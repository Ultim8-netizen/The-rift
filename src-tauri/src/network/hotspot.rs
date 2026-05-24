//! Windows Mobile Hotspot automation via `netsh wlan hostednetwork`.
//!
//! Windows requirements:
//!   - Administrator privileges (enforced at launch via UAC manifest)
//!   - A WiFi adapter that supports hosted network (`netsh wlan show drivers`
//!     → "Hosted network supported: Yes")
//!
//! How the hotspot bootstrap works:
//!   Host device: start_hotspot() → generates SSID + password → starts the
//!   Windows hosted network → reads gateway IP dynamically → returns HotspotInfo.
//!   The frontend shows the SSID and password (and optionally a QR code).
//!
//!   Guest device: connect_to_hotspot() → writes a temporary WPA2-PSK wireless
//!   profile XML → `netsh wlan connect` → waits for DHCP → reads gateway IP.
//!   The gateway IP is where the host device is reachable; discovery runs
//!   against that /24 subnet immediately after connection.
//!
//! Android: stubs returning descriptive errors. Full Android implementation
//! (WifiManager.startLocalOnlyHotspot for API 26+ or TetheringManager for 30+,
//! plus WifiNetworkSpecifier for joining) slots here when the Android layer
//! arrives. The function signatures are intentionally identical so callers in
//! lib.rs need zero changes.
//!
//! macOS/Linux: stubs. Neither platform is in scope for v1.

use crate::state::HotspotInfo;

// ── Windows implementation ────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub async fn start_hotspot(ssid: &str, password: &str) -> anyhow::Result<HotspotInfo> {
    use tokio::process::Command;

    // Step 1: configure the hosted network parameters
    let set = Command::new("netsh")
        .args([
            "wlan",
            "set",
            "hostednetwork",
            "mode=allow",
            &format!("ssid={ssid}"),
            &format!("key={password}"),
        ])
        .output()
        .await?;

    if !set.status.success() {
        let stderr = String::from_utf8_lossy(&set.stderr);
        let stdout = String::from_utf8_lossy(&set.stdout);
        anyhow::bail!(
            "netsh set hostednetwork failed.\n\
             Make sure The Rift is running as Administrator and your WiFi \
             adapter supports hosted networks.\nstdout: {stdout}\nstderr: {stderr}"
        );
    }

    // Step 2: start the hosted network
    let start = Command::new("netsh")
        .args(["wlan", "start", "hostednetwork"])
        .output()
        .await?;

    if !start.status.success() {
        let stdout = String::from_utf8_lossy(&start.stdout);
        anyhow::bail!("netsh start hostednetwork failed: {stdout}");
    }

    // Step 3: wait briefly for the virtual adapter to come up and get its IP
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Step 4: read the actual gateway IP from the routing table — never assume
    let gateway_ip = super::gateway::get_gateway_ip()
        .await
        .unwrap_or_else(|_| "192.168.137.1".to_string());

    eprintln!("[Hotspot] Started — SSID={ssid} gateway={gateway_ip}");

    Ok(HotspotInfo {
        ssid: ssid.to_string(),
        password: password.to_string(),
        gateway_ip,
        is_host: true,
    })
}

#[cfg(target_os = "windows")]
pub async fn stop_hotspot() -> anyhow::Result<()> {
    use tokio::process::Command;
    Command::new("netsh")
        .args(["wlan", "stop", "hostednetwork"])
        .output()
        .await?;
    // Optionally disable so it doesn't auto-start on next boot
    Command::new("netsh")
        .args(["wlan", "set", "hostednetwork", "mode=disallow"])
        .output()
        .await?;
    eprintln!("[Hotspot] Stopped");
    Ok(())
}

