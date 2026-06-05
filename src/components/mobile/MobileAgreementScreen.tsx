// src/components/mobile/MobileAgreementScreen.tsx
// Mobile-only first-launch agreement screen.
// Rendered by App.tsx before the splash screen when localStorage has no
// accepted agreement record on a mobile viewport.
// Decline does NOT programmatically close the app (Google Play / App Store
// guidelines discourage forced exits); instead it shows a clear blocking
// message instructing the user to close manually.

import { useRef, useState } from "react";
import { LEGAL_SECTIONS, EFFECTIVE_DATE, DEVELOPER_EMAIL } from "@/utils/legalContent";

interface Props {
  onAccept: () => void;
}

type DeclineState = "idle" | "declined";

export function MobileAgreementScreen({ onAccept }: Props) {
  const scrollRef    = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [declineState, setDeclineState]     = useState<DeclineState>("idle");

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollProgress(max > 0 ? el.scrollTop / max : 1);
  }

  function handleDecline() {
    setDeclineState("declined");
  }

  function handleReviewTerms() {
    setDeclineState("idle");
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  const hasReadMost = scrollProgress >= 0.72;

  if (declineState === "declined") {
    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center px-6 font-sans"
        style={{
          background:    "rgb(var(--rift-bg))",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          zIndex:        9999,
        }}
      >
        {/* Ambient glow */}
        <div
          aria-hidden
          style={{
            position:      "absolute",
            inset:         0,
            pointerEvents: "none",
            background:    "radial-gradient(ellipse 60% 50% at 50% 50%, rgb(var(--rift-accent2) / 0.04) 0%, transparent 70%)",
          }}
        />

        <div
          className="relative glass-heavy rounded-3xl p-7 w-full text-center"
          style={{ maxWidth: 380 }}
        >
          {/* Top accent bar */}
          <div
            style={{
              position:     "absolute",
              top:          0,
              left:         0,
              right:        0,
              height:       3,
              borderRadius: "24px 24px 0 0",
              background:   "linear-gradient(90deg, rgb(var(--rift-error) / 0.7), rgb(var(--rift-error) / 0.3), transparent)",
            }}
          />

          <p
            className="text-[9px] font-mono uppercase tracking-[0.26em] mb-4 mt-2"
            style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
          >
            Agreement Declined
          </p>

          <h2
            className="font-bold text-base mb-3"
            style={{ color: "rgb(var(--rift-text))" }}
          >
            The Rift cannot be used without your agreement
          </h2>

          <p
            className="text-[12px] leading-relaxed mb-6"
            style={{ color: "rgb(var(--rift-muted) / 0.72)" }}
          >
            You have declined the Terms of Use and Privacy Policy. The Rift does
            not function without your acceptance.
            <br /><br />
            To exit, please close the app from your device's home screen or app
            switcher. To use The Rift, tap the button below to review the terms
            and accept.
          </p>

          <button
            onClick={handleReviewTerms}
            className="w-full py-3.5 btn-accent text-xs"
          >
            Review Terms Again
          </button>

          <p
            className="text-[9px] font-mono mt-4"
            style={{ color: "rgb(var(--rift-muted) / 0.3)" }}
          >
            Questions? {DEVELOPER_EMAIL}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 flex flex-col font-sans"
      style={{
        background: "rgb(var(--rift-bg))",
        height:     "100dvh",
        zIndex:     9999,
      }}
    >
      {/* ── Sticky header ─── */}
      <header
        className="flex-shrink-0"
        style={{
          background:     "rgb(var(--rift-surface) / 0.95)",
          backdropFilter: "blur(20px) saturate(180%)",
          position:       "relative",
          zIndex:         2,
        }}
      >
        {/* Accent gradient bar */}
        <div
          style={{
            height:     3,
            background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
            boxShadow:  "0 0 22px rgb(var(--rift-glow) / 0.45)",
          }}
        />

        <div className="px-5 pt-4 pb-3">
          <p
            className="text-[8px] font-mono uppercase tracking-[0.3em] mb-1"
            style={{ color: "rgb(var(--rift-muted) / 0.42)" }}
          >
            Before you continue
          </p>
          <h1
            className="text-base font-bold"
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
            className="text-[9px] font-mono mt-0.5"
            style={{ color: "rgb(var(--rift-muted) / 0.4)" }}
          >
            The Rift · abyssprotocol · Effective {EFFECTIVE_DATE}
          </p>
        </div>

        {/* Scroll progress bar */}
        <div
          className="mx-5 mb-1"
          style={{
            height:     "2px",
            background: "rgb(var(--rift-border) / 0.3)",
            borderRadius: 99,
            overflow:   "hidden",
          }}
        >
          <div
            style={{
              height:       "100%",
              width:        `${scrollProgress * 100}%`,
              background:   "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              borderRadius: 99,
              transition:   "width 0.18s ease",
              boxShadow:    "0 0 6px rgb(var(--rift-glow) / 0.5)",
            }}
          />
        </div>

        {/* Header bottom fade */}
        <div
          aria-hidden
          style={{
            position:      "absolute",
            bottom:        -24,
            left:          0,
            right:         0,
            height:        24,
            background:    "linear-gradient(180deg, rgb(var(--rift-surface) / 0.3) 0%, transparent 100%)",
            pointerEvents: "none",
            zIndex:        3,
          }}
        />
      </header>

      {/* ── Scrollable legal content ─── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}
      >
        <div className="px-5 pt-4 pb-2">
          {/* Intro */}
          <p
            className="text-[11px] leading-relaxed mb-5"
            style={{ color: "rgb(var(--rift-muted) / 0.7)" }}
          >
            Please read the following in full. By tapping{" "}
            <span style={{ color: "rgb(var(--rift-accent))", fontWeight: 700 }}>
              I Accept &amp; Continue
            </span>
            , you confirm you have read, understood, and agreed to these Terms
            and Privacy Policy. If you do not agree, tap{" "}
            <span style={{ color: "rgb(var(--rift-muted))" }}>Decline</span>.
          </p>

          {/* Legal sections */}
          {LEGAL_SECTIONS.map((section) => (
            <div
              key={section.heading}
              className="mb-5 rounded-2xl p-4"
              style={{
                background: "rgb(var(--rift-surface2) / 0.38)",
                boxShadow:  "0 1px 6px rgb(0 0 0 / 0.15), 0 0 0 1px rgb(255 255 255 / 0.03), inset 0 1px 0 rgb(255 255 255 / 0.04)",
              }}
            >
              {/* Section heading */}
              <h2
                className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] mb-2"
                style={{ color: "rgb(var(--rift-accent) / 0.8)" }}
              >
                {section.heading}
              </h2>

              {/* Body paragraphs */}
              {section.paragraphs.map((para, i) => (
                <p
                  key={i}
                  className="text-[12px] leading-relaxed mb-1.5"
                  style={{ color: "rgb(var(--rift-muted) / 0.78)" }}
                >
                  {para}
                </p>
              ))}

              {/* Bullet list */}
              {section.bullets && (
                <ul className="mt-2 flex flex-col gap-1.5 pl-0.5">
                  {section.bullets.map((bullet, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 text-[11px] leading-relaxed"
                      style={{ color: "rgb(var(--rift-muted) / 0.68)" }}
                    >
                      <span
                        className="flex-shrink-0 mt-[6px] w-[5px] h-[5px] rounded-full"
                        style={{ background: "rgb(var(--rift-accent) / 0.42)" }}
                      />
                      {bullet}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          <p
            className="text-[9px] font-mono text-center pb-2 pt-1"
            style={{ color: "rgb(var(--rift-muted) / 0.22)" }}
          >
            by abyssprotocol · {DEVELOPER_EMAIL}
          </p>
        </div>
      </div>

      {/* ── Sticky action footer ─── */}
      <div
        className="flex-shrink-0"
        style={{
          background:     "rgb(var(--rift-surface) / 0.97)",
          backdropFilter: "blur(20px) saturate(180%)",
          borderTop:      "1px solid rgb(255 255 255 / 0.05)",
          padding:        "14px 20px",
          paddingBottom:  "calc(14px + env(safe-area-inset-bottom, 0px))",
          position:       "relative",
          zIndex:         2,
        }}
      >
        {/* Scroll nudge */}
        {!hasReadMost && (
          <p
            className="text-center text-[9px] font-mono mb-3"
            style={{ color: "rgb(var(--rift-muted) / 0.35)" }}
          >
            ↓ Scroll to read all terms
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleDecline}
            className="py-3.5 btn-ghost"
            style={{ flex: "0 0 auto", paddingLeft: "20px", paddingRight: "20px", fontSize: "0.68rem" }}
          >
            Decline
          </button>
          <button
            onClick={onAccept}
            className="flex-1 py-3.5 btn-accent"
            style={{ fontSize: "0.7rem" }}
          >
            I Accept &amp; Continue
          </button>
        </div>

        <p
          className="text-center text-[8px] font-mono mt-2.5"
          style={{ color: "rgb(var(--rift-muted) / 0.24)" }}
        >
          Accepting confirms you are 13 or older · abyssprotocol {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}