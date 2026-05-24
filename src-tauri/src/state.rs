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

pub struct StreamReceiveState {
    pub manifest: crate::transfer::manifest::FileManifest,
    pub completed_chunks: Mutex<HashSet<usize>>,
    pub dest_path: PathBuf,
    pub file_handle: Mutex<tokio::fs::File>,
}

#[allow(dead_code)]
pub struct TransferReceiveState {
    pub transfer_id: String,
    pub files: Vec<Arc<StreamReceiveState>>,
    pub total_files: usize,
    pub completed_files: AtomicUsize,
}

pub struct RiftState {
    pub own_id: String,
    pub own_device_name: String,
    pub own_port: u16,
    pub devices: HashMap<String, Device>,
    pub pending_transfers: HashMap<String, PendingTransfer>,
    pub transfer_notifiers: HashMap<String, tokio::sync::oneshot::Sender<bool>>,
    pub rifted_devices: HashSet<String>,
    pub heartbeat_failures: HashMap<String, u8>,
    pub active_stream_transfers: HashMap<String, Arc<TransferReceiveState>>,
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