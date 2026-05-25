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

function Portal({
  dragging,
  hasFiles,
  isSending,
}: {
  dragging: boolean;
  hasFiles: boolean;
  isSending: boolean;
}) {
  const scale = dragging ? 1.08 : hasFiles ? 1.03 : 1;
  const state = dragging ? "drop" : isSending ? "send" : hasFiles ? "ready" : "idle";

  const orbGlow = {
    idle:  "0 0 60px rgb(var(--rift-accent) / 0.12), 0 0 120px rgb(var(--rift-glow) / 0.06)",
    ready: "0 0 80px rgb(var(--rift-accent) / 0.2), 0 0 160px rgb(var(--rift-glow) / 0.1)",
    drop:  "0 0 100px rgb(var(--rift-accent) / 0.35), 0 0 200px rgb(var(--rift-glow) / 0.18)",
    send:  "0 0 90px rgb(var(--rift-accent2) / 0.3), 0 0 180px rgb(var(--rift-accent2) / 0.12)",
  }[state];

  return (
    <div
      className="relative flex items-center justify-center"
      style={{
        width: "220px",
        height: "220px",
        transform: `scale(${scale})`,
        transition: "transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(ellipse at center,
            rgb(var(--rift-accent) / ${dragging ? "0.08" : "0.04"}) 0%,
            transparent 65%
          )`,
          boxShadow: orbGlow,
          transition: "all 0.5s ease",
        }}
      />
      <div
        className="absolute rounded-full animate-spin-slowest"
        style={{
          inset: "0px",
          background: "transparent",
          boxShadow: `0 0 0 1px rgb(var(--rift-accent) / ${dragging ? "0.22" : "0.1"}), 0 0 12px rgb(var(--rift-glow) / 0.08)`,
          transition: "box-shadow 0.4s ease",
        }}
      />
      <div
        className="absolute rounded-full animate-spin-slower"
        style={{
          inset: "20px",
          background: "transparent",
          boxShadow: `0 0 0 1px rgb(var(--rift-accent2) / ${dragging ? "0.3" : "0.12"}), 0 0 16px rgb(var(--rift-accent2) / 0.06)`,
          animationDirection: "reverse",
          transition: "box-shadow 0.4s ease",
        }}
      />
      <div
        className="absolute rounded-full animate-spin-slow"
        style={{
          inset: "40px",
          background: "transparent",
          boxShadow: `0 0 0 1.5px rgb(var(--rift-accent) / ${dragging ? "0.45" : "0.2"}), 0 0 20px rgb(var(--rift-glow) / 0.1)`,
          transition: "box-shadow 0.4s ease",
        }}
      />
      <div
        className="absolute rounded-full animate-ring-breathe"
        style={{
          inset: "30px",
          background: "transparent",
          boxShadow: `0 0 0 1px rgb(var(--rift-accent) / 0.08), 0 0 30px rgb(var(--rift-glow) / 0.06)`,
        }}
      />
      <div
        className="relative rounded-full flex flex-col items-center justify-center"
        style={{
          width: "90px",
          height: "90px",
          background: dragging
            ? `radial-gradient(circle at 35% 30%, rgb(var(--rift-accent) / 0.35) 0%, rgb(var(--rift-surface) / 0.95) 60%)`
            : state === "send"
            ? `radial-gradient(circle at 35% 30%, rgb(var(--rift-accent2) / 0.3) 0%, rgb(var(--rift-surface) / 0.95) 60%)`
            : `radial-gradient(circle at 35% 30%, rgb(var(--rift-accent) / 0.2) 0%, rgb(var(--rift-surface) / 0.92) 60%)`,
          boxShadow: `
            0 8px 32px rgb(0 0 0 / 0.5),
            0 0 0 1px rgb(var(--rift-accent) / ${dragging ? "0.4" : "0.18"}),
            0 0 ${dragging ? "50" : "28"}px rgb(var(--rift-glow) / ${dragging ? "0.35" : "0.15"}),
            inset 0 1px 0 rgb(255 255 255 / 0.1)
          `,
          backdropFilter: "blur(24px)",
          transition: "all 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {dragging ? (
          <>
            <span
              className="text-2xl font-mono font-black leading-none animate-float"
              style={{
                background:
                  "linear-gradient(145deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              ↓
            </span>
            <span
              className="text-[9px] font-mono font-bold mt-1 tracking-widest"
              style={{ color: "rgb(var(--rift-accent) / 0.8)" }}
            >
              DROP
            </span>
          </>
        ) : state === "send" ? (
          <span
            className="text-[10px] font-mono font-bold tracking-widest"
            style={{ color: "rgb(var(--rift-accent2))" }}
          >
            SENDING
          </span>
        ) : state === "ready" ? (
          <span
            className="text-[11px] font-mono font-bold tracking-[0.12em]"
            style={{ color: "rgb(var(--rift-accent))" }}
          >
            READY
          </span>
        ) : (
          <>
            <span
              className="text-2xl font-mono font-black leading-none"
              style={{
                background:
                  "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                filter: "drop-shadow(0 0 8px rgb(var(--rift-glow) / 0.4))",
              }}
            >
              ◈
            </span>
            <span
              className="text-[9px] font-mono mt-0.5 tracking-[0.2em]"
              style={{ color: "rgb(var(--rift-muted) / 0.6)" }}
            >
              RIFT
            </span>
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
  const setStickyNote  = useRiftStore((s) => s.setStickyNoteOpen);
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
            background:
              "linear-gradient(125deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
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

      {/* Portal */}
      <Portal
        dragging={isDragging}
        hasFiles={stagedFiles.length > 0}
        isSending={isSending}
      />

      {/* File info / drop prompt */}
      {stagedFiles.length === 0 ? (
        <div className="text-center flex flex-col items-center gap-2">
          <p className="text-xs" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
            Drop files anywhere — or{" "}
            <button
              onClick={browse}
              className="font-mono text-xs transition-colors"
              style={{ color: "rgb(var(--rift-accent))" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  "rgb(var(--rift-accent2))";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  "rgb(var(--rift-accent))";
              }}
            >
              browse
            </button>
          </p>
          <p
            className="text-[10px] font-mono tracking-wide"
            style={{ color: "rgb(var(--rift-muted) / 0.35)" }}
          >
            Any type · Any size
          </p>
        </div>
      ) : (
        <div
          className="rounded-2xl p-4 w-full max-w-xs animate-slide-up"
          style={{
            background: "rgb(var(--rift-surface2) / 0.5)",
            backdropFilter: "blur(20px)",
            boxShadow:
              "0 2px 12px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-semibold text-rift-text">
                {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""} staged
              </p>
              <p
                className="text-[10px] font-mono mt-0.5"
                style={{ color: "rgb(var(--rift-muted) / 0.7)" }}
              >
                {fmt(totalBytes)}
              </p>
            </div>
            <button
              onClick={clearStaged}
              className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all"
              style={{
                color: "rgb(var(--rift-error) / 0.75)",
                background: "rgb(var(--rift-error) / 0.08)",
                boxShadow: "0 0 0 1px rgb(var(--rift-error) / 0.15)",
              }}
            >
              CLEAR
            </button>
          </div>
          <div className="max-h-20 overflow-y-auto">
            {stagedFiles.map((f, i) => (
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
      )}

      {/* Target device indicator */}
      {selectedDevice ? (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-full"
          style={{
            background: "rgb(var(--rift-accent) / 0.07)",
            boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
          }}
        >
          <span className="status-dot-live" style={{ width: "5px", height: "5px" }} />
          <span
            className="text-[11px] font-mono"
            style={{ color: "rgb(var(--rift-muted) / 0.8)" }}
          >
            Sending to{" "}
            <span style={{ color: "rgb(var(--rift-accent))", fontWeight: 600 }}>
              {selectedDevice.name}
            </span>
          </span>
        </div>
      ) : (
        <p
          className="text-[11px] font-mono"
          style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
        >
          Select a device from the left panel
        </p>
      )}

      {/* Action row */}
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

        <button
          data-tour="text-btn"
          onClick={() => setStickyNote(true)}
          title="Send text"
          className="flex items-center justify-center rounded-2xl transition-all duration-200"
          style={{
            width: "44px",
            height: "44px",
            background: "rgb(var(--rift-surface2) / 0.55)",
            boxShadow:
              "0 0 0 1px rgb(255 255 255 / 0.06), 0 2px 8px rgb(0 0 0 / 0.25)",
            backdropFilter: "blur(12px)",
            flexShrink: 0,
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
      </div>
    </div>
  );
}