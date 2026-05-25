//! Forces the OS to keep the WiFi link alive.
//!
//! Desktop (Windows / macOS / Linux):
//!   1. DNS responder on UDP :53 — answers ALL A-record queries with our IP.
//!   2. HTTP captive portal on TCP :80 — serves NCSI / CNA check responses.
//!   3. Hosts-file injection — rewrites NCSI hostnames → our IP.
//!   4. WiFi power-save disable — platform-specific commands.
//!   5. Windows Firewall rules — allows all Rift ports inbound.
//!
//! Android: WiFi keepalive handled by WifiLock + MulticastLock + TCP pings.

use std::net::Ipv4Addr;

#[cfg(not(target_os = "android"))]
use tokio::net::UdpSocket;

#[cfg(not(target_os = "android"))]
const NCSI_HOSTS: &[&str] = &[
    "msftconnecttest.com",
    "www.msftconnecttest.com",
    "dns.msftncsi.com",
    "www.msftncsi.com",
    "captive.apple.com",
    "connectivitycheck.gstatic.com",
    "connectivitycheck.android.com",
    "clients3.google.com",
    "nmcheck.gnome.org",
    "network-test.debian.org",
    "networkcheck.kde.org",
];

#[cfg(not(target_os = "android"))]
const HOSTS_MARKER: &str = "# THE RIFT - DO NOT EDIT BELOW";

// ── Entry point ──────────────────────────────────────────────────────────────

pub async fn start_captive_portal(our_ip: Ipv4Addr) -> anyhow::Result<()> {
    #[cfg(target_os = "android")]
    {
        let _ = our_ip;
        eprintln!("[Captive] Android — skipped (WiFi locks handle keepalive)");
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        match UdpSocket::bind("0.0.0.0:53").await {
            Ok(sock) => {
                eprintln!("[Captive] DNS responder on :53 — all NCSI queries → {our_ip}");
                tokio::spawn(dns_loop(sock, our_ip));
            }
            Err(e) => {
                eprintln!("[Captive] Port 53 unavailable ({e}); falling back to hosts file");
                write_hosts_file(our_ip).await;
            }
        }

        match tokio::net::TcpListener::bind("0.0.0.0:80").await {
            Ok(listener) => {
                eprintln!("[Captive] HTTP captive portal on :80");
                tokio::spawn(http_captive_loop(listener));
            }
            Err(e) => {
                eprintln!(
                    "[Captive] Port 80 unavailable ({e}); NCSI HTTP checks may not be intercepted"
                );
            }
        }

        disable_wifi_power_save().await;

        Ok(())
    }
}

// ── Windows Firewall ──────────────────────────────────────────────────────────

