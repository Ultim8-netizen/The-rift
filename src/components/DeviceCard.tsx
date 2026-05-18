import { Device } from "@/types";
import { useRiftStore } from "@/store/riftStore";

const osIcons: Record<string, string> = {
  windows: "⊞",
  macos: "",
  linux: "🐧",
  android: "⬡",
  unknown: "◈",
};

function formatLatency(ms: number | null): string {
  if (ms === null) return "...";
  return `${ms}ms`;
}

interface Props {
  device: Device;
}

export function DeviceCard({ device }: Props) {
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const selectDevice = useRiftStore((s) => s.selectDevice);
  const isSelected = selectedDevice?.id === device.id;

  return (
    <button
      onClick={() => selectDevice(isSelected ? null : device)}
      className={`
        w-full text-left px-3 py-3 rounded-lg border transition-all duration-150 animate-slide-up
        ${
          isSelected
            ? "border-rift-accent bg-rift-accent/10 shadow-[0_0_12px_rgba(0,200,255,0.15)]"
            : "border-rift-border bg-rift-surface hover:border-rift-accent/40 hover:bg-rift-accent/5"
        }
      `}
    >
      <div className="flex items-center gap-3">
        <span className="text-lg leading-none">{osIcons[device.os]}</span>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium truncate ${
              isSelected ? "text-rift-accent" : "text-rift-text"
            }`}
          >
            {device.name}
          </p>
          <p className="text-xs text-rift-muted font-mono mt-0.5">
            {device.ip}
          </p>
        </div>
        <span
          className={`text-xs font-mono ${
            device.latencyMs !== null && device.latencyMs < 20
              ? "text-rift-success"
              : device.latencyMs !== null && device.latencyMs < 60
              ? "text-rift-warning"
              : "text-rift-muted"
          }`}
        >
          {formatLatency(device.latencyMs)}
        </span>
      </div>
    </button>
  );
}