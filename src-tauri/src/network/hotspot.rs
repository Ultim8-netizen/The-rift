//! Windows Mobile Hotspot automation — three strategies tried in order:
//!
//!   1. Detect already-running hotspot (covers manual Windows Settings setup)
//!   2. WinRT NetworkOperatorTetheringManager via hidden PowerShell
//!      (modern API, works on all adapters, requires internet connection)
//!   3. Legacy netsh wlan hostednetwork
//!      (older adapters, works offline, deprecated on many Win 11 machines)
//!
//! All execution is hidden — no windows, no terminal, no raw output to UI.
//! Error messages are plain English throughout.

use crate::state::HotspotInfo;

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub async fn start_hotspot(ssid: &str, password: &str) -> anyhow::Result<HotspotInfo> {
    // Strategy 1: already running (user enabled manually in Windows Settings)
    if let Some(info) = detect_running_hotspot(ssid, password).await {
        eprintln!("[Hotspot] Using already-running hotspot at {}", info.gateway_ip);
        return Ok(info);
    }

    // Strategy 2: WinRT Mobile Hotspot API (modern, all adapters, needs internet)
    match start_via_winrt(ssid, password).await {
        Ok(info) => {
            eprintln!("[Hotspot] Started via WinRT");
            return Ok(info);
        }
        Err(e) => eprintln!("[Hotspot] WinRT attempt failed: {e}"),
    }

    // Strategy 3: legacy netsh hostednetwork (offline capable, adapter-dependent)
    match start_via_netsh(ssid, password).await {
        Ok(info) => {
            eprintln!("[Hotspot] Started via netsh hostednetwork");
            return Ok(info);
        }
        Err(e) => eprintln!("[Hotspot] netsh attempt failed: {e}"),
    }

    anyhow::bail!(
        "Could not start a hotspot automatically on this device. \
        Go to Windows Settings → Network & Internet → Mobile hotspot, \
        enable it manually, then tap Detect in The Rift."
    )
}

/// Checks if we are currently hosting a hotspot by looking for 192.168.137.1
/// on our own network interfaces. If found, returns HotspotInfo immediately
/// without creating anything. This covers the case where the user enabled
/// Mobile Hotspot manually in Windows Settings before opening The Rift.
#[cfg(target_os = "windows")]
async fn detect_running_hotspot(ssid: &str, password: &str) -> Option<HotspotInfo> {
    use tokio::process::Command;

    let out = Command::new("ipconfig")
        .output()
        .await
        .ok()?;

    let text = String::from_utf8_lossy(&out.stdout);

    // 192.168.137.1 is always the host IP on the Windows Mobile Hotspot virtual adapter.
    // Guests receive .137.2+ so this check identifies the host only.
    let is_hosting = text
        .lines()
        .any(|line| line.trim().ends_with(": 192.168.137.1"));

    if !is_hosting {
        return None;
    }

    // Best-effort SSID read. If this fails the caller can still use the gateway.
    let actual_ssid = read_active_ssid_via_winrt()
        .await
        .unwrap_or_else(|| ssid.to_string());

    Some(HotspotInfo {
        ssid: actual_ssid,
        password: password.to_string(),
        gateway_ip: "192.168.137.1".to_string(),
        is_host: true,
    })
}

