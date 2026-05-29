//! Raw TCP stream server on :7477.
//!
//! Each incoming connection is one worker from the sender.  There is no
//! longer any concept of "stream 0 owns the first half".  Any connection may
//! deliver any chunk.  Finalization fires exactly once, claimed atomically by
//! whichever connection writes the last missing chunk.
//!
//! Per-connection file handle
//! --------------------------
//! Each accepted connection opens its own `tokio::fs::File` for writing.
//! Chunks are written with seek+write on that private handle — no mutex,
//! no serialization between workers.  Because the chunks never overlap
//! (each chunk owns a unique byte range in the pre-allocated file), the OS
//! can process all workers' writes concurrently without corruption.
//!
//! Finalization gate
//! -----------------
//! After every successful chunk write the handler checks:
//!   `completed_chunks.len() == total_chunks`
//! The first connection to satisfy that condition atomically swaps
//! `StreamReceiveState::finalized` from false to true and spawns
//! `finalize_file`.  All other connections' swap attempts return true
//! and are ignored.
//!
//! Failure detection
//! -----------------
//! Every connection termination (DONE, clean close, or error) increments
//! `streams_done`.  When `streams_done >= streams_expected` and `finalized`
//! has not been set, we know all workers have stopped but chunks are missing
//! — a `transfer_error` event is emitted.

use crate::state::SharedState;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::io::SeekFrom;
use tauri::{AppHandle, Emitter};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

pub const STREAM_PORT: u16 = 7477;

pub async fn start_stream_server(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    let listener = TcpListener::bind(format!("0.0.0.0:{STREAM_PORT}")).await?;
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
    if let Err(e) = handle_connection_inner(stream, state, app).await {
        eprintln!("[StreamServer] Connection error: {e}");
    }
}

