//! Independent transfer accountability layer.
//!
//! The manifest is the source of truth for what a transfer *should* contain.
//! The overseer is the accountability layer for what *is* happening, maintained
//! in parallel and completely independently of the manifest's data structures.
//!
//! Responsibilities
//! ────────────────
//! 1. Track every chunk dispatched by any worker and every ACK received.
//! 2. Re-queue in-flight chunks not ACKed within INFLIGHT_TIMEOUT.
//! 3. Enforce per-chunk retry limits; permanently fail chunks that exceed them.
//! 4. Detect transfer stalls (no new confirmed chunk for STALL_TIMEOUT).
//! 5. Emit periodic telemetry events for the frontend progress UI.
//! 6. On shutdown, cross-check the overseer's confirmed ledger against the
//!    expected chunk set built at construction time.  A discrepancy means a
//!    chunk was silently lost — neither confirmed nor permanently failed —
//!    which the manifest's accounting would not catch on its own.
//!
//! Independence guarantee
//! ──────────────────────
//! `expected_chunks` is built from manifest IDs at construction and never
//! mutated.  `confirmed` is populated only by explicit `track_confirmed` calls.
//! `verify_ledger` checks these two sets without consulting the queue or the
//! workers' in-flight state.  Any chunk unaccounted for — not in confirmed, not
//! in failed_permanent — is a detectable hole regardless of what the queue
//! thinks.
//!
//! INFLIGHT_TIMEOUT rationale
//! ──────────────────────────
//! Previous value was 5 s.  At 1 MB chunks the send takes ~100 ms at 10 MB/s.
//! The receiver then BLAKE3-verifies, seeks, and writes before ACKing; on a
//! slow HDD or an OS that is flushing dirty pages this can take 3-8 s.  At 5 s
//! the overseer was re-queuing legitimately in-flight chunks on almost every
//! tick, effectively doubling the bytes sent over the wire.  30 s gives the
//! receiver headroom while still catching genuinely stuck workers.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// ── Constants ─────────────────────────────────────────────────────────────────

/// How often the overseer wakes to sweep in-flight chunks.
const OVERSEER_TICK: Duration = Duration::from_millis(500);

/// A chunk not ACKed within this window is re-queued.
///
/// 30 s: generous enough that a slow-disk receiver writing a 1 MB chunk never
/// triggers a false re-queue, but tight enough to catch a dead connection within
/// a minute.  With pipelining, chunks are typically ACKed in well under 1 s.
const INFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum combined retries (NACKs + timeouts) per chunk before permanent fail.
pub const MAX_CHUNK_RETRIES: u8 = 5;

/// No new confirmed chunk for this long → emit `transfer_stalled` to the UI.
const STALL_TIMEOUT: Duration = Duration::from_secs(10);

// ── Internal types ────────────────────────────────────────────────────────────

struct InFlightEntry {
    dispatched_at: Instant,
    worker_id:     u8,
}

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverseerSnapshot {
    pub file_index:         usize,
    pub total_chunks:       usize,
    pub confirmed:          usize,
    pub in_flight:          usize,
    pub permanently_failed: usize,
    pub percent_complete:   f64,
}

/// Per-file overseer.  Cheaply cloneable — all mutable state is Arc-wrapped.
#[derive(Clone)]
pub struct FileOverseer {
    pub transfer_id:  String,
    pub file_index:   usize,
    pub total_chunks: usize,

    /// Immutable set of all expected chunk IDs.  Never mutated after new().
    expected_chunks: Arc<HashSet<usize>>,

    in_flight:        Arc<Mutex<HashMap<usize, InFlightEntry>>>,
    confirmed:        Arc<Mutex<HashSet<usize>>>,
    chunk_retries:    Arc<Mutex<HashMap<usize, u8>>>,
    failed_permanent: Arc<Mutex<HashSet<usize>>>,
    last_progress_at: Arc<Mutex<Instant>>,
    queue:            Arc<Mutex<VecDeque<usize>>>,

    app: AppHandle,
}

impl FileOverseer {
    pub fn new(
        transfer_id:  String,
        file_index:   usize,
        chunk_ids:    Vec<usize>,
        queue:        Arc<Mutex<VecDeque<usize>>>,
        app:          AppHandle,
    ) -> Self {
        let total_chunks    = chunk_ids.len();
        let expected_chunks = Arc::new(chunk_ids.into_iter().collect::<HashSet<usize>>());
        Self {
            transfer_id,
            file_index,
            total_chunks,
            expected_chunks,
            in_flight:        Arc::new(Mutex::new(HashMap::new())),
            confirmed:        Arc::new(Mutex::new(HashSet::new())),
            chunk_retries:    Arc::new(Mutex::new(HashMap::new())),
            failed_permanent: Arc::new(Mutex::new(HashSet::new())),
            last_progress_at: Arc::new(Mutex::new(Instant::now())),
            queue,
            app,
        }
    }

