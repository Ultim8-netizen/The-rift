// src/components/mobile/MobileSendPanel.tsx
import { useCallback, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { Portal3D } from "@/components/Portal3D";
import { type StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { fmt, expandToPaths } from "@/utils/fileHelpers";

type TextStatus = "idle" | "sending" | "sent" | "error";

export function MobileSendPanel() {
  const [textMode,   setTextMode]   = useState(false);
  const [text,       setText]       = useState("");
  const [textStatus, setTextStatus] = useState<TextStatus>("idle");
  const [stageError, setStageError] = useState<string | null>(null);
  const [sendError,  setSendError]  = useState<string | null>(null);

  const stagedFiles    = useRiftStore((s) => s.stagedFiles);
  const setStagedFiles = useRiftStore((s) => s.setStagedFiles);
  const clearStaged    = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const isSending      = useRiftStore((s) => s.isSending);

  const { call }                = useInvoke();
  const { sendFiles, sendText } = useTransferActions();

  const totalBytes   = stagedFiles.reduce((s, f) => s + f.sizeBytes, 0);
  const canSendFiles = stagedFiles.length > 0 && !!selectedDevice && !isSending;
  const canSendText  = text.trim().length > 0 && !!selectedDevice && textStatus !== "sending";

  // No try/catch here — errors propagate to callers (browse / handleSendFiles)
  const stageFromPaths = useCallback(async (rawPaths: string[]) => {
    if (!rawPaths.length) return;
    const filePaths = await expandToPaths(rawPaths);
    if (!filePaths.length) return;
    const files = await call<StagedFile[]>("get_file_metadata", { paths: filePaths });
    setStagedFiles(files);
  }, [call, setStagedFiles]);

  async function browse() {
    setStageError(null);
    setSendError(null);
    try {
      const res = await open({ multiple: true, directory: false });
      if (!res) return;
      await stageFromPaths(Array.isArray(res) ? res : [res]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStageError(msg);
      console.error("[MobileSendPanel] stageFromPaths error:", e);
    }
  }

  async function handleSendFiles() {
    setSendError(null);
    try {
      await sendFiles();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendError(msg);
      console.error("[MobileSendPanel] sendFiles error:", e);
    }
  }

  async function handleSendText() {
    if (!canSendText) return;
    setTextStatus("sending");
    try {
      await sendText(text);
      setTextStatus("sent");
      setText("");
      setTimeout(() => setTextStatus("idle"), 2200);
    } catch {
      setTextStatus("error");
      setTimeout(() => setTextStatus("idle"), 3000);
    }
  }

  const displayedError = stageError ?? sendError;

  return (
    <div style={{ width: "100vw", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {/* Portal3D hero */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8 }}>
        <p
          className="text-[8px] font-mono uppercase tracking-[0.32em] mb-1"
          style={{ color: "rgb(var(--rift-muted) / 0.3)" }}
        >
          Transfer
        </p>
        <Portal3D
          dragging={false}
          hasFiles={stagedFiles.length > 0}
          isSending={isSending}
          isMobile={true}
        />
      </div>

      <div className="px-4 flex flex-col gap-4 pb-10">

        {/* ── Error banner ── */}
        {displayedError && (
          <div
            className="rounded-2xl px-4 py-3 flex items-start gap-3"
            style={{
              background: "rgb(var(--rift-error) / 0.1)",
              boxShadow: "0 0 0 1px rgb(var(--rift-error) / 0.25)",
            }}
          >
            <span
              className="flex-shrink-0 text-[11px] font-mono font-bold mt-0.5"
              style={{ color: "rgb(var(--rift-error))" }}
            >
              ERR
            </span>
            <p className="text-[11px] font-mono leading-snug flex-1" style={{ color: "rgb(var(--rift-error) / 0.9)" }}>
              {displayedError}
            </p>
            <button
              onClick={() => { setStageError(null); setSendError(null); }}
              className="flex-shrink-0 text-[10px] font-mono"
              style={{ color: "rgb(var(--rift-error) / 0.55)" }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Target device indicator */}
        {selectedDevice ? (
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-2xl"
            style={{
              background: "rgb(var(--rift-accent) / 0.07)",
              boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.18), 0 0 22px rgb(var(--rift-glow) / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.04)",
            }}
          >
            <span className="status-dot-live" />
            <div>
              <p
                className="text-[9px] font-mono uppercase tracking-widest"
                style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
              >
                Sending to
              </p>
              <p className="text-sm font-semibold mt-0.5" style={{ color: "rgb(var(--rift-accent))" }}>
                {selectedDevice.name}
              </p>
            </div>
          </div>
        ) : (
          <div
            className="px-4 py-3.5 rounded-2xl text-center"
            style={{
              background: "rgb(var(--rift-surface2) / 0.28)",
              boxShadow:  "inset 0 2px 8px rgb(0 0 0 / 0.12)",
            }}
          >
            <p className="text-[11px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>
              ← Swipe left to Devices and select a target
            </p>
          </div>
        )}

        {/* Files / Text mode toggle */}
        <div
          className="flex rounded-2xl p-1"
          style={{
            background: "rgb(var(--rift-surface2) / 0.42)",
            boxShadow:  "inset 0 2px 8px rgb(0 0 0 / 0.16)",
          }}
        >
          {(["files", "text"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => { setTextMode(mode === "text"); setStageError(null); setSendError(null); }}
              className="flex-1 py-2.5 rounded-xl text-[10px] font-mono font-bold uppercase tracking-widest transition-all duration-150"
              style={{
                background: (mode === "text") === textMode
                  ? "rgb(var(--rift-accent) / 0.14)"
                  : "transparent",
                color: (mode === "text") === textMode
                  ? "rgb(var(--rift-accent))"
                  : "rgb(var(--rift-muted) / 0.48)",
                boxShadow: (mode === "text") === textMode
                  ? "0 0 0 1px rgb(var(--rift-accent) / 0.26), 0 0 16px rgb(var(--rift-glow) / 0.09)"
                  : "none",
              }}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* ── FILES ── */}
        {!textMode && (
          <>
            {stagedFiles.length === 0 ? (
              <button
                onClick={browse}
                className="w-full py-12 rounded-3xl flex flex-col items-center gap-3 active:scale-[0.98] transition-transform duration-150"
                style={{
                  background:     "rgb(var(--rift-surface2) / 0.28)",
                  boxShadow:      "0 0 0 1.5px rgb(var(--rift-accent) / 0.1) inset, 0 4px 20px rgb(0 0 0 / 0.2), inset 0 1px 0 rgb(255 255 255 / 0.04)",
                  backdropFilter: "blur(16px)",
                }}
              >
                <span style={{
                  fontSize: "2rem",
                  color: "rgb(var(--rift-accent) / 0.42)",
                  filter: "drop-shadow(0 0 16px rgb(var(--rift-glow) / 0.45))",
                }}>
                  ⤵
                </span>
                <div className="text-center">
                  <p className="text-sm font-mono font-semibold" style={{ color: "rgb(var(--rift-muted) / 0.62)" }}>
                    Tap to browse files
                  </p>
                  <p className="text-[10px] font-mono mt-1" style={{ color: "rgb(var(--rift-muted) / 0.32)" }}>
                    Any type · Any size
                  </p>
                </div>
              </button>
            ) : (
              <div
                className="rounded-2xl p-4"
                style={{
                  background:     "rgb(var(--rift-surface2) / 0.44)",
                  backdropFilter: "blur(20px)",
                  boxShadow:      "0 2px 14px rgb(0 0 0 / 0.2), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)",
                }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "rgb(var(--rift-text))" }}>
                      {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""}
                    </p>
                    <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-muted) / 0.58)" }}>
                      {fmt(totalBytes)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={browse}
                      className="text-[10px] font-mono px-3 py-1.5 rounded-full"
                      style={{
                        color:      "rgb(var(--rift-accent) / 0.85)",
                        background: "rgb(var(--rift-accent) / 0.08)",
                        boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
                      }}
                    >
                      + Add
                    </button>
                    <button
                      onClick={() => { clearStaged(); setStageError(null); setSendError(null); }}
                      className="text-[10px] font-mono px-3 py-1.5 rounded-full"
                      style={{
                        color:      "rgb(var(--rift-error) / 0.8)",
                        background: "rgb(var(--rift-error) / 0.08)",
                        boxShadow:  "0 0 0 1px rgb(var(--rift-error) / 0.16)",
                      }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div style={{ maxHeight: "7rem", overflowY: "auto" }}>
                  {stagedFiles.map((f, i) => (
                    <p
                      key={i}
                      className="text-[10px] font-mono truncate py-0.5"
                      style={{ color: "rgb(var(--rift-muted) / 0.58)" }}
                    >
                      {f.name}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={handleSendFiles}
              disabled={!canSendFiles}
              className="w-full py-4 rounded-2xl font-mono text-sm font-bold tracking-[0.1em] uppercase transition-all duration-200 btn-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
            >
              {isSending ? "Sending…" : "Send Through"}
            </button>
          </>
        )}

        {/* ── TEXT ── */}
        {textMode && (
          <>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (textStatus !== "idle") setTextStatus("idle");
              }}
              placeholder="Type or paste text to send…"
              rows={8}
              className="w-full resize-none rounded-2xl p-4 font-mono text-sm leading-relaxed focus:outline-none transition-all"
              style={{
                background:     "rgb(var(--rift-surface2) / 0.44)",
                backdropFilter: "blur(20px)",
                color:          "rgb(var(--rift-text))",
                boxShadow:      "inset 0 2px 10px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(var(--rift-border) / 0.42)",
                caretColor:     "rgb(var(--rift-accent))",
              }}
            />
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.38)" }}>
                {text.length} chars
              </span>
              <button
                onClick={async () => {
                  const t = await navigator.clipboard.readText().catch(() => "");
                  if (t) setText((p) => p + t);
                }}
                className="text-[10px] font-mono px-3 py-1.5 rounded-full transition-all"
                style={{
                  color:      "rgb(var(--rift-muted) / 0.62)",
                  background: "rgb(var(--rift-surface2) / 0.5)",
                  boxShadow:  "0 0 0 1px rgb(255 255 255 / 0.05)",
                }}
              >
                Paste
              </button>
            </div>
            <button
              onClick={handleSendText}
              disabled={!canSendText}
              className="w-full py-4 rounded-2xl font-mono text-sm font-bold tracking-[0.1em] uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: textStatus === "sent"  ? "rgb(var(--rift-success))"
                          : textStatus === "error" ? "rgb(var(--rift-error))"
                          : canSendText
                          ? "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))"
                          : "rgb(var(--rift-surface2) / 0.42)",
                color: canSendText || textStatus !== "idle"
                  ? "rgb(var(--rift-bg))"
                  : "rgb(var(--rift-muted) / 0.48)",
                boxShadow: canSendText && textStatus === "idle"
                  ? "0 0 30px rgb(var(--rift-glow) / 0.4), 0 0 0 1px rgb(var(--rift-accent) / 0.35), inset 0 1px 0 rgb(255 255 255 / 0.2)"
                  : "none",
              }}
            >
              {textStatus === "sending" ? "Sending…"
               : textStatus === "sent"  ? "Sent ✓"
               : textStatus === "error" ? "Failed ✗"
               : "Send Text"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}