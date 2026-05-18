import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

export function AcceptDialog() {
  const req = useRiftStore((s) => s.incomingRequest);
  const { acceptTransfer, declineTransfer } = useTransferActions();

  if (!req) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.55)", backdropFilter: "blur(12px)" }}
    >
      <div className="glass-heavy rounded-3xl w-80 shadow-glass overflow-hidden animate-slide-up grad-border">
        {/* Gradient accent bar */}
        <div
          className="h-0.5 w-full"
          style={{
            background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
          }}
        />

        <div className="p-6">
          {/* Header */}
          <p className="text-[9px] font-mono text-rift-muted/60 uppercase tracking-[0.22em] mb-1">
            Incoming Transfer
          </p>
          <p className="text-base font-semibold text-rift-text mb-0.5">
            {req.senderDevice.name}
          </p>
          <p className="text-[11px] text-rift-muted mb-4">
            wants to send{" "}
            <span className="text-rift-text font-mono">
              {req.files.length} file{req.files.length !== 1 ? "s" : ""}
            </span>{" "}
            <span className="text-rift-accent font-mono">{fmt(req.totalBytes)}</span>
          </p>

          {/* File list */}
          <div
            className="max-h-24 overflow-y-auto rounded-xl p-2.5 mb-5"
            style={{ background: "rgb(var(--rift-surface2) / 0.5)" }}
          >
            {req.files.map((f, i) => (
              <p key={i} className="text-[10px] font-mono text-rift-muted/75 truncate py-0.5">
                {f.name}
              </p>
            ))}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={() => declineTransfer(req.transferId)}
              className="flex-1 py-2.5 rounded-xl border border-rift-border/60 text-rift-muted/70 text-xs font-mono tracking-widest uppercase hover:border-rift-error/40 hover:text-rift-error transition-all duration-150"
            >
              Decline
            </button>
            <button
              onClick={() => acceptTransfer(req.transferId)}
              className="flex-1 py-2.5 rounded-xl text-rift-bg text-xs font-mono font-bold tracking-widest uppercase shadow-glow hover:shadow-glow-lg hover:scale-[1.02] transition-all duration-150"
              style={{
                background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
              }}
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}