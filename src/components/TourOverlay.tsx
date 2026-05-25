import { useCallback, useEffect, useState } from "react";
import { useRiftStore } from "@/store/riftStore";

export const TOUR_SEEN_KEY = "rift-tour-seen-v1";

export type Placement = "center" | "top" | "bottom" | "left" | "right";

const STEPS = [
  {
    id: null as string | null,
    title: "Welcome to The Rift",
    body: "Transfer files directly between devices on the same network, no internet, no cloud, no accounts. This quick tour takes under a minute.",
    placement: "center" as Placement,
  },
  {
    id: "device-list",
    title: "Nearby Devices",
    body: "Devices running The Rift on the same Wi-Fi appear here automatically. Click a card once to select it as your transfer target. Click the selected card again for details.",
    placement: "right" as Placement,
  },
  {
    id: "drop-zone",
    title: "The Portal",
    body: "Drag files anywhere onto the window to stage them, or click the browse link to pick files from disk. The portal in the centre reflects the current transfer state at a glance.",
    placement: "right" as Placement,
  },
  {
    id: "send-btn",
    title: "Send Through",
    body: "Once files are staged and a device is selected, press Send Through. The recipient sees an accept or decline prompt before any bytes move.",
    placement: "top" as Placement,
  },
  {
    id: "text-btn",
    title: "Quick Note",
    body: "Click the sticky-note icon to send a text snippet directly to another device, no files needed. Paste from clipboard or type freely. Ctrl+Enter sends instantly.",
    placement: "top" as Placement,
  },
  {
    id: "transfer-queue",
    title: "Transfer Queue",
    body: "All active, completed, and failed transfers appear here. TX is outgoing, RX is incoming. Incoming file requests pop up with an accept or decline dialog.",
    placement: "left" as Placement,
  },
  {
    id: "status-bar",
    title: "Status Bar",
    body: "Your device name and network status live here. HOTSPOT creates a direct Wi-Fi link when there is no shared router. THEME switches colour schemes. The ? button reopens this guide any time.",
    placement: "top" as Placement,
  },
] as const;

type Step = (typeof STEPS)[number];
type ArrowSide = "top" | "bottom" | "left" | "right" | null;

const TOTAL = STEPS.length;
const POP_W = 300;
const POP_H = 218;
const GAP = 18;
const ARROW = 9;
const PAD = 14;

interface DomRect { top: number; left: number; width: number; height: number }
interface PopPos {
  top: number;
  left: number;
  arrowSide: ArrowSide;
  arrowAlong: number;
}

