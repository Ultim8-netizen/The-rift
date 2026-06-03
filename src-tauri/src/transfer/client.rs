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
//! The overseer runs as a concurrent background task.
//!
//! Pipelined dispatch
//! ──────────────────
//! Each worker maintains a sliding window of PIPELINE_DEPTH in-flight chunks.
//! The fill phase reads and buffers up to PIPELINE_DEPTH chunks into a single
//! BufWriter flush, then the drain phase reads one ACK.  This hides the full
//! receiver processing RTT (hash + write + ACK transit) behind the next chunk's
//! disk read and hash, keeping the network saturated at all times.
//!
//! Reconnection
//! ────────────
//! Workers survive transient TCP failures by reconnecting.  In-flight chunks
//! are reclaimed to the shared queue before each reconnect attempt.

use crate::state::{Device, FileEntry, SharedState, TransferRequest};
use crate::transfer::manifest::{
    build_manifest, FileManifest, ResumeManifest, SenderDevice, TransferManifest,
    DEFAULT_CHUNK_SIZE,
};
use crate::transfer::overseer::{FileOverseer, run_overseer};
use crate::transfer::stream_server::STREAM_PORT;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpSocket;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

/// Number of concurrent worker streams per file.
pub const NUM_STREAMS: usize = 4;

const CONNECT_TIMEOUT:    Duration = Duration::from_secs(10);
const ACK_TIMEOUT:        Duration = Duration::from_secs(30);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(200);
const ACCEPT_TIMEOUT:     Duration = Duration::from_secs(120);
const MAX_RECONNECT:      u8       = 12;
const RECONNECT_DELAY:    Duration = Duration::from_secs(5);

// ── Pipeline / socket tuning ──────────────────────────────────────────────────

/// Chunks sent ahead of their ACK per worker.  With PIPELINE_DEPTH = 2 and
/// NUM_STREAMS = 4, up to 8 × DEFAULT_CHUNK_SIZE bytes are in flight at once.
/// On a 100 Mbps hotspot this is ~640 ms of data — far above the 2 ms LAN RTT —
/// so receiver processing time is completely hidden and the wire stays saturated.
const PIPELINE_DEPTH: usize = 2;

/// OS-level TCP send buffer.  Large enough to hold a full pipeline burst so the
/// kernel never blocks the sender task waiting for socket buffer space.
const SOCKET_SEND_BUF: u32 = 8 * 1024 * 1024; // 8 MiB

/// BufWriter capacity: holds PIPELINE_DEPTH complete chunks so the header and
/// body of every chunk in a batch flush as a single burst rather than two
/// separate TCP segments (header line then raw bytes).
const CHUNK_PIPELINE_BUF: usize = (DEFAULT_CHUNK_SIZE + 512) * PIPELINE_DEPTH;

/// BufReader capacity for reading ACKs.  ACKs are tiny (≈ 12 bytes each) but a
/// larger buffer avoids kernel read() calls when multiple ACKs queue up.
const STREAM_READ_BUF: usize = 64 * 1024;

/// Emit chunk_sent IPC events only every N confirmed chunks.
/// Eliminates ~87.5% of JSON-serialise + webview-post overhead on fast links.
const EMIT_EVERY_N_CHUNKS: u32 = 8;

// ── Public orchestration ──────────────────────────────────────────────────────

/// Full file-send flow:
///   1. POST /request  → receiver's UI shows the incoming-transfer prompt.
///   2. Await accept/decline via our own server's transfer_notifiers channel.
///   3. Build TransferManifest (no file I/O — chunk sizes computed from stat).
///   4. POST /manifest → receiver pre-allocates files, returns ResumeManifest.
///   5. Call send_multi_stream to stream all chunks over NUM_STREAMS TCP workers.
pub async fn send_files_to_device(
    transfer_id: String,
    target:      Device,
    files:       Vec<FileEntry>,
    state:       SharedState,
    app:         AppHandle,
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

    let resume: ResumeManifest = reqwest::Client::new()
        .post(format!("http://{}:{}/manifest", target.ip, target.port))
        .json(&manifest)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Manifest POST to {} failed: {e}", target.ip))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("ResumeManifest deserialize failed: {e}"))?;

    send_multi_stream(&manifest, &resume, &target, &file_paths, &app).await
}

