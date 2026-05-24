import { useRiftStore } from "@/store/riftStore";
import { useInvoke } from "@/hooks/useTauri";
import { DeviceCard } from "./DeviceCard";

function ScanAnimation() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-6 py-8">
      {/* Radar rings */}
      <div className="relative w-16 h-16 flex items-center justify-center flex-shrink-0">
        {[0, 0.75, 1.5].map((delay) => (
          <div
            key={delay}
            className="absolute inset-0 rounded-full animate-radar"
            style={{
              animationDelay: `${delay}s`,
              boxShadow: `0 0 0 1px rgb(var(--rift-accent) / 0.35), 0 0 12px rgb(var(--rift-glow) / 0.2)`,
            }}
          />
        ))}
        {/* Inner disc */}
        <div
          className="relative w-7 h-7 rounded-full flex items-center justify-center"
          style={{
            background: "radial-gradient(circle, rgb(var(--rift-accent) / 0.15) 0%, transparent 70%)",
            boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.25), 0 0 16px rgb(var(--rift-glow) / 0.2)",
          }}
        >
          <span className="status-dot-wait" />
        </div>
      </div>

      <div className="text-center">
        <p className="text-[11px] font-mono text-rift-muted tracking-[0.18em] uppercase mb-1.5">
          Scanning
        </p>
        <p
          className="text-[10px] font-mono leading-relaxed"
          style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
        >
          Open The Rift on another<br/>device on this network
        </p>
      </div>
    </div>
  );
}

export function DeviceList() {
  const devices = useRiftStore((s) => s.devices);
  const { call } = useInvoke();

  return (
    <div
      className="glass flex flex-col flex-shrink-0"
      style={{ width: "232px", borderRadius: "22px" }}
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
            Devices
          </h2>
          {devices.length > 0 && (
            <p
              className="text-[10px] font-mono mt-0.5"
              style={{ color: "rgb(var(--rift-accent) / 0.7)" }}
            >
              {devices.length} in range
            </p>
          )}
        </div>

        <button
          onClick={() => call("rescan")}
          className="w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200"
          style={{
            background: "rgb(var(--rift-surface2) / 0.5)",
            color: "rgb(var(--rift-muted))",
            fontSize: "14px",
            fontFamily: "monospace",
            boxShadow: "0 0 0 1px rgb(255 255 255 / 0.05)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.boxShadow =
              "0 0 0 1px rgb(var(--rift-accent) / 0.35), 0 0 12px rgb(var(--rift-glow) / 0.15)";
            (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent))";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 0 0 1px rgb(255 255 255 / 0.05)";
            (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-muted))";
          }}
          title="Rescan"
        >
          ↻
        </button>
      </div>

      {/* Subtle separator via gradient not border */}
      <div
        className="mx-3 flex-shrink-0"
        style={{
          height: "1px",
          background: "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.1), transparent)",
        }}
      />

      {/* Device list */}
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