function getElRect(id: string | null): DomRect | null {
  if (!id) return null;
  const el = document.querySelector(`[data-tour="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function calcPos(rect: DomRect | null, placement: Placement, vw: number, vh: number): PopPos {
  if (!rect || placement === "center") {
    return {
      top: vh / 2 - POP_H / 2,
      left: vw / 2 - POP_W / 2,
      arrowSide: null,
      arrowAlong: 0,
    };
  }

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  let rawTop = 0;
  let rawLeft = 0;
  let arrowSide: ArrowSide = null;

  switch (placement) {
    case "right":
      rawTop = cy - POP_H / 2;
      rawLeft = rect.left + rect.width + GAP;
      arrowSide = "left";
      break;
    case "left":
      rawTop = cy - POP_H / 2;
      rawLeft = rect.left - POP_W - GAP;
      arrowSide = "right";
      break;
    case "bottom":
      rawTop = rect.top + rect.height + GAP;
      rawLeft = cx - POP_W / 2;
      arrowSide = "top";
      break;
    case "top":
      rawTop = rect.top - POP_H - GAP;
      rawLeft = cx - POP_W / 2;
      arrowSide = "bottom";
      break;
  }

  const top = Math.max(PAD, Math.min(rawTop, vh - POP_H - PAD));
  const left = Math.max(PAD, Math.min(rawLeft, vw - POP_W - PAD));

  let arrowAlong = 0;
  if (arrowSide === "left" || arrowSide === "right") {
    arrowAlong = Math.max(ARROW * 2.5, Math.min(cy - top, POP_H - ARROW * 2.5));
  } else if (arrowSide === "top" || arrowSide === "bottom") {
    arrowAlong = Math.max(ARROW * 2.5, Math.min(cx - left, POP_W - ARROW * 2.5));
  }

  return { top, left, arrowSide, arrowAlong };
}

export function TourOverlay() {
  const tourActive = useRiftStore((s) => s.tourActive);
  const tourStep = useRiftStore((s) => s.tourStep);
  const advanceTour = useRiftStore((s) => s.advanceTour);
  const retreatTour = useRiftStore((s) => s.retreatTour);
  const endTour = useRiftStore((s) => s.endTour);

  const [pos, setPos] = useState<PopPos>({ top: 0, left: 0, arrowSide: null, arrowAlong: 0 });
  const [ready, setReady] = useState(false);

  // Track previous external state to cleanly derive component state inside render.
  const [prevStep, setPrevStep] = useState(tourStep);
  const [prevActive, setPrevActive] = useState(tourActive);

  if (tourStep !== prevStep || tourActive !== prevActive) {
    setPrevStep(tourStep);
    setPrevActive(tourActive);
    setReady(false);
  }

  const step = STEPS[tourStep] as Step | undefined;

  const recompute = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = getElRect(step?.id ?? null);
    setPos(calcPos(rect, step?.placement ?? "center", vw, vh));
    setReady(true);
  }, [step]);

  useEffect(() => {
    if (!tourActive) return;
    const t = setTimeout(recompute, 80);
    return () => clearTimeout(t);
  }, [tourActive, tourStep, recompute]);

  useEffect(() => {
    if (!tourActive) return;
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [tourActive, recompute]);

  if (!tourActive || !step) return null;

  const isFirst = tourStep === 0;
  const isLast = tourStep === TOTAL - 1;
  const highlightRect = step.id ? getElRect(step.id) : null;
  const surf = "rgb(var(--rift-surface))";

  function handleSkip() {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
    endTour();
  }

  function handleNext() {
    if (isLast) {
      localStorage.setItem(TOUR_SEEN_KEY, "1");
      endTour();
    } else {
      advanceTour();
    }
  }

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 200 }}>
      {/* ── Scrim with cutout ── */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-auto"
        style={{ cursor: "default" }}
        onClick={(e) => e.stopPropagation()}
      >
        <defs>
          <mask id="rift-tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {highlightRect && (
              <rect
                x={highlightRect.left - 8}
                y={highlightRect.top - 8}
                width={highlightRect.width + 16}
                height={highlightRect.height + 16}
                rx="20"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.6)"
          mask="url(#rift-tour-mask)"
        />
      </svg>

      {/* ── Highlight ring ── */}
      {highlightRect && (
        <div
          className="absolute pointer-events-none"
          style={{
            top: highlightRect.top - 8,
            left: highlightRect.left - 8,
            width: highlightRect.width + 16,
            height: highlightRect.height + 16,
            borderRadius: 20,
            boxShadow:
              "0 0 0 2px rgb(var(--rift-accent) / 0.9), 0 0 0 5px rgb(var(--rift-accent) / 0.12), 0 0 40px rgb(var(--rift-glow) / 0.45)",
            animation: "ringBreathe 2.2s ease-in-out infinite",
          }}
        />
      )}

      {/* ── Popover ── */}
      {ready && (
        <div
          className="absolute pointer-events-auto"
          style={{ top: pos.top, left: pos.left, width: POP_W, zIndex: 201 }}
        >
          {/* Arrows */}
          {pos.arrowSide === "left" && (
            <div
              style={{
                position: "absolute",
                top: pos.arrowAlong - ARROW,
                left: -ARROW,
                width: 0,
                height: 0,
                borderTop: `${ARROW}px solid transparent`,
                borderBottom: `${ARROW}px solid transparent`,
                borderRight: `${ARROW}px solid ${surf}`,
              }}
            />
          )}
          {pos.arrowSide === "right" && (
            <div
              style={{
                position: "absolute",
                top: pos.arrowAlong - ARROW,
                right: -ARROW,
                width: 0,
                height: 0,
                borderTop: `${ARROW}px solid transparent`,
                borderBottom: `${ARROW}px solid transparent`,
                borderLeft: `${ARROW}px solid ${surf}`,
              }}
            />
          )}
          {pos.arrowSide === "top" && (
            <div
              style={{
                position: "absolute",
                top: -ARROW,
                left: pos.arrowAlong - ARROW,
                width: 0,
                height: 0,
                borderLeft: `${ARROW}px solid transparent`,
                borderRight: `${ARROW}px solid transparent`,
                borderBottom: `${ARROW}px solid ${surf}`,
              }}
            />
          )}
          {pos.arrowSide === "bottom" && (
            <div
              style={{
                position: "absolute",
                bottom: -ARROW,
                left: pos.arrowAlong - ARROW,
                width: 0,
                height: 0,
                borderLeft: `${ARROW}px solid transparent`,
                borderRight: `${ARROW}px solid transparent`,
                borderTop: `${ARROW}px solid ${surf}`,
              }}
            />
          )}

          {/* Card */}
          <div
            className="glass-heavy overflow-hidden animate-scale-in"
            style={{ borderRadius: 20 }}
          >
            <div
              style={{
                height: 3,
                background:
                  "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
                boxShadow: "0 0 18px rgb(var(--rift-glow) / 0.5)",
              }}
            />

            <div className="p-5">
              {/* Meta row */}
              <div className="flex items-center justify-between mb-3">
                <span
                  className="text-[9px] font-mono uppercase tracking-[0.22em]"
                  style={{ color: "rgb(var(--rift-accent) / 0.7)" }}
                >
                  Step {tourStep + 1} of {TOTAL}
                </span>
                <button
                  onClick={handleSkip}
                  className="text-[9px] font-mono transition-colors"
                  style={{ color: "rgb(var(--rift-muted) / 0.4)" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "rgb(var(--rift-muted))";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "rgb(var(--rift-muted) / 0.4)";
                  }}
                >
                  Skip tour
                </button>
              </div>

              {/* Progress segments */}
              <div className="flex gap-1 mb-4">
                {STEPS.map((_, i) => (
                  <div
                    key={i}
                    style={{
                      height: 2,
                      flex: 1,
                      borderRadius: 99,
                      background:
                        i <= tourStep
                          ? "rgb(var(--rift-accent))"
                          : "rgb(var(--rift-muted) / 0.16)",
                      transition: "background 0.3s ease",
                    }}
                  />
                ))}
              </div>

              <p className="font-semibold text-rift-text text-sm mb-2">
                {step.title}
              </p>
              <p
                className="text-[11px] leading-relaxed mb-4"
                style={{ color: "rgb(var(--rift-muted) / 0.82)" }}
              >
                {step.body}
              </p>

              <div className="flex gap-2">
                {!isFirst && (
                  <button
                    onClick={retreatTour}
                    className="px-3 py-2 btn-ghost text-[10px]"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={handleNext}
                  className="flex-1 py-2 btn-accent text-[10px]"
                >
                  {isLast ? "Done" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}