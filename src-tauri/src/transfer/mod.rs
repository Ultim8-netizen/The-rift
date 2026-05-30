pub mod client;
pub mod integrity;
pub mod manifest;
pub mod overseer;
pub mod server;
pub mod stream_server;
// stream_client removed — functionality fully absorbed into client.rs

pub use client::send_files_to_device;
pub use client::send_text_to_device;
pub use server::start_transfer_server;
pub use stream_server::start_stream_server;