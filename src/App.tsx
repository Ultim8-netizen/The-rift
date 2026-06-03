import { useEffect, useState } from "react";
import { useDevices } from "@/hooks/useDevices";
import { useTransferEvents } from "@/hooks/useTransfer";
import { useTheme } from "@/hooks/useTheme";
import { useMobile } from "@/hooks/useMobile";
import { MobileLayout } from "@/components/MobileLayout";
import { DeviceList } from "@/components/DeviceList";
import { DropZone } from "@/components/DropZone";
import { TransferQueue } from "@/components/TransferQueue";
import { AcceptDialog } from "@/components/AcceptDialog";
import { DevicePopup } from "@/components/DevicePopup";
import { StatusBar } from "@/components/StatusBar";
import { ThemeSelector } from "@/components/ThemeSelector";
import { HotspotPanel } from "@/components/HotspotPanel";
import { TextTransferPanel } from "@/components/TextTransferPanel";
import { IncomingTextDialog } from "@/components/IncomingTextDialog";
import { TourOverlay, TOUR_SEEN_KEY } from "@/components/TourOverlay";
import { HelpPage } from "@/components/HelpPage";
import { SplashScreen } from "@/components/SplashScreen";
import { useRiftStore } from "@/store/riftStore";

const SPLASH_KEY = "rift-splash-v1";

export default function App() {
  // Check once per session — sessionStorage clears when the Tauri webview
  // is fully closed, so the splash plays on every fresh app launch.
  const [splashDone, setSplashDone] = useState(() => {
    return sessionStorage.getItem(SPLASH_KEY) === "1";
  });

  // Hooks must be called unconditionally. Discovery starts immediately in the
  // background while the splash plays — devices are often ready by the time
  // the animation finishes.
  useTheme();
  useDevices();
  useTransferEvents();

  const isMobile = useMobile();

  // Tour fires 650 ms after the splash clears, not before.
  useEffect(() => {
    if (!splashDone) return;
    const t = setTimeout(() => {
      if (!localStorage.getItem(TOUR_SEEN_KEY)) {
        useRiftStore.getState().startTour();
      }
    }, 650);
    return () => clearTimeout(t);
  }, [splashDone]);

  // ── Splash ─────────────────────────────────────────────────────────────────
  if (!splashDone) {
    return (
      <SplashScreen
        onDone={() => {
          sessionStorage.setItem(SPLASH_KEY, "1");
          setSplashDone(true);
        }}
      />
    );
  }

  // ── Mobile ─────────────────────────────────────────────────────────────────
  if (isMobile) {
    return <MobileLayout />;
  }

  // ── Desktop ────────────────────────────────────────────────────────────────
  return (
    <div
      className="h-screen overflow-hidden font-sans text-rift-text relative select-none"
      style={{ background: "rgb(var(--rift-bg))" }}
    >
      {/* Ambient light orbs */}
      <div aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
        <div
          className="ambient-orb animate-orb-drift-a"
          style={{
            width: "55vw", height: "55vw", top: "-20%", left: "-15%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.055) 0%, transparent 70%)",
          }}
        />
        <div
          className="ambient-orb animate-orb-drift-b"
          style={{
            width: "50vw", height: "50vw", bottom: "-20%", right: "-12%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent2) / 0.05) 0%, transparent 70%)",
          }}
        />
        <div
          className="ambient-orb animate-orb-drift-c"
          style={{
            width: "35vw", height: "35vw", top: "30%", left: "35%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.028) 0%, transparent 70%)",
          }}
        />
      </div>

      {/* Main layout */}
      <div className="relative flex h-full gap-2.5 p-2.5 pb-14" style={{ zIndex: 1 }}>
        <DeviceList />
        <DropZone />
        <TransferQueue />
      </div>

      {/* Floating status bar */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-2.5 px-3" style={{ zIndex: 2 }}>
        <StatusBar />
      </div>

      {/* Overlays */}
      <AcceptDialog />
      <DevicePopup />
      <ThemeSelector />
      <HotspotPanel />
      <TextTransferPanel />
      <IncomingTextDialog />
      <HelpPage />
      <TourOverlay />
    </div>
  );
}