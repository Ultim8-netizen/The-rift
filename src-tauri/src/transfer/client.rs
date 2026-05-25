//! Dual-stream TCP file sender.
//!
//! Opens two independent TCP connections to the receiver's stream server.
//! Stream 0 sends chunks in ascending order (forward from the start of the file).
//! Stream 1 sends chunks in descending order (backward from the end of the file).

use crate::state::{Device, FileEntry, SharedState};
use crate::transfer::manifest::{build_manifest, ResumeManifest, SenderDevice};
use crate::transfer::stream_client::send_dual_stream;
use tauri::{AppHandle, Emitter};

/// Returns the local IP address that the OS would use to send traffic to `target_ip`.
/// Uses a connected UDP socket — no data is ever sent; the OS resolves the route
/// and the socket's local address reveals which interface would be used.
///
/// This is far more reliable than `local_ip_address::local_ip()` on machines with
/// multiple interfaces (WiFi + Ethernet + virtual adapters + link-local addresses),
/// where the "primary" IP is often not the one reachable from the target subnet.
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

    // Fallback — less reliable on multi-interface machines but better than crashing
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

    // ── KEY FIX ──────────────────────────────────────────────────────────────
    // Do NOT use local_ip_address::local_ip() here. That returns the default-route
    // interface IP, which on multi-interface machines (common on Windows with hotspot,
    // Ethernet, VPN, etc.) is likely NOT the IP reachable from the target device.
    // Instead, ask the OS which interface it would use to reach target.ip — that
    // is the IP the receiver must use when POSTing /accept back to us.
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

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    state
        .lock()
        .await
        .transfer_notifiers
        .insert(transfer_id.clone(), tx);

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
    )
    .await
    .map_err(|e| anyhow::anyhow!("Manifest build failed: {e}"))?;

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

    eprintln!("[Client] Manifest accepted by receiver — launching dual streams");

    let file_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

    send_dual_stream(&manifest, &resume, &target, &file_paths, &app)
        .await
        .map_err(|e| anyhow::anyhow!("Dual-stream send failed: {e}"))?;

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

    // Same fix: use outbound IP for the target, not the default-route IP
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