/// Sends a plain-text message to the target's /text/:tid endpoint.
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

        let queue: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new(
            fm.chunks
                .iter()
                .filter(|c| !completed.contains(&c.id))
                .map(|c| c.id)
                .collect(),
        ));

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

        if let Err(e) = overseer_res      { return Err(e); }
        if let Some(e) = first_worker_err { return Err(e); }

        eprintln!(
            "[StreamClient] File {fi} — all {} chunks confirmed, overseer verified",
            fm.total_chunks
        );
    }

    Ok(())
}

// ── Worker ────────────────────────────────────────────────────────────────────

/// Reconnecting wrapper around `stream_worker_inner`.
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
    let mut attempt = 0u8;

    loop {
        let result = stream_worker_inner(
            &transfer_id, file_index, worker_id,
            &queue, &file_manifest, &file_path,
            &target_ip, port, &app, &overseer,
        )
        .await;

        overseer.reclaim_worker(worker_id).await;

        match result {
            Ok(()) => return Ok(()),

            Err(e) => {
                attempt += 1;

                if !is_retriable(&e) {
                    return Err(e);
                }

                let (confirmed, failed) = overseer.completion_counts().await;
                if confirmed + failed >= overseer.total_chunks {
                    return Ok(());
                }

                if attempt >= MAX_RECONNECT {
                    return Err(anyhow::anyhow!(
                        "Worker {worker_id}: giving up after {MAX_RECONNECT} reconnect \
                         attempts (file={file_index} transfer={transfer_id}); \
                         last error: {e}"
                    ));
                }

                eprintln!(
                    "[StreamClient] Worker {worker_id} disconnected — reconnecting in {}s \
                     (attempt {attempt}/{MAX_RECONNECT}, {confirmed}/{} confirmed, \
                     file={file_index} transfer={transfer_id}): {e}",
                    RECONNECT_DELAY.as_secs(),
                    overseer.total_chunks,
                );

                tokio::time::sleep(RECONNECT_DELAY).await;
            }
        }
    }
}

fn is_retriable(e: &anyhow::Error) -> bool {
    let msg = e.to_string();
    !msg.contains("permanently failed")
        && !msg.contains("not in manifest")
        && !msg.contains("ERR unknown transfer")
        && !msg.contains("ERR bad file index")
        && !msg.contains("cannot open")
}

