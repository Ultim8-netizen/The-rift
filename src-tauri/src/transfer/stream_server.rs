//! Raw TCP stream server on :7477.
//!
//! Each incoming connection is one pipelined worker from the sender.  Any
//! connection may deliver any chunk in any order.  Chunks are written directly
//! to their byte offset in the pre-allocated destination file via a
//! per-connection file handle (no shared mutex).
//!
//! Receiver-side optimisations in this revision
//! ─────────────────────────────────────────────
//! • TCP_NODELAY on every accepted socket — ACK responses go out immediately
//!   rather than being held by Nagle's algorithm (up to 40 ms delay per ACK).
//! • BufReader capacity = STREAM_SERVER_READ_BUF (4 MiB) — one kernel read()
//!   syscall fills the buffer with a full 2 MiB chunk body rather than 256
//!   successive 8 KiB reads (the tokio::io::BufReader default).
//! • SO_RCVBUF = 8 MiB on the listening socket — inherits to all accepted
//!   connections, preventing the sender's TCP window from stalling while the
//!   application layer is occupied with disk I/O.
//! • Single reusable chunk_buf per connection — one Vec allocation per
//!   connection instead of one per chunk (263 allocations for a 526 MB file).
//! • TCP keepalive on every accepted socket — OS RSTs the socket within ~11 s
//!   of a silent WiFi drop so the sender's worker triggers reconnect rather
//!   than stalling until ACK_TIMEOUT fires.

use crate::state::SharedState;
use crate::transfer::manifest::DEFAULT_CHUNK_SIZE;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::io::SeekFrom;
use tauri::{AppHandle, Emitter};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpSocket, TcpStream};

pub const STREAM_PORT: u16 = 7477;

/// BufReader capacity for the receive side.
///
/// With 2 MiB chunks and a sender using BufWriter flush bursts, the full chunk
/// body arrives in one OS-level burst.  A 4 MiB BufReader absorbs it in a
/// single read() syscall versus 256 syscalls with the 8 KiB default.
const STREAM_SERVER_READ_BUF: usize = 4 * 1024 * 1024;

pub async fn start_stream_server(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    // Use TcpSocket so we can set SO_RCVBUF before binding.  The large recv
    // buffer lets the OS absorb a full pipeline's worth of incoming chunk data
    // without stalling the sender's TCP window when disk I/O is busy.
    let sock = TcpSocket::new_v4()?;
    sock.set_reuseaddr(true)?;
    sock.set_recv_buffer_size(8 * 1024 * 1024)?;
    sock.bind(format!("0.0.0.0:{STREAM_PORT}").parse()?)?;
    let listener = sock.listen(1024)?;

    eprintln!("[StreamServer] Bound on :{STREAM_PORT}");
    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                eprintln!("[StreamServer] Connection from {addr}");
                let s = state.clone();
                let a = app.clone();
                tokio::spawn(handle_connection(stream, s, a));
            }
            Err(e) => eprintln!("[StreamServer] accept error: {e}"),
        }
    }
}

async fn handle_connection(stream: TcpStream, state: SharedState, app: AppHandle) {
    // TCP_NODELAY: ACK responses are ~12 bytes.  Without this, Nagle holds them
    // until either a 40 ms delayed-ACK timer fires or enough data accumulates,
    // adding 40 ms to every chunk's round trip on the sender side.
    let _ = stream.set_nodelay(true);
    // OS keepalive: if the WiFi drops mid-transfer, the OS RSTs the socket
    // within ~11 s and the sender's worker triggers reconnect. Without this,
    // a silent link failure would stall the transfer until ACK_TIMEOUT fires.
    crate::network::apply_tcp_keepalive(&stream);
    if let Err(e) = handle_connection_inner(stream, state, app).await {
        eprintln!("[StreamServer] Connection error: {e}");
    }
}

