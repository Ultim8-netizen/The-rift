import { useRef } from "react";
import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { ChunkProgress, IncomingRequest, IncomingTextPayload, Transfer } from "@/types";

// ── Progress tracker ──────────────────────────────────────────────────────────
const CHUNK_SIZE = 512 * 1024; // mirrors DEFAULT_CHUNK_SIZE in manifest.rs
const EMA_ALPHA = 0.3;
const MIN_SPEED_FOR_ETA = 2048; // 2 KB/s

interface ProgressTracker {
  chunksReceived: number;
  totalExpectedChunks: number;
  lastTime: number;
  lastBytes: number;
  speedEma: number;
  // Outgoing-specific: tracks which file indices the overseer has verified.
  // When verifiedFiles.size === transfer.files.length the transfer is complete.
  verifiedFiles: Set<number>;
}

// Shared helper: build or retrieve a tracker for a transfer.
// `direction` is only used to initialise — the tracker itself is direction-agnostic.
function getOrCreateTracker(
  trackers: Map<string, ProgressTracker>,
  transferId: string,
  totalFiles: { sizeBytes: number }[],
  now: number
): ProgressTracker {
  let tracker = trackers.get(transferId);
  if (!tracker) {
    const totalExpectedChunks = totalFiles.reduce(
      (sum, f) => sum + Math.max(1, Math.ceil(f.sizeBytes / CHUNK_SIZE)),
      0
    );
    tracker = {
      chunksReceived: 0,
      totalExpectedChunks,
      lastTime: now,
      lastBytes: 0,
      speedEma: 0,
      verifiedFiles: new Set(),
    };
    trackers.set(transferId, tracker);
  }
  return tracker;
}

// Shared helper: advance the tracker by one chunk and compute UI values.
function advanceTracker(
  tracker: ProgressTracker,
  transferTotal: number,
  now: number
): { bytesTransferred: number; speedBytesPerSec: number; etaSeconds: number | null } {
  tracker.chunksReceived++;

  const bytesTransferred = Math.min(
    Math.round((tracker.chunksReceived / tracker.totalExpectedChunks) * transferTotal),
    transferTotal
  );

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

  const remaining  = transferTotal - bytesTransferred;
  const etaSeconds =
    tracker.speedEma >= MIN_SPEED_FOR_ETA
      ? Math.ceil(remaining / tracker.speedEma)
      : null;

  return {
    bytesTransferred,
    speedBytesPerSec: Math.round(tracker.speedEma),
    etaSeconds,
  };
}

