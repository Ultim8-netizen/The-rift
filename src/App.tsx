import { useDevices } from "@/hooks/useDevices";
import { useTransferEvents } from "@/hooks/useTransfer";
import { DeviceList } from "@/components/DeviceList";
import { DropZone } from "@/components/DropZone";
import { TransferQueue } from "@/components/TransferQueue";
import { AcceptDialog } from "@/components/AcceptDialog";
import { DevicePopup } from "@/components/DevicePopup";
import { StatusBar } from "@/components/StatusBar";
import { IncomingTextDialog } from "@/components/IncomingTextDialog";

export default function App() {
  useDevices();
  useTransferEvents();

  return (
    <div className="h-screen bg-rift-bg flex flex-col overflow-hidden font-sans text-rift-text">
      <div className="flex-1 flex overflow-hidden">
        <DeviceList />
        <DropZone />
        <TransferQueue />
      </div>
      <StatusBar />
      <AcceptDialog />
      <DevicePopup />
      <IncomingTextDialog />
    </div>
  );
}