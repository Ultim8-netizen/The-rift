// src/components/HelpPage.tsx

import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";

interface HelpSection {
  icon: string;
  title: string;
  paras: string[];
  tips?: string[];
  subsections?: { title: string; steps: string[] }[];
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
    title: "How to Connect Two Devices",
    paras: [
      "There are two ways to connect devices. The easiest and most reliable is Hotspot Mode, which is covered in detail further down this guide. The other way is to join the same Wi-Fi network — both devices connect to the same router, open The Rift, and they find each other automatically within a few seconds.",
      "If both devices already share the same Wi-Fi, you do not need to do anything extra. Just open The Rift on both and wait for the device to appear in the left panel.",
    ],
    tips: [
      "If a device does not appear after 10 seconds, tap the ↻ button at the top of the device list to force a fresh scan.",
      "A green dot next to a device means a live connection is confirmed. An amber dot means The Rift can see the device but the connection is still being established.",
    ],
  },
  {
    icon: "⌘",
    title: "Hotspot Mode — Connecting Without a Router",
    paras: [
      "Hotspot Mode is the recommended way to connect two devices when there is no shared Wi-Fi router available, for example in a hotel room, on a train, outdoors, or when you are not sure if both devices are on the same network.",
      "One device creates a private Wi-Fi hotspot. The other device joins that hotspot. Both devices then run The Rift and find each other automatically. No internet is required at any point.",
      "There are two roles: the Host device creates the hotspot, and the Guest device joins it. Decide which device will be the Host before you start.",
    ],
    subsections: [
      {
        title: "On the Host device (the one creating the hotspot)",
        steps: [
          "Open The Rift and click the HOTSPOT button in the bottom status bar.",
          "Make sure the Create tab is selected, then click Create Hotspot.",
          "The Rift will display a Network Name (called an SSID) and a Password. Leave this screen open. You will share these with the other device in the next step.",
          "If you see an error message, read the note below about Windows administrator mode.",
        ],
      },
      {
        title: "On the Guest device (the one joining the hotspot)",
        steps: [
          "Open your device Wi-Fi settings. On Windows this is in the system tray at the bottom right. On Android this is in Settings, then Wi-Fi or Network.",
          "Find the network name shown on the Host device and connect to it using the password shown on the Host device.",
          "Once connected to the Wi-Fi, open The Rift.",
          "In The Rift, click HOTSPOT in the status bar, select the Join tab, type in the exact Network Name and Password shown on the Host device, and click Join Hotspot.",
          "The Rift will confirm the connection and begin scanning. The Host device should appear in the device list within a few seconds.",
        ],
      },
    ],
    tips: [
      "Windows only: creating a hotspot requires The Rift to run as Administrator. Right-click the app icon and choose Run as Administrator, then try again. If you cannot do this, enable Mobile Hotspot manually in Windows Settings under Network and Internet, then open The Rift and tap Detect Active Hotspot instead of Create Hotspot.",
      "The guest device must connect to the hotspot in Wi-Fi settings first, before opening The Rift or clicking Join. The order matters.",
      "Once both devices are connected and The Rift is open on both, file transfer works exactly the same as over a normal Wi-Fi network. Select the device, stage your files, and press Send Through.",
      "To stop, click HOTSPOT on the Host device and click Stop Hotspot. The guest device will automatically lose the connection.",
    ],
  },
  {
    icon: "▣",
    title: "Selecting a Device",
    paras: [
      "Click any device card once to select it as your transfer target. The label below the portal updates to show which device you are sending to.",
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
      "If the connection drops mid-transfer, the protocol resumes from the last verified chunk on reconnect. No data is retransmitted unnecessarily.",
    ],
    tips: [
      "Received files land in the recipient's Downloads folder automatically.",
      "The Transfer Queue on the right shows live progress, speed, and estimated time remaining.",
    ],
  },
  {
    icon: "✎",
    title: "Sending Text",
    paras: [
      "Click the sticky-note icon next to the Send Through button to open the Quick Note panel. Type or paste text, then click Send.",
      "The recipient sees the text in a popup and can copy it to their clipboard with one click. No file is created.",
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
      "When another device sends files, an accept or decline dialog appears over the app. Accepting starts the download immediately to your Downloads folder.",
      "Received text appears in its own popup with a single-click copy button.",
    ],
  },
  {
    icon: "⧖",
    title: "Transfer Queue",
    paras: [
      "The right panel lists all transfers in the current session. TX badges are outgoing, RX badges are incoming.",
    ],
    tips: [
      "QUEUE: waiting for acceptance. CONN: establishing the connection. LIVE: actively transferring. DONE: verified and complete. ERR: failed. DENY: declined by the recipient.",
    ],
  },
  {
    icon: "◑",
    title: "Themes",
    paras: [
      "Click THEME in the status bar to switch colour schemes. Dark options: Void, Abyss, Slate, Cosmos. Light options: Rose, Citrus, Sky. Auto follows your OS preference.",
    ],
  },
  {
    icon: "◐",
    title: "Privacy",
    paras: [
      "The Rift does not require an internet connection and transmits no data to any external server. All discovery traffic and file data stays entirely within your local network.",
      "No telemetry, no analytics, no advertisements, no accounts.",
    ],
  },
];

function SubsectionBlock({ sub }: { sub: { title: string; steps: string[] } }) {
  return (
    <div
      className="mt-3 rounded-xl overflow-hidden"
      style={{
        background: "rgb(var(--rift-bg) / 0.35)",
        boxShadow: "inset 0 1px 6px rgb(0 0 0 / 0.2)",
      }}
    >
      <div
        className="px-3 py-2"
        style={{
          background: "rgb(var(--rift-accent) / 0.07)",
          borderBottom: "1px solid rgb(var(--rift-accent) / 0.08)",
        }}
      >
        <p
          className="text-[10px] font-mono font-bold uppercase tracking-[0.18em]"
          style={{ color: "rgb(var(--rift-accent) / 0.8)" }}
        >
          {sub.title}
        </p>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">
        {sub.steps.map((step, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span
              className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-mono font-bold mt-0.5"
              style={{
                background: "rgb(var(--rift-accent) / 0.15)",
                color: "rgb(var(--rift-accent))",
                boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)",
              }}
            >
              {i + 1}
            </span>
            <p
              className="text-[11px] leading-relaxed flex-1"
              style={{ color: "rgb(var(--rift-muted) / 0.82)" }}
            >
              {step}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

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

      {section.subsections && section.subsections.map((sub, i) => (
        <SubsectionBlock key={i} sub={sub} />
      ))}

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
        <div
          style={{
            height: 3,
            flexShrink: 0,
            background:
              "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
            boxShadow: "0 0 24px rgb(var(--rift-glow) / 0.45)",
          }}
        />

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

        <div
          className="mx-7 flex-shrink-0"
          style={{
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.12), transparent)",
          }}
        />

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