/// Public entry point for the `detect_hotspot` Tauri command.
/// Called when the user clicks "Detect Active Hotspot" after manual setup.
/// Returns None on all non-Windows platforms.
pub async fn detect_hotspot_active() -> Option<HotspotInfo> {
    #[cfg(target_os = "windows")]
    {
        detect_running_hotspot("Mobile Hotspot", "").await
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// WinRT strategy: starts the Windows Mobile Hotspot via a hidden PowerShell
/// process that invokes NetworkOperatorTetheringManager. SSID and password are
/// passed as environment variables to avoid any quoting or injection issues.
#[cfg(target_os = "windows")]
async fn start_via_winrt(ssid: &str, password: &str) -> anyhow::Result<HotspotInfo> {
    use tokio::process::Command;

    // Script uses $env:RIFT_SSID and $env:RIFT_PASS — no interpolation needed.
    let script = r#"
$ErrorActionPreference = 'Stop'
$ssid = $env:RIFT_SSID
$pass = $env:RIFT_PASS

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

    function Await($op, $type) {
        $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    function AwaitAction($op) {
        $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
        })[0]
        $task = $m.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
    }

    $ni   = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
    $tmT  = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]

    $profile = $ni::GetInternetConnectionProfile()
    if (-not $profile) {
        $profiles = $ni::GetConnectionProfiles()
        foreach ($p in $profiles) { if ($p) { $profile = $p; break } }
    }
    if (-not $profile) { throw 'No network profile available' }

    $manager = $tmT::CreateFromConnectionProfile($profile)
    $config  = $manager.GetCurrentAccessPointConfiguration()
    $config.Ssid       = $ssid
    $config.Passphrase = $pass

    AwaitAction($manager.ConfigureAccessPointAsync($config))

    $resultT = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
    $result  = Await $manager.StartTetheringAsync() $resultT

    if ([int]$result.Status -ne 0) { throw "TetheringStatus=$($result.Status)" }
    Write-Output 'RIFT_HOTSPOT_OK'
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
"#;

    let script_path = std::env::temp_dir().join("rift_start_hotspot.ps1");
    tokio::fs::write(&script_path, script.as_bytes())
        .await
        .map_err(|e| anyhow::anyhow!("Cannot write PS1: {e}"))?;

    let output = Command::new("powershell")
        .env("RIFT_SSID", ssid)
        .env("RIFT_PASS", password)
        .args([
            "-WindowStyle", "Hidden",
            "-ExecutionPolicy", "Bypass",
            "-NonInteractive",
            "-File", &script_path.to_string_lossy(),
        ])
        .output()
        .await;

    let _ = tokio::fs::remove_file(&script_path).await;

    let out = output.map_err(|e| anyhow::anyhow!("PowerShell process error: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    if !out.status.success() || !stdout.contains("RIFT_HOTSPOT_OK") {
        let msg = if !stderr.trim().is_empty() { stderr.trim().to_string() } else { stdout.trim().to_string() };
        anyhow::bail!("WinRT API: {msg}");
    }

    // Wait for the virtual adapter to acquire its IP
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let gateway_ip = super::gateway::get_gateway_ip()
        .await
        .unwrap_or_else(|_| "192.168.137.1".to_string());

    Ok(HotspotInfo {
        ssid: ssid.to_string(),
        password: password.to_string(),
        gateway_ip,
        is_host: true,
    })
}

/// Legacy strategy: netsh wlan hostednetwork. Works on some adapters without
/// internet but is deprecated on most Windows 11 hardware.
#[cfg(target_os = "windows")]
async fn start_via_netsh(ssid: &str, password: &str) -> anyhow::Result<HotspotInfo> {
    use tokio::process::Command;

    let set = Command::new("netsh")
        .args([
            "wlan", "set", "hostednetwork",
            "mode=allow",
            &format!("ssid={ssid}"),
            &format!("key={password}"),
        ])
        .output()
        .await?;

    if !set.status.success() {
        anyhow::bail!("Adapter does not support hosted network mode");
    }

    let start = Command::new("netsh")
        .args(["wlan", "start", "hostednetwork"])
        .output()
        .await?;

    if !start.status.success() {
        anyhow::bail!("Failed to start hosted network");
    }

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let gateway_ip = super::gateway::get_gateway_ip()
        .await
        .unwrap_or_else(|_| "192.168.137.1".to_string());

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

    // Stop WinRT Mobile Hotspot
    let stop_script = r#"
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    function Await($op, $type) {
        $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }
    $ni  = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
    $tmT = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
    $profile = $ni::GetInternetConnectionProfile()
    if ($profile) {
        $manager = $tmT::CreateFromConnectionProfile($profile)
        $resultT = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
        Await $manager.StopTetheringAsync() $resultT | Out-Null
    }
} catch {}
"#;

    let script_path = std::env::temp_dir().join("rift_stop_hotspot.ps1");
    if tokio::fs::write(&script_path, stop_script.as_bytes()).await.is_ok() {
        let _ = Command::new("powershell")
            .args([
                "-WindowStyle", "Hidden",
                "-ExecutionPolicy", "Bypass",
                "-NonInteractive",
                "-File", &script_path.to_string_lossy(),
            ])
            .output()
            .await;
        let _ = tokio::fs::remove_file(&script_path).await;
    }

    // Also stop the legacy hosted network if it was running
    let _ = Command::new("netsh")
        .args(["wlan", "stop", "hostednetwork"])
        .output()
        .await;
    let _ = Command::new("netsh")
        .args(["wlan", "set", "hostednetwork", "mode=disallow"])
        .output()
        .await;

    eprintln!("[Hotspot] Stopped");
    Ok(())
}

#[cfg(target_os = "windows")]
pub async fn connect_to_hotspot(ssid: &str, password: &str) -> anyhow::Result<HotspotInfo> {
    use tokio::process::Command;

    let profile_xml = format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{ssid}</name>
  <SSIDConfig>
    <SSID><name>{ssid}</name></SSID>
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
    tokio::fs::write(&profile_path, profile_xml.as_bytes())
        .await
        .map_err(|e| anyhow::anyhow!("Cannot write profile XML: {e}"))?;

    let add = Command::new("netsh")
        .args([
            "wlan", "add", "profile",
            &format!("filename={}", profile_path.display()),
        ])
        .output()
        .await?;

    let _ = tokio::fs::remove_file(&profile_path).await;

    if !add.status.success() {
        anyhow::bail!("Could not add the WiFi profile. Make sure the app is running as Administrator.");
    }

    let connect = Command::new("netsh")
        .args(["wlan", "connect", &format!("name={ssid}")])
        .output()
        .await?;

    if !connect.status.success() {
        anyhow::bail!("Could not connect to the hotspot. Check the network name and password.");
    }

    // Wait for DHCP
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

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

/// Best-effort: read the active Mobile Hotspot SSID via WinRT.
/// Returns None silently if anything fails — callers use their own fallback.
#[cfg(target_os = "windows")]
async fn read_active_ssid_via_winrt() -> Option<String> {
    use tokio::process::Command;

    let script = r#"try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $ni  = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
    $tmT = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
    $profile = $ni::GetInternetConnectionProfile()
    if ($profile) {
        $manager = $tmT::CreateFromConnectionProfile($profile)
        $config  = $manager.GetCurrentAccessPointConfiguration()
        Write-Output $config.Ssid
    }
} catch {}"#;

    let out = Command::new("powershell")
        .args([
            "-WindowStyle", "Hidden",
            "-NonInteractive",
            "-Command", script,
        ])
        .output()
        .await
        .ok()?;

    let ssid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if ssid.is_empty() { None } else { Some(ssid) }
}

// ── Credential generation ─────────────────────────────────────────────────────

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
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    (0..6)
        .map(|i| chars[((v >> (i * 5)) as usize) % chars.len()])
        .collect()
}

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

// ── Android stubs ─────────────────────────────────────────────────────────────

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