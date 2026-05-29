//! Queue-based dual-stream sender.
//!
//! Instead of statically assigning chunks to streams ("stream 0 owns the
//! first half"), all pending chunks are placed in a single shared
//! `Arc<Mutex<VecDeque>>`.  Every worker pulls the next unassigned chunk
//! from the front, reads it from the source file, and fires it down its
//! TCP connection.  Workers compete on the queue: whichever is ready first
//! takes the next job.  If one worker stalls (slow ACK, seek latency),
//! the other drains its share of the queue faster.  No chunk is ever
//! "orphaned" by a fixed ownership assignment.
//!
//! The receiver is oblivious to which worker delivered which chunk.  It
//! writes each arriving chunk to its `byte_offset` and tracks completeness
//! with a `HashSet<usize>`; order of arrival is irrelevant.

use crate::state::Device;
use crate::transfer::manifest::{FileManifest, ResumeManifest, TransferManifest};
use crate::transfer::stream_server::STREAM_PORT;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

/// Number of concurrent worker streams per file.
/// Both connect to :7477 on the receiver and compete for chunks.
pub const NUM_STREAMS: usize = 2;

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const ACK_TIMEOUT:     std::time::Duration = std::time::Duration::from_secs(30);

/// Entry point called from `send_files_to_device`.
///
/// For each file in the transfer, builds a shared chunk queue from all
/// non-completed chunk IDs (ascending order, so both workers seek forward
/// in the source file), spawns `NUM_STREAMS` workers, and waits for all of
/// them.  If any worker fails its `JoinSet` is dropped, cancelling the rest.
pub async fn send_multi_stream(
    manifest: &TransferManifest,
    resume: &ResumeManifest,
    target: &Device,
    file_paths: &[String],
    app: &AppHandle,
) -> anyhow::Result<()> {
    for (fi, file_manifest) in manifest.files.iter().enumerate() {
        let completed: HashSet<usize> = resume
            .completed_per_file
            .get(fi)
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default();

        let file_path = file_paths.get(fi).cloned().unwrap_or_default();
        let fm = Arc::new(file_manifest.clone());

        // All non-completed chunk IDs in ascending order.
        // Ascending = both workers seek forward in the source file,
        // which is the most cache-friendly access pattern.
        let queue: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new(
            fm.chunks
                .iter()
                .filter(|c| !completed.contains(&c.id))
                .map(|c| c.id)
                .collect(),
        ));

        let mut join_set = JoinSet::new();

        for worker_id in 0..NUM_STREAMS {
            let queue  = queue.clone();
            let fm     = fm.clone();
            let fp     = file_path.clone();
            let tid    = manifest.transfer_id.clone();
            let ip     = target.ip.clone();
            let app_w  = app.clone();

            join_set.spawn(async move {
                stream_worker(tid, fi, worker_id as u8, queue, fm, fp, ip, STREAM_PORT, app_w)
                    .await
            });
        }

        // Await all workers.  The first error propagates; dropping the
        // JoinSet cancels any still-running workers (Tokio abort on drop).
        while let Some(result) = join_set.join_next().await {
            result??; // JoinError (panic/cancel) then anyhow::Error
        }

        eprintln!("[StreamClient] File {fi} — all workers finished");
    }

    Ok(())
}

/// A single stream worker.
///
/// Connects to the receiver's stream server, performs the RIFT-STREAM
/// handshake, then loops: pop a chunk ID from the shared queue, read the
/// chunk bytes from the source file, send the CHUNK header + bytes, wait for
/// ACK.  When the queue is empty, sends DONE and returns.
///
/// The worker opens its own `tokio::fs::File` for the source; two workers
/// reading the same file concurrently via separate handles is safe on all
/// major OS's.
async fn stream_worker(
    transfer_id: String,
    file_index:  usize,
    worker_id:   u8,
    queue:       Arc<Mutex<VecDeque<usize>>>,
    file_manifest: Arc<FileManifest>,
    file_path:   String,
    target_ip:   String,
    port:        u16,
    app:         AppHandle,
) -> anyhow::Result<()> {
    // ── Connect ───────────────────────────────────────────────────────────────
    let addr = format!("{target_ip}:{port}");
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("Connect to {addr} timed out"))??;

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
            "[StreamClient] Worker {worker_id}: expected READY, got: {}",
            line.trim()
        );
    }

    // ── Source file handle (per worker, read-only) ────────────────────────────
    let mut src_file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot open source {file_path}: {e}"))?;

    eprintln!(
        "[StreamClient] Worker {worker_id} ready — file {file_index} transfer {transfer_id}"
    );

    // ── Chunk dispatch loop ───────────────────────────────────────────────────
    loop {
        // Pop the next job from the shared queue.
        let chunk_id = {
            let mut q = queue.lock().await;
            q.pop_front()
        };

        let Some(chunk_id) = chunk_id else {
            // Queue exhausted — this worker is done.
            break;
        };

        let chunk_info = file_manifest
            .chunks
            .get(chunk_id)
            .ok_or_else(|| anyhow::anyhow!("Chunk {chunk_id} not in manifest"))?;

        // Read chunk bytes from source file.
        src_file
            .seek(tokio::io::SeekFrom::Start(chunk_info.offset))
            .await
            .map_err(|e| anyhow::anyhow!("Seek source chunk {chunk_id}: {e}"))?;

        let mut buf = vec![0u8; chunk_info.size as usize];
        src_file
            .read_exact(&mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("Read source chunk {chunk_id}: {e}"))?;

        // Send CHUNK header then raw bytes.
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

        // Wait for ACK (or NACK).
        line.clear();
        match tokio::time::timeout(ACK_TIMEOUT, reader.read_line(&mut line)).await {
            Err(_) => anyhow::bail!(
                "Worker {worker_id}: ACK timeout for chunk {chunk_id}"
            ),
            Ok(Err(e)) => anyhow::bail!(
                "Worker {worker_id}: ACK read error chunk {chunk_id}: {e}"
            ),
            Ok(Ok(0)) => anyhow::bail!(
                "Worker {worker_id}: connection closed before ACK for chunk {chunk_id}"
            ),
            Ok(Ok(_)) => {
                let resp = line.trim();
                if resp.starts_with("NACK") {
                    anyhow::bail!(
                        "Worker {worker_id}: chunk {chunk_id} NACKed: {resp}"
                    );
                }
                // ACK received — loop to next chunk.
            }
        }

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

    // ── Signal end-of-stream ──────────────────────────────────────────────────
    writer.write_all(b"DONE\n").await?;
    eprintln!(
        "[StreamClient] Worker {worker_id} DONE — file {file_index} transfer {transfer_id}"
    );
    Ok(())
}