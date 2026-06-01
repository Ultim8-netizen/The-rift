//! Transfer manifest — metadata sent before any file data moves.
//!
//! Chunk hash strategy
//! ───────────────────
//! Per-chunk BLAKE3 hashes are NOT computed during manifest build.  They are
//! computed by the sender at send time (read chunk → BLAKE3 → include in the
//! CHUNK header).  The receiver verifies each chunk hash from the CHUNK header,
//! providing per-byte integrity coverage over the entire transfer.
//!
//! Full-file hash
//! ──────────────
//! `FileManifest::file_blake3` is left empty (`String::new()`).  The receiver
//! skips the post-assembly full-file hash check when this field is empty.
//! Per-chunk BLAKE3 is comprehensive: every byte of every chunk is individually
//! verified, making a full-file second pass redundant for local LAN transfers.
//! This eliminates two full sequential reads of the source file (one on the
//! sender during manifest build, one on the receiver after assembly) — for
//! large files this was 30-90 seconds of wasted time before a byte moved.
//!
//! Chunk size
//! ──────────
//! 1 MB.  Previous value was 512 KB.  On a local hotspot with 2 ms RTT and
//! 10-100 MB/s throughput, 1 MB chunks reduce the total ACK round-trip count
//! by 2× while keeping per-chunk BLAKE3 fast (<1 ms).

use serde::{Deserialize, Serialize};

/// 1 MB — optimal chunk size for local WiFi hotspot transfers.
pub const DEFAULT_CHUNK_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderDevice {
    pub id:   String,
    pub name: String,
    pub os:   String,
    pub ip:   String,
    pub port: u16,
}

/// Metadata for one chunk.
///
/// `blake3` is always `String::new()` in the manifest.  The actual hash is
/// computed by the sender when the chunk is read and included in the CHUNK
/// protocol header.  The receiver verifies against that header hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkInfo {
    pub id:     usize,
    pub offset: u64,
    pub size:   u64,
    /// Always empty in the manifest.  Hash is computed during send.
    pub blake3: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifest {
    pub name:         String,
    pub total_bytes:  u64,
    pub total_chunks: usize,
    /// Empty string — per-chunk hashes provide integrity coverage.
    /// The receiver skips full-file verification when this is empty.
    pub file_blake3:  String,
    pub chunks:       Vec<ChunkInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferManifest {
    pub transfer_id:   String,
    pub sender_device: SenderDevice,
    pub files:         Vec<FileManifest>,
    pub total_bytes:   u64,
    /// Number of concurrent worker streams the sender opens per file.
    pub num_streams:   usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeManifest {
    pub transfer_id:        String,
    pub completed_per_file: Vec<Vec<usize>>,
}

pub async fn build_manifest(
    transfer_id:   String,
    sender_device: SenderDevice,
    file_entries:  &[(String, String, u64)],
    num_streams:   usize,
) -> anyhow::Result<TransferManifest> {
    let mut files       = Vec::with_capacity(file_entries.len());
    let mut total_bytes = 0u64;

    for (name, path, size_bytes) in file_entries {
        let fm = build_file_manifest(name, path, *size_bytes)?;
        total_bytes += fm.total_bytes;
        files.push(fm);
    }

    Ok(TransferManifest { transfer_id, sender_device, files, total_bytes, num_streams })
}

/// Build chunk metadata from file size alone — no file I/O, O(chunk_count) time.
///
/// Per-chunk BLAKE3 hashes are computed lazily by the sender at send time.
/// Full-file hash is omitted; per-chunk verification provides equivalent coverage.
fn build_file_manifest(
    name:       &str,
    _path:      &str,   // not read — hashes computed during send
    size_bytes: u64,
) -> anyhow::Result<FileManifest> {
    if size_bytes == 0 {
        return Ok(FileManifest {
            name:         name.to_string(),
            total_bytes:  0,
            total_chunks: 0,
            file_blake3:  String::new(),
            chunks:       vec![],
        });
    }

    let chunk_size   = DEFAULT_CHUNK_SIZE as u64;
    let total_chunks = ((size_bytes + chunk_size - 1) / chunk_size) as usize;

    let chunks: Vec<ChunkInfo> = (0..total_chunks)
        .map(|i| {
            let offset = i as u64 * chunk_size;
            let size   = (size_bytes - offset).min(chunk_size);
            ChunkInfo { id: i, offset, size, blake3: String::new() }
        })
        .collect();

    Ok(FileManifest {
        name:         name.to_string(),
        total_bytes:  size_bytes,
        total_chunks,
        file_blake3:  String::new(),
        chunks,
    })
}