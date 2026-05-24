//! Transfer manifest — the metadata packet sent before any file data moves.
//!
//! Protocol:
//!   1. Sender reads all files, computes per-chunk BLAKE3 hashes and the
//!      full-file BLAKE3 hash by streaming through a hasher.
//!   2. Sender POSTs the manifest to POST /manifest on the receiver.
//!   3. Receiver pre-allocates files, returns a ResumeManifest listing any
//!      already-complete chunks (empty on a fresh transfer).
//!   4. Sender launches dual-stream TCP transfer, skipping completed chunks.
//!
//! Stream assignment:
//!   Chunks 0 .. ceil(N/2)-1 → stream 0 (ascending order, forward from start)
//!   Chunks ceil(N/2) .. N-1 → stream 1 (descending order, backward from end)
//!
//! This struct intentionally does NOT import from crate::state to avoid
//! circular dependencies. The SenderDevice type mirrors Device fields relevant
//! to transfer routing.

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

pub const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4 MB

/// Minimal sender identity included in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderDevice {
    pub id: String,
    pub name: String,
    pub os: String,
    pub ip: String,
    pub port: u16,
}

/// Metadata for one chunk within a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkInfo {
    /// Sequential index within the file (0-based).
    pub id: usize,
    /// Byte offset of this chunk within the assembled file.
    pub offset: u64,
    /// Number of bytes in this chunk (last chunk may be smaller).
    pub size: u64,
    /// BLAKE3 hex digest of the raw chunk bytes.
    pub blake3: String,
    /// 0 = stream 0 (forward, first half); 1 = stream 1 (reverse, second half).
    pub stream: u8,
}

/// Manifest for one file in the transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifest {
    pub name: String,
    pub total_bytes: u64,
    pub total_chunks: usize,
    /// BLAKE3 hex digest of the complete assembled file — used for final
    /// end-to-end integrity verification after all chunks land.
    pub file_blake3: String,
    pub chunks: Vec<ChunkInfo>,
}

/// Top-level manifest sent from sender to receiver before any data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferManifest {
    pub transfer_id: String,
    pub sender_device: SenderDevice,
    pub files: Vec<FileManifest>,
    pub total_bytes: u64,
}

/// Returned by the receiver in response to a manifest POST.
/// Lists chunk IDs already on disk so the sender can skip them.
/// On a fresh transfer, all inner vecs are empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeManifest {
    pub transfer_id: String,
    /// One Vec<usize> per file; each entry is a completed chunk ID.
    pub completed_per_file: Vec<Vec<usize>>,
}

/// Build a TransferManifest by reading each file from disk and computing
/// BLAKE3 hashes. Does a single sequential pass per file — chunk hashes and
/// full-file hash are computed simultaneously.
pub async fn build_manifest(
    transfer_id: String,
    sender_device: SenderDevice,
    file_entries: &[(String, String, u64)], // (name, path, size_bytes)
) -> anyhow::Result<TransferManifest> {
    let mut files = Vec::with_capacity(file_entries.len());
    let mut total_bytes = 0u64;

    for (name, path, size_bytes) in file_entries {
        let fm = build_file_manifest(name, path, *size_bytes).await?;
        total_bytes += fm.total_bytes;
        files.push(fm);
    }

    Ok(TransferManifest {
        transfer_id,
        sender_device,
        files,
        total_bytes,
    })
}

async fn build_file_manifest(
    name: &str,
    path: &str,
    size_bytes: u64,
) -> anyhow::Result<FileManifest> {
    let mut file = tokio::fs::File::open(path).await
        .map_err(|e| anyhow::anyhow!("Cannot open {path}: {e}"))?;

    let chunk_size = DEFAULT_CHUNK_SIZE;
    let total_chunks =
        ((size_bytes as usize).saturating_add(chunk_size - 1)) / chunk_size;
    let total_chunks = total_chunks.max(1);

    let mut chunks = Vec::with_capacity(total_chunks);
    let mut full_hasher = blake3::Hasher::new();
    let mut offset = 0u64;

    for ci in 0..total_chunks {
        let mut buf = vec![0u8; chunk_size];
        let n = file.read(&mut buf).await
            .map_err(|e| anyhow::anyhow!("Read error at chunk {ci}: {e}"))?;
        if n == 0 {
            break;
        }
        buf.truncate(n);

        // Per-chunk BLAKE3 (used by receiver to verify each arriving chunk)
        let chunk_blake3 = hex::encode(blake3::hash(&buf).as_bytes());

        // Feed into full-file hasher (single pass, no double-read)
        full_hasher.update(&buf);

        // Stream assignment: first ceil(N/2) chunks → stream 0 (ascending)
        // remaining chunks → stream 1 (descending on the client side)
        let boundary = total_chunks / 2 + total_chunks % 2;
        let stream = if ci < boundary { 0 } else { 1 };

        chunks.push(ChunkInfo {
            id: ci,
            offset,
            size: n as u64,
            blake3: chunk_blake3,
            stream,
        });

        offset += n as u64;
    }

    let file_blake3 = hex::encode(full_hasher.finalize().as_bytes());

    Ok(FileManifest {
        name: name.to_string(),
        total_bytes: size_bytes,
        total_chunks,
        file_blake3,
        chunks,
    })
}