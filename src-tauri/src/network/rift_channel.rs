//! Persistent TCP channel between Rift peers.
//!
//! Purpose: keep the WiFi adapter sending traffic every 2 seconds so the OS
//! never marks the link as idle/no-internet and disconnects from it.
//! Secondarily, this provides ground-truth connection state (the mDNS layer
//! is passive and does not confirm reachability).
//!
//! Protocol (line-oriented, UTF-8):
//!   Client → Server: "RIFT/1.0\n"
//!   Server → Client: "RIFT/ACK\n"
//!   Client → Server: "{own_id}\n"          (device ID registration)
//!   Client ←→ Server: "PING\n" / "PONG\n"  every 2 s from client
//!   Either side drops: reconnect after 5 s (client side)
//!
//! Connection ownership: the peer whose ID is lexicographically SMALLER acts
//! as TCP client. This prevents duplicate channels when both peers discover
//! each other simultaneously.

use crate::state::SharedState;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

pub const RIFT_CHANNEL_PORT: u16 = 7475;
/// 1.5 s: more frequent keepalive frames prevent the AP's idle-eviction timer
/// from firing (shortest observed: 8 s) while still being lighter than 1 s.
const PING_INTERVAL: Duration = Duration::from_millis(1500);
/// 6 s: 4 missed PINGs before we declare the peer dead and reconnect.
/// Down from 10 s — faster reconnect after a hotspot radio hiccup.
const PEER_TIMEOUT: Duration = Duration::from_secs(6);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const MAX_RETRIES: u8 = 12; // 1 min total before giving up

// ── Server ──────────────────────────────────────────────────────────────────

pub async fn start_channel_server(state: SharedState, app: AppHandle) -> anyhow::Result<()> {
    let listener = TcpListener::bind(format!("0.0.0.0:{RIFT_CHANNEL_PORT}")).await?;
    eprintln!("[RiftChannel] Server bound on :{RIFT_CHANNEL_PORT}");

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let s = state.clone();
                let a = app.clone();
                tokio::spawn(async move {
                    serve_channel(stream, s, a).await;
                });
            }
            Err(e) => eprintln!("[RiftChannel] accept error: {e}"),
        }
    }
}

async fn serve_channel(stream: TcpStream, state: SharedState, app: AppHandle) {
    // OS-level dead-peer detection: RST within ~11 s of link dying,
    // rather than waiting for the next write to fail (hours without this).
    crate::network::apply_tcp_keepalive(&stream);
    let (read_half, mut writer) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    // Expect handshake
    line.clear();
    if read_line_timeout(&mut reader, &mut line, CONNECT_TIMEOUT).await.is_err()
        || line.trim() != "RIFT/1.0"
    {
        return;
    }

    // Send ACK
    if writer.write_all(b"RIFT/ACK\n").await.is_err() {
        return;
    }

    // Expect peer ID
    line.clear();
    if read_line_timeout(&mut reader, &mut line, CONNECT_TIMEOUT).await.is_err() {
        return;
    }
    let peer_id = line.trim().to_string();
    if peer_id.is_empty() {
        return;
    }

    mark_rifted(&state, &app, &peer_id, true).await;

    // PONG loop – respond to every PING; drop if silent for PEER_TIMEOUT
    loop {
        line.clear();
        match tokio::time::timeout(PEER_TIMEOUT, reader.read_line(&mut line)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(_)) => {
                if line.trim() == "PING" {
                    if writer.write_all(b"PONG\n").await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    mark_rifted(&state, &app, &peer_id, false).await;
}

// ── Client ──────────────────────────────────────────────────────────────────

/// Called from discovery when a new peer is found.
/// Only runs if `own_id < peer_id` (prevents duplicate channels).
pub async fn connect_to_peer(
    peer_ip: String,
    peer_id: String,
    own_id: String,
    state: SharedState,
    app: AppHandle,
) {
    if own_id >= peer_id {
        return; // The other side will connect to us
    }

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(RETRY_DELAY).await;
        }

        // Abort if peer has disappeared from state
        if !state.lock().await.devices.contains_key(&peer_id) {
            return;
        }

        // Abort if already connected
        if state.lock().await.rifted_devices.contains(&peer_id) {
            return;
        }

        let addr = format!("{peer_ip}:{RIFT_CHANNEL_PORT}");
        eprintln!("[RiftChannel] → {addr} (attempt {})", attempt + 1);

        let stream = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect(&addr),
        )
        .await
        {
            Ok(Ok(s)) => s,
            _ => continue,
        };

        // Run the channel – blocks until disconnection
        run_client(stream, peer_id.clone(), own_id.clone(), state.clone(), app.clone()).await;

        // Channel dropped; loop will retry after RETRY_DELAY
    }

    eprintln!("[RiftChannel] Gave up connecting to {peer_id}");
}

async fn run_client(
    stream: TcpStream,
    peer_id: String,
    own_id: String,
    state: SharedState,
    app: AppHandle,
) {
    crate::network::apply_tcp_keepalive(&stream);
    let (read_half, mut writer) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    // Send handshake
    if writer.write_all(b"RIFT/1.0\n").await.is_err() {
        return;
    }

    // Expect ACK
    line.clear();
    if read_line_timeout(&mut reader, &mut line, CONNECT_TIMEOUT).await.is_err()
        || line.trim() != "RIFT/ACK"
    {
        return;
    }

    // Send our ID
    if writer
        .write_all(format!("{own_id}\n").as_bytes())
        .await
        .is_err()
    {
        return;
    }

    mark_rifted(&state, &app, &peer_id, true).await;

    // PING loop
    loop {
        tokio::time::sleep(PING_INTERVAL).await;

        if !state.lock().await.rifted_devices.contains(&peer_id) {
            break;
        }

        if writer.write_all(b"PING\n").await.is_err() {
            break;
        }

        // Expect PONG back within PEER_TIMEOUT
        line.clear();
        match tokio::time::timeout(PEER_TIMEOUT, reader.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 && line.trim() == "PONG" => {}
            _ => break,
        }
    }

    mark_rifted(&state, &app, &peer_id, false).await;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async fn read_line_timeout(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
    line: &mut String,
    timeout: Duration,
) -> anyhow::Result<usize> {
    let n = tokio::time::timeout(timeout, reader.read_line(line))
        .await
        .map_err(|_| anyhow::anyhow!("timeout"))??;
    Ok(n)
}

async fn mark_rifted(state: &SharedState, app: &AppHandle, peer_id: &str, connected: bool) {
    let mut s = state.lock().await;
    if connected {
        s.rifted_devices.insert(peer_id.to_string());
        let _ = app.emit(
            "device_channel_connected",
            &serde_json::json!({ "deviceId": peer_id }),
        );
        eprintln!("[RiftChannel] ✓ channel live: {peer_id}");
    } else {
        s.rifted_devices.remove(peer_id);
        let _ = app.emit(
            "device_channel_lost",
            &serde_json::json!({ "deviceId": peer_id }),
        );
        eprintln!("[RiftChannel] ✗ channel lost: {peer_id}");
    }
}