//! Raw TCP stream server on :7477.
//!
//! Each incoming connection handles one half of a dual-stream transfer for
//! one file. Protocol (line-oriented UTF-8 + raw binary):
//!
//!   Client → "RIFT-STREAM/1.0\n"
//!   Client → "{transfer_id}\n"
//!   Client → "{file_index}\n"
//!   Client → "{stream_id}\n"        (0 or 1; informational only server-side)
//!   Server → "READY\n"
//!
//!   For each chunk:
//!     Client → "CHUNK {id} {offset} {size} {blake3_hex}\n"
//!     Client → [{size} raw bytes]
//!     Server → "ACK {id}\n"         on success
//!     Server → "NACK {id}\n"        on hash mismatch (client retries later)
//!
//!   Client → "DONE\n"              after sending all chunks for this stream
//!
//! Finalization gate (race-condition fix):
//!   Each file has a `streams_done` AtomicUsize (starts at 0, max 2).
//!   When a stream connection receives DONE it increments the counter.
//!   `finalize_file` is only called when `streams_done` reaches 2 — meaning
//!   both TCP connections have fully written all their chunks and sent DONE.
//!   This prevents the previous race where whichever stream delivered the
//!   last chunk triggered hashing while the other stream's final write was
//!   still in flight.

use crate::state::SharedState;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};
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
            if n == 0 {
                anyhow::bail!("Connection closed during handshake");
            }
            line.trim().to_string()
        }};
    }

    // Handshake
    let hello = read_line!();
    if hello != "RIFT-STREAM/1.0" {
        anyhow::bail!("Unexpected handshake: {hello}");
    }

    let transfer_id = read_line!();
    let file_index: usize = read_line!()
        .parse()
        .map_err(|_| anyhow::anyhow!("Bad file_index"))?;
    let stream_id: u8 = read_line!()
        .parse()
        .unwrap_or(0);

    // Look up transfer and file state
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
    eprintln!(
        "[StreamServer] stream {stream_id} open — transfer={transfer_id} file={file_index}"
    );

    // Chunk receive loop
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                // Clean TCP close without DONE — treat as implicit DONE so we
                // don't permanently block the streams_done gate.
                eprintln!(
                    "[StreamServer] stream {stream_id} closed without DONE \
                     (file={file_index}, transfer={transfer_id}) — treating as DONE"
                );
                try_finalize(
                    &transfer_id,
                    file_index,
                    stream_id,
                    &file_state,
                    &transfer_state,
                    &state,
                    &app,
                )
                .await;
                break;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("[StreamServer] read error: {e}");
                break;
            }
        }

        let cmd = line.trim();

        if cmd == "DONE" {
            eprintln!(
                "[StreamServer] DONE from stream {stream_id} for file {file_index}"
            );
            // ── RACE FIX ────────────────────────────────────────────────────
            // Increment streams_done and only finalize when both streams have
            // confirmed they finished writing. This replaces the old
            // `completed_count == total_chunks` trigger which fired as soon as
            // the last chunk arrived — potentially before the other stream had
            // flushed its own last write.
            try_finalize(
                &transfer_id,
                file_index,
                stream_id,
                &file_state,
                &transfer_state,
                &state,
                &app,
            )
            .await;
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
            Err(_) => {
                writer.write_all(b"NACK bad-id\n").await?;
                continue;
            }
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

        // Read exactly `size` bytes of chunk data
        let mut buf = vec![0u8; size];
        if let Err(e) = reader.read_exact(&mut buf).await {
            eprintln!("[StreamServer] read_exact failed for chunk {chunk_id}: {e}");
            writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
            break;
        }

        // BLAKE3 verify
        let actual_blake3 = hex::encode(blake3::hash(&buf).as_bytes());
        if actual_blake3 != expected_blake3 {
            eprintln!("[StreamServer] BLAKE3 mismatch chunk {chunk_id}");
            writer.write_all(format!("NACK {chunk_id}\n").as_bytes()).await?;
            continue;
        }

        // Seek to byte offset and write
        {
            let mut fh = file_state.file_handle.lock().await;
            use tokio::io::SeekFrom;
            fh.seek(SeekFrom::Start(byte_offset)).await.map_err(|e| {
                anyhow::anyhow!("seek to {byte_offset} failed: {e}")
            })?;
            fh.write_all(&buf).await.map_err(|e| {
                anyhow::anyhow!("write at {byte_offset} failed: {e}")
            })?;
        }

        // Mark chunk complete
        let completed_count = {
            let mut completed = file_state.completed_chunks.lock().await;
            completed.insert(chunk_id);
            completed.len()
        };

        writer.write_all(format!("ACK {chunk_id}\n").as_bytes()).await?;

        // Progress event
        let _ = app.emit(
            "transfer_progress",
            &serde_json::json!({
                "transferId": transfer_id,
                "chunkIndex": chunk_id,
                "totalChunks": file_state.manifest.total_chunks,
                "bytesTransferred": completed_count as u64
                    * crate::transfer::manifest::DEFAULT_CHUNK_SIZE as u64,
                "totalBytes": file_state.manifest.total_bytes,
                "speedBytesPerSec": 0,
                "etaSeconds": null,
            }),
        );

        // NOTE: we no longer trigger finalization here based on chunk count.
        // Finalization is exclusively gated on streams_done reaching 2 (DONE
        // received from both stream connections), which happens below in
        // try_finalize when each stream sends its DONE command.
    }

    Ok(())
}

