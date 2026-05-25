// src/components/DropZone.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
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

// ── Portal geometry (module-level — computed once) ────────────────────────────
const PCX = 150, PCY = 150, PSR = 52;

function ellipsePerim(rx: number, ry: number): number {
  const h = ((rx - ry) / (rx + ry)) ** 2;
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

interface RingSpec {
  rx: number; ry: number; rgb: string;
  dur: string; delay: string; sw: number; gsw: number;
}

const BASE_RINGS: RingSpec[] = [
  // Equatorial: very flat ellipse, tilted ~75° from face-on
  { rx: 115, ry: 23,  rgb: "0,200,255",   dur: "5.5s",  delay: "0s",    sw: 1.2, gsw: 10 },
  // Intermediate: ~45° inclination
  { rx: 88,  ry: 56,  rgb: "130,75,255",  dur: "8.4s",  delay: "-2.6s", sw: 1.5, gsw: 12 },
  // Steep: nearly vertical, appears nearly circular
  { rx: 70,  ry: 67,  rgb: "170,210,255", dur: "11.2s", delay: "-5.8s", sw: 1.8, gsw: 14 },
];

const RINGS = BASE_RINGS.map((r, i) => {
  const C    = Math.round(ellipsePerim(r.rx, r.ry));
  const gLen = Math.round(C * 0.14);  // blurred halo segment length
  const cLen = Math.round(C * 0.052); // bright core segment length
  return { ...r, C, gLen, gGap: C - gLen, cLen, cGap: C - cLen, cls: `rfrt${i}` };
});

// Paths for upper (back) and lower (front) arcs — enables sphere to occlude correctly
const bArc = (rx: number, ry: number) =>
  `M ${PCX + rx},${PCY} A ${rx},${ry} 0 0,1 ${PCX - rx},${PCY}`;
const fArc = (rx: number, ry: number) =>
  `M ${PCX - rx},${PCY} A ${rx},${ry} 0 0,1 ${PCX + rx},${PCY}`;

// CSS injected into the SVG <style> tag — static, never recalculated
const RING_CSS =
  RINGS.map((r) =>
    `.${r.cls}{animation:${r.cls}kf ${r.dur} linear infinite ${r.delay}}` +
    `@keyframes ${r.cls}kf{to{stroke-dashoffset:-${r.C}}}`
  ).join("") +
  `.rfrb{animation:rfbreath 4.5s ease-in-out infinite}` +
  `@keyframes rfbreath{0%,100%{opacity:.5}50%{opacity:.9}}`;

// ─────────────────────────────────────────────────────────────────────────────

function Portal({
  dragging,
  hasFiles,
  isSending,
}: {
  dragging: boolean;
  hasFiles: boolean;
  isSending: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  // spec.cx / spec.cy: 0–100 percentages driving both sphere fill and specular
  const [spec, setSpec] = useState({ cx: 36, cy: 30 });

  const state    = dragging ? "drop" : isSending ? "send" : hasFiles ? "ready" : "idle";
  const baseRgb  = state === "send" ? "130,75,255" : "0,200,255";
  const ambAlpha = dragging ? 0.22 : state === "ready" ? 0.12 : 0.065;
  const isRest   = tilt.x === 0 && tilt.y === 0;

  function onMouseMove(e: MouseEvent<HTMLDivElement>) {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    const nx = (e.clientX - r.left - r.width  / 2) / (r.width  / 2); // -1..1
    const ny = (e.clientY - r.top  - r.height / 2) / (r.height / 2); // -1..1
    setTilt({ x: ny * -13, y: nx * 13 });
    setSpec({ cx: 36 + nx * 13, cy: 30 + ny * 11 });
  }

  function onMouseLeave() {
    setTilt({ x: 0, y: 0 });
    setSpec({ cx: 36, cy: 30 });
  }

  const [sym, sub] =
    dragging   ? ["↓",  "DROP"]
    : isSending ? ["",   "SENDING"]
    : hasFiles  ? ["",   "READY"]
    :             ["◈",  "RIFT"];

  return (
    <div
      ref={containerRef}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={{ width: 260, height: 260, position: "relative", cursor: "default", flexShrink: 0 }}
    >
      <svg
        viewBox="0 0 300 300"
        width={260}
        height={260}
        style={{
          display: "block",
          overflow: "visible",
          transform: `perspective(900px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: isRest
            ? "transform 0.72s cubic-bezier(0.16,1,0.3,1)"
            : "transform 0.09s ease-out",
        }}
      >
        <defs>
          {/* Ring animations + breathe keyframes — injected once at module scope */}
          <style>{RING_CSS}</style>

          {/* ── Filters ─────────────────────────────────────────────── */}
          {/* Glow with sharp core preserved */}
          <filter id="rfsm" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          {/* Soft medium blur for halos */}
          <filter id="rfmd" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9"/>
          </filter>
          {/* Large blur for ambient background blob */}
          <filter id="rflg" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="22"/>
          </filter>

          {/* ── Sphere gradients ─────────────────────────────────────── */}
          {/* Main 3D fill — bright spot tracks mouse via spec.cx/cy */}
          <radialGradient id="rfsph" cx={`${spec.cx}%`} cy={`${spec.cy}%`} r="70%">
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity="0.48"/>
            <stop offset="40%"  stopColor="rgb(9,7,26)"        stopOpacity="0.88"/>
            <stop offset="100%" stopColor="rgb(4,4,12)"        stopOpacity="1"/>
          </radialGradient>

          {/* Rim edge light */}
          <radialGradient id="rfrim" cx="50%" cy="50%" r="50%">
            <stop offset="60%"  stopColor="transparent"        stopOpacity="0"/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`}  stopOpacity="0.3"/>
          </radialGradient>

          {/* Specular hot-spot — offset slightly above mouse position */}
          <radialGradient
            id="rfsp2"
            cx={`${spec.cx}%`}
            cy={`${Math.max(8, spec.cy - 8)}%`}
            r="19%"
          >
            <stop offset="0%"   stopColor="white" stopOpacity="0.85"/>
            <stop offset="55%"  stopColor="white" stopOpacity="0.1"/>
            <stop offset="100%" stopColor="white" stopOpacity="0"/>
          </radialGradient>

          {/* Ambient background radial */}
          <radialGradient id="rfamb" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity={String(ambAlpha)}/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`} stopOpacity="0"/>
          </radialGradient>

          {/* Text gradient */}
          <linearGradient id="rftg" x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`}/>
            <stop offset="100%" stopColor="rgb(180,120,255)"/>
          </linearGradient>
        </defs>

        {/* ══ 0. Ambient background glow ══════════════════════════════ */}
        <ellipse
          cx={PCX} cy={PCY} rx={145} ry={145}
          fill="url(#rfamb)"
          filter="url(#rflg)"
        />

        {/* ══ 1. Back arc base strokes (rendered UNDER the sphere) ════ */}
        {RINGS.map((r, i) => (
          <path
            key={`bb${i}`}
            d={bArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw}
            strokeOpacity="0.13"
            className="rfrb"
          />
        ))}

        {/* ══ 2. Back arc blurred halo (under sphere) ═════════════════ */}
        {RINGS.map((r, i) => (
          <path
            key={`bh${i}`}
            d={bArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.gsw}
            strokeOpacity="0.05"
            filter="url(#rfmd)"
            className="rfrb"
          />
        ))}

        {/* ══ 3. Sphere drop shadow ════════════════════════════════════ */}
        <ellipse
          cx={PCX + 3} cy={PCY + 15}
          rx={46} ry={11}
          fill="black"
          opacity="0.45"
          filter="url(#rfmd)"
        />

        {/* ══ 4. Sphere body ═══════════════════════════════════════════ */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfsph)"/>

        {/* ══ 5. Sphere rim edge glow ══════════════════════════════════ */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfrim)"/>

        {/* ══ 6. Sphere inner structural depth rings ═══════════════════ */}
        <circle
          cx={PCX} cy={PCY} r={PSR - 9}
          fill="none"
          stroke={`rgb(${baseRgb})`}
          strokeWidth="0.5"
          strokeOpacity="0.13"
        />
        <circle
          cx={PCX} cy={PCY} r={PSR - 20}
          fill="none"
          stroke={`rgb(${baseRgb})`}
          strokeWidth="0.4"
          strokeOpacity="0.07"
        />

        {/* ══ 7. Specular highlight — tracks mouse ═════════════════════ */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfsp2)"/>

        {/* ══ 8. Front arc base strokes (rendered ABOVE sphere) ════════ */}
        {RINGS.map((r, i) => (
          <path
            key={`fb${i}`}
            d={fArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw}
            strokeOpacity="0.4"
            className="rfrb"
          />
        ))}

        {/* ══ 9. Front arc blurred halo (above sphere) ═════════════════ */}
        {RINGS.map((r, i) => (
          <path
            key={`fh${i}`}
            d={fArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.gsw * 1.6}
            strokeOpacity="0.08"
            filter="url(#rfsm)"
          />
        ))}

        {/* ══ 10. Traveling glow — blurred outer halo (full ellipse) ═══ */}
        {RINGS.map((r, i) => (
          <ellipse
            key={`tg${i}`}
            cx={PCX} cy={PCY} rx={r.rx} ry={r.ry}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.gsw * 2}
            strokeOpacity="0.22"
            strokeDasharray={`${r.gLen} ${r.gGap}`}
            className={r.cls}
            filter="url(#rfsm)"
          />
        ))}

        {/* ══ 11. Traveling glow — sharp bright core (full ellipse) ════ */}
        {RINGS.map((r, i) => (
          <ellipse
            key={`tc${i}`}
            cx={PCX} cy={PCY} rx={r.rx} ry={r.ry}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw + 0.6}
            strokeOpacity="0.95"
            strokeDasharray={`${r.cLen} ${r.cGap}`}
            className={r.cls}
          />
        ))}

        {/* ══ 12. Sphere state label ════════════════════════════════════ */}
        <g filter="url(#rfsm)">
          {sym && (
            <text
              x={PCX}
              y={sub ? PCY - 4 : PCY + 5}
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily="'JetBrains Mono', monospace"
              fontSize={sym === "◈" ? 22 : 28}
              fontWeight="900"
              fill="url(#rftg)"
            >
              {sym}
            </text>
          )}
          {sub && (
            <text
              x={PCX}
              y={sym ? PCY + 14 : PCY + 5}
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily="'JetBrains Mono', monospace"
              fontSize="9"
              fontWeight="700"
              letterSpacing="3"
              fill={`rgb(${baseRgb})`}
              fillOpacity="0.82"
            >
              {sub}
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

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

      {/* 3D SVG Portal */}
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
            <line x1="5" y1="8"  x2="13" y2="8"  stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round"/>
            <line x1="5" y1="11" x2="13" y2="11" stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round"/>
            <line x1="5" y1="14" x2="10" y2="14" stroke="rgb(var(--rift-accent) / 0.4)" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}