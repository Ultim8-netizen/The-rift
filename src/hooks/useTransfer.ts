// src/hooks/useTransfer.ts
import { useRef } from "react";
import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { ChunkProgress, IncomingRequest, IncomingTextPayload, Transfer } from "@/types";

// ── Progress constants ────────────────────────────────────────────────────────
// CRITICAL: must match DEFAULT_CHUNK_SIZE in src-tauri/src/transfer/manifest.rs.
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB

const EMA_ALPHA = 0.3;
const MIN_SPEED_FOR_ETA = 2048; // 2 KB/s — suppress ETA at very low speeds

// ── Tracker ───────────────────────────────────────────────────────────────────
interface ProgressTracker {
  chunksReceived:      number;
  totalExpectedChunks: number;
  lastTime:            number;
  lastBytes:           number;
  speedEma:            number;
  /** File indices confirmed by transfer_overseer_verified (sender side). */
  verifiedFiles:       Set<number>;
}

function makeTracker(totalExpectedChunks: number, now: number): ProgressTracker {
  return {
    chunksReceived:      0,
    totalExpectedChunks,
    lastTime:            now,
    lastBytes:           0,
    speedEma:            0,
    verifiedFiles:       new Set(),
  };
}

/** Sum of ceil(sizeBytes / CHUNK_SIZE) across all files — total expected chunks. */
function computeExpectedChunks(files: { sizeBytes: number }[]): number {
  return files.reduce(
    (sum, f) => sum + Math.max(1, Math.ceil(f.sizeBytes / CHUNK_SIZE)),
    0,
  );
}

/**
 * Advance the chunk counter by `count` (default 1), compute bytes-transferred
 * proportion, update EMA speed.
 *
 * Used ONLY by the receiver-side transfer_progress handler.
 */
