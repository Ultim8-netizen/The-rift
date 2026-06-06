//! WiFi bond maintenance — keeps the radio active before and between transfers.
//!
//! Root cause of the observed failure modes
//! ─────────────────────────────────────────
//!
//! (a) Radio idle eviction
//!     WiFi adapters drop their 802.11 association when no frames are transmitted
//!     for 10–30 s (varies by AP firmware, worst on OEM Android hotspot drivers).
//!     This explains "unable to find device it is connected to" and "disconnection
//!     before transfer starts" — the link is physically gone before Rust even
//!     opens a socket.
//!
//! (b) Cellular rerouting (Android 10+, hotspot client side)
//!     When the hotspot network has no internet access, Android's connectivity
//!     service marks it as "not satisfied" and routes new TCP connections over
//!     the default (cellular) network instead. Discovered peers appear reachable
//!     but every connect() attempt goes over LTE, not WiFi. Mitigated in
//!     RiftService.kt via bindProcessToNetwork.
//!
//! (c) ARP table eviction / stale gateway
//!     The gateway's ARP table evicts idle clients, causing the first outbound
//!     packet after a quiet period to require an ARP round-trip before the radio
//!     can transmit. This causes the 5–30 s "takes too long to connect" symptom.
//!
//! Mitigations in this module
//! ──────────────────────────
//! 1. UDP bond ping to the gateway every BOND_PING_INTERVAL (1 s).
//!    The outbound frame traverses the full L2 path (NIC → AP radio → AP NIC),
//!    preventing radio idle eviction AND refreshing the gateway's ARP entry so
//!    the next real packet does not pay an ARP penalty.
//!
//! 2. Broadcast ping every tick as a fallback when gateway is unknown (hotspot
//!    host device, emulator, DHCP not yet complete).
//!
//! 3. Peer-absence rescan: if no devices appear in state for PEER_ABSENCE_RESCAN_SECS
//!    re-trigger subnet scan on desktop so we catch peers that started before us or
//!    were missed during the initial startup window.
//!
//! Note: Android process-to-network binding (cellular rerouting fix) lives in
//! RiftService.kt — it requires ConnectivityManager which is Java-only.

use crate::state::SharedState;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::net::UdpSocket;

/// How often to send a bond ping. 1 s is well below any observed radio idle
/// eviction timer (shortest tested: 8 s on TECNO hotspot driver).
/// Packets are 9 bytes — negligible bandwidth at any link speed.
#[allow(dead_code)]
const BOND_PING_INTERVAL: Duration = Duration::from_secs(1);

/// Re-trigger subnet scan if no peers are seen for this many seconds.
#[allow(dead_code)]
const PEER_ABSENCE_RESCAN_SECS: u64 = 20;

/// Re-read the gateway IP every N ticks (~60 s) to handle DHCP renewals.
const GATEWAY_REFRESH_TICKS: u32 = 60;

/// Port used for bond pings. Matches our own broadcast port so the packet
/// is not alien to AP traffic shapers; any Rift instance receiving it will
/// discard it silently (parse_packet in broadcast.rs checks "RIFT|" prefix).
const BOND_TARGET_PORT: u16 = 7476;

/// Payload intentionally does not start with "RIFT|" so broadcast.rs drops it.
const BOND_PING_PAYLOAD: &[u8] = b"RIFT-BOND";

pub async fn start_bond_keeper(state: SharedState, _app: AppHandle) -> anyhow::Result<()> {
    // Bind to an ephemeral port so we can send to broadcast addresses.
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
        // Refreshed periodically rather than every tick to avoid spawning a
        // process (ip route / route print) 60 times per minute.
        if gateway.is_none() || gateway_ticks % GATEWAY_REFRESH_TICKS == 0 {
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
        // Targeted unicast: works even on APs that filter broadcast/multicast
        // in power-save mode. Also refreshes the AP's ARP entry for this host,
        // eliminating the ARP round-trip penalty on the next real connection.
        if let Some(ref gw) = gateway {
            let dest = format!("{gw}:{BOND_TARGET_PORT}");
            let _ = sock.send_to(BOND_PING_PAYLOAD, &dest).await;
        }

        // ── Bond ping to broadcast (fallback) ─────────────────────────────────
        // Covers the case where gateway detection fails (hotspot host, DHCP
        // incomplete). Also keeps radios alive on both sides of the link when
        // a peer is visible but no rift_channel connection exists yet.
        let _ = sock
            .send_to(
                BOND_PING_PAYLOAD,
                format!("255.255.255.255:{BOND_TARGET_PORT}"),
            )
            .await;

        // ── Peer-absence rescan (desktop only) ────────────────────────────────
        // On Android, the accelerated broadcast interval (2 s when no peers)
        // combined with mDNS re-announce covers this case. Subnet scan on
        // Android would require ICMP which is blocked without root.
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