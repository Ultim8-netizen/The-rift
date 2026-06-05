use crate::network::rift_channel;
use crate::state::{Device, SharedState};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const SERVICE_TYPE: &str = "_therift._tcp.local.";

/// 30 s on Android (battery + render thread relief), 10 s on desktop.
/// mDNS is a secondary discovery path on mobile... subnet scan and UDP
/// broadcast cover fast detection. Re-announcing every 10 s was causing
/// a confirmed Davey frame drop on the test device each cycle.
#[cfg(target_os = "android")]
const REANNOUNCE_SECS: u64 = 30;
#[cfg(not(target_os = "android"))]
const REANNOUNCE_SECS: u64 = 10;

pub async fn start_discovery(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };

    let ip = local_ip_address::local_ip()
        .unwrap_or_else(|_| "127.0.0.1".parse().unwrap());

    let mdns_hostname = format!("{}.local.", own_name.to_lowercase().replace(' ', "-"));

    let mut properties: HashMap<String, String> = HashMap::new();
    properties.insert("id".to_string(), own_id.clone());
    properties.insert("os".to_string(), std::env::consts::OS.to_string());
    properties.insert("name".to_string(), own_name.clone());

    let state_clone = state.clone();
    let app_clone = app.clone();
    let own_id_clone = own_id.clone();
    let ip_str = ip.to_string();
    let rt = tokio::runtime::Handle::current();

    tokio::task::spawn_blocking(move || {
        let mdns = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[mDNS] Daemon failed: {e}");
                return;
            }
        };

        let register = |mdns: &ServiceDaemon| {
            match ServiceInfo::new(
                SERVICE_TYPE,
                &own_id_clone,
                &mdns_hostname,
                ip_str.as_str(),
                own_port,
                Some(properties.clone()),
            ) {
                Ok(info) => {
                    let fullname = format!("{own_id_clone}.{SERVICE_TYPE}");
                    let _ = mdns.unregister(&fullname);
                    if let Err(e) = mdns.register(info) {
                        eprintln!("[mDNS] Register error: {e}");
                    }
                }
                Err(e) => eprintln!("[mDNS] ServiceInfo error: {e}"),
            }
        };

        register(&mdns);
        eprintln!("[mDNS] Registered. Browse + re-announce every {REANNOUNCE_SECS}s");

        let receiver = match mdns.browse(SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[mDNS] Browse error: {e}");
                return;
            }
        };

        loop {
            match receiver.recv_timeout(Duration::from_secs(REANNOUNCE_SECS)) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    let peer_id = get_prop(&info, "id");
                    if peer_id.is_empty() || peer_id == own_id_clone {
                        continue;
                    }

                    let peer_os = get_prop(&info, "os");
                    let peer_name = {
                        let n = get_prop(&info, "name");
                        if n.is_empty() { "Unknown Device".to_string() } else { n }
                    };

                    let peer_ip = info
                        .get_addresses()
                        .iter()
                        .filter_map(|a| match a {
                            std::net::IpAddr::V4(v4) if !v4.is_loopback() => Some(v4.to_string()),
                            _ => None,
                        })
                        .next()
                        .unwrap_or_else(|| info.get_hostname().trim_end_matches('.').to_string());

                    let peer_port = info.get_port();
                    let now = unix_now_ms();

                    let device = Device {
                        id: peer_id.clone(),
                        name: peer_name,
                        os: peer_os,
                        ip: peer_ip.clone(),
                        port: peer_port,
                        latency_ms: None,
                        discovered_at: now,
                    };

                    let s = state_clone.clone();
                    let d = device.clone();
                    rt.spawn(async move {
                        s.lock().await.devices.insert(d.id.clone(), d);
                    });

                    let _ = app_clone.emit("device_discovered", &device);

                    let s = state_clone.clone();
                    let a = app_clone.clone();
                    let pid = peer_id.clone();
                    let pip = peer_ip.clone();
                    let oid = own_id_clone.clone();
                    rt.spawn(async move {
                        rift_channel::connect_to_peer(pip, pid, oid, s, a).await;
                    });
                }

                Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                    let s = state_clone.clone();
                    let a = app_clone.clone();
                    rt.spawn(async move {
                        let state = s.lock().await;
                        let affected: Vec<String> = state
                            .devices
                            .keys()
                            .filter(|id| fullname.contains(id.as_str()))
                            .cloned()
                            .collect();
                        drop(state);
                        for id in affected {
                            eprintln!("[mDNS] ServiceRemoved for {id} — not evicting, waiting for heartbeat");
                            let _ = a.emit(
                                "device_reconnecting",
                                &serde_json::json!({ "deviceId": id }),
                            );
                        }
                    });
                }

                Ok(_) => {}

                Err(flume::RecvTimeoutError::Timeout) => {
                    eprintln!("[mDNS] Re-announcing service");
                    register(&mdns);
                }

                Err(flume::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(())
}

fn get_prop(info: &mdns_sd::ServiceInfo, key: &str) -> String {
    info.get_properties()
        .get(key)
        .map(|v| v.val_str().to_string())
        .unwrap_or_default()
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}