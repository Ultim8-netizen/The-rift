import { useState } from "react";
import type { MouseEvent } from "react";
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
  queued:       { label: "QUEUE", color: "rgb(var(--rift-muted))",         bg: "rgb(var(--rift-muted) / 0.08)" },
  connecting:   { label: "CONN",  color: "rgb(var(--rift-warning))",       bg: "rgb(var(--rift-warning) / 0.1)",  glow: "0 0 12px rgb(var(--rift-warning) / 0.2)" },
  transferring: { label: "LIVE",  color: "rgb(var(--rift-accent))",        bg: "rgb(var(--rift-accent) / 0.1)",   glow: "0 0 12px rgb(var(--rift-glow) / 0.25)" },
  paused:       { label: "PAUSE", color: "rgb(var(--rift-warning))",       bg: "rgb(var(--rift-warning) / 0.08)" },
  complete:     { label: "DONE",  color: "rgb(var(--rift-success))",       bg: "rgb(var(--rift-success) / 0.1)",  glow: "0 0 10px rgb(var(--rift-success) / 0.2)" },
  error:        { label: "ERR",   color: "rgb(var(--rift-error))",         bg: "rgb(var(--rift-error) / 0.1)" },
  declined:     { label: "DENY",  color: "rgb(var(--rift-error) / 0.7)",  bg: "rgb(var(--rift-error) / 0.07)" },
};

// ── Detail row for single-file expanded view ───────────────────────────────────
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-start gap-2 px-2.5 py-1.5"
      style={{ borderBottom: "1px solid rgb(255 255 255 / 0.04)" }}
    >
      <span
        className="text-[9px] font-mono uppercase tracking-[0.1em] flex-shrink-0 w-12 mt-0.5"
        style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
      >
        {label}
      </span>
      <span
        className="text-[10px] font-mono break-all leading-relaxed"
        style={{ color: "rgb(var(--rift-muted) / 0.8)" }}
      >
        {value}
      </span>
    </div>
  );
}

