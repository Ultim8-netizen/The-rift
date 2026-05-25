import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";

interface HelpSection {
  icon: string;
  title: string;
  paras: string[];
  tips?: string[];
}

const SECTIONS: HelpSection[] = [
  {
    icon: "◈",
    title: "What is The Rift",
    paras: [
      "The Rift transfers files directly between devices on the same local network. No internet connection is required, no cloud storage is involved, and no account is needed.",
      "It works between any combination of Windows, macOS, Linux, and Android. Files travel device-to-device over a direct TCP connection, so transfer speed is limited only by your local network.",
    ],
  },
  {
    icon: "⊙",
    title: "Discovering Devices",
    paras: [
      "Open The Rift on both devices while connected to the same Wi-Fi network. Devices appear in the left panel automatically within a few seconds.",
      "Three discovery methods run simultaneously for maximum reliability: mDNS (multicast), UDP broadcast on port 7476, and an active subnet scan that probes every address in the local /24.",
    ],
    tips: [
      "The ↻ button at the top of the device list forces an immediate rescan at any time.",
      "A green dot next to a device card means a persistent TCP keep-alive channel is live. Amber means the device is still in state but temporarily unreachable.",
    ],
  },
  {
    icon: "▣",
    title: "Selecting a Device",
    paras: [
      "Click any device card once to select it as your transfer target. The label below the portal updates to 'Sending to X' immediately.",
      "Click the already-selected card again to open a detail popup showing the OS, IP address, port, and current latency. You can also deselect from there.",
    ],
    tips: [
      "You can select a device before or after staging files. Order does not matter.",
    ],
  },
  {
    icon: "↓",
    title: "Sending Files",
    paras: [
      "Drag files anywhere onto the window to stage them, or click the browse link under the portal to open a file picker. Any number of files, any size, any type.",
      "Once files are staged and a device is selected, press Send Through. The recipient sees an accept or decline dialog before any bytes transfer.",
      "If the connection drops mid-transfer, the dual-stream protocol resumes from the last verified chunk on reconnect. No data is retransmitted unnecessarily.",
    ],
    tips: [
      "Received files land in the recipient's Downloads folder automatically.",
      "The Transfer Queue on the right shows live progress, speed, and an estimated time remaining.",
    ],
  },
  {
    icon: "✎",
    title: "Sending Text",
    paras: [
      "Click the sticky-note icon next to the Send Through button to open the Quick Note panel. Type or paste text, then click Send.",
      "The recipient sees the text in a popup and can copy it to their clipboard with one click. No file is created and no file picker is needed.",
    ],
    tips: [
      "Ctrl+Enter (or Cmd+Enter on macOS) sends without reaching for the mouse.",
      "Click the PASTE button inside the panel to pull your clipboard contents in automatically.",
    ],
  },
  {
    icon: "↧",
    title: "Receiving Transfers",
    paras: [
      "When another device sends files, an accept or decline dialog appears over the app. Accepting starts the download immediately to your Downloads folder. Declining notifies the sender.",
      "Received text appears in its own popup with a single-click copy button. The sender is not notified when you read or copy it.",
    ],
  },
  {
    icon: "⧖",
    title: "Transfer Queue",
    paras: [
      "The right panel lists all transfers in the current session. TX badges are outgoing, RX badges are incoming. Transfers persist in the list until you restart the app.",
    ],
    tips: [
      "QUEUE: waiting for acceptance. CONN: establishing the TCP connection. LIVE: actively transferring. DONE: verified and complete. ERR: failed. DENY: declined by the recipient.",
      "If a transfer shows ERR, verify both devices are still on the same network and try again. Transfers resume from the last verified chunk.",
    ],
  },
  {
    icon: "⌘",
    title: "Hotspot Mode",
    paras: [
      "Use Hotspot Mode when there is no shared Wi-Fi router, such as in a hotel room, on a plane, or outdoors. Click the HOTSPOT button in the status bar.",
      "Create tab: The Rift generates a Wi-Fi hotspot with a random SSID and password. Share those credentials with the other device. That device connects from its Wi-Fi settings and opens The Rift.",
      "Join tab: Enter the SSID and password displayed on the host device and The Rift connects automatically.",
    ],
    tips: [
      "On Windows, hotspot creation requires the app to run as Administrator.",
      "If automatic creation fails, enable Mobile Hotspot manually in Windows Settings (Network and Internet, then Mobile hotspot), then click Detect Active Hotspot inside The Rift.",
      "The host device's gateway IP is shown after creation. Devices connecting to the hotspot will be discovered automatically.",
    ],
  },
  {
    icon: "◑",
    title: "Themes",
    paras: [
      "Click THEME in the status bar to switch colour schemes. Dark options: Void, Abyss, Slate, Cosmos. Light options: Rose, Citrus, Sky. Auto follows your OS preference.",
      "Your selection is saved to local storage and restored on every launch.",
    ],
  },
  {
    icon: "◐",
    title: "Privacy",
    paras: [
      "The Rift does not require an internet connection and transmits no data to any external server. All discovery traffic and file data stays entirely within your local network.",
      "No telemetry, no analytics, no advertisements, no accounts. The only storage used is your own Downloads folder and a small local-storage key for your theme preference.",
    ],
  },
];

