import { useCallback, useEffect, useState } from "react";
import { useRiftStore } from "@/store/riftStore";

// Bumped to v2 so users who dismissed the old tour see the new one.
export const TOUR_SEEN_KEY = "rift-tour-seen-v2";

export type Placement = "center" | "top" | "bottom" | "left" | "right";
type ArrowSide = "top" | "bottom" | "left" | "right" | null;

interface TourStep {
  id: string | null;
  title: string;
  body: string;
  placement: Placement;
  clickable: boolean; // when true the highlighted element receives real pointer events
}

// Index 2 is the "click hotspot" step — the auto-advance effect is keyed on this.
const HOTSPOT_CLICK_STEP = 2;

const STEPS: TourStep[] = [
  {
    id: null,
    title: "Welcome to The Rift",
    body: "The Rift transfers files directly between two devices on the same Wi-Fi. No internet, no cloud, no accounts — ever. This guide walks you from opening the app to completing your first transfer. It takes under two minutes.",
    placement: "center",
    clickable: false,
  },
  {
    id: "device-list",
    title: "Step 1: Look for Nearby Devices",
    body: "Any device running The Rift on the same Wi-Fi network appears here automatically. Wait a few seconds. If you already see a device, click its card to select it, then press Next until you reach the send steps. If nothing appears, continue — the next step explains how to connect the two devices.",
    placement: "right",
    clickable: false,
  },
  {
    id: "hotspot-btn",
    title: "Step 2: No Devices? Use Hotspot",
    body: "Nothing in the list means the two devices are not on the same network yet. Click the HOTSPOT button below right now — it is highlighted. It lets one device create its own private Wi-Fi that the other device joins. The guide continues automatically as soon as the panel opens.",
    placement: "top",
    clickable: true,
  },
  {
    id: "hotspot-panel-body",
    title: "Step 3: Create the Hotspot (Host)",
    body: "On the HOST device: confirm the Create tab is selected, then click Create Hotspot. The app generates a network name and password — keep this screen open. Windows only: if you see a privilege error, close the app, right-click its icon, choose Run as Administrator, and try again.",
    placement: "right",
    clickable: true,
  },
  {
    id: "hotspot-panel-body",
    title: "Step 4: Join the Hotspot (Guest)",
    body: "On the GUEST device: open Wi-Fi settings (Windows: system tray bottom-right, Android: Settings then Wi-Fi) and connect to the network name shown on the host using the password shown. Then open The Rift on the guest, tap HOTSPOT, go to the Join tab, enter the same details, and tap Join Hotspot. Close this panel on both devices with the X button when done.",
    placement: "right",
    clickable: true,
  },
  {
    id: "device-list",
    title: "Step 5: Select the Target Device",
    body: "After both devices join the same network, the other device appears in this list within a few seconds. Click its card once to select it as your transfer destination. A label below the portal confirms the selection. You can change it at any time.",
    placement: "right",
    clickable: false,
  },
  {
    id: "drop-zone",
    title: "Step 6: Stage Your Files",
    body: "Drag files or folders anywhere onto this window to stage them. Or click the browse or folder links below the portal to open a file picker. All staged files appear below the orb. Any file type, any size, any number of files.",
    placement: "right",
    clickable: false,
  },
  {
    id: "send-btn",
    title: "Step 7: Send Through",
    body: "When a device is selected and files are staged, click Send Through. The other device sees a pop-up asking to Accept or Decline. Accepting starts the transfer immediately and files arrive in their Downloads folder automatically. Nothing else is needed on the receiving end.",
    placement: "top",
    clickable: false,
  },
  {
    id: "transfer-queue",
    title: "Step 8: Track Your Transfer",
    body: "Every transfer appears in this panel. QUEUE means waiting for acceptance, LIVE means actively sending, DONE means complete, DENY means the recipient declined. The ? button in the status bar reopens this guide at any time.",
    placement: "left",
    clickable: false,
  },
];

const TOTAL = STEPS.length;
const POP_W = 300;
const POP_H = 285; // conservative estimate; card expands to fit content
const GAP   = 18;
const ARROW = 9;
const PAD   = 14;

interface DomRect { top: number; left: number; width: number; height: number }
interface PopPos  { top: number; left: number; arrowSide: ArrowSide; arrowAlong: number }

