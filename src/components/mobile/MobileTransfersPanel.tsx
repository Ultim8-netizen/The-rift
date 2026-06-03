import { useRiftStore } from "@/store/riftStore";
import { TransferItem } from "@/components/TransferItem";

export function MobileTransfersPanel() {
  const transfers = useRiftStore((s) => s.transfers);
  const doneCount = transfers.filter((t) => t.status === "complete").length;

  return (
    <div style={{ width: "100vw", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <p
          className="text-[9px] font-mono uppercase tracking-[0.24em]"
          style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
        >
          {transfers.length} transfer{transfers.length !== 1 ? "s" : ""}
        </p>
        {doneCount > 0 && (
          <span
            className="text-[9px] font-mono font-bold px-2.5 py-1 rounded-full"
            style={{
              color:      "rgb(var(--rift-success))",
              background: "rgb(var(--rift-success) / 0.1)",
              boxShadow:  "0 0 0 1px rgb(var(--rift-success) / 0.2)",
            }}
          >
            {doneCount} done
          </span>
        )}
      </div>

      {transfers.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center mx-4 rounded-3xl py-24 gap-4"
          style={{
            background: "rgb(var(--rift-surface2) / 0.22)",
            boxShadow:  "inset 0 2px 10px rgb(0 0 0 / 0.12)",
          }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{
              background: "rgb(var(--rift-surface2) / 0.48)",
              boxShadow:  "inset 0 1px 0 rgb(255 255 255 / 0.04)",
            }}
          >
            <span className="text-base font-mono font-bold" style={{ color: "rgb(var(--rift-muted) / 0.24)" }}>
              TX
            </span>
          </div>
          <p className="text-xs font-mono" style={{ color: "rgb(var(--rift-muted) / 0.36)" }}>
            No transfers yet
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 px-4 pb-8">
          {transfers.map((t) => (
            <TransferItem key={t.id} transfer={t} />
          ))}
        </div>
      )}
    </div>
  );
}