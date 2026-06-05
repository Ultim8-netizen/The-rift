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

/// Returns file metadata for the given paths.
///
/// ── Android fix ──────────────────────────────────────────────────────────────
/// The old implementation called `android_fs::get_file_info` which queries
/// ContentResolver's `SIZE` column.  That column is `null` for the overwhelming
/// majority of `content://` URIs returned by the Android file picker, so every
/// file appeared as 0 bytes in the staging UI.
///
/// Worse: it preserved the raw `content://` URI as `StagedFile.path`.  The
/// file-picker Intent's URI grant is only guaranteed valid *immediately* after
/// the picker returns.  By the time the user reviews staging and taps Send,
/// that ephemeral grant is frequently expired.  `copyUriToCache` then fails,
/// `resolve_paths` returns `Err`, `send_files` returns `Err` to the frontend
/// *before* `transfer_started` is emitted — the dialogue dismissed via the
/// invoke-rejection path and nothing ever reached the remote device.
///
/// Fix: call `resolve_paths` here (which runs `android_copy_uri` for
/// `content://` URIs) while the grant is still live.  The file is copied to
/// the app's private cache directory once; subsequent calls in `send_files`
/// receive a plain file path and need only `stat` it — no URI, no grant.
///
/// On desktop `resolve_paths` is a plain `tokio::fs::metadata` call, so
/// desktop behaviour is unchanged.
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
                #[cfg(target_os = "android")]
                if path.starts_with("content://") {
                    return Err(
                        "Could not read the selected file. \
                         Storage permission may be missing, or the file comes from a \
                         cloud provider that has not downloaded it yet. \
                         Try selecting the file again, or move it to local storage first."
                            .to_string(),
                    );
                }
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

    // Subnet scan is desktop-only. On Android the /24 probe saturates the
    // Tokio I/O driver at startup and can trigger AP rate-limiting. mDNS and
    // UDP broadcast (already running) are the correct discovery mechanisms
    // on mobile and cover the same devices without the scan cost.
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
        eprintln!("[Send] URI resolution failed: {e}");
        e.to_string()
    })?;

    // ── Temp-path cleanup ────────────────────────────────────────────────────
    // Two sources of temporary cache files that must be removed after transfer:
    //
    //   1. Files copied to cache *right now* by resolve_paths (content:// URIs
    //      that somehow bypassed get_file_metadata).  These have temp_path set.
    //
    //   2. Files pre-staged into cache by get_file_metadata (the normal Android
    //      path).  resolve_paths treats them as plain files (temp_path = None),
    //      but they are identifiable by the "rift_send_" filename prefix that
    //      android_copy_uri always uses.
    //
    // On non-Android builds the cfg block below is never compiled, so `mut` is
    // not exercised. The allow attribute suppresses the resulting lint without
    // changing behaviour on any platform.
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

    // ── Emit transfer_started so the sender sees their own transfer ──────────
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

    // Capture target address before `target` is moved into send_files_to_device.
    let target_ip   = target.ip.clone();
    let target_port = target.port;

    let state_clone = state.inner().clone();
    let app_clone = app.clone();
    let tid = transfer_id.clone();

    tauri::async_runtime::spawn(async move {
        let result = transfer::send_files_to_device(
            tid.clone(),
            target,
            files,
            state_clone,
            app_clone.clone(),
        )
        .await;

        // Clean up all temp/pre-staged cache files regardless of outcome.
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
    // ── Android: dynamic Tokio runtime configuration ──────────────────────────
    // Must be called before Builder::default(). All tauri::async_runtime::spawn
    // calls for the lifetime of the app inherit this runtime.
    //
    // worker_threads: half of available logical CPUs, floored at 2. Prevents
    // Tokio from saturating all cores and starving the render thread under
    // transfer load. available_parallelism already reflects parked efficiency
    // cores under thermal throttling, so the value is always current.
    //
    //   2-core  device: 2 workers  (floor applied)
    //   4-core  device: 2 workers
    //   6-core  device: 3 workers
    //   8-core  device: 4 workers
    //   10-core device: 5 workers
    //
    // max_blocking_threads: caps the spawn_blocking pool at 16. The default of
    // 512 is a desktop assumption; 16 is more than sufficient for concurrent
    // file copies and prevents runaway thread spawning on slow storage I/O.
    //
    // thread_stack_size: reduces worker stacks from 2MB to 512KB. Async I/O
    // tasks have shallow call stacks; the full 2MB is never touched, but the
    // kernel reserves it as virtual address space regardless. Saves ~3MB RSS
    // per worker pair on a 4-core device.
    //
    // thread_keep_alive: retained at the standard 10s. Blocking threads
    // spawned for file copies must remain available for back-to-back transfers
    // without paying re-spawn cost between them. 10s covers typical multi-file
    // transfer sessions where the user selects another batch immediately after
    // the first completes.
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

        tauri::async_runtime::set(rt);
    }

    let shared_state = new_shared_state();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
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

                // Captive portal is desktop-only. On Android writing to
                // /etc/hosts requires root and the redirect server serves no
                // purpose; skipping it avoids an idle port listener for the
                // entire session.
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

                // Subnet scan is desktop-only. On Android probing up to 255
                // addresses saturates the Tokio I/O driver at startup and can
                // trigger AP rate-limiting. mDNS and UDP broadcast (already
                // running above) cover the same devices on mobile without the
                // scan cost.
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
            // Hosts file cleanup is desktop-only. On Android the write has no
            // effect without root; skipping block_on here makes the exit path
            // instantaneous on mobile instead of awaiting a doomed syscall.
            #[cfg(not(target_os = "android"))]
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(network::captive::cleanup_hosts_file());
            }
            // Suppress unused variable warning on Android where the cfg gate
            // above means `event` is never read.
            #[cfg(target_os = "android")]
            let _ = event;
        });
}