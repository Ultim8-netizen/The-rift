import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";

const OS_LABEL: Record<string, string> = {
  windows: "Windows",
  macos:   "macOS",
  linux:   "Linux",
  android: "Android",
  unknown: "Unknown",
};

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[10px] font-mono text-rift-muted/60 uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className={`text-[11px] text-rift-text max-w-[55%] truncate text-right ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

export function DevicePopup() {
  const device        = useRiftStore((s) => s.devicePopup);
  const setPopup      = useRiftStore((s) => s.setDevicePopup);
  const selectDevice  = useRiftStore((s) => s.selectDevice);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const riftedDevices = useRiftStore((s) => s.riftedDevices);
  const overlayRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!device) return;
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") setPopup(null); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [device, setPopup]);

  if (!device) return null;

  const isRifted   = riftedDevices.includes(device.id);
  const isSelected = selectedDevice?.id === device.id;

  function handleSelect() {
    selectDevice(isSelected ? null : device);
    setPopup(null);
  }

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) setPopup(null); }}
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.55)", backdropFilter: "blur(14px)" }}
    >
      <div className="glass-heavy rounded-3xl w-76 shadow-glass overflow-hidden animate-slide-up grad-border" style={{ width: "18rem" }}>
        {/* Gradient accent line */}
        <div
          className="h-0.5"
          style={{
            background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
          }}
        />

        <div className="p-5">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-[9px] font-mono text-rift-muted/55 uppercase tracking-[0.2em] mb-1">
                Device Info
              </p>
              <p className="font-semibold text-rift-text text-sm">{device.name}</p>
            </div>
            <span className="text-[9px] font-mono font-bold text-rift-accent/75 border border-rift-accent/20 bg-rift-accent/8 rounded-md px-2 py-1 leading-none mt-0.5">
              {device.os.toUpperCase().slice(0, 3)}
            </span>
          </div>

          {/* Details */}
          <div
            className="rounded-xl px-3 py-1 mb-4 divide-y divide-rift-border/30"
            style={{ background: "rgb(var(--rift-surface2) / 0.45)" }}
          >
            <Row label="OS" value={OS_LABEL[device.os] ?? device.os} />
            <Row label="Address" value={`${device.ip}:${device.port}`} mono />
            <Row label="Latency" value={device.latencyMs !== null ? `${device.latencyMs}ms` : "—"} mono />
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] font-mono text-rift-muted/60 uppercase tracking-[0.14em]">
                Rift Channel
              </span>
              <span className={`flex items-center gap-1.5 text-[10px] font-mono ${isRifted ? "text-rift-success" : "text-rift-warning"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isRifted ? "bg-rift-success shadow-glow-sm" : "bg-rift-warning animate-pulse"}`} />
                {isRifted ? "LIVE" : "WAIT"}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <button
              onClick={handleSelect}
              className={`
                w-full py-2.5 rounded-xl text-xs font-mono font-bold tracking-[0.1em] uppercase
                transition-all duration-150
                ${isSelected
                  ? "border border-rift-error/30 text-rift-error/80 hover:bg-rift-error/8"
                  : "text-rift-bg shadow-glow hover:shadow-glow-lg hover:scale-[1.01]"}
              `}
              style={!isSelected ? {
                background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
              } : {}}
            >
              {isSelected ? "Deselect" : "Select for Transfer"}
            </button>
            <button
              onClick={() => setPopup(null)}
              className="w-full py-2 rounded-xl border border-rift-border/40 text-rift-muted/60 text-[10px] font-mono tracking-widest uppercase hover:border-rift-accent/25 hover:text-rift-muted transition-all duration-150"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}