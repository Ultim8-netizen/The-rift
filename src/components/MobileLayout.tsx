// src/components/MobileLayout.tsx
// Redesigned: swipe navigation, Portal3D, branded header, zero-edge bleed aesthetics

import { useState, useCallback, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { AcceptDialog } from "./AcceptDialog";
import { IncomingTextDialog } from "./IncomingTextDialog";
import { DevicePopup } from "./DevicePopup";
import { Portal3D } from "./Portal3D";
import { TransferItem } from "./TransferItem";
import { setAndPersistTheme } from "@/hooks/useTheme";
import type { ThemeId } from "@/types";

type Tab = "devices" | "send" | "transfers";
const TAB_ORDER: Tab[] = ["devices", "send", "transfers"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

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
      if (entry.isDirectory) results.push(...(await enumFilesRecursive(full)));
      else if (entry.isFile) results.push(full);
    }
    return results;
  } catch { return []; }
}

async function expandToPaths(rawPaths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const p of rawPaths) {
    try {
      const info = await stat(p);
      if (info.isDirectory) result.push(...(await enumFilesRecursive(p)));
      else result.push(p);
    } catch { result.push(p); }
  }
  return result;
}

// ─── Theme options ────────────────────────────────────────────────────────────

const THEME_OPTIONS: { id: ThemeId; label: string; bg: string; accent: string }[] = [
  { id: "dark-black",  label: "Void",   bg: "#08080e", accent: "#00c8ff" },
  { id: "dark-blue",   label: "Abyss",  bg: "#04081e", accent: "#60b6ff" },
  { id: "dark-grey",   label: "Slate",  bg: "#0b0b0e", accent: "#bcc2d2" },
  { id: "dark-purple", label: "Cosmos", bg: "#080416", accent: "#c06cff" },
  { id: "light-pink",  label: "Rose",   bg: "#fff2fa", accent: "#d03e8a" },
  { id: "light-lemon", label: "Citrus", bg: "#ffffe6", accent: "#918700" },
  { id: "light-blue",  label: "Sky",    bg: "#e6f2ff", accent: "#1270d6" },
];

