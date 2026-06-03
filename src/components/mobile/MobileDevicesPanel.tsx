import { useRiftStore } from "@/store/riftStore";
import { useInvoke } from "@/hooks/useTauri";
import { OwnDeviceCard } from "./OwnDeviceCard";
import { MobileDeviceRow } from "./MobileDeviceRow";

export function MobileDevicesPanel() {
  const devices = useRiftStore((s) => s.devices);
  const { call } = useInvoke();

  return (
    <div style={{ width: "100vw", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      <OwnDeviceCard />

      <div className="flex items-center justify-between px-4 mb-3 mt-1">
        <div>
          <p
            className="text-[9px] font-mono uppercase tracking-[0.24em]"
            style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
          >
            Nearby
          </p>
          {devices.length > 0 && (
            <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
              {devices.length} in range
            </p>
          )}
        </div>
        <button
          onClick={() => call("rescan")}
          className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-full transition-all"
          style={{
            color:      "rgb(var(--rift-accent) / 0.85)",
            background: "rgb(var(--rift-accent) / 0.08)",
            boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
          }}
        >
          <span style={{ fontSize: 14 }}>↻</span>
          <span>Rescan</span>
        </button>
      </div>

      {devices.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center mx-4 rounded-3xl py-20 gap-6"
          style={{
            background: "rgb(var(--rift-surface2) / 0.22)",
            boxShadow:  "inset 0 2px 10px rgb(0 0 0 / 0.14)",
          }}
        >
          <div className="relative w-16 h-16 flex items-center justify-center">
            {[0, 0.85, 1.7].map((delay) => (
              <div
                key={delay}
                className="absolute inset-0 rounded-full animate-radar"
                style={{
                  animationDelay: `${delay}s`,
                  boxShadow: "0 0 0 1.5px rgb(var(--rift-accent) / 0.28)",
                }}
              />
            ))}
            <div
              className="w-4 h-4 rounded-full"
              style={{
                background: "rgb(var(--rift-accent))",
                boxShadow:  "0 0 24px rgb(var(--rift-glow) / 0.9)",
              }}
            />
          </div>
          <div className="text-center px-8">
            <p
              className="text-xs font-mono font-semibold mb-1.5"
              style={{ color: "rgb(var(--rift-muted) / 0.6)" }}
            >
              Scanning
            </p>
            <p
              className="text-[10px] font-mono leading-relaxed"
              style={{ color: "rgb(var(--rift-muted) / 0.38)" }}
            >
              Open The Rift on another device on the same Wi-Fi network
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-4">
          {devices.map((d) => (
            <MobileDeviceRow key={d.id} deviceId={d.id} />
          ))}
        </div>
      )}

      <div style={{ height: 40 }} />
    </div>
  );
}