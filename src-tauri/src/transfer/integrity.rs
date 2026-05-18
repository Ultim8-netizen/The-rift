use sha2::{Digest, Sha256};

pub fn hash_chunk(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

pub fn verify_chunk(data: &[u8], expected_hash: &str) -> bool {
    hash_chunk(data) == expected_hash
}