/// Inner implementation — pipelined, single connection lifetime.
///
/// Changes from the stop-and-wait version:
///
///   1. `TcpSocket` instead of `TcpStream::connect` — lets us set SO_SNDBUF
///      before connecting so the kernel never stalls the sender task.
///   2. `TCP_NODELAY` — disables Nagle so the flush burst goes out immediately
///      without waiting for the receiver's delayed-ACK timer (40 ms on many OSes).
///   3. `BufWriter` (CHUNK_PIPELINE_BUF capacity) — coalesces each chunk's
///      text header and binary body into a single `write()` syscall burst.
///   4. Sliding-window pipeline (depth PIPELINE_DEPTH) — the fill phase reads
///      and buffers up to PIPELINE_DEPTH chunks, flushes them all at once, then
///      the drain phase reads exactly one ACK.  In steady state the worker always
///      has one chunk in flight while a second is already at the receiver, hiding
///      the full round-trip from the sender's perspective.
///   5. Single reusable `chunk_buf` — one heap allocation per connection instead
///      of one per chunk, eliminating hundreds of MB-scale malloc/free calls.
///   6. Rate-limited IPC emit — one event per EMIT_EVERY_N_CHUNKS rather than
///      per chunk, cutting webview serialisation overhead on fast links.
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
    let addr: std::net::SocketAddr = format!("{target_ip}:{port}")
        .parse()
        .map_err(|_| anyhow::anyhow!("bad stream address: {target_ip}:{port}"))?;

    // TcpSocket lets us size SO_SNDBUF before connecting.  8 MiB gives the kernel
    // room to buffer a full pipeline burst without blocking the Tokio task.
    let socket = TcpSocket::new_v4()
        .map_err(|e| anyhow::anyhow!("TcpSocket::new_v4: {e}"))?;
    socket.set_send_buffer_size(SOCKET_SEND_BUF)?;

    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, socket.connect(addr))
        .await
        .map_err(|_| anyhow::anyhow!(
            "Worker {worker_id}: connect to {target_ip}:{port} timed out"
        ))??;

    // TCP_NODELAY: our BufWriter already coalesces header + data, so Nagle
    // buys nothing here.  Disabling it ensures the flush burst goes out
    // immediately and ACKs are not held up by the receiver's delayed-ACK timer.
    tcp.set_nodelay(true)?;

    let (read_half, write_half) = tcp.into_split();

    // BufWriter large enough to hold PIPELINE_DEPTH full chunks so header and
    // data flush as one burst per batch, not two separate TCP segments per chunk.
    let mut writer = BufWriter::with_capacity(CHUNK_PIPELINE_BUF, write_half);

    // 64 KiB is generous for ACK lines (~12 bytes each) but avoids kernel
    // read() calls when multiple ACKs are queued in the receive buffer.
    let mut reader = BufReader::with_capacity(STREAM_READ_BUF, read_half);
    let mut line   = String::new();

    // ── Handshake ─────────────────────────────────────────────────────────────
    writer
        .write_all(
            format!("RIFT-STREAM/1.0\n{transfer_id}\n{file_index}\n{worker_id}\n").as_bytes(),
        )
        .await?;
    writer.flush().await?;

    line.clear();
    reader.read_line(&mut line).await?;
    if line.trim() != "READY" {
        anyhow::bail!("Worker {worker_id}: expected READY, got: {}", line.trim());
    }

    // ── Source file ───────────────────────────────────────────────────────────
    let mut src = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Worker {worker_id}: cannot open {file_path}: {e}"))?;

    // Single reusable buffer sized to the largest chunk in this manifest —
    // normally DEFAULT_CHUNK_SIZE, last chunk may be smaller.
    // Avoids one Vec allocation per chunk (hundreds of MB-scale allocs per file).
    let max_chunk = file_manifest
        .chunks
        .iter()
        .map(|c| c.size as usize)
        .max()
        .unwrap_or(DEFAULT_CHUNK_SIZE);
    let mut chunk_buf = vec![0u8; max_chunk];

    // Sliding-window state: chunk IDs whose data has been sent but whose
    // ACK has not yet been received.
    let mut inflight: VecDeque<usize> = VecDeque::with_capacity(PIPELINE_DEPTH + 1);
    let mut emit_counter: u32 = 0;

    eprintln!(
        "[StreamClient] Worker {worker_id} ready (file={file_index} transfer={transfer_id})"
    );

    // ── Pipelined dispatch loop ───────────────────────────────────────────────
    //
    // Each iteration:
    //   Phase 1 — Fill: pop up to PIPELINE_DEPTH chunks from the shared queue,
    //             read + hash + write each one into the BufWriter.
    //   Phase 2 — Flush: push all buffered data to the OS in one burst so
    //             header + body arrive as a single TCP segment run.
    //   Phase 3 — Drain: read exactly one ACK (the oldest in-flight chunk).
    //
    // In steady state, one chunk's data is in flight over the network while
    // the sender is already processing the next chunk locally (disk read +
    // BLAKE3).  The receiver's full processing RTT is hidden behind local work.
    'outer: loop {
        // ── Phase 1: Fill pipeline ─────────────────────────────────────────────
        while inflight.len() < PIPELINE_DEPTH {
            let chunk_id = queue.lock().await.pop_front();
            let chunk_id = match chunk_id {
                Some(id) => id,
                None     => break, // queue empty — drain whatever is still inflight
            };

            overseer.track_dispatch(chunk_id, worker_id).await;

            let chunk_info = file_manifest
                .chunks
                .get(chunk_id)
                .ok_or_else(|| anyhow::anyhow!("Chunk {chunk_id} not in manifest"))?;

            // Slice the reusable buffer to this chunk's exact size.
            // BufWriter::write_all copies immediately into its internal buffer,
            // so we can safely overwrite chunk_buf on the next iteration.
            let data = &mut chunk_buf[..chunk_info.size as usize];

            src.seek(tokio::io::SeekFrom::Start(chunk_info.offset))
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Worker {worker_id}: seek chunk {chunk_id}: {e}"
                ))?;
            src.read_exact(data)
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Worker {worker_id}: read chunk {chunk_id}: {e}"
                ))?;

            // Compute hash from the actual bytes read — the manifest stub is
            // always empty (see manifest.rs).  opt-level = 3 keeps this fast
            // via BLAKE3's SIMD paths (AVX2 / NEON).
            let chunk_blake3 = hex::encode(blake3::hash(data).as_bytes());

            // Write header then body into BufWriter — both are held in the
            // internal buffer until flush() below, so they exit the process as
            // a single large write() syscall rather than two separate segments.
            writer
                .write_all(
                    format!(
                        "CHUNK {} {} {} {}\n",
                        chunk_id, chunk_info.offset, chunk_info.size, chunk_blake3
                    )
                    .as_bytes(),
                )
                .await?;
            writer.write_all(data).await?;

            inflight.push_back(chunk_id);
        }

        // ── Phase 2: Flush ─────────────────────────────────────────────────────
        // All chunks buffered above go to the OS in one burst.
        // TCP_NODELAY ensures they are transmitted immediately.
        writer.flush().await?;

        // ── Termination check ─────────────────────────────────────────────────
        if inflight.is_empty() {
            let (confirmed, failed) = overseer.completion_counts().await;
            if confirmed + failed >= overseer.total_chunks {
                break 'outer;
            }
            // Overseer may have re-queued NACKed chunks not yet visible in the
            // shared queue.  Brief sleep avoids a hot spin.
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
            continue 'outer;
        }

        // ── Phase 3: Drain one ACK ─────────────────────────────────────────────
        // Read the ACK for the oldest in-flight chunk.  While we wait, the
        // receiver is simultaneously processing the next chunk (if pipeline
        // depth > 1), so the RTT is almost fully hidden.
        let chunk_id = inflight.pop_front().unwrap();

        line.clear();
        match tokio::time::timeout(ACK_TIMEOUT, reader.read_line(&mut line)).await {
            Err(_)     => anyhow::bail!(
                "Worker {worker_id}: ACK timeout chunk {chunk_id}"
            ),
            Ok(Err(e)) => anyhow::bail!(
                "Worker {worker_id}: ACK read error chunk {chunk_id}: {e}"
            ),
            Ok(Ok(0))  => anyhow::bail!(
                "Worker {worker_id}: connection closed before ACK chunk {chunk_id}"
            ),
            Ok(Ok(_))  => {}
        }

        let resp = line.trim();

        if resp.starts_with("NACK") {
            // track_nack re-queues the chunk to the shared queue.
            // The next fill iteration will pick it up.
            let should_continue = overseer.track_nack(chunk_id).await;
            if !should_continue {
                anyhow::bail!(
                    "Worker {worker_id}: chunk {chunk_id} permanently failed \
                     (file={file_index} transfer={transfer_id})"
                );
            }
            continue 'outer;
        }

        overseer.track_confirmed(chunk_id).await;

        // Rate-limited IPC — emit every EMIT_EVERY_N_CHUNKS confirmed chunks
        // instead of every single one.  On a 100 Mbps link with 2 MiB chunks
        // this reduces webview serialisation calls from ~263 to ~33 per file.
        emit_counter = emit_counter.wrapping_add(1);
        if emit_counter % EMIT_EVERY_N_CHUNKS == 0 {
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
    }

    // Signal clean completion to the receiver's connection loop.
    writer.write_all(b"DONE\n").await?;
    writer.flush().await?;
    eprintln!(
        "[StreamClient] Worker {worker_id} DONE (file={file_index} transfer={transfer_id})"
    );
    Ok(())
}