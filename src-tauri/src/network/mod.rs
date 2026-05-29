pub mod android_wifi;
pub mod broadcast;
pub mod captive;
pub mod gateway;
pub mod heartbeat;
pub mod hotspot;
pub mod rift_channel;
pub mod subnet_scan;

// acquire_wifi_locks is intentionally NOT re-exported — the function is a
// permanent no-op and the call site in lib.rs has been removed. WiFi locks
// are held by RiftService.kt on the Java side.
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