/// Increment `streams_done` for this file. When the counter reaches 2 (both
/// TCP stream connections have sent DONE), verify that all expected chunks
/// actually arrived and then kick off finalization.
///
/// The extra chunk-count guard catches the edge case where a stream closed
/// without sending every chunk — in that scenario we emit an error rather
/// than hashing a partial file.
async fn try_finalize(
    transfer_id: &str,
    file_index: usize,
    stream_id: u8,
    file_state: &Arc<crate::state::StreamReceiveState>,
    transfer_state: &Arc<crate::state::TransferReceiveState>,
    state: &SharedState,
    app: &AppHandle,
) {
    let prev = file_state.streams_done.fetch_add(1, Ordering::SeqCst);
    let now  = prev + 1;

    eprintln!(
        "[StreamServer] stream {stream_id} DONE — streams_done={now}/2 \
         for file {file_index} in {transfer_id}"
    );

    // Only the stream that brings the counter to 2 proceeds.
    if now != 2 {
        return;
    }

    // Both streams done — verify chunk completeness before hashing.
    let received = file_state.completed_chunks.lock().await.len();
    let expected = file_state.manifest.total_chunks;

    if received != expected {
        eprintln!(
            "[StreamServer] Chunk count mismatch for file {file_index} in {transfer_id}: \
             received {received}/{expected} — emitting error"
        );
        let _ = app.emit(
            "transfer_error",
            &serde_json::json!({
                "transferId": transfer_id,
                "message": format!(
                    "Incomplete transfer: {} received {}/{} chunks",
                    file_state.manifest.name, received, expected
                ),
            }),
        );
        return;
    }

    // All chunks present and both streams confirmed done — safe to hash.
    let tid = transfer_id.to_string();
    let fs  = file_state.clone();
    let ts  = transfer_state.clone();
    let st  = state.clone();
    let ap  = app.clone();
    tokio::spawn(async move {
        finalize_file(tid, file_index, fs, ts, st, ap).await;
    });
}

/// Verify the assembled file with BLAKE3 and emit the appropriate event.
/// Uses a streaming read to avoid loading the entire file into RAM.
async fn finalize_file(
    transfer_id: String,
    file_index: usize,
    file_state: Arc<crate::state::StreamReceiveState>,
    transfer_state: Arc<crate::state::TransferReceiveState>,
    state: SharedState,
    app: AppHandle,
) {
    // Flush the file handle before reading back
    {
        let mut fh = file_state.file_handle.lock().await;
        if let Err(e) = fh.flush().await {
            eprintln!("[StreamServer] flush failed: {e}");
        }
    }

    // Stream-hash the file to avoid loading it into RAM
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
            "[StreamServer] Full-file BLAKE3 mismatch for file {file_index} \
             in {transfer_id}\n  expected: {}\n  actual:   {}",
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
        "[StreamServer] File {file_index} verified — {}",
        file_state.manifest.name
    );

    // Atomically increment completed file count
    let prev = transfer_state
        .completed_files
        .fetch_add(1, Ordering::SeqCst);
    let now = prev + 1;

    eprintln!(
        "[StreamServer] {now}/{} files complete for {transfer_id}",
        transfer_state.total_files
    );

    if now == transfer_state.total_files {
        // All files complete — clean up state and notify frontend
        state.lock().await.active_stream_transfers.remove(&transfer_id);
        let save_path = file_state.dest_path.to_string_lossy().to_string();
        let _ = app.emit(
            "transfer_complete",
            &serde_json::json!({
                "transferId": transfer_id,
                "savePath": save_path,
            }),
        );
        eprintln!("[StreamServer] Transfer {transfer_id} complete");
    }
}

async fn stream_hash_file(path: &std::path::Path) -> anyhow::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024]; // 8 MB read buffer
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize().as_bytes()))
}