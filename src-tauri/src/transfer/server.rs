use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::state::{PendingTransfer, SharedState, TransferRequest};
use crate::transfer::integrity;

pub const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4 MB

#[derive(Clone)]
struct Srv {
    state: SharedState,
    app: AppHandle,
}

pub async fn start_transfer_server(
    state: SharedState,
    app: AppHandle,
) -> anyhow::Result<()> {
    let port = state.lock().await.own_port;

    let srv = Srv { state, app };

    let router = Router::new()
        .route("/ping",              get(handle_ping))
        .route("/hello",             get(handle_hello))   // ← NEW: identity endpoint
        .route("/request",           post(handle_request))
        .route("/accept/:tid",       post(handle_accept))
        .route("/decline/:tid",      post(handle_decline))
        .route("/upload/:tid/:fi/:ci", post(handle_upload))
        .route("/text/:tid",         post(handle_text))
        .with_state(srv);

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("[Server] Listening on {addr}");
    axum::serve(listener, router).await?;
    Ok(())
}

async fn handle_ping() -> StatusCode {
    StatusCode::OK
}

/// Returns this device's identity so subnet_scan can identify us without mDNS.
async fn handle_hello(State(srv): State<Srv>) -> Json<serde_json::Value> {
    let s = srv.state.lock().await;
    Json(serde_json::json!({
        "id":   s.own_id,
        "name": s.own_device_name,
        "os":   std::env::consts::OS,
        "port": s.own_port,
    }))
}

async fn handle_request(
    State(srv): State<Srv>,
    Json(req): Json<TransferRequest>,
) -> StatusCode {
    let pending = PendingTransfer {
        transfer_id: req.transfer_id.clone(),
        sender_device: req.sender_device.clone(),
        files: req.files.clone(),
        total_bytes: req.total_bytes,
    };

    srv.state
        .lock()
        .await
        .pending_transfers
        .insert(req.transfer_id.clone(), pending);

    let _ = srv.app.emit(
        "incoming_transfer_request",
        &serde_json::json!({
            "transferId": req.transfer_id,
            "senderDevice": req.sender_device,
            "files": req.files,
            "totalBytes": req.total_bytes,
        }),
    );

    StatusCode::OK
}

async fn handle_accept(
    Path(tid): Path<String>,
    State(srv): State<Srv>,
) -> StatusCode {
    let tx = srv.state.lock().await.transfer_notifiers.remove(&tid);
    match tx {
        Some(tx) => {
            let _ = tx.send(true);
            StatusCode::OK
        }
        None => StatusCode::NOT_FOUND,
    }
}

async fn handle_decline(
    Path(tid): Path<String>,
    State(srv): State<Srv>,
) -> StatusCode {
    let tx = srv.state.lock().await.transfer_notifiers.remove(&tid);
    if let Some(tx) = tx {
        let _ = tx.send(false);
    }
    let _ = srv.app.emit(
        "transfer_error",
        &serde_json::json!({
            "transferId": tid,
            "message": "Transfer declined by recipient",
        }),
    );
    StatusCode::OK
}

