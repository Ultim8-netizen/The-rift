// Captive portal DNS simulation for hotspot/no-internet networks.
//
// When two machines connect via a hotspot that has no real internet, the OS
// (Windows, macOS) runs connectivity checks against known endpoints and marks
// the network as "No Internet," which can trigger silent disconnection.
//
// Fixing this requires binding a DNS server to port 53 (requires admin/root).
// This is planned for a future release with privilege elevation handling.
// On a normal shared WiFi network this is not needed.

pub async fn start_captive_portal() -> anyhow::Result<()> {
    eprintln!("[Captive] Disabled in v0.1 (requires elevated privileges for port 53).");
    Ok(())
}