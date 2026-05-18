import { useDevices } from "@/hooks/useDevices";
import { useTransfer } from "@/hooks/useTransfer";
import { DeviceList } from "@/components/DeviceList";
import { DropZone } from "@/components/DropZone";
import { TransferQueue } from "@/components/TransferQueue";
import { AcceptDialog } from "@/components/AcceptDialog";
import { StatusBar } from "@/components/StatusBar";

export default function App() {
  useDevices();
  useTransfer();

  return (
    <div className="h-screen bg-rift-bg flex flex-col overflow-hidden font-sans text-rift-text">
      <div className="flex-1 flex overflow-hidden">
        <DeviceList />
        <DropZone />
        <TransferQueue />
      </div>
      <StatusBar />
      <AcceptDialog />
    </div>
  );
}