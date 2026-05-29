//! Transfer manifest — the metadata packet sent before any file data moves.
//!
//! The `stream` field has been removed from `ChunkInfo`.  There is no longer
//! any static stream-to-chunk assignment.  The sender builds a single ordered
//! chunk queue and N workers compete to drain it; the receiver writes each
//! chunk wherever it arrives.

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

pub const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4 MB

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifest {
    pub name: String,
    pub total_bytes: u64,
    pub total_chunks: usize,
    /// BLAKE3 hex digest of the complete assembled file.
    pub file_blake3: String,
    pub chunks: Vec<ChunkInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferManifest {
    pub transfer_id: String,
    pub sender_device: SenderDevice,
    pub files: Vec<FileManifest>,
    pub total_bytes: u64,
    /// Number of concurrent worker streams the sender will open per file.
    /// The receiver uses this for failure detection only (not for finalization
    /// gating — finalization is triggered by chunk count).
    pub num_streams: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeManifest {
    pub transfer_id: String,
    /// One Vec<usize> per file; each entry is a completed chunk ID.
    pub completed_per_file: Vec<Vec<usize>>,
}

pub async fn build_manifest(
    transfer_id: String,
    sender_device: SenderDevice,
    file_entries: &[(String, String, u64)], // (name, path, size_bytes)
    num_streams: usize,
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
        num_streams,
    })
}

async fn build_file_manifest(
    name: &str,
    path: &str,
    size_bytes: u64,
) -> anyhow::Result<FileManifest> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot open {path}: {e}"))?;

    let chunk_size = DEFAULT_CHUNK_SIZE;
    let total_chunks =
        ((size_bytes as usize).saturating_add(chunk_size - 1)) / chunk_size;
    let total_chunks = total_chunks.max(1);

    let mut chunks = Vec::with_capacity(total_chunks);
    let mut full_hasher = blake3::Hasher::new();
    let mut offset = 0u64;

    for ci in 0..total_chunks {
        // Use a fill-loop instead of a bare `read()` call.
        // A single `AsyncReadExt::read` may legally return fewer bytes than
        // the buffer even for a local file; the loop ensures we always get a
        // full chunk (or everything up to EOF for the last chunk).
        let mut buf = vec![0u8; chunk_size];
        let mut total_read = 0usize;
        while total_read < chunk_size {
            match file.read(&mut buf[total_read..]).await
                .map_err(|e| anyhow::anyhow!("Read error at chunk {ci}: {e}"))?
            {
                0 => break, // EOF
                n => total_read += n,
            }
        }

        if total_read == 0 {
            break; // Nothing left
        }
        buf.truncate(total_read);

        let chunk_blake3 = hex::encode(blake3::hash(&buf).as_bytes());
        full_hasher.update(&buf);

        chunks.push(ChunkInfo {
            id: ci,
            offset,
            size: total_read as u64,
            blake3: chunk_blake3,
        });

        offset += total_read as u64;
    }

    let file_blake3 = hex::encode(full_hasher.finalize().as_bytes());

    Ok(FileManifest {
        name: name.to_string(),
        total_bytes: size_bytes,
        total_chunks: chunks.len(),
        file_blake3,
        chunks,
    })
}