import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function AcceptDialog() {
  const req = useRiftStore((s) => s.incomingRequest);
  const { acceptTransfer, declineTransfer } = useTransferActions();

  if (!req) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-rift-surface border border-rift-border rounded-2xl p-6 w-80 shadow-2xl shadow-black/50 animate-slide-up">
        <p className="text-xs font-mono text-rift-muted uppercase tracking-widest mb-4">
          Incoming Transfer
        </p>
        <p className="text-rift-text font-semibold mb-1">
          {req.senderDevice.name}
        </p>
        <p className="text-xs text-rift-muted mb-4">
          wants to send you{" "}
          <span className="text-rift-text">
            {req.files.length} file{req.files.length !== 1 ? "s" : ""}
          </span>{" "}
          ({formatBytes(req.totalBytes)})
        </p>

        <div className="max-h-24 overflow-y-auto mb-4">
          {req.files.map((f, i) => (
            <p key={i} className="text-xs text-rift-muted truncate font-mono">
              {f.name}
            </p>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => declineTransfer(req.transferId)}
            className="flex-1 py-2 rounded-lg border border-rift-border text-rift-muted text-sm hover:border-rift-error hover:text-rift-error transition-colors font-mono"
          >
            Decline
          </button>
          <button
            onClick={() => acceptTransfer(req.transferId)}
            className="flex-1 py-2 rounded-lg bg-rift-accent text-rift-bg text-sm font-semibold hover:bg-rift-accentDim transition-colors font-mono"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}