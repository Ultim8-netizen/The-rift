//! UDP broadcast presence — a second discovery path that works when mDNS multicast
//! is blocked by a firewall, dropped by the router, or suppressed by the OS.
//!
//! Adaptive announce interval:
//!   • ANNOUNCE_INTERVAL_FAST (2 s) — when no peers in state: aggressive mode
//!     so newly powered-on peers are heard within 2 s rather than 8 s.
//!   • ANNOUNCE_INTERVAL_SLOW (8 s) — once peers exist: maintenance mode,
//!     reduces radio duty cycle during active transfers.
//!
//! ── Android AP host mode — directed subnet broadcast ─────────────────────────
//!
//! When mobile is the hotspot AP host, `255.255.255.255` (limited broadcast) is
//! sent on the default route interface, which is typically cellular (rmnet0/ccmni0)
//! because the OS default route points to the cellular gateway. PC clients on the
//! AP subnet (192.168.43.x) never receive this packet.
//!
//! Fix: on Android, additionally send to the directed subnet broadcast derived
//! from the device's primary local IP. When mobile is the AP host, `local_ip()`
//! returns `192.168.43.1`, so we also send to `192.168.43.255:7476`. The AP
//! routing table has `192.168.43.0/24 → ap0` as a direct route, so this packet
//! is delivered through the AP interface regardless of the default route.
//!
//! Combined with the `bindProcessToNetwork(null)` fix in RiftService.kt and the
//! subnet scan enabled in lib.rs, this makes discovery bidirectional in AP host mode.

use super::rift_channel;
use crate::state::{Device, SharedState};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;

pub const BROADCAST_PORT: u16 = 7476;

/// When no peers are in state — aggressive re-announce to catch peers that just started.
const ANNOUNCE_INTERVAL_FAST: Duration = Duration::from_secs(2);
/// When at least one peer is active — maintenance cadence, reduces radio load.
const ANNOUNCE_INTERVAL_SLOW: Duration = Duration::from_secs(8);

fn build_packet(id: &str, name: &str, port: u16, os: &str) -> Vec<u8> {
    format!("RIFT|{id}|{name}|{port}|{os}").into_bytes()
}

fn parse_packet(buf: &[u8]) -> Option<(String, String, u16, String)> {
    let s = std::str::from_utf8(buf).ok()?;
    let mut parts = s.splitn(5, '|');
    if parts.next()? != "RIFT" {
        return None;
    }
    let id   = parts.next()?.to_string();
    let name = parts.next()?.to_string();
    let port: u16 = parts.next()?.parse().ok()?;
    let os   = parts.next()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some((id, name, port, os))
}

/// Computes the /24 directed broadcast address from a local IPv4 address.
///
/// Android hotspot always assigns /24 subnets (192.168.43.0/24, 192.168.49.0/24,
/// etc.). A /24 directed broadcast is x.x.x.255.
///
/// Returns None for loopback or link-local addresses.
#[cfg(target_os = "android")]
fn subnet_broadcast_v4(ip: std::net::Ipv4Addr) -> Option<String> {
    if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
        return None;
    }
    let o = ip.octets();
    Some(format!("{}.{}.{}.255:{BROADCAST_PORT}", o[0], o[1], o[2]))
}

