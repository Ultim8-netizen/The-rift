import { useRiftStore } from "@/store/riftStore";
import { TransferItem } from "./TransferItem";

export function TransferQueue() {
  const transfers = useRiftStore((s) => s.transfers);

  return (
    <div className="w-72 flex-shrink-0 border-l border-rift-border bg-rift-surface flex flex-col">
      <div className="px-4 py-3 border-b border-rift-border">
        <h2 className="text-xs font-mono font-semibold text-rift-muted uppercase tracking-widest">
          Transfers
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {transfers.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-rift-muted text-center">
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