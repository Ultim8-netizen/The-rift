import { useRiftStore } from "@/store/riftStore";
import { useInvoke } from "@/hooks/useTauri";
import { DeviceCard } from "./DeviceCard";

// ── 3D Scan Animation constants (module-level, computed once) ─────────────────
const SCX = 75;   // SVG center x
const SCY = 48;   // SVG center y (slightly above midpoint for visual weight)
const SRX = 64;   // Maximum ring rx
const SRY = 23;   // Maximum ring ry — ratio 0.359 ≈ 21° elevation angle
// This ratio makes the ellipses look like concentric circles on a
// horizontal plane seen from ~21° above the horizon.

// CSS keyframes injected into the SVG — using unique names to avoid doc conflicts.
// s3dOut: expand → hit boundary → bounce back slightly → secondary spread → fade
// s3dBeacon: the center dot pulses
// s3dPlane: the static reference ellipses breathe very gently
const SCAN_CSS = `
  @keyframes s3dOut {
    0%   { transform: scale(0.04); opacity: 0;    }
    8%   { opacity: 0.9;                           }
    44%  { transform: scale(1);    opacity: 0.85;  }
    55%  { transform: scale(0.88); opacity: 0.72;  }
    67%  { transform: scale(1.07); opacity: 0.46;  }
    100% { transform: scale(1.32); opacity: 0;     }
  }
  @keyframes s3dBeacon {
    0%, 100% { opacity: 0.4;  transform: scale(1);   }
    50%       { opacity: 1.0;  transform: scale(1.4); }
  }
  @keyframes s3dPlane {
    0%, 100% { opacity: 0.07; }
    50%       { opacity: 0.14; }
  }
  @keyframes s3dBloom {
    0%, 100% { opacity: 0.06; }
    50%       { opacity: 0.16; }
  }
`;

function ScanAnimation3D() {
  // Each ripple group: 3 elements (back arc dim, ambient halo, front arc bright)
  // All three share the same CSS scale animation so they expand together as one ring.
  // front/back split via SVG masks — creates the tilted-plane 3D illusion.
  const ripples = [0, 1, 2, 3];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-6 py-8">
      <div className="relative flex-shrink-0">
        <svg
          width={150}
          height={96}
          viewBox={`0 0 150 96`}
          style={{ overflow: "visible" }}
        >
          <style>{SCAN_CSS}</style>
          <defs>
            {/* Front hemisphere mask: bottom half of SVG = front of 3D plane */}
            <mask id="s3dF">
              <rect x="0" y={SCY} width="150" height="96" fill="white"/>
            </mask>
            {/* Back hemisphere mask: top half of SVG = back of 3D plane */}
            <mask id="s3dB">
              <rect x="0" y="0" width="150" height={SCY} fill="white"/>
            </mask>
            {/* Soft glow filter for halos */}
            <filter id="s3dG" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="4.5"/>
            </filter>
            {/* Large bloom for center beacon */}
            <filter id="s3dL" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="14"/>
            </filter>
          </defs>

          {/* ── Static reference rings — establish the 3D ground plane ── */}
          {/* Outer boundary ring — the "wall" the ripples bounce off */}
          <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
            fill="none" strokeWidth="0.6" strokeOpacity="0"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 3s ease-in-out infinite" }}/>
          {/* Front half of boundary ring (brighter = closer) */}
          <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
            fill="none" strokeWidth="0.6" strokeOpacity="0.22"
            mask="url(#s3dF)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 3s ease-in-out infinite" }}/>
          <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
            fill="none" strokeWidth="0.4" strokeOpacity="0.08"
            mask="url(#s3dB)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 3s ease-in-out infinite" }}/>

          {/* Mid reference ring */}
          <ellipse cx={SCX} cy={SCY} rx={SRX * 0.6} ry={SRY * 0.6}
            fill="none" strokeWidth="0.4" strokeOpacity="0.14"
            mask="url(#s3dF)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 3s ease-in-out 0.5s infinite" }}/>
          <ellipse cx={SCX} cy={SCY} rx={SRX * 0.6} ry={SRY * 0.6}
            fill="none" strokeWidth="0.3" strokeOpacity="0.05"
            mask="url(#s3dB)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 3s ease-in-out 0.5s infinite" }}/>

          {/* Inner reference ring */}
          <ellipse cx={SCX} cy={SCY} rx={SRX * 0.3} ry={SRY * 0.3}
            fill="none" strokeWidth="0.3" strokeOpacity="0.08"
            mask="url(#s3dF)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 3s ease-in-out 1s infinite" }}/>

          {/* ── 4 staggered outward ripples ──────────────────────────── */}
          {ripples.map((i) => (
            <g
              key={i}
              style={{
                // transform-box fill-box + 50%/50% origin = scales around ellipse center
                transformBox: "fill-box",
                transformOrigin: "50% 50%",
                animation: `s3dOut 3.6s cubic-bezier(0.4,0,0.6,1) ${(-i * 0.9).toFixed(1)}s infinite`,
              }}
            >
              {/* Ambient halo — full ellipse, very dim, creates bloom trail */}
              <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
                fill="none" strokeWidth="14" strokeOpacity="0.06"
                filter="url(#s3dG)"
                style={{ stroke: "rgb(0,200,255)" }}
              />
              {/* Back arc (dim) — top half, receding, physically "behind" the plane */}
              <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
                fill="none" strokeWidth="1" strokeOpacity="0.18"
                mask="url(#s3dB)"
                style={{ stroke: "rgb(0,200,255)" }}
              />
              {/* Front arc (bright) — bottom half, approaching, physically "in front" */}
              <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
                fill="none" strokeWidth="1.8" strokeOpacity="0.92"
                mask="url(#s3dF)"
                style={{ stroke: "rgb(0,200,255)" }}
              />
            </g>
          ))}

          {/* ── Center beacon ─────────────────────────────────────────── */}
          {/* Bloom */}
          <ellipse cx={SCX} cy={SCY} rx={22} ry={8}
            fill="rgb(0,200,255)" fillOpacity="0.06"
            filter="url(#s3dL)"
            style={{ animation: "s3dBloom 2.4s ease-in-out infinite" }}
          />
          {/* Soft halo ring around beacon */}
          <circle cx={SCX} cy={SCY} r="10"
            fill="none" stroke="rgb(0,200,255)" strokeWidth="6" strokeOpacity="0.06"
            filter="url(#s3dG)"
            style={{ animation: "s3dBeacon 2s ease-in-out infinite" }}
          />
          {/* Beacon dot */}
          <circle cx={SCX} cy={SCY} r="3"
            fill="rgb(0,200,255)" fillOpacity="0.85"
            style={{
              transformBox: "fill-box",
              transformOrigin: "50% 50%",
              animation: "s3dBeacon 2s ease-in-out infinite",
            }}
          />
        </svg>
      </div>

      <div className="text-center">
        <p className="text-[11px] font-mono text-rift-muted tracking-[0.18em] uppercase mb-1.5">
          Scanning
        </p>
        <p
          className="text-[10px] font-mono leading-relaxed"
          style={{ color: "rgb(var(--rift-muted) / 0.48)" }}
        >
          Open The Rift on another
          <br />
          device on this network
        </p>
      </div>
    </div>
  );
}

