import { useState, useCallback } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { AcceptDialog } from "./AcceptDialog";
import { IncomingTextDialog } from "./IncomingTextDialog";
import { DevicePopup } from "./DevicePopup";

type Tab = "devices" | "send" | "transfers";

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

function fmtEta(sec: number | null): string {
  if (sec === null) return "";
  return sec < 60 ? `${Math.ceil(sec)}s` : `${Math.ceil(sec / 60)}m`;
}

// ── Device row ────────────────────────────────────────────────────────────────

function MobileDeviceRow({ deviceId }: { deviceId: string }) {
  const device          = useRiftStore((s) => s.devices.find((d) => d.id === deviceId));
  const selectedDevice  = useRiftStore((s) => s.selectedDevice);
  const selectDevice    = useRiftStore((s) => s.selectDevice);
  const riftedDevices   = useRiftStore((s) => s.riftedDevices);
  const reconnecting    = useRiftStore((s) => s.reconnectingDevices);
  const setDevicePopup  = useRiftStore((s) => s.setDevicePopup);

  if (!device) return null;

  const isSelected     = selectedDevice?.id === device.id;
  const isRifted       = riftedDevices.includes(device.id);
  const isReconnecting = reconnecting.includes(device.id);

  const OS_LABELS: Record<string, string> = {
    windows: "WIN", macos: "MAC", linux: "NIX", android: "AND", unknown: "SYS",
  };

  return (
    <button
      onClick={() => isSelected ? setDevicePopup(device) : selectDevice(device)}
      className="w-full text-left rounded-2xl p-4 transition-all duration-200"
      style={{
        background: isSelected
          ? "rgb(var(--rift-accent) / 0.1)"
          : "rgb(var(--rift-surface2) / 0.5)",
        boxShadow: isSelected
          ? "0 0 0 1px rgb(var(--rift-accent) / 0.45), 0 0 24px rgb(var(--rift-glow) / 0.15)"
          : "0 2px 10px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04)",
      }}
    >
      <div className="flex items-center gap-3">
        {/* OS badge */}
        <span
          className="text-[10px] font-mono font-bold px-2 py-1.5 rounded-xl flex-shrink-0"
          style={{
            color: "rgb(var(--rift-accent) / 0.85)",
            background: "rgb(var(--rift-accent) / 0.1)",
          }}
        >
          {OS_LABELS[device.os] ?? "SYS"}
        </span>

        {/* Name + IP */}
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-semibold truncate"
            style={{ color: isSelected ? "rgb(var(--rift-accent))" : "rgb(var(--rift-text))" }}
          >
            {device.name}
          </p>
          <p className="text-[11px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
            {device.ip}
            {device.latencyMs !== null && ` · ${device.latencyMs}ms`}
          </p>
        </div>

        {/* Connection status */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span
            className="w-2 h-2 rounded-full"
            style={{
              background: isRifted
                ? "rgb(var(--rift-success))"
                : isReconnecting
                ? "rgb(var(--rift-warning))"
                : "rgb(var(--rift-muted) / 0.35)",
              boxShadow: isRifted
                ? "0 0 8px rgb(var(--rift-success) / 0.6)"
                : "none",
            }}
          />
          {isSelected && (
            <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
              SELECTED
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Main layout ───────────────────────────────────────────────────────────────

export function MobileLayout() {
  const [tab, setTab]               = useState<Tab>("devices");
  const [textMode, setTextMode]     = useState(false);
  const [text, setText]             = useState("");
  const [textStatus, setTextStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const devices        = useRiftStore((s) => s.devices);
  const transfers      = useRiftStore((s) => s.transfers);
  const stagedFiles    = useRiftStore((s) => s.stagedFiles);
  const setStagedFiles = useRiftStore((s) => s.setStagedFiles);
  const clearStaged    = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const ownDeviceName  = useRiftStore((s) => s.ownDeviceName);
  const networkStatus  = useRiftStore((s) => s.networkStatus);
  const isSending      = useRiftStore((s) => s.isSending);

  const { call }               = useInvoke();
  const { sendFiles, sendText } = useTransferActions();

  const totalBytes   = stagedFiles.reduce((s, f) => s + f.sizeBytes, 0);
  const canSendFiles = stagedFiles.length > 0 && !!selectedDevice && !isSending;
  const canSendText  = text.trim().length > 0 && !!selectedDevice && textStatus !== "sending";

  const stageFromPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const files = await call<StagedFile[]>("get_file_metadata", { paths });
      setStagedFiles(files);
    } catch (e) { console.error(e); }
  }, [call, setStagedFiles]);

  async function browse() {
    try {
      const res = await open({ multiple: true, directory: false });
      if (!res) return;
      await stageFromPaths(Array.isArray(res) ? res : [res]);
    } catch (e) { console.error(e); }
  }

  async function handleSendText() {
    if (!canSendText) return;
    setTextStatus("sending");
    try {
      await sendText(text);
      setTextStatus("sent");
      setText("");
      setTimeout(() => setTextStatus("idle"), 2000);
    } catch {
      setTextStatus("error");
      setTimeout(() => setTextStatus("idle"), 3000);
    }
  }

  const STATUS_DOT: Record<string, string> = {
    searching: "rgb(var(--rift-warning))",
    connected: "rgb(var(--rift-success))",
    hotspot:   "rgb(var(--rift-accent))",
    offline:   "rgb(var(--rift-error))",
  };

  const activeTransfers = transfers.filter((t) => t.status === "transferring").length;

  return (
    <div
      className="h-screen flex flex-col overflow-hidden font-sans text-rift-text select-none"
      style={{ background: "rgb(var(--rift-bg))" }}
    >
      {/* ── Header ── */}
      <div
        className="flex-shrink-0 flex items-center justify-between px-5 py-4"
        style={{
          background: "rgb(var(--rift-surface) / 0.85)",
          backdropFilter: "blur(40px)",
          boxShadow: "0 1px 0 rgb(255 255 255 / 0.05), 0 4px 20px rgb(0 0 0 / 0.3)",
        }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{
              background: STATUS_DOT[networkStatus] ?? "rgb(var(--rift-muted))",
              boxShadow: networkStatus === "connected"
                ? "0 0 8px rgb(var(--rift-success) / 0.6)"
                : networkStatus === "searching"
                ? "0 0 8px rgb(var(--rift-warning) / 0.4)"
                : "none",
            }}
          />
          <h1
            className="text-lg font-black tracking-[-0.03em] font-mono"
            style={{
              background: "linear-gradient(120deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            THE RIFT
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {selectedDevice && (
            <span
              className="text-[10px] font-mono px-2.5 py-1 rounded-full"
              style={{
                color: "rgb(var(--rift-accent))",
                background: "rgb(var(--rift-accent) / 0.1)",
                boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)",
              }}
            >
              → {selectedDevice.name}
            </span>
          )}
          <span
            className="text-[10px] font-mono"
            style={{ color: "rgb(var(--rift-muted) / 0.55)" }}
          >
            {ownDeviceName}
          </span>
        </div>
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto">

        {/* DEVICES */}
        {tab === "devices" && (
          <div className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em]"
                style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>
                {devices.length} device{devices.length !== 1 ? "s" : ""} in range
              </p>
              <button
                onClick={() => call("rescan")}
                className="text-[11px] font-mono px-3 py-1.5 rounded-full transition-all"
                style={{
                  color: "rgb(var(--rift-accent) / 0.8)",
                  background: "rgb(var(--rift-accent) / 0.08)",
                  boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)",
                }}
              >
                ↻ Rescan
              </button>
            </div>

            {devices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-5">
                <div className="relative w-16 h-16 flex items-center justify-center">
                  {[0, 0.8, 1.6].map((delay) => (
                    <div
                      key={delay}
                      className="absolute inset-0 rounded-full animate-radar"
                      style={{
                        animationDelay: `${delay}s`,
                        boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.3)",
                      }}
                    />
                  ))}
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{ background: "rgb(var(--rift-accent))", boxShadow: "0 0 12px rgb(var(--rift-glow) / 0.6)" }}
                  />
                </div>
                <div className="text-center px-8">
                  <p className="text-xs font-mono text-rift-muted mb-1">Scanning…</p>
                  <p className="text-[10px] font-mono leading-relaxed"
                    style={{ color: "rgb(var(--rift-muted) / 0.5)" }}>
                    Open The Rift on another device on the same Wi-Fi network
                  </p>
                </div>
              </div>
            ) : (
              devices.map((d) => <MobileDeviceRow key={d.id} deviceId={d.id} />)
            )}
          </div>
        )}

        {/* SEND */}
        {tab === "send" && (
          <div className="p-4 flex flex-col gap-4">
            {/* Target device indicator */}
            {selectedDevice ? (
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-2xl"
                style={{
                  background: "rgb(var(--rift-accent) / 0.08)",
                  boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)",
                }}
              >
                <span className="status-dot-live" />
                <div>
                  <p className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.7)" }}>Sending to</p>
                  <p className="text-sm font-semibold" style={{ color: "rgb(var(--rift-accent))" }}>
                    {selectedDevice.name}
                  </p>
                </div>
              </div>
            ) : (
              <div
                className="px-4 py-3 rounded-2xl text-center"
                style={{ background: "rgb(var(--rift-surface2) / 0.4)" }}
              >
                <p className="text-xs font-mono" style={{ color: "rgb(var(--rift-muted) / 0.6)" }}>
                  Go to Devices tab and select a target device
                </p>
              </div>
            )}

            {/* Mode toggle */}
            <div
              className="flex rounded-2xl p-1"
              style={{ background: "rgb(var(--rift-surface2) / 0.5)" }}
            >
              {(["files", "text"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setTextMode(mode === "text")}
                  className="flex-1 py-2.5 rounded-xl text-[10px] font-mono font-bold uppercase tracking-widest transition-all duration-150"
                  style={{
                    background: (mode === "text") === textMode
                      ? "rgb(var(--rift-accent) / 0.15)"
                      : "transparent",
                    color: (mode === "text") === textMode
                      ? "rgb(var(--rift-accent))"
                      : "rgb(var(--rift-muted) / 0.6)",
                    boxShadow: (mode === "text") === textMode
                      ? "0 0 0 1px rgb(var(--rift-accent) / 0.25)"
                      : "none",
                  }}
                >
                  {mode === "files" ? "Files" : "Text"}
                </button>
              ))}
            </div>

            {/* FILE MODE */}
            {!textMode && (
              <>
                {stagedFiles.length === 0 ? (
                  <button
                    onClick={browse}
                    className="w-full py-16 rounded-3xl flex flex-col items-center gap-4 transition-all"
                    style={{
                      background: "rgb(var(--rift-surface2) / 0.4)",
                      boxShadow: "0 0 0 2px rgb(var(--rift-accent) / 0.12) inset",
                    }}
                  >
                    <span className="text-3xl opacity-40">⤵</span>
                    <div className="text-center">
                      <p className="text-sm font-mono" style={{ color: "rgb(var(--rift-muted) / 0.75)" }}>
                        Tap to browse files
                      </p>
                      <p className="text-[10px] font-mono mt-1" style={{ color: "rgb(var(--rift-muted) / 0.4)" }}>
                        Any type · Any size
                      </p>
                    </div>
                  </button>
                ) : (
                  <div
                    className="rounded-2xl p-4"
                    style={{
                      background: "rgb(var(--rift-surface2) / 0.5)",
                      boxShadow: "0 2px 10px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04)",
                    }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="text-sm font-semibold text-rift-text">
                          {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""}
                        </p>
                        <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
                          {fmt(totalBytes)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={browse}
                          className="text-[10px] font-mono px-3 py-1.5 rounded-full"
                          style={{
                            color: "rgb(var(--rift-accent) / 0.8)",
                            background: "rgb(var(--rift-accent) / 0.08)",
                            boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)",
                          }}
                        >
                          + Add
                        </button>
                        <button
                          onClick={clearStaged}
                          className="text-[10px] font-mono px-3 py-1.5 rounded-full"
                          style={{
                            color: "rgb(var(--rift-error) / 0.75)",
                            background: "rgb(var(--rift-error) / 0.08)",
                            boxShadow: "0 0 0 1px rgb(var(--rift-error) / 0.2)",
                          }}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="max-h-32 overflow-y-auto">
                      {stagedFiles.map((f, i) => (
                        <p key={i} className="text-[10px] font-mono truncate py-0.5"
                          style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
                          {f.name}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={sendFiles}
                  disabled={!canSendFiles}
                  className="w-full py-4 rounded-2xl font-mono text-sm font-bold tracking-[0.1em] uppercase transition-all duration-200 btn-accent disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSending ? "Sending…" : "Send Through"}
                </button>
              </>
            )}

            {/* TEXT MODE */}
            {textMode && (
              <>
                <textarea
                  value={text}
                  onChange={(e) => { setText(e.target.value); if (textStatus !== "idle") setTextStatus("idle"); }}
                  placeholder="Type or paste text to send…"
                  rows={8}
                  className="w-full resize-none rounded-2xl p-4 font-mono text-sm leading-relaxed focus:outline-none transition-all"
                  style={{
                    background: "rgb(var(--rift-surface2) / 0.5)",
                    color: "rgb(var(--rift-text))",
                    boxShadow: "inset 0 2px 8px rgb(0 0 0 / 0.2), 0 0 0 1px rgb(var(--rift-border) / 0.5)",
                    caretColor: "rgb(var(--rift-accent))",
                  }}
                />
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.5)" }}>
                    {text.length} chars
                  </span>
                  <button
                    onClick={async () => {
                      const t = await navigator.clipboard.readText().catch(() => "");
                      if (t) setText((p) => p + t);
                    }}
                    className="text-[10px] font-mono px-3 py-1.5 rounded-full"
                    style={{
                      color: "rgb(var(--rift-muted) / 0.7)",
                      background: "rgb(var(--rift-surface2) / 0.6)",
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
                    background: textStatus === "sent"
                      ? "rgb(var(--rift-success))"
                      : textStatus === "error"
                      ? "rgb(var(--rift-error))"
                      : "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
                    color: "rgb(var(--rift-bg))",
                    boxShadow: canSendText
                      ? "0 0 24px rgb(var(--rift-glow) / 0.35)"
                      : "none",
                  }}
                >
                  {textStatus === "sending" ? "Sending…"
                    : textStatus === "sent" ? "Sent ✓"
                    : textStatus === "error" ? "Failed ✗"
                    : "Send Text"}
                </button>
              </>
            )}
          </div>
        )}

        {/* TRANSFERS */}
        {tab === "transfers" && (
          <div className="p-4 flex flex-col gap-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em]"
              style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>
              {transfers.length} transfer{transfers.length !== 1 ? "s" : ""}
              {transfers.filter((t) => t.status === "complete").length > 0 &&
                ` · ${transfers.filter((t) => t.status === "complete").length} done`}
            </p>

            {transfers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{
                    background: "rgb(var(--rift-surface2) / 0.4)",
                    boxShadow: "0 0 0 1px rgb(255 255 255 / 0.04)",
                  }}
                >
                  <span className="text-base font-mono font-bold"
                    style={{ color: "rgb(var(--rift-muted) / 0.3)" }}>TX</span>
                </div>
                <p className="text-xs font-mono" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>
                  No transfers yet
                </p>
              </div>
            ) : (
              transfers.map((t) => {
                const progress = t.totalBytes > 0
                  ? Math.min(100, (t.bytesTransferred / t.totalBytes) * 100)
                  : 0;
                const isActive = t.status === "transferring" || t.status === "paused";
                const label = t.files.length === 1
                  ? (t.files[0]?.name ?? "Unknown")
                  : `${t.files.length} files`;
                const peer = t.direction === "outgoing"
                  ? t.targetDevice?.name
                  : t.senderDevice?.name;

                const STATUS_COLOR: Record<string, string> = {
                  queued: "rgb(var(--rift-muted))",
                  connecting: "rgb(var(--rift-warning))",
                  transferring: "rgb(var(--rift-accent))",
                  paused: "rgb(var(--rift-warning))",
                  complete: "rgb(var(--rift-success))",
                  error: "rgb(var(--rift-error))",
                  declined: "rgb(var(--rift-error) / 0.7)",
                };
                const STATUS_LABEL: Record<string, string> = {
                  queued: "QUEUE", connecting: "CONN", transferring: "LIVE",
                  paused: "PAUSE", complete: "DONE", error: "ERR", declined: "DENY",
                };

                return (
                  <div
                    key={t.id}
                    className="rounded-2xl p-4"
                    style={{
                      background: "rgb(var(--rift-surface2) / 0.5)",
                      boxShadow: "0 2px 10px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04)",
                    }}
                  >
                    <div className="flex items-start gap-2 mb-2">
                      <span
                        className="flex-shrink-0 text-[9px] font-mono font-bold px-1.5 py-1 rounded-lg"
                        style={{
                          color: t.direction === "outgoing"
                            ? "rgb(var(--rift-accent) / 0.85)"
                            : "rgb(var(--rift-accent2) / 0.85)",
                          background: t.direction === "outgoing"
                            ? "rgb(var(--rift-accent) / 0.1)"
                            : "rgb(var(--rift-accent2) / 0.1)",
                        }}
                      >
                        {t.direction === "outgoing" ? "TX" : "RX"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-rift-text">{label}</p>
                        <p className="text-[10px] font-mono mt-0.5"
                          style={{ color: "rgb(var(--rift-muted) / 0.6)" }}>
                          {peer ?? "Unknown"} · {fmt(t.totalBytes)}
                        </p>
                      </div>
                      <span
                        className="text-[9px] font-mono font-bold flex-shrink-0"
                        style={{ color: STATUS_COLOR[t.status] ?? "rgb(var(--rift-muted))" }}
                      >
                        {STATUS_LABEL[t.status] ?? t.status.toUpperCase()}
                      </span>
                    </div>
                    {isActive && (
                      <div className="mt-2">
                        <div className="progress-bar-track w-full h-1.5">
                          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                        </div>
                        <div className="flex justify-between mt-1.5">
                          <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>
                            {fmt(t.bytesTransferred)} / {fmt(t.totalBytes)}
                          </span>
                          <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>
                            {fmt(t.speedBytesPerSec)}/s
                            {t.etaSeconds !== null && ` · ${fmtEta(t.etaSeconds)}`}
                          </span>
                        </div>
                      </div>
                    )}
                    {t.status === "error" && t.errorMessage && (
                      <p className="text-[10px] font-mono mt-1.5"
                        style={{ color: "rgb(var(--rift-error) / 0.75)" }}>
                        {t.errorMessage}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── Bottom tab bar ── */}
      <div
        className="flex-shrink-0 flex"
        style={{
          background: "rgb(var(--rift-surface) / 0.9)",
          backdropFilter: "blur(40px)",
          boxShadow: "0 -1px 0 rgb(255 255 255 / 0.05), 0 -4px 20px rgb(0 0 0 / 0.3)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {([
          { id: "devices",   icon: "◈", label: "Devices",   badge: devices.length > 0 ? devices.length : null },
          { id: "send",      icon: "⤵", label: "Send",      badge: stagedFiles.length > 0 ? stagedFiles.length : null },
          { id: "transfers", icon: "↕", label: "History",   badge: activeTransfers > 0 ? activeTransfers : null },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex-1 relative flex flex-col items-center gap-1 py-3 transition-all duration-150"
            style={{
              color: tab === t.id ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.5)",
            }}
          >
            <span className="text-lg leading-none">{t.icon}</span>
            <span className="text-[9px] font-mono uppercase tracking-widest">{t.label}</span>
            {t.badge !== null && (
              <span
                className="absolute top-2 right-[calc(50%-18px)] w-4 h-4 rounded-full text-[8px] font-mono font-bold flex items-center justify-center"
                style={{
                  background: "rgb(var(--rift-accent))",
                  color: "rgb(var(--rift-bg))",
                }}
              >
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Overlays — always present regardless of tab */}
      <AcceptDialog />
      <IncomingTextDialog />
      <DevicePopup />
    </div>
  );
}