async fn handle_upload(
    Path((tid, fi, ci)): Path<(String, usize, usize)>,
    State(srv): State<Srv>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let expected_hash = header_str(&headers, "x-chunk-hash");
    let total_chunks  = header_parse::<usize>(&headers, "x-total-chunks").unwrap_or(1);
    let total_files   = header_parse::<usize>(&headers, "x-total-files").unwrap_or(1);
    let file_size     = header_parse::<u64>(&headers, "x-file-size").unwrap_or(0);
    let file_name     = header_str(&headers, "x-file-name");
    let file_name = if file_name.is_empty() {
        format!("rift_file_{fi}")
    } else {
        file_name
    };

    if !expected_hash.is_empty() && !integrity::verify_chunk(&body, &expected_hash) {
        eprintln!("[Upload] Hash mismatch: transfer={tid} file={fi} chunk={ci}");
        return StatusCode::BAD_REQUEST;
    }

    let temp_dir = std::env::temp_dir().join("the-rift-incoming");
    if tokio::fs::create_dir_all(&temp_dir).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

    let temp_path = temp_dir.join(format!("{tid}_{fi}.tmp"));
    let open_result = if ci == 0 {
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp_path)
            .await
    } else {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temp_path)
            .await
    };

    match open_result {
        Ok(mut f) => {
            if f.write_all(&body).await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
        Err(e) => {
            eprintln!("[Upload] File open error: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    }

    let bytes_done = ((ci + 1) as u64 * CHUNK_SIZE as u64).min(file_size);
    let _ = srv.app.emit(
        "transfer_progress",
        &serde_json::json!({
            "transferId": tid,
            "chunkIndex": ci,
            "totalChunks": total_chunks,
            "bytesTransferred": bytes_done,
            "totalBytes": file_size,
            "speedBytesPerSec": 0,
            "etaSeconds": null,
        }),
    );

    if ci + 1 == total_chunks {
        let downloads = get_save_dir();

        if tokio::fs::create_dir_all(&downloads).await.is_err() {
            eprintln!("[Upload] Cannot create downloads dir: {:?}", downloads);
            return StatusCode::INTERNAL_SERVER_ERROR;
        }

        let safe_name = sanitize(&file_name);
        let dest = unique_path(&downloads, &safe_name);

        if tokio::fs::rename(&temp_path, &dest).await.is_err() {
            if tokio::fs::copy(&temp_path, &dest).await.is_err() {
                eprintln!("[Upload] Could not save file to {:?}", dest);
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
            let _ = tokio::fs::remove_file(&temp_path).await;
        }

        if fi + 1 == total_files {
            let _ = srv.app.emit(
                "transfer_complete",
                &serde_json::json!({
                    "transferId": tid,
                    "savePath": dest.to_string_lossy(),
                }),
            );
        }
    }

    StatusCode::OK
}

async fn handle_text(
    Path(tid): Path<String>,
    State(srv): State<Srv>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let text = match String::from_utf8(body.to_vec()) {
        Ok(t) => t,
        Err(_) => return StatusCode::BAD_REQUEST,
    };

    if text.trim().is_empty() {
        return StatusCode::BAD_REQUEST;
    }

    let sender_id   = header_str(&headers, "x-sender-id");
    let sender_name = header_str(&headers, "x-sender-name");
    let sender_ip   = header_str(&headers, "x-sender-ip");
    let sender_port = header_parse::<u16>(&headers, "x-sender-port").unwrap_or(7474);
    let sender_os   = header_str(&headers, "x-sender-os");

    let _ = srv.app.emit(
        "incoming_text",
        &serde_json::json!({
            "transferId": tid,
            "text": text,
            "senderDevice": {
                "id": sender_id,
                "name": if sender_name.is_empty() { "Unknown Device".to_string() } else { sender_name },
                "os": if sender_os.is_empty() { "unknown".to_string() } else { sender_os },
                "ip": sender_ip,
                "port": sender_port,
                "latencyMs": null,
                "discoveredAt": 0,
            },
        }),
    );

    StatusCode::OK
}

// ── Platform-conditional download directory ───────────────────────────────────

fn get_save_dir() -> PathBuf {
    #[cfg(target_os = "android")]
    {
        std::env::var("EXTERNAL_STORAGE")
            .map(|s| PathBuf::from(s).join("Download"))
            .unwrap_or_else(|_| PathBuf::from("/sdcard/Download"))
    }

    #[cfg(not(target_os = "android"))]
    {
        dirs::download_dir().unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Downloads")
        })
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn header_str(h: &HeaderMap, key: &str) -> String {
    h.get(key)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn header_parse<T: std::str::FromStr>(h: &HeaderMap, key: &str) -> Option<T> {
    h.get(key)?.to_str().ok()?.parse().ok()
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}

fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let mut dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let stem = std::path::Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let mut n = 1u32;
    loop {
        dest = dir.join(format!("{stem}({n}){ext}"));
        if !dest.exists() {
            return dest;
        }
        n += 1;
    }
}