async fn handle_connection_inner(
    stream: TcpStream,
    state:  SharedState,
    app:    AppHandle,
) -> anyhow::Result<()> {
    let (read_half, mut writer) = stream.into_split();

    // 4 MiB BufReader: one kernel read() per 2 MiB chunk body instead of 256.
    // When the sender flushes a full pipeline burst, the BufReader absorbs both
    // chunk bodies at once so subsequent read_exact calls hit memory, not the kernel.
    let mut reader = BufReader::with_capacity(STREAM_SERVER_READ_BUF, read_half);
    let mut line   = String::new();

    macro_rules! read_line {
        () => {{
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 { anyhow::bail!("Connection closed during handshake"); }
            line.trim().to_string()
        }};
    }

    // ── Handshake ─────────────────────────────────────────────────────────────
    let hello = read_line!();
    if hello != "RIFT-STREAM/1.0" {
        anyhow::bail!("Unexpected handshake: {hello}");
    }
    let transfer_id       = read_line!();
    let file_index: usize = read_line!().parse()
        .map_err(|_| anyhow::anyhow!("Bad file_index"))?;
    let _worker_id: u8    = read_line!().parse().unwrap_or(0);

    // ── Look up transfer state ────────────────────────────────────────────────
    let transfer_state = {
        let s = state.lock().await;
        s.active_stream_transfers.get(&transfer_id).cloned()
    };
    let transfer_state = match transfer_state {
        Some(t) => t,
        None => {
            writer.write_all(b"ERR unknown transfer\n").await?;
            anyhow::bail!("Unknown transfer: {transfer_id}");
        }
    };

    let file_state = match transfer_state.files.get(file_index) {
        Some(fs) => fs.clone(),
        None => {
            writer.write_all(b"ERR bad file index\n").await?;
            anyhow::bail!("Bad file index {file_index} for {transfer_id}");
        }
    };

    // ── Per-connection write handle ───────────────────────────────────────────
    // Each worker owns its own handle — writes to non-overlapping byte ranges
    // are fully parallel with no mutex serialisation.
    let dest_file_result = OpenOptions::new()
        .write(true)
        .open(&file_state.dest_path)
        .await;

    let mut dest_file: Option<tokio::fs::File> = match dest_file_result {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!(
                "[StreamServer] Cannot open dest {:?}: {e} \
                 (transfer={transfer_id} file={file_index})",
                file_state.dest_path
            );
            check_all_workers_done(&file_state, &app, &transfer_id).await;
            return Err(anyhow::anyhow!(
                "Cannot open dest {:?}: {e}", file_state.dest_path
            ));
        }
    };

    writer.write_all(b"READY\n").await?;
    eprintln!(
        "[StreamServer] worker open — transfer={transfer_id} file={file_index}"
    );

    // Single reusable buffer sized to the largest possible chunk (DEFAULT_CHUNK_SIZE).
    // Eliminates one Vec allocation per chunk — 263 allocs of 2 MiB each for a
    // 526 MiB file — replaced by a single allocation per connection lifetime.
    let mut chunk_buf = vec![0u8; DEFAULT_CHUNK_SIZE];

    // ── Chunk receive loop ────────────────────────────────────────────────────
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                eprintln!(
                    "[StreamServer] Clean close without DONE \
                     (transfer={transfer_id} file={file_index})"
                );
                drop(dest_file);
                check_all_workers_done(&file_state, &app, &transfer_id).await;
                break;
            }
            Ok(_)  => {}
            Err(e) => {
                eprintln!("[StreamServer] Read error: {e}");
                drop(dest_file);
                check_all_workers_done(&file_state, &app, &transfer_id).await;
                break;
            }
        }

        let cmd = line.trim();

        if cmd == "DONE" {
            eprintln!(
                "[StreamServer] DONE (transfer={transfer_id} file={file_index})"
            );
            drop(dest_file);
            check_all_workers_done(&file_state, &app, &transfer_id).await;
            break;
        }

        if !cmd.starts_with("CHUNK ") {
            eprintln!("[StreamServer] Unexpected command: {cmd}");
            continue;
        }

        // Parse: "CHUNK {id} {offset} {size} {blake3}"
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.len() < 5 {
            writer.write_all(b"NACK malformed\n").await?;
            continue;
        }

        let chunk_id: usize = match parts[1].parse() {
            Ok(v)  => v,
            Err(_) => { writer.write_all(b"NACK bad-id\n").await?; continue; }
        };
        let byte_offset: u64 = match parts[2].parse() {
            Ok(v)  => v,
            Err(_) => {
                writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        };
        let size: usize = match parts[3].parse() {
            Ok(v)  => v,
            Err(_) => {
                writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        };
        let expected_blake3 = parts[4].to_string();

        // Slice the reusable buffer to this chunk's exact size.
        // read_exact fills only these bytes; blake3::hash and write_all consume
        // only this slice.  No heap allocation per chunk.
        let buf = &mut chunk_buf[..size];
        if let Err(e) = reader.read_exact(buf).await {
            eprintln!("[StreamServer] read_exact failed chunk {chunk_id}: {e}");
            writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
            drop(dest_file);
            check_all_workers_done(&file_state, &app, &transfer_id).await;
            break;
        }

        // Verify BLAKE3.  With opt-level = "3" both sides hash at multi-GB/s
        // via SIMD so this adds under 1 ms per 2 MiB chunk.
        let actual_blake3 = hex::encode(blake3::hash(buf).as_bytes());
        if actual_blake3 != expected_blake3 {
            eprintln!("[StreamServer] BLAKE3 mismatch chunk {chunk_id}");
            writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
            continue;
        }

        // Idempotency: skip write if already received (handles reconnect duplicates).
        {
            let completed = file_state.completed_chunks.lock().await;
            if completed.contains(&chunk_id) {
                drop(completed);
                writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        }

        // Write to dest file at the chunk's exact byte offset.
        match dest_file {
            Some(ref mut f) => {
                f.seek(SeekFrom::Start(byte_offset))
                    .await
                    .map_err(|e| anyhow::anyhow!("Seek chunk {chunk_id}: {e}"))?;
                f.write_all(buf)
                    .await
                    .map_err(|e| anyhow::anyhow!("Write chunk {chunk_id}: {e}"))?;
            }
            None => {
                // Finalisation already triggered — ACK without re-writing.
                writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        }

        let all_done = {
            let mut completed = file_state.completed_chunks.lock().await;
            completed.insert(chunk_id);
            completed.len() == file_state.manifest.total_chunks
        };

        // ACK before (potentially slow) finalisation path.
        // TCP_NODELAY ensures this small write goes out immediately so the
        // sender's pipeline can refill without waiting.
        writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;

        let _ = app.emit(
            "transfer_progress",
            &serde_json::json!({
                "transferId":  transfer_id,
                "chunkIndex":  chunk_id,
                "totalChunks": file_state.manifest.total_chunks,
                "totalBytes":  file_state.manifest.total_bytes,
                "speedBytesPerSec": 0,
                "etaSeconds":  null,
            }),
        );

        // Claim finalisation atomically — only the first connection to complete
        // the last chunk proceeds; all others are no-ops.
        if all_done && !file_state.finalized.swap(true, Ordering::SeqCst) {
            dest_file = None; // close write handle before hash pass opens read handle

            let fs  = file_state.clone();
            let ts  = transfer_state.clone();
            let st  = state.clone();
            let ap  = app.clone();
            let tid = transfer_id.clone();
            tokio::spawn(async move {
                finalize_file(tid, file_index, fs, ts, st, ap).await;
            });
        }
    }

    Ok(())
}

/// Increments the closed-connection counter and logs it.
/// Error detection for incomplete transfers is the sender's responsibility.
async fn check_all_workers_done(
    file_state:  &Arc<crate::state::StreamReceiveState>,
    _app:        &AppHandle,
    transfer_id: &str,
) {
    let done = file_state.streams_done.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!(
        "[StreamServer] Connection closed ({done} total, {} declared, transfer={transfer_id})",
        file_state.streams_expected
    );
}

/// Called exactly once per file (atomic `finalized` flag) after the last chunk
/// lands on disk.
///
/// When `file_blake3` is empty (current default — per-chunk BLAKE3 already
/// verified every byte), the full-file hash pass is skipped entirely.
/// This avoids a second sequential read of the assembled file (15-60 s for
/// multi-GB files) with no additional integrity benefit.
async fn finalize_file(
    transfer_id:    String,
    file_index:     usize,
    file_state:     Arc<crate::state::StreamReceiveState>,
    transfer_state: Arc<crate::state::TransferReceiveState>,
    state:          SharedState,
    app:            AppHandle,
) {
    // ── Optional full-file BLAKE3 check ───────────────────────────────────────
    if !file_state.manifest.file_blake3.is_empty() {
        let actual_blake3 = match stream_hash_file(&file_state.dest_path).await {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[StreamServer] Cannot hash file: {e}");
                let _ = app.emit(
                    "transfer_error",
                    &serde_json::json!({
                        "transferId": transfer_id,
                        "message": format!("Integrity check failed: {e}"),
                    }),
                );
                return;
            }
        };

        if actual_blake3 != file_state.manifest.file_blake3 {
            eprintln!(
                "[StreamServer] Full-file BLAKE3 mismatch for file {file_index} in \
                 {transfer_id}\n  expected: {}\n  actual:   {}",
                file_state.manifest.file_blake3, actual_blake3
            );
            let _ = app.emit(
                "transfer_error",
                &serde_json::json!({
                    "transferId": transfer_id,
                    "message": format!(
                        "File integrity check failed: {}",
                        file_state.manifest.name
                    ),
                }),
            );
            return;
        }

        eprintln!(
            "[StreamServer] File {file_index} full-file hash verified — {}",
            file_state.manifest.name
        );
    } else {
        eprintln!(
            "[StreamServer] File {file_index} complete — per-chunk integrity verified, \
             skipping full-file hash pass ({})",
            file_state.manifest.name
        );
    }

    let prev = transfer_state.completed_files.fetch_add(1, Ordering::SeqCst);
    let now  = prev + 1;

    eprintln!(
        "[StreamServer] {now}/{} files complete for {transfer_id}",
        transfer_state.total_files
    );

    if now == transfer_state.total_files {
        state.lock().await.active_stream_transfers.remove(&transfer_id);
        let save_path = file_state.dest_path.to_string_lossy().to_string();
        let _ = app.emit(
            "transfer_complete",
            &serde_json::json!({ "transferId": transfer_id, "savePath": save_path }),
        );
        eprintln!("[StreamServer] Transfer {transfer_id} complete");
    }
}

/// Streaming BLAKE3 of an on-disk file.
/// Only called when `file_blake3` is non-empty in the manifest (legacy senders).
async fn stream_hash_file(path: &std::path::Path) -> anyhow::Result<String> {
    use tokio::io::AsyncReadExt as _;
    let mut file   = tokio::fs::File::open(path).await?;
    let mut hasher = blake3::Hasher::new();
    let mut buf    = vec![0u8; 8 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize().as_bytes()))
}