import { useRiftStore } from "@/store/riftStore";

export function OwnDeviceCard() {
  const ownDeviceName = useRiftStore((s) => s.ownDeviceName);
  const networkStatus = useRiftStore((s) => s.networkStatus);
  const devices       = useRiftStore((s) => s.devices);

  const statusColor = {
    connected: "rgb(var(--rift-success))",
    hotspot:   "rgb(var(--rift-accent))",
    searching: "rgb(var(--rift-warning))",
    offline:   "rgb(var(--rift-error))",
  }[networkStatus] ?? "rgb(var(--rift-warning))";

  const statusLabel = {
    connected: "Connected",
    hotspot:   "Hotspot",
    searching: "Scanning",
    offline:   "Offline",
  }[networkStatus] ?? "Scanning";

  return (
    <div
      className="mx-4 mt-4 mb-3 rounded-3xl p-4 relative overflow-hidden"
      style={{
        background: "linear-gradient(145deg, rgb(var(--rift-accent) / 0.09) 0%, rgb(var(--rift-surface2) / 0.5) 100%)",
        boxShadow: "0 2px 20px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--rift-accent) / 0.14), inset 0 1px 0 rgb(255 255 255 / 0.07)",
        backdropFilter: "blur(24px)",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute", top: 0, left: 0,
          width: "55%", height: "100%",
          background: "radial-gradient(ellipse at 0% 50%, rgb(var(--rift-accent) / 0.12) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div className="relative">
        <p
          className="text-[8px] font-mono uppercase tracking-[0.3em] mb-1.5"
          style={{ color: "rgb(var(--rift-accent) / 0.6)" }}
        >
          This Device
        </p>
        <p
          className="text-lg font-black font-mono tracking-tight leading-none"
          style={{ color: "rgb(var(--rift-text))" }}
        >
          {ownDeviceName}
        </p>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: statusColor, boxShadow: `0 0 7px ${statusColor}` }}
          />
          <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
            {statusLabel}
          </span>
          {devices.length > 0 && (
            <>
              <span style={{ color: "rgb(var(--rift-muted) / 0.28)", fontSize: 8 }}>·</span>
              <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
                {devices.length} {devices.length === 1 ? "device" : "devices"} nearby
              </span>
            </>
          )}
        </div>
        <p
          className="text-[9px] font-mono mt-2 leading-snug"
          style={{ color: "rgb(var(--rift-muted) / 0.38)" }}
        >
          This name appears on other devices when they scan for you
        </p>
      </div>
    </div>
  );
}