// ─── MobileThemePicker ────────────────────────────────────────────────────────

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
      style={{ background: "rgb(0 0 0 / 0.65)", backdropFilter: "blur(18px)" }}
      onClick={onClose}
    >
      <div
        className="glass-heavy w-full animate-slide-up overflow-hidden"
        style={{
          borderRadius: "32px 32px 0 0",
          maxWidth: 480,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent band */}
        <div style={{
          height: 3,
          background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
          boxShadow: "0 0 28px rgb(var(--rift-glow) / 0.55)",
        }} />

        <div className="px-6 pt-5 pb-8">
          <div className="flex items-center justify-between mb-5">
            <p className="text-[9px] font-mono uppercase tracking-[0.3em]" style={{ color: "rgb(var(--rift-muted) / 0.45)" }}>
              Appearance
            </p>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-[11px] font-mono"
              style={{ background: "rgb(var(--rift-surface2) / 0.65)", color: "rgb(var(--rift-muted) / 0.55)" }}
            >
              ✕
            </button>
          </div>

          <button
            onClick={() => select("system")}
            className="w-full flex items-center justify-between px-4 py-3 rounded-2xl mb-5 text-xs font-mono transition-all"
            style={{
              background: currentTheme === "system" ? "rgb(var(--rift-accent) / 0.1)" : "rgb(var(--rift-surface2) / 0.38)",
              color:      currentTheme === "system" ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.6)",
              boxShadow:  currentTheme === "system"
                ? "0 0 0 1px rgb(var(--rift-accent) / 0.3), 0 0 18px rgb(var(--rift-glow) / 0.12)"
                : "0 0 0 1px rgb(255 255 255 / 0.04)",
            }}
          >
            <span className="uppercase tracking-widest text-[10px]">Auto / System</span>
            {currentTheme === "system" && <span style={{ color: "rgb(var(--rift-accent))" }}>✓</span>}
          </button>

          <div className="flex gap-3 flex-wrap">
            {THEME_OPTIONS.map((opt) => (
              <button key={opt.id} onClick={() => select(opt.id)} className="flex flex-col items-center gap-1.5">
                <div
                  className="w-12 h-12 rounded-2xl relative transition-all duration-150 active:scale-90"
                  style={{
                    background: opt.bg,
                    boxShadow: currentTheme === opt.id
                      ? `0 0 0 2.5px ${opt.accent}, 0 0 22px ${opt.accent}55`
                      : `0 0 0 1px ${opt.accent}28`,
                  }}
                >
                  <span className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 rounded-full"
                    style={{ background: opt.accent, boxShadow: `0 0 7px ${opt.accent}99` }} />
                  {currentTheme === opt.id && (
                    <span className="absolute top-1 left-1.5 text-[9px] font-mono font-bold" style={{ color: opt.accent }}>✓</span>
                  )}
                </div>
                <span className="text-[9px] font-mono uppercase tracking-wider"
                  style={{ color: currentTheme === opt.id ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.45)" }}>
                  {opt.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Own Device Card ──────────────────────────────────────────────────────────

function OwnDeviceCard() {
  const ownDeviceName = useRiftStore((s) => s.ownDeviceName);
  const networkStatus = useRiftStore((s) => s.networkStatus);
  const devices       = useRiftStore((s) => s.devices);

  const statusColor = {
    connected: "rgb(var(--rift-success))",
    hotspot:   "rgb(var(--rift-accent))",
    searching: "rgb(var(--rift-warning))",
    offline:   "rgb(var(--rift-error))",
  }[networkStatus] ?? "rgb(var(--rift-warning))";

  const statusLabel = {
    connected: "Connected",
    hotspot:   "Hotspot",
    searching: "Scanning",
    offline:   "Offline",
  }[networkStatus] ?? "Scanning";

  return (
    <div
      className="mx-4 mt-4 mb-3 rounded-3xl p-4 relative overflow-hidden"
      style={{
        background: "linear-gradient(145deg, rgb(var(--rift-accent) / 0.09) 0%, rgb(var(--rift-surface2) / 0.5) 100%)",
        boxShadow: "0 2px 20px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--rift-accent) / 0.14), inset 0 1px 0 rgb(255 255 255 / 0.07)",
        backdropFilter: "blur(24px)",
      }}
    >
      {/* Ambient accent corner */}
      <div aria-hidden style={{
        position: "absolute", top: 0, left: 0,
        width: "55%", height: "100%",
        background: "radial-gradient(ellipse at 0% 50%, rgb(var(--rift-accent) / 0.12) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div className="relative">
        <p className="text-[8px] font-mono uppercase tracking-[0.3em] mb-1.5"
          style={{ color: "rgb(var(--rift-accent) / 0.6)" }}>
          This Device
        </p>
        <p className="text-lg font-black font-mono tracking-tight leading-none"
          style={{ color: "rgb(var(--rift-text))" }}>
          {ownDeviceName}
        </p>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: statusColor, boxShadow: `0 0 7px ${statusColor}` }} />
          <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-muted) / 0.65)" }}>
            {statusLabel}
          </span>
          {devices.length > 0 && (
            <>
              <span style={{ color: "rgb(var(--rift-muted) / 0.28)", fontSize: 8 }}>·</span>
              <span className="text-[10px] font-mono" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
                {devices.length} {devices.length === 1 ? "device" : "devices"} nearby
              </span>
            </>
          )}
        </div>
        <p className="text-[9px] font-mono mt-2 leading-snug"
          style={{ color: "rgb(var(--rift-muted) / 0.38)" }}>
          This name appears on other devices when they scan for you
        </p>
      </div>
    </div>
  );
}

// ─── Mobile Device Row ────────────────────────────────────────────────────────

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

  const OS_LABELS: Record<string, string> = {
    windows: "WIN", macos: "MAC", linux: "NIX", android: "AND", unknown: "SYS",
  };
  const OS_COLORS: Record<string, string> = {
    windows: "rgb(var(--rift-accent) / 0.9)",
    macos:   "rgb(var(--rift-accent2) / 0.9)",
    linux:   "rgb(var(--rift-success) / 0.9)",
    android: "rgb(var(--rift-warning) / 0.9)",
    unknown: "rgb(var(--rift-muted) / 0.65)",
  };
  const osColor = OS_COLORS[device.os] ?? OS_COLORS.unknown;

  function bgStyle() {
    if (isSelected)     return "linear-gradient(145deg, rgb(var(--rift-accent) / 0.11) 0%, rgb(var(--rift-surface2) / 0.65) 100%)";
    if (isReconnecting) return "rgb(var(--rift-surface2) / 0.42)";
    return "rgb(var(--rift-surface2) / 0.44)";
  }

  function shadowStyle() {
    if (isSelected)     return "0 4px 22px rgb(0 0 0 / 0.38), 0 0 0 1px rgb(var(--rift-accent) / 0.5), 0 0 44px rgb(var(--rift-glow) / 0.12), inset 0 1px 0 rgb(255 255 255 / 0.08)";
    if (isRifted)       return "0 2px 12px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--rift-success) / 0.22), inset 0 1px 0 rgb(255 255 255 / 0.05)";
    if (isReconnecting) return "0 2px 12px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--rift-warning) / 0.28), inset 0 1px 0 rgb(255 255 255 / 0.05)";
    return "0 2px 10px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)";
  }

  return (
    <button
      onClick={() => isSelected ? setDevicePopup(device) : selectDevice(device)}
      className="w-full text-left transition-all duration-200 active:scale-[0.98]"
      style={{
        background:     bgStyle(),
        borderRadius:   20,
        padding:        "12px 14px",
        backdropFilter: "blur(22px)",
        boxShadow:      shadowStyle(),
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="text-[10px] font-mono font-bold px-2 py-1.5 rounded-xl flex-shrink-0 leading-none"
          style={{
            color:      osColor,
            background: osColor.replace("0.9)", "0.1)"),
            boxShadow:  `0 0 0 1px ${osColor.replace("0.9)", "0.2)")}`,
          }}
        >
          {OS_LABELS[device.os] ?? "SYS"}
        </span>

        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-semibold truncate leading-tight"
            style={{
              color: isSelected     ? "rgb(var(--rift-accent))"
                   : isReconnecting ? "rgb(var(--rift-warning) / 0.85)"
                   : "rgb(var(--rift-text))",
            }}
          >
            {device.name}
          </p>
          <p className="text-[10px] font-mono mt-0.5 truncate" style={{ color: "rgb(var(--rift-muted) / 0.55)" }}>
            {device.ip}
            {device.latencyMs !== null && (
              <span style={{
                color: device.latencyMs < 20  ? "rgb(var(--rift-success) / 0.85)"
                     : device.latencyMs < 60  ? "rgb(var(--rift-warning) / 0.85)"
                     : "rgb(var(--rift-error) / 0.85)",
              }}>
                {" "}· {device.latencyMs}ms
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {isRifted       ? <span className="status-dot-live" />
           : isReconnecting ? <span className="status-dot-wait" />
           : <span className="status-dot-offline" />}
          {isSelected && (
            <span className="text-[9px] font-mono font-bold" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
              SELECTED
            </span>
          )}
          {isReconnecting && !isSelected && (
            <span className="text-[9px] font-mono" style={{ color: "rgb(var(--rift-warning) / 0.55)" }}>…</span>
          )}
        </div>
      </div>

      {isSelected && (
        <p className="text-[9px] font-mono mt-1.5 tracking-wide" style={{ color: "rgb(var(--rift-accent) / 0.55)" }}>
          tap again for details
        </p>
      )}
    </button>
  );
}

// ─── Main Layout ──────────────────────────────────────────────────────────────

export function MobileLayout() {
  const [tab,        setTab]        = useState<Tab>("send");
  const [textMode,   setTextMode]   = useState(false);
  const [text,       setText]       = useState("");
  const [textStatus, setTextStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [themeOpen,  setThemeOpen]  = useState(false);

  const tabIndex    = TAB_ORDER.indexOf(tab);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

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
  const activeXfers  = transfers.filter((t) => t.status === "transferring").length;

  // ── Swipe navigation ───────────────────────────────────────────────────────

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const dx  = e.changedTouches[0].clientX - touchStartX.current;
    const adx = Math.abs(dx);
    const ady = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    // Require clearly horizontal gesture (adx > ady * 1.2) and minimum travel
    if (adx < 52 || adx < ady * 1.2) return;
    if (dx < 0 && tabIndex < 2) setTab(TAB_ORDER[tabIndex + 1]);
    else if (dx > 0 && tabIndex > 0) setTab(TAB_ORDER[tabIndex - 1]);
  }

  // ── File staging ───────────────────────────────────────────────────────────

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
      setTimeout(() => setTextStatus("idle"), 2200);
    } catch {
      setTextStatus("error");
      setTimeout(() => setTextStatus("idle"), 3000);
    }
  }

  const statusDotColor = {
    connected: "rgb(var(--rift-success))",
    hotspot:   "rgb(var(--rift-accent))",
    searching: "rgb(var(--rift-warning))",
    offline:   "rgb(var(--rift-error))",
  }[networkStatus] ?? "rgb(var(--rift-warning))";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col font-sans text-rift-text select-none overflow-hidden"
      style={{ height: "100dvh", background: "rgb(var(--rift-bg))", position: "relative" }}
    >
      {/* ── Ambient orbs — fixed depth layer ────────────────────────────── */}
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 0 }}>
        <div
          className="ambient-orb animate-orb-drift-a"
          style={{
            width: "110vw", height: "110vw", top: "-35%", left: "-30%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.075) 0%, transparent 68%)",
          }}
        />
        <div
          className="ambient-orb animate-orb-drift-b"
          style={{
            width: "90vw", height: "90vw", bottom: "-25%", right: "-20%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent2) / 0.06) 0%, transparent 68%)",
          }}
        />
        <div
          className="ambient-orb animate-orb-drift-c"
          style={{
            width: "70vw", height: "70vw", top: "38%", left: "25%",
            background: "radial-gradient(ellipse at center, rgb(var(--rift-accent) / 0.032) 0%, transparent 70%)",
          }}
        />
      </div>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header
        style={{
          position:       "relative",
          zIndex:         10,
          flexShrink:     0,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          padding:        "16px 20px 20px",
          background:     "rgb(var(--rift-surface) / 0.9)",
          backdropFilter: "blur(52px) saturate(190%)",
        }}
      >
        {/* Branding */}
        <div>
          <h1
            className="font-black font-mono leading-none"
            style={{
              fontSize:             "1.9rem",
              letterSpacing:        "-0.04em",
              background:           "linear-gradient(118deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor:  "transparent",
              backgroundClip:       "text",
              filter:               "drop-shadow(0 0 18px rgb(var(--rift-glow) / 0.45))",
            }}
          >
            THE RIFT
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: statusDotColor, boxShadow: `0 0 6px ${statusDotColor}` }}
            />
            <p
              className="font-mono"
              style={{ fontSize: "9px", letterSpacing: "0.24em", color: "rgb(var(--rift-muted) / 0.5)", textTransform: "uppercase" }}
            >
              {ownDeviceName}
            </p>
            <span style={{ color: "rgb(var(--rift-muted) / 0.2)", fontSize: 9 }}>·</span>
            <p
              className="font-mono"
              style={{ fontSize: "8px", letterSpacing: "0.2em", color: "rgb(var(--rift-muted) / 0.32)", textTransform: "lowercase" }}
            >
              by abyssprotocol
            </p>
          </div>
        </div>

        {/* Right: selected device chip + theme toggle */}
        <div className="flex items-center gap-2">
          {selectedDevice && (
            <span
              className="text-[10px] font-mono px-2.5 py-1.5 rounded-full"
              style={{
                color:      "rgb(var(--rift-accent))",
                background: "rgb(var(--rift-accent) / 0.1)",
                boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.22)",
                maxWidth:   "110px",
                overflow:   "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              → {selectedDevice.name}
            </span>
          )}
          <button
            onClick={() => setThemeOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-2xl transition-all"
            style={{
              background: "rgb(var(--rift-surface2) / 0.65)",
              boxShadow:  "0 0 0 1px rgb(255 255 255 / 0.07), 0 2px 10px rgb(0 0 0 / 0.28)",
              color:      "rgb(var(--rift-muted) / 0.65)",
              fontSize:   "16px",
            }}
          >
            ◑
          </button>
        </div>

        {/* Bottom bleed: header melts into bg */}
        <div
          aria-hidden
          style={{
            position:       "absolute",
            bottom:         -28,
            left:           0,
            right:          0,
            height:         28,
            background:     "linear-gradient(180deg, rgb(var(--rift-surface) / 0.35) 0%, transparent 100%)",
            pointerEvents:  "none",
            zIndex:         20,
          }}
        />
      </header>

      {/* ── Slider wrapper ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* 3-panel slider */}
        <div
          style={{
            display:    "flex",
            width:      "300vw",
            height:     "100%",
            transform:  `translateX(${-tabIndex * 100}vw)`,
            transition: "transform 0.34s cubic-bezier(0.16, 1, 0.3, 1)",
            willChange: "transform",
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >

          {/* ── Panel 0: Devices ──────────────────────────────────────── */}
          <div style={{ width: "100vw", height: "100%", overflowY: "auto", overflowX: "hidden" }}>

            <OwnDeviceCard />

            {/* Nearby heading + rescan */}
            <div className="flex items-center justify-between px-4 mb-3 mt-1">
              <div>
                <p className="text-[9px] font-mono uppercase tracking-[0.24em]"
                  style={{ color: "rgb(var(--rift-muted) / 0.48)" }}>
                  Nearby
                </p>
                {devices.length > 0 && (
                  <p className="text-[10px] font-mono mt-0.5" style={{ color: "rgb(var(--rift-accent) / 0.7)" }}>
                    {devices.length} in range
                  </p>
                )}
              </div>
              <button
                onClick={() => call("rescan")}
                className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-full transition-all"
                style={{
                  color:      "rgb(var(--rift-accent) / 0.85)",
                  background: "rgb(var(--rift-accent) / 0.08)",
                  boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
                }}
              >
                <span style={{ fontSize: 14 }}>↻</span>
                <span>Rescan</span>
              </button>
            </div>

            {devices.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center mx-4 rounded-3xl py-20 gap-6"
                style={{
                  background: "rgb(var(--rift-surface2) / 0.22)",
                  boxShadow:  "inset 0 2px 10px rgb(0 0 0 / 0.14)",
                }}
              >
                {/* Pulsing radar dot */}
                <div className="relative w-16 h-16 flex items-center justify-center">
                  {[0, 0.85, 1.7].map((delay) => (
                    <div
                      key={delay}
                      className="absolute inset-0 rounded-full animate-radar"
                      style={{
                        animationDelay: `${delay}s`,
                        boxShadow: "0 0 0 1.5px rgb(var(--rift-accent) / 0.28)",
                      }}
                    />
                  ))}
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{
                      background: "rgb(var(--rift-accent))",
                      boxShadow:  "0 0 24px rgb(var(--rift-glow) / 0.9)",
                    }}
                  />
                </div>
                <div className="text-center px-8">
                  <p className="text-xs font-mono font-semibold mb-1.5" style={{ color: "rgb(var(--rift-muted) / 0.6)" }}>
                    Scanning
                  </p>
                  <p className="text-[10px] font-mono leading-relaxed" style={{ color: "rgb(var(--rift-muted) / 0.38)" }}>
                    Open The Rift on another device on the same Wi-Fi network
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 px-4">
                {devices.map((d) => (
                  <MobileDeviceRow key={d.id} deviceId={d.id} />
                ))}
              </div>
            )}

            <div style={{ height: 40 }} />
          </div>

          {/* ── Panel 1: Send ─────────────────────────────────────────── */}
          <div style={{ width: "100vw", height: "100%", overflowY: "auto", overflowX: "hidden" }}>

            {/* Portal3D — centred hero, scrolls with page */}
            <div
              style={{
                display:        "flex",
                flexDirection:  "column",
                alignItems:     "center",
                paddingTop:     8,
              }}
            >
              {/* Subtle label above sphere */}
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
              />
            </div>

            {/* Controls */}
            <div className="px-4 flex flex-col gap-4 pb-10">

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
                    <p className="text-[9px] font-mono uppercase tracking-widest" style={{ color: "rgb(var(--rift-muted) / 0.5)" }}>
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
                    onClick={() => setTextMode(mode === "text")}
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

              {/* FILES */}
              {!textMode && (
                <>
                  {stagedFiles.length === 0 ? (
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={browse}
                        className="w-full py-12 rounded-3xl flex flex-col items-center gap-3 active:scale-[0.98] transition-transform duration-150"
                        style={{
                          background:     "rgb(var(--rift-surface2) / 0.28)",
                          boxShadow:      "0 0 0 1.5px rgb(var(--rift-accent) / 0.1) inset, 0 4px 20px rgb(0 0 0 / 0.2), inset 0 1px 0 rgb(255 255 255 / 0.04)",
                          backdropFilter: "blur(16px)",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "2rem",
                            color: "rgb(var(--rift-accent) / 0.42)",
                            filter: "drop-shadow(0 0 16px rgb(var(--rift-glow) / 0.45))",
                          }}
                        >
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

                      <button
                        onClick={browseFolder}
                        className="w-full py-3 rounded-2xl flex items-center justify-center gap-2 active:scale-[0.98] transition-transform duration-150"
                        style={{
                          background: "rgb(var(--rift-surface2) / 0.22)",
                          boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.11)",
                        }}
                      >
                        <span style={{ fontSize: 15 }}>📁</span>
                        <span className="text-[11px] font-mono font-semibold" style={{ color: "rgb(var(--rift-accent) / 0.68)" }}>
                          Select folder
                        </span>
                      </button>
                    </div>
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
                            onClick={clearStaged}
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
                          <p key={i} className="text-[10px] font-mono truncate py-0.5"
                            style={{ color: "rgb(var(--rift-muted) / 0.58)" }}>
                            {f.name}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={sendFiles}
                    disabled={!canSendFiles}
                    className="w-full py-4 rounded-2xl font-mono text-sm font-bold tracking-[0.1em] uppercase transition-all duration-200 btn-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    {isSending ? "Sending…" : "Send Through"}
                  </button>
                </>
              )}

              {/* TEXT */}
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

          {/* ── Panel 2: Transfers ────────────────────────────────────── */}
          <div style={{ width: "100vw", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
            <div
              className="px-4 pt-4 pb-2 flex items-center justify-between"
            >
              <p className="text-[9px] font-mono uppercase tracking-[0.24em]"
                style={{ color: "rgb(var(--rift-muted) / 0.48)" }}>
                {transfers.length} transfer{transfers.length !== 1 ? "s" : ""}
              </p>
              {transfers.filter((t) => t.status === "complete").length > 0 && (
                <span
                  className="text-[9px] font-mono font-bold px-2.5 py-1 rounded-full"
                  style={{
                    color:      "rgb(var(--rift-success))",
                    background: "rgb(var(--rift-success) / 0.1)",
                    boxShadow:  "0 0 0 1px rgb(var(--rift-success) / 0.2)",
                  }}
                >
                  {transfers.filter((t) => t.status === "complete").length} done
                </span>
              )}
            </div>

            {transfers.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center mx-4 rounded-3xl py-24 gap-4"
                style={{
                  background: "rgb(var(--rift-surface2) / 0.22)",
                  boxShadow:  "inset 0 2px 10px rgb(0 0 0 / 0.12)",
                }}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{
                    background: "rgb(var(--rift-surface2) / 0.48)",
                    boxShadow:  "inset 0 1px 0 rgb(255 255 255 / 0.04)",
                  }}
                >
                  <span className="text-base font-mono font-bold" style={{ color: "rgb(var(--rift-muted) / 0.24)" }}>
                    TX
                  </span>
                </div>
                <p className="text-xs font-mono" style={{ color: "rgb(var(--rift-muted) / 0.36)" }}>
                  No transfers yet
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 px-4 pb-8">
                {transfers.map((t) => (
                  <TransferItem key={t.id} transfer={t} />
                ))}
              </div>
            )}
          </div>

        </div>{/* end slider */}

        {/* Bottom bleed: content melts into tab bar */}
        <div
          aria-hidden
          style={{
            position:      "absolute",
            bottom:        0,
            left:          0,
            right:         0,
            height:        36,
            pointerEvents: "none",
            background:    "linear-gradient(to top, rgb(var(--rift-bg)) 0%, transparent 100%)",
          }}
        />
      </div>{/* end slider wrapper */}

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <nav
        style={{
          flexShrink:     0,
          position:       "relative",
          zIndex:         10,
          background:     "rgb(var(--rift-surface) / 0.96)",
          backdropFilter: "blur(52px) saturate(190%)",
          paddingBottom:  "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {/* Top bleed: tab bar emerges from content */}
        <div
          aria-hidden
          style={{
            position:      "absolute",
            top:           -28,
            left:          0,
            right:         0,
            height:        28,
            pointerEvents: "none",
            background:    "linear-gradient(to top, rgb(var(--rift-surface) / 0.65) 0%, transparent 100%)",
          }}
        />

        {/* Sliding top accent bar */}
        <div
          style={{
            position:   "absolute",
            top:        0,
            height:     2.5,
            width:      "calc(100% / 3)",
            borderRadius: "0 0 4px 4px",
            background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)))",
            transform:  `translateX(${tabIndex * 100}%)`,
            transition: "transform 0.34s cubic-bezier(0.16, 1, 0.3, 1)",
            boxShadow:  "0 0 16px rgb(var(--rift-glow) / 0.8), 0 0 6px rgb(var(--rift-glow) / 0.5)",
          }}
        />

        {/* Tab buttons */}
        <div className="flex">
          {([
            { id: "devices",   icon: "◈", label: "Devices",   badge: devices.length > 0 ? devices.length : null },
            { id: "send",      icon: "⤵", label: "Send",      badge: stagedFiles.length > 0 ? stagedFiles.length : null },
            { id: "transfers", icon: "↕", label: "History",   badge: activeXfers > 0 ? activeXfers : null },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex-1 relative flex flex-col items-center gap-1 py-3.5 transition-all duration-150"
              style={{ color: tab === t.id ? "rgb(var(--rift-accent))" : "rgb(var(--rift-muted) / 0.38)" }}
            >
              <span
                style={{
                  fontSize:   "1.1rem",
                  lineHeight: 1,
                  filter:     tab === t.id ? "drop-shadow(0 0 8px rgb(var(--rift-glow) / 0.7))" : "none",
                  transition: "filter 0.22s ease",
                }}
              >
                {t.icon}
              </span>
              <span
                className="font-mono uppercase"
                style={{
                  fontSize:      "8px",
                  letterSpacing: "0.18em",
                  fontWeight:    tab === t.id ? 700 : 400,
                }}
              >
                {t.label}
              </span>
              {t.badge !== null && (
                <span
                  className="absolute top-2 right-[calc(50%-18px)] min-w-[16px] h-4 rounded-full text-[8px] font-mono font-bold flex items-center justify-center px-1"
                  style={{
                    background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
                    color:      "rgb(var(--rift-bg))",
                    boxShadow:  "0 0 10px rgb(var(--rift-glow) / 0.55)",
                  }}
                >
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Overlays ────────────────────────────────────────────────────── */}
      <AcceptDialog />
      <IncomingTextDialog />
      <DevicePopup />
      {themeOpen && <MobileThemePicker onClose={() => setThemeOpen(false)} />}
    </div>
  );
}