export function TransferItem({ transfer }: { transfer: Transfer }) {
  const isMulti = transfer.files.length > 1;

  const [tilt,        setTilt]        = useState({ x: 0, y: 0 });
  const [light,       setLight]       = useState({ x: 50, y: 50 });
  const [hovered,     setHovered]     = useState(false);
  // Multi-file starts expanded so the file list is immediately visible.
  // Single-file starts collapsed — the name is already in the header.
  const [detailsOpen, setDetailsOpen] = useState(isMulti);

  const progress =
    transfer.totalBytes > 0 && typeof transfer.bytesTransferred === "number"
      ? Math.min(100, (transfer.bytesTransferred / transfer.totalBytes) * 100)
      : 0;

  const label =
    isMulti
      ? `${transfer.files.length} files`
      : (transfer.files[0]?.name ?? "Unknown");

  const peer =
    transfer.direction === "outgoing"
      ? transfer.targetDevice?.name
      : transfer.senderDevice?.name;

  const sc       = STATUS_CONFIG[transfer.status] ?? STATUS_CONFIG.queued;
  const isActive = transfer.status === "transferring" || transfer.status === "paused";
  const isDone   = transfer.status === "complete";

  const firstFile = transfer.files[0];

  function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top)  / r.height;
    setTilt({ x: (ny - 0.5) * -8, y: (nx - 0.5) * 8 });
    setLight({ x: nx * 100, y: ny * 100 });
  }

  return (
    <div
      className="rounded-2xl p-3 animate-slide-up"
      onMouseEnter={() => setHovered(true)}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        setTilt({ x: 0, y: 0 });
        setLight({ x: 50, y: 50 });
        setHovered(false);
      }}
      style={{
        position:       "relative",
        overflow:       "hidden",
        background:     `rgb(var(--rift-surface2) / ${isDone ? "0.32" : "0.5"})`,
        backdropFilter: "blur(20px)",
        boxShadow: `
          0 2px 10px rgb(0 0 0 / ${isDone ? "0.18" : "0.25"}),
          0 0 0 1px rgb(255 255 255 / 0.04),
          inset 0 1px 0 rgb(255 255 255 / 0.045)
        `,
        opacity:   isDone ? 0.75 : 1,
        transform: `perspective(600px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        transition: hovered
          ? "transform 0.06s ease-out, box-shadow 0.18s ease"
          : "transform 0.65s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease",
      }}
    >
      {/* Surface light overlay */}
      <div
        aria-hidden
        style={{
          position:      "absolute",
          inset:         0,
          borderRadius:  "16px",
          pointerEvents: "none",
          zIndex:        0,
          background: `radial-gradient(circle at ${light.x}% ${light.y}%,
            rgb(255 255 255 / 0.09) 0%,
            rgb(255 255 255 / 0.03) 40%,
            transparent 65%)`,
          opacity:    hovered ? 1 : 0,
          transition: hovered ? "opacity 0.08s ease" : "opacity 0.55s ease",
        }}
      />

      <div style={{ position: "relative", zIndex: 1 }}>

        {/* ── Header row ───────────────────────────────────────────────── */}
        <div className="flex items-start gap-2 mb-1.5">

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
              color:      sc.color,
              background: sc.bg,
              boxShadow:  sc.glow ?? "none",
            }}
          >
            {sc.label}
          </span>
        </div>

        {/* ── Expandable details (all transfers) ───────────────────────── */}
        <div className="mb-1">

          {/* Toggle button — always present */}
          <button
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex items-center gap-1.5 mb-1 transition-opacity hover:opacity-80"
            style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
          >
            <span
              className="text-[9px] font-mono leading-none"
              style={{
                display:         "inline-block",
                transform:       detailsOpen ? "rotate(90deg)" : "rotate(0deg)",
                transition:      "transform 0.18s ease",
                transformOrigin: "center",
              }}
            >
              ▶
            </span>
            <span className="text-[9px] font-mono uppercase tracking-[0.14em]">
              {isMulti ? `${transfer.files.length} files` : "Details"}
            </span>
          </button>

          {detailsOpen && (
            <div
              // Use explicit overflow classes to avoid the cascade ambiguity
              // of combining the `overflow-hidden` Tailwind class with an
              // inline overflowY — the class sets overflow: hidden on both
              // axes and the inline style may not reliably win in all engines.
              className="rounded-xl overflow-y-auto overflow-x-hidden"
              style={{
                maxHeight: "9rem",
                background: "rgb(var(--rift-bg) / 0.38)",
                boxShadow: "inset 0 1px 4px rgb(0 0 0 / 0.22)",
              }}
            >
              {isMulti ? (
                /* Multi-file: scrollable file list */
                transfer.files.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-2.5 py-1.5"
                    style={{
                      borderBottom:
                        i < transfer.files.length - 1
                          ? "1px solid rgb(255 255 255 / 0.04)"
                          : "none",
                    }}
                  >
                    <span
                      className="text-[10px] font-mono truncate flex-1 pr-2 leading-tight"
                      style={{ color: "rgb(var(--rift-muted) / 0.75)" }}
                    >
                      {f.name}
                    </span>
                    <span
                      className="text-[9px] font-mono flex-shrink-0"
                      style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
                    >
                      {fmt(f.sizeBytes)}
                    </span>
                  </div>
                ))
              ) : (
                /* Single-file: key/value detail rows */
                <>
                  <DetailRow label="Name" value={firstFile?.name ?? "—"} />
                  <DetailRow label="Size" value={
                    firstFile
                      ? `${fmt(firstFile.sizeBytes)}  (${firstFile.sizeBytes.toLocaleString()} B)`
                      : "—"
                  } />
                  {transfer.direction === "outgoing" && firstFile?.path && (
                    <DetailRow label="Source" value={firstFile.path} />
                  )}
                  {transfer.status === "complete" && transfer.savePath && (
                    <DetailRow label="Saved" value={transfer.savePath} />
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Progress bar — active transfers only ─────────────────────── */}
        {isActive && (
          <div className="mt-0.5">
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
                {fmt(transfer.bytesTransferred ?? 0)} / {fmt(transfer.totalBytes)}
              </span>
              <span
                className="text-[9px] font-mono"
                style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
              >
                {transfer.speedBytesPerSec > 0
                  ? `${fmt(transfer.speedBytesPerSec)}/s`
                  : "…"}
                {transfer.etaSeconds !== null && ` · ${fmtEta(transfer.etaSeconds)}`}
              </span>
            </div>
          </div>
        )}

        {/* ── Error message ─────────────────────────────────────────────── */}
        {transfer.status === "error" && transfer.errorMessage && (
          <p
            className="text-[10px] font-mono mt-1.5 leading-snug"
            style={{ color: "rgb(var(--rift-error) / 0.75)" }}
          >
            {transfer.errorMessage}
          </p>
        )}

      </div>
    </div>
  );
}