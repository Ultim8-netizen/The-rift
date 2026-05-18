import { useRiftStore } from "@/store/riftStore";

const STATUS_META = {
  searching: { label: "Scanning",   dot: "bg-rift-warning animate-pulse", text: "text-rift-warning" },
  connected: { label: "Connected",  dot: "bg-rift-success",               text: "text-rift-success" },
  hotspot:   { label: "Hotspot",    dot: "bg-rift-accent animate-pulse",  text: "text-rift-accent"  },
  offline:   { label: "Offline",    dot: "bg-rift-error",                 text: "text-rift-error"   },
};

export function StatusBar() {
  const ownDeviceName     = useRiftStore((s) => s.ownDeviceName);
  const networkStatus     = useRiftStore((s) => s.networkStatus);
  const devicesCount      = useRiftStore((s) => s.devices.length);
  const setThemePickerOpen = useRiftStore((s) => s.setThemePickerOpen);
  const themePickerOpen   = useRiftStore((s) => s.themePickerOpen);

  const meta = STATUS_META[networkStatus];

  return (
    <div className="relative z-10 h-10 glass border-t border-rift-border/40 flex items-center px-4 select-none">
      {/* Left: status */}
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
        <span className={`text-[11px] font-mono ${meta.text}`}>{meta.label}</span>
      </div>

      {/* Center: device name */}
      <div className="flex-1 flex justify-center">
        <span className="text-[11px] font-mono text-rift-muted/70 tracking-wide">
          {ownDeviceName}
        </span>
      </div>

      {/* Right: device count + theme picker */}
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-mono text-rift-muted">
          {devicesCount} {devicesCount === 1 ? "device" : "devices"} in range
        </span>
        <span className="w-px h-3 bg-rift-border/60" />
        <button
          onClick={() => setThemePickerOpen(!themePickerOpen)}
          className={`
            text-[11px] font-mono tracking-widest transition-colors px-1 rounded
            ${themePickerOpen ? "text-rift-accent" : "text-rift-muted hover:text-rift-text"}
          `}
          title="Change theme"
        >
          THEME
        </button>
        <span className="text-[11px] font-mono text-rift-muted/30 tracking-widest">
          RIFT
        </span>
      </div>
    </div>
  );
}