async fn handle_connection_inner(
    stream: TcpStream,
    state: SharedState,
    app: AppHandle,
) -> anyhow::Result<()> {
    let (read_half, mut writer) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    macro_rules! read_line {
        () => {{
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 { anyhow::bail!("Connection closed during handshake"); }
            line.trim().to_string()
        }};
    }

    // ── Handshake ────────────────────────────────────────────────────────────
    let hello = read_line!();
    if hello != "RIFT-STREAM/1.0" {
        anyhow::bail!("Unexpected handshake: {hello}");
    }
    let transfer_id  = read_line!();
    let file_index: usize = read_line!().parse()
        .map_err(|_| anyhow::anyhow!("Bad file_index"))?;
    let _worker_id: u8 = read_line!().parse().unwrap_or(0);

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

    writer.write_all(b"READY\n").await?;

    // ── Per-connection write handle ───────────────────────────────────────────
    // Each worker owns its own handle; no mutex, no serialization.
    // Writes to non-overlapping chunk regions are safe across handles.
    let mut dest_file: Option<tokio::fs::File> = Some(
        OpenOptions::new()
            .write(true)
            .open(&file_state.dest_path)
            .await
            .map_err(|e| anyhow::anyhow!("Cannot open dest {:?}: {e}", file_state.dest_path))?,
    );

    eprintln!(
        "[StreamServer] worker open — transfer={transfer_id} file={file_index}"
    );

    // ── Chunk receive loop ────────────────────────────────────────────────────
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                // Clean TCP close without DONE
                eprintln!(
                    "[StreamServer] Clean close without DONE \
                     (transfer={transfer_id} file={file_index})"
                );
                drop(dest_file);
                check_all_workers_done(&file_state, &app, &transfer_id).await;
                break;
            }
            Ok(_) => {}
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
            Ok(v) => v,
            Err(_) => { writer.write_all(b"NACK bad-id\n").await?; continue; }
        };
        let byte_offset: u64 = match parts[2].parse() {
            Ok(v) => v,
            Err(_) => {
                writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        };
        let size: usize = match parts[3].parse() {
            Ok(v) => v,
            Err(_) => {
                writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        };
        let expected_blake3 = parts[4].to_string();

        // Read chunk bytes
        let mut buf = vec![0u8; size];
        if let Err(e) = reader.read_exact(&mut buf).await {
            eprintln!("[StreamServer] read_exact failed chunk {chunk_id}: {e}");
            writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
            drop(dest_file);
            check_all_workers_done(&file_state, &app, &transfer_id).await;
            break;
        }

        // Verify BLAKE3
        let actual_blake3 = hex::encode(blake3::hash(&buf).as_bytes());
        if actual_blake3 != expected_blake3 {
            eprintln!("[StreamServer] BLAKE3 mismatch chunk {chunk_id}");
            writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
            continue;
        }

        // Idempotency check — skip write if already received
        {
            let completed = file_state.completed_chunks.lock().await;
            if completed.contains(&chunk_id) {
                drop(completed);
                writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        }

        // Write to dest file via per-connection handle
        match dest_file {
            Some(ref mut f) => {
                f.seek(SeekFrom::Start(byte_offset)).await
                    .map_err(|e| anyhow::anyhow!("Seek chunk {chunk_id}: {e}"))?;
                f.write_all(&buf).await
                    .map_err(|e| anyhow::anyhow!("Write chunk {chunk_id}: {e}"))?;
            }
            None => {
                // File handle closed — finalization already triggered by a
                // concurrent worker.  ACK without re-writing (idempotent).
                writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;
                continue;
            }
        }

        // Mark complete and check if this was the last missing chunk
        let all_done = {
            let mut completed = file_state.completed_chunks.lock().await;
            completed.insert(chunk_id);
            completed.len() == file_state.manifest.total_chunks
        };

        // ACK before (possibly slow) finalization
        writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;

        let _ = app.emit(
            "transfer_progress",
            &serde_json::json!({
                "transferId": transfer_id,
                "chunkIndex": chunk_id,
                "totalChunks": file_state.manifest.total_chunks,
                "totalBytes": file_state.manifest.total_bytes,
                "speedBytesPerSec": 0,
                "etaSeconds": null,
            }),
        );

        // ── Finalization: claimed by exactly one connection ────────────────
        if all_done && !file_state.finalized.swap(true, Ordering::SeqCst) {
            // Close our write handle before the hash pass opens a read handle.
            // The data is already in the OS page cache; closing the fd just
            // releases the kernel descriptor, not the cached pages.
            dest_file = None;

            let fs  = file_state.clone();
            let ts  = transfer_state.clone();
            let st  = state.clone();
            let ap  = app.clone();
            let tid = transfer_id.clone();
            tokio::spawn(async move {
                finalize_file(tid, file_index, fs, ts, st, ap).await;
            });

            // This connection's work is done; let the loop drain cleanly
            // (expect DONE next, then break).
        }
    }

    Ok(())
}

/// Increments `streams_done` for this file and, when every expected worker
/// has terminated, checks whether all chunks arrived.  If chunks are missing
/// and finalization hasn't already fired (success path), emits `transfer_error`.
async fn check_all_workers_done(
    file_state: &Arc<crate::state::StreamReceiveState>,
    app: &AppHandle,
    transfer_id: &str,
) {
    let done = file_state.streams_done.fetch_add(1, Ordering::SeqCst) + 1;
    if done >= file_state.streams_expected {
        let received = file_state.completed_chunks.lock().await.len();
        if received < file_state.manifest.total_chunks
            && !file_state.finalized.swap(true, Ordering::SeqCst)
        {
            eprintln!(
                "[StreamServer] All workers done but only {}/{} chunks for {} in {}",
                received,
                file_state.manifest.total_chunks,
                file_state.manifest.name,
                transfer_id
            );
            let _ = app.emit(
                "transfer_error",
                &serde_json::json!({
                    "transferId": transfer_id,
                    "message": format!(
                        "Transfer incomplete: received {}/{} chunks for {}",
                        received,
                        file_state.manifest.total_chunks,
                        file_state.manifest.name
                    ),
                }),
            );
        }
    }
}

/// Verify the assembled file end-to-end with BLAKE3 and emit the result.
/// Called only once per file, after the last chunk is confirmed on disk.
/// No shared write handle exists at this point — each worker closed its own.
async fn finalize_file(
    transfer_id: String,
    file_index: usize,
    file_state: Arc<crate::state::StreamReceiveState>,
    transfer_state: Arc<crate::state::TransferReceiveState>,
    state: SharedState,
    app: AppHandle,
) {
    // Open a fresh read handle.  All per-connection write handles were closed
    // before finalization was spawned, so the kernel page cache is coherent.
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
            "[StreamServer] Full-file BLAKE3 mismatch for file {file_index} in {transfer_id}\n  \
             expected: {}\n  actual:   {}",
            file_state.manifest.file_blake3, actual_blake3
        );
        let _ = app.emit(
            "transfer_error",
            &serde_json::json!({
                "transferId": transfer_id,
                "message": format!("File integrity check failed: {}", file_state.manifest.name),
            }),
        );
        return;
    }

    eprintln!(
        "[StreamServer] File {file_index} verified — {}",
        file_state.manifest.name
    );

    let prev = transfer_state.completed_files.fetch_add(1, Ordering::SeqCst);
    let now = prev + 1;

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

async fn stream_hash_file(path: &std::path::Path) -> anyhow::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize().as_bytes()))
}