    // ── Worker callbacks ──────────────────────────────────────────────────────

    pub async fn track_dispatch(&self, chunk_id: usize, worker_id: u8) {
        self.in_flight.lock().await.insert(
            chunk_id,
            InFlightEntry { dispatched_at: Instant::now(), worker_id },
        );
    }

    pub async fn track_confirmed(&self, chunk_id: usize) {
        self.in_flight.lock().await.remove(&chunk_id);
        self.confirmed.lock().await.insert(chunk_id);
        *self.last_progress_at.lock().await = Instant::now();
    }

    /// Returns `true` → re-queued; `false` → permanently failed.
    pub async fn track_nack(&self, chunk_id: usize) -> bool {
        self.in_flight.lock().await.remove(&chunk_id);

        let retries = {
            let mut map = self.chunk_retries.lock().await;
            let r = map.entry(chunk_id).or_insert(0);
            *r += 1;
            *r
        };

        if retries >= MAX_CHUNK_RETRIES {
            eprintln!(
                "[Overseer] Chunk {chunk_id} permanently failed after {retries} NACKs \
                 (file={} transfer={})",
                self.file_index, self.transfer_id
            );
            self.failed_permanent.lock().await.insert(chunk_id);
            return false;
        }

        eprintln!(
            "[Overseer] Chunk {chunk_id} NACKed — retry {retries}/{MAX_CHUNK_RETRIES} \
             (file={} transfer={})",
            self.file_index, self.transfer_id
        );
        self.queue.lock().await.push_front(chunk_id);
        true
    }

    /// Immediately re-queues any in-flight chunks owned by `worker_id`.
    /// Called on worker exit (clean or error) before the outer wrapper returns.
    pub async fn reclaim_worker(&self, worker_id: u8) {
        let orphaned: Vec<usize> = {
            let in_flight = self.in_flight.lock().await;
            in_flight
                .iter()
                .filter(|(_, e)| e.worker_id == worker_id)
                .map(|(id, _)| *id)
                .collect()
        };
        if orphaned.is_empty() {
            return;
        }
        eprintln!(
            "[Overseer] Worker {worker_id} exiting — reclaiming {} orphaned chunk(s) \
             (file={} transfer={})",
            orphaned.len(), self.file_index, self.transfer_id
        );
        {
            let mut in_flight = self.in_flight.lock().await;
            for id in &orphaned { in_flight.remove(id); }
        }
        {
            let mut queue = self.queue.lock().await;
            for id in orphaned { queue.push_front(id); }
        }
    }

    // ── Query methods ─────────────────────────────────────────────────────────

    pub async fn completion_counts(&self) -> (usize, usize) {
        let c = self.confirmed.lock().await.len();
        let f = self.failed_permanent.lock().await.len();
        (c, f)
    }

    pub async fn snapshot(&self) -> OverseerSnapshot {
        let confirmed          = self.confirmed.lock().await.len();
        let in_flight          = self.in_flight.lock().await.len();
        let permanently_failed = self.failed_permanent.lock().await.len();
        OverseerSnapshot {
            file_index: self.file_index,
            total_chunks: self.total_chunks,
            confirmed,
            in_flight,
            permanently_failed,
            percent_complete: if self.total_chunks > 0 {
                (confirmed as f64 / self.total_chunks as f64) * 100.0
            } else {
                100.0
            },
        }
    }

    /// Cross-checks the overseer's confirmed ledger against expected_chunks.
    /// Called only after all workers have exited.
    pub async fn verify_ledger(&self) -> anyhow::Result<()> {
        let confirmed = self.confirmed.lock().await;
        let failed    = self.failed_permanent.lock().await;

        let missing: Vec<usize> = self
            .expected_chunks
            .iter()
            .filter(|id| !confirmed.contains(id) && !failed.contains(id))
            .cloned()
            .collect();

        let phantom: Vec<usize> = confirmed
            .iter()
            .filter(|id| !self.expected_chunks.contains(id))
            .cloned()
            .collect();

        let fail_count = failed.len();
        drop(confirmed);
        drop(failed);

        if !missing.is_empty() {
            anyhow::bail!(
                "[Overseer] Ledger discrepancy — {} chunk(s) unaccounted for in \
                 file {} of transfer {} (first 10: {:?})",
                missing.len(), self.file_index, self.transfer_id,
                &missing[..missing.len().min(10)]
            );
        }
        if !phantom.is_empty() {
            anyhow::bail!(
                "[Overseer] Ledger discrepancy — {} phantom confirmed chunk(s) in \
                 file {} of transfer {}",
                phantom.len(), self.file_index, self.transfer_id
            );
        }
        if fail_count > 0 {
            anyhow::bail!(
                "[Overseer] {} chunk(s) permanently failed in file {} of transfer {}",
                fail_count, self.file_index, self.transfer_id
            );
        }
        Ok(())
    }
}