function advanceTracker(
  tracker:       ProgressTracker,
  transferTotal: number,
  now:           number,
  count:         number = 1,
): { bytesTransferred: number; speedBytesPerSec: number; etaSeconds: number | null } {
  tracker.chunksReceived = Math.min(
    tracker.chunksReceived + count,
    tracker.totalExpectedChunks,
  );

  const bytesTransferred =
    tracker.totalExpectedChunks > 0
      ? Math.min(
          Math.round(
            (tracker.chunksReceived / tracker.totalExpectedChunks) * transferTotal,
          ),
          transferTotal,
        )
      : 0;

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

// ── Event listeners ───────────────────────────────────────────────────────────
export function useTransferEvents() {
  const addTransfer        = useRiftStore((s) => s.addTransfer);
  const updateTransfer     = useRiftStore((s) => s.updateTransfer);
  const setIncomingRequest = useRiftStore((s) => s.setIncomingRequest);
  const setIncomingText    = useRiftStore((s) => s.setIncomingText);

  const trackers = useRef<Map<string, ProgressTracker>>(new Map());

  // ── transfer_started ──────────────────────────────────────────────────────
  useTauriEvent<Transfer>("transfer_started", (transfer) => {
    addTransfer(transfer);
  });

  // ── transfer_progress (INCOMING — receiver side) ──────────────────────────
  // Fires once per chunk written to disk. count = 1 (default).
  useTauriEvent<ChunkProgress>("transfer_progress", (progress) => {
    const { transferId, totalChunks, totalBytes } = progress;
    const now    = Date.now();
    const stored = useRiftStore.getState().transfers.find((t) => t.id === transferId);
    const transferTotal = stored?.totalBytes ?? totalBytes;

    const expectedTotal =
      stored?.files && stored.files.length > 0
        ? stored.files.length === 1
          ? totalChunks
          : computeExpectedChunks(stored.files)
        : totalChunks;

    let tracker = trackers.current.get(transferId);
    if (!tracker) {
      tracker = makeTracker(expectedTotal, now);
      trackers.current.set(transferId, tracker);
    }

    const { bytesTransferred, speedBytesPerSec, etaSeconds } = advanceTracker(
      tracker,
      transferTotal,
      now,
    );

    updateTransfer(transferId, {
      bytesTransferred,
      speedBytesPerSec,
      etaSeconds,
      status: "transferring",
    });
  });

  // ── chunk_sent (OUTGOING — sender side) ───────────────────────────────────
  // Emitted every EMIT_EVERY_N_CHUNKS confirmed chunks per worker.
  // We do NOT use this for bytesTransferred — the count is structurally
  // unreliable (floor(chunks_per_worker / N) × N always undershoots total).
  // Its only job here is to ensure the tracker exists and flip status to
  // transferring immediately on the first chunk, before the first overseer tick.
  useTauriEvent<{
    transferId: string;
    fileIndex:  number;
    chunkId:    number;
    workerId:   number;
  }>("chunk_sent", ({ transferId }) => {
    const now    = Date.now();
    const stored = useRiftStore.getState().transfers.find((t) => t.id === transferId);
    if (!stored) return;

    // Ensure the tracker exists so overseer_tick can use it for EMA speed.
    if (!trackers.current.has(transferId)) {
      trackers.current.set(
        transferId,
        makeTracker(computeExpectedChunks(stored.files), now),
      );
    }

    // Flip status only — do not touch bytesTransferred.
    if (stored.status === "queued" || stored.status === "connecting") {
      updateTransfer(transferId, { status: "transferring" });
    }
  });

  // ── transfer_overseer_tick (OUTGOING — sender side, ground-truth progress) ─
  //
  // The overseer independently tracks every chunk dispatched and ACKed.
  // confirmedChunks/totalChunks is the only accurate progress signal on the
  // sender side — it matches what the receiver actually has on disk.
  //
  // For multi-file transfers, files are processed sequentially.  bytesTransferred
  // = (bytes of already-verified files) + (confirmed fraction of current file).
  useTauriEvent<{
    transferId:      string;
    fileIndex:       number;
    confirmedChunks: number;
    totalChunks:     number;
    percentComplete: number;
  }>(
    "transfer_overseer_tick",
    ({ transferId, fileIndex, confirmedChunks, totalChunks }) => {
      const now = Date.now();
      const stored = useRiftStore
        .getState()
        .transfers.find((t) => t.id === transferId && t.direction === "outgoing");
      if (!stored) return;

      let tracker = trackers.current.get(transferId);
      if (!tracker) {
        tracker = makeTracker(computeExpectedChunks(stored.files), now);
        trackers.current.set(transferId, tracker);
      }

      // Bytes from files that the overseer has already fully verified.
      const completedBytes = stored.files
        .filter((_, i) => tracker!.verifiedFiles.has(i))
        .reduce((sum, f) => sum + f.sizeBytes, 0);

      // Confirmed fraction of the file currently being transferred.
      const currentFile = stored.files[fileIndex];
      const currentFileBytes =
        currentFile && totalChunks > 0
          ? Math.round((confirmedChunks / totalChunks) * currentFile.sizeBytes)
          : 0;

      const bytesTransferred = Math.min(
        completedBytes + currentFileBytes,
        stored.totalBytes,
      );

      // EMA speed derived from the delta since the last tick measurement.
      // Using overseer-accurate bytes makes this more reliable than the old
      // chunk_sent counter which systematically undershot.
      const dtSeconds  = Math.max(0.1, (now - tracker.lastTime) / 1000);
      const deltaBytes = Math.max(0, bytesTransferred - tracker.lastBytes);
      if (deltaBytes > 0) {
        const instant    = deltaBytes / dtSeconds;
        tracker.speedEma =
          tracker.speedEma === 0
            ? instant
            : EMA_ALPHA * instant + (1 - EMA_ALPHA) * tracker.speedEma;
      }
      tracker.lastTime  = now;
      tracker.lastBytes = bytesTransferred;

      const remaining  = stored.totalBytes - bytesTransferred;
      const etaSeconds =
        tracker.speedEma >= MIN_SPEED_FOR_ETA
          ? Math.ceil(remaining / tracker.speedEma)
          : null;

      const updates: Partial<Transfer> = {
        bytesTransferred,
        speedBytesPerSec: Math.round(tracker.speedEma),
        etaSeconds,
      };
      if (stored.status === "queued") updates.status = "transferring";
      updateTransfer(transferId, updates);
    },
  );

  // ── transfer_complete (INCOMING — receiver side) ──────────────────────────
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
    },
  );

  // ── transfer_overseer_verified (OUTGOING — sender side) ──────────────────
  useTauriEvent<{
    transferId:  string;
    fileIndex:   number;
    totalChunks: number;
  }>("transfer_overseer_verified", ({ transferId, fileIndex }) => {
    const stored = useRiftStore
      .getState()
      .transfers.find(
        (t) => t.id === transferId && t.direction === "outgoing",
      );
    if (!stored) return;

    const tracker = trackers.current.get(transferId);
    if (!tracker) return;

    tracker.verifiedFiles.add(fileIndex);

    if (tracker.verifiedFiles.size >= stored.files.length) {
      trackers.current.delete(transferId);
      updateTransfer(transferId, {
        status:           "complete",
        completedAt:      Date.now(),
        bytesTransferred: stored.totalBytes,
        speedBytesPerSec: 0,
        etaSeconds:       null,
      });
    } else {
      const verifiedBytes = stored.files
        .filter((_, i) => tracker.verifiedFiles.has(i))
        .reduce((sum, f) => sum + f.sizeBytes, 0);
      updateTransfer(transferId, { bytesTransferred: verifiedBytes });
    }
  });

  // ── transfer_error (both sides) ───────────────────────────────────────────
  useTauriEvent<{ transferId: string; message: string }>(
    "transfer_error",
    ({ transferId, message }) => {
      trackers.current.delete(transferId);
      updateTransfer(transferId, { status: "error", errorMessage: message });
    },
  );

  // ── transfer_declined (OUTGOING — sender side) ────────────────────────────
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

// ── Action functions ──────────────────────────────────────────────────────────
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