// src-tauri/src/lib.rs
mod android_fs;
mod discovery;
mod network;
mod state;
mod transfer;

use state::{new_shared_state, HotspotInfo, SharedState, StagedFile};
use tauri::{Emitter, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatePayload {
    own_device_name: String,
    network_status: String,
    devices_in_range: usize,
}

#[tauri::command]
async fn get_app_state(state: State<'_, SharedState>) -> Result<AppStatePayload, String> {
    let s = state.lock().await;
    Ok(AppStatePayload {
        own_device_name: s.own_device_name.clone(),
        network_status: "searching".to_string(),
        devices_in_range: s.devices.len(),
    })
}

/// Launches the native file picker on Android and returns staged files ready
/// for transfer. Files are copied to the app's private cache directory inside
/// the activity result callback — while the URI grant is live — before this
/// command returns. No content:// URI ever reaches Rust.
///
/// On non-Android platforms this command returns an Err with a sentinel value
/// ("USE_DIALOG_PLUGIN") that the frontend uses to fall back to the existing
/// tauri-plugin-dialog + get_file_metadata flow.
#[tauri::command]
async fn pick_files_for_send() -> Result<Vec<StagedFile>, String> {
    #[cfg(target_os = "android")]
    {
        let picked = android_fs::trigger_android_picker()
            .await
            .map_err(|e| e.to_string())?;

        let staged: Vec<StagedFile> = picked
            .into_iter()
            .map(|f| StagedFile {
                name: f.name,
                path: f.path,
                size_bytes: f.size,
            })
            .collect();

        Ok(staged)
    }

    #[cfg(not(target_os = "android"))]
    {
        // Tell the frontend to use its existing dialog-plugin path.
        Err("USE_DIALOG_PLUGIN".to_string())
    }
}

/// Returns file metadata for the given paths.
/// On Android, paths must be plain filesystem paths (not content:// URIs).
/// In the new architecture, content:// URIs never reach this command —
/// RiftFilePicker copies them to cache and returns plain paths via
/// pick_files_for_send.
#[tauri::command]
async fn get_file_metadata(paths: Vec<String>) -> Result<Vec<StagedFile>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        match android_fs::resolve_paths(std::slice::from_ref(&path)).await {
            Ok(mut resolved) if !resolved.is_empty() => {
                let r = resolved.remove(0);
                out.push(StagedFile {
                    name: r.name,
                    path: r.real_path,
                    size_bytes: r.size,
                });
            }
            _ => {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                out.push(StagedFile {
                    name,
                    path,
                    size_bytes: 0,
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn start_discovery(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = discovery::start_discovery(s, app).await {
            eprintln!("[Discovery] Error: {e}");
        }
    });
    Ok(())
}

#[tauri::command]
async fn rescan(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    {
        let mut s = state.lock().await;
        s.devices.clear();
        s.rifted_devices.clear();
        s.heartbeat_failures.clear();
    }
    let _ = app.emit("devices_cleared", &serde_json::Value::Null);

    let s = state.inner().clone();
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = discovery::start_discovery(s, a).await {
            eprintln!("[Rescan] Discovery error: {e}");
        }
    });

    #[cfg(not(target_os = "android"))]
    {
        let s2 = state.inner().clone();
        let a2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let our_ip = local_ip_address::local_ip()
                .ok()
                .and_then(|ip| match ip {
                    std::net::IpAddr::V4(v4) => Some(v4),
                    _ => None,
                })
                .unwrap_or_else(|| "127.0.0.1".parse().unwrap());
            network::run_subnet_scan(our_ip, s2, a2).await;
        });
    }

    Ok(())
}

