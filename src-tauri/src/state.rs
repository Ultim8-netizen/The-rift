use std::collections::{HashMap, HashSet};
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

pub struct RiftState {
    pub own_id: String,
    pub own_device_name: String,
    pub own_port: u16,
    pub devices: HashMap<String, Device>,
    pub pending_transfers: HashMap<String, PendingTransfer>,
    pub transfer_notifiers: HashMap<String, tokio::sync::oneshot::Sender<bool>>,
    /// Device IDs with a live TCP rift channel.
    pub rifted_devices: HashSet<String>,
    /// Consecutive heartbeat failures per device — evict at 3.
    pub heartbeat_failures: HashMap<String, u8>,
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
    }))
}