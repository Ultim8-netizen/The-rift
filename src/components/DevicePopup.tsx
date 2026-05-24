import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";

const OS_LABEL: Record<string, string> = {
  windows: "Windows",
  macos:   "macOS",
  linux:   "Linux",
  android: "Android",
  unknown: "Unknown",
};

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span
        className="text-[10px] font-mono uppercase tracking-[0.16em]"
        style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
      >
        {label}
      </span>
      <span
        className={`text-[11px] max-w-[55%] truncate text-right ${mono ? "font-mono" : ""}`}
        style={{ color: "rgb(var(--rift-text))" }}
      >
        {value}
      </span>
    </div>
  );
}

export function DevicePopup() {
  const device         = useRiftStore((s) => s.devicePopup);
  const setPopup       = useRiftStore((s) => s.setDevicePopup);
  const selectDevice   = useRiftStore((s) => s.selectDevice);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const riftedDevices  = useRiftStore((s) => s.riftedDevices);
  const overlayRef     = useRef<HTMLDivElement>(null);

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
      style={{ background: "rgb(0 0 0 / 0.6)", backdropFilter: "blur(20px)" }}
    >
      <div
        className="glass-heavy animate-scale-in overflow-hidden"
        style={{ width: "300px", borderRadius: "28px" }}
      >
        {/* Accent top band */}
        <div
          style={{
            height: "3px",
            background: `linear-gradient(90deg, ${
              isRifted
                ? "rgb(var(--rift-success) / 0.8), rgb(var(--rift-accent) / 0.4)"
                : "rgb(var(--rift-accent) / 0.8), rgb(var(--rift-accent2) / 0.4)"
            }, transparent)`,
            boxShadow: `0 0 24px ${isRifted ? "rgb(var(--rift-success) / 0.4)" : "rgb(var(--rift-glow) / 0.4)"}`,
          }}
        />

        <div className="p-5">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <p
                className="text-[9px] font-mono uppercase tracking-[0.22em] mb-1"
                style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
              >
                Device
              </p>
              <p className="font-semibold text-rift-text text-sm">{device.name}</p>
            </div>
            {/* Connection status indicator */}
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full"
              style={{
                background: isRifted
                  ? "rgb(var(--rift-success) / 0.1)"
                  : "rgb(var(--rift-warning) / 0.1)",
                boxShadow: `0 0 0 1px ${isRifted ? "rgb(var(--rift-success) / 0.2)" : "rgb(var(--rift-warning) / 0.2)"}`,
              }}
            >
              <span className={isRifted ? "status-dot-live" : "status-dot-wait"} />
              <span
                className="text-[9px] font-mono font-bold"
                style={{
                  color: isRifted ? "rgb(var(--rift-success))" : "rgb(var(--rift-warning))",
                }}
              >
                {isRifted ? "LIVE" : "WAIT"}
              </span>
            </div>
          </div>

          {/* Details */}
          <div
            className="rounded-2xl px-3 py-1 mb-4"
            style={{
              background: "rgb(var(--rift-bg) / 0.4)",
              boxShadow: "inset 0 2px 8px rgb(0 0 0 / 0.2)",
            }}
          >
            {/* Dividers via margin, not borders */}
            <InfoRow label="OS" value={OS_LABEL[device.os] ?? device.os} />
            <div style={{ height: "1px", background: "rgb(255 255 255 / 0.04)", margin: "0" }} />
            <InfoRow label="Address" value={`${device.ip}:${device.port}`} mono />
            <div style={{ height: "1px", background: "rgb(255 255 255 / 0.04)" }} />
            <InfoRow
              label="Latency"
              value={device.latencyMs !== null ? `${device.latencyMs}ms` : "—"}
              mono
            />
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <button
              onClick={handleSelect}
              className={`w-full py-2.5 ${isSelected ? "btn-danger" : "btn-accent"}`}
              style={{ fontSize: "0.7rem" }}
            >
              {isSelected ? "Deselect Device" : "Select for Transfer"}
            </button>
            <button
              onClick={() => setPopup(null)}
              className="w-full py-2 btn-ghost"
              style={{ fontSize: "0.65rem" }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}