#[tauri::command]
async fn send_files(
    target_device_id: String,
    file_paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let (target, _own_id) = {
        let s = state.lock().await;
        let t = s
            .devices
            .get(&target_device_id)
            .cloned()
            .ok_or_else(|| "Device not found".to_string())?;
        (t, s.own_id.clone())
    };

    let resolved = android_fs::resolve_paths(&file_paths).await.map_err(|e| {
        eprintln!("[Send] Path resolution failed: {e}");
        e.to_string()
    })?;

    // On Android, file_paths contains pre-copied cache paths from pick_files_for_send.
    // The rift_send_ prefix identifies them so they can be cleaned up after transfer.
    #[allow(unused_mut)]
    let mut temp_paths: Vec<Option<String>> = resolved.iter().map(|r| r.temp_path.clone()).collect();

    #[cfg(target_os = "android")]
    for p in &file_paths {
        if std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("rift_send_"))
            .unwrap_or(false)
        {
            temp_paths.push(Some(p.clone()));
        }
    }

    let files: Vec<state::FileEntry> = resolved
        .into_iter()
        .map(|r| state::FileEntry {
            name: r.name,
            path: r.real_path,
            size_bytes: r.size,
            mime_type: "application/octet-stream".to_string(),
        })
        .collect();

    let transfer_id = uuid::Uuid::new_v4().to_string();

    {
        let total_bytes: u64 = files.iter().map(|f| f.size_bytes).sum();
        let files_json: Vec<serde_json::Value> = files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "name":      f.name,
                    "path":      f.path,
                    "sizeBytes": f.size_bytes,
                    "mimeType":  f.mime_type,
                })
            })
            .collect();
        let _ = app.emit(
            "transfer_started",
            &serde_json::json!({
                "id":               transfer_id,
                "direction":        "outgoing",
                "status":           "queued",
                "files":            files_json,
                "targetDevice":     &target,
                "senderDevice":     serde_json::Value::Null,
                "totalBytes":       total_bytes,
                "bytesTransferred": 0,
                "speedBytesPerSec": 0,
                "etaSeconds":       serde_json::Value::Null,
                "startedAt":        serde_json::Value::Null,
                "completedAt":      serde_json::Value::Null,
                "errorMessage":     serde_json::Value::Null,
                "savePath":         serde_json::Value::Null,
            }),
        );
    }

    let target_ip   = target.ip.clone();
    let target_port = target.port;
    let state_clone = state.inner().clone();
    let app_clone   = app.clone();
    let tid         = transfer_id.clone();

    tauri::async_runtime::spawn(async move {
        let result = transfer::send_files_to_device(
            tid.clone(),
            target,
            files,
            state_clone,
            app_clone.clone(),
        )
        .await;

        for temp in &temp_paths {
            if let Some(p) = temp {
                if let Err(e) = tokio::fs::remove_file(p).await {
                    eprintln!("[Send] Temp file cleanup failed ({p}): {e}");
                }
            }
        }

        match result {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                eprintln!("[Send] Transfer error: {e}");

                if msg.contains("declined by receiver") {
                    let _ = app_clone.emit(
                        "transfer_declined",
                        &serde_json::json!({ "transferId": tid }),
                    );
                } else {
                    let cancel_url = format!(
                        "http://{}:{}/cancel/{}",
                        target_ip, target_port, tid
                    );
                    let _ = reqwest::Client::new()
                        .post(&cancel_url)
                        .timeout(std::time::Duration::from_secs(5))
                        .send()
                        .await;

                    let _ = app_clone.emit(
                        "transfer_error",
                        &serde_json::json!({ "transferId": tid, "message": msg }),
                    );
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn send_text(
    target_device_id: String,
    text: String,
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let target = {
        let s = state.lock().await;
        s.devices
            .get(&target_device_id)
            .cloned()
            .ok_or_else(|| "Device not found".to_string())?
    };

    if text.trim().is_empty() {
        return Err("Text is empty".to_string());
    }

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let state_clone = state.inner().clone();

    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            transfer::send_text_to_device(transfer_id, target, text, state_clone, app).await
        {
            eprintln!("[SendText] Error: {e}");
        }
    });

    Ok(())
}

#[tauri::command]
async fn accept_transfer(
    transfer_id: String,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let (sender_ip, sender_port) = {
        let s = state.lock().await;
        let pending = s
            .pending_transfers
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "Pending transfer not found".to_string())?;

        let ip = s
            .devices
            .get(&pending.sender_device.id)
            .map(|d| d.ip.clone())
            .unwrap_or_else(|| {
                eprintln!(
                    "[Accept] Sender {} not in device state — falling back to self-reported IP {}",
                    pending.sender_device.id, pending.sender_device.ip
                );
                pending.sender_device.ip.clone()
            });

        (ip, pending.sender_device.port)
    };

    let url = format!("http://{}:{}/accept/{}", sender_ip, sender_port, transfer_id);
    eprintln!("[Accept] → {url}");

    reqwest::Client::new()
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Accept signal failed — is the sender still reachable? ({e})"))?;

    state.lock().await.pending_transfers.remove(&transfer_id);
    Ok(())
}

#[tauri::command]
async fn decline_transfer(
    transfer_id: String,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let (sender_ip, sender_port) = {
        let s = state.lock().await;
        let pending = s
            .pending_transfers
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "Pending transfer not found".to_string())?;

        let ip = s
            .devices
            .get(&pending.sender_device.id)
            .map(|d| d.ip.clone())
            .unwrap_or_else(|| pending.sender_device.ip.clone());

        (ip, pending.sender_device.port)
    };

    let url = format!("http://{}:{}/decline/{}", sender_ip, sender_port, transfer_id);

    reqwest::Client::new()
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Decline signal failed: {e}"))?;

    state.lock().await.pending_transfers.remove(&transfer_id);
    Ok(())
}

