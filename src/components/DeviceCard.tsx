import { useState } from "react";
import type { MouseEvent } from "react";
import { Device } from "@/types";
import { useRiftStore } from "@/store/riftStore";

const OS_META: Record<string, { label: string; color: string }> = {
  windows: { label: "WIN", color: "rgb(var(--rift-accent) / 0.8)" },
  macos:   { label: "MAC", color: "rgb(var(--rift-accent2) / 0.8)" },
  linux:   { label: "NIX", color: "rgb(var(--rift-success) / 0.8)" },
  android: { label: "AND", color: "rgb(var(--rift-warning) / 0.8)" },
  unknown: { label: "SYS", color: "rgb(var(--rift-muted) / 0.6)" },
};

export function DeviceCard({ device }: { device: Device }) {
  const selectedDevice      = useRiftStore((s) => s.selectedDevice);
  const selectDevice        = useRiftStore((s) => s.selectDevice);
  const riftedDevices       = useRiftStore((s) => s.riftedDevices);
  const reconnectingDevices = useRiftStore((s) => s.reconnectingDevices);
  const setDevicePopup      = useRiftStore((s) => s.setDevicePopup);

  // 3D tilt (degrees) and surface-light position (0–100 %)
  const [tilt,    setTilt]    = useState({ x: 0, y: 0 });
  const [light,   setLight]   = useState({ x: 50, y: 50 });
  const [hovered, setHovered] = useState(false);

  const isSelected     = selectedDevice?.id === device.id;
  const isRifted       = riftedDevices.includes(device.id);
  const isReconnecting = reconnectingDevices.includes(device.id);
  const osMeta         = OS_META[device.os] ?? OS_META.unknown;

  let cardShadow: string;
  if (isSelected) {
    cardShadow = `
      0 4px 20px rgb(0 0 0 / 0.4),
      0 0 0 1px rgb(var(--rift-accent) / 0.5),
      0 0 40px rgb(var(--rift-glow) / 0.18),
      inset 0 1px 0 rgb(255 255 255 / 0.08)
    `;
  } else if (isRifted) {
    cardShadow = `
      0 2px 10px rgb(0 0 0 / 0.3),
      0 0 0 1px rgb(var(--rift-success) / 0.22),
      0 0 20px rgb(var(--rift-success) / 0.08),
      inset 0 1px 0 rgb(255 255 255 / 0.05)
    `;
  } else if (isReconnecting) {
    cardShadow = `
      0 2px 10px rgb(0 0 0 / 0.28),
      0 0 0 1px rgb(var(--rift-warning) / 0.28),
      0 0 18px rgb(var(--rift-warning) / 0.1),
      inset 0 1px 0 rgb(255 255 255 / 0.05)
    `;
  } else {
    cardShadow = `
      0 2px 10px rgb(0 0 0 / 0.25),
      0 0 0 1px rgb(255 255 255 / 0.04),
      inset 0 1px 0 rgb(255 255 255 / 0.05)
    `;
  }

  let cardBg: string;
  if (isSelected) {
    cardBg = `linear-gradient(145deg, rgb(var(--rift-accent) / 0.1), rgb(var(--rift-surface2) / 0.65))`;
  } else if (isReconnecting) {
    cardBg = `rgb(var(--rift-surface2) / 0.42)`;
  } else {
    cardBg = `rgb(var(--rift-surface2) / 0.48)`;
  }

  function handleCardClick() {
    if (!isSelected) {
      selectDevice(device);
    } else {
      setDevicePopup(device);
    }
  }

  function handleMouseMove(e: MouseEvent<HTMLButtonElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    // nx/ny: 0..1 across the card surface
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top)  / r.height;
    // Tilt: ±12° — (0.5-center) gives range -0.5..0.5, × 24 = ±12°
    setTilt({ x: (ny - 0.5) * -12, y: (nx - 0.5) * 12 });
    // Light position: 0–100% across card
    setLight({ x: nx * 100, y: ny * 100 });
  }

  return (
    <button
      onClick={handleCardClick}
      className="w-full text-left animate-slide-up"
      style={{
        background: cardBg,
        borderRadius: "16px",
        padding: "10px 12px",
        boxShadow: cardShadow,
        backdropFilter: "blur(20px)",
        // Required for the light overlay to clip to rounded corners
        position: "relative",
        overflow: "hidden",
        // Perspective tilt — fast while tracking, spring-like on release
        transform: `perspective(700px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        transition: hovered
          ? "transform 0.06s ease-out, box-shadow 0.18s ease"
          : "transform 0.65s cubic-bezier(0.16, 1, 0.3, 1), background 0.2s ease, box-shadow 0.2s ease",
      }}
      onMouseEnter={(e) => {
        setHovered(true);
        if (!isSelected) {
          (e.currentTarget as HTMLButtonElement).style.background =
            `rgb(var(--rift-surface2) / 0.7)`;
        }
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={(e) => {
        setTilt({ x: 0, y: 0 });
        setLight({ x: 50, y: 50 });
        setHovered(false);
        if (!isSelected) {
          (e.currentTarget as HTMLButtonElement).style.background = cardBg;
        }
      }}
    >
      {/* ── Surface light overlay ──────────────────────────────────────
          A radial gradient that moves with the mouse — simulates a physical
          light source illuminating the card surface from the cursor position.
          Three-stop: bright specular core → soft ambient lift → transparent edge. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "16px",
          pointerEvents: "none",
          background: `radial-gradient(circle at ${light.x}% ${light.y}%,
            rgb(255 255 255 / 0.12) 0%,
            rgb(255 255 255 / 0.04) 38%,
            transparent 62%)`,
          opacity: hovered ? 1 : 0,
          // Instant on hover (light appears immediately), slow fade on leave
          transition: hovered ? "opacity 0.08s ease" : "opacity 0.55s ease",
          zIndex: 0,
        }}
      />

      {/* ── Accent edge shimmer (Fresnel-like effect) ──────────────────
          Subtle accent-colored glow at the card edge opposite the light source —
          simulates light wrapping around the card's physical edge. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "16px",
          pointerEvents: "none",
          background: `radial-gradient(circle at ${100 - light.x}% ${100 - light.y}%,
            rgb(var(--rift-accent) / 0.06) 0%,
            transparent 55%)`,
          opacity: hovered ? 1 : 0,
          transition: hovered ? "opacity 0.08s ease" : "opacity 0.55s ease",
          zIndex: 0,
        }}
      />

      {/* ── Card content — z-index 1 ensures it renders above overlays ── */}
      <div style={{ position: "relative", zIndex: 1 }}>
        <div className="flex items-center gap-2.5">
          {/* OS tag */}
          <span
            className="flex-shrink-0 text-[9px] font-mono font-bold tracking-[0.15em] rounded-lg px-1.5 py-1 leading-none"
            style={{
              color: osMeta.color,
              background: `${osMeta.color.replace("rgb(", "rgba(").replace(")", ", 0.12)")}`.replace("0.8", "0.12"),
              boxShadow: `0 0 0 1px ${osMeta.color.replace("/ 0.8", "/ 0.2")}`,
            }}
          >
            {osMeta.label}
          </span>

          {/* Name + IP */}
          <div className="flex-1 min-w-0">
            <p
              className="text-xs font-semibold truncate leading-tight"
              style={{
                color: isSelected
                  ? "rgb(var(--rift-accent))"
                  : isReconnecting
                  ? "rgb(var(--rift-warning) / 0.85)"
                  : "rgb(var(--rift-text))",
              }}
            >
              {device.name}
            </p>
            <p
              className="text-[10px] font-mono mt-0.5 truncate"
              style={{ color: "rgb(var(--rift-muted) / 0.6)" }}
            >
              {device.ip}
            </p>
          </div>

          {/* Right column: status + latency */}
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            {isRifted ? (
              <span className="status-dot-live" />
            ) : isReconnecting ? (
              <span className="status-dot-wait" />
            ) : (
              <span className="status-dot-offline" />
            )}

            {device.latencyMs !== null && (
              <span
                className="text-[9px] font-mono rounded-full px-1.5 py-0.5 leading-none"
                style={{
                  color: device.latencyMs < 20
                    ? "rgb(var(--rift-success))"
                    : device.latencyMs < 60
                    ? "rgb(var(--rift-warning))"
                    : "rgb(var(--rift-error))",
                  background: device.latencyMs < 20
                    ? "rgb(var(--rift-success) / 0.1)"
                    : device.latencyMs < 60
                    ? "rgb(var(--rift-warning) / 0.1)"
                    : "rgb(var(--rift-error) / 0.1)",
                  boxShadow: `0 0 0 1px ${
                    device.latencyMs < 20
                      ? "rgb(var(--rift-success) / 0.2)"
                      : device.latencyMs < 60
                      ? "rgb(var(--rift-warning) / 0.2)"
                      : "rgb(var(--rift-error) / 0.2)"
                  }`,
                }}
              >
                {device.latencyMs}ms
              </span>
            )}
          </div>
        </div>

        {isSelected && (
          <p
            className="text-[9px] font-mono mt-1.5 tracking-wide"
            style={{ color: "rgb(var(--rift-accent) / 0.7)" }}
          >
            selected · tap again for details
          </p>
        )}

        {isReconnecting && !isSelected && (
          <p
            className="text-[9px] font-mono mt-1.5 tracking-wide"
            style={{ color: "rgb(var(--rift-warning) / 0.55)" }}
          >
            reconnecting…
          </p>
        )}
      </div>
    </button>
  );
}