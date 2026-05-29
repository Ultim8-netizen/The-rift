//! Dual-stream TCP file sender.
//!
//! Builds a transfer manifest, negotiates with the receiver, then delegates
//! the actual byte transfer to `send_multi_stream`.

use crate::state::{Device, FileEntry, SharedState};
use crate::transfer::manifest::{build_manifest, ResumeManifest, SenderDevice};
use crate::transfer::stream_client::{send_multi_stream, NUM_STREAMS};
use tauri::{AppHandle, Emitter};

/// Returns the local IP that the OS would route through to reach `target_ip`.
/// Uses a connected UDP socket — no data is sent; the OS resolves the
/// routing table and the socket's local address reveals the correct interface.
fn outbound_ip_for(target_ip: &str) -> String {
    use std::net::UdpSocket;

    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect(format!("{target_ip}:7474")).is_ok() {
            if let Ok(local) = sock.local_addr() {
                let ip = local.ip().to_string();
                if ip != "0.0.0.0" && ip != "::" && ip != "127.0.0.1" {
                    eprintln!("[Client] Outbound IP for {target_ip} → {ip}");
                    return ip;
                }
            }
        }
    }

    let fallback = local_ip_address::local_ip()
        .unwrap_or_else(|_| "127.0.0.1".parse().unwrap())
        .to_string();
    eprintln!("[Client] outbound_ip_for fallback for {target_ip} → {fallback}");
    fallback
}

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

    let own_ip = outbound_ip_for(&target.ip);

    let sender_device_full = Device {
        id: own_id.clone(),
        name: own_name.clone(),
        os: std::env::consts::OS.to_string(),
        ip: own_ip.clone(),
        port: own_port,
        latency_ms: None,
        discovered_at: 0,
    };

    let total_bytes: u64 = files.iter().map(|f| f.size_bytes).sum();

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // ── Notify receiver ───────────────────────────────────────────────────────
    let req_url = format!("http://{}:{}/request", target.ip, target.port);
    let req_body = crate::state::TransferRequest {
        transfer_id: transfer_id.clone(),
        sender_device: sender_device_full.clone(),
        files: files.clone(),
        total_bytes,
    };
    http.post(&req_url)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Cannot reach target: {e}"))?;

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

    // ── Wait for accept/decline ───────────────────────────────────────────────
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    state.lock().await.transfer_notifiers.insert(transfer_id.clone(), tx);

    let accepted = match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(v)) => v,
        _ => {
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

    // ── Build manifest (includes NUM_STREAMS so receiver knows expected DONEs) ─
    let sender_device_manifest = SenderDevice {
        id: own_id.clone(),
        name: own_name.clone(),
        os: std::env::consts::OS.to_string(),
        ip: own_ip.clone(),
        port: own_port,
    };

    let file_tuples: Vec<(String, String, u64)> = files
        .iter()
        .map(|f| (f.name.clone(), f.path.clone(), f.size_bytes))
        .collect();

    eprintln!("[Client] Building manifest for {transfer_id} ({} files)", files.len());
    let manifest = build_manifest(
        transfer_id.clone(),
        sender_device_manifest,
        &file_tuples,
        NUM_STREAMS,
    )
    .await
    .map_err(|e| anyhow::anyhow!("Manifest build failed: {e}"))?;

    // ── Exchange manifest with receiver ───────────────────────────────────────
    let manifest_url = format!("http://{}:{}/manifest", target.ip, target.port);
    let resume: ResumeManifest = http
        .post(&manifest_url)
        .json(&manifest)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("POST /manifest failed: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("Deserialize ResumeManifest failed: {e}"))?;

    eprintln!("[Client] Manifest accepted — launching {NUM_STREAMS} stream workers");

    let file_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

    send_multi_stream(&manifest, &resume, &target, &file_paths, &app)
        .await
        .map_err(|e| anyhow::anyhow!("Multi-stream send failed: {e}"))?;

    eprintln!("[Client] Transfer {transfer_id} send phase complete");
    Ok(())
}

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

    let own_ip = outbound_ip_for(&target.ip);

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
                "targetDevice": { "id": target.id, "name": target.name },
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