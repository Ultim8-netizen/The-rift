use blake3;

/// BLAKE3 hash — used for all dual-stream transfers.
/// Significantly faster than SHA-256 and designed for high-throughput use.
#[allow(dead_code)]
pub fn hash_chunk_blake3(data: &[u8]) -> String {
    hex::encode(blake3::hash(data).as_bytes())
}

/// BLAKE3 verify.
#[allow(dead_code)]
pub fn verify_chunk_blake3(data: &[u8], expected: &str) -> bool {
    hash_chunk_blake3(data) == expected
}