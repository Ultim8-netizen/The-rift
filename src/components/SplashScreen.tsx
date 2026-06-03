import { useEffect, useRef } from "react";

// ── Crack path: normalized [x, y] within the icon square ──────────────────────
// x=0 left edge, x=1 right edge, y=0 top, y=1 bottom.
// Points traced along the visible lightning crack in icon-source.png.
const CRACK: [number, number][] = [
  [0.522, 0.000],
  [0.514, 0.082],
  [0.550, 0.178],
  [0.480, 0.276],
  [0.526, 0.368],
  [0.476, 0.458],
  [0.537, 0.546],
  [0.466, 0.637],
  [0.513, 0.726],
  [0.478, 0.816],
  [0.503, 0.908],
  [0.488, 1.000],
];

const DUR = 2600; // total ms

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function phase(t: number, a: number, b: number) {
  return clamp((t - a) / (b - a), 0, 1);
}
function eO3(t: number) { return 1 - (1 - t) ** 3; }
function eO5(t: number) { return 1 - (1 - t) ** 5; }
function eIO2(t: number) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

// Linear interpolation of crack x-fraction at normalized y
function crackNX(ny: number): number {
  const n = CRACK.length;
  if (ny <= 0) return CRACK[0][0];
  if (ny >= 1) return CRACK[n - 1][0];
  let i = 0;
  while (i < n - 2 && CRACK[i + 1][1] <= ny) i++;
  const [x0, y0] = CRACK[i];
  const [x1, y1] = CRACK[i + 1];
  return x0 + (x1 - x0) * clamp((ny - y0) / (y1 - y0 + 1e-6), 0, 1);
}

// Draw one half of the icon: clip left or right of the crack, then
// translate/rotate (both in the same transformed coordinate space so
// the clip rides along with the image correctly).
function drawHalf(
  ctx:   CanvasRenderingContext2D,
  img:   HTMLImageElement,
  iX: number, iY: number, iS: number,
  dx: number, rot: number,
  left: boolean,
  alpha: number,
  W: number, H: number,
) {
  if (alpha < 0.004) return;
  const FAR = Math.max(W, H) * 4;
  const cx  = iX + iS * 0.5;
  const cy  = iY + iS * 0.5;

  ctx.save();
  // Rotate around icon center, then translate — both affect clip + image equally
  ctx.translate(cx + dx, cy);
  ctx.rotate(rot);
  ctx.translate(-cx, -cy);

  ctx.beginPath();
  const STEPS = 90;
  if (left) {
    ctx.moveTo(-FAR, -FAR);
    ctx.lineTo(iX + crackNX(0) * iS, iY);
    for (let s = 1; s <= STEPS; s++) {
      const ny = s / STEPS;
      ctx.lineTo(iX + crackNX(ny) * iS, iY + ny * iS);
    }
    ctx.lineTo(-FAR, FAR);
  } else {
    ctx.moveTo(FAR, -FAR);
    ctx.lineTo(iX + crackNX(0) * iS, iY);
    for (let s = 1; s <= STEPS; s++) {
      const ny = s / STEPS;
      ctx.lineTo(iX + crackNX(ny) * iS, iY + ny * iS);
    }
    ctx.lineTo(FAR, FAR);
  }
  ctx.closePath();
  ctx.clip();

  ctx.globalAlpha = alpha;
  ctx.drawImage(img, iX, iY, iS, iS);
  ctx.restore();
}

