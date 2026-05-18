import { useCallback, useEffect, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false);
  const stagedFiles = useRiftStore((s) => s.stagedFiles);
  const setStagedFiles = useRiftStore((s) => s.setStagedFiles);
  const clearStagedFiles = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const isSending = useRiftStore((s) => s.isSending);
  const { sendFiles } = useTransferActions();
  const { call } = useInvoke();

  const totalBytes = stagedFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  const canSend = stagedFiles.length > 0 && selectedDevice !== null && !isSending;

  const stageFromPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const files = await call<StagedFile[]>("get_file_metadata", { paths });
        setStagedFiles(files);
      } catch (e) {
        console.error("get_file_metadata failed:", e);
      }
    },
    [call, setStagedFiles]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "drop") {
          setIsDragging(false);
          stageFromPaths(event.payload.paths ?? []);
        } else {
          setIsDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [stageFromPaths]);

  async function browseFiles() {
    try {
      const result = await open({ multiple: true, directory: false });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      await stageFromPaths(paths);
    } catch (e) {
      console.error("Browse files error:", e);
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
      <div className="mb-2 select-none">
        <h1 className="text-2xl font-mono font-bold text-rift-accent tracking-tight">
          THE RIFT
        </h1>
        <p className="text-xs text-rift-muted font-mono text-center tracking-widest">
          by abyssprotocol
        </p>
      </div>

      <div
        className={`
          w-full max-w-md aspect-[4/3] rounded-2xl border-2 border-dashed transition-all duration-200
          flex flex-col items-center justify-center gap-4 select-none
          ${
            isDragging
              ? "border-rift-accent bg-rift-accent/10 shadow-[0_0_40px_rgba(0,200,255,0.2)]"
              : stagedFiles.length > 0
              ? "border-rift-accent/60 bg-rift-surface"
              : "border-rift-border bg-rift-surface hover:border-rift-accent/30"
          }
        `}
      >
        {stagedFiles.length === 0 ? (
          <>
            <div className="text-4xl opacity-30">⤵</div>
            <p className="text-sm text-rift-muted text-center">Drop files here</p>
            <p className="text-xs text-rift-muted/60 text-center">
              Any file type. Any size.
            </p>
            <button
              onClick={browseFiles}
              className="mt-2 px-4 py-1.5 rounded-lg border border-rift-border text-xs text-rift-muted hover:border-rift-accent/40 hover:text-rift-accent transition-colors font-mono"
            >
              Browse Files
            </button>
          </>
        ) : (
          <>
            <div className="text-3xl">📦</div>
            <div className="text-center">
              <p className="text-rift-text font-medium text-sm">
                {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""} ready
              </p>
              <p className="text-rift-muted text-xs mt-1 font-mono">
                {formatBytes(totalBytes)}
              </p>
            </div>
            <div className="max-h-28 overflow-y-auto px-4 w-full">
              {stagedFiles.map((f, i) => (
                <p key={i} className="text-xs text-rift-muted truncate text-center">
                  {f.name}
                </p>
              ))}
            </div>
            <button
              onClick={clearStagedFiles}
              className="text-xs text-rift-error hover:text-rift-error/80 transition-colors"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {selectedDevice ? (
        <p className="text-xs text-rift-muted font-mono">
          Sending to{" "}
          <span className="text-rift-accent">{selectedDevice.name}</span>
        </p>
      ) : (
        <p className="text-xs text-rift-muted font-mono">
          Select a device from the left panel
        </p>
      )}

      <button
        onClick={sendFiles}
        disabled={!canSend}
        className={`
          px-8 py-3 rounded-lg font-mono text-sm font-semibold tracking-wide transition-all duration-150
          ${
            canSend
              ? "bg-rift-accent text-rift-bg hover:bg-rift-accentDim shadow-[0_0_20px_rgba(0,200,255,0.3)] hover:shadow-[0_0_30px_rgba(0,200,255,0.4)]"
              : "bg-rift-border text-rift-muted cursor-not-allowed"
          }
        `}
      >
        {isSending ? "SENDING…" : "SEND"}
      </button>
    </div>
  );
}