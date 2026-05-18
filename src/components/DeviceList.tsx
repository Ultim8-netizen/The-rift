import { useRiftStore } from "@/store/riftStore";
import { useInvoke } from "@/hooks/useTauri";
import { DeviceCard } from "./DeviceCard";

export function DeviceList() {
  const devices = useRiftStore((s) => s.devices);
  const { call } = useInvoke();

  async function handleRescan() {
    await call("rescan");
  }

  return (
    <div className="w-64 flex-shrink-0 border-r border-rift-border bg-rift-surface flex flex-col">
      <div className="px-4 py-3 border-b border-rift-border flex items-center justify-between">
        <h2 className="text-xs font-mono font-semibold text-rift-muted uppercase tracking-widest">
          Nearby Devices
        </h2>
        <button
          onClick={handleRescan}
          title="Force rescan"
          className="text-rift-muted hover:text-rift-accent transition-colors text-sm leading-none font-mono"
        >
          ⟳
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
            <div className="w-8 h-8 rounded-full border border-rift-border flex items-center justify-center animate-pulse-slow">
              <span className="text-rift-muted text-sm">◈</span>
            </div>
            <p className="text-xs text-rift-muted leading-relaxed">
              Open The Rift on another device on the same network
            </p>
            <button
              onClick={handleRescan}
              className="text-xs font-mono text-rift-accent hover:underline"
            >
              Scan again
            </button>
          </div>
        ) : (
          devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))
        )}
      </div>
    </div>
  );
}