function getElRect(id: string | null): DomRect | null {
  if (!id) return null;
  const el = document.querySelector(`[data-tour="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function calcPos(rect: DomRect | null, placement: Placement, vw: number, vh: number): PopPos {
  if (!rect || placement === "center") {
    return { top: vh / 2 - POP_H / 2, left: vw / 2 - POP_W / 2, arrowSide: null, arrowAlong: 0 };
  }

  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;

  let rawTop = 0, rawLeft = 0;
  let arrowSide: ArrowSide = null;

  switch (placement) {
    case "right":
      rawTop  = cy - POP_H / 2;
      rawLeft = rect.left + rect.width + GAP;
      arrowSide = "left";
      break;
    case "left":
      rawTop  = cy - POP_H / 2;
      rawLeft = rect.left - POP_W - GAP;
      arrowSide = "right";
      break;
    case "bottom":
      rawTop  = rect.top + rect.height + GAP;
      rawLeft = cx - POP_W / 2;
      arrowSide = "top";
      break;
    case "top":
      rawTop  = rect.top - POP_H - GAP;
      rawLeft = cx - POP_W / 2;
      arrowSide = "bottom";
      break;
  }

  const top  = Math.max(PAD, Math.min(rawTop,  vh - POP_H - PAD));
  const left = Math.max(PAD, Math.min(rawLeft, vw - POP_W - PAD));

  let arrowAlong = 0;
  if (arrowSide === "left" || arrowSide === "right") {
    arrowAlong = Math.max(ARROW * 2.5, Math.min(cy - top,  POP_H - ARROW * 2.5));
  } else if (arrowSide === "top" || arrowSide === "bottom") {
    arrowAlong = Math.max(ARROW * 2.5, Math.min(cx - left, POP_W - ARROW * 2.5));
  }

  return { top, left, arrowSide, arrowAlong };
}

export function TourOverlay() {
  const tourActive       = useRiftStore((s) => s.tourActive);
  const tourStep         = useRiftStore((s) => s.tourStep);
  const advanceTour      = useRiftStore((s) => s.advanceTour);
  const retreatTour      = useRiftStore((s) => s.retreatTour);
  const endTour          = useRiftStore((s) => s.endTour);
  const hotspotPanelOpen = useRiftStore((s) => s.hotspotPanelOpen);

  const [pos,       setPos]       = useState<PopPos>({ top: 0, left: 0, arrowSide: null, arrowAlong: 0 });
  const [ready,     setReady]     = useState(false);
  const [prevStep,  setPrevStep]  = useState(tourStep);
  const [prevActive,setPrevActive]= useState(tourActive);

  // Synchronously reset "ready" when step or active state changes to prevent
  // a flash of the popover at the old position.
  if (tourStep !== prevStep || tourActive !== prevActive) {
    setPrevStep(tourStep);
    setPrevActive(tourActive);
    setReady(false);
  }

  const step = STEPS[tourStep] as TourStep | undefined;

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

  // Auto-advance from the "click hotspot" step as soon as the panel opens.
  useEffect(() => {
    if (!tourActive || tourStep !== HOTSPOT_CLICK_STEP) return;
    if (hotspotPanelOpen) advanceTour();
  }, [hotspotPanelOpen, tourActive, tourStep, advanceTour]);

  if (!tourActive || !step) return null;

  const isFirst = tourStep === 0;
  const isLast  = tourStep === TOTAL - 1;

  // Resolve the target element's rect at render time (used both for highlight
  // ring positioning and for the clickable-scrim hole calculation).
  const highlightRect  = step.id ? getElRect(step.id) : null;

  // Clickable mode: the highlighted element must both exist and be flagged as
  // interactive. When true we replace the SVG mask with 4 surrounding divs so
  // the hole in the scrim has no pointer-events coverage, letting clicks reach
  // the real element underneath.
  const isClickable = step.clickable && !!highlightRect;

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

      {/* ── Scrim ───────────────────────────────────────────────────────────
          Non-clickable steps: SVG with mask cutout — one element, blocks
          all pointer events including over the highlighted region.

          Clickable steps: four plain divs arranged around the hole.
          The outer wrapper is pointer-events-none, so the gap between the
          four divs (the hole) naturally passes pointer events through to
          whatever lives underneath.
      ── */}

      {isClickable ? (
        <>
          {/* top */}
          <div
            className="absolute pointer-events-auto"
            style={{
              top: 0, left: 0, right: 0,
              height: Math.max(0, highlightRect.top - 8),
              background: "rgba(0,0,0,0.62)",
            }}
            onClick={(e) => e.stopPropagation()}
          />
          {/* bottom */}
          <div
            className="absolute pointer-events-auto"
            style={{
              top: highlightRect.top + highlightRect.height + 8,
              left: 0, right: 0, bottom: 0,
              background: "rgba(0,0,0,0.62)",
            }}
            onClick={(e) => e.stopPropagation()}
          />
          {/* left */}
          <div
            className="absolute pointer-events-auto"
            style={{
              top:    Math.max(0, highlightRect.top - 8),
              left:   0,
              width:  Math.max(0, highlightRect.left - 8),
              height: highlightRect.height + 16,
              background: "rgba(0,0,0,0.62)",
            }}
            onClick={(e) => e.stopPropagation()}
          />
          {/* right */}
          <div
            className="absolute pointer-events-auto"
            style={{
              top:  Math.max(0, highlightRect.top - 8),
              left: highlightRect.left + highlightRect.width + 8,
              right: 0,
              height: highlightRect.height + 16,
              background: "rgba(0,0,0,0.62)",
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </>
      ) : (
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
                  y={highlightRect.top  - 8}
                  width={highlightRect.width  + 16}
                  height={highlightRect.height + 16}
                  rx="20"
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            width="100%" height="100%"
            fill="rgba(0,0,0,0.62)"
            mask="url(#rift-tour-mask)"
          />
        </svg>
      )}

      {/* ── Highlight ring ── */}
      {highlightRect && (
        <div
          className="absolute pointer-events-none"
          style={{
            top:    highlightRect.top  - 8,
            left:   highlightRect.left - 8,
            width:  highlightRect.width  + 16,
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
          {/* Directional arrows */}
          {pos.arrowSide === "left" && (
            <div style={{
              position: "absolute", top: pos.arrowAlong - ARROW, left: -ARROW,
              width: 0, height: 0,
              borderTop: `${ARROW}px solid transparent`,
              borderBottom: `${ARROW}px solid transparent`,
              borderRight: `${ARROW}px solid ${surf}`,
            }} />
          )}
          {pos.arrowSide === "right" && (
            <div style={{
              position: "absolute", top: pos.arrowAlong - ARROW, right: -ARROW,
              width: 0, height: 0,
              borderTop: `${ARROW}px solid transparent`,
              borderBottom: `${ARROW}px solid transparent`,
              borderLeft: `${ARROW}px solid ${surf}`,
            }} />
          )}
          {pos.arrowSide === "top" && (
            <div style={{
              position: "absolute", top: -ARROW, left: pos.arrowAlong - ARROW,
              width: 0, height: 0,
              borderLeft: `${ARROW}px solid transparent`,
              borderRight: `${ARROW}px solid transparent`,
              borderBottom: `${ARROW}px solid ${surf}`,
            }} />
          )}
          {pos.arrowSide === "bottom" && (
            <div style={{
              position: "absolute", bottom: -ARROW, left: pos.arrowAlong - ARROW,
              width: 0, height: 0,
              borderLeft: `${ARROW}px solid transparent`,
              borderRight: `${ARROW}px solid transparent`,
              borderTop: `${ARROW}px solid ${surf}`,
            }} />
          )}

          {/* Card */}
          <div
            className="glass-heavy overflow-hidden animate-scale-in"
            style={{ borderRadius: 20 }}
          >
            {/* Accent top bar */}
            <div style={{
              height: 3, flexShrink: 0,
              background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
              boxShadow: "0 0 18px rgb(var(--rift-glow) / 0.5)",
            }} />

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
                    (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-muted))";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-muted) / 0.4)";
                  }}
                >
                  Skip tour
                </button>
              </div>

              {/* Progress bar */}
              <div className="flex gap-1 mb-4">
                {STEPS.map((_, i) => (
                  <div
                    key={i}
                    style={{
                      height: 2, flex: 1, borderRadius: 99,
                      background: i <= tourStep
                        ? "rgb(var(--rift-accent))"
                        : "rgb(var(--rift-muted) / 0.16)",
                      transition: "background 0.3s ease",
                    }}
                  />
                ))}
              </div>

              {/* "Click to interact" callout — only on clickable steps where the
                  element is in the DOM so the user knows the scrim hole is real. */}
              {isClickable && (
                <div
                  className="mb-3 flex items-center gap-2 px-2.5 py-1.5 rounded-xl"
                  style={{
                    background: "rgb(var(--rift-accent) / 0.07)",
                    boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
                  }}
                >
                  <span
                    className="text-[8px] font-mono font-bold tracking-widest flex-shrink-0"
                    style={{ color: "rgb(var(--rift-accent))" }}
                  >
                    ACTION
                  </span>
                  <span
                    className="text-[9px] font-mono leading-tight"
                    style={{ color: "rgb(var(--rift-muted) / 0.75)" }}
                  >
                    {tourStep === HOTSPOT_CLICK_STEP
                      ? "Click the highlighted button below"
                      : "You can interact with the highlighted area"}
                  </span>
                </div>
              )}

              <p className="font-semibold text-rift-text text-sm mb-2">
                {step.title}
              </p>
              <p
                className="text-[11px] leading-relaxed mb-4"
                style={{ color: "rgb(var(--rift-muted) / 0.82)" }}
              >
                {step.body}
              </p>

              {/* Navigation */}
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