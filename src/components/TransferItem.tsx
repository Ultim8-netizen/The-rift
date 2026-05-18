import { Transfer } from "@/types";

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

function fmtEta(s: number | null): string {
  if (s === null) return "";
  return s < 60 ? `${Math.ceil(s)}s` : `${Math.ceil(s / 60)}m`;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  queued:      { label: "QUEUE",  color: "text-rift-muted" },
  connecting:  { label: "CONN",   color: "text-rift-warning" },
  transferring:{ label: "LIVE",   color: "text-rift-accent" },
  paused:      { label: "PAUSE",  color: "text-rift-warning" },
  complete:    { label: "DONE",   color: "text-rift-success" },
  error:       { label: "ERR",    color: "text-rift-error" },
  declined:    { label: "DENY",   color: "text-rift-error" },
};

export function TransferItem({ transfer }: { transfer: Transfer }) {
  const progress =
    transfer.totalBytes > 0
      ? (transfer.bytesTransferred / transfer.totalBytes) * 100
      : 0;

  const label =
    transfer.files.length === 1
      ? (transfer.files[0]?.name ?? "Unknown")
      : `${transfer.files.length} files`;

  const peer =
    transfer.direction === "outgoing"
      ? transfer.targetDevice?.name
      : transfer.senderDevice?.name;

  const meta = STATUS_META[transfer.status] ?? STATUS_META.queued;
  const isActive = transfer.status === "transferring" || transfer.status === "paused";
  const isDone   = transfer.status === "complete";

  return (
    <div className={`glass-card rounded-xl p-3 animate-slide-up ${isDone ? "opacity-70" : ""}`}>
      {/* Header row */}
      <div className="flex items-start gap-2 mb-2">
        {/* Direction badge */}
        <span
          className={`
            flex-shrink-0 text-[9px] font-mono font-bold border rounded-md px-1.5 py-1 leading-none mt-0.5
            ${transfer.direction === "outgoing"
              ? "text-rift-accent/80 border-rift-accent/25 bg-rift-accent/8"
              : "text-rift-accent2/80 border-rift-accent2/25 bg-rift-accent2/8"}
          `}
        >
          {transfer.direction === "outgoing" ? "TX" : "RX"}
        </span>

        {/* File name + peer */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-rift-text font-medium truncate leading-snug">{label}</p>
          <p className="text-[10px] font-mono text-rift-muted/65 mt-0.5 truncate">
            {peer ?? "Unknown"} · {fmt(transfer.totalBytes)}
          </p>
        </div>

        {/* Status pill */}
        <span className={`text-[9px] font-mono font-bold flex-shrink-0 ${meta.color}`}>
          {meta.label}
        </span>
      </div>

      {/* Progress */}
      {isActive && (
        <div className="mt-2">
          <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: "rgb(var(--rift-border) / 0.5)" }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress}%`,
                background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[9px] font-mono text-rift-muted/60">
              {fmt(transfer.bytesTransferred)} / {fmt(transfer.totalBytes)}
            </span>
            <span className="text-[9px] font-mono text-rift-muted/60">
              {fmt(transfer.speedBytesPerSec)}/s
              {transfer.etaSeconds !== null && ` · ${fmtEta(transfer.etaSeconds)}`}
            </span>
          </div>
        </div>
      )}

      {transfer.status === "error" && transfer.errorMessage && (
        <p className="text-[10px] font-mono text-rift-error/80 mt-1.5 leading-snug">
          {transfer.errorMessage}
        </p>
      )}
    </div>
  );
}