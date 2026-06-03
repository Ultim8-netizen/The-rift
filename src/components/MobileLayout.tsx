// src/components/MobileLayout.tsx
import { useRef, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { AcceptDialog } from "./AcceptDialog";
import { IncomingTextDialog } from "./IncomingTextDialog";
import { DevicePopup } from "./DevicePopup";
import { MobileThemePicker } from "./mobile/MobileThemePicker";
import { MobileDevicesPanel } from "./mobile/MobileDevicesPanel";
import { MobileSendPanel } from "./mobile/MobileSendPanel";
import { MobileTransfersPanel } from "./mobile/MobileTransfersPanel";
import { TAB_ORDER, type Tab } from "@/utils/tabTypes";
import { MobileTabBar } from "./mobile/MobileTabBar";
import { ContactPanel } from "./ContactPanel";

export function MobileLayout() {
  const [tab,          setTab]          = useState<Tab>("send");
  const [themeOpen,    setThemeOpen]    = useState(false);
  const [contactOpen,  setContactOpen]  = useState(false);

  const tabIndex    = TAB_ORDER.indexOf(tab);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  const ownDeviceName  = useRiftStore((s) => s.ownDeviceName);
  const networkStatus  = useRiftStore((s) => s.networkStatus);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);

  const statusDotColor = {
    connected: "rgb(var(--rift-success))",
    hotspot:   "rgb(var(--rift-accent))",
    searching: "rgb(var(--rift-warning))",
    offline:   "rgb(var(--rift-error))",
  }[networkStatus] ?? "rgb(var(--rift-warning))";

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const dx  = e.changedTouches[0].clientX - touchStartX.current;
    const adx = Math.abs(dx);
    const ady = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    if (adx < 52 || adx < ady * 1.2) return;
    if (dx < 0 && tabIndex < 2) setTab(TAB_ORDER[tabIndex + 1]);
    else if (dx > 0 && tabIndex > 0) setTab(TAB_ORDER[tabIndex - 1]);
  }

  return (
    <div
      className="flex flex-col font-sans text-rift-text select-none overflow-hidden"
      style={{ height: "100dvh", background: "rgb(var(--rift-bg))", position: "relative" }}
    >
      {/* ── Ambient orbs ─────────────────────────────────────────────────── */}
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 0 }}>
        <div className="ambient-orb animate-orb-drift-a" style={{
          width: "110vw", height: "110vw", top: "-35%", left: "-30%",
          background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.075) 0%, transparent 68%)",
        }} />
        <div className="ambient-orb animate-orb-drift-b" style={{
          width: "90vw", height: "90vw", bottom: "-25%", right: "-20%",
          background: "radial-gradient(ellipse at center, rgb(var(--rift-accent2) / 0.06) 0%, transparent 68%)",
        }} />
        <div className="ambient-orb animate-orb-drift-c" style={{
          width: "70vw", height: "70vw", top: "38%", left: "25%",
          background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.032) 0%, transparent 70%)",
        }} />
      </div>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          position:       "relative",
          zIndex:         10,
          flexShrink:     0,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          padding:        "16px 20px 20px",
          background:     "rgb(var(--rift-surface) / 0.9)",
          backdropFilter: "blur(52px) saturate(190%)",
        }}
      >
        <div>
          {/* ── "The Rift" — cursive, bold, italic, gradient ── */}
          <h1
            style={{
              fontFamily:           "'Segoe Script', 'Apple Chancery', 'Brush Script MT', cursive",
              fontWeight:           700,
              fontStyle:            "italic",
              fontSize:             "2rem",
              lineHeight:           1,
              letterSpacing:        "0.02em",
              background:           "linear-gradient(118deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor:  "transparent",
              backgroundClip:       "text",
              filter:               "drop-shadow(0 0 18px rgb(var(--rift-glow) / 0.45))",
            }}
          >
            The Rift
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: statusDotColor, boxShadow: `0 0 6px ${statusDotColor}` }}
            />
            <p
              className="font-mono"
              style={{ fontSize: "9px", letterSpacing: "0.24em", color: "rgb(var(--rift-muted) / 0.5)", textTransform: "uppercase" }}
            >
              {ownDeviceName}
            </p>
            <span style={{ color: "rgb(var(--rift-muted) / 0.2)", fontSize: 9 }}>·</span>
            <p
              className="font-mono"
              style={{ fontSize: "8px", letterSpacing: "0.2em", color: "rgb(var(--rift-muted) / 0.32)", textTransform: "lowercase" }}
            >
              by abyssprotocol
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedDevice && (
            <span
              className="text-[10px] font-mono px-2.5 py-1.5 rounded-full"
              style={{
                color:        "rgb(var(--rift-accent))",
                background:   "rgb(var(--rift-accent) / 0.1)",
                boxShadow:    "0 0 0 1px rgb(var(--rift-accent) / 0.22)",
                maxWidth:     "110px",
                overflow:     "hidden",
                textOverflow: "ellipsis",
                whiteSpace:   "nowrap",
              }}
            >
              → {selectedDevice.name}
            </span>
          )}

          {/* Contact button */}
          <button
            onClick={() => setContactOpen(true)}
            title="Contact us"
            className="w-9 h-9 flex items-center justify-center rounded-2xl transition-all"
            style={{
              background: "rgb(var(--rift-surface2) / 0.65)",
              boxShadow:  "0 0 0 1px rgb(255 255 255 / 0.07), 0 2px 10px rgb(0 0 0 / 0.28)",
              color:      "rgb(var(--rift-muted) / 0.65)",
            }}
          >
            {/* Envelope icon */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="3" width="14" height="10" rx="2"/>
              <path d="M1 5l7 5 7-5"/>
            </svg>
          </button>

          {/* Theme button */}
          <button
            onClick={() => setThemeOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-2xl transition-all"
            style={{
              background: "rgb(var(--rift-surface2) / 0.65)",
              boxShadow:  "0 0 0 1px rgb(255 255 255 / 0.07), 0 2px 10px rgb(0 0 0 / 0.28)",
              color:      "rgb(var(--rift-muted) / 0.65)",
              fontSize:   "16px",
            }}
          >
            ◑
          </button>
        </div>

        {/* Bottom bleed */}
        <div
          aria-hidden
          style={{
            position:      "absolute",
            bottom:        -28,
            left:          0,
            right:         0,
            height:        28,
            background:    "linear-gradient(180deg, rgb(var(--rift-surface) / 0.35) 0%, transparent 100%)",
            pointerEvents: "none",
            zIndex:        20,
          }}
        />
      </header>

      {/* ── 3-panel slider ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative", zIndex: 1 }}>
        <div
          style={{
            display:    "flex",
            width:      "300vw",
            height:     "100%",
            transform:  `translateX(${-tabIndex * 100}vw)`,
            transition: "transform 0.34s cubic-bezier(0.16, 1, 0.3, 1)",
            willChange: "transform",
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <MobileDevicesPanel />
          <MobileSendPanel />
          <MobileTransfersPanel />
        </div>

        {/* Bottom bleed: content melts into tab bar */}
        <div
          aria-hidden
          style={{
            position:      "absolute",
            bottom:        0,
            left:          0,
            right:         0,
            height:        36,
            pointerEvents: "none",
            background:    "linear-gradient(to top, rgb(var(--rift-bg)) 0%, transparent 100%)",
          }}
        />
      </div>

      <MobileTabBar tab={tab} setTab={setTab} />

      {/* ── Overlays ────────────────────────────────────────────────────────── */}
      <AcceptDialog />
      <IncomingTextDialog />
      <DevicePopup />
      {themeOpen  && <MobileThemePicker onClose={() => setThemeOpen(false)} />}
      {contactOpen && <ContactPanel onClose={() => setContactOpen(false)} />}
    </div>
  );
}