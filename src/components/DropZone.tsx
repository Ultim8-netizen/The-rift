// src/components/DropZone.tsx
import { useCallback, useEffect, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { type StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fmt, expandToPaths } from "@/utils/fileHelpers";
import { Portal3D } from "./Portal3D";

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false);

  const stagedFiles    = useRiftStore((s) => s.stagedFiles);
  const setStagedFiles = useRiftStore((s) => s.setStagedFiles);
  const clearStaged    = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const isSending      = useRiftStore((s) => s.isSending);
  const setStickyNote  = useRiftStore((s) => s.setStickyNoteOpen);

  const { sendFiles } = useTransferActions();
  const { call }      = useInvoke();

  const totalBytes = stagedFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
  const canSend    = stagedFiles.length > 0 && !!selectedDevice && !isSending;

  const stageFromPaths = useCallback(
    async (rawPaths: string[]) => {
      if (!rawPaths.length) return;
      try {
        const filePaths = await expandToPaths(rawPaths);
        if (!filePaths.length) return;
        const files = await call<StagedFile[]>("get_file_metadata", { paths: filePaths });
        setStagedFiles(files);
      } catch (e) {
        console.error(e);
      }
    },
    [call, setStagedFiles],
  );

  async function browse() {
    try {
      const res = await open({ multiple: true, directory: false });
      if (!res) return;
      await stageFromPaths(Array.isArray(res) ? res : [res]);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over") {
          setIsDragging(true);
        } else if (e.payload.type === "drop") {
          setIsDragging(false);
          void stageFromPaths(e.payload.paths ?? []);
        } else {
          setIsDragging(false);
        }
      })
      .then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [stageFromPaths]);

  return (
    <div
      data-tour="drop-zone"
      className="flex-1 flex flex-col items-center justify-center gap-6 px-8 py-6 select-none overflow-hidden"
    >
      {/* Wordmark */}
      <div className="text-center">
        <h1
          className="font-black tracking-[-0.04em] font-mono leading-none"
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            background: "linear-gradient(125deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            filter: "drop-shadow(0 0 24px rgb(var(--rift-glow) / 0.3))",
          }}
        >
          THE RIFT
        </h1>
        <p
          className="text-[9px] font-mono tracking-[0.35em] uppercase mt-1"
          style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
        >
          by abyssprotocol
        </p>
      </div>

      <Portal3D dragging={isDragging} hasFiles={stagedFiles.length > 0} isSending={isSending} />

      {stagedFiles.length === 0 ? (
        <EmptyPrompt onBrowse={browse} />
      ) : (
        <StageReadout files={stagedFiles} totalBytes={totalBytes} onClear={clearStaged} />
      )}

      {selectedDevice ? (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-full"
          style={{
            background: "rgb(var(--rift-accent) / 0.07)",
            boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
          }}
        >
          <span className="status-dot-live" style={{ width: "5px", height: "5px" }} />
          <span className="text-[11px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.8)" }}>
            Sending to{" "}
            <span style={{ color: "rgb(var(--rift-accent))", fontWeight: 600 }}>
              {selectedDevice.name}
            </span>
          </span>
        </div>
      ) : (
        <p className="text-[11px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>
          Select a device from the left panel
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          data-tour="send-btn"
          onClick={sendFiles}
          disabled={!canSend}
          className="px-12 py-3.5 btn-accent text-sm animate-glow-pulse disabled:animate-none"
          style={{ minWidth: "180px", fontSize: "0.75rem", letterSpacing: "0.14em" }}
        >
          {isSending ? "Sending…" : "Send Through"}
        </button>
        <StickyNoteButton onClick={() => setStickyNote(true)} />
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EmptyPrompt({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="text-center flex flex-col items-center gap-2">
      <p className="text-xs" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
        Drop files or folders anywhere — or{" "}
        <AccentButton onClick={onBrowse}>browse</AccentButton>
      </p>
      <p
        className="text-[10px] font-mono tracking-wide"
        style={{ color: "rgb(var(--rift-muted) / 0.35)" }}
      >
        Any type · Any size · Drag folders to include their contents
      </p>
    </div>
  );
}

function StageReadout({
  files,
  totalBytes,
  onClear,
}: {
  files: StagedFile[];
  totalBytes: number;
  onClear: () => void;
}) {
  return (
    <div
      className="rounded-2xl p-4 w-full max-w-xs animate-slide-up"
      style={{
        background:     "rgb(var(--rift-surface2) / 0.5)",
        backdropFilter: "blur(20px)",
        boxShadow:      "0 2px 12px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)",
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-xs font-semibold text-rift-text">
            {files.length} file{files.length !== 1 ? "s" : ""} staged
          </p>
          <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-muted) / 0.7)" }}>
            {fmt(totalBytes)}
          </p>
        </div>
        <button
          onClick={onClear}
          className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all"
          style={{
            color:      "rgb(var(--rift-error) / 0.75)",
            background: "rgb(var(--rift-error) / 0.08)",
            boxShadow:  "0 0 0 1px rgb(var(--rift-error) / 0.15)",
          }}
        >
          CLEAR
        </button>
      </div>
      <div className="max-h-20 overflow-y-auto">
        {files.map((f, i) => (
          <p
            key={i}
            className="text-[10px] font-mono truncate py-0.5"
            style={{ color: "rgb(var(--rift-muted) / 0.65)" }}
          >
            {f.name}
          </p>
        ))}
      </div>
    </div>
  );
}

function AccentButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="font-mono text-xs transition-colors"
      style={{ color: "rgb(var(--rift-accent))" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent2))";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent))";
      }}
    >
      {children}
    </button>
  );
}

function StickyNoteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      data-tour="text-btn"
      onClick={onClick}
      title="Send text"
      className="flex items-center justify-center rounded-2xl transition-all duration-200"
      style={{
        width:          "44px",
        height:         "44px",
        background:     "rgb(var(--rift-surface2) / 0.55)",
        boxShadow:      "0 0 0 1px rgb(255 255 255 / 0.06), 0 2px 8px rgb(0 0 0 / 0.25)",
        backdropFilter: "blur(12px)",
        flexShrink:     0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 0 0 1px rgb(var(--rift-accent) / 0.35), 0 0 16px rgb(var(--rift-glow) / 0.2)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 0 0 1px rgb(255 255 255 / 0.06), 0 2px 8px rgb(0 0 0 / 0.25)";
      }}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <polygon
          points="2,2 13,2 16,5 16,16 2,16"
          fill="rgb(var(--rift-accent) / 0.15)"
          stroke="rgb(var(--rift-accent) / 0.55)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <polygon
          points="13,2 16,5 13,5"
          fill="rgb(var(--rift-accent) / 0.3)"
          stroke="rgb(var(--rift-accent) / 0.55)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <line x1="5" y1="8"  x2="13" y2="8"  stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round" />
        <line x1="5" y1="11" x2="13" y2="11" stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round" />
        <line x1="5" y1="14" x2="10" y2="14" stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </button>
  );
}