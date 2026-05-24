//! Runtime gateway IP detection — reads from the OS routing table, never
//! assumes or hardcodes an IP address.
//!
//! Windows: parses `route print 0.0.0.0` (the default route table entry).
//! Android: parses `ip route show default`.
//! macOS/Linux: tries `ip route show default`, falls back to `netstat -rn`.
//!
//! Returns only RFC-1918 private addresses (10.x, 172.16-31.x, 192.168.x).
//! Rejects 0.0.0.0, loopback, and public IPs.

pub async fn get_gateway_ip() -> anyhow::Result<String> {
    #[cfg(target_os = "windows")]
    return get_gateway_windows().await;

    #[cfg(target_os = "android")]
    return get_gateway_android().await;

    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    return get_gateway_unix().await;
}

#[cfg(target_os = "windows")]
async fn get_gateway_windows() -> anyhow::Result<String> {
    use tokio::process::Command;

    // `route print 0.0.0.0` gives the default route entries.
    // Typical line: "         0.0.0.0          0.0.0.0    192.168.137.1  192.168.137.1      25"
    let out = Command::new("route")
        .args(["print", "0.0.0.0"])
        .output()
        .await?;

    let text = String::from_utf8_lossy(&out.stdout);

    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        // Default route: dest=0.0.0.0 mask=0.0.0.0 gateway=<ip> iface=<ip> metric=<n>
        if parts.len() >= 4 && parts[0] == "0.0.0.0" && parts[1] == "0.0.0.0" {
            let gw = parts[2];
            if is_valid_private_ip(gw) {
                eprintln!("[Gateway] Detected: {gw}");
                return Ok(gw.to_string());
            }
        }
    }

    anyhow::bail!("No RFC-1918 default gateway found in Windows routing table")
}

#[cfg(target_os = "android")]
async fn get_gateway_android() -> anyhow::Result<String> {
    use tokio::process::Command;

    // "default via 192.168.43.1 dev wlan0 proto dhcp src 192.168.43.100 metric 100"
    let out = Command::new("ip")
        .args(["route", "show", "default"])
        .output()
        .await?;

    let text = String::from_utf8_lossy(&out.stdout);

    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        for (i, &part) in parts.iter().enumerate() {
            if part == "via" {
                if let Some(&gw) = parts.get(i + 1) {
                    if is_valid_private_ip(gw) {
                        eprintln!("[Gateway] Detected (Android): {gw}");
                        return Ok(gw.to_string());
                    }
                }
            }
        }
    }

    anyhow::bail!("No RFC-1918 default gateway found via `ip route`")
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
async fn get_gateway_unix() -> anyhow::Result<String> {
    use tokio::process::Command;

    // Try Linux-style `ip route` first
    if let Ok(out) = Command::new("ip")
        .args(["route", "show", "default"])
        .output()
        .await
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            for (i, &p) in parts.iter().enumerate() {
                if p == "via" {
                    if let Some(&gw) = parts.get(i + 1) {
                        if is_valid_private_ip(gw) {
                            return Ok(gw.to_string());
                        }
                    }
                }
            }
        }
    }

    // macOS fallback: `netstat -rn -f inet`
    let out = Command::new("netstat")
        .args(["-rn", "-f", "inet"])
        .output()
        .await?;

    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        // "default  192.168.1.1  UGScg  en0"
        if parts.first() == Some(&"default") && parts.len() >= 2 {
            let gw = parts[1];
            if is_valid_private_ip(gw) {
                return Ok(gw.to_string());
            }
        }
    }

    anyhow::bail!("No RFC-1918 default gateway found")
}

/// Returns true only for RFC-1918 private IPv4 addresses.
fn is_valid_private_ip(s: &str) -> bool {
    match s.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => {
            let o = ip.octets();
            !ip.is_loopback()
                && !ip.is_unspecified()
                && (o[0] == 10
                    || (o[0] == 172 && (16..=31).contains(&o[1]))
                    || (o[0] == 192 && o[1] == 168))
        }
        Err(_) => false,
    }
}