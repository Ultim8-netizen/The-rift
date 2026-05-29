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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// ── Constants ─────────────────────────────────────────────────────────────────

/// How often the overseer wakes to sweep in-flight chunks.
const OVERSEER_TICK: Duration = Duration::from_millis(500);

/// A chunk not ACKed within this window is considered lost and re-queued.
/// At 512 KB over a 10 MB/s WiFi link a chunk takes ~50 ms.  5 s allows for
/// a stalled worker, a single TCP retransmit, and OS scheduling jitter — but
/// is still short enough to heal most failures well before the tail of the
/// transfer.
const INFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum total re-queue attempts (NACKs + timeouts combined) per chunk
/// before it is declared permanently failed.
pub const MAX_CHUNK_RETRIES: u8 = 5;

/// No new confirmed chunk for this long → emit `transfer_stalled` to the UI.
const STALL_TIMEOUT: Duration = Duration::from_secs(10);

// ── Internal types ────────────────────────────────────────────────────────────

struct InFlightEntry {
    dispatched_at: Instant,
    worker_id:     u8,
}

// ── Public types ──────────────────────────────────────────────────────────────

/// Point-in-time snapshot emitted as frontend telemetry every OVERSEER_TICK.
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

    /// Immutable set of all expected chunk IDs, built from the manifest
    /// at construction time.  Never mutated after new().
    expected_chunks: Arc<HashSet<usize>>,

    /// Chunks currently dispatched to a worker and awaiting ACK.
    in_flight: Arc<Mutex<HashMap<usize, InFlightEntry>>>,

    /// The overseer's own confirmed ledger.
    /// Populated only via track_confirmed — independent of the queue.
    confirmed: Arc<Mutex<HashSet<usize>>>,

    /// Total re-queue attempts per chunk (persists across re-queues so that
    /// NACK retries and timeout retries count against the same budget).
    chunk_retries: Arc<Mutex<HashMap<usize, u8>>>,

    /// Chunks that have exhausted MAX_CHUNK_RETRIES.  Will not be retried.
    failed_permanent: Arc<Mutex<HashSet<usize>>>,

    /// Timestamp of the last track_confirmed call — stall detection clock.
    last_progress_at: Arc<Mutex<Instant>>,

    /// Shared work queue.  The overseer pushes timed-out / NACKed chunks here
    /// so live workers pick them up on the next pop iteration.
    queue: Arc<Mutex<VecDeque<usize>>>,

    app: AppHandle,
}

impl FileOverseer {
    /// Construct a new overseer from the complete list of chunk IDs for this
    /// file.  `chunk_ids` must enumerate every `ChunkInfo::id` in the manifest.
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

    /// Called immediately after a worker pops a chunk ID from the queue.
    pub async fn track_dispatch(&self, chunk_id: usize, worker_id: u8) {
        self.in_flight.lock().await.insert(
            chunk_id,
            InFlightEntry { dispatched_at: Instant::now(), worker_id },
        );
    }

    /// Called when the receiver ACKs a chunk.
    pub async fn track_confirmed(&self, chunk_id: usize) {
        self.in_flight.lock().await.remove(&chunk_id);
        self.confirmed.lock().await.insert(chunk_id);
        *self.last_progress_at.lock().await = Instant::now();
    }

    /// Called when the receiver NACKs a chunk.
    ///
    /// Returns `true`  → re-queued for retry; worker should continue.
    /// Returns `false` → permanently failed; worker should bail.
    pub async fn track_nack(&self, chunk_id: usize) -> bool {
        // Remove from in-flight first (lock, extract, release).
        self.in_flight.lock().await.remove(&chunk_id);

        // Increment persistent retry counter (separate lock, separate acquire).
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
        // Push to front: re-tried before any fresh chunks.
        self.queue.lock().await.push_front(chunk_id);
        true
    }

    /// Called by a worker on exit (clean or error) to immediately reclaim any
    /// in-flight chunks it held, rather than waiting for INFLIGHT_TIMEOUT.
    /// If the worker exited cleanly with all chunks confirmed this is a no-op.
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

