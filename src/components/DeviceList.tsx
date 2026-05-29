import { useRiftStore } from "@/store/riftStore";
import { useInvoke } from "@/hooks/useTauri";
import { DeviceCard } from "./DeviceCard";

const SCX = 75;
const SCY = 48;
const SRX = 64;
const SRY = 23;

// Slowed way down: 8s base, 4-ripple stagger at 2s each = full 8s cycle
// The bounce-back and secondary spread are kept but stretched in time.
// Result: a calm, breathing sonar feel instead of a rushed radar sweep.
const SCAN_CSS = `
  @keyframes s3dOut {
    0%   { transform: scale(0.04); opacity: 0;    }
    8%   { opacity: 0.85;                          }
    44%  { transform: scale(1);    opacity: 0.78;  }
    55%  { transform: scale(0.9);  opacity: 0.62;  }
    70%  { transform: scale(1.06); opacity: 0.38;  }
    100% { transform: scale(1.28); opacity: 0;     }
  }
  @keyframes s3dBeacon {
    0%, 100% { opacity: 0.35; transform: scale(1);    }
    50%       { opacity: 0.95; transform: scale(1.35); }
  }
  @keyframes s3dPlane {
    0%, 100% { opacity: 0.07; }
    50%       { opacity: 0.13; }
  }
  @keyframes s3dBloom {
    0%, 100% { opacity: 0.05; }
    50%       { opacity: 0.14; }
  }
`;

function ScanAnimation3D() {
  const ripples = [0, 1, 2, 3];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-6 py-8">
      <div className="relative flex-shrink-0">
        <svg
          width={150}
          height={96}
          viewBox="0 0 150 96"
          style={{ overflow: "visible" }}
        >
          <style>{SCAN_CSS}</style>
          <defs>
            <mask id="s3dF">
              <rect x="0" y={SCY} width="150" height="96" fill="white"/>
            </mask>
            <mask id="s3dB">
              <rect x="0" y="0" width="150" height={SCY} fill="white"/>
            </mask>
            <filter id="s3dG" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="4.5"/>
            </filter>
            <filter id="s3dL" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="14"/>
            </filter>
          </defs>

          {/* Static reference rings */}
          <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
            fill="none" strokeWidth="0.6" strokeOpacity="0"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 6s ease-in-out infinite" }}/>
          <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
            fill="none" strokeWidth="0.6" strokeOpacity="0.22"
            mask="url(#s3dF)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 6s ease-in-out infinite" }}/>
          <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
            fill="none" strokeWidth="0.4" strokeOpacity="0.08"
            mask="url(#s3dB)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 6s ease-in-out infinite" }}/>

          <ellipse cx={SCX} cy={SCY} rx={SRX * 0.6} ry={SRY * 0.6}
            fill="none" strokeWidth="0.4" strokeOpacity="0.14"
            mask="url(#s3dF)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 6s ease-in-out 1s infinite" }}/>
          <ellipse cx={SCX} cy={SCY} rx={SRX * 0.6} ry={SRY * 0.6}
            fill="none" strokeWidth="0.3" strokeOpacity="0.05"
            mask="url(#s3dB)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 6s ease-in-out 1s infinite" }}/>

          <ellipse cx={SCX} cy={SCY} rx={SRX * 0.3} ry={SRY * 0.3}
            fill="none" strokeWidth="0.3" strokeOpacity="0.08"
            mask="url(#s3dF)"
            style={{ stroke: "rgb(0,200,255)", animation: "s3dPlane 6s ease-in-out 2s infinite" }}/>

          {/* 4 staggered ripples — 8s duration, 2s apart = smooth continuous wave */}
          {ripples.map((i) => (
            <g
              key={i}
              style={{
                transformBox: "fill-box",
                transformOrigin: "50% 50%",
                // 8s per ripple, staggered by 2s (8/4 = 2s per slot)
                animation: `s3dOut 8s cubic-bezier(0.4,0,0.6,1) ${(-i * 2).toFixed(1)}s infinite`,
              }}
            >
              <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
                fill="none" strokeWidth="14" strokeOpacity="0.06"
                filter="url(#s3dG)"
                style={{ stroke: "rgb(0,200,255)" }}
              />
              <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
                fill="none" strokeWidth="1" strokeOpacity="0.18"
                mask="url(#s3dB)"
                style={{ stroke: "rgb(0,200,255)" }}
              />
              <ellipse cx={SCX} cy={SCY} rx={SRX} ry={SRY}
                fill="none" strokeWidth="1.8" strokeOpacity="0.92"
                mask="url(#s3dF)"
                style={{ stroke: "rgb(0,200,255)" }}
              />
            </g>
          ))}

          {/* Center beacon — slowed breathing */}
          <ellipse cx={SCX} cy={SCY} rx={22} ry={8}
            fill="rgb(0,200,255)" fillOpacity="0.06"
            filter="url(#s3dL)"
            style={{ animation: "s3dBloom 4s ease-in-out infinite" }}
          />
          <circle cx={SCX} cy={SCY} r="10"
            fill="none" stroke="rgb(0,200,255)" strokeWidth="6" strokeOpacity="0.06"
            filter="url(#s3dG)"
            style={{ animation: "s3dBeacon 4s ease-in-out infinite" }}
          />
          <circle cx={SCX} cy={SCY} r="3"
            fill="rgb(0,200,255)" fillOpacity="0.85"
            style={{
              transformBox: "fill-box",
              transformOrigin: "50% 50%",
              animation: "s3dBeacon 4s ease-in-out infinite",
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