/// Adds Windows Firewall inbound allow rules for all Rift ports.
///
/// Ports covered:
///   7474 TCP — HTTP transfer server (/hello, /ping, /request, /manifest, /accept, /decline)
///   7475 TCP — Rift channel (persistent keepalive + ground-truth connectivity)
///   7476 UDP — UDP broadcast discovery
///   7477 TCP — Raw stream server (dual-stream file transfer)
///
/// Rules are idempotent: existing rules are deleted first so re-running the app
/// never accumulates duplicates. Requires administrator privileges (enforced at
/// launch via UAC manifest) — the netsh calls succeed silently if already elevated.
///
/// This is critical on Windows because Defender Firewall will silently block
/// inbound connections on ports 7475–7477 unless explicitly allowed. Port 7474
/// may already be allowed if Windows prompted on first connection, but 7477
/// (the stream server) is a new port that Windows never auto-prompts for and
/// WILL block, causing all file transfers to fail after the accept handshake
/// appears to succeed.
pub async fn add_firewall_rules() {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;

        // Delete stale rules first — idempotent, ignore errors
        let _ = Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", "name=The Rift Transfer"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .await;
        let _ = Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", "name=The Rift Discovery"])
            .creation_flags(0x08000000)
            .output()
            .await;

        // TCP inbound: 7474 (HTTP), 7475 (rift channel), 7477 (stream server)
        let tcp_result = Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule",
                "name=The Rift Transfer",
                "dir=in",
                "action=allow",
                "protocol=TCP",
                "localport=7474,7475,7477",
                "profile=any",
            ])
            .creation_flags(0x08000000)
            .output()
            .await;

        match tcp_result {
            Ok(o) if o.status.success() =>
                eprintln!("[Firewall] TCP inbound rule added (7474, 7475, 7477)"),
            Ok(o) =>
                eprintln!("[Firewall] TCP rule warning: {}", String::from_utf8_lossy(&o.stdout).trim()),
            Err(e) =>
                eprintln!("[Firewall] TCP rule error: {e}"),
        }

        // UDP inbound: 7476 (broadcast discovery)
        let udp_result = Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule",
                "name=The Rift Discovery",
                "dir=in",
                "action=allow",
                "protocol=UDP",
                "localport=7476",
                "profile=any",
            ])
            .creation_flags(0x08000000)
            .output()
            .await;

        match udp_result {
            Ok(o) if o.status.success() =>
                eprintln!("[Firewall] UDP inbound rule added (7476)"),
            Ok(o) =>
                eprintln!("[Firewall] UDP rule warning: {}", String::from_utf8_lossy(&o.stdout).trim()),
            Err(e) =>
                eprintln!("[Firewall] UDP rule error: {e}"),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Linux/macOS: no action needed — iptables/pf typically allow inbound
        // on all ports by default in desktop environments.
    }
}

