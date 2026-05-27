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

// ── Portal geometry (module-level) ────────────────────────────────────────────
const PCX = 150, PCY = 150, PSR = 52;

function ellipsePerim(rx: number, ry: number): number {
  const h = ((rx - ry) / (rx + ry)) ** 2;
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

interface RingSpec {
  rx: number; ry: number; rgb: string;
  dur: string; delay: string; sw: number; gsw: number;
}

// Dramatically different inclinations for genuine 3D depth:
// Ring 0 — near-equatorial (ratio 8.4:1, flat disc)
// Ring 1 — mid-inclined   (ratio 1.7:1, 45° tilt)
// Ring 2 — near-polar     (ratio ~1:1, almost circular)
const BASE_RINGS: RingSpec[] = [
  { rx: 118, ry: 14,  rgb: "0,200,255",   dur: "5.5s",  delay: "0s",    sw: 1.2, gsw: 10 },
  { rx: 85,  ry: 50,  rgb: "130,75,255",  dur: "8.4s",  delay: "-2.6s", sw: 1.5, gsw: 12 },
  { rx: 62,  ry: 61,  rgb: "170,210,255", dur: "11.2s", delay: "-5.8s", sw: 1.8, gsw: 14 },
];

const RINGS = BASE_RINGS.map((r, i) => {
  const C    = Math.round(ellipsePerim(r.rx, r.ry));
  const gLen = Math.round(C * 0.14);
  const cLen = Math.round(C * 0.052);
  return { ...r, C, gLen, gGap: C - gLen, cLen, cGap: C - cLen, cls: `rfrt${i}` };
});

// Half-arc path generators — back = top half (y < PCY), front = bottom half (y >= PCY)
const bArc = (rx: number, ry: number) =>
  `M ${PCX + rx},${PCY} A ${rx},${ry} 0 0,1 ${PCX - rx},${PCY}`;
const fArc = (rx: number, ry: number) =>
  `M ${PCX - rx},${PCY} A ${rx},${ry} 0 0,1 ${PCX + rx},${PCY}`;

// CSS: dashoffset animation per ring + breathe for base strokes
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
  // spec.cx/cy: 0–100 percentages, now covering the full sphere surface
  const [spec, setSpec] = useState({ cx: 50, cy: 50 });

  const state    = dragging ? "drop" : isSending ? "send" : hasFiles ? "ready" : "idle";
  const baseRgb  = state === "send" ? "130,75,255" : "0,200,255";
  const ambAlpha = dragging ? 0.22 : state === "ready" ? 0.12 : 0.065;
  const isRest   = tilt.x === 0 && tilt.y === 0;

  function onMouseMove(e: MouseEvent<HTMLDivElement>) {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    const nx = (e.clientX - r.left - r.width  / 2) / (r.width  / 2); // -1..1
    const ny = (e.clientY - r.top  - r.height / 2) / (r.height / 2); // -1..1
    // Increased tilt range from ±13° to ±22° for more dramatic 3D
    setTilt({ x: ny * -22, y: nx * 22 });
    // Full sphere coverage: spec ranges 6%–94% instead of the old narrow 23%–49%
    setSpec({ cx: 50 + nx * 44, cy: 50 + ny * 44 });
  }

  function onMouseLeave() {
    setTilt({ x: 0, y: 0 });
    setSpec({ cx: 50, cy: 50 });
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
          transform: `perspective(700px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: isRest
            ? "transform 0.72s cubic-bezier(0.16,1,0.3,1)"
            : "transform 0.09s ease-out",
        }}
      >
        <defs>
          {/* Ring animations + breathe keyframes */}
          <style>{RING_CSS}</style>

          {/* ── Hemisphere masks for genuine 3D ring occlusion ───────── */}
          {/* Front hemisphere: only shows y >= PCY (bottom half = front of orbit) */}
          <mask id="rfFH">
            <rect x="0" y={PCY} width="300" height="300" fill="white"/>
          </mask>
          {/* Back hemisphere: only shows y < PCY (top half = back of orbit) */}
          <mask id="rfBH">
            <rect x="0" y="0" width="300" height={PCY} fill="white"/>
          </mask>

          {/* ── Filters ─────────────────────────────────────────────── */}
          {/* Sharp glow — preserves bright core */}
          <filter id="rfsm" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          {/* Soft medium blur for arc halos */}
          <filter id="rfmd" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9"/>
          </filter>
          {/* Large blur for ambient background */}
          <filter id="rflg" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="22"/>
          </filter>

          {/* ── Sphere gradients ─────────────────────────────────────── */}
          {/* Main 3D fill — bright specular tracks mouse across full sphere */}
          <radialGradient id="rfsph" cx={`${spec.cx}%`} cy={`${spec.cy}%`} r="70%">
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity="0.52"/>
            <stop offset="35%"  stopColor="rgb(9,7,26)"        stopOpacity="0.92"/>
            <stop offset="100%" stopColor="rgb(4,4,12)"        stopOpacity="1"/>
          </radialGradient>

          {/* Rim edge — accent color bleeds at the sphere silhouette */}
          <radialGradient id="rfrim" cx="50%" cy="50%" r="50%">
            <stop offset="62%"  stopColor="transparent"       stopOpacity="0"/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`} stopOpacity="0.32"/>
          </radialGradient>

          {/* Primary specular hot-spot — no clamp, tracks mouse fully */}
          <radialGradient
            id="rfsp2"
            cx={`${spec.cx}%`}
            cy={`${spec.cy - 5}%`}
            r="19%"
          >
            <stop offset="0%"   stopColor="white" stopOpacity="0.90"/>
            <stop offset="55%"  stopColor="white" stopOpacity="0.14"/>
            <stop offset="100%" stopColor="white" stopOpacity="0"/>
          </radialGradient>

          {/* Secondary fill light — opposite side of specular (two-point lighting) */}
          <radialGradient
            id="rfsp3"
            cx={`${100 - spec.cx}%`}
            cy={`${100 - spec.cy}%`}
            r="45%"
          >
            <stop offset="0%"   stopColor={`rgb(${baseRgb})`} stopOpacity="0.16"/>
            <stop offset="100%" stopColor={`rgb(${baseRgb})`} stopOpacity="0"/>
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

        {/* ══ 1. Back arc dim base strokes — UNDER SPHERE ═════════════
            Opacity 0.025 vs front's 0.78 = 31× contrast → convincing 3D depth */}
        {RINGS.map((r, i) => (
          <path
            key={`bb${i}`}
            d={bArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw}
            strokeOpacity="0.025"
            className="rfrb"
          />
        ))}

        {/* ══ 2. Back arc dim halo — UNDER SPHERE ═════════════════════ */}
        {RINGS.map((r, i) => (
          <path
            key={`bh${i}`}
            d={bArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.gsw}
            strokeOpacity="0.025"
            filter="url(#rfmd)"
            className="rfrb"
          />
        ))}

        {/* ══ 3. Back traveling bright core — UNDER SPHERE ═════════════
            Masked to top-half (y < PCY). Sphere body naturally occludes
            whatever portion passes through the sphere's circular footprint.
            Dim (0.12) — the orbiting dot is barely visible behind the planet. */}
        {RINGS.map((r, i) => (
          <ellipse
            key={`tbd${i}`}
            cx={PCX} cy={PCY} rx={r.rx} ry={r.ry}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw + 0.8}
            strokeOpacity="0.12"
            strokeDasharray={`${r.cLen} ${r.cGap}`}
            className={r.cls}
            mask="url(#rfBH)"
          />
        ))}

        {/* ══ 4. Sphere drop shadow ════════════════════════════════════ */}
        <ellipse
          cx={PCX + 3} cy={PCY + 15}
          rx={46} ry={11}
          fill="black"
          opacity="0.45"
          filter="url(#rfmd)"
        />

        {/* ══ 5. Sphere body — fully opaque edge occludes back arcs ════ */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfsph)"/>

        {/* ══ 6. Sphere rim edge glow ══════════════════════════════════ */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfrim)"/>

        {/* ══ 7. Sphere inner structural depth rings ═══════════════════ */}
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

        {/* ══ 8. Secondary fill light (rim lighting, opposite specular) */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfsp3)"/>

        {/* ══ 9. Primary specular hot-spot — full sphere tracking ══════ */}
        <circle cx={PCX} cy={PCY} r={PSR} fill="url(#rfsp2)"/>

        {/* ══ 10. Front arc bright base strokes — ABOVE SPHERE ══════════
             Opacity 0.78 with breathe → ranges 0.39–0.70. 31× brighter than back. */}
        {RINGS.map((r, i) => (
          <path
            key={`fb${i}`}
            d={fArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw}
            strokeOpacity="0.78"
            className="rfrb"
          />
        ))}

        {/* ══ 11. Front arc bright halo — ABOVE SPHERE ════════════════ */}
        {RINGS.map((r, i) => (
          <path
            key={`fh${i}`}
            d={fArc(r.rx, r.ry)}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.gsw * 1.6}
            strokeOpacity="0.18"
            filter="url(#rfsm)"
          />
        ))}

        {/* ══ 12. Ambient traveling halo — full ellipse, bloom only ════
             Very dim (0.08) — creates a luminous trail around the full orbit
             without revealing the back arc position. */}
        {RINGS.map((r, i) => (
          <ellipse
            key={`tg${i}`}
            cx={PCX} cy={PCY} rx={r.rx} ry={r.ry}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.gsw * 2}
            strokeOpacity="0.08"
            strokeDasharray={`${r.gLen} ${r.gGap}`}
            className={r.cls}
            filter="url(#rfsm)"
          />
        ))}

        {/* ══ 13. Front traveling bright core — ABOVE SPHERE, MASKED ═══
             Masked to bottom-half (y >= PCY). Brilliant (0.95).
             The dot blazes in front, vanishes behind — genuine orbital occlusion. */}
        {RINGS.map((r, i) => (
          <ellipse
            key={`tfd${i}`}
            cx={PCX} cy={PCY} rx={r.rx} ry={r.ry}
            fill="none"
            stroke={`rgb(${r.rgb})`}
            strokeWidth={r.sw + 0.8}
            strokeOpacity="0.95"
            strokeDasharray={`${r.cLen} ${r.cGap}`}
            className={r.cls}
            mask="url(#rfFH)"
          />
        ))}

        {/* ══ 14. Sphere state label ════════════════════════════════════ */}
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