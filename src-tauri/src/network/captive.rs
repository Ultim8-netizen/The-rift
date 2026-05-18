//! Forces the OS to keep the WiFi link alive by three mechanisms:
//!
//! 1. DNS responder on UDP :53 — answers ALL A-record queries with our IP.
//!    Windows NCSI, macOS CNA, and Android/Chrome connectivity checkers do DNS
//!    lookups first. Intercepting them prevents "No Internet" detection.
//!    Requires admin / root. Falls back to hosts-file rewrite if port is taken.
//!
//! 2. HTTP captive portal on TCP :80 — serves exact response bodies that
//!    Windows, macOS, Android, and Linux expect from their connectivity URLs.
//!    Requires admin / root. Silently skipped if unavailable.
//!
//! 3. Hosts-file injection — writes all known NCSI hostnames → our IP into
//!    /etc/hosts (Linux / macOS) or the Windows hosts file. Works without root
//!    on most systems if the app was launched with appropriate permissions.
//!    Cleaned up on exit via `cleanup_hosts_file()`.
//!
//! 4. WiFi power-save disable — runs platform-specific commands (powercfg on
//!    Windows, iw on Linux) to prevent the adapter from sleeping between the
//!    TCP rift-channel PING bursts.

use std::net::Ipv4Addr;
use tokio::net::UdpSocket;

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

const HOSTS_MARKER: &str = "# THE RIFT - DO NOT EDIT BELOW";

// ── Entry point ──────────────────────────────────────────────────────────────

pub async fn start_captive_portal(our_ip: Ipv4Addr) -> anyhow::Result<()> {
    // 1. DNS on :53
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

    // 2. HTTP captive portal on :80
    match tokio::net::TcpListener::bind("0.0.0.0:80").await {
        Ok(listener) => {
            eprintln!("[Captive] HTTP captive portal on :80");
            tokio::spawn(http_captive_loop(listener));
        }
        Err(e) => {
            eprintln!("[Captive] Port 80 unavailable ({e}); NCSI HTTP checks may not be intercepted");
        }
    }

    // 3. WiFi power save
    disable_wifi_power_save().await;

    Ok(())
}

// ── DNS responder ─────────────────────────────────────────────────────────────

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

fn build_dns_response(query: &[u8], ip: Ipv4Addr) -> Option<Vec<u8>> {
    if query.len() < 12 {
        return None;
    }
    // Must be a question (QR bit = 0)
    if query[2] & 0x80 != 0 {
        return None;
    }
    let qd_count = u16::from_be_bytes([query[4], query[5]]);
    if qd_count == 0 {
        return None;
    }

    // Walk the question section to find QTYPE
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
    // Transaction ID
    r.extend_from_slice(&query[0..2]);
    // Flags: QR=1 AA=1 RD=1 RA=1
    r.extend_from_slice(&[0x85, 0x80]);
    // QDCOUNT
    r.extend_from_slice(&query[4..6]);
    // ANCOUNT: 1 for A, 0 for everything else
    r.extend_from_slice(if qtype == 1 { &[0, 1] } else { &[0, 0] });
    // NSCOUNT ARCOUNT
    r.extend_from_slice(&[0, 0, 0, 0]);
    // Copy question section
    r.extend_from_slice(&query[12..]);

    if qtype == 1 {
        // Answer: name pointer → 0x0C
        r.extend_from_slice(&[0xC0, 0x0C]);
        // Type A, Class IN
        r.extend_from_slice(&[0, 1, 0, 1]);
        // TTL 30 s
        r.extend_from_slice(&[0, 0, 0, 30]);
        // RDLENGTH 4
        r.extend_from_slice(&[0, 4]);
        r.extend_from_slice(&ip.octets());
    }

    Some(r)
}

// ── HTTP captive portal ───────────────────────────────────────────────────────

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
                    if first_line.contains("connecttest.txt")
                        || first_line.contains("ncsi.txt")
                    {
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

fn hosts_path() -> &'static str {
    if cfg!(windows) {
        r"C:\Windows\System32\drivers\etc\hosts"
    } else {
        "/etc/hosts"
    }
}

async fn write_hosts_file(ip: Ipv4Addr) {
    let path = hosts_path();
    let current = tokio::fs::read_to_string(path).await.unwrap_or_default();

    // Strip any previous Rift block
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
        Err(e) => eprintln!("[Captive] Cannot write hosts file: {e} (run as admin/root for this feature)"),
    }
}

pub async fn cleanup_hosts_file() {
    let path = hosts_path();
    if let Ok(current) = tokio::fs::read_to_string(path).await {
        let cleaned = strip_rift_block(&current);
        let _ = tokio::fs::write(path, cleaned).await;
        eprintln!("[Captive] Hosts file cleaned up");
    }
}

fn strip_rift_block(content: &str) -> String {
    // Remove the marker line and everything after it that was injected by us,
    // up to the first blank line or end of file.
    if let Some(pos) = content.find(HOSTS_MARKER) {
        // Keep everything before the marker (trim trailing whitespace)
        content[..pos].trim_end().to_string() + "\n"
    } else {
        content.to_string()
    }
}

// ── WiFi power-save disable ───────────────────────────────────────────────────

async fn disable_wifi_power_save() {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        // Wireless Adapter Settings > Power Saving Mode = Maximum Performance (0)
        let _ = Command::new("powercfg")
            .args([
                "/setacvalueindex",
                "SCHEME_CURRENT",
                "19cbb8fa-5279-450e-9fac-8a3d5fedd0c1",
                "12bbebe6-58d6-4636-95bb-3217ef867c1a",
                "0",
            ])
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
            .output()
            .await;
        let _ = Command::new("powercfg")
            .args(["/setactive", "SCHEME_CURRENT"])
            .output()
            .await;
        eprintln!("[Captive] Windows WiFi power save → Maximum Performance");
    }

    #[cfg(target_os = "linux")]
    {
        use tokio::process::Command;
        // Discover all WiFi interfaces via `iw dev`
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
                    // Also try iwconfig legacy
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
        // macOS requires com.apple.wifi private framework or system preferences.
        // We can prevent system sleep which indirectly helps adapter stay active.
        let _ = tokio::process::Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .spawn();
        eprintln!("[Captive] macOS: caffeinate started to prevent system idle sleep");
    }
}