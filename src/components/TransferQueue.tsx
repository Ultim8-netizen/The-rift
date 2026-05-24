import { useRiftStore } from "@/store/riftStore";
import { TransferItem } from "./TransferItem";

export function TransferQueue() {
  const transfers = useRiftStore((s) => s.transfers);
  const doneCount = transfers.filter((t) => t.status === "complete").length;

  return (
    <div
      className="glass flex flex-col flex-shrink-0"
      style={{ width: "260px", borderRadius: "22px" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3.5 flex-shrink-0"
        style={{
          background: "linear-gradient(180deg, rgb(var(--rift-surface) / 0.5) 0%, transparent 100%)",
          borderRadius: "22px 22px 0 0",
        }}
      >
        <div>
          <h2
            className="text-[9px] font-mono font-bold uppercase tracking-[0.22em]"
            style={{ color: "rgb(var(--rift-muted) / 0.65)" }}
          >
            Transfers
          </h2>
          {transfers.length > 0 && (
            <p
              className="text-[10px] font-mono mt-0.5"
              style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
            >
              {transfers.length} total
            </p>
          )}
        </div>

        {doneCount > 0 && (
          <span
            className="text-[9px] font-mono font-bold px-2.5 py-1 rounded-full"
            style={{
              color: "rgb(var(--rift-success))",
              background: "rgb(var(--rift-success) / 0.1)",
              boxShadow: "0 0 0 1px rgb(var(--rift-success) / 0.2)",
            }}
          >
            {doneCount} done
          </span>
        )}
      </div>

      {/* Gradient separator */}
      <div
        className="mx-3 flex-shrink-0"
        style={{
          height: "1px",
          background: "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.1), transparent)",
        }}
      />

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
        {transfers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{
                background: "rgb(var(--rift-surface2) / 0.4)",
                boxShadow: "0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.04)",
              }}
            >
              <span
                className="text-sm font-mono font-bold"
                style={{ color: "rgb(var(--rift-muted) / 0.3)" }}
              >
                TX
              </span>
            </div>
            <p
              className="text-[11px] font-mono text-center"
              style={{ color: "rgb(var(--rift-muted) / 0.4)" }}
            >
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