        // Release in_flight, then acquire queue — consistent lock order.
        {
            let mut in_flight = self.in_flight.lock().await;
            for id in &orphaned {
                in_flight.remove(id);
            }
        }
        {
            let mut queue = self.queue.lock().await;
            for id in orphaned {
                queue.push_front(id);
            }
        }
    }

    // ── Query methods ─────────────────────────────────────────────────────────

    /// Returns (confirmed_count, permanently_failed_count).
    ///
    /// Workers use this as their exit condition: exit when the sum equals
    /// total_chunks.  Permanently failed chunks count toward the total so that
    /// workers don't spin forever waiting for chunks that will never arrive.
    pub async fn completion_counts(&self) -> (usize, usize) {
        let c = self.confirmed.lock().await.len();
        let f = self.failed_permanent.lock().await.len();
        (c, f)
    }

    /// Point-in-time snapshot of overseer state.
    pub async fn snapshot(&self) -> OverseerSnapshot {
        let confirmed         = self.confirmed.lock().await.len();
        let in_flight         = self.in_flight.lock().await.len();
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
    ///
    /// Errors if:
    /// - Any expected chunk is neither confirmed nor permanently failed
    ///   (silent data loss).
    /// - Any confirmed chunk was not in expected_chunks (phantom data).
    /// - Any chunks are permanently failed (unrecoverable error).
    ///
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
        // Release locks before any bail — avoids holding across await points.
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

/// Runs concurrently with stream workers for one file's transfer.
///
/// Exits when:
/// - All chunks confirmed or failed (early completion path).
/// - Permanent failures detected during a tick (error path).
/// - Shutdown watch fires after all workers exit (normal completion path,
///   triggers final ledger verification).
pub async fn run_overseer(
    overseer:     FileOverseer,
    transfer_id:  String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    loop {
        tokio::select! {
            // biased: shutdown wins when both branches are simultaneously ready.
            biased;

            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return run_final_pass(&overseer, &transfer_id).await;
                }
            }

            _ = tokio::time::sleep(OVERSEER_TICK) => {
                // Tick: sweep timeouts, check stalls, emit telemetry.
                // Returns Err on permanent failure, which exits the task.
                tick(&overseer, &transfer_id).await?;

                // Early completion check (all workers may have already exited).
                let (c, f) = overseer.completion_counts().await;
                if c + f >= overseer.total_chunks {
                    return run_final_pass(&overseer, &transfer_id).await;
                }
            }
        }
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// One periodic sweep: re-queue timed-out in-flight chunks, detect stalls,
/// check for permanent failures, emit telemetry.
async fn tick(overseer: &FileOverseer, transfer_id: &str) -> anyhow::Result<()> {
    // ── Snapshot timed-out entries — release lock before acting ──────────────
    let timed_out: Vec<(usize, u8)> = {
        let in_flight = overseer.in_flight.lock().await;
        in_flight
            .iter()
            .filter(|(_, e)| e.dispatched_at.elapsed() > INFLIGHT_TIMEOUT)
            .map(|(id, e)| (*id, e.worker_id))
            .collect()
    };

    // ── Process each timed-out chunk independently ────────────────────────────
    for (chunk_id, _worker_id) in timed_out {
        // Skip if confirmed in the window between collection and processing.
        {
            if overseer.confirmed.lock().await.contains(&chunk_id) {
                overseer.in_flight.lock().await.remove(&chunk_id);
                continue;
            }
        }

        // Remove from in-flight.
        overseer.in_flight.lock().await.remove(&chunk_id);

        // Increment persistent retry counter.
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

    // ── Permanent failure check ───────────────────────────────────────────────
    let fail_count = overseer.failed_permanent.lock().await.len();
    if fail_count > 0 {
        anyhow::bail!(
            "[Overseer] {fail_count} chunk(s) permanently failed for \
             file {} in {transfer_id}",
            overseer.file_index
        );
    }

    // ── Stall detection ───────────────────────────────────────────────────────
    let stall_elapsed = overseer.last_progress_at.lock().await.elapsed();
    if stall_elapsed > STALL_TIMEOUT {
        let snap = overseer.snapshot().await;
        eprintln!(
            "[Overseer] Stall — no progress for {:.1}s \
             ({}/{} confirmed, {} in-flight, file={} transfer={transfer_id})",
            stall_elapsed.as_secs_f32(),
            snap.confirmed, snap.total_chunks, snap.in_flight,
            snap.file_index
        );
        let _ = overseer.app.emit(
            "transfer_stalled",
            &serde_json::json!({
                "transferId":    transfer_id,
                "fileIndex":     snap.file_index,
                "confirmedChunks": snap.confirmed,
                "totalChunks":   snap.total_chunks,
                "stalledForSecs": stall_elapsed.as_secs(),
            }),
        );
    }

    // ── Periodic telemetry ────────────────────────────────────────────────────
    let snap = overseer.snapshot().await;
    let _ = overseer.app.emit(
        "transfer_overseer_tick",
        &serde_json::json!({
            "transferId":      transfer_id,
            "fileIndex":       snap.file_index,
            "confirmedChunks": snap.confirmed,
            "inFlightChunks":  snap.in_flight,
            "permanentlyFailed": snap.permanently_failed,
            "totalChunks":     snap.total_chunks,
            "percentComplete": snap.percent_complete,
        }),
    );

    Ok(())
}

/// Called when all workers have exited (shutdown signal) or when the early
/// completion check fires.  Runs one final tick to catch any last-millisecond
/// timeouts, then invokes the independent ledger verification.
async fn run_final_pass(overseer: &FileOverseer, transfer_id: &str) -> anyhow::Result<()> {
    // Suppress tick errors here — verify_ledger is the authoritative verdict.
    let _ = tick(overseer, transfer_id).await;

    let snap = overseer.snapshot().await;
    eprintln!(
        "[Overseer] Final pass — {}/{} confirmed, {} in-flight, {} failed \
         (file={} transfer={transfer_id})",
        snap.confirmed, snap.total_chunks,
        snap.in_flight, snap.permanently_failed,
        snap.file_index
    );

    // Independent cross-check: confirmed ledger vs expected_chunks.
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