import { useRiftStore } from "@/store/riftStore";
import { type Tab, TAB_ORDER } from "@/utils/tabTypes";

interface MobileTabBarProps {
  tab: Tab;
  setTab: (tab: Tab) => void;
}

export function MobileTabBar({ tab, setTab }: MobileTabBarProps) {
  const devices     = useRiftStore((s) => s.devices);
  const stagedFiles = useRiftStore((s) => s.stagedFiles);
  const transfers   = useRiftStore((s) => s.transfers);

  const tabIndex    = TAB_ORDER.indexOf(tab);
  const activeXfers = transfers.filter((t) => t.status === "transferring").length;

  const TABS: { id: Tab; icon: string; label: string; badge: number | null }[] = [
    { id: "devices",   icon: "◈", label: "Devices", badge: devices.length > 0 ? devices.length : null },
    { id: "send",      icon: "⤵", label: "Send",    badge: stagedFiles.length > 0 ? stagedFiles.length : null },
    { id: "transfers", icon: "↕", label: "History", badge: activeXfers > 0 ? activeXfers : null },
  ];

  return (
    <nav
      style={{
        flexShrink:     0,
        position:       "relative",
        zIndex:         10,
        background:     "rgb(var(--rift-surface) / 0.96)",
        backdropFilter: "blur(16px) saturate(190%)",
        paddingBottom:  "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div
        aria-hidden
        style={{
          position:      "absolute",
          top:           -28,
          left:          0,
          right:         0,
          height:        28,
          pointerEvents: "none",
          background:    "linear-gradient(to top, rgb(var(--rift-surface) / 0.65) 0%, transparent 100%)",
        }}
      />

      <div
        style={{
          position:     "absolute",
          top:          0,
          height:       2.5,
          width:        "calc(100% / 3)",
          borderRadius: "0 0 4px 4px",
          background:   "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
          transform:    `translateX(${tabIndex * 100}%)`,
          transition:   "transform 0.34s cubic-bezier(0.16, 1, 0.3, 1)",
          boxShadow:    "0 0 16px rgb(var(--rift-glow) / 0.8), 0 0 6px rgb(var(--rift-glow) / 0.5)",
        }}
      />

      <div className="flex">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex-1 relative flex flex-col items-center gap-1 py-3.5 transition-all duration-150"
            style={{ color: tab === t.id ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.38)" }}
          >
            <span
              style={{
                fontSize:   "1.1rem",
                lineHeight: 1,
                filter:     tab === t.id ? "drop-shadow(0 0 8px rgb(var(--rift-glow) / 0.7))" : "none",
                transition: "filter 0.22s ease",
              }}
            >
              {t.icon}
            </span>
            <span
              className="font-mono uppercase"
              style={{
                fontSize:      "8px",
                letterSpacing: "0.18em",
                fontWeight:    tab === t.id ? 700 : 400,
              }}
            >
              {t.label}
            </span>
            {t.badge !== null && (
              <span
                className="absolute top-2 right-[calc(50%-18px)] min-w-[16px] h-4 rounded-full text-[8px] font-mono font-bold flex items-center justify-center px-1"
                style={{
                  background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
                  color:      "rgb(var(--rift-bg))",
                  boxShadow:  "0 0 10px rgb(var(--rift-glow) / 0.55)",
                }}
              >
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}