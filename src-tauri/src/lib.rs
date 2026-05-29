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

#[tauri::command]
async fn get_file_metadata(paths: Vec<String>) -> Result<Vec<StagedFile>, String> {
    let mut out = Vec::new();
    for path in paths {
        let p = std::path::Path::new(&path);
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        out.push(StagedFile { name, path, size_bytes: size });
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

    let files: Vec<state::FileEntry> = file_paths
        .iter()
        .map(|path| {
            let p = std::path::Path::new(path);
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            state::FileEntry {
                name,
                path: path.clone(),
                size_bytes: size,
                mime_type: "application/octet-stream".to_string(),
            }
        })
        .collect();

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let state_clone = state.inner().clone();

    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            transfer::send_files_to_device(transfer_id, target, files, state_clone, app).await
        {
            eprintln!("[Send] Error: {e}");
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
    let shared_state = new_shared_state();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(shared_state.clone())
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            get_file_metadata,
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
            // ── REMOVED: acquire_wifi_locks() ────────────────────────────────
            // The previous call here caused a fatal SIGABRT on Android 11:
            //   Abort message: 'android context was not initialized'
            // ndk_context::android_context() panics when called from a Tokio
            // background thread (Thread-2) before Tauri has finished setting
            // up the JNI context pointer. The panic aborts the process.
            //
            // Fix: WiFi/multicast/wake locks are already acquired by
            // RiftService.kt in onCreate() — before any Rust code runs.
            // There is nothing for Rust to do here.

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
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(network::captive::cleanup_hosts_file());
            }
        });
}