#[cfg(target_os = "windows")]
pub async fn connect_to_hotspot(ssid: &str, password: &str) -> anyhow::Result<HotspotInfo> {
    use tokio::process::Command;

    // Build a minimal WPA2-PSK wireless profile XML
    let profile_xml = format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{ssid}</name>
  <SSIDConfig>
    <SSID>
      <name>{ssid}</name>
    </SSID>
    <nonBroadcast>false</nonBroadcast>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>{password}</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>"#
    );

    let profile_path = std::env::temp_dir().join("rift_hotspot_join.xml");
    tokio::fs::write(&profile_path, profile_xml.as_bytes()).await
        .map_err(|e| anyhow::anyhow!("Cannot write profile XML: {e}"))?;

    // Add the profile to Windows
    let add = Command::new("netsh")
        .args([
            "wlan",
            "add",
            "profile",
            &format!("filename={}", profile_path.display()),
        ])
        .output()
        .await?;

    let _ = tokio::fs::remove_file(&profile_path).await;

    if !add.status.success() {
        let out = String::from_utf8_lossy(&add.stdout);
        anyhow::bail!("netsh wlan add profile failed: {out}");
    }

    // Connect to the network
    let connect = Command::new("netsh")
        .args(["wlan", "connect", &format!("name={ssid}")])
        .output()
        .await?;

    if !connect.status.success() {
        let out = String::from_utf8_lossy(&connect.stdout);
        anyhow::bail!("netsh wlan connect failed: {out}");
    }

    // Wait for DHCP lease
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    // The gateway is the host device — read it from our routing table
    let gateway_ip = super::gateway::get_gateway_ip()
        .await
        .unwrap_or_else(|_| "192.168.137.1".to_string());

    eprintln!("[Hotspot] Joined {ssid} — gateway={gateway_ip}");

    Ok(HotspotInfo {
        ssid: ssid.to_string(),
        password: password.to_string(),
        gateway_ip,
        is_host: false,
    })
}

// ── Android stubs ─────────────────────────────────────────────────────────────
// Signatures match Windows exactly. When Android layer arrives, replace these
// stubs with WifiManager.startLocalOnlyHotspot (API 26+) for hosting and
// WifiNetworkSpecifier + ConnectivityManager for joining.

#[cfg(target_os = "android")]
pub async fn start_hotspot(_ssid: &str, _password: &str) -> anyhow::Result<HotspotInfo> {
    anyhow::bail!(
        "Hotspot hosting is not yet implemented on Android. \
         Connect both devices to the same WiFi network and The Rift \
         will discover them automatically."
    )
}

#[cfg(target_os = "android")]
pub async fn stop_hotspot() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(target_os = "android")]
pub async fn connect_to_hotspot(_ssid: &str, _password: &str) -> anyhow::Result<HotspotInfo> {
    anyhow::bail!(
        "Programmatic hotspot joining is not yet implemented on Android. \
         Connect to the hotspot manually in Android Settings, then return to The Rift."
    )
}

// ── macOS / Linux stubs ───────────────────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub async fn start_hotspot(_ssid: &str, _password: &str) -> anyhow::Result<HotspotInfo> {
    anyhow::bail!("Hotspot automation is currently Windows-only.")
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub async fn stop_hotspot() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub async fn connect_to_hotspot(_ssid: &str, _password: &str) -> anyhow::Result<HotspotInfo> {
    anyhow::bail!("Hotspot joining automation is currently Windows-only.")
}

// ── Credential generation ─────────────────────────────────────────────────────

/// Generate a unique SSID suffix using a hash of process ID and timestamp.
/// Format: "TheRift-XXXXXX" where X is uppercase alphanumeric.
pub fn generate_ssid() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_default()
        .hash(&mut h);

    let v = h.finish();
    // Unambiguous character set: no 0/O, 1/I/l
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    (0..6)
        .map(|i| {
            let idx = ((v >> (i * 5)) as usize) % chars.len();
            chars[idx]
        })
        .collect()
}

/// Generate a random WPA2-compliant 12-character password.
pub fn generate_password() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);

    let v = h.finish();
    // Mix of lower, upper, digit — no ambiguous chars, no special chars for XML safety
    let chars: Vec<char> =
        "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789".chars().collect();
    (0..12)
        .map(|i| {
            let rotated = v
                .wrapping_mul(6364136223846793005u64)
                .wrapping_add(i as u64);
            chars[(rotated as usize) % chars.len()]
        })
        .collect()
}