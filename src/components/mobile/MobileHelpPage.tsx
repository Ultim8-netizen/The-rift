// src/components/mobile/MobileHelpPage.tsx
import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";

interface Props {
  onClose: () => void;
}

interface Section {
  icon:        string;
  title:       string;
  paras:       string[];
  tips?:       string[];
  subsections?: { title: string; steps: string[] }[];
}

const SECTIONS: Section[] = [
  {
    icon:  "◈",
    title: "What is The Rift",
    paras: [
      "The Rift transfers files directly between devices on the same local network. No internet connection is required, no cloud storage is involved, and no account is ever needed.",
      "It works between any combination of Windows, macOS, Linux, and Android. Files travel device-to-device over a direct TCP connection — speed is limited only by your local network.",
    ],
  },
  {
    icon:  "⊙",
    title: "Navigating the App",
    paras: [
      "The Rift on mobile is organised into three tabs at the bottom: Devices, Send, and History. You can tap a tab or swipe left and right to switch between them.",
    ],
    tips: [
      "Devices: lists every device running The Rift on the same network. Tap one to select it as your transfer target.",
      "Send: stage files or type a text snippet, then send to the selected device.",
      "History: tracks every transfer this session with live progress, speed, and status badges.",
    ],
  },
  {
    icon:  "⊕",
    title: "Connecting Two Devices",
    paras: [
      "The easiest way is to join the same Wi-Fi router — both devices open The Rift and find each other automatically within a few seconds.",
      "If no shared router is available (hotel room, outdoors, no Wi-Fi), use Hotspot Mode. One device creates a private Wi-Fi hotspot and the other joins it. Both then open The Rift and see each other normally.",
    ],
    tips: [
      "If a device does not appear after 10 seconds, tap the ↻ Rescan button at the top of the Devices tab.",
      "A green dot means a live connection is confirmed. An amber dot means The Rift sees the device but the channel is still opening.",
    ],
  },
  {
    icon:  "⌘",
    title: "Hotspot Mode — No Router Needed",
    paras: [
      "Hotspot Mode lets one device create its own private Wi-Fi that the other device joins. No internet is needed at any point.",
    ],
    subsections: [
      {
        title: "On the Host device (creates the hotspot)",
        steps: [
          "Open Wi-Fi or Hotspot settings and create a personal hotspot. Note the network name and password.",
          "Open The Rift — it detects the hotspot automatically and begins scanning.",
          "Keep the screen on. The other device should appear in the Devices tab once it joins.",
        ],
      },
      {
        title: "On the Guest device (joins the hotspot)",
        steps: [
          "Open Wi-Fi settings and connect to the network name the host showed you, using the host's password.",
          "Open The Rift. The host device appears in the Devices tab within a few seconds.",
        ],
      },
    ],
    tips: [
      "On Android, personal hotspot is in Settings → Network & Internet → Hotspot & tethering.",
      "The guest must connect to the Wi-Fi first before opening The Rift. Order matters.",
      "Once both devices are on the same hotspot network, sending files works exactly the same as over a normal Wi-Fi router.",
    ],
  },
  {
    icon:  "▣",
    title: "Selecting a Device",
    paras: [
      "In the Devices tab, tap any device card once to select it as your transfer target. A pill in the top-right corner of the header confirms which device is selected.",
      "Tap the already-selected card again to open a detail popup showing OS, IP address, port, and current latency. You can deselect the device from there.",
    ],
    tips: [
      "You can select a device before or after staging files — order does not matter.",
    ],
  },
  {
    icon:  "↓",
    title: "Sending Files",
    paras: [
      "Switch to the Send tab and make sure Files mode is selected. Tap the large browse area to open the system file picker. Any file type and any size is accepted.",
      "Once a device is selected and files are staged, tap Send Through. The recipient sees an accept or decline dialog before any data transfers. Accepted files land in their Downloads folder automatically.",
    ],
    tips: [
      "Tap + Add to stage more files without clearing what is already there.",
      "Tap Clear to remove all staged files and start over.",
      "If you see a content URI error, it means the file picker returned a temporary URI that The Rift could not read directly. Try picking the file from the Downloads or Documents folder instead of from a recent-files shortcut.",
    ],
  },
  {
    icon:  "✎",
    title: "Sending Text",
    paras: [
      "In the Send tab, switch to Text mode. Type or paste a snippet, link, or note, then tap Send Text.",
      "The recipient sees the text in a pop-up with a single-tap copy button. No file is created on either device.",
    ],
    tips: [
      "Tap the Paste button inside the text area to pull your clipboard content in automatically.",
    ],
  },
  {
    icon:  "↧",
    title: "Receiving Transfers",
    paras: [
      "When another device sends files to you, an accept or decline dialog appears over the app. Tap Accept to start the download immediately. Files save to your Downloads folder.",
      "Received text appears in its own pop-up with a one-tap copy button.",
    ],
    tips: [
      "The dialog appears regardless of which tab you are on — you do not need to be in a specific screen to receive.",
    ],
  },
  {
    icon:  "⧖",
    title: "Transfer History",
    paras: [
      "The History tab lists all transfers in the current session. TX badges are outgoing, RX badges are incoming.",
    ],
    tips: [
      "QUEUE: waiting for the recipient to accept. LIVE: actively transferring. DONE: verified and saved. ERR: failed. DENY: declined by the recipient.",
      "Tap a transfer card to expand or collapse its file list and details.",
    ],
  },
  {
    icon:  "◑",
    title: "Themes",
    paras: [
      "Tap the ◑ button in the top-right corner to open the theme picker. Dark options: Void, Abyss, Slate, Cosmos. Light options: Rose, Citrus, Sky. Auto follows your system preference.",
    ],
  },
  {
    icon:  "◐",
    title: "Privacy",
    paras: [
      "The Rift does not require an internet connection and transmits no data to any external server. All discovery traffic and file data stays entirely within your local network.",
      "No telemetry, no analytics, no advertisements, no accounts.",
    ],
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SubsectionBlock({ sub }: { sub: { title: string; steps: string[] } }) {
  return (
    <div
      className="mt-3 rounded-2xl overflow-hidden"
      style={{
        background: "rgb(var(--rift-bg) / 0.35)",
        boxShadow:  "inset 0 1px 6px rgb(0 0 0 / 0.2)",
      }}
    >
      <div
        className="px-3 py-2.5"
        style={{
          background:   "rgb(var(--rift-accent) / 0.07)",
          borderBottom: "1px solid rgb(var(--rift-accent) / 0.08)",
        }}
      >
        <p
          className="text-[10px] font-mono font-bold uppercase tracking-[0.16em]"
          style={{ color: "rgb(var(--rift-accent) / 0.8)" }}
        >
          {sub.title}
        </p>
      </div>
      <div className="px-3 py-2.5 flex flex-col gap-2.5">
        {sub.steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3">
            <span
              className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-mono font-bold mt-0.5"
              style={{
                background: "rgb(var(--rift-accent) / 0.15)",
                color:      "rgb(var(--rift-accent))",
                boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.2)",
              }}
            >
              {i + 1}
            </span>
            <p
              className="text-[12px] leading-relaxed flex-1"
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

function SectionCard({ section }: { section: Section }) {
  return (
    <div
      className="rounded-2xl p-4 mb-3"
      style={{
        background: "rgb(var(--rift-surface2) / 0.44)",
        boxShadow:
          "0 2px 8px rgb(0 0 0 / 0.2), 0 0 0 1px rgb(255 255 255 / 0.03), inset 0 1px 0 rgb(255 255 255 / 0.04)",
      }}
    >
      {/* Section header */}
      <div className="flex items-center gap-3 mb-3">
        <span
          className="text-sm font-mono font-bold w-8 h-8 flex items-center justify-center rounded-xl flex-shrink-0"
          style={{
            color:      "rgb(var(--rift-accent))",
            background: "rgb(var(--rift-accent) / 0.09)",
            boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.16)",
          }}
        >
          {section.icon}
        </span>
        <h3 className="font-semibold text-sm text-rift-text flex-1">{section.title}</h3>
      </div>

      {/* Body paragraphs */}
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

      {/* Subsections */}
      {section.subsections?.map((sub, i) => (
        <SubsectionBlock key={i} sub={sub} />
      ))}

      {/* Tips */}
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
                  color:      "rgb(var(--rift-accent) / 0.85)",
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

// ─── Main component ───────────────────────────────────────────────────────────

export function MobileHelpPage({ onClose }: Props) {
  const startTour  = useRiftStore((s) => s.startTour);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Back-swipe / hardware back on Android — Escape on desktop emulator
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  function handleRestartTour() {
    onClose();
    // Short delay so the help page finishes closing before the tour card appears
    setTimeout(() => startTour(), 240);
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex flex-col animate-fade-in"
      style={{
        background:     "rgb(var(--rift-bg))",
        paddingBottom:  "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {/* ── Sticky header ── */}
      <div
        className="flex-shrink-0"
        style={{
          background:    "rgb(var(--rift-surface) / 0.96)",
          backdropFilter:"blur(52px) saturate(190%)",
          position:      "relative",
          zIndex:        2,
        }}
      >
        {/* Accent bar */}
        <div
          style={{
            height:     3,
            background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
            boxShadow:  "0 0 24px rgb(var(--rift-glow) / 0.45)",
          }}
        />

        <div
          className="flex items-center justify-between px-5 py-4"
        >
          <div>
            <p
              className="text-[9px] font-mono uppercase tracking-[0.25em] mb-1"
              style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
            >
              Reference Guide
            </p>
            <h2
              className="font-black text-lg tracking-tight font-mono"
              style={{
                background:           "linear-gradient(125deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor:  "transparent",
                backgroundClip:       "text",
              }}
            >
              The Rift
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRestartTour}
              className="px-3 py-2 btn-ghost text-[10px]"
            >
              Restart Tour
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 flex items-center justify-center rounded-full text-xs font-mono transition-all"
              style={{
                background: "rgb(var(--rift-surface2) / 0.65)",
                color:      "rgb(var(--rift-muted) / 0.55)",
                boxShadow:  "0 0 0 1px rgb(255 255 255 / 0.06)",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Header bottom divider */}
        <div
          style={{
            height:     1,
            background: "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.12), transparent)",
          }}
        />
      </div>

      {/* ── Scrollable content ── */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}
      >
        <div className="px-4 pt-4 pb-8">
          {SECTIONS.map((s) => (
            <SectionCard key={s.title} section={s} />
          ))}
          <p
            className="text-[10px] font-mono text-center pb-4 pt-2"
            style={{ color: "rgb(var(--rift-muted) / 0.22)" }}
          >
            by abyssprotocol
          </p>
        </div>
      </div>
    </div>
  );
}