// Animated crack glow: traces from top downward as crackP 0→1,
// then pulses. Three passes: outer bloom, mid, core.
function drawCrackGlow(
  ctx: CanvasRenderingContext2D,
  iX: number, iY: number, iS: number,
  crackP: number,   // how far the trace has grown (0→1)
  intensity: number, // overall alpha
  pulseT: number,   // time in seconds for sparks
) {
  if (intensity < 0.005 || crackP < 0.01) return;

  const target = crackP * (CRACK.length - 1); // fractional segment index

  const PASSES = [
    { w: 44, a: 0.09, r: 130, g: 55,  b: 255 },
    { w: 22, a: 0.32, r: 175, g: 100, b: 255 },
    { w:  7, a: 0.92, r: 242, g: 215, b: 255 },
  ] as const;

  for (const pass of PASSES) {
    ctx.save();
    ctx.strokeStyle = `rgba(${pass.r},${pass.g},${pass.b},${pass.a * intensity})`;
    ctx.lineWidth   = pass.w;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.shadowColor = `rgba(${pass.r},${pass.g},${pass.b},0.95)`;
    ctx.shadowBlur  = pass.w * 2.2;
    ctx.beginPath();

    let started = false;
    for (let i = 0; i < CRACK.length; i++) {
      if (i > target) break;
      let nx = CRACK[i][0], ny = CRACK[i][1];

      // Partial last segment
      if (i === Math.floor(target) && i < CRACK.length - 1) {
        const frac = target - Math.floor(target);
        nx = nx + (CRACK[i + 1][0] - nx) * frac;
        ny = ny + (CRACK[i + 1][1] - ny) * frac;
      }

      const px = iX + nx * iS;
      const py = iY + ny * iS;
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Perpendicular electric sparks
  if (crackP > 0.45 && intensity > 0.25) {
    const count = 9;
    for (let i = 0; i < count; i++) {
      const sny = ((i + 0.5) / count) * crackP;
      if (sny > 1) break;
      const sx  = iX + crackNX(sny) * iS;
      const sy  = iY + sny * iS;
      const ang = Math.sin(sny * 20 + pulseT * 7 + i * 1.3) * 1.1;
      const len = iS * 0.045 * intensity * (0.4 + Math.abs(Math.sin(pulseT * 9 + i * 0.9)) * 0.6);
      ctx.save();
      ctx.strokeStyle = `rgba(215, 170, 255, ${0.65 * intensity})`;
      ctx.lineWidth   = 1.5;
      ctx.lineCap     = "round";
      ctx.shadowColor = "rgba(190, 130, 255, 0.9)";
      ctx.shadowBlur  = 10;
      ctx.beginPath();
      ctx.moveTo(sx - Math.cos(ang) * len, sy - Math.sin(ang) * len);
      ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Plasma/electricity filling the widening gap between the two halves
function drawGapEnergy(
  ctx: CanvasRenderingContext2D,
  iX: number, iY: number, iS: number,
  lDx: number, rDx: number,
  intensity: number,
  pulseT: number,
) {
  if (intensity < 0.005) return;
  const ROWS = 160;

  for (let s = 0; s <= ROWS; s++) {
    const ny  = s / ROWS;
    const cnx = crackNX(ny);
    const lcx = iX + cnx * iS + lDx; // left crack edge (moved)
    const rcx = iX + cnx * iS + rDx; // right crack edge (moved)
    const gap = rcx - lcx;
    if (gap < 0.8) continue;

    const cy    = iY + ny * iS;
    const noise = 0.55 + 0.45 * Math.sin(ny * 24 + pulseT * 11);

    // Horizontal energy gradient across the gap
    const g = ctx.createLinearGradient(lcx, cy, rcx, cy);
    g.addColorStop(0,    `rgba(170, 90, 255, 0)`);
    g.addColorStop(0.12, `rgba(195, 120, 255, ${0.45 * intensity * noise})`);
    g.addColorStop(0.38, `rgba(235, 190, 255, ${0.80 * intensity})`);
    g.addColorStop(0.50, `rgba(255, 255, 255,  ${intensity})`);
    g.addColorStop(0.62, `rgba(235, 190, 255, ${0.80 * intensity})`);
    g.addColorStop(0.88, `rgba(195, 120, 255, ${0.45 * intensity * noise})`);
    g.addColorStop(1,    `rgba(170, 90, 255, 0)`);

    ctx.fillStyle = g;
    ctx.fillRect(lcx, cy - 1, gap, 2.5);
  }

  // Edge glow on both crack faces
  for (let s = 0; s <= ROWS; s += 4) {
    const ny  = s / ROWS;
    const cnx = crackNX(ny);
    const lcx = iX + cnx * iS + lDx;
    const rcx = iX + cnx * iS + rDx;
    const cy  = iY + ny * iS;
    ctx.save();
    ctx.shadowColor = `rgba(175, 90, 255, 0.9)`;
    ctx.shadowBlur  = 18 * intensity;
    ctx.fillStyle   = `rgba(175, 90, 255, ${0.35 * intensity})`;
    ctx.fillRect(lcx - 2, cy - 1.5, 4, 3);
    ctx.fillRect(rcx - 2, cy - 1.5, 4, 3);
    ctx.restore();
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ctx = el.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;

    let W = 0, H = 0;
    function resize() {
      // TS doesn't carry the outer null-narrowing into nested function closures,
      // even for const bindings. Local guard re-establishes the narrowing here.
      if (!el) return;
      W = window.innerWidth;
      H = window.innerHeight;
      el.width  = W * dpr;
      el.height = H * dpr;
      el.style.width  = `${W}px`;
      el.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const img = new Image();
    img.src = "/icon-source.png";

    let raf  = 0;
    let t0   = 0;
    let done = false;

    function frame(now: number) {
      if (!t0) t0 = now;
      const t  = clamp((now - t0) / DUR, 0, 1);
      const pT = (now - t0) / 1000; // seconds (for pulse/spark oscillators)

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#05050e";
      ctx.fillRect(0, 0, W, H);

      // ── Responsive icon size ─────────────────────────────────────────────────
      // Portrait (mobile): 72 % of width  |  Landscape/desktop: 55 % of height
      const iS = W < H ? W * 0.72 : Math.min(H * 0.55, W * 0.44);
      const iX = (W - iS) * 0.5;
      const iY = (H - iS) * 0.5;

      // ── Phase progress ───────────────────────────────────────────────────────
      // Phase times (normalized 0–1 of DUR=2600ms):
      //   Fade-in logo      0.00 → 0.18  (  0 –  468ms)
      //   Crack trace       0.14 → 0.48  (364 – 1248ms)
      //   Glow intensity    0.12 → 0.60  (312 – 1560ms)
      //   Split opens       0.46 → 0.74  (1196– 1924ms)
      //   Flash             0.70 → 0.84  (1820– 2184ms)
      //   Fly out           0.70 → 0.92  (1820– 2392ms)
      //   End fade-to-black 0.88 → 1.00  (2288– 2600ms)
      const fadeIn   = eO3 (phase(t, 0.00, 0.18));
      const crackP   = eO3 (phase(t, 0.14, 0.48)); // trace 0→1
      const crackGI  = eIO2(phase(t, 0.12, 0.60)); // glow intensity
      const splitP   = eO5 (phase(t, 0.46, 0.74)); // gap opens
      const flyP     = eO5 (phase(t, 0.70, 0.92)); // letters fly off
      const flashBeat= phase(t, 0.70, 0.84);
      const flashA   = flashBeat < 0.5 ? flashBeat * 2 : 2 - flashBeat * 2;
      const endFade  = eO3 (phase(t, 0.88, 1.00));

      // ── Motion ──────────────────────────────────────────────────────────────
      const gap    = iS * 0.058 * splitP;
      const flyOff = (iS * 0.55 + W * 0.55) * flyP;
      const lDx    = -(gap + flyOff);
      const rDx    =  (gap + flyOff);
      const lRot   = -0.11 * flyP;
      const rRot   =  0.11 * flyP;
      const imgA   = fadeIn * (1 - endFade);

      // ── Icon halves ─────────────────────────────────────────────────────────
      if (img.complete && img.naturalWidth > 0 && imgA > 0.003) {
        drawHalf(ctx, img, iX, iY, iS, lDx, lRot, true,  imgA, W, H);
        drawHalf(ctx, img, iX, iY, iS, rDx, rRot, false, imgA, W, H);
      }

      // ── Crack glow (fades out as gap widens) ────────────────────────────────
      const glowI = crackGI * imgA * (1 - splitP * 0.75);
      if (glowI > 0.005) {
        drawCrackGlow(ctx, iX, iY, iS, crackP, glowI, pT);
      }

      // ── Gap plasma ──────────────────────────────────────────────────────────
      if (splitP > 0.015 && flyP < 0.995) {
        drawGapEnergy(ctx, iX, iY, iS, lDx, rDx, splitP * (1 - flyP) * imgA, pT);
      }

      // ── Purple flash ─────────────────────────────────────────────────────────
      if (flashA > 0.008) {
        ctx.save();
        ctx.globalAlpha = flashA * 0.58 * (1 - endFade);
        ctx.fillStyle   = "rgb(158, 78, 255)";
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // ── End fade to bg colour ────────────────────────────────────────────────
      if (endFade > 0.002) {
        ctx.save();
        ctx.globalAlpha = endFade;
        ctx.fillStyle   = "#05050e";
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      if (t < 1) {
        raf = requestAnimationFrame(frame);
      } else if (!done) {
        done = true;
        onDone();
      }
    }

    function start() { raf = requestAnimationFrame(frame); }

    if (img.complete && img.naturalWidth > 0) {
      start();
    } else {
      img.onload  = start;
      img.onerror = () => { onDone(); }; // silent fallback — never block the app
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [onDone]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "block", background: "#05050e" }}
    />
  );
}