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
  const setHelpPageOpen    = useRiftStore((s) => s.setHelpPageOpen);

  const meta = STATUS_META[networkStatus];

  return (
    <div
      data-tour="status-bar"
      className="glass-heavy flex items-center gap-3 px-5 py-2"
      style={{
        borderRadius: "9999px",
        maxWidth: "720px",
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

      <span
        className="w-1 h-1 rounded-full flex-shrink-0"
        style={{ background: "rgb(var(--rift-muted) / 0.3)" }}
      />

      {/* Device name */}
      <span className="text-[11px] font-mono text-rift-muted/70 tracking-wide flex-shrink-0">
        {ownDeviceName}
      </span>

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
          background:
            hotspotPanelOpen || hotspotRole !== "none"
              ? "rgb(var(--rift-accent) / 0.12)"
              : "transparent",
          color:
            hotspotPanelOpen || hotspotRole !== "none"
              ? "rgb(var(--rift-accent))"
              : "rgb(var(--rift-muted) / 0.7)",
          boxShadow:
            hotspotPanelOpen || hotspotRole !== "none"
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

      <span
        className="w-px h-3 flex-shrink-0"
        style={{ background: "rgb(var(--rift-muted) / 0.15)" }}
      />

      {/* Help button */}
      <button
        onClick={() => setHelpPageOpen(true)}
        className="w-6 h-6 flex items-center justify-center rounded-full text-[11px] font-mono font-bold transition-all duration-150 flex-shrink-0"
        style={{
          color: "rgb(var(--rift-muted) / 0.55)",
          background: "rgb(var(--rift-surface2) / 0.5)",
          boxShadow: "0 0 0 1px rgb(255 255 255 / 0.05)",
        }}
        title="Help"
        onMouseEnter={(e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.style.color = "rgb(var(--rift-accent))";
          b.style.boxShadow =
            "0 0 0 1px rgb(var(--rift-accent) / 0.3), 0 0 10px rgb(var(--rift-glow) / 0.2)";
        }}
        onMouseLeave={(e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.style.color = "rgb(var(--rift-muted) / 0.55)";
          b.style.boxShadow = "0 0 0 1px rgb(255 255 255 / 0.05)";
        }}
      >
        ?
      </button>
    </div>
  );
}