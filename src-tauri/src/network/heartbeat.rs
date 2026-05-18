use crate::state::SharedState;
use tauri::{AppHandle, Emitter};

// Every 5 seconds, ping each known device. If a device does not respond,
// remove it from the list and emit device_lost. This catches devices that
// disappeared without sending an mDNS goodbye packet (e.g. hard shutdown).
pub async fn start_heartbeat(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        let devices: Vec<crate::state::Device> = {
            let s = state.lock().await;
            s.devices.values().cloned().collect()
        };

        for device in devices {
            let url = format!("http://{}:{}/ping", device.ip, device.port);
            let state_clone = state.clone();
            let app_clone = app.clone();
            let client_clone = client.clone();

            tokio::spawn(async move {
                let start = std::time::Instant::now();
                match client_clone.get(&url).send().await {
                    Ok(_) => {
                        let latency = start.elapsed().as_millis() as u64;
                        let _ = app_clone.emit(
                            "device_latency_update",
                            &serde_json::json!({
                                "deviceId": device.id,
                                "latencyMs": latency,
                            }),
                        );
                    }
                    Err(_) => {
                        // Device unreachable: remove and notify frontend
                        state_clone.lock().await.devices.remove(&device.id);
                        let _ = app_clone.emit(
                            "device_lost",
                            &serde_json::json!({ "id": device.id }),
                        );
                    }
                }
            });
        }
    }
}