import { useRiftStore } from "@/store/riftStore";

const statusConfig = {
  searching: {
    label: "Searching for devices...",
    color: "text-rift-warning",
    dot: "bg-rift-warning animate-pulse",
  },
  connected: {
    label: "Connected",
    color: "text-rift-success",
    dot: "bg-rift-success",
  },
  hotspot: {
    label: "Hotspot Mode",
    color: "text-rift-accent",
    dot: "bg-rift-accent",
  },
  offline: {
    label: "No Network",
    color: "text-rift-error",
    dot: "bg-rift-error",
  },
};

export function StatusBar() {
  const ownDeviceName = useRiftStore((s) => s.ownDeviceName);
  const networkStatus = useRiftStore((s) => s.networkStatus);
  const devicesCount = useRiftStore((s) => s.devices.length);
  const cfg = statusConfig[networkStatus];

  return (
    <div className="h-9 border-t border-rift-border bg-rift-surface flex items-center justify-between px-4 text-xs text-rift-muted font-mono select-none">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        <span className={cfg.color}>{cfg.label}</span>
      </div>
      <div className="flex items-center gap-4">
        <span>
          {devicesCount} device{devicesCount !== 1 ? "s" : ""} in range
        </span>
        <span className="text-rift-border">|</span>
        <span className="text-rift-text">{ownDeviceName}</span>
        <span className="text-rift-border">|</span>
        <span className="text-rift-muted opacity-60">
          abyssprotocol / the rift
        </span>
      </div>
    </div>
  );
}