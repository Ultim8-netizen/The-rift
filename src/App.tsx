import { useDevices } from "@/hooks/useDevices";
import { useTransferEvents } from "@/hooks/useTransfer";
import { useTheme } from "@/hooks/useTheme";
import { DeviceList } from "@/components/DeviceList";
import { DropZone } from "@/components/DropZone";
import { TransferQueue } from "@/components/TransferQueue";
import { AcceptDialog } from "@/components/AcceptDialog";
import { DevicePopup } from "@/components/DevicePopup";
import { StatusBar } from "@/components/StatusBar";
import { ThemeSelector } from "@/components/ThemeSelector";
import { HotspotPanel } from "@/components/HotspotPanel";

export default function App() {
  useTheme();
  useDevices();
  useTransferEvents();

  return (
    <div
      className="h-screen overflow-hidden font-sans text-rift-text relative select-none"
      style={{ background: "rgb(var(--rift-bg))" }}
    >
      {/* ── Animated ambient light field ── */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{ zIndex: 0 }}
      >
        {/* Primary orb — follows accent */}
        <div
          className="ambient-orb animate-orb-drift-a"
          style={{
            width: "55vw",
            height: "55vw",
            top: "-20%",
            left: "-15%",
            background: `radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.055) 0%, transparent 70%)`,
          }}
        />
        {/* Secondary orb — accent2 */}
        <div
          className="ambient-orb animate-orb-drift-b"
          style={{
            width: "50vw",
            height: "50vw",
            bottom: "-20%",
            right: "-12%",
            background: `radial-gradient(ellipse at center, rgb(var(--rift-accent2) / 0.05) 0%, transparent 70%)`,
          }}
        />
        {/* Mid orb — warm center */}
        <div
          className="ambient-orb animate-orb-drift-c"
          style={{
            width: "35vw",
            height: "35vw",
            top: "30%",
            left: "35%",
            background: `radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.028) 0%, transparent 70%)`,
          }}
        />
      </div>

      {/* ── Main layout — floating panels with gap ── */}
      <div
        className="relative flex h-full gap-2.5 p-2.5 pb-14"
        style={{ zIndex: 1 }}
      >
        <DeviceList />
        <DropZone />
        <TransferQueue />
      </div>

      {/* ── Floating status pill ── */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-2.5 px-3" style={{ zIndex: 2 }}>
        <StatusBar />
      </div>

      {/* ── Overlays ── */}
      <AcceptDialog />
      <DevicePopup />
      <ThemeSelector />
      <HotspotPanel />
    </div>
  );
}