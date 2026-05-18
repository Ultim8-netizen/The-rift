import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { ChunkProgress, IncomingRequest, Transfer } from "@/types";

export function useTransfer() {
  const { call } = useInvoke();
  const addTransfer = useRiftStore((s) => s.addTransfer);
  const updateTransfer = useRiftStore((s) => s.updateTransfer);
  const setIncomingRequest = useRiftStore((s) => s.setIncomingRequest);
  const clearStagedFiles = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const stagedFiles = useRiftStore((s) => s.stagedFiles);

  useTauriEvent<Transfer>("transfer_started", (transfer) => {
    addTransfer(transfer);
  });

  useTauriEvent<ChunkProgress>("transfer_progress", (progress) => {
    updateTransfer(progress.transferId, {
      bytesTransferred: progress.bytesTransferred,
      speedBytesPerSec: progress.speedBytesPerSec,
      etaSeconds: progress.etaSeconds,
      status: "transferring",
    });
  });

  useTauriEvent<{ transferId: string; savePath: string }>(
    "transfer_complete",
    ({ transferId, savePath }) => {
      updateTransfer(transferId, {
        status: "complete",
        completedAt: Date.now(),
        savePath,
      });
    }
  );

  useTauriEvent<{ transferId: string; message: string }>(
    "transfer_error",
    ({ transferId, message }) => {
      updateTransfer(transferId, {
        status: "error",
        errorMessage: message,
      });
    }
  );

  useTauriEvent<IncomingRequest>("incoming_transfer_request", (req) => {
    addTransfer({
      id: req.transferId,
      direction: "incoming",
      status: "queued",
      files: req.files,
      targetDevice: null,
      senderDevice: req.senderDevice,
      totalBytes: req.totalBytes,
      bytesTransferred: 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      savePath: null,
    });
    setIncomingRequest(req);
  });

  async function sendFiles() {
    if (!selectedDevice || stagedFiles.length === 0) return;
    const filePaths = stagedFiles.map((f) => f.path);
    await call("send_files", {
      targetDeviceId: selectedDevice.id,
      filePaths,
    });
    clearStagedFiles();
  }

  async function acceptTransfer(transferId: string) {
    setIncomingRequest(null);
    updateTransfer(transferId, { status: "connecting" });
    await call("accept_transfer", { transferId });
  }

  async function declineTransfer(transferId: string) {
    setIncomingRequest(null);
    updateTransfer(transferId, { status: "declined" });
    await call("decline_transfer", { transferId });
  }

  return { sendFiles, acceptTransfer, declineTransfer };
}