import { useRiftStore } from "@/store/riftStore";

const STATUS_META = {
  searching: { label: "Scanning",  dotClass: "status-dot-wait",    textClass: "text-rift-warning" },
  connected: { label: "Connected", dotClass: "status-dot-live",    textClass: "text-rift-success" },
  hotspot:   { label: "Hotspot",   dotClass: "status-dot-live",    textClass: "text-rift-accent"  },
  offline:   { label: "Offline",   dotClass: "status-dot-offline", textClass: "text-rift-error"   },
};

export function StatusBar() {
  const ownDeviceName      = useRiftStore((s) => s.ownDeviceName);
  const networkStatus      = useRiftStore((s) => s.networkStatus);
  const devicesCount       = useRiftStore((s) => s.devices.length);
  const setThemePickerOpen = useRiftStore((s) => s.setThemePickerOpen);
  const themePickerOpen    = useRiftStore((s) => s.themePickerOpen);
  const setHotspotOpen     = useRiftStore((s) => s.setHotspotPanelOpen);
  const hotspotPanelOpen   = useRiftStore((s) => s.hotspotPanelOpen);
  const hotspotRole        = useRiftStore((s) => s.hotspotRole);

  const meta = STATUS_META[networkStatus];

  return (
    <div
      className="glass-heavy flex items-center gap-3 px-5 py-2"
      style={{
        borderRadius: "9999px",
        maxWidth: "680px",
        width: "100%",
      }}
    >
      {/* Status */}
      <div className="flex items-center gap-2">
        <span className={meta.dotClass} />
        <span className={`text-[11px] font-mono font-semibold ${meta.textClass}`}>
          {meta.label}
        </span>
      </div>

      {/* Separator dot */}
      <span
        className="w-1 h-1 rounded-full flex-shrink-0"
        style={{ background: "rgb(var(--rift-muted) / 0.3)" }}
      />

      {/* Device name */}
      <span className="text-[11px] font-mono text-rift-muted/70 tracking-wide flex-shrink-0">
        {ownDeviceName}
      </span>

      {/* Flex spacer */}
      <div className="flex-1" />

      {/* Device count */}
      <span className="text-[11px] font-mono text-rift-muted/60">
        {devicesCount} {devicesCount === 1 ? "device" : "devices"}
      </span>

      <span
        className="w-px h-3 flex-shrink-0"
        style={{ background: "rgb(var(--rift-muted) / 0.15)" }}
      />

      {/* Hotspot button */}
      <button
        onClick={() => setHotspotOpen(!hotspotPanelOpen)}
        className="text-[10px] font-mono tracking-[0.14em] px-2.5 py-1 rounded-full transition-all duration-150"
        style={{
          background: hotspotPanelOpen || hotspotRole !== "none"
            ? "rgb(var(--rift-accent) / 0.12)"
            : "transparent",
          color: hotspotPanelOpen || hotspotRole !== "none"
            ? "rgb(var(--rift-accent))"
            : "rgb(var(--rift-muted) / 0.7)",
          boxShadow: hotspotPanelOpen || hotspotRole !== "none"
            ? "0 0 0 1px rgb(var(--rift-accent) / 0.25)"
            : "none",
        }}
        title="Hotspot"
      >
        {hotspotRole === "host" ? "HOST" : hotspotRole === "guest" ? "GUEST" : "HOTSPOT"}
      </button>

      <span
        className="w-px h-3 flex-shrink-0"
        style={{ background: "rgb(var(--rift-muted) / 0.15)" }}
      />

      {/* Theme button */}
      <button
        onClick={() => setThemePickerOpen(!themePickerOpen)}
        className="text-[10px] font-mono tracking-[0.14em] px-2.5 py-1 rounded-full transition-all duration-150"
        style={{
          background: themePickerOpen
            ? "rgb(var(--rift-accent) / 0.12)"
            : "transparent",
          color: themePickerOpen
            ? "rgb(var(--rift-accent))"
            : "rgb(var(--rift-muted) / 0.7)",
          boxShadow: themePickerOpen
            ? "0 0 0 1px rgb(var(--rift-accent) / 0.25)"
            : "none",
        }}
        title="Change theme"
      >
        THEME
      </button>
    </div>
  );
}