use crate::state::Device;
use crate::transfer::manifest::{FileManifest, ResumeManifest, TransferManifest};
use crate::transfer::overseer::{FileOverseer, run_overseer};
use crate::transfer::stream_server::STREAM_PORT;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

/// Number of concurrent worker streams per file.
/// Four connections saturate a local WiFi link more aggressively than two
/// without adding meaningful protocol complexity.
pub const NUM_STREAMS: usize = 4;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ACK_TIMEOUT:     Duration = Duration::from_secs(30);

/// How long a worker sleeps when the queue is momentarily empty but the
/// overseer may still re-queue timed-out chunks.
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(200);

// ── Entry point ───────────────────────────────────────────────────────────────

/// Send all files to `target`.
///
/// For each file:
///   1. Build the shared chunk queue (non-completed chunks, ascending order).
///   2. Create a FileOverseer from the manifest's chunk IDs.
///   3. Spawn the overseer background task.
///   4. Spawn NUM_STREAMS worker tasks.
///   5. Await all workers; collect errors without short-circuiting so the
///      overseer always gets a shutdown signal.
///   6. Signal overseer shutdown → final ledger verification.
///   7. Propagate overseer error first (most informative), then worker error.
pub async fn send_multi_stream(
    manifest:   &TransferManifest,
    resume:     &ResumeManifest,
    target:     &Device,
    file_paths: &[String],
    app:        &AppHandle,
) -> anyhow::Result<()> {
    for (fi, file_manifest) in manifest.files.iter().enumerate() {
        let completed: HashSet<usize> = resume
            .completed_per_file
            .get(fi)
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default();

        let file_path = file_paths.get(fi).cloned().unwrap_or_default();
        let fm = Arc::new(file_manifest.clone());

        // ── Shared work queue ─────────────────────────────────────────────
        // Non-completed chunk IDs in ascending order; ascending = both source
        // file seeks are always forward, maximising OS read-ahead.
        let queue: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new(
            fm.chunks
                .iter()
                .filter(|c| !completed.contains(&c.id))
                .map(|c| c.id)
                .collect(),
        ));

        // ── Overseer ──────────────────────────────────────────────────────
        let chunk_ids: Vec<usize> = fm.chunks.iter().map(|c| c.id).collect();
        let overseer = FileOverseer::new(
            manifest.transfer_id.clone(),
            fi,
            chunk_ids,
            queue.clone(),
            app.clone(),
        );

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        let overseer_handle = {
            let o   = overseer.clone();
            let tid = manifest.transfer_id.clone();
            tokio::spawn(async move { run_overseer(o, tid, shutdown_rx).await })
        };

        // ── Workers ───────────────────────────────────────────────────────
        let mut join_set = JoinSet::new();

        for worker_id in 0..NUM_STREAMS {
            let queue_c    = queue.clone();
            let overseer_c = overseer.clone();
            let fm_c       = fm.clone();
            let fp_c       = file_path.clone();
            let tid_c      = manifest.transfer_id.clone();
            let ip_c       = target.ip.clone();
            let app_c      = app.clone();

            join_set.spawn(async move {
                stream_worker(
                    tid_c, fi, worker_id as u8,
                    queue_c, fm_c, fp_c, ip_c, STREAM_PORT,
                    app_c, overseer_c,
                )
                .await
            });
        }

        // ── Drain workers — collect all errors before returning ───────────
        let mut first_worker_err: Option<anyhow::Error> = None;
        while let Some(res) = join_set.join_next().await {
            match res {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_worker_err.is_none() {
                        first_worker_err = Some(e);
                    }
                }
                Err(je) => {
                    if first_worker_err.is_none() {
                        first_worker_err =
                            Some(anyhow::anyhow!("Worker task panicked: {je}"));
                    }
                }
            }
        }

        // Signal overseer shutdown (fires final ledger verification).
        // Ignore send error — overseer may have already exited on completion.
        let _ = shutdown_tx.send(true);

        // Await overseer final verdict.
        let overseer_res = overseer_handle
            .await
            .map_err(|je| anyhow::anyhow!("Overseer task panicked: {je}"))
            .and_then(|r| r);

        // Overseer verdict takes priority: it has the independent view.
        if let Err(e) = overseer_res {
            return Err(e);
        }
        if let Some(e) = first_worker_err {
            return Err(e);
        }

        eprintln!(
            "[StreamClient] File {fi} — all {} chunks confirmed, overseer verified",
            fm.total_chunks
        );
    }

    Ok(())
}

// ── Worker ────────────────────────────────────────────────────────────────────

/// Public wrapper.  Always calls reclaim_worker before returning so orphaned
/// in-flight chunks are returned to the queue immediately on any exit path.
async fn stream_worker(
    transfer_id:   String,
    file_index:    usize,
    worker_id:     u8,
    queue:         Arc<Mutex<VecDeque<usize>>>,
    file_manifest: Arc<FileManifest>,
    file_path:     String,
    target_ip:     String,
    port:          u16,
    app:           AppHandle,
    overseer:      FileOverseer,
) -> anyhow::Result<()> {
    let result = stream_worker_inner(
        &transfer_id, file_index, worker_id,
        &queue, &file_manifest, &file_path,
        &target_ip, port, &app, &overseer,
    )
    .await;

    // Reclaim in-flight chunks this worker held at exit time (no-op on clean exit).
    overseer.reclaim_worker(worker_id).await;

    result
}