function SectionCard({ section }: { section: HelpSection }) {
  return (
    <div
      className="rounded-2xl p-5 mb-3"
      style={{
        background: "rgb(var(--rift-surface2) / 0.44)",
        boxShadow:
          "0 2px 8px rgb(0 0 0 / 0.2), 0 0 0 1px rgb(255 255 255 / 0.03), inset 0 1px 0 rgb(255 255 255 / 0.04)",
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <span
          className="text-sm font-mono font-bold w-7 h-7 flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            color: "rgb(var(--rift-accent))",
            background: "rgb(var(--rift-accent) / 0.09)",
            boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.16)",
          }}
        >
          {section.icon}
        </span>
        <h3 className="font-semibold text-sm text-rift-text">{section.title}</h3>
      </div>

      <div className="flex flex-col gap-2">
        {section.paras.map((p, i) => (
          <p
            key={i}
            className="text-[12px] leading-relaxed"
            style={{ color: "rgb(var(--rift-muted) / 0.82)" }}
          >
            {p}
          </p>
        ))}
      </div>

      {section.tips && section.tips.length > 0 && (
        <div
          className="mt-3 rounded-xl px-3 py-2.5 flex flex-col gap-2"
          style={{ background: "rgb(var(--rift-accent) / 0.04)" }}
        >
          {section.tips.map((tip, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span
                className="text-[8px] font-mono font-bold tracking-widest mt-0.5 flex-shrink-0 px-1.5 py-0.5 rounded"
                style={{
                  color: "rgb(var(--rift-accent) / 0.85)",
                  background: "rgb(var(--rift-accent) / 0.1)",
                }}
              >
                TIP
              </span>
              <p
                className="text-[11px] leading-relaxed"
                style={{ color: "rgb(var(--rift-muted) / 0.68)" }}
              >
                {tip}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HelpPage() {
  const open = useRiftStore((s) => s.helpPageOpen);
  const setOpen = useRiftStore((s) => s.setHelpPageOpen);
  const startTour = useRiftStore((s) => s.startTour);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, setOpen]);

  if (!open) return null;

  function handleRestartTour() {
    setOpen(false);
    setTimeout(() => startTour(), 220);
  }

  return (
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) setOpen(false);
      }}
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.65)", backdropFilter: "blur(24px)" }}
    >
      <div
        className="glass-heavy overflow-hidden flex flex-col animate-scale-in"
        style={{
          width: "min(680px, 92vw)",
          height: "min(800px, 88vh)",
          borderRadius: 28,
        }}
      >
        {/* Accent top bar */}
        <div
          style={{
            height: 3,
            flexShrink: 0,
            background:
              "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
            boxShadow: "0 0 24px rgb(var(--rift-glow) / 0.45)",
          }}
        />

        {/* Header */}
        <div
          className="flex items-center justify-between px-7 py-5 flex-shrink-0"
          style={{
            background:
              "linear-gradient(180deg, rgb(var(--rift-surface) / 0.55) 0%, transparent 100%)",
          }}
        >
          <div>
            <p
              className="text-[9px] font-mono uppercase tracking-[0.25em] mb-1"
              style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
            >
              Reference Guide
            </p>
            <h2
              className="font-black text-xl tracking-tight font-mono"
              style={{
                background:
                  "linear-gradient(125deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              The Rift
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRestartTour}
              className="px-3 py-1.5 btn-ghost text-[10px]"
            >
              Restart Tour
            </button>
            <button
              onClick={() => setOpen(false)}
              className="w-8 h-8 flex items-center justify-center rounded-full text-xs font-mono transition-all"
              style={{
                background: "rgb(var(--rift-surface2) / 0.5)",
                color: "rgb(var(--rift-muted) / 0.55)",
                boxShadow: "0 0 0 1px rgb(255 255 255 / 0.05)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  "rgb(var(--rift-text))";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  "rgb(var(--rift-muted) / 0.55)";
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Gradient separator */}
        <div
          className="mx-7 flex-shrink-0"
          style={{
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.12), transparent)",
          }}
        />

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-7 py-5">
          {SECTIONS.map((s) => (
            <SectionCard key={s.title} section={s} />
          ))}
          <p
            className="text-[10px] font-mono text-center pb-6 pt-3"
            style={{ color: "rgb(var(--rift-muted) / 0.25)" }}
          >
            by abyssprotocol
          </p>
        </div>
      </div>
    </div>
  );
}