import { Device } from "@/types";
import { useRiftStore } from "@/store/riftStore";

const osIcons: Record<string, string> = {
  windows: "⊞",
  macos: "",
  linux: "🐧",
  android: "⬡",
  unknown: "◈",
};

interface Props {
  device: Device;
}

export function DeviceCard({ device }: Props) {
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const riftedDevices = useRiftStore((s) => s.riftedDevices);
  const setDevicePopup = useRiftStore((s) => s.setDevicePopup);

  const isSelected = selectedDevice?.id === device.id;
  const isRifted = riftedDevices.includes(device.id);

  return (
    <button
      onClick={() => setDevicePopup(device)}
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
        <div className="relative">
          <span className="text-lg leading-none">{osIcons[device.os] ?? "◈"}</span>
          {/* Rift channel status dot */}
          <span
            className={`
              absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-rift-bg
              ${isRifted ? "bg-rift-success" : "bg-rift-muted/50"}
            `}
            title={isRifted ? "Rift channel live" : "Channel establishing…"}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium truncate ${
              isSelected ? "text-rift-accent" : "text-rift-text"
            }`}
          >
            {device.name}
          </p>
          <p className="text-xs text-rift-muted font-mono mt-0.5">{device.ip}</p>
        </div>
        {device.latencyMs !== null && (
          <span
            className={`text-xs font-mono ${
              device.latencyMs < 20
                ? "text-rift-success"
                : device.latencyMs < 60
                ? "text-rift-warning"
                : "text-rift-error"
            }`}
          >
            {device.latencyMs}ms
          </span>
        )}
      </div>
    </button>
  );
}