/// Inner implementation.  May use `?` freely — reclaim_worker is handled by
/// the outer wrapper.
async fn stream_worker_inner(
    transfer_id:   &str,
    file_index:    usize,
    worker_id:     u8,
    queue:         &Arc<Mutex<VecDeque<usize>>>,
    file_manifest: &Arc<FileManifest>,
    file_path:     &str,
    target_ip:     &str,
    port:          u16,
    app:           &AppHandle,
    overseer:      &FileOverseer,
) -> anyhow::Result<()> {
    // ── Connect ───────────────────────────────────────────────────────────────
    let addr = format!("{target_ip}:{port}");
    let tcp  = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("Worker {worker_id}: connect to {addr} timed out"))??;

    let (read_half, mut writer) = tcp.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line   = String::new();

    // ── Handshake ─────────────────────────────────────────────────────────────
    writer
        .write_all(
            format!(
                "RIFT-STREAM/1.0\n{transfer_id}\n{file_index}\n{worker_id}\n"
            )
            .as_bytes(),
        )
        .await?;

    line.clear();
    reader.read_line(&mut line).await?;
    if line.trim() != "READY" {
        anyhow::bail!(
            "Worker {worker_id}: expected READY, got: {}",
            line.trim()
        );
    }

    // ── Source file (per-worker read-only handle) ─────────────────────────────
    let mut src = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Worker {worker_id}: cannot open {file_path}: {e}"))?;

    eprintln!(
        "[StreamClient] Worker {worker_id} ready \
         (file={file_index} transfer={transfer_id})"
    );

    // ── Chunk dispatch loop ───────────────────────────────────────────────────
    loop {
        // Pop the next chunk ID from the shared queue.
        let chunk_id = queue.lock().await.pop_front();

        let chunk_id = match chunk_id {
            Some(id) => id,

            // Queue empty.  Check if the transfer is fully accounted for.
            None => {
                let (confirmed, failed) = overseer.completion_counts().await;
                let total = overseer.total_chunks;

                if confirmed + failed >= total {
                    if failed > 0 {
                        anyhow::bail!(
                            "Worker {worker_id}: permanent chunk failure(s) detected \
                             (file={file_index} transfer={transfer_id})"
                        );
                    }
                    // All chunks confirmed — clean exit.
                    break;
                }

                // More chunks expected (overseer may re-queue timed-out ones).
                tokio::time::sleep(IDLE_POLL_INTERVAL).await;
                continue;
            }
        };

        // Notify overseer this chunk is now in-flight.
        overseer.track_dispatch(chunk_id, worker_id).await;

        let chunk_info = file_manifest
            .chunks
            .get(chunk_id)
            .ok_or_else(|| anyhow::anyhow!("Chunk {chunk_id} not in manifest"))?;

        // ── Read chunk bytes from source file ─────────────────────────────────
        src.seek(tokio::io::SeekFrom::Start(chunk_info.offset))
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "Worker {worker_id}: seek source chunk {chunk_id}: {e}"
                )
            })?;

        let mut buf = vec![0u8; chunk_info.size as usize];
        src.read_exact(&mut buf)
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "Worker {worker_id}: read source chunk {chunk_id}: {e}"
                )
            })?;

        // ── Send CHUNK header + raw bytes ─────────────────────────────────────
        writer
            .write_all(
                format!(
                    "CHUNK {} {} {} {}\n",
                    chunk_id, chunk_info.offset, chunk_info.size, chunk_info.blake3
                )
                .as_bytes(),
            )
            .await?;
        writer.write_all(&buf).await?;

        // ── Wait for ACK / NACK ───────────────────────────────────────────────
        line.clear();
        match tokio::time::timeout(ACK_TIMEOUT, reader.read_line(&mut line)).await {
            Err(_) => anyhow::bail!(
                "Worker {worker_id}: ACK timeout for chunk {chunk_id}"
            ),
            Ok(Err(e)) => anyhow::bail!(
                "Worker {worker_id}: ACK read error chunk {chunk_id}: {e}"
            ),
            Ok(Ok(0)) => anyhow::bail!(
                "Worker {worker_id}: connection closed before ACK chunk {chunk_id}"
            ),
            Ok(Ok(_)) => {}
        }

        let resp = line.trim();

        if resp.starts_with("NACK") {
            // Hand off to overseer: increments retry counter, re-queues or
            // marks permanent depending on budget.
            let should_continue = overseer.track_nack(chunk_id).await;
            if !should_continue {
                anyhow::bail!(
                    "Worker {worker_id}: chunk {chunk_id} permanently failed \
                     (file={file_index} transfer={transfer_id})"
                );
            }
            // Chunk was re-queued at the front.  Continue to pop next chunk.
            continue;
        }

        // ACK — confirm with overseer and emit frontend event.
        overseer.track_confirmed(chunk_id).await;

        let _ = app.emit(
            "chunk_sent",
            &serde_json::json!({
                "transferId": transfer_id,
                "fileIndex":  file_index,
                "chunkId":    chunk_id,
                "workerId":   worker_id,
            }),
        );
    }

    // ── Signal end-of-stream to receiver ─────────────────────────────────────
    writer.write_all(b"DONE\n").await?;
    eprintln!(
        "[StreamClient] Worker {worker_id} DONE \
         (file={file_index} transfer={transfer_id})"
    );
    Ok(())
}