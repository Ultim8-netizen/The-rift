import { useRiftStore } from "@/store/riftStore";
import { TransferItem } from "./TransferItem";

export function TransferQueue() {
  const transfers = useRiftStore((s) => s.transfers);

  return (
    <div className="w-72 flex-shrink-0 glass border-l border-rift-border/40 flex flex-col">
      <div className="px-4 py-3.5 border-b border-rift-border/40 flex items-center justify-between">
        <div>
          <h2 className="text-[10px] font-mono font-semibold text-rift-muted/70 uppercase tracking-[0.18em]">
            Transfers
          </h2>
          {transfers.length > 0 && (
            <p className="text-[10px] font-mono text-rift-muted/50 mt-0.5">
              {transfers.length} total
            </p>
          )}
        </div>
        {transfers.length > 0 && (
          <div className="flex gap-1">
            <span className="text-[9px] font-mono text-rift-success/70 border border-rift-success/20 bg-rift-success/8 rounded-full px-1.5 py-0.5">
              {transfers.filter((t) => t.status === "complete").length} done
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
        {transfers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div
              className="w-12 h-12 rounded-2xl border border-rift-border/50 flex items-center justify-center"
              style={{ background: "rgb(var(--rift-surface2) / 0.4)" }}
            >
              <span className="text-rift-muted/40 font-mono text-sm">TX</span>
            </div>
            <p className="text-[11px] font-mono text-rift-muted/50 text-center">
              No transfers yet
            </p>
          </div>
        ) : (
          transfers.map((t) => <TransferItem key={t.id} transfer={t} />)
        )}
      </div>
    </div>
  );
}