pub async fn start_broadcast_discovery(
    state: SharedState,
    app: AppHandle,
) -> anyhow::Result<()> {
    let socket = match UdpSocket::bind(format!("0.0.0.0:{BROADCAST_PORT}")).await {
        Ok(s) => s,
        Err(e) => {
            // Non-fatal — mDNS and subnet-scan still provide discovery.
            eprintln!("[Broadcast] Cannot bind :{BROADCAST_PORT}: {e} — broadcast disabled");
            return Ok(());
        }
    };
    socket.set_broadcast(true)?;
    let socket = Arc::new(socket);

    let (own_id, own_name, own_port) = {
        let s = state.lock().await;
        (s.own_id.clone(), s.own_device_name.clone(), s.own_port)
    };
    let os = std::env::consts::OS.to_string();
    let packet = build_packet(&own_id, &own_name, own_port, &os);
    let dest: std::net::SocketAddr =
        format!("255.255.255.255:{BROADCAST_PORT}").parse().unwrap();

    // ── Sender ───────────────────────────────────────────────────────────────
    {
        let sock    = socket.clone();
        let pkt     = packet.clone();
        let dest_c  = dest;
        let state_c = state.clone();
        tokio::spawn(async move {
            loop {
                // ── Primary: limited broadcast (all platforms) ────────────────
                // Reaches peers when sockets are bound to the correct interface.
                let _ = sock.send_to(&pkt, dest_c).await;

                // ── Android: directed subnet broadcast (AP host mode fix) ──────
                //
                // 255.255.255.255 follows the default route, which is typically
                // cellular when mobile is the hotspot AP host. The directed
                // subnet broadcast (192.168.43.255) uses the AP routing table
                // entry (192.168.43.0/24 → ap0) and reaches PC clients directly.
                //
                // This runs on every announce tick so the PC hears the mobile
                // continuously, not just on the first packet.
                #[cfg(target_os = "android")]
                {
                    if let Ok(local) = local_ip_address::local_ip() {
                        if let IpAddr::V4(v4) = local {
                            if let Some(bcast) = subnet_broadcast_v4(v4) {
                                let _ = sock.send_to(&pkt, bcast.as_str()).await;
                                // If the primary local IP is cellular (10.x.x.x),
                                // also try known Android hotspot subnet ranges
                                // in case the AP interface has a different IP.
                                // Android uses 192.168.43.x or 192.168.49.x
                                // depending on OEM and Android version.
                                let o = v4.octets();
                                if o[0] == 10 {
                                    // Primary IP is cellular. Probe both known
                                    // Android hotspot AP subnets directly.
                                    let _ = sock.send_to(
                                        &pkt,
                                        format!("192.168.43.255:{BROADCAST_PORT}").as_str(),
                                    ).await;
                                    let _ = sock.send_to(
                                        &pkt,
                                        format!("192.168.49.255:{BROADCAST_PORT}").as_str(),
                                    ).await;
                                }
                            }
                        }
                    }
                }

                // Adaptive interval: be loud when the subnet is quiet so newly
                // powered-on peers hear us within 2 s.
                let interval = if state_c.lock().await.devices.is_empty() {
                    ANNOUNCE_INTERVAL_FAST
                } else {
                    ANNOUNCE_INTERVAL_SLOW
                };
                tokio::time::sleep(interval).await;
            }
        });
    }

    // ── Receiver ─────────────────────────────────────────────────────────────
    {
        let sock   = socket;
        let state  = state;
        let app    = app;
        let own_id = own_id;
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            loop {
                let (n, src) = match sock.recv_from(&mut buf).await {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[Broadcast] recv error: {e}");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                };

                let (peer_id, peer_name, peer_port, peer_os) =
                    match parse_packet(&buf[..n]) {
                        Some(p) => p,
                        None => continue,
                    };

                if peer_id == own_id {
                    continue;
                }

                let peer_ip = match src.ip() {
                    IpAddr::V4(v4) if !v4.is_loopback() => v4.to_string(),
                    _ => continue,
                };

                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                let device = Device {
                    id: peer_id.clone(),
                    name: peer_name,
                    os: peer_os,
                    ip: peer_ip.clone(),
                    port: peer_port,
                    latency_ms: None,
                    discovered_at: now,
                };

                let already = state.lock().await.devices.contains_key(&peer_id);
                state.lock().await.devices.insert(peer_id.clone(), device.clone());

                if !already {
                    eprintln!("[Broadcast] Discovered: {peer_id} @ {peer_ip}");
                    let _ = app.emit("device_discovered", &device);
                }

                // Fire-and-forget rift channel attempt; idempotent.
                let s   = state.clone();
                let a   = app.clone();
                let oid = own_id.clone();
                let pip = peer_ip;
                let pid = peer_id;
                tokio::spawn(async move {
                    rift_channel::connect_to_peer(pip, pid, oid, s, a).await;
                });
            }
        });
    }

    eprintln!("[Broadcast] UDP presence active on :{BROADCAST_PORT} (adaptive interval 2/8 s)");
    Ok(())
}