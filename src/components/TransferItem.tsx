import { Transfer } from "@/types";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

const statusColors: Record<string, string> = {
  queued: "text-rift-muted",
  connecting: "text-rift-warning",
  transferring: "text-rift-accent",
  paused: "text-rift-warning",
  complete: "text-rift-success",
  error: "text-rift-error",
  declined: "text-rift-error",
};

interface Props {
  transfer: Transfer;
}

export function TransferItem({ transfer }: Props) {
  const progress =
    transfer.totalBytes > 0
      ? (transfer.bytesTransferred / transfer.totalBytes) * 100
      : 0;

  const label =
    transfer.files.length === 1
      ? transfer.files[0]?.name ?? "Unknown"
      : `${transfer.files.length} files`;

  const deviceName =
    transfer.direction === "outgoing"
      ? transfer.targetDevice?.name
      : transfer.senderDevice?.name;

  return (
    <div className="px-3 py-3 border border-rift-border rounded-lg bg-rift-surface animate-slide-up">
      <div className="flex items-start gap-2 mb-2">
        <span className="text-xs mt-0.5">
          {transfer.direction === "outgoing" ? "↑" : "↓"}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-rift-text font-medium truncate">{label}</p>
          <p className="text-xs text-rift-muted font-mono">
            {deviceName ?? "Unknown"} &bull; {formatBytes(transfer.totalBytes)}
          </p>
        </div>
        <span
          className={`text-xs font-mono ${
            statusColors[transfer.status] ?? "text-rift-muted"
          }`}
        >
          {transfer.status}
        </span>
      </div>

      {(transfer.status === "transferring" || transfer.status === "paused") && (
        <div className="mt-2">
          <div className="w-full h-1 bg-rift-border rounded-full overflow-hidden">
            <div
              className="h-full bg-rift-accent rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-rift-muted font-mono">
              {formatBytes(transfer.bytesTransferred)} /{" "}
              {formatBytes(transfer.totalBytes)}
            </span>
            <span className="text-xs text-rift-muted font-mono">
              {formatBytes(transfer.speedBytesPerSec)}/s{" "}
              {transfer.etaSeconds !== null &&
                `· ${formatEta(transfer.etaSeconds)}`}
            </span>
          </div>
        </div>
      )}

      {transfer.status === "error" && transfer.errorMessage && (
        <p className="text-xs text-rift-error mt-1 font-mono">
          {transfer.errorMessage}
        </p>
      )}
    </div>
  );
}