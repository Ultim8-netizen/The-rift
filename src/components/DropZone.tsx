import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";
import { useInvoke } from "@/hooks/useTauri";
import { StagedFile } from "@/types";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readDir, stat } from "@tauri-apps/plugin-fs";

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

// ── File system helpers ───────────────────────────────────────────────────────

/** Build a full path from a directory and an entry name, inferring the OS separator. */
function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\")
    ? dir + name
    : dir + sep + name;
}

/** Recursively enumerate all files under a directory. Returns empty array on any error. */
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

/**
 * Expand a mixed list of file and directory paths into only file paths.
 * Directories are recursively enumerated. Unknown paths are passed through.
 */
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
      // stat failed (permission denied, bad path, etc.) — pass through unchanged
      result.push(p);
    }
  }
  return result;
}

// ── Portal geometry ───────────────────────────────────────────────────────────
const PCX = 150, PCY = 150, PSR = 58;

function ellipsePerim(rx: number, ry: number): number {
  const h = ((rx - ry) / (rx + ry)) ** 2;
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

interface RingSpec {
  rx: number; ry: number; rgb: string;
  dur: string; delay: string; sw: number; gsw: number;
  tiltX: number;
}

const BASE_RINGS: RingSpec[] = [
  { rx: 118, ry: 14,  rgb: "0,200,255",   dur: "5.5s",  delay: "0s",    sw: 1.2, gsw: 10, tiltX: 0 },
  { rx: 85,  ry: 50,  rgb: "130,75,255",  dur: "8.4s",  delay: "-2.6s", sw: 1.5, gsw: 12, tiltX: 0 },
  { rx: 62,  ry: 61,  rgb: "170,210,255", dur: "11.2s", delay: "-5.8s", sw: 1.8, gsw: 14, tiltX: 0 },
];

const RINGS = BASE_RINGS.map((r, i) => {
  const C    = Math.round(ellipsePerim(r.rx, r.ry));
  const gLen = Math.round(C * 0.14);
  const cLen = Math.round(C * 0.052);
  return { ...r, C, gLen, gGap: C - gLen, cLen, cGap: C - cLen, cls: `rfrt${i}` };
});

const bArc = (rx: number, ry: number) =>
  `M ${PCX + rx},${PCY} A ${rx},${ry} 0 0,1 ${PCX - rx},${PCY}`;
const fArc = (rx: number, ry: number) =>
  `M ${PCX - rx},${PCY} A ${rx},${ry} 0 0,1 ${PCX + rx},${PCY}`;

const RING_CSS =
  RINGS.map((r) =>
    `.${r.cls}{animation:${r.cls}kf ${r.dur} linear infinite ${r.delay}}` +
    `@keyframes ${r.cls}kf{to{stroke-dashoffset:-${r.C}}}`
  ).join("") +
  `.rfrb{animation:rfbreath 4.5s ease-in-out infinite}` +
  `@keyframes rfbreath{0%,100%{opacity:.5}50%{opacity:.9}}`;

// ── Sphere physics ────────────────────────────────────────────────────────────
interface SphereShading {
  diffuseCx: number; diffuseCy: number;
  diffuseR: number; diffuseOpacity: number;
  specCx: number; specCy: number;
  specR: number; specOpacity: number;
  fillCx: number; fillCy: number;
  fillR: number; fillOpacity: number;
  rimOpacity: number; aoOpacity: number;
  shadowCx: number; shadowCy: number;
}

function computeShading(nx: number, ny: number): SphereShading {
  const lz = 0.6;
  const scale = Math.sqrt(1 - lz * lz) / Math.max(0.001, Math.sqrt(nx * nx + ny * ny) || 1);
  const lx = nx * scale, ly = ny * scale;
  const lLen = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const lxn = lx / lLen, lyn = ly / lLen, lzn = lz / lLen;
  const hx = lxn, hy = lyn, hz = lzn + 1;
  const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const hxn = hx / hLen, hyn = hy / hLen;
  const specCx = PCX + hxn * PSR * 0.72, specCy = PCY + hyn * PSR * 0.72;
  const diffuseCx = PCX + lxn * PSR * 0.38, diffuseCy = PCY + lyn * PSR * 0.38;
  const fillCx = PCX - lxn * PSR * 0.55, fillCy = PCY - lyn * PSR * 0.55;
  const shadowCx = PCX - lxn * PSR * 0.3, shadowCy = PCY - lyn * PSR * 0.3;
  return {
    diffuseCx, diffuseCy, diffuseR: PSR * 1.05,
    diffuseOpacity: 0.55 + 0.2 * lzn,
    specCx, specCy, specR: PSR * 0.28, specOpacity: 0.88,
    fillCx, fillCy, fillR: PSR * 0.9,
    fillOpacity: 0.08 + 0.04 * (1 - lzn),
    rimOpacity: 0.22 + 0.08 * (1 - Math.abs(lzn)),
    aoOpacity: 0.35,
    shadowCx, shadowCy,
  };
}

// ── Portal component ──────────────────────────────────────────────────────────
function Portal({ dragging, hasFiles, isSending }: {
  dragging: boolean;
  hasFiles: boolean;
  isSending: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [light, setLight] = useState({ nx: -0.4, ny: -0.6 });
  const state   = dragging ? "drop" : isSending ? "send" : hasFiles ? "ready" : "idle";
  const baseRgb = state === "send" ? "130,75,255" : "0,200,255";
  const ambAlpha = dragging ? 0.22 : state === "ready" ? 0.12 : 0.065;
  const shading = computeShading(light.nx, light.ny);

  function onMouseMove(e: MouseEvent<HTMLDivElement>) {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    const nx = ((e.clientX - r.left) / r.width  - 0.5) * 2;
    const ny = ((e.clientY - r.top)  / r.height - 0.5) * 2;
    setLight({ nx, ny });
  }
  function onMouseLeave() { setLight({ nx: -0.4, ny: -0.6 }); }

  const [sym, sub] =
    dragging   ? ["↓",  "DROP"]
    : isSending ? ["",   "SENDING"]
    : hasFiles  ? ["",   "READY"]
    :             ["◈",  "RIFT"];

  const uid = "portal";

  return (
    <div
      ref={containerRef}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={{ width: 260, height: 260, position: "relative", cursor: "default", flexShrink: 0 }}
    >
      <svg viewBox="0 0 300 300" width={260} height={260} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <style>{RING_CSS}</style>
          <mask id={`${uid}FH`}><rect x="0" y={PCY} width="300" height="300" fill="white"/></mask>
          <mask id={`${uid}BH`}><rect x="0" y="0" width="300" height={PCY} fill="white"/></mask>
          <clipPath id={`${uid}SC`}><circle cx={PCX} cy={PCY} r={PSR}/></clipPath>
          <filter id={`${uid}sm`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id={`${uid}md`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9"/>
          </filter>
          <filter id={`${uid}lg`} x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="22"/>
          </filter>
          <filter id={`${uid}sp`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.8"/>
          </filter>
          <filter id={`${uid}df`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6"/>
          </filter>
          <filter id={`${uid}rim`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4"/>
          </filter>
          <radialGradient id={`${uid}base`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="rgb(22,18,48)"  stopOpacity="1"/>
            <stop offset="60%"  stopColor="rgb(10,8,28)"   stopOpacity="1"/>
            <stop offset="100%" stopColor="rgb(4,3,14)"    stopOpacity="1"/>
          </radialGradient>
          <radialGradient
            id={`${uid}diff`}
            cx={`${((shading.diffuseCx - PCX + PSR) / (PSR * 2)) * 100}%`}
            cy={`${((shading.diffuseCy - PCY + PSR) / (PSR * 2)) * 100}%`}
            r="85%" gradientUnits="objectBoundingBox"
          >
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity={String(shading.diffuseOpacity)}/>
            <stop offset="40%"  stopColor={`rgb(${baseRgb})`} stopOpacity={String(shading.diffuseOpacity * 0.3)}/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`} stopOpacity="0"/>
          </radialGradient>
          <radialGradient
            id={`${uid}dark`}
            cx={`${((shading.shadowCx - PCX + PSR) / (PSR * 2)) * 100}%`}
            cy={`${((shading.shadowCy - PCY + PSR) / (PSR * 2)) * 100}%`}
            r="75%" gradientUnits="objectBoundingBox"
          >
            <stop offset="30%"  stopColor="rgb(0,0,0)" stopOpacity="0.72"/>
            <stop offset="100%" stopColor="rgb(0,0,0)" stopOpacity="0"/>
          </radialGradient>
          <radialGradient
            id={`${uid}spec`}
            cx={`${((shading.specCx - PCX + PSR) / (PSR * 2)) * 100}%`}
            cy={`${((shading.specCy - PCY + PSR) / (PSR * 2)) * 100}%`}
            r="22%" gradientUnits="objectBoundingBox"
          >
            <stop offset="0%"   stopColor="rgb(255,255,255)" stopOpacity={String(shading.specOpacity)}/>
            <stop offset="35%"  stopColor="rgb(220,240,255)" stopOpacity={String(shading.specOpacity * 0.35)}/>
            <stop offset="100%" stopColor="rgb(255,255,255)" stopOpacity="0"/>
          </radialGradient>
          <radialGradient
            id={`${uid}spec2`}
            cx={`${((shading.specCx - PCX + PSR) / (PSR * 2)) * 100}%`}
            cy={`${((shading.specCy - PCY + PSR) / (PSR * 2)) * 100}%`}
            r="40%" gradientUnits="objectBoundingBox"
          >
            <stop offset="0%"   stopColor="rgb(200,230,255)" stopOpacity={String(shading.specOpacity * 0.28)}/>
            <stop offset="100%" stopColor="rgb(200,230,255)" stopOpacity="0"/>
          </radialGradient>
          <radialGradient
            id={`${uid}fill`}
            cx={`${((shading.fillCx - PCX + PSR) / (PSR * 2)) * 100}%`}
            cy={`${((shading.fillCy - PCY + PSR) / (PSR * 2)) * 100}%`}
            r="75%" gradientUnits="objectBoundingBox"
          >
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity={String(shading.fillOpacity)}/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`} stopOpacity="0"/>
          </radialGradient>
          <radialGradient id={`${uid}ao`} cx="50%" cy="90%" r="50%">
            <stop offset="0%"   stopColor="rgb(0,0,0)" stopOpacity={String(shading.aoOpacity)}/>
            <stop offset="100%" stopColor="rgb(0,0,0)" stopOpacity="0"/>
          </radialGradient>
          <radialGradient id={`${uid}amb`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity={String(ambAlpha)}/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`} stopOpacity="0"/>
          </radialGradient>
          <linearGradient id={`${uid}tg`} x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`}/>
            <stop offset="100%" stopColor="rgb(180,120,255)"/>
          </linearGradient>
        </defs>

        <ellipse cx={PCX} cy={PCY} rx={145} ry={145} fill={`url(#${uid}amb)`} filter={`url(#${uid}lg)`}/>
        {RINGS.map((r, i) => (<path key={`bb${i}`} d={bArc(r.rx, r.ry)} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.sw} strokeOpacity="0.025" className="rfrb"/>))}
        {RINGS.map((r, i) => (<path key={`bh${i}`} d={bArc(r.rx, r.ry)} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.gsw} strokeOpacity="0.025" filter={`url(#${uid}md)`} className="rfrb"/>))}
        {RINGS.map((r, i) => (<ellipse key={`tbd${i}`} cx={PCX} cy={PCY} rx={r.rx} ry={r.ry} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.sw + 0.8} strokeOpacity="0.12" strokeDasharray={`${r.cLen} ${r.cGap}`} className={r.cls} mask={`url(#${uid}BH)`}/>))}
        <ellipse cx={PCX + 4} cy={PCY + 18} rx={48} ry={10} fill="black" opacity="0.55" filter={`url(#${uid}md)`}/>
        <g clipPath={`url(#${uid}SC)`}>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}base)`}/>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}diff)`}/>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}dark)`}/>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}fill)`}/>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}ao)`}/>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}spec2)`}/>
          <circle cx={PCX} cy={PCY} r={PSR} fill={`url(#${uid}spec)`}/>
        </g>
        <circle cx={PCX} cy={PCY} r={PSR - 1} fill="none" stroke={`rgb(${baseRgb})`} strokeWidth="10" strokeOpacity={String(shading.rimOpacity * 0.5)} filter={`url(#${uid}rim)`}/>
        <circle cx={PCX} cy={PCY} r={PSR - 0.5} fill="none" stroke={`rgb(${baseRgb})`} strokeWidth="1.2" strokeOpacity={String(shading.rimOpacity)}/>
        {RINGS.map((r, i) => (<path key={`fb${i}`} d={fArc(r.rx, r.ry)} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.sw} strokeOpacity="0.78" className="rfrb"/>))}
        {RINGS.map((r, i) => (<path key={`fh${i}`} d={fArc(r.rx, r.ry)} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.gsw * 1.6} strokeOpacity="0.18" filter={`url(#${uid}sm)`}/>))}
        {RINGS.map((r, i) => (<ellipse key={`tg${i}`} cx={PCX} cy={PCY} rx={r.rx} ry={r.ry} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.gsw * 2} strokeOpacity="0.08" strokeDasharray={`${r.gLen} ${r.gGap}`} className={r.cls} filter={`url(#${uid}sm)`}/>))}
        {RINGS.map((r, i) => (<ellipse key={`tfd${i}`} cx={PCX} cy={PCY} rx={r.rx} ry={r.ry} fill="none" stroke={`rgb(${r.rgb})`} strokeWidth={r.sw + 0.8} strokeOpacity="0.95" strokeDasharray={`${r.cLen} ${r.cGap}`} className={r.cls} mask={`url(#${uid}FH)`}/>))}
        <g filter={`url(#${uid}sm)`}>
          {sym && (
            <text x={PCX} y={sub ? PCY - 4 : PCY + 5} textAnchor="middle" dominantBaseline="middle"
              fontFamily="'JetBrains Mono', monospace" fontSize={sym === "◈" ? 22 : 28} fontWeight="900"
              fill={`url(#${uid}tg)`}>{sym}</text>
          )}
          {sub && (
            <text x={PCX} y={sym ? PCY + 14 : PCY + 5} textAnchor="middle" dominantBaseline="middle"
              fontFamily="'JetBrains Mono', monospace" fontSize="9" fontWeight="700" letterSpacing="3"
              fill={`rgb(${baseRgb})`} fillOpacity="0.82">{sub}</text>
          )}
        </g>
      </svg>
    </div>
  );
}

