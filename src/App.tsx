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

export default function App() {
  useTheme();
  useDevices();
  useTransferEvents();

  return (
    <div className="h-screen bg-rift-bg flex flex-col overflow-hidden font-sans text-rift-text relative">
      {/* Ambient background orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
        <div
          className="absolute -top-32 -left-32 w-96 h-96 rounded-full blur-3xl opacity-30"
          style={{ background: "rgb(var(--rift-accent) / 0.08)" }}
        />
        <div
          className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full blur-3xl opacity-30"
          style={{ background: "rgb(var(--rift-accent2) / 0.08)" }}
        />
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full blur-3xl opacity-20"
          style={{ background: "rgb(var(--rift-accent) / 0.06)" }}
        />
      </div>

      <div className="flex-1 flex overflow-hidden relative z-10">
        <DeviceList />
        <DropZone />
        <TransferQueue />
      </div>

      <StatusBar />
      <AcceptDialog />
      <DevicePopup />
      <ThemeSelector />
    </div>
  );
}