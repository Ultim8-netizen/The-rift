use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use tauri::{AppHandle, Emitter};

use crate::state::{
    PendingTransfer, SharedState, StreamReceiveState, TransferReceiveState, TransferRequest,
};
use crate::transfer::manifest::{ResumeManifest, TransferManifest};

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
        .route("/ping",               get(handle_ping))
        .route("/hello",              get(handle_hello))
        .route("/request",            post(handle_request))
        .route("/manifest",           post(handle_manifest))
        .route("/resume/:tid",        get(handle_resume))
        .route("/accept/:tid",        post(handle_accept))
        .route("/decline/:tid",       post(handle_decline))
        .route("/text/:tid",          post(handle_text))
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

/// Receives the TransferManifest from the sender.
/// Pre-allocates files on disk and returns a ResumeManifest.
/// If a transfer with this ID already exists (resume case), returns the
/// current completed-chunks state so the sender skips already-written chunks.
async fn handle_manifest(
    State(srv): State<Srv>,
    Json(manifest): Json<TransferManifest>,
) -> Result<Json<ResumeManifest>, StatusCode> {
    let tid = manifest.transfer_id.clone();

    // Check for existing state (resume)
    {
        let s = srv.state.lock().await;
        let existing = s.active_stream_transfers.get(&tid).cloned();
        drop(s);

        if let Some(ts) = existing {
            let mut completed_per_file = Vec::new();
            for fs in &ts.files {
                let locked = fs.completed_chunks.lock().await;
                completed_per_file.push(locked.iter().cloned().collect::<Vec<_>>());
            }
            eprintln!("[Manifest] Resume for {tid}");
            return Ok(Json(ResumeManifest { transfer_id: tid, completed_per_file }));
        }
    }

    // Fresh transfer — pre-allocate files
    let downloads = get_save_dir();
    if tokio::fs::create_dir_all(&downloads).await.is_err() {
        eprintln!("[Manifest] Cannot create downloads dir");
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let mut file_states: Vec<Arc<StreamReceiveState>> = Vec::new();

    for file_manifest in &manifest.files {
        let safe_name = sanitize(&file_manifest.name);
        let dest = unique_path(&downloads, &safe_name);

        // Create and pre-allocate the file.
        // set_len() reserves the space without writing zeros on NTFS (sparse);
        // on FAT32/exFAT it writes zeros, which is still correct.
        let file = match tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .open(&dest)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[Manifest] Cannot create {:?}: {e}", dest);
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };

        if let Err(e) = file.set_len(file_manifest.total_bytes).await {
            eprintln!("[Manifest] set_len({}) failed: {e}", file_manifest.total_bytes);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }

        eprintln!(
            "[Manifest] Pre-allocated {:?} ({} bytes)",
            dest, file_manifest.total_bytes
        );

        file_states.push(Arc::new(StreamReceiveState {
            manifest: file_manifest.clone(),
            completed_chunks: tokio::sync::Mutex::new(HashSet::new()),
            dest_path: dest,
            file_handle: tokio::sync::Mutex::new(file),
        }));
    }

    let total_files = file_states.len();
    let transfer_state = Arc::new(TransferReceiveState {
        transfer_id: tid.clone(),
        files: file_states,
        total_files,
        completed_files: AtomicUsize::new(0),
    });

    srv.state
        .lock()
        .await
        .active_stream_transfers
        .insert(tid.clone(), transfer_state);

    eprintln!("[Manifest] Registered {tid} — {} files", manifest.files.len());

    let completed_per_file = vec![vec![]; manifest.files.len()];
    Ok(Json(ResumeManifest { transfer_id: tid, completed_per_file }))
}

/// Returns the current ResumeManifest for an active transfer.
/// Used by the sender on reconnect to learn which chunks to skip.
async fn handle_resume(
    Path(tid): Path<String>,
    State(srv): State<Srv>,
) -> Result<Json<ResumeManifest>, StatusCode> {
    let ts = {
        let s = srv.state.lock().await;
        s.active_stream_transfers.get(&tid).cloned()
    };

    match ts {
        None => Err(StatusCode::NOT_FOUND),
        Some(ts) => {
            let mut completed_per_file = Vec::new();
            for fs in &ts.files {
                let locked = fs.completed_chunks.lock().await;
                completed_per_file.push(locked.iter().cloned().collect::<Vec<_>>());
            }
            Ok(Json(ResumeManifest { transfer_id: tid, completed_per_file }))
        }
    }
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
                "id":   sender_id,
                "name": if sender_name.is_empty() { "Unknown Device".to_string() } else { sender_name },
                "os":   if sender_os.is_empty()   { "unknown".to_string()         } else { sender_os   },
                "ip":   sender_ip,
                "port": sender_port,
                "latencyMs": null,
                "discoveredAt": 0,
            },
        }),
    );
    StatusCode::OK
}

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

fn header_str(h: &HeaderMap, key: &str) -> String {
    h.get(key).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
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