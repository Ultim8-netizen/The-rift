//! Android WiFi keepalive — handled entirely by RiftService.kt on the Java
//! side (WifiLock + MulticastLock + WakeLock acquired in onCreate and held
//! for the process lifetime).
//!
//! The previous Rust JNI implementation called ndk_context::android_context()
//! from a Tokio background thread (Thread-2) before Tauri had finished
//! initialising the JNI context pointer. That caused:
//!
//!   SIGABRT — Abort message: 'android context was not initialized'
//!
//! Since RiftService.kt is started by MainActivity before Tauri's Rust
//! runtime runs, the locks are always held by the time any Rust code
//! executes. No Rust-side acquisition is needed or safe to attempt here.
//!
//! This file is kept as a stub so no other module needs changing if a
//! future Tauri version exposes a safe Android context API.

/// No-op on all platforms. WiFi/multicast/wake locks are owned by
/// RiftService.kt and are guaranteed to be held before Rust code runs.
#[allow(dead_code)]
pub fn acquire_wifi_locks() -> anyhow::Result<()> {
    Ok(())
}