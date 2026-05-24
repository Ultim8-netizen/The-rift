//! Dual-stream TCP file sender.
//!
//! Opens two independent TCP connections to the receiver's stream server.
//! Stream 0 sends chunks in ascending order (forward from the start of the file).
//! Stream 1 sends chunks in descending order (backward from the end of the file).
//!
//! At any point during transfer, bytes exist at both ends of the pre-allocated
//! destination file. If the transfer is interrupted, the receiver's resume
//! manifest reports which chunks are already written. On reconnect the sender
//! skips those chunks entirely.
//!
//! Both streams run as concurrent Tokio tasks. The function returns when both
//! complete (or either fails).

use crate::state::Device;
use crate::transfer::manifest::{FileManifest, ResumeManifest, TransferManifest};
use crate::transfer::stream_server::STREAM_PORT;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Send all files to `target` using the dual-stream protocol.
/// `file_paths` must correspond 1-to-1 with `manifest.files`.
/// `resume` tells us which chunks are already on the receiver and can be skipped.
pub async fn send_dual_stream(
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

        // Split chunks by stream; exclude already-completed
        let mut s0_ids: Vec<usize> = fm
            .chunks
            .iter()
            .filter(|c| c.stream == 0 && !completed.contains(&c.id))
            .map(|c| c.id)
            .collect();
        let mut s1_ids: Vec<usize> = fm
            .chunks
            .iter()
            .filter(|c| c.stream == 1 && !completed.contains(&c.id))
            .map(|c| c.id)
            .collect();

        // Stream 0 ascending, stream 1 descending
        s0_ids.sort_unstable();
        s1_ids.sort_unstable_by(|a, b| b.cmp(a));

        let tid = manifest.transfer_id.clone();
        let ip = target.ip.clone();

        // Clone everything for the two spawned tasks
        let fm0 = fm.clone();
        let fm1 = fm.clone();
        let fp0 = file_path.clone();
        let fp1 = file_path.clone();
        let tid0 = tid.clone();
        let tid1 = tid.clone();
        let ip0 = ip.clone();
        let ip1 = ip.clone();
        let app0 = app.clone();
        let app1 = app.clone();

        let task0 = tokio::spawn(async move {
            send_stream(tid0, fi, 0, s0_ids, fm0, fp0, ip0, STREAM_PORT, app0).await
        });
        let task1 = tokio::spawn(async move {
            send_stream(tid1, fi, 1, s1_ids, fm1, fp1, ip1, STREAM_PORT, app1).await
        });

        let (r0, r1) = tokio::join!(task0, task1);
        r0??;
        r1??;

        eprintln!("[StreamClient] File {fi} fully sent");
    }

    Ok(())
}

/// Send one stream's worth of chunks to the receiver.
async fn send_stream(
    transfer_id: String,
    file_index: usize,
    stream_id: u8,
    chunk_ids: Vec<usize>,
    file_manifest: Arc<FileManifest>,
    file_path: String,
    target_ip: String,
    port: u16,
    app: AppHandle,
) -> anyhow::Result<()> {
    if chunk_ids.is_empty() {
        eprintln!(
            "[StreamClient] stream {stream_id} has no chunks to send for file {file_index}"
        );
        return Ok(());
    }

    let addr = format!("{target_ip}:{port}");

    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("[StreamClient] Connect to {addr} timed out"))??;

    let (read_half, mut writer) = tcp.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    // Handshake
    writer
        .write_all(
            format!(
                "RIFT-STREAM/1.0\n{transfer_id}\n{file_index}\n{stream_id}\n"
            )
            .as_bytes(),
        )
        .await?;

    line.clear();
    reader.read_line(&mut line).await?;
    if line.trim() != "READY" {
        anyhow::bail!(
            "[StreamClient] Expected READY, got: {}",
            line.trim()
        );
    }

    eprintln!(
        "[StreamClient] Stream {stream_id} ready — sending {} chunks for file {file_index}",
        chunk_ids.len()
    );

    // Open source file once, seek to each chunk on demand
    let mut file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot open {file_path}: {e}"))?;

    for &chunk_id in &chunk_ids {
        let chunk_info = match file_manifest.chunks.get(chunk_id) {
            Some(c) => c,
            None => {
                anyhow::bail!("Chunk {chunk_id} not in manifest");
            }
        };

        // Seek to the chunk's position in the source file
        file.seek(tokio::io::SeekFrom::Start(chunk_info.offset))
            .await
            .map_err(|e| {
                anyhow::anyhow!("seek to {} for chunk {chunk_id}: {e}", chunk_info.offset)
            })?;

        let mut buf = vec![0u8; chunk_info.size as usize];
        file.read_exact(&mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("read chunk {chunk_id}: {e}"))?;

        // Send the CHUNK header
        writer
            .write_all(
                format!(
                    "CHUNK {} {} {} {}\n",
                    chunk_id, chunk_info.offset, chunk_info.size, chunk_info.blake3
                )
                .as_bytes(),
            )
            .await?;

        // Send raw bytes
        writer.write_all(&buf).await?;

        // Wait for ACK with timeout
        line.clear();
        let read_result = tokio::time::timeout(ACK_TIMEOUT, reader.read_line(&mut line)).await;
        match read_result {
            Err(_) => anyhow::bail!("ACK timeout for chunk {chunk_id}"),
            Ok(Err(e)) => anyhow::bail!("Read ACK error for chunk {chunk_id}: {e}"),
            Ok(Ok(0)) => anyhow::bail!("Connection closed before ACK for chunk {chunk_id}"),
            Ok(Ok(_)) => {}
        }

        let resp = line.trim();
        if resp.starts_with("NACK") {
            // The receiver rejected this chunk (hash mismatch). The resume
            // mechanism will retry it in the next session.
            anyhow::bail!("Chunk {chunk_id} NACKed by receiver: {resp}");
        }

        let _ = app.emit(
            "chunk_sent",
            &serde_json::json!({
                "transferId": transfer_id,
                "fileIndex": file_index,
                "chunkId": chunk_id,
                "streamId": stream_id,
            }),
        );
    }

    // Signal end of this stream
    writer.write_all(b"DONE\n").await?;
    eprintln!("[StreamClient] Stream {stream_id} DONE for file {file_index}");

    Ok(())
}