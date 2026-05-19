//! Android WiFi and Multicast keepalive locks.
//!
//! Android's WiFi driver does two things that break The Rift unless we
//! intervene at startup:
//!
//! 1. It suppresses multicast packets to most apps to save battery.
//!    Without a `MulticastLock`, every mDNS probe and response is silently
//!    dropped → peers are never discovered.
//!
//! 2. It puts the radio to sleep when no "real" internet traffic is seen.
//!    A `WifiLock(WIFI_MODE_FULL_LOW_LATENCY)` tells the driver the process
//!    needs the adapter fully awake and at minimum latency — equivalent to
//!    what the captive-portal tricks achieve on desktop.
//!
//! Both locks are acquired once at startup and intentionally never released;
//! Android frees them automatically when the process exits.
//!
//! On desktop this whole module compiles to a single inlined `Ok(())`.

#[cfg(target_os = "android")]
pub fn acquire_wifi_locks() -> anyhow::Result<()> {
    use jni::{
        objects::{JObject, JValue},
        JavaVM,
    };

    // ndk-context stores the JavaVM* and jobject (Activity) that the Android
    // runtime provides to every native process at startup.
    let android_ctx = ndk_context::android_context();

    // SAFETY: The pointer is valid for the lifetime of the process and was set
    // by the Android runtime before any Rust code runs.
    let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }?;

    // Attach the current thread to the JVM. If it is already attached (e.g.
    // the main thread), attach_current_thread returns the existing handle.
    let mut env = vm.attach_current_thread()?;

    // The Activity object — valid as long as the app is in foreground.
    let context = unsafe { JObject::from_raw(android_ctx.context().cast()) };

    // ── Obtain WifiManager ────────────────────────────────────────────────────
    //
    // Context.getSystemService("wifi") → WifiManager
    let wifi_svc: JObject = env.new_string("wifi")?.into();
    let wifi_mgr = env
        .call_method(
            &context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&wifi_svc)],
        )?
        .l()?;

    if wifi_mgr.is_null() {
        anyhow::bail!("[Android] WifiManager is null — are WiFi permissions declared?");
    }

    // ── WifiLock — WIFI_MODE_FULL_LOW_LATENCY = 4 ────────────────────────────
    //
    // Keeps the radio at full power and minimal latency. This is the same mode
    // used by real-time gaming and VOIP apps.
    let wl_tag: JObject = env.new_string("TheRift:WifiLock")?.into();
    let wifi_lock = env
        .call_method(
            &wifi_mgr,
            "createWifiLock",
            "(ILjava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;",
            &[JValue::Int(4), JValue::Object(&wl_tag)],
        )?
        .l()?;
    env.call_method(&wifi_lock, "acquire", "()V", &[])?;

    // ── MulticastLock — required for mDNS multicast reception ────────────────
    //
    // Without this lock, Android's WifiManager filters out all multicast
    // frames before they reach user-space sockets. mDNS uses 224.0.0.251:5353
    // which is multicast, so this lock is non-negotiable for discovery.
    let mc_tag: JObject = env.new_string("TheRift:MulticastLock")?.into();
    let mc_lock = env
        .call_method(
            &wifi_mgr,
            "createMulticastLock",
            "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
            &[JValue::Object(&mc_tag)],
        )?
        .l()?;
    env.call_method(&mc_lock, "acquire", "()V", &[])?;

    eprintln!("[Android] WifiLock(LOW_LATENCY) + MulticastLock acquired — adapter will stay awake");
    Ok(())
}

/// No-op on all non-Android targets. Compiled away entirely.
/// `#[allow(dead_code)]` suppresses the unused-function warning on non-Android
/// build targets (e.g. Windows/macOS desktop) where this stub is the active
/// variant but nothing has called it yet. The Android path above is excluded
/// from those compilations entirely by `#[cfg]`, so it never triggers the lint.
#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
pub fn acquire_wifi_locks() -> anyhow::Result<()> {
    Ok(())
}