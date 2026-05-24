import { Device } from "@/types";
import { useRiftStore } from "@/store/riftStore";

const OS_META: Record<string, { label: string }> = {
  windows: { label: "WIN" },
  macos:   { label: "MAC" },
  linux:   { label: "NIX" },
  android: { label: "AND" },
  unknown: { label: "SYS" },
};

function LatencyBadge({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  const cls =
    ms < 20 ? "text-rift-success bg-rift-success/10 border-rift-success/20"
    : ms < 60 ? "text-rift-warning bg-rift-warning/10 border-rift-warning/20"
    : "text-rift-error bg-rift-error/10 border-rift-error/20";
  return (
    <span className={`text-[9px] font-mono border rounded-full px-1.5 py-0.5 leading-none ${cls}`}>
      {ms}ms
    </span>
  );
}

function StatusDot({
  isRifted,
  isReconnecting,
}: {
  isRifted: boolean;
  isReconnecting: boolean;
}) {
  if (isRifted) {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-rift-success shadow-glow-sm"
        title="Rift channel live"
      />
    );
  }
  if (isReconnecting) {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-rift-warning animate-pulse"
        title="Reconnecting…"
      />
    );
  }
  return (
    <span
      className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-rift-muted/30 animate-pulse"
      title="Establishing connection…"
    />
  );
}

export function DeviceCard({ device }: { device: Device }) {
  const selectedDevice    = useRiftStore((s) => s.selectedDevice);
  const riftedDevices     = useRiftStore((s) => s.riftedDevices);
  const reconnectingDevices = useRiftStore((s) => s.reconnectingDevices);
  const setDevicePopup    = useRiftStore((s) => s.setDevicePopup);

  const isSelected     = selectedDevice?.id === device.id;
  const isRifted       = riftedDevices.includes(device.id);
  const isReconnecting = reconnectingDevices.includes(device.id);
  const osMeta         = OS_META[device.os] ?? OS_META.unknown;

  return (
    <button
      onClick={() => setDevicePopup(device)}
      className={`
        w-full text-left rounded-xl p-3 transition-all duration-200 animate-slide-up grad-border
        ${isSelected
          ? "glass-card border-rift-accent/50 shadow-glow-sm"
          : isReconnecting
          ? "glass-card border-rift-warning/25"
          : "glass-card"}
      `}
    >
      <div className="flex items-start gap-2.5">
        {/* OS badge */}
        <span className="flex-shrink-0 text-[9px] font-mono font-bold tracking-widest text-rift-accent/70 border border-rift-accent/20 bg-rift-accent/5 rounded-md px-1.5 py-1 leading-none mt-0.5">
          {osMeta.label}
        </span>

        {/* Name + IP */}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold truncate leading-snug ${isSelected ? "text-rift-accent" : isReconnecting ? "text-rift-warning/80" : "text-rift-text"}`}>
            {device.name}
            {isReconnecting && (
              <span className="ml-1.5 text-[9px] font-mono font-normal text-rift-warning/60 normal-case tracking-normal">
                reconnecting
              </span>
            )}
          </p>
          <p className="text-[10px] font-mono text-rift-muted/70 mt-0.5 truncate">
            {device.ip}
          </p>
        </div>

        {/* Right: status dot + latency */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <StatusDot isRifted={isRifted} isReconnecting={isReconnecting} />
          <LatencyBadge ms={device.latencyMs} />
        </div>
      </div>
    </button>
  );
}