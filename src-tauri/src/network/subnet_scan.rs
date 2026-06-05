//! Active /24 subnet scan — finds Rift instances that are already running
//! before we started, or that mDNS/broadcast hasn't surfaced yet.
//!
//! Probes every host in the local /24 in parallel (capped at MAX_CONCURRENT)
//! via GET /hello.  Discovered devices are collected across all concurrent
//! tasks and emitted as a single `devices_discovered_batch` event after all
//! probes complete, rather than one `device_discovered` per device.
//!
//! This eliminates the Davey frame drop that occurred when the scan completed
//! and fired ~N rapid-succession IPC events into the WebView simultaneously,
//! each triggering a Zustand state update and React reconciliation pass while
//! Portal3D was mid-frame on the main thread.

use super::rift_channel;
use crate::state::{Device, SharedState};
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as TokioMutex;

const SCAN_TIMEOUT_MS: u64 = 700;
const MAX_CONCURRENT: usize = 40;

#[derive(serde::Deserialize)]
struct HelloResponse {
    id: String,
    name: String,
    os: String,
    port: u16,
}

pub async fn run_subnet_scan(our_ip: Ipv4Addr, state: SharedState, app: AppHandle) {
    let [a, b, c, _] = our_ip.octets();
    let prefix = format!("{a}.{b}.{c}.");
    let our_ip_str = our_ip.to_string();

    eprintln!("[Scan] Probing {prefix}0/24 …");

    let (own_id, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_port)
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(SCAN_TIMEOUT_MS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let sem = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT));

    /// Devices discovered for the first time during this scan.
    /// Each task pushes here instead of emitting immediately.
    /// After all handles join, a single batch event is emitted.
    let batch: Arc<TokioMutex<Vec<Device>>> = Arc::new(TokioMutex::new(Vec::new()));

    let mut handles = Vec::with_capacity(254);

    for last in 1u8..=254 {
        let ip = format!("{prefix}{last}");
        if ip == our_ip_str {
            continue;
        }

        let client     = client.clone();
        let state      = state.clone();
        let app        = app.clone();
        let own_id     = own_id.clone();
        let sem        = sem.clone();
        let batch      = batch.clone();

        handles.push(tokio::spawn(async move {
            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return,
            };

            let url = format!("http://{ip}:{own_port}/hello");
            let resp = match client.get(&url).send().await {
                Ok(r) if r.status().is_success() => r,
                _ => return,
            };
            let hello: HelloResponse = match resp.json().await {
                Ok(h) => h,
                Err(_) => return,
            };

            if hello.id == own_id {
                return;
            }

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let device = Device {
                id: hello.id.clone(),
                name: hello.name,
                os: hello.os,
                ip: ip.clone(),
                port: hello.port,
                latency_ms: None,
                discovered_at: now,
            };

            let already = state.lock().await.devices.contains_key(&hello.id);
            state.lock().await.devices.insert(hello.id.clone(), device.clone());

            if !already {
                eprintln!("[Scan] Found: {} @ {ip}", hello.id);
                // Queue for batch emit — do NOT emit device_discovered here.
                batch.lock().await.push(device.clone());
            }

            // Rift channel connection starts immediately per-device as found.
            // This is Tokio async work and does not touch the WebView/JS thread.
            rift_channel::connect_to_peer(ip, hello.id, own_id, state, app).await;
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    // Single IPC call for all discovered devices — one React reconciliation
    // pass instead of N, eliminating the post-scan Davey spike.
    let found = batch.lock().await;
    if !found.is_empty() {
        let _ = app.emit("devices_discovered_batch", &*found);
    }

    eprintln!("[Scan] Subnet scan complete");
}