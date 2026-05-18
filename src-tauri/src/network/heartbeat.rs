use crate::state::SharedState;
use tauri::{AppHandle, Emitter};

const HEARTBEAT_INTERVAL_SECS: u64 = 5;
const EVICT_AFTER_FAILURES: u8 = 3; // 15 s of silence before eviction

pub async fn start_heartbeat(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)).await;

        let devices: Vec<crate::state::Device> = {
            let s = state.lock().await;
            s.devices.values().cloned().collect()
        };

        for device in devices {
            let url = format!("http://{}:{}/ping", device.ip, device.port);
            let sc = state.clone();
            let ac = app.clone();
            let cc = client.clone();

            tokio::spawn(async move {
                let start = std::time::Instant::now();
                match cc.get(&url).send().await {
                    Ok(_) => {
                        let latency = start.elapsed().as_millis() as u64;
                        // Success — reset failure counter
                        {
                            let mut s = sc.lock().await;
                            s.heartbeat_failures.remove(&device.id);
                        }
                        let _ = ac.emit(
                            "device_latency_update",
                            &serde_json::json!({
                                "deviceId": device.id,
                                "latencyMs": latency,
                            }),
                        );
                    }
                    Err(_) => {
                        let failures = {
                            let mut s = sc.lock().await;
                            let count = s
                                .heartbeat_failures
                                .entry(device.id.clone())
                                .or_insert(0);
                            *count += 1;
                            *count
                        };

                        eprintln!(
                            "[Heartbeat] {} unreachable ({}/{})",
                            device.id, failures, EVICT_AFTER_FAILURES
                        );

                        if failures >= EVICT_AFTER_FAILURES {
                            let mut s = sc.lock().await;
                            s.devices.remove(&device.id);
                            s.heartbeat_failures.remove(&device.id);
                            s.rifted_devices.remove(&device.id);
                            drop(s);
                            let _ = ac.emit(
                                "device_lost",
                                &serde_json::json!({ "id": device.id }),
                            );
                        }
                    }
                }
            });
        }
    }
}