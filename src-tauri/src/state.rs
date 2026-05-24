use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub os: String,
    pub ip: String,
    pub port: u16,
    pub latency_ms: Option<u64>,
    pub discovered_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTransfer {
    pub transfer_id: String,
    pub sender_device: Device,
    pub files: Vec<FileEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub transfer_id: String,
    pub sender_device: Device,
    pub files: Vec<FileEntry>,
    pub total_bytes: u64,
}

/// Hotspot credential and connection state shared with the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotInfo {
    pub ssid: String,
    pub password: String,
    /// Actual gateway IP read at runtime — never hardcoded.
    pub gateway_ip: String,
    /// true = this device is hosting, false = this device joined.
    pub is_host: bool,
}

/// Per-file receive state for an active dual-stream transfer.
/// Not Serialize/Clone — only accessed internally behind Arc.
pub struct StreamReceiveState {
    pub manifest: crate::transfer::manifest::FileManifest,
    /// Chunk IDs that have been written and verified.
    pub completed_chunks: Mutex<HashSet<usize>>,
    /// Absolute path to the pre-allocated destination file.
    pub dest_path: PathBuf,
    /// File handle used for seek+write operations.
    /// Mutex serializes concurrent writes from stream 0 and stream 1.
    pub file_handle: Mutex<tokio::fs::File>,
}

/// Transfer-level receive state: groups all per-file states for one transfer.
pub struct TransferReceiveState {
    pub transfer_id: String,
    pub files: Vec<Arc<StreamReceiveState>>,
    pub total_files: usize,
    /// Incremented atomically as each file completes full-file verification.
    pub completed_files: AtomicUsize,
}

pub struct RiftState {
    pub own_id: String,
    pub own_device_name: String,
    pub own_port: u16,
    pub devices: HashMap<String, Device>,
    pub pending_transfers: HashMap<String, PendingTransfer>,
    pub transfer_notifiers: HashMap<String, tokio::sync::oneshot::Sender<bool>>,
    /// Device IDs with a live TCP rift channel.
    pub rifted_devices: HashSet<String>,
    /// Consecutive heartbeat failures per device.
    pub heartbeat_failures: HashMap<String, u8>,
    /// Active dual-stream transfers being received.
    pub active_stream_transfers: HashMap<String, Arc<TransferReceiveState>>,
    /// Current hotspot state (None = no hotspot active).
    pub hotspot_info: Option<HotspotInfo>,
}

pub type SharedState = Arc<Mutex<RiftState>>;

pub fn new_shared_state() -> SharedState {
    Arc::new(Mutex::new(RiftState {
        own_id: uuid::Uuid::new_v4().to_string(),
        own_device_name: String::new(),
        own_port: 7474,
        devices: HashMap::new(),
        pending_transfers: HashMap::new(),
        transfer_notifiers: HashMap::new(),
        rifted_devices: HashSet::new(),
        heartbeat_failures: HashMap::new(),
        active_stream_transfers: HashMap::new(),
        hotspot_info: None,
    }))
}