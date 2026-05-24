import { Device } from "@/types";
import { useRiftStore } from "@/store/riftStore";

const OS_META: Record<string, { label: string; color: string }> = {
  windows: { label: "WIN", color: "rgb(var(--rift-accent) / 0.8)" },
  macos:   { label: "MAC", color: "rgb(var(--rift-accent2) / 0.8)" },
  linux:   { label: "NIX", color: "rgb(var(--rift-success) / 0.8)" },
  android: { label: "AND", color: "rgb(var(--rift-warning) / 0.8)" },
  unknown: { label: "SYS", color: "rgb(var(--rift-muted) / 0.6)" },
};

export function DeviceCard({ device }: { device: Device }) {
  const selectedDevice      = useRiftStore((s) => s.selectedDevice);
  const riftedDevices       = useRiftStore((s) => s.riftedDevices);
  const reconnectingDevices = useRiftStore((s) => s.reconnectingDevices);
  const setDevicePopup      = useRiftStore((s) => s.setDevicePopup);

  const isSelected     = selectedDevice?.id === device.id;
  const isRifted       = riftedDevices.includes(device.id);
  const isReconnecting = reconnectingDevices.includes(device.id);
  const osMeta         = OS_META[device.os] ?? OS_META.unknown;

  // Build shadow based on state
  let cardShadow: string;
  if (isSelected) {
    cardShadow = `
      0 4px 20px rgb(0 0 0 / 0.4),
      0 0 0 1px rgb(var(--rift-accent) / 0.5),
      0 0 40px rgb(var(--rift-glow) / 0.18),
      inset 0 1px 0 rgb(255 255 255 / 0.08)
    `;
  } else if (isRifted) {
    cardShadow = `
      0 2px 10px rgb(0 0 0 / 0.3),
      0 0 0 1px rgb(var(--rift-success) / 0.22),
      0 0 20px rgb(var(--rift-success) / 0.08),
      inset 0 1px 0 rgb(255 255 255 / 0.05)
    `;
  } else if (isReconnecting) {
    cardShadow = `
      0 2px 10px rgb(0 0 0 / 0.28),
      0 0 0 1px rgb(var(--rift-warning) / 0.28),
      0 0 18px rgb(var(--rift-warning) / 0.1),
      inset 0 1px 0 rgb(255 255 255 / 0.05)
    `;
  } else {
    cardShadow = `
      0 2px 10px rgb(0 0 0 / 0.25),
      0 0 0 1px rgb(255 255 255 / 0.04),
      inset 0 1px 0 rgb(255 255 255 / 0.05)
    `;
  }

  let cardBg: string;
  if (isSelected) {
    cardBg = `linear-gradient(145deg, rgb(var(--rift-accent) / 0.1), rgb(var(--rift-surface2) / 0.65))`;
  } else if (isReconnecting) {
    cardBg = `rgb(var(--rift-surface2) / 0.42)`;
  } else {
    cardBg = `rgb(var(--rift-surface2) / 0.48)`;
  }

  return (
    <button
      onClick={() => setDevicePopup(device)}
      className="w-full text-left animate-slide-up"
      style={{
        background: cardBg,
        borderRadius: "16px",
        padding: "10px 12px",
        boxShadow: cardShadow,
        backdropFilter: "blur(20px)",
        transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLButtonElement).style.background =
            `rgb(var(--rift-surface2) / 0.7)`;
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLButtonElement).style.background = cardBg;
        }
      }}
    >
      <div className="flex items-center gap-2.5">
        {/* OS tag */}
        <span
          className="flex-shrink-0 text-[9px] font-mono font-bold tracking-[0.15em] rounded-lg px-1.5 py-1 leading-none"
          style={{
            color: osMeta.color,
            background: `${osMeta.color.replace("rgb(", "rgba(").replace(")", ", 0.12)")}`.replace("0.8", "0.12"),
            boxShadow: `0 0 0 1px ${osMeta.color.replace("/ 0.8", "/ 0.2")}`,
          }}
        >
          {osMeta.label}
        </span>

        {/* Name + IP */}
        <div className="flex-1 min-w-0">
          <p
            className="text-xs font-semibold truncate leading-tight"
            style={{
              color: isSelected
                ? "rgb(var(--rift-accent))"
                : isReconnecting
                ? "rgb(var(--rift-warning) / 0.85)"
                : "rgb(var(--rift-text))",
            }}
          >
            {device.name}
          </p>
          <p
            className="text-[10px] font-mono mt-0.5 truncate"
            style={{ color: "rgb(var(--rift-muted) / 0.6)" }}
          >
            {device.ip}
          </p>
        </div>

        {/* Right column: status + latency */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {/* Status dot / glow */}
          {isRifted ? (
            <span className="status-dot-live" />
          ) : isReconnecting ? (
            <span className="status-dot-wait" />
          ) : (
            <span className="status-dot-offline" />
          )}

          {/* Latency badge */}
          {device.latencyMs !== null && (
            <span
              className="text-[9px] font-mono rounded-full px-1.5 py-0.5 leading-none"
              style={{
                color: device.latencyMs < 20
                  ? "rgb(var(--rift-success))"
                  : device.latencyMs < 60
                  ? "rgb(var(--rift-warning))"
                  : "rgb(var(--rift-error))",
                background: device.latencyMs < 20
                  ? "rgb(var(--rift-success) / 0.1)"
                  : device.latencyMs < 60
                  ? "rgb(var(--rift-warning) / 0.1)"
                  : "rgb(var(--rift-error) / 0.1)",
                boxShadow: `0 0 0 1px ${
                  device.latencyMs < 20
                    ? "rgb(var(--rift-success) / 0.2)"
                    : device.latencyMs < 60
                    ? "rgb(var(--rift-warning) / 0.2)"
                    : "rgb(var(--rift-error) / 0.2)"
                }`,
              }}
            >
              {device.latencyMs}ms
            </span>
          )}
        </div>
      </div>

      {/* Reconnecting label */}
      {isReconnecting && (
        <p
          className="text-[9px] font-mono mt-1.5 tracking-wide"
          style={{ color: "rgb(var(--rift-warning) / 0.55)" }}
        >
          reconnecting…
        </p>
      )}
    </button>
  );
}