// ── Event listeners — call ONCE in App.tsx only ───────────────────────────────
export function useTransferEvents() {
  const addTransfer        = useRiftStore((s) => s.addTransfer);
  const updateTransfer     = useRiftStore((s) => s.updateTransfer);
  const setIncomingRequest = useRiftStore((s) => s.setIncomingRequest);
  const setIncomingText    = useRiftStore((s) => s.setIncomingText);

  const trackers = useRef<Map<string, ProgressTracker>>(new Map());

  // ── transfer_started ───────────────────────────────────────────────────────
  // Fired by the SENDER's Rust side (lib.rs send_files) for outgoing transfers.
  // Previously this listener existed but Rust never emitted the event.
  useTauriEvent<Transfer>("transfer_started", (transfer) => {
    addTransfer(transfer);
  });

  // ── transfer_progress (INCOMING on receiver) ───────────────────────────────
  useTauriEvent<ChunkProgress>("transfer_progress", (progress) => {
    const { transferId, totalChunks, totalBytes } = progress;
    const now = Date.now();

    const stored = useRiftStore.getState().transfers.find((t) => t.id === transferId);
    const expectedChunks = stored
      ? stored.files.reduce(
          (sum, f) => sum + Math.max(1, Math.ceil(f.sizeBytes / CHUNK_SIZE)),
          0
        )
      : totalChunks;

    const tracker = getOrCreateTracker(
      trackers.current,
      transferId,
      stored?.files ?? Array(Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE))).fill({ sizeBytes: CHUNK_SIZE }),
      now
    );

    // Ensure totalExpectedChunks is set correctly if it wasn't initialised from the store.
    if (tracker.totalExpectedChunks === 0) {
      tracker.totalExpectedChunks = expectedChunks;
    }

    const transferTotal = stored?.totalBytes ?? totalBytes;
    const { bytesTransferred, speedBytesPerSec, etaSeconds } = advanceTracker(
      tracker,
      transferTotal,
      now
    );

    updateTransfer(transferId, {
      bytesTransferred,
      speedBytesPerSec,
      etaSeconds,
      status: "transferring",
    });
  });

  // ── chunk_sent (OUTGOING on sender) ───────────────────────────────────────
  // Emitted by client.rs for every ACK'd chunk.  Used to drive the TX card's
  // progress bar and speed readout on the sender's side.
  useTauriEvent<{
    transferId: string;
    fileIndex: number;
    chunkId: number;
    workerId: number;
  }>("chunk_sent", ({ transferId }) => {
    const now = Date.now();
    const stored = useRiftStore.getState().transfers.find((t) => t.id === transferId);
    if (!stored) return;

    const tracker = getOrCreateTracker(
      trackers.current,
      transferId,
      stored.files,
      now
    );

    const { bytesTransferred, speedBytesPerSec, etaSeconds } = advanceTracker(
      tracker,
      stored.totalBytes,
      now
    );

    updateTransfer(transferId, {
      bytesTransferred,
      speedBytesPerSec,
      etaSeconds,
      status: "transferring",
    });
  });

  // ── transfer_complete (INCOMING on receiver) ───────────────────────────────
  useTauriEvent<{ transferId: string; savePath: string }>(
    "transfer_complete",
    ({ transferId, savePath }) => {
      trackers.current.delete(transferId);
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

  // ── transfer_overseer_verified (OUTGOING on sender) ───────────────────────
  // The overseer fires once per FILE after all chunks for that file are
  // confirmed.  We accumulate verified file indices and mark the whole transfer
  // complete only when every file has been verified.
  useTauriEvent<{
    transferId: string;
    fileIndex: number;
    totalChunks: number;
  }>("transfer_overseer_verified", ({ transferId, fileIndex }) => {
    // Only relevant for outgoing transfers on the sender side.
    const stored = useRiftStore
      .getState()
      .transfers.find((t) => t.id === transferId && t.direction === "outgoing");
    if (!stored) return;

    const tracker = trackers.current.get(transferId);
    if (!tracker) return;

    tracker.verifiedFiles.add(fileIndex);

    if (tracker.verifiedFiles.size >= stored.files.length) {
      // All files confirmed by the overseer — the transfer is fully done.
      trackers.current.delete(transferId);
      updateTransfer(transferId, {
        status:           "complete",
        completedAt:      Date.now(),
        bytesTransferred: stored.totalBytes,
        speedBytesPerSec: 0,
        etaSeconds:       null,
      });
    }
  });

  // ── transfer_error (both sender and receiver) ─────────────────────────────
  useTauriEvent<{ transferId: string; message: string }>(
    "transfer_error",
    ({ transferId, message }) => {
      trackers.current.delete(transferId);
      updateTransfer(transferId, { status: "error", errorMessage: message });
    }
  );

  // ── transfer_declined (OUTGOING on sender) ────────────────────────────────
  // Emitted by lib.rs when the receiver declines.  Previously this case was
  // swallowed with a misleading comment — the receiver's server.rs DID emit
  // transfer_error, but to its OWN app, not to ours.  The sender's transfer
  // card was permanently stuck in "queued" / QUEUE status.
  useTauriEvent<{ transferId: string }>("transfer_declined", ({ transferId }) => {
    trackers.current.delete(transferId);
    updateTransfer(transferId, { status: "declined" });
  });

  // ── incoming_transfer_request ─────────────────────────────────────────────
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

  // ── incoming_text ─────────────────────────────────────────────────────────
  useTauriEvent<IncomingTextPayload>("incoming_text", (payload) => {
    setIncomingText(payload);
  });
}

// ── Action functions — safe to call from any component ────────────────────────
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