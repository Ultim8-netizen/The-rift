use crate::state::SharedState;
use tauri::{AppHandle, Emitter};

const HEARTBEAT_INTERVAL_SECS: u64 = 5;

/// 6 consecutive failures = 30 s before eviction (was 3 = 15 s).
/// If the rift channel is alive the failure counter is reset instead of
/// incremented — TCP-level reachability overrides HTTP-level unavailability.
const EVICT_AFTER_FAILURES: u8 = 6;

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
            let sc  = state.clone();
            let ac  = app.clone();
            let cc  = client.clone();

            tokio::spawn(async move {
                let start = std::time::Instant::now();
                match cc.get(&url).send().await {
                    Ok(_) => {
                        let latency = start.elapsed().as_millis() as u64;

                        let was_failing = {
                            let mut s = sc.lock().await;
                            let was = s.heartbeat_failures.contains_key(&device.id);
                            s.heartbeat_failures.remove(&device.id);
                            was
                        };

                        if was_failing {
                            // Device came back — tell frontend to clear reconnecting state.
                            let _ = ac.emit(
                                "device_recovered",
                                &serde_json::json!({ "deviceId": device.id }),
                            );
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
                        // If the TCP rift channel is actively exchanging PINGs/PONGs,
                        // the device is reachable.  HTTP may fail because the server is
                        // busy (large upload), firewall blocks port, or the HTTP stack
                        // hiccuped.  Trust the rift channel over HTTP.
                        let rifted = sc.lock().await.rifted_devices.contains(&device.id);
                        if rifted {
                            sc.lock().await.heartbeat_failures.remove(&device.id);
                            eprintln!(
                                "[Heartbeat] HTTP ping failed for {} but rift channel is live — skipping eviction",
                                device.id
                            );
                            return;
                        }

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

                        // First failure — warn frontend without touching state.
                        // The device card shows an amber dot so the user knows
                        // something is wrong, but it stays selectable.
                        if failures == 1 {
                            let _ = ac.emit(
                                "device_reconnecting",
                                &serde_json::json!({ "deviceId": device.id }),
                            );
                        }

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