// ── Hotspot commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn start_hotspot(state: State<'_, SharedState>) -> Result<HotspotInfo, String> {
    let ssid = format!("TheRift-{}", network::generate_ssid());
    let password = network::generate_password();

    match network::start_hotspot(&ssid, &password).await {
        Ok(info) => {
            state.lock().await.hotspot_info = Some(info.clone());
            Ok(info)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn stop_hotspot(state: State<'_, SharedState>) -> Result<(), String> {
    network::stop_hotspot().await.map_err(|e| e.to_string())?;
    state.lock().await.hotspot_info = None;
    Ok(())
}

#[tauri::command]
async fn connect_to_hotspot(
    ssid: String,
    password: String,
    state: State<'_, SharedState>,
) -> Result<HotspotInfo, String> {
    match network::connect_to_hotspot(&ssid, &password).await {
        Ok(info) => {
            state.lock().await.hotspot_info = Some(info.clone());
            Ok(info)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn get_hotspot_info(state: State<'_, SharedState>) -> Result<Option<HotspotInfo>, String> {
    Ok(state.lock().await.hotspot_info.clone())
}

#[tauri::command]
async fn detect_hotspot(state: State<'_, SharedState>) -> Result<HotspotInfo, String> {
    match network::detect_hotspot_active().await {
        Some(info) => {
            state.lock().await.hotspot_info = Some(info.clone());
            Ok(info)
        }
        None => Err(
            "No active hotspot found. Make sure Mobile Hotspot is turned on \
            in Windows Settings, then try again."
                .to_string(),
        ),
    }
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    {
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let worker_threads = (logical_cores / 2).max(2);
        eprintln!(
            "[Runtime] Android: {logical_cores} logical cores detected, \
             capping Tokio at {worker_threads} worker threads"
        );

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(worker_threads)
            .max_blocking_threads(16)
            .thread_stack_size(512 * 1024)
            .thread_keep_alive(std::time::Duration::from_secs(10))
            .enable_all()
            .build()
            .expect("[Runtime] Failed to build Tokio runtime");

        let handle = rt.handle().clone();
        Box::leak(Box::new(rt));
        tauri::async_runtime::set(handle);
    }

    let shared_state = new_shared_state();

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())       // ← added
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(shared_state.clone())
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            get_file_metadata,
            pick_files_for_send,
            start_discovery,
            rescan,
            send_files,
            send_text,
            accept_transfer,
            decline_transfer,
            start_hotspot,
            stop_hotspot,
            connect_to_hotspot,
            get_hotspot_info,
            detect_hotspot,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let state_clone = shared_state.clone();

            tauri::async_runtime::spawn(async move {
                let name = hostname::get()
                    .ok()
                    .and_then(|h| h.into_string().ok())
                    .unwrap_or_else(|| "Rift Device".to_string());
                state_clone.lock().await.own_device_name = name;

                let our_ip = local_ip_address::local_ip()
                    .ok()
                    .and_then(|ip| match ip {
                        std::net::IpAddr::V4(v4) => Some(v4),
                        _ => None,
                    })
                    .unwrap_or_else(|| "127.0.0.1".parse().unwrap());

                #[cfg(not(target_os = "android"))]
                let _ = network::captive::start_captive_portal(our_ip).await;

                #[cfg(target_os = "windows")]
                tauri::async_runtime::spawn(async {
                    network::captive::add_firewall_rules().await;
                });

                {
                    let s = state_clone.clone();
                    let a = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = network::start_channel_server(s, a).await {
                            eprintln!("[ChannelServer] Fatal: {e}");
                        }
                    });
                }
                {
                    let s = state_clone.clone();
                    let a = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = transfer::start_transfer_server(s, a).await {
                            eprintln!("[Server] Fatal: {e}");
                        }
                    });
                }
                {
                    let s = state_clone.clone();
                    let a = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = transfer::start_stream_server(s, a).await {
                            eprintln!("[StreamServer] Fatal: {e}");
                        }
                    });
                }
                {
                    let s = state_clone.clone();
                    let a = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = network::start_heartbeat(s, a).await {
                            eprintln!("[Heartbeat] Fatal: {e}");
                        }
                    });
                }
                {
                    let s = state_clone.clone();
                    let a = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = network::start_broadcast_discovery(s, a).await {
                            eprintln!("[Broadcast] Error: {e}");
                        }
                    });
                }

                #[cfg(not(target_os = "android"))]
                {
                    let s = state_clone.clone();
                    let a = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        network::run_subnet_scan(our_ip, s, a).await;
                    });
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("The Rift failed to start")
        .run(|_app, event| {
            #[cfg(not(target_os = "android"))]
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(network::captive::cleanup_hosts_file());
            }
            #[cfg(target_os = "android")]
            let _ = event;
        });
}