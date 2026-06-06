pub mod android_wifi;
pub mod bond_keeper;
pub mod broadcast;
pub mod captive;
pub mod gateway;
pub mod heartbeat;
pub mod hotspot;
pub mod rift_channel;
pub mod subnet_scan;

// acquire_wifi_locks is intentionally NOT re-exported — permanent no-op.
// WiFi locks are held by RiftService.kt on the Java side.
#[allow(unused_imports)]
pub use bond_keeper::start_bond_keeper;
pub use broadcast::start_broadcast_discovery;
pub use heartbeat::start_heartbeat;
pub use hotspot::{
    connect_to_hotspot,
    detect_hotspot_active,
    generate_password,
    generate_ssid,
    start_hotspot,
    stop_hotspot,
};
pub use rift_channel::start_channel_server;
pub use subnet_scan::run_subnet_scan;

/// Sets OS-level TCP keepalive probes on a Tokio `TcpStream`.
///
/// Parameters chosen for fast dead-peer detection on local WiFi:
///   KEEPIDLE  = 5 s  — begin probing after 5 s of inactivity on the socket
///   KEEPINTVL = 2 s  — send a probe every 2 s once probing begins
///   KEEPCNT   = 3    — fail after 3 missed probes (≈ 11 s total from idle)
///
/// Without this, the OS default KEEPIDLE is 2 hours on Linux and macOS.
/// A dead WiFi link would not be detected until the next application-level
/// write fails — which for rift_channel could be up to PEER_TIMEOUT (6 s)
/// and for stream_server could be much longer during a large write.
///
/// With this, the OS sends RST and closes the socket within ~11 s of the
/// link dying, triggering Rust's reconnect logic immediately.
///
/// On Windows, KEEPCNT is system-controlled (default 10); time and interval
/// are still set. The combined effect is still far better than the 2-hour default.
pub fn apply_tcp_keepalive(stream: &tokio::net::TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let sock = SockRef::from(stream);
    let ka = TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(5))
        .with_interval(std::time::Duration::from_secs(2));
    #[cfg(not(target_os = "windows"))]
    let ka = ka.with_retries(3);
    if let Err(e) = sock.set_tcp_keepalive(&ka) {
        eprintln!("[Network] set_tcp_keepalive failed (non-fatal): {e}");
    }
}