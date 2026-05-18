use crate::state::{Device, SharedState};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const SERVICE_TYPE: &str = "_therift._tcp.local.";

pub async fn start_discovery(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };

    let ip = local_ip_address::local_ip()
        .unwrap_or_else(|_| "127.0.0.1".parse().unwrap());

    // mDNS hostname must end with .local.
    let mdns_hostname = format!(
        "{}.local.",
        own_name.to_lowercase().replace(' ', "-")
    );

    let mut properties: HashMap<String, String> = HashMap::new();
    properties.insert("id".to_string(), own_id.clone());
    properties.insert("os".to_string(), std::env::consts::OS.to_string());
    properties.insert("name".to_string(), own_name.clone());

    let state_clone = state.clone();
    let app_clone = app.clone();
    let own_id_clone = own_id.clone();
    let ip_str = ip.to_string();

    // mdns-sd uses blocking std::sync::mpsc channels internally.
    // We run the browse loop inside spawn_blocking so the tokio runtime
    // is not blocked. The runtime handle is captured from the calling
    // async context and remains valid for spawning async tasks.
    let rt = tokio::runtime::Handle::current();

    tokio::task::spawn_blocking(move || {
        let mdns = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[mDNS] Daemon failed to start: {e}");
                return;
            }
        };

        // Register this device on the network
        match ServiceInfo::new(
            SERVICE_TYPE,
            &own_id_clone,
            &mdns_hostname,
            ip_str.as_str(),
            own_port,
            Some(properties),
        ) {
            Ok(info) => {
                if let Err(e) = mdns.register(info) {
                    eprintln!("[mDNS] Registration error: {e}");
                }
            }
            Err(e) => eprintln!("[mDNS] ServiceInfo error: {e}"),
        }

        // Start browsing for peers
        let receiver = match mdns.browse(SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[mDNS] Browse error: {e}");
                return;
            }
        };

        loop {
            match receiver.recv() {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    // Extract peer ID from properties.
                    // In mdns-sd 0.11, get_properties() returns &TxtProperties.
                    // TxtProperties::get(key) returns Option<&Option<String>>.
                    let peer_id = get_prop(&info, "id");
                    if peer_id.is_empty() || peer_id == own_id_clone {
                        continue;
                    }

                    let peer_os = get_prop(&info, "os");
                    let peer_name = {
                        let n = get_prop(&info, "name");
                        if n.is_empty() { "Unknown Device".to_string() } else { n }
                    };

                    // Prefer IPv4 non-loopback addresses
                    let peer_ip = info
                        .get_addresses()
                        .iter()
                        .filter_map(|a| match a {
                            std::net::IpAddr::V4(v4) if !v4.is_loopback() => {
                                Some(v4.to_string())
                            }
                            _ => None,
                        })
                        .next()
                        .unwrap_or_else(|| {
                            info.get_hostname()
                                .trim_end_matches('.')
                                .to_string()
                        });

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

                    // Store in shared state
                    let s = state_clone.clone();
                    let d = device.clone();
                    rt.spawn(async move {
                        s.lock().await.devices.insert(d.id.clone(), d);
                    });

                    let _ = app_clone.emit("device_discovered", &device);

                    // Measure latency
                    let app_ping = app_clone.clone();
                    let url = format!("http://{}:{}/ping", peer_ip, peer_port);
                    rt.spawn(async move {
                        ping_device(app_ping, peer_id, url).await;
                    });
                }

                Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                    let s = state_clone.clone();
                    let a = app_clone.clone();
                    rt.spawn(async move {
                        let mut state = s.lock().await;
                        let to_remove: Vec<String> = state
                            .devices
                            .keys()
                            .filter(|id| fullname.contains(id.as_str()))
                            .cloned()
                            .collect();
                        for id in to_remove {
                            state.devices.remove(&id);
                            let _ = a.emit(
                                "device_lost",
                                &serde_json::json!({ "id": id }),
                            );
                        }
                    });
                }

                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    Ok(())
}

// Property extraction. mdns-sd 0.11 stores values as Option<String>.
// If this fails to compile, the inner type may be Option<Vec<u8>> -- in that
// case replace `.as_deref().unwrap_or("")` with:
// `.as_ref().and_then(|b| std::str::from_utf8(b).ok()).unwrap_or("")`
fn get_prop(info: &ServiceInfo, key: &str) -> String {
    info.get_properties()
        .get(key)
        .map(|v| v.val_str().to_string())
        .unwrap_or_default()
}

async fn ping_device(app: AppHandle, device_id: String, url: String) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    let start = std::time::Instant::now();
    if client.get(&url).send().await.is_ok() {
        let latency = start.elapsed().as_millis() as u64;
        let _ = app.emit(
            "device_latency_update",
            &serde_json::json!({ "deviceId": device_id, "latencyMs": latency }),
        );
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}