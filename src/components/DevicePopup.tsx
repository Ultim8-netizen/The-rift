import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";

const osLabels: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  unknown: "Unknown",
};

export function DevicePopup() {
  const device = useRiftStore((s) => s.devicePopup);
  const setDevicePopup = useRiftStore((s) => s.setDevicePopup);
  const selectDevice = useRiftStore((s) => s.selectDevice);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const riftedDevices = useRiftStore((s) => s.riftedDevices);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!device) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDevicePopup(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [device, setDevicePopup]);

  if (!device) return null;

  const isRifted = riftedDevices.includes(device.id);
  const isSelected = selectedDevice?.id === device.id;

  function handleSelect() {
    if (isSelected) {
      selectDevice(null);
    } else {
      selectDevice(device);
    }
    setDevicePopup(null);
  }

  return (
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) setDevicePopup(null);
      }}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
    >
      <div className="bg-rift-surface border border-rift-border rounded-2xl w-72 shadow-2xl shadow-black/60 animate-slide-up overflow-hidden">
        {/* Header bar */}
        <div className="px-5 pt-5 pb-3 border-b border-rift-border">
          <p className="text-xs font-mono text-rift-muted uppercase tracking-widest mb-1">
            Device Info
          </p>
          <p className="text-rift-text font-semibold text-base">{device.name}</p>
        </div>

        {/* Details */}
        <div className="px-5 py-4 flex flex-col gap-2">
          <Row label="OS" value={osLabels[device.os] ?? device.os} />
          <Row label="Address" value={`${device.ip}:${device.port}`} mono />
          <Row
            label="Latency"
            value={
              device.latencyMs !== null ? `${device.latencyMs}ms` : "measuring…"
            }
            mono
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-rift-muted font-mono uppercase tracking-wider">
              Rift Channel
            </span>
            <span
              className={`flex items-center gap-1.5 text-xs font-mono ${
                isRifted ? "text-rift-success" : "text-rift-warning"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isRifted ? "bg-rift-success" : "bg-rift-warning animate-pulse"
                }`}
              />
              {isRifted ? "LIVE" : "ESTABLISHING"}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex flex-col gap-2">
          <button
            onClick={handleSelect}
            className={`
              w-full py-2.5 rounded-lg font-mono text-sm font-semibold tracking-wide transition-all
              ${
                isSelected
                  ? "bg-rift-border text-rift-muted border border-rift-border hover:border-rift-error/60 hover:text-rift-error"
                  : "bg-rift-accent text-rift-bg hover:bg-rift-accentDim shadow-[0_0_16px_rgba(0,200,255,0.2)]"
              }
            `}
          >
            {isSelected ? "DESELECT" : "SELECT FOR TRANSFER"}
          </button>
          <button
            onClick={() => setDevicePopup(null)}
            className="w-full py-2 rounded-lg border border-rift-border text-rift-muted text-xs font-mono hover:border-rift-accent/40 hover:text-rift-accent transition-colors"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-rift-muted font-mono uppercase tracking-wider">
        {label}
      </span>
      <span
        className={`text-xs text-rift-text ${mono ? "font-mono" : ""} max-w-[55%] truncate text-right`}
      >
        {value}
      </span>
    </div>
  );
}