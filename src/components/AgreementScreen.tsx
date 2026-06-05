// src/components/AgreementScreen.tsx
// Desktop-only first-launch agreement screen.
// Rendered by App.tsx before the splash screen when localStorage has no
// accepted agreement record. Decline closes the Tauri window entirely.

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LEGAL_SECTIONS, EFFECTIVE_DATE, DEVELOPER_EMAIL } from "@/utils/legalContent";

interface Props {
  onAccept: () => void;
}

export function AgreementScreen({ onAccept }: Props) {
  const scrollRef   = useRef<HTMLDivElement>(null);
  const mountedRef  = useRef(true);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [declinePhase, setDecliningPhase]   = useState<"idle" | "waiting" | "failed">("idle");

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollProgress(max > 0 ? el.scrollTop / max : 1);
  }

  async function handleDecline() {
    setDecliningPhase("waiting");
    try {
      // Tauri v2 core — closes the current webview window.
      // With a single-window app and exitWithLastWindow:true in tauri.conf.json
      // (the Tauri default) this also terminates the process.
      await getCurrentWindow().close();
    } catch {
      // close() resolved without error — window is closing. The fallback
      // timeout below handles the rare case where the window stays open
      // (e.g. debug builds with a close interceptor).
    }
    // If the component is still mounted 1.5s later, the close did not take
    // effect; tell the user to close manually.
    setTimeout(() => {
      if (mountedRef.current) {
        setDecliningPhase("failed");
      }
    }, 1500);
  }

  const hasReadMost = scrollProgress >= 0.72;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center font-sans select-none"
      style={{ background: "rgb(var(--rift-bg))", zIndex: 9999 }}
    >
      {/* ── Ambient background orbs ─── */}
      <div aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="ambient-orb"
          style={{
            width:      "55vw",
            height:     "55vw",
            top:        "-18%",
            left:       "-12%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.048) 0%, transparent 70%)",
          }}
        />
        <div
          className="ambient-orb"
          style={{
            width:      "48vw",
            height:     "48vw",
            bottom:     "-18%",
            right:      "-10%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent2) / 0.042) 0%, transparent 70%)",
          }}
        />
      </div>

      {/* ── Modal card ─── */}
      <div
        className="glass-heavy relative flex flex-col animate-scale-in"
        style={{
          width:        "min(680px, 95vw)",
          height:       "min(820px, 91vh)",
          borderRadius: 28,
          zIndex:       1,
        }}
      >
        {/* Accent gradient top bar */}
        <div
          style={{
            height:       3,
            flexShrink:   0,
            background:   "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
            boxShadow:    "0 0 28px rgb(var(--rift-glow) / 0.45)",
            borderRadius: "28px 28px 0 0",
          }}
        />

        {/* ── Header ─── */}
        <div
          className="flex-shrink-0 px-8 pt-6 pb-4"
          style={{
            background: "linear-gradient(180deg, rgb(var(--rift-surface) / 0.5) 0%, transparent 100%)",
          }}
        >
          <p
            className="text-[9px] font-mono uppercase tracking-[0.26em] mb-2"
            style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
          >
            Before you continue
          </p>
          <h1
            className="text-xl font-bold mb-1"
            style={{
              background:           "linear-gradient(125deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor:  "transparent",
              backgroundClip:       "text",
              letterSpacing:        "-0.01em",
            }}
          >
            Terms of Use &amp; Privacy Policy
          </h1>
          <p
            className="text-[10px] font-mono"
            style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
          >
            The Rift · abyssprotocol · Effective {EFFECTIVE_DATE}
          </p>
        </div>

        {/* ── Scroll progress bar ─── */}
        <div
          className="flex-shrink-0 mx-8 mb-2"
          style={{
            height:     "2px",
            background: "rgb(var(--rift-border) / 0.3)",
            borderRadius: 99,
            overflow:   "hidden",
          }}
        >
          <div
            style={{
              height:     "100%",
              width:      `${scrollProgress * 100}%`,
              background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              borderRadius: 99,
              transition: "width 0.18s ease",
              boxShadow:  "0 0 8px rgb(var(--rift-glow) / 0.5)",
            }}
          />
        </div>

        {/* ── Scrollable legal content ─── */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto"
          style={{ padding: "4px 32px 0" }}
        >
          {/* Intro paragraph */}
          <p
            className="text-[11px] leading-relaxed mb-6 pt-1"
            style={{ color: "rgb(var(--rift-muted) / 0.72)" }}
          >
            Please read the following Terms of Use and Privacy Policy in full.
            By clicking{" "}
            <span style={{ color: "rgb(var(--rift-accent))", fontWeight: 700 }}>
              I Accept &amp; Continue
            </span>
            , you confirm that you have read, understood, and agree to these
            terms. If you do not agree, click{" "}
            <span style={{ color: "rgb(var(--rift-muted))" }}>Decline &amp; Exit</span>{" "}
            to close The Rift.
          </p>

          {LEGAL_SECTIONS.map((section) => (
            <div key={section.heading} className="mb-6">
              {/* Section heading */}
              <h2
                className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] mb-2.5"
                style={{ color: "rgb(var(--rift-accent) / 0.82)" }}
              >
                {section.heading}
              </h2>

              {/* Body paragraphs */}
              {section.paragraphs.map((para, i) => (
                <p
                  key={i}
                  className="text-[12px] leading-relaxed mb-2"
                  style={{ color: "rgb(var(--rift-muted) / 0.78)" }}
                >
                  {para}
                </p>
              ))}

              {/* Bullet list */}
              {section.bullets && (
                <ul className="mt-2 flex flex-col gap-1.5 pl-1">
                  {section.bullets.map((bullet, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 text-[11px] leading-relaxed"
                      style={{ color: "rgb(var(--rift-muted) / 0.7)" }}
                    >
                      <span
                        className="flex-shrink-0 mt-[6px] w-[5px] h-[5px] rounded-full"
                        style={{ background: "rgb(var(--rift-accent) / 0.45)" }}
                      />
                      {bullet}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {/* Bottom breathing room */}
          <div style={{ height: 16 }} />
        </div>

        {/* ── Action footer ─── */}
        <div
          className="flex-shrink-0 px-8 pt-4 pb-6"
          style={{
            borderTop:  "1px solid rgb(255 255 255 / 0.05)",
            background: "linear-gradient(0deg, rgb(var(--rift-surface) / 0.45) 0%, transparent 100%)",
          }}
        >
          {declinePhase === "failed" ? (
            /* Window close failed — give manual instructions */
            <div
              className="text-center rounded-2xl px-5 py-4"
              style={{
                background: "rgb(var(--rift-surface2) / 0.55)",
                boxShadow:  "inset 0 2px 8px rgb(0 0 0 / 0.2)",
              }}
            >
              <p
                className="text-[11px] font-mono leading-relaxed"
                style={{ color: "rgb(var(--rift-muted) / 0.7)" }}
              >
                You have declined the agreement.
                <br />
                Please close The Rift from your taskbar or task manager.
              </p>
              <p
                className="text-[10px] font-mono mt-2"
                style={{ color: "rgb(var(--rift-muted) / 0.38)" }}
              >
                Contact: {DEVELOPER_EMAIL}
              </p>
            </div>
          ) : declinePhase === "waiting" ? (
            <p
              className="text-center text-[11px] font-mono py-3"
              style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
            >
              Closing…
            </p>
          ) : (
            <>
              {/* Scroll nudge — only while user hasn't read most of the doc */}
              {!hasReadMost && (
                <p
                  className="text-center text-[9px] font-mono mb-3"
                  style={{ color: "rgb(var(--rift-muted) / 0.38)" }}
                >
                  ↓ Scroll to read all terms before accepting
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={handleDecline}
                  className="flex-1 py-3 btn-ghost"
                  style={{ fontSize: "0.68rem" }}
                >
                  Decline &amp; Exit
                </button>
                <button
                  onClick={onAccept}
                  className="flex-1 py-3 btn-accent"
                  style={{ fontSize: "0.7rem", minWidth: "160px" }}
                >
                  I Accept &amp; Continue
                </button>
              </div>

              <p
                className="text-center text-[9px] font-mono mt-3"
                style={{ color: "rgb(var(--rift-muted) / 0.25)" }}
              >
                Accepting confirms you are 13 or older and agree to the terms above
                · abyssprotocol {new Date().getFullYear()}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}