export function DeviceList() {
  const devices = useRiftStore((s) => s.devices);
  const { call } = useInvoke();

  return (
    <div
      data-tour="device-list"
      className="glass flex flex-col flex-shrink-0"
      style={{ width: "232px", borderRadius: "22px" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3.5 flex-shrink-0"
        style={{
          background:
            "linear-gradient(180deg, rgb(var(--rift-surface) / 0.5) 0%, transparent 100%)",
          borderRadius: "22px 22px 0 0",
        }}
      >
        <div>
          <h2
            className="text-[9px] font-mono font-bold uppercase tracking-[0.22em]"
            style={{ color: "rgb(var(--rift-muted) / 0.65)" }}
          >
            Devices
          </h2>
          {devices.length > 0 && (
            <p
              className="text-[10px] font-mono mt-0.5"
              style={{ color: "rgb(var(--rift-accent) / 0.7)" }}
            >
              {devices.length} in range
            </p>
          )}
        </div>

        <button
          onClick={() => call("rescan")}
          className="w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200"
          style={{
            background: "rgb(var(--rift-surface2) / 0.5)",
            color: "rgb(var(--rift-muted))",
            fontSize: "14px",
            fontFamily: "monospace",
            boxShadow: "0 0 0 1px rgb(255 255 255 / 0.05)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.boxShadow =
              "0 0 0 1px rgb(var(--rift-accent) / 0.35), 0 0 12px rgb(var(--rift-glow) / 0.15)";
            (e.currentTarget as HTMLButtonElement).style.color =
              "rgb(var(--rift-accent))";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.boxShadow =
              "0 0 0 1px rgb(255 255 255 / 0.05)";
            (e.currentTarget as HTMLButtonElement).style.color =
              "rgb(var(--rift-muted))";
          }}
          title="Rescan"
        >
          ↻
        </button>
      </div>

      <div
        className="mx-3 flex-shrink-0"
        style={{
          height: "1px",
          background:
            "linear-gradient(90deg, transparent, rgb(var(--rift-accent) / 0.1), transparent)",
        }}
      />

      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
        {devices.length === 0 ? (
          <ScanAnimation3D />
        ) : (
          devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))
        )}
      </div>
    </div>
  );
}