// ── DNS responder ─────────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
async fn dns_loop(socket: UdpSocket, ip: Ipv4Addr) {
    let mut buf = [0u8; 512];
    loop {
        match socket.recv_from(&mut buf).await {
            Ok((n, src)) => {
                if let Some(resp) = build_dns_response(&buf[..n], ip) {
                    let _ = socket.send_to(&resp, src).await;
                }
            }
            Err(e) => {
                eprintln!("[DNS] recv error: {e}");
                break;
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
fn build_dns_response(query: &[u8], ip: Ipv4Addr) -> Option<Vec<u8>> {
    if query.len() < 12 {
        return None;
    }
    if query[2] & 0x80 != 0 {
        return None;
    }
    let qd_count = u16::from_be_bytes([query[4], query[5]]);
    if qd_count == 0 {
        return None;
    }

    let mut off = 12usize;
    loop {
        if off >= query.len() {
            return None;
        }
        let len = query[off] as usize;
        if len == 0 {
            off += 1;
            break;
        }
        if len & 0xC0 == 0xC0 {
            off += 2;
            break;
        }
        off += len + 1;
    }
    if off + 4 > query.len() {
        return None;
    }
    let qtype = u16::from_be_bytes([query[off], query[off + 1]]);

    let mut r = Vec::with_capacity(query.len() + 20);
    r.extend_from_slice(&query[0..2]);
    r.extend_from_slice(&[0x85, 0x80]);
    r.extend_from_slice(&query[4..6]);
    r.extend_from_slice(if qtype == 1 { &[0, 1] } else { &[0, 0] });
    r.extend_from_slice(&[0, 0, 0, 0]);
    r.extend_from_slice(&query[12..]);

    if qtype == 1 {
        r.extend_from_slice(&[0xC0, 0x0C]);
        r.extend_from_slice(&[0, 1, 0, 1]);
        r.extend_from_slice(&[0, 0, 0, 30]);
        r.extend_from_slice(&[0, 4]);
        r.extend_from_slice(&ip.octets());
    }

    Some(r)
}

// ── HTTP captive portal ───────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
async fn http_captive_loop(listener: tokio::net::TcpListener) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    loop {
        if let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = match stream.read(&mut buf).await {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");

                let (status, ct, body): (&str, &str, &str) =
                    if first_line.contains("connecttest.txt") || first_line.contains("ncsi.txt") {
                        ("200 OK", "text/plain", "Microsoft Connect Test")
                    } else if first_line.contains("hotspot-detect")
                        || first_line.contains("success.html")
                        || first_line.contains("generate_204")
                    {
                        (
                            "200 OK",
                            "text/html",
                            "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>",
                        )
                    } else {
                        ("200 OK", "text/plain", "OK")
                    };

                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    }
}

// ── Hosts file ───────────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
fn hosts_path() -> &'static str {
    if cfg!(windows) {
        r"C:\Windows\System32\drivers\etc\hosts"
    } else {
        "/etc/hosts"
    }
}

#[cfg(not(target_os = "android"))]
async fn write_hosts_file(ip: Ipv4Addr) {
    let path = hosts_path();
    let current = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let cleaned = strip_rift_block(&current);

    let mut new_content = cleaned;
    new_content.push('\n');
    new_content.push_str(HOSTS_MARKER);
    new_content.push('\n');
    for host in NCSI_HOSTS {
        new_content.push_str(&format!("{ip} {host}\n"));
    }

    match tokio::fs::write(path, &new_content).await {
        Ok(_) => eprintln!("[Captive] Hosts file updated → {ip}"),
        Err(e) => eprintln!(
            "[Captive] Cannot write hosts file: {e} (run as admin/root for this feature)"
        ),
    }
}

pub async fn cleanup_hosts_file() {
    #[cfg(target_os = "android")]
    {
        return;
    }

    #[cfg(not(target_os = "android"))]
    {
        let path = hosts_path();
        if let Ok(current) = tokio::fs::read_to_string(path).await {
            let cleaned = strip_rift_block(&current);
            let _ = tokio::fs::write(path, cleaned).await;
            eprintln!("[Captive] Hosts file cleaned up");
        }
    }
}

#[cfg(not(target_os = "android"))]
fn strip_rift_block(content: &str) -> String {
    if let Some(pos) = content.find(HOSTS_MARKER) {
        content[..pos].trim_end().to_string() + "\n"
    } else {
        content.to_string()
    }
}

// ── WiFi power-save disable ───────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
async fn disable_wifi_power_save() {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let _ = Command::new("powercfg")
            .args([
                "/setacvalueindex",
                "SCHEME_CURRENT",
                "19cbb8fa-5279-450e-9fac-8a3d5fedd0c1",
                "12bbebe6-58d6-4636-95bb-3217ef867c1a",
                "0",
            ])
            .creation_flags(0x08000000)
            .output()
            .await;
        let _ = Command::new("powercfg")
            .args([
                "/setdcvalueindex",
                "SCHEME_CURRENT",
                "19cbb8fa-5279-450e-9fac-8a3d5fedd0c1",
                "12bbebe6-58d6-4636-95bb-3217ef867c1a",
                "0",
            ])
            .creation_flags(0x08000000)
            .output()
            .await;
        let _ = Command::new("powercfg")
            .args(["/setactive", "SCHEME_CURRENT"])
            .creation_flags(0x08000000)
            .output()
            .await;
        eprintln!("[Captive] Windows WiFi power save → Maximum Performance");
    }

    #[cfg(target_os = "linux")]
    {
        use tokio::process::Command;
        if let Ok(out) = Command::new("iw").arg("dev").output().await {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if let Some(iface) = trimmed.strip_prefix("Interface ") {
                    let iface = iface.trim();
                    let _ = Command::new("iw")
                        .args(["dev", iface, "set", "power_save", "off"])
                        .output()
                        .await;
                    let _ = Command::new("iwconfig")
                        .args([iface, "power", "off"])
                        .output()
                        .await;
                    eprintln!("[Captive] Linux WiFi power save off: {iface}");
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = tokio::process::Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .spawn();
        eprintln!("[Captive] macOS: caffeinate started to prevent system idle sleep");
    }
}