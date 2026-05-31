// src/components/MobileLayout.tsx

import { useState, useCallback } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { AcceptDialog } from "./AcceptDialog";
import { IncomingTextDialog } from "./IncomingTextDialog";
import { DevicePopup } from "./DevicePopup";
import { setAndPersistTheme } from "@/hooks/useTheme";
import type { ThemeId } from "@/types";

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

// ── File system helpers (same as DropZone) ────────────────────────────────────

function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

async function enumFilesRecursive(dirPath: string): Promise<string[]> {
  try {
    const entries = await readDir(dirPath);
    const results: string[] = [];
    for (const entry of entries) {
      if (!entry.name) continue;
      const full = joinPath(dirPath, entry.name);
      if (entry.isDirectory) {
        results.push(...await enumFilesRecursive(full));
      } else if (entry.isFile) {
        results.push(full);
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function expandToPaths(rawPaths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const p of rawPaths) {
    try {
      const info = await stat(p);
      if (info.isDirectory) {
        result.push(...await enumFilesRecursive(p));
      } else {
        result.push(p);
      }
    } catch {
      result.push(p);
    }
  }
  return result;
}

// ── Mini theme picker (mobile) ────────────────────────────────────────────────

const THEME_OPTIONS: { id: ThemeId; label: string; bg: string; accent: string }[] = [
  { id: "dark-black",  label: "Void",   bg: "#08080e", accent: "#00c8ff" },
  { id: "dark-blue",   label: "Abyss",  bg: "#04081e", accent: "#60b6ff" },
  { id: "dark-grey",   label: "Slate",  bg: "#0b0b0e", accent: "#bcc2d2" },
  { id: "dark-purple", label: "Cosmos", bg: "#080416", accent: "#c06cff" },
  { id: "light-pink",  label: "Rose",   bg: "#fff2fa", accent: "#d03e8a" },
  { id: "light-lemon", label: "Citrus", bg: "#ffffe6", accent: "#918700" },
  { id: "light-blue",  label: "Sky",    bg: "#e6f2ff", accent: "#1270d6" },
];

function MobileThemePicker({ onClose }: { onClose: () => void }) {
  const currentTheme = useRiftStore((s) => s.theme);
  const setTheme     = useRiftStore((s) => s.setTheme);

  function select(id: ThemeId) {
    setAndPersistTheme(id);
    setTheme(id);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.55)", backdropFilter: "blur(12px)" }}
      onClick={onClose}
    >
      <div
        className="glass-heavy w-full animate-slide-up overflow-hidden"
        style={{ borderRadius: "24px 24px 0 0", maxWidth: "480px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ height: 3, background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)", boxShadow: "0 0 18px rgb(var(--rift-glow) / 0.4)" }}/>
        <div className="px-5 pt-5 pb-8">
          <div className="flex items-center justify-between mb-5">
            <p className="text-[9px] font-mono uppercase tracking-[0.24em]" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>Appearance</p>
            <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full text-[10px] font-mono" style={{ background: "rgb(var(--rift-surface2) / 0.6)", color: "rgb(var(--rift-muted) / 0.6)" }}>✕</button>
          </div>
          <button
            onClick={() => select("system")}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-2xl mb-4 text-xs font-mono transition-all"
            style={{
              background: currentTheme === "system" ? "rgb(var(--rift-accent) / 0.12)" : "rgb(var(--rift-surface2) / 0.4)",
              color: currentTheme === "system" ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.7)",
              boxShadow: currentTheme === "system" ? "0 0 0 1px rgb(var(--rift-accent) / 0.3)" : "0 0 0 1px rgb(255 255 255 / 0.04)",
            }}
          >
            <span className="uppercase tracking-widest text-[10px]">Auto / System</span>
            {currentTheme === "system" && <span>✓</span>}
          </button>
          <div className="flex gap-3 flex-wrap">
            {THEME_OPTIONS.map((opt) => (
              <button key={opt.id} onClick={() => select(opt.id)} className="flex flex-col items-center gap-1.5">
                <div className="w-11 h-11 rounded-2xl relative transition-transform active:scale-95" style={{ background: opt.bg, boxShadow: currentTheme === opt.id ? `0 0 0 2.5px ${opt.accent}, 0 0 18px ${opt.accent}55` : `0 0 0 1px ${opt.accent}30` }}>
                  <span className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full" style={{ background: opt.accent, boxShadow: `0 0 5px ${opt.accent}88` }}/>
                  {currentTheme === opt.id && <span className="absolute top-1 left-1.5 text-[9px] font-mono font-bold" style={{ color: opt.accent }}>✓</span>}
                </div>
                <span className="text-[9px] font-mono uppercase tracking-wide" style={{ color: currentTheme === opt.id ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.55)" }}>{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Device row ────────────────────────────────────────────────────────────────

function MobileDeviceRow({ deviceId }: { deviceId: string }) {
  const device         = useRiftStore((s) => s.devices.find((d) => d.id === deviceId));
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const selectDevice   = useRiftStore((s) => s.selectDevice);
  const riftedDevices  = useRiftStore((s) => s.riftedDevices);
  const reconnecting   = useRiftStore((s) => s.reconnectingDevices);
  const setDevicePopup = useRiftStore((s) => s.setDevicePopup);

  if (!device) return null;

  const isSelected     = selectedDevice?.id === device.id;
  const isRifted       = riftedDevices.includes(device.id);
  const isReconnecting = reconnecting.includes(device.id);

  const OS_LABELS: Record<string, string> = { windows: "WIN", macos: "MAC", linux: "NIX", android: "AND", unknown: "SYS" };
  const OS_COLORS: Record<string, string> = {
    windows: "rgb(var(--rift-accent) / 0.85)", macos: "rgb(var(--rift-accent2) / 0.85)",
    linux:   "rgb(var(--rift-success) / 0.85)", android: "rgb(var(--rift-warning) / 0.85)",
    unknown: "rgb(var(--rift-muted) / 0.6)",
  };
  const osColor = OS_COLORS[device.os] ?? OS_COLORS.unknown;

  return (
    <button
      onClick={() => isSelected ? setDevicePopup(device) : selectDevice(device)}
      className="w-full text-left transition-all duration-200 animate-slide-up"
      style={{
        background: isSelected ? "linear-gradient(145deg, rgb(var(--rift-accent) / 0.1), rgb(var(--rift-surface2) / 0.65))" : "rgb(var(--rift-surface2) / 0.48)",
        borderRadius: 18, padding: "12px 14px", backdropFilter: "blur(20px)",
        boxShadow: isSelected
          ? "0 4px 20px rgb(0 0 0 / 0.4), 0 0 0 1px rgb(var(--rift-accent) / 0.5), 0 0 40px rgb(var(--rift-glow) / 0.12), inset 0 1px 0 rgb(255 255 255 / 0.08)"
          : isRifted
          ? "0 2px 10px rgb(0 0 0 / 0.3), 0 0 0 1px rgb(var(--rift-success) / 0.22), inset 0 1px 0 rgb(255 255 255 / 0.05)"
          : "0 2px 10px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)",
      }}
    >
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-mono font-bold px-2 py-1.5 rounded-xl flex-shrink-0 leading-none"
          style={{ color: osColor, background: osColor.replace("/ 0.85)", "/ 0.1)").replace("/ 0.6)", "/ 0.1)"), boxShadow: `0 0 0 1px ${osColor.replace("/ 0.85)", "/ 0.2)").replace("/ 0.6)", "/ 0.12)")}` }}>
          {OS_LABELS[device.os] ?? "SYS"}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate leading-tight" style={{ color: isSelected ? "rgb(var(--rift-accent))" : isReconnecting ? "rgb(var(--rift-warning) / 0.85)" : "rgb(var(--rift-text))" }}>
            {device.name}
          </p>
          <p className="text-[11px] font-mono mt-0.5 truncate" style={{ color: "rgb(var(--rift-muted) / 0.6)" }}>
            {device.ip}
            {device.latencyMs !== null && (
              <span style={{ color: device.latencyMs < 20 ? "rgb(var(--rift-success) / 0.8)" : device.latencyMs < 60 ? "rgb(var(--rift-warning) / 0.8)" : "rgb(var(--rift-error) / 0.8)" }}>
                {" "}· {device.latencyMs}ms
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {isRifted ? <span className="status-dot-live"/> : isReconnecting ? <span className="status-dot-wait"/> : <span className="status-dot-offline"/>}
          {isSelected && <span className="text-[9px] font-mono font-bold" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>SELECTED</span>}
          {isReconnecting && !isSelected && <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-warning) / 0.6)" }}>…</span>}
        </div>
      </div>
      {isSelected && <p className="text-[9px] font-mono mt-1.5 tracking-wide" style={{ color: "rgb(var(--rift-accent) / 0.6)" }}>tap again for details</p>}
    </button>
  );
}

// ── Main layout ───────────────────────────────────────────────────────────────

export function MobileLayout() {
  const [tab, setTab]               = useState<Tab>("devices");
  const [textMode, setTextMode]     = useState(false);
  const [text, setText]             = useState("");
  const [textStatus, setTextStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [themeOpen, setThemeOpen]   = useState(false);

  const devices        = useRiftStore((s) => s.devices);
  const transfers      = useRiftStore((s) => s.transfers);
  const stagedFiles    = useRiftStore((s) => s.stagedFiles);
  const setStagedFiles = useRiftStore((s) => s.setStagedFiles);
  const clearStaged    = useRiftStore((s) => s.clearStagedFiles);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const ownDeviceName  = useRiftStore((s) => s.ownDeviceName);
  const networkStatus  = useRiftStore((s) => s.networkStatus);
  const isSending      = useRiftStore((s) => s.isSending);

  const { call }                = useInvoke();
  const { sendFiles, sendText } = useTransferActions();

  const totalBytes   = stagedFiles.reduce((s, f) => s + f.sizeBytes, 0);
  const canSendFiles = stagedFiles.length > 0 && !!selectedDevice && !isSending;
  const canSendText  = text.trim().length > 0 && !!selectedDevice && textStatus !== "sending";

  // Stage from a mixed list of file and directory paths.
  const stageFromPaths = useCallback(async (rawPaths: string[]) => {
    if (!rawPaths.length) return;
    try {
      const filePaths = await expandToPaths(rawPaths);
      if (!filePaths.length) return;
      const files = await call<StagedFile[]>("get_file_metadata", { paths: filePaths });
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

  async function browseFolder() {
    try {
      const res = await open({ multiple: false, directory: true });
      if (!res) return;
      const dirPath = typeof res === "string" ? res : res[0];
      if (!dirPath) return;
      const filePaths = await enumFilesRecursive(dirPath);
      if (!filePaths.length) return;
      const files = await call<StagedFile[]>("get_file_metadata", { paths: filePaths });
      setStagedFiles(files);
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

  const STATUS_DOT_COLOR: Record<string, string> = {
    searching: "rgb(var(--rift-warning))", connected: "rgb(var(--rift-success))",
    hotspot: "rgb(var(--rift-accent))", offline: "rgb(var(--rift-error))",
  };
  const STATUS_LABEL: Record<string, string> = {
    searching: "Scanning", connected: "Connected", hotspot: "Hotspot", offline: "Offline",
  };

  const activeTransfers = transfers.filter((t) => t.status === "transferring").length;

  const TRANSFER_STATUS_COLOR: Record<string, string> = {
    queued: "rgb(var(--rift-muted))", connecting: "rgb(var(--rift-warning))",
    transferring: "rgb(var(--rift-accent))", paused: "rgb(var(--rift-warning))",
    complete: "rgb(var(--rift-success))", error: "rgb(var(--rift-error))",
    declined: "rgb(var(--rift-error) / 0.7)",
  };
  const TRANSFER_STATUS_LABEL: Record<string, string> = {
    queued: "QUEUE", connecting: "CONN", transferring: "LIVE",
    paused: "PAUSE", complete: "DONE", error: "ERR", declined: "DENY",
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden font-sans text-rift-text select-none relative" style={{ background: "rgb(var(--rift-bg))" }}>
      {/* Ambient orbs */}
      <div aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
        <div className="ambient-orb animate-orb-drift-a" style={{ width: "80vw", height: "80vw", top: "-30%", left: "-25%", background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.06) 0%, transparent 70%)" }}/>
        <div className="ambient-orb animate-orb-drift-b" style={{ width: "70vw", height: "70vw", bottom: "-25%", right: "-20%", background: "radial-gradient(ellipse at center, rgb(var(--rift-accent2) / 0.05) 0%, transparent 70%)" }}/>
      </div>

      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 relative"
        style={{ background: "rgb(var(--rift-surface) / 0.85)", backdropFilter: "blur(48px) saturate(180%)", boxShadow: "0 1px 0 rgb(255 255 255 / 0.05), 0 4px 20px rgb(0 0 0 / 0.3)", zIndex: 10 }}>
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: STATUS_DOT_COLOR[networkStatus] ?? "rgb(var(--rift-muted))", boxShadow: networkStatus === "connected" ? "0 0 8px rgb(var(--rift-success) / 0.7)" : networkStatus === "searching" ? "0 0 8px rgb(var(--rift-warning) / 0.5)" : "none" }}/>
          <div>
            <h1 className="text-lg font-black tracking-[-0.03em] font-mono leading-none" style={{ background: "linear-gradient(120deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>THE RIFT</h1>
            <p className="text-[9px] font-mono leading-none mt-0.5" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>{STATUS_LABEL[networkStatus] ?? "Searching"} · {ownDeviceName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedDevice && (
            <span className="text-[10px] font-mono px-2.5 py-1 rounded-full" style={{ color: "rgb(var(--rift-accent))", background: "rgb(var(--rift-accent) / 0.1)", boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)" }}>
              → {selectedDevice.name}
            </span>
          )}
          <button onClick={() => setThemeOpen(true)} className="w-8 h-8 flex items-center justify-center rounded-full transition-all" style={{ background: "rgb(var(--rift-surface2) / 0.6)", boxShadow: "0 0 0 1px rgb(255 255 255 / 0.06)", color: "rgb(var(--rift-muted) / 0.7)", fontSize: "14px" }}>◑</button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto relative" style={{ zIndex: 1 }}>

        {/* DEVICES */}
        {tab === "devices" && (
          <div className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] font-mono uppercase tracking-[0.22em]" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>Nearby Devices</p>
                {devices.length > 0 && <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>{devices.length} in range</p>}
              </div>
              <button onClick={() => call("rescan")} className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-full transition-all" style={{ color: "rgb(var(--rift-accent) / 0.85)", background: "rgb(var(--rift-accent) / 0.08)", boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)" }}>
                <span style={{ fontSize: "13px" }}>↻</span><span>Rescan</span>
              </button>
            </div>
            {devices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-6 rounded-3xl" style={{ background: "rgb(var(--rift-surface2) / 0.3)", boxShadow: "0 0 0 1px rgb(255 255 255 / 0.03), inset 0 2px 8px rgb(0 0 0 / 0.15)" }}>
                <div className="relative w-16 h-16 flex items-center justify-center">
                  {[0, 0.9, 1.8].map((delay) => (
                    <div key={delay} className="absolute inset-0 rounded-full animate-radar" style={{ animationDelay: `${delay}s`, boxShadow: "0 0 0 1.5px rgb(var(--rift-accent) / 0.35)" }}/>
                  ))}
                  <div className="w-4 h-4 rounded-full" style={{ background: "rgb(var(--rift-accent))", boxShadow: "0 0 16px rgb(var(--rift-glow) / 0.7)" }}/>
                </div>
                <div className="text-center px-8">
                  <p className="text-xs font-mono font-semibold mb-1" style={{ color: "rgb(var(--rift-muted) / 0.7)" }}>Scanning</p>
                  <p className="text-[10px] font-mono leading-relaxed" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>Open The Rift on another device on the same Wi-Fi network</p>
                </div>
              </div>
            ) : (
              devices.map((d) => <MobileDeviceRow key={d.id} deviceId={d.id}/>)
            )}
          </div>
        )}

        {/* SEND */}
        {tab === "send" && (
          <div className="p-4 flex flex-col gap-4">
            {/* Target device */}
            {selectedDevice ? (
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl animate-slide-up" style={{ background: "rgb(var(--rift-accent) / 0.07)", boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.22), 0 0 20px rgb(var(--rift-glow) / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.04)" }}>
                <span className="status-dot-live"/>
                <div>
                  <p className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>Sending to</p>
                  <p className="text-sm font-semibold" style={{ color: "rgb(var(--rift-accent))" }}>{selectedDevice.name}</p>
                </div>
              </div>
            ) : (
              <div className="px-4 py-3.5 rounded-2xl text-center" style={{ background: "rgb(var(--rift-surface2) / 0.35)", boxShadow: "0 0 0 1px rgb(255 255 255 / 0.04), inset 0 2px 8px rgb(0 0 0 / 0.15)" }}>
                <p className="text-xs font-mono" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>Go to Devices and select a target first</p>
              </div>
            )}

            {/* Mode toggle */}
            <div className="flex rounded-2xl p-1" style={{ background: "rgb(var(--rift-surface2) / 0.5)", boxShadow: "inset 0 2px 8px rgb(0 0 0 / 0.2)" }}>
              {(["files", "text"] as const).map((mode) => (
                <button key={mode} onClick={() => setTextMode(mode === "text")}
                  className="flex-1 py-2.5 rounded-xl text-[10px] font-mono font-bold uppercase tracking-widest transition-all duration-150"
                  style={{
                    background: (mode === "text") === textMode ? "rgb(var(--rift-accent) / 0.15)" : "transparent",
                    color: (mode === "text") === textMode ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.55)",
                    boxShadow: (mode === "text") === textMode ? "0 0 0 1px rgb(var(--rift-accent) / 0.28), 0 0 12px rgb(var(--rift-glow) / 0.1)" : "none",
                  }}>
                  {mode === "files" ? "Files" : "Text"}
                </button>
              ))}
            </div>

            {/* FILES */}
            {!textMode && (
              <>
                {stagedFiles.length === 0 ? (
                  <div className="flex flex-col gap-2">
                    {/* File picker */}
                    <button onClick={browse}
                      className="w-full py-12 rounded-3xl flex flex-col items-center gap-3 transition-all active:scale-98"
                      style={{ background: "rgb(var(--rift-surface2) / 0.35)", boxShadow: "0 0 0 2px rgb(var(--rift-accent) / 0.1) inset, 0 4px 16px rgb(0 0 0 / 0.2), inset 0 1px 0 rgb(255 255 255 / 0.04)", backdropFilter: "blur(20px)" }}>
                      <span className="text-3xl" style={{ color: "rgb(var(--rift-accent) / 0.4)", filter: "drop-shadow(0 0 12px rgb(var(--rift-glow) / 0.3))" }}>⤵</span>
                      <div className="text-center">
                        <p className="text-sm font-mono font-semibold" style={{ color: "rgb(var(--rift-muted) / 0.7)" }}>Tap to browse files</p>
                        <p className="text-[10px] font-mono mt-1" style={{ color: "rgb(var(--rift-muted) / 0.38)" }}>Any type · Any size</p>
                      </div>
                    </button>
                    {/* Folder picker */}
                    <button onClick={browseFolder}
                      className="w-full py-3 rounded-2xl flex items-center justify-center gap-2 transition-all active:scale-98"
                      style={{ background: "rgb(var(--rift-surface2) / 0.3)", boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.15)", backdropFilter: "blur(12px)" }}>
                      <span className="text-base" style={{ color: "rgb(var(--rift-accent) / 0.55)" }}>📁</span>
                      <span className="text-[11px] font-mono font-semibold" style={{ color: "rgb(var(--rift-accent) / 0.75)" }}>Select folder</span>
                    </button>
                  </div>
                ) : (
                  <div className="rounded-2xl p-4 animate-slide-up" style={{ background: "rgb(var(--rift-surface2) / 0.5)", backdropFilter: "blur(20px)", boxShadow: "0 2px 12px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)" }}>
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="text-sm font-semibold text-rift-text">{stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""}</p>
                        <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>{fmt(totalBytes)}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={browse} className="text-[10px] font-mono px-3 py-1.5 rounded-full transition-all" style={{ color: "rgb(var(--rift-accent) / 0.85)", background: "rgb(var(--rift-accent) / 0.08)", boxShadow: "0 0 0 1px rgb(var(--rift-accent) / 0.2)" }}>+ Add</button>
                        <button onClick={clearStaged} className="text-[10px] font-mono px-3 py-1.5 rounded-full transition-all" style={{ color: "rgb(var(--rift-error) / 0.8)", background: "rgb(var(--rift-error) / 0.08)", boxShadow: "0 0 0 1px rgb(var(--rift-error) / 0.18)" }}>Clear</button>
                      </div>
                    </div>
                    <div className="max-h-32 overflow-y-auto">
                      {stagedFiles.map((f, i) => (
                        <p key={i} className="text-[10px] font-mono truncate py-0.5" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>{f.name}</p>
                      ))}
                    </div>
                  </div>
                )}

                <button onClick={sendFiles} disabled={!canSendFiles}
                  className="w-full py-4 rounded-2xl font-mono text-sm font-bold tracking-[0.1em] uppercase transition-all duration-200 btn-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none">
                  {isSending ? "Sending…" : "Send Through"}
                </button>
              </>
            )}

            {/* TEXT */}
            {textMode && (
              <>
                <textarea value={text} onChange={(e) => { setText(e.target.value); if (textStatus !== "idle") setTextStatus("idle"); }}
                  placeholder="Type or paste text to send…" rows={8}
                  className="w-full resize-none rounded-2xl p-4 font-mono text-sm leading-relaxed focus:outline-none transition-all"
                  style={{ background: "rgb(var(--rift-surface2) / 0.5)", backdropFilter: "blur(20px)", color: "rgb(var(--rift-text))", boxShadow: "inset 0 2px 10px rgb(0 0 0 / 0.2), 0 0 0 1px rgb(var(--rift-border) / 0.5)", caretColor: "rgb(var(--rift-accent))" }}/>
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>{text.length} chars</span>
                  <button onClick={async () => { const t = await navigator.clipboard.readText().catch(() => ""); if (t) setText((p) => p + t); }}
                    className="text-[10px] font-mono px-3 py-1.5 rounded-full transition-all" style={{ color: "rgb(var(--rift-muted) / 0.7)", background: "rgb(var(--rift-surface2) / 0.6)", boxShadow: "0 0 0 1px rgb(255 255 255 / 0.05)" }}>Paste</button>
                </div>
                <button onClick={handleSendText} disabled={!canSendText}
                  className="w-full py-4 rounded-2xl font-mono text-sm font-bold tracking-[0.1em] uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: textStatus === "sent" ? "rgb(var(--rift-success))" : textStatus === "error" ? "rgb(var(--rift-error))" : canSendText ? "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))" : "rgb(var(--rift-surface2) / 0.5)",
                    color: canSendText || textStatus !== "idle" ? "rgb(var(--rift-bg))" : "rgb(var(--rift-muted) / 0.5)",
                    boxShadow: canSendText && textStatus === "idle" ? "0 0 28px rgb(var(--rift-glow) / 0.4), 0 0 0 1px rgb(var(--rift-accent) / 0.35), inset 0 1px 0 rgb(255 255 255 / 0.2)" : "none",
                  }}>
                  {textStatus === "sending" ? "Sending…" : textStatus === "sent" ? "Sent ✓" : textStatus === "error" ? "Failed ✗" : "Send Text"}
                </button>
              </>
            )}
          </div>
        )}

        {/* TRANSFERS */}
        {tab === "transfers" && (
          <div className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-mono uppercase tracking-[0.22em]" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>{transfers.length} transfer{transfers.length !== 1 ? "s" : ""}</p>
              {transfers.filter((t) => t.status === "complete").length > 0 && (
                <span className="text-[9px] font-mono font-bold px-2.5 py-1 rounded-full" style={{ color: "rgb(var(--rift-success))", background: "rgb(var(--rift-success) / 0.1)", boxShadow: "0 0 0 1px rgb(var(--rift-success) / 0.2)" }}>
                  {transfers.filter((t) => t.status === "complete").length} done
                </span>
              )}
            </div>

            {transfers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4 rounded-3xl" style={{ background: "rgb(var(--rift-surface2) / 0.3)", boxShadow: "0 0 0 1px rgb(255 255 255 / 0.03), inset 0 2px 8px rgb(0 0 0 / 0.15)" }}>
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: "rgb(var(--rift-surface2) / 0.5)", boxShadow: "0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.04)" }}>
                  <span className="text-base font-mono font-bold" style={{ color: "rgb(var(--rift-muted) / 0.28)" }}>TX</span>
                </div>
                <p className="text-xs font-mono" style={{ color: "rgb(var(--rift-muted) / 0.4)" }}>No transfers yet</p>
              </div>
            ) : (
              transfers.map((t) => {
                const progress     = t.totalBytes > 0 ? Math.min(100, ((t.bytesTransferred ?? 0) / t.totalBytes) * 100) : 0;
                const isActive     = t.status === "transferring" || t.status === "paused";
                const isDone       = t.status === "complete";
                const label        = t.files.length === 1 ? (t.files[0]?.name ?? "Unknown") : `${t.files.length} files`;
                const peer         = t.direction === "outgoing" ? t.targetDevice?.name : t.senderDevice?.name;
                const statusColor  = TRANSFER_STATUS_COLOR[t.status] ?? "rgb(var(--rift-muted))";

                return (
                  <div key={t.id} className="rounded-2xl p-4 animate-slide-up"
                    style={{ background: isDone ? "rgb(var(--rift-surface2) / 0.28)" : "rgb(var(--rift-surface2) / 0.5)", backdropFilter: "blur(20px)", boxShadow: isDone ? "0 2px 8px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(255 255 255 / 0.03)" : "0 2px 12px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.04)", opacity: isDone ? 0.75 : 1 }}>
                    <div className="flex items-start gap-2 mb-2">
                      <span className="flex-shrink-0 text-[9px] font-mono font-bold px-1.5 py-1 rounded-lg mt-0.5 leading-none"
                        style={{ color: t.direction === "outgoing" ? "rgb(var(--rift-accent) / 0.85)" : "rgb(var(--rift-accent2) / 0.85)", background: t.direction === "outgoing" ? "rgb(var(--rift-accent) / 0.1)" : "rgb(var(--rift-accent2) / 0.1)", boxShadow: t.direction === "outgoing" ? "0 0 0 1px rgb(var(--rift-accent) / 0.2)" : "0 0 0 1px rgb(var(--rift-accent2) / 0.2)" }}>
                        {t.direction === "outgoing" ? "TX" : "RX"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate leading-tight" style={{ color: "rgb(var(--rift-text))" }}>{label}</p>
                        <p className="text-[10px] font-mono mt-0.5 truncate" style={{ color: "rgb(var(--rift-muted) / 0.6)" }}>{peer ?? "Unknown"} · {fmt(t.totalBytes)}</p>
                      </div>
                      <span className="text-[9px] font-mono font-bold flex-shrink-0 px-2 py-0.5 rounded-full" style={{ color: statusColor, background: statusColor.replace("rgb(", "").replace(")", "").includes("/") ? statusColor.replace("/ 0.7)", "/ 0.08)") : `${statusColor.slice(0, -1)} / 0.08)` }}>
                        {TRANSFER_STATUS_LABEL[t.status] ?? t.status.toUpperCase()}
                      </span>
                    </div>

                    {/* Per-file list for multi-file transfers */}
                    {t.files.length > 1 && (
                      <div className="rounded-xl overflow-hidden mb-2" style={{ maxHeight: "6rem", overflowY: "auto", background: "rgb(var(--rift-bg) / 0.35)", boxShadow: "inset 0 1px 4px rgb(0 0 0 / 0.2)" }}>
                        {t.files.map((f, fi) => (
                          <div key={fi} className="flex items-center justify-between px-2.5 py-1" style={{ borderBottom: fi < t.files.length - 1 ? "1px solid rgb(255 255 255 / 0.04)" : "none" }}>
                            <span className="text-[10px] font-mono truncate flex-1 pr-2" style={{ color: "rgb(var(--rift-muted) / 0.7)" }}>{f.name}</span>
                            <span className="text-[9px] font-mono flex-shrink-0" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>{fmt(f.sizeBytes)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {isActive && (
                      <div className="mt-2">
                        <div className="progress-bar-track w-full h-1.5">
                          <div className="progress-bar-fill" style={{ width: `${progress}%` }}/>
                        </div>
                        <div className="flex justify-between mt-1.5">
                          <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>{fmt(t.bytesTransferred ?? 0)} / {fmt(t.totalBytes)}</span>
                          <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>
                            {(t.speedBytesPerSec ?? 0) > 0 ? `${fmt(t.speedBytesPerSec!)}/s` : "…"}
                            {t.etaSeconds !== null && ` · ${fmtEta(t.etaSeconds)}`}
                          </span>
                        </div>
                      </div>
                    )}

                    {t.status === "error" && t.errorMessage && (
                      <p className="text-[10px] font-mono mt-1.5 leading-snug" style={{ color: "rgb(var(--rift-error) / 0.75)" }}>{t.errorMessage}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Bottom tab bar */}
      <div className="flex-shrink-0 flex relative"
        style={{ background: "rgb(var(--rift-surface) / 0.92)", backdropFilter: "blur(48px) saturate(180%)", boxShadow: "0 -1px 0 rgb(255 255 255 / 0.05), 0 -4px 24px rgb(0 0 0 / 0.35)", paddingBottom: "env(safe-area-inset-bottom, 0px)", zIndex: 10 }}>
        <div className="absolute top-0 left-0 right-0" style={{ height: 1, background: "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.15), rgb(var(--rift-accent2) / 0.1), transparent)" }}/>
        {([
          { id: "devices",   icon: "◈", label: "Devices",  badge: devices.length > 0 ? devices.length : null },
          { id: "send",      icon: "⤵", label: "Send",     badge: stagedFiles.length > 0 ? stagedFiles.length : null },
          { id: "transfers", icon: "↕", label: "History",  badge: activeTransfers > 0 ? activeTransfers : null },
        ] as const).map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className="flex-1 relative flex flex-col items-center gap-1 py-3 transition-all duration-150"
            style={{ color: tab === t.id ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.45)" }}>
            {tab === t.id && <div className="absolute top-0 left-1/2" style={{ transform: "translateX(-50%)", width: "32px", height: "2px", borderRadius: "0 0 4px 4px", background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))", boxShadow: "0 0 12px rgb(var(--rift-glow) / 0.6)" }}/>}
            <span className="text-lg leading-none" style={{ filter: tab === t.id ? "drop-shadow(0 0 6px rgb(var(--rift-glow) / 0.5))" : "none" }}>{t.icon}</span>
            <span className="text-[9px] font-mono uppercase tracking-widest">{t.label}</span>
            {t.badge !== null && (
              <span className="absolute top-2 right-[calc(50%-18px)] min-w-[16px] h-4 rounded-full text-[8px] font-mono font-bold flex items-center justify-center px-1"
                style={{ background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))", color: "rgb(var(--rift-bg))", boxShadow: "0 0 8px rgb(var(--rift-glow) / 0.5)" }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Overlays */}
      <AcceptDialog/>
      <IncomingTextDialog/>
      <DevicePopup/>
      {themeOpen && <MobileThemePicker onClose={() => setThemeOpen(false)}/>}
    </div>
  );
}