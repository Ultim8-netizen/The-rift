//! Queue-based multi-stream sender with integrated transfer overseer.
//!
//! Public API
//! ──────────
//! send_files_to_device  — full orchestration: request → accept → manifest → stream
//! send_text_to_device   — single HTTP POST to /text/:tid
//! send_multi_stream     — raw streaming layer (called by send_files_to_device)
//!
//! Architecture
//! ────────────
//! All pending chunks for a file are placed in a single shared
//! `Arc<Mutex<VecDeque<usize>>>`.  NUM_STREAMS worker tasks compete to pop
//! the next chunk ID, read its bytes from the source file, and fire it over
//! their TCP connection.  No chunk is pre-assigned to any stream.
//!
//! Workers report every dispatch, confirmation, and NACK to the FileOverseer.
//! The overseer runs as a concurrent background task.  It re-queues any chunk
//! that has been in-flight longer than INFLIGHT_TIMEOUT so a healthy worker
//! will pick it up without waiting for the transfer to finish.

use crate::state::{Device, FileEntry, SharedState, TransferRequest};
use crate::transfer::manifest::{
    build_manifest, FileManifest, ResumeManifest, SenderDevice, TransferManifest,
};
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
pub const NUM_STREAMS: usize = 4;

const CONNECT_TIMEOUT:    Duration = Duration::from_secs(10);
const ACK_TIMEOUT:        Duration = Duration::from_secs(30);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// How long to wait for the receiver to accept or decline before giving up.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(120);

// ── Public orchestration ──────────────────────────────────────────────────────

/// Full file-send flow:
///   1. POST /request  → receiver's UI shows the incoming-transfer prompt.
///   2. Await accept/decline via our own server's transfer_notifiers channel.
///   3. Build TransferManifest (reads + BLAKE3-hashes all file content).
///   4. POST /manifest → receiver pre-allocates files, returns ResumeManifest.
///   5. Call send_multi_stream to stream all chunks over NUM_STREAMS TCP workers.
pub async fn send_files_to_device(
    transfer_id: String,
    target:      Device,
    files:       Vec<FileEntry>,
    state:       SharedState,
    app:         AppHandle,
) -> anyhow::Result<()> {
    // ── Own device info ───────────────────────────────────────────────────────
    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };

    let own_ip = local_ip_address::local_ip()
        .ok()
        .and_then(|ip| match ip {
            std::net::IpAddr::V4(v4) => Some(v4.to_string()),
            _                        => None,
        })
        .unwrap_or_else(|| "127.0.0.1".to_string());

    // ── POST /request ─────────────────────────────────────────────────────────
    let total_bytes: u64 = files.iter().map(|f| f.size_bytes).sum();

    let request = TransferRequest {
        transfer_id:   transfer_id.clone(),
        sender_device: Device {
            id:            own_id.clone(),
            name:          own_name.clone(),
            os:            std::env::consts::OS.to_string(),
            ip:            own_ip.clone(),
            port:          own_port,
            latency_ms:    None,
            discovered_at: 0,
        },
        files: files.clone(),
        total_bytes,
    };

    reqwest::Client::new()
        .post(format!("http://{}:{}/request", target.ip, target.port))
        .json(&request)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Transfer request to {} failed: {e}", target.ip))?;

    // ── Wait for accept/decline ───────────────────────────────────────────────
    // Our own server's handle_accept / handle_decline fires on the notifier.
    // handle_decline already emits transfer_error to the frontend before
    // sending false, so we just bail here without double-emitting.
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    state.lock().await.transfer_notifiers.insert(transfer_id.clone(), tx);

    let accepted = tokio::time::timeout(ACCEPT_TIMEOUT, rx)
        .await
        .map_err(|_| anyhow::anyhow!(
            "Transfer {transfer_id} timed out — receiver did not respond within 120 s"
        ))?
        .map_err(|_| anyhow::anyhow!(
            "Transfer notifier channel dropped for {transfer_id}"
        ))?;

    if !accepted {
        anyhow::bail!("Transfer {transfer_id} declined by receiver");
    }

    // ── Build manifest ────────────────────────────────────────────────────────
    let file_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let file_entries: Vec<(String, String, u64)> = files
        .iter()
        .map(|f| (f.name.clone(), f.path.clone(), f.size_bytes))
        .collect();

    let manifest = build_manifest(
        transfer_id.clone(),
        SenderDevice {
            id:   own_id,
            name: own_name,
            os:   std::env::consts::OS.to_string(),
            ip:   own_ip,
            port: own_port,
        },
        &file_entries,
        NUM_STREAMS,
    )
    .await?;

    // ── POST /manifest ────────────────────────────────────────────────────────
    let resume: ResumeManifest = reqwest::Client::new()
        .post(format!("http://{}:{}/manifest", target.ip, target.port))
        .json(&manifest)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Manifest POST to {} failed: {e}", target.ip))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("ResumeManifest deserialize failed: {e}"))?;

    // ── Stream ────────────────────────────────────────────────────────────────
    send_multi_stream(&manifest, &resume, &target, &file_paths, &app).await
}

