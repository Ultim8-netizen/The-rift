import { useRiftStore } from "@/store/riftStore";

const OS_LABELS: Record<string, string> = {
  windows: "WIN", macos: "MAC", linux: "NIX", android: "AND", unknown: "SYS",
};
const OS_COLORS: Record<string, string> = {
  windows: "rgb(var(--rift-accent) / 0.9)",
  macos:   "rgb(var(--rift-accent2) / 0.9)",
  linux:   "rgb(var(--rift-success) / 0.9)",
  android: "rgb(var(--rift-warning) / 0.9)",
  unknown: "rgb(var(--rift-muted) / 0.65)",
};

export function MobileDeviceRow({ deviceId }: { deviceId: string }) {
  const device         = useRiftStore((s) => s.devices.find((d) => d.id === deviceId));
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const selectDevice   = useRiftStore((s) => s.selectDevice);
  const riftedDevices  = useRiftStore((s) => s.riftedDevices);
  const reconnecting   = useRiftStore((s) => s.reconnectingDevices);
  const setDevicePopup = useRiftStore((s) => s.setDevicePopup);

  if (!device) return null;

  const isSelected     = selectedDevice?.id === device.id;
  const isRifted       = riftedDevices.includes(device.id);
  const isReconnecting = reconnecting.includes(device.id);
  const osColor        = OS_COLORS[device.os] ?? OS_COLORS.unknown;

  function bgStyle() {
    if (isSelected)     return "linear-gradient(145deg, rgb(var(--rift-accent) / 0.11) 0%, rgb(var(--rift-surface2) / 0.65) 100%)";
    if (isReconnecting) return "rgb(var(--rift-surface2) / 0.42)";
    return "rgb(var(--rift-surface2) / 0.44)";
  }

  function shadowStyle() {
    if (isSelected)     return "0 4px 22px rgb(0 0 0 / 0.38), 0 0 0 1px rgb(var(--rift-accent) / 0.5), 0 0 44px rgb(var(--rift-glow) / 0.12), inset 0 1px 0 rgb(255 255 255 / 0.08)";
    if (isRifted)       return "0 2px 12px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--rift-success) / 0.22), inset 0 1px 0 rgb(255 255 255 / 0.05)";
    if (isReconnecting) return "0 2px 12px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--rift-warning) / 0.28), inset 0 1px 0 rgb(255 255 255 / 0.05)";
    return "0 2px 10px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)";
  }

  return (
    <button
      onClick={() => isSelected ? setDevicePopup(device) : selectDevice(device)}
      className="w-full text-left transition-all duration-200 active:scale-[0.98]"
      style={{
        background:     bgStyle(),
        borderRadius:   20,
        padding:        "12px 14px",
        backdropFilter: "blur(22px)",
        boxShadow:      shadowStyle(),
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="text-[10px] font-mono font-bold px-2 py-1.5 rounded-xl flex-shrink-0 leading-none"
          style={{
            color:      osColor,
            background: osColor.replace("0.9)", "0.1)"),
            boxShadow:  `0 0 0 1px ${osColor.replace("0.9)", "0.2)")}`,
          }}
        >
          {OS_LABELS[device.os] ?? "SYS"}
        </span>

        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-semibold truncate leading-tight"
            style={{
              color: isSelected     ? "rgb(var(--rift-accent))"
                   : isReconnecting ? "rgb(var(--rift-warning) / 0.85)"
                   : "rgb(var(--rift-text))",
            }}
          >
            {device.name}
          </p>
          <p
            className="text-[10px] font-mono mt-0.5 truncate"
            style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
          >
            {device.ip}
            {device.latencyMs !== null && (
              <span style={{
                color: device.latencyMs < 20  ? "rgb(var(--rift-success) / 0.85)"
                     : device.latencyMs < 60  ? "rgb(var(--rift-warning) / 0.85)"
                     : "rgb(var(--rift-error) / 0.85)",
              }}>
                {" "}· {device.latencyMs}ms
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {isRifted       ? <span className="status-dot-live" />
           : isReconnecting ? <span className="status-dot-wait" />
           : <span className="status-dot-offline" />}
          {isSelected && (
            <span className="text-[9px] font-mono font-bold" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
              SELECTED
            </span>
          )}
          {isReconnecting && !isSelected && (
            <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-warning) / 0.55)" }}>…</span>
          )}
        </div>
      </div>

      {isSelected && (
        <p
          className="text-[9px] font-mono mt-1.5 tracking-wide"
          style={{ color: "rgb(var(--rift-accent) / 0.55)" }}
        >
          tap again for details
        </p>
      )}
    </button>
  );
}