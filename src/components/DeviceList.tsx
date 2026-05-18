import { useRiftStore } from "@/store/riftStore";
import { useInvoke } from "@/hooks/useTauri";
import { DeviceCard } from "./DeviceCard";

function ScanAnimation() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 px-6">
      {/* Radar rings */}
      <div className="relative w-14 h-14 flex items-center justify-center">
        <div
          className="absolute inset-0 rounded-full border border-rift-accent/30 animate-radar"
          style={{ animationDelay: "0s" }}
        />
        <div
          className="absolute inset-0 rounded-full border border-rift-accent/20 animate-radar"
          style={{ animationDelay: "0.9s" }}
        />
        <div
          className="absolute inset-2 rounded-full border border-rift-accent/25"
        />
        <div className="w-1.5 h-1.5 rounded-full bg-rift-accent animate-pulse" />
      </div>
      <div className="text-center">
        <p className="text-[11px] font-mono text-rift-muted tracking-widest uppercase">
          Scanning
        </p>
        <p className="text-[10px] text-rift-muted/50 mt-1 leading-relaxed">
          Open The Rift on another device on this network
        </p>
      </div>
    </div>
  );
}

export function DeviceList() {
  const devices = useRiftStore((s) => s.devices);
  const { call } = useInvoke();

  return (
    <div className="w-60 flex-shrink-0 glass border-r border-rift-border/40 flex flex-col">
      <div className="px-4 py-3.5 border-b border-rift-border/40 flex items-center justify-between">
        <div>
          <h2 className="text-[10px] font-mono font-semibold text-rift-muted/70 uppercase tracking-[0.18em]">
            Devices
          </h2>
          {devices.length > 0 && (
            <p className="text-[10px] font-mono text-rift-accent/60 mt-0.5">
              {devices.length} in range
            </p>
          )}
        </div>
        <button
          onClick={() => call("rescan")}
          className="w-7 h-7 rounded-lg border border-rift-border/50 flex items-center justify-center text-rift-muted hover:text-rift-accent hover:border-rift-accent/40 transition-all text-xs font-mono"
          title="Rescan"
        >
          ↻
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
        {devices.length === 0 ? (
          <ScanAnimation />
        ) : (
          devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))
        )}
      </div>
    </div>
  );
}