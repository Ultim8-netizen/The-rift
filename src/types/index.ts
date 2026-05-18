export type ThemeId =
  | "system"
  | "dark-black"
  | "dark-blue"
  | "dark-grey"
  | "dark-purple"
  | "light-pink"
  | "light-lemon"
  | "light-blue";

export type TransferStatus =
  | "queued"
  | "connecting"
  | "transferring"
  | "paused"
  | "complete"
  | "error"
  | "declined";

export type TransferDirection = "outgoing" | "incoming";

export type NetworkStatus =
  | "searching"
  | "connected"
  | "hotspot"
  | "offline";

export interface StagedFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface Device {
  id: string;
  name: string;
  os: "windows" | "macos" | "linux" | "android" | "unknown";
  ip: string;
  port: number;
  latencyMs: number | null;
  discoveredAt: number;
}

export interface FileEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
}

export interface ChunkProgress {
  transferId: string;
  chunkIndex: number;
  totalChunks: number;
  bytesTransferred: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
}

export interface Transfer {
  id: string;
  direction: TransferDirection;
  status: TransferStatus;
  files: FileEntry[];
  targetDevice: Device | null;
  senderDevice: Device | null;
  totalBytes: number;
  bytesTransferred: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  startedAt: number | null;
  completedAt: number | null;
  errorMessage: string | null;
  savePath: string | null;
}

export interface IncomingRequest {
  transferId: string;
  senderDevice: Device;
  files: FileEntry[];
  totalBytes: number;
}

export interface IncomingTextPayload {
  text: string;
  senderDevice: Device;
}

export interface AppState {
  ownDeviceName: string;
  networkStatus: NetworkStatus;
  devicesInRange: number;
}