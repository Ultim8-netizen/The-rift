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

const STATUS_CONFIG: Record<string, {
  label: string;
  color: string;
  bg: string;
  glow?: string;
}> = {
  queued:       { label: "QUEUE",  color: "rgb(var(--rift-muted))",               bg: "rgb(var(--rift-muted) / 0.08)" },
  connecting:   { label: "CONN",   color: "rgb(var(--rift-warning))",             bg: "rgb(var(--rift-warning) / 0.1)", glow: "0 0 12px rgb(var(--rift-warning) / 0.2)" },
  transferring: { label: "LIVE",   color: "rgb(var(--rift-accent))",              bg: "rgb(var(--rift-accent) / 0.1)",  glow: "0 0 12px rgb(var(--rift-glow) / 0.25)" },
  paused:       { label: "PAUSE",  color: "rgb(var(--rift-warning))",             bg: "rgb(var(--rift-warning) / 0.08)" },
  complete:     { label: "DONE",   color: "rgb(var(--rift-success))",             bg: "rgb(var(--rift-success) / 0.1)", glow: "0 0 10px rgb(var(--rift-success) / 0.2)" },
  error:        { label: "ERR",    color: "rgb(var(--rift-error))",               bg: "rgb(var(--rift-error) / 0.1)" },
  declined:     { label: "DENY",   color: "rgb(var(--rift-error) / 0.7)",        bg: "rgb(var(--rift-error) / 0.07)" },
};

export function TransferItem({ transfer }: { transfer: Transfer }) {
  const progress =
    transfer.totalBytes > 0
      ? Math.min(100, (transfer.bytesTransferred / transfer.totalBytes) * 100)
      : 0;

  const label =
    transfer.files.length === 1
      ? (transfer.files[0]?.name ?? "Unknown")
      : `${transfer.files.length} files`;

  const peer =
    transfer.direction === "outgoing"
      ? transfer.targetDevice?.name
      : transfer.senderDevice?.name;

  const sc = STATUS_CONFIG[transfer.status] ?? STATUS_CONFIG.queued;
  const isActive = transfer.status === "transferring" || transfer.status === "paused";
  const isDone   = transfer.status === "complete";

  return (
    <div
      className="rounded-2xl p-3 animate-slide-up"
      style={{
        background: `rgb(var(--rift-surface2) / ${isDone ? "0.32" : "0.5"})`,
        backdropFilter: "blur(20px)",
        boxShadow: `
          0 2px 10px rgb(0 0 0 / ${isDone ? "0.18" : "0.25"}),
          0 0 0 1px rgb(255 255 255 / 0.04),
          inset 0 1px 0 rgb(255 255 255 / 0.045)
        `,
        opacity: isDone ? 0.75 : 1,
        transition: "opacity 0.3s ease",
      }}
    >
      {/* Header */}
      <div className="flex items-start gap-2 mb-2">
        {/* Direction badge */}
        <span
          className="flex-shrink-0 text-[9px] font-mono font-bold rounded-lg px-1.5 py-1 leading-none mt-0.5"
          style={{
            color: transfer.direction === "outgoing"
              ? "rgb(var(--rift-accent) / 0.85)"
              : "rgb(var(--rift-accent2) / 0.85)",
            background: transfer.direction === "outgoing"
              ? "rgb(var(--rift-accent) / 0.1)"
              : "rgb(var(--rift-accent2) / 0.1)",
            boxShadow: transfer.direction === "outgoing"
              ? "0 0 0 1px rgb(var(--rift-accent) / 0.2)"
              : "0 0 0 1px rgb(var(--rift-accent2) / 0.2)",
          }}
        >
          {transfer.direction === "outgoing" ? "TX" : "RX"}
        </span>

        {/* Name + peer */}
        <div className="flex-1 min-w-0">
          <p
            className="text-[11px] font-medium truncate leading-tight"
            style={{ color: "rgb(var(--rift-text))" }}
          >
            {label}
          </p>
          <p
            className="text-[10px] font-mono mt-0.5 truncate"
            style={{ color: "rgb(var(--rift-muted) / 0.6)" }}
          >
            {peer ?? "Unknown"} · {fmt(transfer.totalBytes)}
          </p>
        </div>

        {/* Status badge */}
        <span
          className="text-[9px] font-mono font-bold rounded-full px-2 py-0.5 flex-shrink-0"
          style={{
            color: sc.color,
            background: sc.bg,
            boxShadow: sc.glow ?? "none",
          }}
        >
          {sc.label}
        </span>
      </div>

      {/* Progress bar */}
      {isActive && (
        <div className="mt-2">
          <div className="progress-bar-track w-full h-1">
            <div
              className="progress-bar-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between mt-1.5">
            <span
              className="text-[9px] font-mono"
              style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
            >
              {fmt(transfer.bytesTransferred)} / {fmt(transfer.totalBytes)}
            </span>
            <span
              className="text-[9px] font-mono"
              style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
            >
              {fmt(transfer.speedBytesPerSec)}/s
              {transfer.etaSeconds !== null && ` · ${fmtEta(transfer.etaSeconds)}`}
            </span>
          </div>
        </div>
      )}

      {/* Error message */}
      {transfer.status === "error" && transfer.errorMessage && (
        <p
          className="text-[10px] font-mono mt-1.5 leading-snug"
          style={{ color: "rgb(var(--rift-error) / 0.75)" }}
        >
          {transfer.errorMessage}
        </p>
      )}
    </div>
  );
}