/// Sends a plain-text message to the target's /text/:tid endpoint.
/// No accept/decline flow — fires and forgets over HTTP.
pub async fn send_text_to_device(
    transfer_id: String,
    target:      Device,
    text:        String,
    state:       SharedState,
    _app:        AppHandle,
) -> anyhow::Result<()> {
    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };

    let own_ip = local_ip_address::local_ip()
        .ok()
        .and_then(|ip| match ip {
            std::net::IpAddr::V4(v4) => Some(v4.to_string()),
            _                        => None,
        })
        .unwrap_or_else(|| "127.0.0.1".to_string());

    reqwest::Client::new()
        .post(format!("http://{}:{}/text/{}", target.ip, target.port, transfer_id))
        .header("x-sender-id",   &own_id)
        .header("x-sender-name", &own_name)
        .header("x-sender-ip",   &own_ip)
        .header("x-sender-port", own_port.to_string())
        .header("x-sender-os",   std::env::consts::OS)
        .body(text)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Text send to {} failed: {e}", target.ip))?;

    Ok(())
}

// ── send_multi_stream ─────────────────────────────────────────────────────────

/// Stream all files in `manifest` to `target`.
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

        // Non-completed chunk IDs in ascending order; forward seeks maximise
        // OS read-ahead on the source file.
        let queue: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new(
            fm.chunks
                .iter()
                .filter(|c| !completed.contains(&c.id))
                .map(|c| c.id)
                .collect(),
        ));

        // ── Overseer ──────────────────────────────────────────────────────────
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

        // ── Workers ───────────────────────────────────────────────────────────
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

        // ── Drain workers — collect all errors before returning ───────────────
        let mut first_worker_err: Option<anyhow::Error> = None;
        while let Some(res) = join_set.join_next().await {
            match res {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_worker_err.is_none() { first_worker_err = Some(e); }
                }
                Err(je) => {
                    if first_worker_err.is_none() {
                        first_worker_err = Some(anyhow::anyhow!("Worker task panicked: {je}"));
                    }
                }
            }
        }

        let _ = shutdown_tx.send(true);

        let overseer_res = overseer_handle
            .await
            .map_err(|je| anyhow::anyhow!("Overseer task panicked: {je}"))
            .and_then(|r| r);

        if let Err(e) = overseer_res   { return Err(e); }
        if let Some(e) = first_worker_err { return Err(e); }

        eprintln!(
            "[StreamClient] File {fi} — all {} chunks confirmed, overseer verified",
            fm.total_chunks
        );
    }

    Ok(())
}

// ── Worker ────────────────────────────────────────────────────────────────────

/// Public wrapper. Always calls reclaim_worker before returning so orphaned
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

    overseer.reclaim_worker(worker_id).await;

    result
}

/// Inner implementation. May use `?` freely — reclaim_worker is handled by
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
            format!("RIFT-STREAM/1.0\n{transfer_id}\n{file_index}\n{worker_id}\n").as_bytes(),
        )
        .await?;

    line.clear();
    reader.read_line(&mut line).await?;
    if line.trim() != "READY" {
        anyhow::bail!("Worker {worker_id}: expected READY, got: {}", line.trim());
    }

    // ── Source file ───────────────────────────────────────────────────────────
    let mut src = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Worker {worker_id}: cannot open {file_path}: {e}"))?;

    eprintln!(
        "[StreamClient] Worker {worker_id} ready (file={file_index} transfer={transfer_id})"
    );

    // ── Chunk dispatch loop ───────────────────────────────────────────────────
    loop {
        let chunk_id = queue.lock().await.pop_front();

        let chunk_id = match chunk_id {
            Some(id) => id,
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
                    break;
                }

                tokio::time::sleep(IDLE_POLL_INTERVAL).await;
                continue;
            }
        };

        overseer.track_dispatch(chunk_id, worker_id).await;

        let chunk_info = file_manifest
            .chunks
            .get(chunk_id)
            .ok_or_else(|| anyhow::anyhow!("Chunk {chunk_id} not in manifest"))?;

        src.seek(tokio::io::SeekFrom::Start(chunk_info.offset))
            .await
            .map_err(|e| anyhow::anyhow!("Worker {worker_id}: seek chunk {chunk_id}: {e}"))?;

        let mut buf = vec![0u8; chunk_info.size as usize];
        src.read_exact(&mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("Worker {worker_id}: read chunk {chunk_id}: {e}"))?;

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

        line.clear();
        match tokio::time::timeout(ACK_TIMEOUT, reader.read_line(&mut line)).await {
            Err(_)        => anyhow::bail!("Worker {worker_id}: ACK timeout chunk {chunk_id}"),
            Ok(Err(e))    => anyhow::bail!("Worker {worker_id}: ACK read error chunk {chunk_id}: {e}"),
            Ok(Ok(0))     => anyhow::bail!("Worker {worker_id}: connection closed before ACK chunk {chunk_id}"),
            Ok(Ok(_))     => {}
        }

        let resp = line.trim();

        if resp.starts_with("NACK") {
            let should_continue = overseer.track_nack(chunk_id).await;
            if !should_continue {
                anyhow::bail!(
                    "Worker {worker_id}: chunk {chunk_id} permanently failed \
                     (file={file_index} transfer={transfer_id})"
                );
            }
            continue;
        }

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

    writer.write_all(b"DONE\n").await?;
    eprintln!(
        "[StreamClient] Worker {worker_id} DONE (file={file_index} transfer={transfer_id})"
    );
    Ok(())
}