// ── DropZone ──────────────────────────────────────────────────────────────────

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

  // Stage from a list of raw paths — directories are expanded recursively.
  const stageFromPaths = useCallback(
    async (rawPaths: string[]) => {
      if (!rawPaths.length) return;
      try {
        const filePaths = await expandToPaths(rawPaths);
        if (!filePaths.length) return;
        const files = await call<StagedFile[]>("get_file_metadata", { paths: filePaths });
        setStagedFiles(files);
      } catch (e) { console.error(e); }
    },
    [call, setStagedFiles]
  );

  // Drag-and-drop (handles both files and folders dropped onto the window).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over") setIsDragging(true);
        else if (e.payload.type === "drop") {
          setIsDragging(false);
          void stageFromPaths(e.payload.paths ?? []);
        } else setIsDragging(false);
      })
      .then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [stageFromPaths]);

  // File picker (files only, multiple selection).
  async function browse() {
    try {
      const res = await open({ multiple: true, directory: false });
      if (!res) return;
      await stageFromPaths(Array.isArray(res) ? res : [res]);
    } catch (e) { console.error(e); }
  }

  // Folder picker — opens a directory chooser and enumerates it recursively.
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

      {/* 3D Sphere */}
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
                (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent2))";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent))";
              }}
            >
              browse
            </button>
            {" "}·{" "}
            <button
              onClick={browseFolder}
              className="font-mono text-xs transition-colors"
              style={{ color: "rgb(var(--rift-accent))" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent2))";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-accent))";
              }}
            >
              folder
            </button>
          </p>
          <p
            className="text-[10px] font-mono tracking-wide"
            style={{ color: "rgb(var(--rift-muted) / 0.35)" }}
          >
            Any type · Any size · Folders included
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
                color:      "rgb(var(--rift-error) / 0.75)",
                background: "rgb(var(--rift-error) / 0.08)",
                boxShadow:  "0 0 0 1px rgb(var(--rift-error) / 0.15)",
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
            boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
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
            width:           "44px",
            height:          "44px",
            background:      "rgb(var(--rift-surface2) / 0.55)",
            boxShadow:       "0 0 0 1px rgb(255 255 255 / 0.06), 0 2px 8px rgb(0 0 0 / 0.25)",
            backdropFilter:  "blur(12px)",
            flexShrink:      0,
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
            <polygon points="2,2 13,2 16,5 16,16 2,16" fill="rgb(var(--rift-accent) / 0.15)" stroke="rgb(var(--rift-accent) / 0.55)" strokeWidth="1.2" strokeLinejoin="round"/>
            <polygon points="13,2 16,5 13,5" fill="rgb(var(--rift-accent) / 0.3)" stroke="rgb(var(--rift-accent) / 0.55)" strokeWidth="1.2" strokeLinejoin="round"/>
            <line x1="5" y1="8"  x2="13" y2="8"  stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round"/>
            <line x1="5" y1="11" x2="13" y2="11" stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round"/>
            <line x1="5" y1="14" x2="10" y2="14" stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}