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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.6)", backdropFilter: "blur(20px)" }}
    >
      <div
        className="glass-heavy animate-scale-in overflow-hidden"
        style={{
          width: "320px",
          borderRadius: "28px",
        }}
      >
        {/* Glowing top accent band */}
        <div
          style={{
            height: "3px",
            background: "linear-gradient(90deg, rgb(var(--rift-accent) / 0.8), rgb(var(--rift-accent2) / 0.6), transparent)",
            boxShadow: "0 0 24px rgb(var(--rift-glow) / 0.5)",
          }}
        />

        <div className="p-6">
          {/* Header */}
          <p
            className="text-[9px] font-mono uppercase tracking-[0.24em] mb-1"
            style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
          >
            Incoming Transfer
          </p>
          <p className="text-base font-semibold text-rift-text mb-0.5">
            {req.senderDevice.name}
          </p>
          <p
            className="text-[11px] mb-5"
            style={{ color: "rgb(var(--rift-muted) / 0.75)" }}
          >
            wants to send{" "}
            <span className="font-mono text-rift-text">
              {req.files.length} file{req.files.length !== 1 ? "s" : ""}
            </span>{" "}
            <span
              className="font-mono font-semibold"
              style={{ color: "rgb(var(--rift-accent))" }}
            >
              {fmt(req.totalBytes)}
            </span>
          </p>

          {/* File list */}
          <div
            className="max-h-24 overflow-y-auto rounded-2xl px-3 py-2 mb-5"
            style={{
              background: "rgb(var(--rift-bg) / 0.45)",
              boxShadow: "inset 0 2px 8px rgb(0 0 0 / 0.2)",
            }}
          >
            {req.files.map((f, i) => (
              <p
                key={i}
                className="text-[10px] font-mono truncate py-0.5"
                style={{ color: "rgb(var(--rift-muted) / 0.7)" }}
              >
                {f.name}
              </p>
            ))}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={() => declineTransfer(req.transferId)}
              className="flex-1 py-2.5 btn-ghost text-xs"
            >
              Decline
            </button>
            <button
              onClick={() => acceptTransfer(req.transferId)}
              className="flex-1 py-2.5 btn-accent text-xs"
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}