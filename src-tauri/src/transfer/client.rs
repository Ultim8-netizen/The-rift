use crate::state::{Device, FileEntry, SharedState, TransferRequest};
use crate::transfer::integrity;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;

pub const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4 MB

pub async fn send_files_to_device(
    transfer_id: String,
    target: Device,
    files: Vec<FileEntry>,
    state: SharedState,
    app: AppHandle,
) -> anyhow::Result<()> {
    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };

    let own_ip = local_ip_address::local_ip()
        .unwrap_or_else(|_| "127.0.0.1".parse().unwrap())
        .to_string();

    let sender_device = Device {
        id: own_id,
        name: own_name,
        os: std::env::consts::OS.to_string(),
        ip: own_ip,
        port: own_port,
        latency_ms: None,
        discovered_at: 0,
    };

    let total_bytes: u64 = files.iter().map(|f| f.size_bytes).sum();
    let total_files = files.len();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let req_url = format!("http://{}:{}/request", target.ip, target.port);
    let req_body = TransferRequest {
        transfer_id: transfer_id.clone(),
        sender_device: sender_device.clone(),
        files: files.clone(),
        total_bytes,
    };

    client.post(&req_url).json(&req_body).send().await
        .map_err(|e| anyhow::anyhow!("Failed to reach target: {e}"))?;

    let _ = app.emit(
        "transfer_started",
        &serde_json::json!({
            "id": transfer_id,
            "direction": "outgoing",
            "status": "connecting",
            "files": files,
            "targetDevice": target,
            "senderDevice": null,
            "totalBytes": total_bytes,
            "bytesTransferred": 0,
            "speedBytesPerSec": 0,
            "etaSeconds": null,
            "startedAt": null,
            "completedAt": null,
            "errorMessage": null,
            "savePath": null,
        }),
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    state
        .lock()
        .await
        .transfer_notifiers
        .insert(transfer_id.clone(), tx);

    let accepted = match tokio::time::timeout(
        std::time::Duration::from_secs(60),
        rx,
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => false,
        Err(_) => {
            state.lock().await.transfer_notifiers.remove(&transfer_id);
            false
        }
    };

    if !accepted {
        let _ = app.emit(
            "transfer_error",
            &serde_json::json!({
                "transferId": transfer_id,
                "message": "Transfer was declined or timed out",
            }),
        );
        return Ok(());
    }

    let base_url = format!("http://{}:{}", target.ip, target.port);
    let start = std::time::Instant::now();
    let mut global_bytes_sent: u64 = 0;

    for (fi, file_entry) in files.iter().enumerate() {
        upload_file(
            &client,
            &transfer_id,
            fi,
            total_files,
            file_entry,
            total_bytes,
            &base_url,
            &app,
            &mut global_bytes_sent,
            start,
        )
        .await?;
    }

    Ok(())
}

async fn upload_file(
    client: &reqwest::Client,
    transfer_id: &str,
    fi: usize,
    total_files: usize,
    entry: &FileEntry,
    total_bytes: u64,
    base_url: &str,
    app: &AppHandle,
    global_bytes_sent: &mut u64,
    start: std::time::Instant,
) -> anyhow::Result<()> {
    let mut file = tokio::fs::File::open(&entry.path).await
        .map_err(|e| anyhow::anyhow!("Cannot open {}: {e}", entry.path))?;

    let file_size = entry.size_bytes;
    let total_chunks = ((file_size as usize).saturating_add(CHUNK_SIZE - 1)) / CHUNK_SIZE;
    let total_chunks = total_chunks.max(1);

    for ci in 0..total_chunks {
        let mut buf = vec![0u8; CHUNK_SIZE];
        let bytes_read = file.read(&mut buf).await?;
        if bytes_read == 0 {
            break;
        }
        buf.truncate(bytes_read);

        let hash = integrity::hash_chunk(&buf);
        let url = format!("{base_url}/upload/{transfer_id}/{fi}/{ci}");

        let resp = client
            .post(&url)
            .header("x-chunk-hash", &hash)
            .header("x-total-chunks", total_chunks.to_string())
            .header("x-file-size", file_size.to_string())
            .header("x-file-name", &entry.name)
            .header("x-total-files", total_files.to_string())
            .body(buf)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Chunk send failed: {e}"))?;

        if !resp.status().is_success() {
            anyhow::bail!("Chunk rejected: HTTP {}", resp.status());
        }

        *global_bytes_sent += bytes_read as u64;

        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            (*global_bytes_sent as f64 / elapsed) as u64
        } else {
            0
        };
        let remaining = total_bytes.saturating_sub(*global_bytes_sent);
        let eta = if speed > 0 {
            Some(remaining / speed)
        } else {
            None
        };

        let _ = app.emit(
            "transfer_progress",
            &serde_json::json!({
                "transferId": transfer_id,
                "chunkIndex": ci,
                "totalChunks": total_chunks,
                "bytesTransferred": global_bytes_sent,
                "totalBytes": total_bytes,
                "speedBytesPerSec": speed,
                "etaSeconds": eta,
            }),
        );
    }

    Ok(())
}

/// Send raw text to a peer device.
/// The receiver emits an `incoming_text` event on their side.
pub async fn send_text_to_device(
    transfer_id: String,
    target: Device,
    text: String,
    state: SharedState,
    app: AppHandle,
) -> anyhow::Result<()> {
    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };

    let own_ip = local_ip_address::local_ip()
        .unwrap_or_else(|_| "127.0.0.1".parse().unwrap())
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let url = format!("http://{}:{}/text/{}", target.ip, target.port, transfer_id);

    let resp = client
        .post(&url)
        .header("x-sender-id", &own_id)
        .header("x-sender-name", &own_name)
        .header("x-sender-ip", &own_ip)
        .header("x-sender-port", own_port.to_string())
        .header("x-sender-os", std::env::consts::OS)
        .header("content-type", "text/plain; charset=utf-8")
        .body(text.clone())
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Text send failed: {e}"))?;

    if resp.status().is_success() {
        let _ = app.emit(
            "text_sent",
            &serde_json::json!({
                "transferId": transfer_id,
                "targetDevice": {
                    "id": target.id,
                    "name": target.name,
                },
                "length": text.len(),
            }),
        );
    } else {
        let _ = app.emit(
            "transfer_error",
            &serde_json::json!({
                "transferId": transfer_id,
                "message": format!("Text send failed: HTTP {}", resp.status()),
            }),
        );
    }

    Ok(())
}