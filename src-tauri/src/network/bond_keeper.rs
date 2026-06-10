//! WiFi bond maintenance — keeps the radio active before and between transfers.
//!
//! Root cause of the observed failure modes
//! ─────────────────────────────────────────
//!
//! (a) Radio idle eviction
//!     WiFi adapters drop their 802.11 association when no frames are transmitted
//!     for 10–30 s (varies by AP firmware, worst on OEM Android hotspot drivers).
//!
//! (b) Cellular rerouting (Android 10+, hotspot client side)
//!     When the hotspot network has no internet access, Android's connectivity
//!     service marks it as "not satisfied" and routes new TCP connections over
//!     the default (cellular) network instead. Mitigated in RiftService.kt via
//!     the corrected bindProcessToNetwork strategy.
//!
//! (c) ARP table eviction / stale gateway
//!     The gateway's ARP table evicts idle clients, causing the first outbound
//!     packet after a quiet period to require an ARP round-trip before the radio
//!     can transmit.
//!
//! ── Android AP host mode — directed subnet bond pings ────────────────────────
//!
//! When mobile is the hotspot AP host, 255.255.255.255 bond pings follow the
//! default route (cellular), not the AP interface. PC clients on 192.168.43.x
//! do not receive these pings and the AP radio can idle-evict.
//!
//! Fix: on Android, additionally send bond pings to the local /24 directed
//! broadcast (192.168.43.255) and to known Android hotspot subnet broadcasts.
//! These use the AP routing table entry (direct route) and keep the AP radio
//! alive regardless of the default route configuration.

use crate::state::SharedState;
use std::net::IpAddr;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::net::UdpSocket;

#[allow(dead_code)]
const BOND_PING_INTERVAL: Duration = Duration::from_secs(1);

#[allow(dead_code)]
const PEER_ABSENCE_RESCAN_SECS: u64 = 20;

const GATEWAY_REFRESH_TICKS: u32 = 60;
const BOND_TARGET_PORT: u16 = 7476;

/// Payload intentionally does not start with "RIFT|" so broadcast.rs drops it.
const BOND_PING_PAYLOAD: &[u8] = b"RIFT-BOND";

pub async fn start_bond_keeper(state: SharedState, _app: AppHandle) -> anyhow::Result<()> {
    let sock = UdpSocket::bind("0.0.0.0:0").await?;
    sock.set_broadcast(true)?;

    let mut gateway: Option<String> = None;
    let mut gateway_ticks: u32 = 0;
    let mut last_rescan = Instant::now();

    let mut interval = tokio::time::interval(BOND_PING_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    eprintln!("[BondKeeper] Started — 1 s gateway + broadcast bond ping active");

    loop {
        interval.tick().await;

        // ── Gateway refresh ───────────────────────────────────────────────────
        // Tick 0 fires immediately (0 % 60 == 0). Subsequent retries wait the
        // full 60-second window regardless of whether the previous attempt
        // succeeded. This prevents route.exe from being spawned every second
        // when no default route exists.
        if gateway_ticks % GATEWAY_REFRESH_TICKS == 0 {
            match super::gateway::get_gateway_ip().await {
                Ok(gw) => {
                    if gateway.as_deref() != Some(&gw) {
                        eprintln!("[BondKeeper] Gateway detected: {gw}");
                        gateway = Some(gw);
                    }
                }
                Err(_) => {
                    // Non-fatal: hotspot host device, emulator, or WiFi not yet
                    // associated. Broadcast-only fallback keeps the radio alive.
                }
            }
        }
        gateway_ticks = gateway_ticks.wrapping_add(1);

        // ── Bond ping to gateway (primary) ────────────────────────────────────
        if let Some(ref gw) = gateway {
            let dest = format!("{gw}:{BOND_TARGET_PORT}");
            let _ = sock.send_to(BOND_PING_PAYLOAD, &dest).await;
        }

        // ── Bond ping to limited broadcast ────────────────────────────────────
        // Works when sockets are correctly bound; covers the client-mode case.
        let _ = sock
            .send_to(
                BOND_PING_PAYLOAD,
                format!("255.255.255.255:{BOND_TARGET_PORT}"),
            )
            .await;

        // ── Android: directed subnet bond pings (AP host mode) ────────────────
        //
        // 255.255.255.255 follows the default route (cellular) when mobile is
        // the AP host. We additionally send to:
        //   1. /24 broadcast of the primary local IP (works if local_ip returns
        //      the AP interface address, e.g., 192.168.43.1)
        //   2. Known Android hotspot subnet broadcasts (192.168.43.255 and
        //      192.168.49.255) as a fallback when local_ip returns cellular
        //      (10.x.x.x) — guarantees the AP radio stays alive regardless of
        //      which IP the crate resolves first.
        //
        // These packets use the AP routing table entry (direct route) and are
        // delivered through the AP interface to PC clients.
        #[cfg(target_os = "android")]
        {
            let mut sent_43 = false;
            let mut sent_49 = false;

            if let Ok(local) = local_ip_address::local_ip() {
                if let IpAddr::V4(v4) = local {
                    if !v4.is_loopback() && !v4.is_link_local() {
                        let o = v4.octets();
                        let sb = format!("{}.{}.{}.255:{BOND_TARGET_PORT}",
                            o[0], o[1], o[2]);
                        let _ = sock.send_to(BOND_PING_PAYLOAD, sb.as_str()).await;
                        // Track which known AP subnets were covered.
                        if o[0] == 192 && o[1] == 168 && o[2] == 43 { sent_43 = true; }
                        if o[0] == 192 && o[1] == 168 && o[2] == 49 { sent_49 = true; }
                    }
                }
            }

            // Ensure both known Android hotspot subnets are always pinged,
            // even if local_ip returned a cellular address (10.x.x.x).
            if !sent_43 {
                let _ = sock.send_to(
                    BOND_PING_PAYLOAD,
                    format!("192.168.43.255:{BOND_TARGET_PORT}").as_str(),
                ).await;
            }
            if !sent_49 {
                let _ = sock.send_to(
                    BOND_PING_PAYLOAD,
                    format!("192.168.49.255:{BOND_TARGET_PORT}").as_str(),
                ).await;
            }
        }

        // ── Peer-absence rescan (desktop only; Android uses accelerated broadcast) ─
        let no_peers = state.lock().await.devices.is_empty();

        if no_peers && last_rescan.elapsed().as_secs() >= PEER_ABSENCE_RESCAN_SECS {
            last_rescan = Instant::now();
            eprintln!(
                "[BondKeeper] No peers after {}s — triggering subnet rescan",
                PEER_ABSENCE_RESCAN_SECS
            );

            #[cfg(not(target_os = "android"))]
            {
                let st = state.clone();
                let ap = _app.clone();
                tokio::spawn(async move {
                    if let Ok(our_ip) = local_ip_address::local_ip() {
                        if let std::net::IpAddr::V4(v4) = our_ip {
                            super::subnet_scan::run_subnet_scan(v4, st, ap).await;
                        }
                    }
                });
            }
        }
    }
}