use sha2::{Digest, Sha256};

/// SHA-256 hash for legacy HTTP chunk uploads (kept for backward compatibility).
pub fn hash_chunk(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// SHA-256 verify (legacy).
pub fn verify_chunk(data: &[u8], expected_hash: &str) -> bool {
    hash_chunk(data) == expected_hash
}

/// BLAKE3 hash — used for all dual-stream transfers.
/// Significantly faster than SHA-256 and designed for high-throughput use.
pub fn hash_chunk_blake3(data: &[u8]) -> String {
    hex::encode(blake3::hash(data).as_bytes())
}

/// BLAKE3 verify.
pub fn verify_chunk_blake3(data: &[u8], expected: &str) -> bool {
    hash_chunk_blake3(data) == expected
}