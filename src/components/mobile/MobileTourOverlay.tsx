// src/components/mobile/MobileTourOverlay.tsx
import { useRiftStore } from "@/store/riftStore";
import { TOUR_SEEN_KEY } from "@/components/TourOverlay";

interface MobileTourStep {
  title: string;
  body:  string;
  tab?:  string; // friendly tab name hint shown in the callout
}

const STEPS: MobileTourStep[] = [
  {
    title: "Welcome to The Rift",
    body:  "The Rift transfers files directly between devices on the same Wi-Fi network. No internet, no cloud, no accounts — ever. This guide walks you through your first transfer in under two minutes.",
  },
  {
    title: "Step 1 — Find Nearby Devices",
    tab:   "Devices",
    body:  "Any phone, PC, or laptop running The Rift on the same Wi-Fi appears in the Devices tab automatically within a few seconds. Tap a device card once to select it as your transfer target. Tap the selected card again to see its details.",
  },
  {
    title: "Step 2 — Stage and Send Files",
    tab:   "Send",
    body:  "Switch to the Send tab. Tap the browse area to pick any file — any type, any size. Once a device is selected and files are staged, tap Send Through. The other device sees an accept or decline dialog before any data transfers.",
  },
  {
    title: "Step 3 — Send Text Snippets",
    tab:   "Send",
    body:  "Still in the Send tab, switch to Text mode to send clipboard content, links, or short messages. No file is created — the recipient sees the text in a pop-up and copies it with one tap.",
  },
  {
    title: "Step 4 — Track Your Transfers",
    tab:   "History",
    body:  "The History tab logs every transfer this session. LIVE means actively transferring, DONE means verified and saved to Downloads, DENY means the recipient declined. Received files land in Downloads automatically.",
  },
  {
    title: "You're All Set",
    body:  "Tap HELP in the top-right corner at any time to reopen this guide or browse the full reference. Happy rifting.",
  },
];

const TOTAL = STEPS.length;

export function MobileTourOverlay() {
  const tourActive  = useRiftStore((s) => s.tourActive);
  const tourStep    = useRiftStore((s) => s.tourStep);
  const advanceTour = useRiftStore((s) => s.advanceTour);
  const retreatTour = useRiftStore((s) => s.retreatTour);
  const endTour     = useRiftStore((s) => s.endTour);

  if (!tourActive) return null;

  // Clamp: desktop tour has more steps than mobile; clamp so mobile never
  // reads an out-of-bounds index if the store step overshoots our array.
  const clampedStep = Math.min(tourStep, TOTAL - 1);
  const step        = STEPS[clampedStep];
  const isFirst     = clampedStep === 0;
  const isLast      = tourStep >= TOTAL - 1;

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
    // Dim scrim — pointer-events-none so the app beneath stays touchable
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      style={{ background: "rgb(0 0 0 / 0.40)", backdropFilter: "blur(2px)" }}
    >
      {/* Bottom card — pointer-events-auto so buttons and text work */}
      <div
        className="absolute bottom-0 left-0 right-0 pointer-events-auto animate-slide-up"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
        }}
      >
        <div
          className="glass-heavy mx-3 mb-2 overflow-hidden"
          style={{ borderRadius: 28 }}
        >
          {/* Accent bar */}
          <div
            style={{
              height:     3,
              background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
              boxShadow:  "0 0 18px rgb(var(--rift-glow) / 0.5)",
            }}
          />

          <div className="p-5">
            {/* Step counter + skip */}
            <div className="flex items-center justify-between mb-3">
              <span
                className="text-[9px] font-mono uppercase tracking-[0.22em]"
                style={{ color: "rgb(var(--rift-accent) / 0.7)" }}
              >
                {clampedStep + 1} of {TOTAL}
              </span>
              <button
                onClick={handleSkip}
                className="text-[9px] font-mono transition-colors"
                style={{ color: "rgb(var(--rift-muted) / 0.38)" }}
              >
                Skip guide
              </button>
            </div>

            {/* Progress bar */}
            <div className="flex gap-1 mb-4">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  style={{
                    height:     2,
                    flex:       1,
                    borderRadius: 99,
                    background: i <= clampedStep
                      ? "rgb(var(--rift-accent))"
                      : "rgb(var(--rift-muted) / 0.16)",
                    transition: "background 0.3s ease",
                  }}
                />
              ))}
            </div>

            {/* Tab hint — only when a specific tab is relevant */}
            {step.tab && (
              <div
                className="mb-3 flex items-center gap-2 px-2.5 py-1.5 rounded-xl"
                style={{
                  background: "rgb(var(--rift-accent) / 0.07)",
                  boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
                }}
              >
                <span
                  className="text-[8px] font-mono font-bold tracking-widest flex-shrink-0"
                  style={{ color: "rgb(var(--rift-accent))" }}
                >
                  TAB
                </span>
                <span
                  className="text-[9px] font-mono"
                  style={{ color: "rgb(var(--rift-muted) / 0.75)" }}
                >
                  Swipe or tap to the{" "}
                  <span
                    style={{ color: "rgb(var(--rift-accent))", fontWeight: 700 }}
                  >
                    {step.tab}
                  </span>{" "}
                  tab
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
                  className="px-4 py-2.5 btn-ghost text-[10px]"
                >
                  Back
                </button>
              )}
              <button
                onClick={handleNext}
                className="flex-1 py-2.5 btn-accent text-[10px]"
              >
                {isLast ? "Done" : "Next →"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}