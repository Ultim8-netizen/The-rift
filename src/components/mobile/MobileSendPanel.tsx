// src/components/mobile/MobileSendPanel.tsx
import { useCallback, useMemo, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { Portal3D } from "@/components/Portal3D";
import { type StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { fmt, expandToPaths } from "@/utils/fileHelpers";

type TextStatus   = "idle" | "sending" | "sent" | "error";
type BrowserState = "closed" | "scanning" | "open";

// ── Main panel ────────────────────────────────────────────────────────────────

export function MobileSendPanel() {
  const [textMode,     setTextMode]     = useState(false);
  const [text,         setText]         = useState("");
  const [textStatus,   setTextStatus]   = useState<TextStatus>("idle");
  const [stageError,   setStageError]   = useState<string | null>(null);
  const [sendError,    setSendError]    = useState<string | null>(null);

  // isPicking: true while the system picker (pick_files_for_send) is in flight.
  // Covers the gap between the picker closing and the Tauri command resolving
  // so the UI shows a spinner instead of the empty browse button (eliminates
  // the brief flash back to the "Tap to browse" state after file selection).
  const [isPicking, setIsPicking] = useState(false);

  // In-app file browser (Android primary path)
  const [browserState,  setBrowserState]  = useState<BrowserState>("closed");
  const [scannedFiles,  setScannedFiles]  = useState<StagedFile[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [searchQuery,   setSearchQuery]   = useState("");

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

  const stageFromPaths = useCallback(async (rawPaths: string[]) => {
    if (!rawPaths.length) return;
    const filePaths = await expandToPaths(rawPaths);
    if (!filePaths.length) return;
    const files = await call<StagedFile[]>("get_file_metadata", { paths: filePaths });
    setStagedFiles(files);
  }, [call, setStagedFiles]);

  // ── System picker fallback ────────────────────────────────────────────────
  // Called when the in-app scanner returns empty, or directly on non-Android.
  // Sets isPicking = true BEFORE awaiting so the spinner appears immediately
  // when the app returns to foreground after the system picker closes.
  async function fallbackToSystemPicker() {
    setBrowserState("closed");
    setIsPicking(true);
    try {
      const files = await call<StagedFile[]>("pick_files_for_send");
      if (files && files.length > 0) {
        setStagedFiles(files);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStageError(msg);
    } finally {
      setIsPicking(false);
    }
  }

  // ── Primary browse handler ────────────────────────────────────────────────
  // Android: scan_android_files → in-app browser → fallback to system picker.
  // Desktop: tauri-plugin-dialog (unchanged).
  async function browse() {
    setStageError(null);
    setSendError(null);

    if (await platform() === "android") {
      setBrowserState("scanning");
      try {
        const files = await call<StagedFile[]>("scan_android_files");
        if (files && files.length > 0) {
          setScannedFiles(files);
          setSelectedPaths(new Set());
          setSearchQuery("");
          setBrowserState("open");
          return;
        }
        setBrowserState("closed");
      } catch {
        setBrowserState("closed");
      }

      await fallbackToSystemPicker();
      return;
    }

    // Desktop: tauri-plugin-dialog — unchanged.
    try {
      const res = await open({ multiple: true, directory: false });
      if (!res) return;
      await stageFromPaths(Array.isArray(res) ? res : [res]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStageError(msg);
    }
  }

  function confirmBrowserSelection() {
    const selected = scannedFiles.filter((f) => selectedPaths.has(f.path));
    if (selected.length > 0) setStagedFiles(selected);
    setBrowserState("closed");
  }

  async function handleSendFiles() {
    setSendError(null);
    try {
      await sendFiles();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendError(msg);
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
    <div style={{ width: "100vw", height: "100%", position: "relative", overflow: "hidden" }}>

      {/* ── Scrollable panel content ────────────────────────────────────────── */}
      <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>

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

          {/* Error banner */}
          {displayedError && (
            <div
              className="rounded-2xl px-4 py-3 flex items-start gap-3"
              style={{
                background: "rgb(var(--rift-error) / 0.1)",
                boxShadow:  "0 0 0 1px rgb(var(--rift-error) / 0.25)",
              }}
            >
              <span
                className="flex-shrink-0 text-[11px] font-mono font-bold mt-0.5"
                style={{ color: "rgb(var(--rift-error))" }}
              >
                ERR
              </span>
              <p
                className="text-[11px] font-mono leading-snug flex-1"
                style={{ color: "rgb(var(--rift-error) / 0.9)" }}
              >
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
                boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18), 0 0 22px rgb(var(--rift-glow) / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.04)",
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
                <p
                  className="text-sm font-semibold mt-0.5"
                  style={{ color: "rgb(var(--rift-accent))" }}
                >
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
                onClick={() => {
                  setTextMode(mode === "text");
                  setStageError(null);
                  setSendError(null);
                }}
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

          {/* ── FILES mode ── */}
          {!textMode && (
            <>
              {/* isPicking: system picker returned, waiting for cache copy + JNI result */}
              {isPicking ? (
                <div
                  className="w-full py-12 rounded-3xl flex flex-col items-center gap-4"
                  style={{
                    background:     "rgb(var(--rift-surface2) / 0.28)",
                    boxShadow:      "inset 0 2px 10px rgb(0 0 0 / 0.16)",
                    backdropFilter: "blur(16px)",
                  }}
                >
                  <div
                    className="animate-spin"
                    style={{
                      width:        38,
                      height:       38,
                      borderRadius: "50%",
                      border:       "2px solid rgb(var(--rift-accent) / 0.14)",
                      borderTop:    "2px solid rgb(var(--rift-accent))",
                    }}
                  />
                  <div className="text-center px-4">
                    <p
                      className="text-sm font-mono font-semibold"
                      style={{ color: "rgb(var(--rift-muted) / 0.65)" }}
                    >
                      Copying selected files…
                    </p>
                    <p
                      className="text-[10px] font-mono mt-1"
                      style={{ color: "rgb(var(--rift-muted) / 0.35)" }}
                    >
                      Large files may take a moment
                    </p>
                  </div>
                </div>
              ) : stagedFiles.length === 0 ? (
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
                    color:    "rgb(var(--rift-accent) / 0.42)",
                    filter:   "drop-shadow(0 0 16px rgb(var(--rift-glow) / 0.45))",
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

          {/* ── TEXT mode ── */}
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

      {/* ── In-app file browser overlay (Android primary path) ──────────────── */}
      {browserState !== "closed" && (
        <FileBrowser
          state={browserState}
          files={scannedFiles}
          selectedPaths={selectedPaths}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onToggle={(path) => {
            setSelectedPaths((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onSelectAll={() => {
            const q       = searchQuery.trim().toLowerCase();
            const visible = q
              ? scannedFiles.filter((f) => f.name.toLowerCase().includes(q))
              : scannedFiles;
            setSelectedPaths(new Set(visible.map((f) => f.path)));
          }}
          onDeselectAll={() => setSelectedPaths(new Set())}
          onConfirm={confirmBrowserSelection}
          onFallback={fallbackToSystemPicker}
          onClose={() => setBrowserState("closed")}
        />
      )}
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type FileGroup = {
  dir:   string;
  files: StagedFile[];
};

type FileBrowserProps = {
  state:          "scanning" | "open";
  files:          StagedFile[];
  selectedPaths:  Set<string>;
  searchQuery:    string;
  onSearchChange: (q: string) => void;
  onToggle:       (path: string) => void;
  onSelectAll:    () => void;
  onDeselectAll:  () => void;
  onConfirm:      () => void;
  onFallback:     () => Promise<void>;
  onClose:        () => void;
};

// ── FileBrowser ───────────────────────────────────────────────────────────────

function FileBrowser({
  state,
  files,
  selectedPaths,
  searchQuery,
  onSearchChange,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onConfirm,
  onFallback,
  onClose,
}: FileBrowserProps) {
  const groups = useMemo<FileGroup[]>(() => {
    const q        = searchQuery.trim().toLowerCase();
    const filtered = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;

    const map = new Map<string, StagedFile[]>();
    for (const f of filtered) {
      const segs    = f.path.split("/");
      const dirName = segs.length >= 2 ? (segs[segs.length - 2] || "Files") : "Files";
      if (!map.has(dirName)) map.set(dirName, []);
      map.get(dirName)!.push(f);
    }

    return Array.from(map.entries())
      .map(([dir, fileList]) => ({ dir, files: fileList }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }, [files, searchQuery]);

  const visibleCount       = groups.reduce((acc, g) => acc + g.files.length, 0);
  const selectedCount      = selectedPaths.size;
  const allVisibleSelected =
    visibleCount > 0 &&
    groups.every((g) => g.files.every((f) => selectedPaths.has(f.path)));
  const selectedSize = files
    .filter((f) => selectedPaths.has(f.path))
    .reduce((acc, f) => acc + f.sizeBytes, 0);

  return (
    <div style={{
      position:      "absolute",
      inset:         0,
      zIndex:        50,
      display:       "flex",
      flexDirection: "column",
      background:    "rgb(var(--rift-bg))",
      userSelect:    "none",
    }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        flexShrink:     0,
        padding:        "16px 16px 12px",
        background:     "rgb(var(--rift-surface) / 0.96)",
        backdropFilter: "blur(24px)",
        boxShadow:      "0 2px 20px rgb(0 0 0 / 0.22)",
      }}>
        <div style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          marginBottom:   state === "open" ? 10 : 0,
        }}>
          <div>
            <p style={{
              fontFamily:    "'JetBrains Mono', monospace",
              fontSize:      13,
              fontWeight:    700,
              letterSpacing: "0.05em",
              color:         "rgb(var(--rift-text))",
              margin:        0,
            }}>
              Select Files
            </p>
            {state === "open" && (
              <p style={{
                fontFamily:    "'JetBrains Mono', monospace",
                fontSize:      9,
                letterSpacing: "0.18em",
                color:         "rgb(var(--rift-muted) / 0.4)",
                marginTop:     2,
                textTransform: "uppercase" as const,
              }}>
                {files.length.toLocaleString()} file{files.length !== 1 ? "s" : ""} found on device
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              width:          32,
              height:         32,
              borderRadius:   "10px",
              background:     "rgb(var(--rift-surface2) / 0.7)",
              boxShadow:      "0 0 0 1px rgb(255 255 255 / 0.07)",
              color:          "rgb(var(--rift-muted) / 0.7)",
              fontSize:       14,
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              flexShrink:     0,
              cursor:         "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {state === "open" && (
          <div style={{
            display:      "flex",
            alignItems:   "center",
            gap:          8,
            background:   "rgb(var(--rift-surface2) / 0.52)",
            borderRadius: 12,
            padding:      "8px 12px",
            boxShadow:    "inset 0 2px 8px rgb(0 0 0 / 0.12)",
          }}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0, opacity: 0.35 }}>
              <circle cx="5.5" cy="5.5" r="4" stroke="rgb(var(--rift-muted))" strokeWidth="1.2" />
              <line x1="8.5" y1="8.5" x2="12" y2="12" stroke="rgb(var(--rift-muted))" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search files…"
              style={{
                flex:       1,
                background: "transparent",
                border:     "none",
                outline:    "none",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize:   12,
                color:      "rgb(var(--rift-text))",
                caretColor: "rgb(var(--rift-accent))",
                userSelect: "text",
              } as React.CSSProperties}
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange("")}
                style={{ color: "rgb(var(--rift-muted) / 0.45)", fontSize: 12, flexShrink: 0, cursor: "pointer" }}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {state === "scanning" ? (
        <div style={{
          flex:           1,
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "center",
          gap:            18,
        }}>
          <div
            className="animate-spin"
            style={{
              width:        38,
              height:       38,
              borderRadius: "50%",
              border:       "2px solid rgb(var(--rift-accent) / 0.12)",
              borderTop:    "2px solid rgb(var(--rift-accent))",
            }}
          />
          <div style={{ textAlign: "center" }}>
            <p style={{
              fontFamily:    "'JetBrains Mono', monospace",
              fontSize:      12,
              color:         "rgb(var(--rift-muted) / 0.58)",
              letterSpacing: "0.05em",
              margin:        0,
            }}>
              Scanning device storage…
            </p>
            <p style={{
              fontFamily:    "'JetBrains Mono', monospace",
              fontSize:      10,
              color:         "rgb(var(--rift-muted) / 0.28)",
              letterSpacing: "0.1em",
              marginTop:     5,
            }}>
              Checking known directories
            </p>
          </div>
        </div>

      ) : groups.length === 0 ? (
        <div style={{
          flex:           1,
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "center",
          gap:            12,
          padding:        "0 32px",
          textAlign:      "center",
        }}>
          <p style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize:   12,
            color:      "rgb(var(--rift-muted) / 0.44)",
            margin:     0,
          }}>
            {searchQuery ? "No files match your search" : "No files found"}
          </p>
          {searchQuery && (
            <button
              onClick={() => onSearchChange("")}
              style={{
                fontFamily:    "'JetBrains Mono', monospace",
                fontSize:      11,
                color:         "rgb(var(--rift-accent))",
                letterSpacing: "0.06em",
                cursor:        "pointer",
              }}
            >
              Clear search
            </button>
          )}
        </div>

      ) : (
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {groups.map(({ dir, files: groupFiles }) => (
            <div key={dir}>
              <p style={{
                padding:       "10px 16px 3px",
                fontFamily:    "'JetBrains Mono', monospace",
                fontSize:      9,
                letterSpacing: "0.22em",
                textTransform: "uppercase" as const,
                color:         "rgb(var(--rift-muted) / 0.3)",
                margin:        0,
              }}>
                {dir}
              </p>

              {groupFiles.map((f) => {
                const sel = selectedPaths.has(f.path);
                return (
                  <div
                    key={f.path}
                    onClick={() => onToggle(f.path)}
                    style={{
                      display:    "flex",
                      alignItems: "center",
                      gap:        12,
                      padding:    "10px 16px",
                      cursor:     "pointer",
                      background: sel ? "rgb(var(--rift-accent) / 0.065)" : "transparent",
                      transition: "background 0.1s",
                    }}
                  >
                    <div style={{
                      width:          18,
                      height:         18,
                      borderRadius:   "50%",
                      flexShrink:     0,
                      background:     sel ? "rgb(var(--rift-accent))" : "transparent",
                      boxShadow:      sel
                        ? "0 0 10px rgb(var(--rift-glow) / 0.45)"
                        : "0 0 0 1.5px rgb(var(--rift-muted) / 0.2) inset",
                      display:        "flex",
                      alignItems:     "center",
                      justifyContent: "center",
                      transition:     "all 0.15s",
                    }}>
                      {sel && (
                        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                          <path
                            d="M1 3.5L3.5 6L8 1"
                            stroke="white"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>

                    <p style={{
                      flex:         1,
                      minWidth:     0,
                      fontFamily:   "'JetBrains Mono', monospace",
                      fontSize:     11,
                      color:        sel ? "rgb(var(--rift-accent))" : "rgb(var(--rift-text) / 0.8)",
                      overflow:     "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace:   "nowrap",
                      transition:   "color 0.12s",
                      margin:       0,
                    }}>
                      {f.name}
                    </p>

                    <p style={{
                      fontFamily:    "'JetBrains Mono', monospace",
                      fontSize:      9,
                      color:         "rgb(var(--rift-muted) / 0.36)",
                      flexShrink:    0,
                      letterSpacing: "0.03em",
                      margin:        0,
                    }}>
                      {fmt(f.sizeBytes)}
                    </p>
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{ height: 130 }} />
        </div>
      )}

      {/* ── Footer (open state only) ────────────────────────────────────────── */}
      {state === "open" && (
        <div style={{
          flexShrink:     0,
          padding:        "12px 16px 28px",
          background:     "rgb(var(--rift-surface) / 0.96)",
          backdropFilter: "blur(24px)",
          boxShadow:      "0 -2px 20px rgb(0 0 0 / 0.2)",
        }}>
          {selectedCount > 0 && (
            <p style={{
              fontFamily:    "'JetBrains Mono', monospace",
              fontSize:      10,
              color:         "rgb(var(--rift-muted) / 0.48)",
              letterSpacing: "0.07em",
              textAlign:     "center",
              margin:        "0 0 10px",
            }}>
              {selectedCount} file{selectedCount !== 1 ? "s" : ""} · {fmt(selectedSize)}
            </p>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={allVisibleSelected ? onDeselectAll : onSelectAll}
              style={{
                flexShrink:    0,
                padding:       "12px 14px",
                borderRadius:  14,
                fontFamily:    "'JetBrains Mono', monospace",
                fontSize:      9,
                fontWeight:    700,
                letterSpacing: "0.12em",
                textTransform: "uppercase" as const,
                color:         allVisibleSelected
                  ? "rgb(var(--rift-accent) / 0.85)"
                  : "rgb(var(--rift-muted) / 0.55)",
                background:    "rgb(var(--rift-surface2) / 0.55)",
                boxShadow:     allVisibleSelected
                  ? "0 0 0 1px rgb(var(--rift-accent) / 0.25)"
                  : "0 0 0 1px rgb(255 255 255 / 0.05)",
                whiteSpace:    "nowrap" as const,
                cursor:        "pointer",
                transition:    "all 0.15s",
              }}
            >
              {allVisibleSelected ? "None" : "All"}
            </button>

            <button
              onClick={selectedCount > 0 ? onConfirm : undefined}
              disabled={selectedCount === 0}
              style={{
                flex:          1,
                padding:       "12px 16px",
                borderRadius:  14,
                fontFamily:    "'JetBrains Mono', monospace",
                fontSize:      12,
                fontWeight:    700,
                letterSpacing: "0.09em",
                textTransform: "uppercase" as const,
                color:         selectedCount > 0
                  ? "rgb(var(--rift-bg))"
                  : "rgb(var(--rift-muted) / 0.3)",
                background:    selectedCount > 0
                  ? "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))"
                  : "rgb(var(--rift-surface2) / 0.42)",
                boxShadow:     selectedCount > 0
                  ? "0 0 28px rgb(var(--rift-glow) / 0.36), 0 0 0 1px rgb(var(--rift-accent) / 0.3), inset 0 1px 0 rgb(255 255 255 / 0.16)"
                  : "none",
                cursor:        selectedCount > 0 ? "pointer" : "not-allowed",
                transition:    "all 0.2s",
              }}
            >
              {selectedCount > 0
                ? `Use ${selectedCount} file${selectedCount !== 1 ? "s" : ""}`
                : "Select files above"}
            </button>
          </div>

          <button
            onClick={() => { void onFallback(); }}
            style={{
              display:       "block",
              width:         "100%",
              marginTop:     10,
              padding:       "8px",
              fontFamily:    "'JetBrains Mono', monospace",
              fontSize:      10,
              letterSpacing: "0.1em",
              color:         "rgb(var(--rift-muted) / 0.28)",
              textAlign:     "center",
              textTransform: "uppercase" as const,
              cursor:        "pointer",
            }}
          >
            Use system picker instead →
          </button>
        </div>
      )}
    </div>
  );
}