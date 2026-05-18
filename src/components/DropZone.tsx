import { useCallback, useEffect, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

function Portal({ dragging, hasFiles }: { dragging: boolean; hasFiles: boolean }) {
  const ringBase = "absolute rounded-full border";
  return (
    <div className="relative w-56 h-56 flex items-center justify-center">
      {/* Rings */}
      <div
        className={`${ringBase} inset-0 animate-spin-slowest transition-all duration-500 ${
          dragging ? "border-rift-accent/50" : "border-rift-accent/12"
        }`}
      />
      <div
        className={`${ringBase} inset-5 animate-spin-slower transition-all duration-500 ${
          dragging ? "border-rift-accent/40" : "border-rift-accent/18"
        }`}
        style={{ animationDirection: "reverse" }}
      />
      <div
        className={`${ringBase} inset-10 animate-spin-slow transition-all duration-500 ${
          dragging ? "border-rift-accent/60" : "border-rift-accent/28"
        }`}
      />
      {/* Subtle ring breathe */}
      <div className="absolute inset-0 rounded-full border border-rift-accent/8 animate-ring-breathe" />

      {/* Center disc */}
      <div
        className={`
          relative z-10 w-28 h-28 rounded-full glass-heavy flex flex-col items-center justify-center
          transition-all duration-300
          ${dragging
            ? "scale-110 shadow-glow border-rift-accent/50"
            : hasFiles
            ? "scale-105 shadow-glow-sm border-rift-accent/30"
            : "border-rift-border/50"}
        `}
        style={{
          border: "1px solid",
        }}
      >
        {dragging ? (
          <>
            <span className="text-xl font-mono font-black text-gradient leading-none">↓</span>
            <span className="text-[9px] font-mono text-rift-accent/80 mt-1 tracking-widest">DROP</span>
          </>
        ) : hasFiles ? (
          <>
            <span className="text-[11px] font-mono font-bold text-rift-accent tracking-wider">READY</span>
          </>
        ) : (
          <>
            <span
              className="text-lg font-mono font-black leading-none"
              style={{
                background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              ◈
            </span>
            <span className="text-[9px] font-mono text-rift-muted/70 mt-1 tracking-widest">RIFT</span>
          </>
        )}
      </div>
    </div>
  );
}

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false);
  const stagedFiles    = useRiftStore((s) => s.stagedFiles);
  const setStagedFiles = useRiftStore((s) => s.setStagedFiles);
  const clearStaged    = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const isSending      = useRiftStore((s) => s.isSending);
  const { sendFiles }  = useTransferActions();
  const { call }       = useInvoke();

  const totalBytes = stagedFiles.reduce((s, f) => s + f.sizeBytes, 0);
  const canSend    = stagedFiles.length > 0 && !!selectedDevice && !isSending;

  const stageFromPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      try {
        const files = await call<StagedFile[]>("get_file_metadata", { paths });
        setStagedFiles(files);
      } catch (e) { console.error(e); }
    },
    [call, setStagedFiles]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over") setIsDragging(true);
        else if (e.payload.type === "drop") {
          setIsDragging(false);
          stageFromPaths(e.payload.paths ?? []);
        } else setIsDragging(false);
      })
      .then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [stageFromPaths]);

  async function browse() {
    try {
      const res = await open({ multiple: true, directory: false });
      if (!res) return;
      await stageFromPaths(Array.isArray(res) ? res : [res]);
    } catch (e) { console.error(e); }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 p-8 select-none">
      {/* Wordmark */}
      <div className="text-center mb-2">
        <h1
          className="text-4xl font-black tracking-[-0.04em] font-mono leading-none"
          style={{
            background: "linear-gradient(125deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          THE RIFT
        </h1>
        <p className="text-[9px] font-mono tracking-[0.32em] text-rift-muted/55 uppercase mt-1">
          by abyssprotocol
        </p>
      </div>

      {/* Portal */}
      <Portal dragging={isDragging} hasFiles={stagedFiles.length > 0} />

      {/* File info */}
      {stagedFiles.length === 0 ? (
        <div className="text-center flex flex-col items-center gap-2">
          <p className="text-xs text-rift-muted/70">
            Drop files anywhere — or{" "}
            <button
              onClick={browse}
              className="text-rift-accent hover:text-rift-accent/80 underline-offset-2 hover:underline font-mono text-xs transition-colors"
            >
              browse
            </button>
          </p>
          <p className="text-[10px] font-mono text-rift-muted/40 tracking-wide">
            Any type · Any size
          </p>
        </div>
      ) : (
        <div className="glass-card rounded-2xl p-4 w-full max-w-xs animate-slide-up">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-semibold text-rift-text">
                {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""} staged
              </p>
              <p className="text-[10px] font-mono text-rift-muted mt-0.5">{fmt(totalBytes)}</p>
            </div>
            <button
              onClick={clearStaged}
              className="text-[10px] font-mono text-rift-error/70 hover:text-rift-error border border-rift-error/20 hover:border-rift-error/40 rounded-lg px-2 py-1 transition-all"
            >
              CLEAR
            </button>
          </div>
          <div className="max-h-20 overflow-y-auto">
            {stagedFiles.map((f, i) => (
              <p key={i} className="text-[10px] font-mono text-rift-muted/70 truncate py-0.5">
                {f.name}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Target */}
      {selectedDevice ? (
        <p className="text-[11px] font-mono text-rift-muted">
          Sending to{" "}
          <span className="text-rift-accent font-semibold">{selectedDevice.name}</span>
        </p>
      ) : (
        <p className="text-[11px] font-mono text-rift-muted/60">
          Select a device from the left panel
        </p>
      )}

      {/* Send button */}
      <button
        onClick={sendFiles}
        disabled={!canSend}
        className={`
          px-10 py-3 rounded-2xl font-mono text-sm font-bold tracking-[0.12em] uppercase
          transition-all duration-200
          ${canSend
            ? "bg-rift-accent text-rift-bg shadow-glow hover:shadow-glow-lg hover:scale-105 animate-glow-pulse"
            : "bg-rift-surface2 text-rift-muted/40 cursor-not-allowed border border-rift-border/30"}
        `}
      >
        {isSending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}