// ── Background task ───────────────────────────────────────────────────────────

pub async fn run_overseer(
    overseer:     FileOverseer,
    transfer_id:  String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return run_final_pass(&overseer, &transfer_id).await;
                }
            }
            _ = tokio::time::sleep(OVERSEER_TICK) => {
                tick(&overseer, &transfer_id).await?;
                let (c, f) = overseer.completion_counts().await;
                if c + f >= overseer.total_chunks {
                    return run_final_pass(&overseer, &transfer_id).await;
                }
            }
        }
    }
}

async fn tick(overseer: &FileOverseer, transfer_id: &str) -> anyhow::Result<()> {
    // Snapshot timed-out entries — release lock before acting.
    let timed_out: Vec<(usize, u8)> = {
        let in_flight = overseer.in_flight.lock().await;
        in_flight
            .iter()
            .filter(|(_, e)| e.dispatched_at.elapsed() > INFLIGHT_TIMEOUT)
            .map(|(id, e)| (*id, e.worker_id))
            .collect()
    };

    for (chunk_id, _) in timed_out {
        {
            if overseer.confirmed.lock().await.contains(&chunk_id) {
                overseer.in_flight.lock().await.remove(&chunk_id);
                continue;
            }
        }
        overseer.in_flight.lock().await.remove(&chunk_id);

        let retries = {
            let mut map = overseer.chunk_retries.lock().await;
            let r = map.entry(chunk_id).or_insert(0);
            *r += 1;
            *r
        };

        if retries >= MAX_CHUNK_RETRIES {
            eprintln!(
                "[Overseer] Chunk {chunk_id} timed out permanently after {retries} attempts \
                 (file={} transfer={transfer_id})",
                overseer.file_index
            );
            overseer.failed_permanent.lock().await.insert(chunk_id);
        } else {
            eprintln!(
                "[Overseer] Chunk {chunk_id} timed out — re-queuing \
                 attempt {retries}/{MAX_CHUNK_RETRIES} \
                 (file={} transfer={transfer_id})",
                overseer.file_index
            );
            overseer.queue.lock().await.push_front(chunk_id);
        }
    }

    let fail_count = overseer.failed_permanent.lock().await.len();
    if fail_count > 0 {
        anyhow::bail!(
            "[Overseer] {fail_count} chunk(s) permanently failed for \
             file {} in {transfer_id}",
            overseer.file_index
        );
    }

    let stall_elapsed = overseer.last_progress_at.lock().await.elapsed();
    if stall_elapsed > STALL_TIMEOUT {
        let snap = overseer.snapshot().await;
        eprintln!(
            "[Overseer] Stall — no progress for {:.1}s \
             ({}/{} confirmed, {} in-flight, file={} transfer={transfer_id})",
            stall_elapsed.as_secs_f32(),
            snap.confirmed, snap.total_chunks, snap.in_flight, snap.file_index
        );
        let _ = overseer.app.emit(
            "transfer_stalled",
            &serde_json::json!({
                "transferId":      transfer_id,
                "fileIndex":       snap.file_index,
                "confirmedChunks": snap.confirmed,
                "totalChunks":     snap.total_chunks,
                "stalledForSecs":  stall_elapsed.as_secs(),
            }),
        );
    }

    let snap = overseer.snapshot().await;
    let _ = overseer.app.emit(
        "transfer_overseer_tick",
        &serde_json::json!({
            "transferId":       transfer_id,
            "fileIndex":        snap.file_index,
            "confirmedChunks":  snap.confirmed,
            "inFlightChunks":   snap.in_flight,
            "permanentlyFailed":snap.permanently_failed,
            "totalChunks":      snap.total_chunks,
            "percentComplete":  snap.percent_complete,
        }),
    );
    Ok(())
}

async fn run_final_pass(overseer: &FileOverseer, transfer_id: &str) -> anyhow::Result<()> {
    let _ = tick(overseer, transfer_id).await;
    let snap = overseer.snapshot().await;
    eprintln!(
        "[Overseer] Final pass — {}/{} confirmed, {} in-flight, {} failed \
         (file={} transfer={transfer_id})",
        snap.confirmed, snap.total_chunks,
        snap.in_flight, snap.permanently_failed, snap.file_index
    );
    overseer.verify_ledger().await?;
    eprintln!(
        "[Overseer] Ledger verified ✓ — all {} chunks accounted for \
         (file={} transfer={transfer_id})",
        snap.total_chunks, snap.file_index
    );
    let _ = overseer.app.emit(
        "transfer_overseer_verified",
        &serde_json::json!({
            "transferId":  transfer_id,
            "fileIndex":   snap.file_index,
            "totalChunks": snap.total_chunks,
        }),
    );
    Ok(())
}