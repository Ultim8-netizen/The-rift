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

    let srv = Srv {
        state,
        app,
    };

    let router = Router::new()
        .route("/ping", get(handle_ping))
        .route("/request", post(handle_request))
        .route("/accept/:tid", post(handle_accept))
        .route("/decline/:tid", post(handle_decline))
        .route("/upload/:tid/:fi/:ci", post(handle_upload))
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

// Another device is requesting to send us files.
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

// Receiver accepted our outgoing transfer. Signal the waiting upload task.
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

// Receiver declined our outgoing transfer.
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

// Receive a file chunk from the sender.
// Path params: tid = transfer ID, fi = file index, ci = chunk index.
async fn handle_upload(
    Path((tid, fi, ci)): Path<(String, usize, usize)>,
    State(srv): State<Srv>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let expected_hash = header_str(&headers, "x-chunk-hash");
    let total_chunks = header_parse::<usize>(&headers, "x-total-chunks").unwrap_or(1);
    let total_files = header_parse::<usize>(&headers, "x-total-files").unwrap_or(1);
    let file_size = header_parse::<u64>(&headers, "x-file-size").unwrap_or(0);
    let file_name = header_str(&headers, "x-file-name");
    let file_name = if file_name.is_empty() {
        format!("rift_file_{fi}")
    } else {
        file_name
    };

    // Verify chunk integrity
    if !expected_hash.is_empty() && !integrity::verify_chunk(&body, &expected_hash) {
        eprintln!("[Upload] Hash mismatch: transfer={tid} file={fi} chunk={ci}");
        return StatusCode::BAD_REQUEST;
    }

    // Write chunk to a temp file. Chunk 0 creates/truncates; subsequent chunks append.
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

    // Emit progress
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

    // Last chunk of this file: move to Downloads
    if ci + 1 == total_chunks {
        let downloads = dirs::download_dir().unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Downloads")
        });

        let safe_name = sanitize(&file_name);
        let dest = unique_path(&downloads, &safe_name);

        // Try rename first (fast, same filesystem). Fall back to copy.
        if tokio::fs::rename(&temp_path, &dest).await.is_err() {
            if tokio::fs::copy(&temp_path, &dest).await.is_err() {
                eprintln!("[Upload] Could not save file to {:?}", dest);
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
            let _ = tokio::fs::remove_file(&temp_path).await;
        }

        // Last file in the transfer: emit complete
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