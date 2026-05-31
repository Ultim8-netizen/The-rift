import { useRef } from "react";
import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { ChunkProgress, IncomingRequest, IncomingTextPayload, Transfer } from "@/types";

// ── Progress tracker ─────────────────────────────────────────────────────────
// Chunk size matches DEFAULT_CHUNK_SIZE in manifest.rs.
// We never import Rust constants into the frontend — this value is stable and
// documented in the Rust source so it is safe to mirror here.
const CHUNK_SIZE = 512 * 1024; // 512 KB

// EMA smoothing factor: 0.3 means 30 % instant, 70 % history.
// Higher = more reactive but noisier; lower = smoother but lags.
const EMA_ALPHA = 0.3;

// Minimum speed (B/s) before we render an ETA. Prevents "∞ s" flicker at start.
const MIN_SPEED_FOR_ETA = 2048; // 2 KB/s

interface ProgressTracker {
  chunksReceived: number;
  totalExpectedChunks: number; // computed once from files[] when tracker is created
  lastTime: number;            // ms timestamp of last event
  lastBytes: number;           // bytesTransferred at last event
  speedEma: number;            // exponential moving average speed (B/s)
}

// ── Event listeners — call ONCE in App.tsx only ───────────────────────────────
export function useTransferEvents() {
  const addTransfer        = useRiftStore((s) => s.addTransfer);
  const updateTransfer     = useRiftStore((s) => s.updateTransfer);
  const setIncomingRequest = useRiftStore((s) => s.setIncomingRequest);
  const setIncomingText    = useRiftStore((s) => s.setIncomingText);

  // Mutable ref — updates never trigger re-renders, exactly what we want.
  const trackers = useRef<Map<string, ProgressTracker>>(new Map());

  useTauriEvent<Transfer>("transfer_started", (transfer) => {
    addTransfer(transfer);
  });

  useTauriEvent<ChunkProgress>("transfer_progress", (progress) => {
    const { transferId, totalChunks, totalBytes } = progress;
    const now = Date.now();

    // ── Resolve or initialise the tracker ─────────────────────────────────────
    let tracker = trackers.current.get(transferId);
    if (!tracker) {
      // Sum expected chunks across all files so we can interpolate globally.
      // Falls back to per-file totalChunks if the transfer isn't in the store yet
      // (shouldn't happen in practice — incoming_transfer_request arrives first).
      const stored = useRiftStore.getState().transfers.find((t) => t.id === transferId);
      const expectedChunks = stored
        ? stored.files.reduce(
            (sum, f) => sum + Math.max(1, Math.ceil(f.sizeBytes / CHUNK_SIZE)),
            0
          )
        : totalChunks;

      tracker = {
        chunksReceived:      0,
        totalExpectedChunks: expectedChunks,
        lastTime:            now,
        lastBytes:           0,
        speedEma:            0,
      };
      trackers.current.set(transferId, tracker);
    }

    tracker.chunksReceived++;

    // ── Bytes transferred (linear interpolation) ──────────────────────────────
    // Slight over-count at the end of each file (last chunk is usually < 512 KB)
    // but the error is < 1 % for any realistic multi-file transfer.
    const stored          = useRiftStore.getState().transfers.find((t) => t.id === transferId);
    const transferTotal   = stored?.totalBytes ?? totalBytes;
    const bytesTransferred = Math.min(
      Math.round((tracker.chunksReceived / tracker.totalExpectedChunks) * transferTotal),
      transferTotal
    );

    // ── Speed via EMA ─────────────────────────────────────────────────────────
    // Guard against clock going backward or two events in the same millisecond.
    const dtSeconds  = Math.max(0.02, (now - tracker.lastTime) / 1000);
    const deltaBytes = bytesTransferred - tracker.lastBytes;
    if (deltaBytes > 0) {
      const instant    = deltaBytes / dtSeconds;
      tracker.speedEma =
        tracker.speedEma === 0
          ? instant
          : EMA_ALPHA * instant + (1 - EMA_ALPHA) * tracker.speedEma;
    }
    tracker.lastTime  = now;
    tracker.lastBytes = bytesTransferred;

    // ── ETA ───────────────────────────────────────────────────────────────────
    const remaining  = transferTotal - bytesTransferred;
    const etaSeconds =
      tracker.speedEma >= MIN_SPEED_FOR_ETA
        ? Math.ceil(remaining / tracker.speedEma)
        : null;

    updateTransfer(transferId, {
      bytesTransferred,
      speedBytesPerSec: Math.round(tracker.speedEma),
      etaSeconds,
      status: "transferring",
    });
  });

  useTauriEvent<{ transferId: string; savePath: string }>(
    "transfer_complete",
    ({ transferId, savePath }) => {
      trackers.current.delete(transferId);

      // Mark 100 % — use the stored totalBytes so the bar fills completely.
      const stored = useRiftStore.getState().transfers.find((t) => t.id === transferId);
      updateTransfer(transferId, {
        status:           "complete",
        completedAt:      Date.now(),
        savePath,
        bytesTransferred: stored?.totalBytes ?? 0,
        speedBytesPerSec: 0,
        etaSeconds:       null,
      });
    }
  );

  useTauriEvent<{ transferId: string; message: string }>(
    "transfer_error",
    ({ transferId, message }) => {
      trackers.current.delete(transferId);
      updateTransfer(transferId, { status: "error", errorMessage: message });
    }
  );

  useTauriEvent<IncomingRequest>("incoming_transfer_request", (req) => {
    addTransfer({
      id:               req.transferId,
      direction:        "incoming",
      status:           "queued",
      files:            req.files,
      targetDevice:     null,
      senderDevice:     req.senderDevice,
      totalBytes:       req.totalBytes,
      bytesTransferred: 0,
      speedBytesPerSec: 0,
      etaSeconds:       null,
      startedAt:        null,
      completedAt:      null,
      errorMessage:     null,
      savePath:         null,
    });
    setIncomingRequest(req);
  });

  // Text arrives silently — no accept/decline, just surface the dialog.
  useTauriEvent<IncomingTextPayload>("incoming_text", (payload) => {
    setIncomingText(payload);
  });
}

// ── Action functions — safe to call from any component ─────────────────────────
export function useTransferActions() {
  const { call }           = useInvoke();
  const clearStagedFiles   = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice     = useRiftStore((s) => s.selectedDevice);
  const stagedFiles        = useRiftStore((s) => s.stagedFiles);
  const setIncomingRequest = useRiftStore((s) => s.setIncomingRequest);
  const updateTransfer     = useRiftStore((s) => s.updateTransfer);
  const isSending          = useRiftStore((s) => s.isSending);
  const setIsSending       = useRiftStore((s) => s.setIsSending);

  async function sendFiles() {
    if (isSending || !selectedDevice || stagedFiles.length === 0) return;
    setIsSending(true);
    const filePaths = stagedFiles.map((f) => f.path);
    clearStagedFiles();
    try {
      await call("send_files", {
        targetDeviceId: selectedDevice.id,
        filePaths,
      });
    } finally {
      setIsSending(false);
    }
  }

  async function sendText(text: string) {
    if (!selectedDevice || text.trim().length === 0) return;
    await call("send_text", {
      targetDeviceId: selectedDevice.id,
      text,
    });
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

  return { sendFiles, sendText, acceptTransfer, declineTransfer };
}