// src/components/Portal3D.tsx
// Physics-driven deformable sphere with particle-ring orbits
// Canvas 2D — no external dependencies

import { useEffect, useRef } from "react";

// ─── constants ────────────────────────────────────────────────────────────────
const W  = 260, H = 260, CX = W / 2, CY = H / 2, SR = 58;
const ND = 72;
const NP = 72;
const PK = 2.6;

// ─── types ────────────────────────────────────────────────────────────────────
type RGB = readonly [number, number, number];
type V3  = [number, number, number];

// ─── 3D helpers ───────────────────────────────────────────────────────────────
function rx(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1]*c - v[2]*s, v[1]*s + v[2]*c];
}
function ry(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0]*c + v[2]*s, v[1], -v[0]*s + v[2]*c];
}
function rz(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0]*c - v[1]*s, v[0]*s + v[1]*c, v[2]];
}

function depthAlpha(z: number, r: number): number {
  const t = Math.max(0, Math.min(1, (z / r) * 0.5 + 0.5));
  return 0.04 + 0.96 * Math.pow(t, 1.6);
}

function isOccluded(p: V3, R: number): boolean {
  const r2 = p[0]*p[0] + p[1]*p[1];
  return r2 < R*R && p[2] < -Math.sqrt(Math.max(0, R*R - r2));
}

// ─── ring definitions ─────────────────────────────────────────────────────────
interface Ring {
  radius: number; tiltX: number; tiltY: number; tiltZ: number;
  speed: number; rgb: RGB;
}

const RINGS: Ring[] = [
  { radius: 112, tiltX: 0.42, tiltY: 0.08, tiltZ:  0.00, speed:  0.42, rgb: [0,   200, 255] },
  { radius:  92, tiltX: 1.38, tiltY: 0.15, tiltZ:  0.52, speed:  0.36, rgb: [140,  80, 255] },
  { radius:  92, tiltX: 1.38, tiltY: 0.15, tiltZ: -0.52, speed: -0.36, rgb: [80,  190, 255] },
];

function ringPos3D(ring: Ring, phase: number, t: number): V3 {
  const θ = phase + t * ring.speed;
  let p: V3 = [Math.cos(θ) * ring.radius, Math.sin(θ) * ring.radius, 0];
  p = rz(ry(rx(p, ring.tiltX), ring.tiltY), ring.tiltZ);
  return p;
}

// ─── Cartesian deformation mesh ───────────────────────────────────────────────
interface MeshPt {
  angle: number;
  bx: number; by: number;
  x:  number; y:  number;
  vx: number; vy: number;
}

function makeMesh(): MeshPt[] {
  return Array.from({ length: ND }, (_, i) => {
    const a = (i / ND) * Math.PI * 2;
    const bx = SR * Math.cos(a), by = SR * Math.sin(a);
    return { angle: a, bx, by, x: bx, y: by, vx: 0, vy: 0 };
  });
}

const _fx = new Float64Array(ND);
const _fy = new Float64Array(ND);

function stepMesh(
  mesh:    MeshPt[],
  dt:      number,
  pullX:   number | null,
  pullY:   number | null,
  stretch: number,
  hovX:    number | null,
  hovY:    number | null,
): void {
  const K = 60, D = 5.8, T = 20;
  _fx.fill(0); _fy.fill(0);

  for (let i = 0; i < ND; i++) {
    const m    = mesh[i];
    const prev = mesh[(i - 1 + ND) % ND];
    const next = mesh[(i + 1)      % ND];

    _fx[i] += -K * (m.x - m.bx);
    _fy[i] += -K * (m.y - m.by);
    _fx[i] += T * (prev.x + next.x - 2 * m.x);
    _fy[i] += T * (prev.y + next.y - 2 * m.y);

    if (hovX !== null && hovY !== null && pullX === null) {
      const hdx = hovX - CX, hdy = hovY - CY;
      const hd  = Math.sqrt(hdx*hdx + hdy*hdy);
      if (hd < SR * 1.3) {
        const hA = Math.atan2(hdy, hdx);
        const da = m.angle - hA;
        const wr = Math.atan2(Math.sin(da), Math.cos(da));
        const w  = Math.exp(-(wr*wr) / (2*0.55*0.55)) * Math.max(0, 1 - hd/(SR*1.3));
        _fx[i] -= 190 * w * Math.cos(m.angle);
        _fy[i] -= 190 * w * Math.sin(m.angle);
      }
    }

    if (pullX !== null && pullY !== null) {
      const pdx    = pullX - CX, pdy = pullY - CY;
      const pDist  = Math.sqrt(pdx*pdx + pdy*pdy);
      const pAngle = Math.atan2(pdy, pdx);
      const da     = m.angle - pAngle;
      const wr     = Math.atan2(Math.sin(da), Math.cos(da));
      const w      = Math.exp(-(wr*wr) / (2*0.52*0.52));

      const targetR = SR + (pDist - SR) * stretch * 0.88;
      const tX = Math.cos(pAngle) * targetR;
      const tY = Math.sin(pAngle) * targetR;
      _fx[i] += K * 4.5 * (tX - m.x) * w;
      _fy[i] += K * 4.5 * (tY - m.y) * w;

      const perpW = Math.max(0, -Math.cos(wr));
      _fx[i] -= K * 0.95 * stretch * perpW * Math.cos(m.angle);
      _fy[i] -= K * 0.95 * stretch * perpW * Math.sin(m.angle);
    }
  }

  for (let i = 0; i < ND; i++) {
    const m  = mesh[i];
    m.vx     = (m.vx + _fx[i] * dt) * (1 - D * dt);
    m.vy     = (m.vy + _fy[i] * dt) * (1 - D * dt);
    m.x     += m.vx * dt;
    m.y     += m.vy * dt;
  }
}

function meshRadiusAt(mesh: MeshPt[], angle: number): number {
  const a  = ((angle % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
  const fi = (a / (Math.PI*2)) * ND;
  const i0 = Math.floor(fi) % ND;
  const i1 = (i0 + 1) % ND;
  const tt = fi - Math.floor(fi);
  const x  = mesh[i0].x*(1-tt) + mesh[i1].x*tt;
  const y  = mesh[i0].y*(1-tt) + mesh[i1].y*tt;
  return Math.sqrt(x*x + y*y);
}

function meshTip(mesh: MeshPt[], pullX: number, pullY: number): { x: number; y: number } {
  const pA = Math.atan2(pullY - CY, pullX - CX);
  let best = 0, bestD = -Infinity;
  for (let i = 0; i < ND; i++) {
    const d = mesh[i].x * Math.cos(pA) + mesh[i].y * Math.sin(pA);
    if (d > bestD) { bestD = d; best = i; }
  }
  return { x: CX + mesh[best].x, y: CY + mesh[best].y };
}

// ─── Particles ────────────────────────────────────────────────────────────────
interface Particle {
  ring: Ring; phase: number; size: number;
  sx: number; sy: number;
  vx: number; vy: number;
  scattered: boolean; age: number;
}

function makeParticles(): Particle[] {
  return RINGS.flatMap(ring =>
    Array.from({ length: NP }, (_, i) => ({
      ring, phase: (i / NP) * Math.PI * 2,
      size: 0.8 + Math.random() * 1.8,
      sx: 0, sy: 0, vx: 0, vy: 0,
      scattered: false, age: 0,
    }))
  );
}

// ─── Shockwave rings ──────────────────────────────────────────────────────────
interface Wave {
  x: number; y: number; r: number; maxR: number;
  alpha: number; rgb: RGB; screen: boolean; spd: number;
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────
function meshPath(ctx: CanvasRenderingContext2D, mesh: MeshPt[]): void {
  ctx.beginPath();
  for (let i = 0; i <= ND; i++) {
    const m0 = mesh[(i - 1 + ND) % ND];
    const m1 = mesh[i            % ND];
    const m2 = mesh[(i + 1)      % ND];
    const m3 = mesh[(i + 2)      % ND];
    const c1x = m1.x + (m2.x - m0.x) / 6;
    const c1y = m1.y + (m2.y - m0.y) / 6;
    const c2x = m2.x - (m3.x - m1.x) / 6;
    const c2y = m2.y - (m3.y - m1.y) / 6;
    if (i === 0) ctx.moveTo(CX + m1.x, CY + m1.y);
    else ctx.bezierCurveTo(CX+c1x, CY+c1y, CX+c2x, CY+c2y, CX+m2.x, CY+m2.y);
  }
  ctx.closePath();
}

function drawSphere(
  ctx: CanvasRenderingContext2D, mesh: MeshPt[], acc: RGB,
  lxn: number, lyn: number, lzn: number,
  hxn: number, hyn: number,
): void {
  const [r, g, b] = acc;
  const BIG = SR * 5;

  ctx.save();
  meshPath(ctx, mesh);
  ctx.clip();

  const base = ctx.createRadialGradient(CX, CY, 0, CX, CY, SR*1.5);
  base.addColorStop(0,    "rgb(22,18,48)");
  base.addColorStop(0.55, "rgb(10,8,28)");
  base.addColorStop(1,    "rgb(4,3,14)");
  ctx.fillStyle = base;
  ctx.fillRect(CX-BIG, CY-BIG, BIG*2, BIG*2);

  const dCx = CX + lxn*SR*0.4, dCy = CY + lyn*SR*0.4;
  const dA  = 0.5 + 0.25*lzn;
  const diff = ctx.createRadialGradient(dCx, dCy, 0, dCx, dCy, SR*1.2);
  diff.addColorStop(0,    `rgba(${r},${g},${b},${dA.toFixed(3)})`);
  diff.addColorStop(0.45, `rgba(${r},${g},${b},${(dA*0.28).toFixed(3)})`);
  diff.addColorStop(1,    `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = diff;
  ctx.fillRect(CX-BIG, CY-BIG, BIG*2, BIG*2);

  const sCx = CX - lxn*SR*0.32, sCy = CY - lyn*SR*0.32;
  const shad = ctx.createRadialGradient(sCx, sCy, SR*0.1, sCx, sCy, SR*1.1);
  shad.addColorStop(0,   "rgba(0,0,0,0)");
  shad.addColorStop(0.7, "rgba(0,0,0,0.5)");
  shad.addColorStop(1,   "rgba(0,0,0,0.72)");
  ctx.fillStyle = shad;
  ctx.fillRect(CX-BIG, CY-BIG, BIG*2, BIG*2);

  const ao = ctx.createRadialGradient(CX, CY+SR*0.52, 0, CX, CY+SR*0.52, SR*0.95);
  ao.addColorStop(0, "rgba(0,0,0,0.38)");
  ao.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = ao;
  ctx.fillRect(CX-BIG, CY-BIG, BIG*2, BIG*2);

  const specCx = CX + hxn*SR*0.72, specCy = CY + hyn*SR*0.72;
  const spec = ctx.createRadialGradient(specCx, specCy, 0, specCx, specCy, SR*0.24);
  spec.addColorStop(0,    "rgba(255,255,255,0.88)");
  spec.addColorStop(0.38, "rgba(220,240,255,0.28)");
  spec.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = spec;
  ctx.fillRect(CX-BIG, CY-BIG, BIG*2, BIG*2);
  ctx.restore();

  ctx.save();
  meshPath(ctx, mesh);
  ctx.shadowColor = `rgba(${r},${g},${b},0.5)`;
  ctx.shadowBlur  = 14;
  ctx.strokeStyle = `rgba(${r},${g},${b},${(0.2 + 0.12*(1-Math.abs(lzn))).toFixed(3)})`;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawTentacle(
  oc:      CanvasRenderingContext2D,
  ox: number, oy: number,
  mx: number, my: number,
  acc:     RGB,
  stretch: number,
  t:       number,
): void {
  if (stretch < 0.02) return;
  const [r1, g1, b1] = acc;
  const dx = mx - ox, dy = my - oy;
  const d  = Math.sqrt(dx*dx + dy*dy);
  if (d < 4) return;
  const nx = -dy / d, ny = dx / d;

  const w = Math.max(2, SR * 0.40 * (1 - stretch * 0.72));

  const a1 = stretch * 30 * Math.sin(t * 9.2);
  const a2 = stretch * 22 * Math.sin(t * 5.7 + 1.8);

  const c1x = ox + dx * 0.22 + nx * a1;
  const c1y = oy + dy * 0.22 + ny * a1;
  const c2x = ox + dx * 0.70 - nx * a2;
  const c2y = oy + dy * 0.70 - ny * a2;

  const a1b = stretch * 24 * Math.sin(t * 9.2 + 0.5);
  const a2b = stretch * 18 * Math.sin(t * 5.7 + 2.3);
  const c1bx = ox + dx * 0.22 + nx * a1b;
  const c1by = oy + dy * 0.22 + ny * a1b;
  const c2bx = ox + dx * 0.70 - nx * a2b;
  const c2by = oy + dy * 0.70 - ny * a2b;

  const pulse  = (Math.sin(t * 5.8)       + 1) * 0.5;
  const pulse2 = (Math.sin(t * 3.4 + 0.9) + 1) * 0.5;
  const cr = (r1 + (140 - r1) * stretch * pulse)  | 0;
  const cg = (g1 + ( 80 - g1) * stretch * pulse)  | 0;
  const cb = (b1 + (255 - b1) * stretch * pulse)  | 0;

  const ir = (r1 + (160 - r1) * stretch * pulse2 * 0.8) | 0;
  const ig = (g1 + (240 - g1) * stretch * pulse2 * 0.5) | 0;
  const ib = (b1 + (255 - b1) * stretch * pulse2 * 0.9) | 0;

  const alpha = 0.45 + stretch * 0.45;

  oc.save();
  oc.lineCap = "round";

  oc.shadowColor = `rgba(${cr},${cg},${cb},0.95)`;
  oc.shadowBlur  = 28 + stretch * 20;
  oc.strokeStyle = `rgba(${cr},${cg},${cb},${alpha})`;
  oc.lineWidth   = w * 2.8;
  oc.beginPath();
  oc.moveTo(ox, oy);
  oc.bezierCurveTo(c1x, c1y, c2x, c2y, mx, my);
  oc.stroke();

  oc.shadowColor = `rgba(${ir},${ig},${ib},0.75)`;
  oc.shadowBlur  = 14;
  oc.strokeStyle = `rgba(${ir},${ig},${ib},${alpha * 0.65})`;
  oc.lineWidth   = w * 1.4;
  oc.beginPath();
  oc.moveTo(ox, oy);
  oc.bezierCurveTo(c1bx, c1by, c2bx, c2by, mx, my);
  oc.stroke();

  oc.shadowBlur  = 5;
  oc.shadowColor = "rgba(255,255,255,0.9)";
  oc.strokeStyle = `rgba(255,255,255,${0.28 + stretch * 0.50})`;
  oc.lineWidth   = w * 0.28;
  oc.beginPath();
  oc.moveTo(ox, oy);
  oc.bezierCurveTo(c1x, c1y, c2x, c2y, mx, my);
  oc.stroke();

  oc.restore();
}

function drawWave(ctx: CanvasRenderingContext2D, wv: Wave): void {
  const [r, g, b] = wv.rgb;
  const a = wv.alpha * (1 - wv.r / wv.maxR);
  if (a <= 0) return;
  ctx.save();
  ctx.shadowColor = `rgba(${r},${g},${b},${a.toFixed(3)})`;
  ctx.shadowBlur  = 12;
  ctx.strokeStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
  ctx.lineWidth   = 2.6 * (1 - wv.r/wv.maxR) + 0.4;
  ctx.beginPath();
  ctx.arc(wv.x, wv.y, wv.r, 0, Math.PI*2);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, state: string, acc: RGB): void {
  const [r, g, b] = acc;
  const sym = state === "drop" ? "↓" : state === "send" ? "" : state === "ready" ? "" : "◈";
  const sub = state === "drop" ? "DROP" : state === "send" ? "SENDING" : state === "ready" ? "READY" : "RIFT";
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  if (sym) {
    ctx.shadowColor = `rgb(${r},${g},${b})`; ctx.shadowBlur = 20;
    ctx.font = `900 ${sym === "◈" ? 22 : 28}px "JetBrains Mono",monospace`;
    ctx.fillText(sym, CX, sub ? CY - 5 : CY + 4);
  }
  if (sub) {
    ctx.shadowBlur = 10;
    ctx.font = '700 9px "JetBrains Mono",monospace';
    const sp = 3; const chars = [...sub];
    let tw = -sp;
    for (const c of chars) tw += ctx.measureText(c).width + sp;
    let x = CX - tw/2; const y = sym ? CY + 14 : CY + 4;
    for (const c of chars) {
      const cw = ctx.measureText(c).width;
      ctx.fillText(c, x + cw/2, y);
      x += cw + sp;
    }
  }
  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────
export interface Portal3DProps {
  dragging:  boolean;
  hasFiles:  boolean;
  isSending: boolean;
  isMobile?: boolean;
}

export function Portal3D({ dragging, hasFiles, isSending, isMobile }: Portal3DProps) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const frameRef   = useRef<number | null>(null);
  const t0Ref      = useRef(0);
  // isMobile is intentionally absent — mob is read from the effect closure, not reactively.
  const propsRef   = useRef({ dragging, hasFiles, isSending });

  const meshRef      = useRef<MeshPt[]>(makeMesh());
  const particlesRef = useRef<Particle[]>(makeParticles());
  const wavesRef     = useRef<Wave[]>([]);
  const sdimRef      = useRef({ w: window.innerWidth, h: window.innerHeight });
  const accentRef    = useRef<RGB>([0, 200, 255]);

  const hoverRef        = useRef<{ cx: number; cy: number } | null>(null);
  const dragRef         = useRef({ active: false, cx: 0, cy: 0, sx: 0, sy: 0, stretch: 0 });
  const cleanupDragRef  = useRef<(() => void) | null>(null);
  const cleanupTouchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    propsRef.current = { dragging, hasFiles, isSending };
  }, [dragging, hasFiles, isSending]);

  useEffect(() => {
    t0Ref.current = performance.now();

    // Locked at mount — component remounts on layout switch, so this never goes stale.
    const mob = isMobile ?? false;

    const canvasMaybe  = canvasRef.current;
    const overlayMaybe = overlayRef.current;
    if (!canvasMaybe || !overlayMaybe) return;

    const canvasEl:  HTMLCanvasElement = canvasMaybe;
    const overlayEl: HTMLCanvasElement = overlayMaybe;

    const ctxMaybe = canvasEl.getContext("2d");
    const ocMaybe  = overlayEl.getContext("2d");
    if (!ctxMaybe || !ocMaybe) return;
    const ctx: CanvasRenderingContext2D = ctxMaybe;
    const oc:  CanvasRenderingContext2D = ocMaybe;

    const dpr = window.devicePixelRatio ?? 1;
    canvasEl.width  = W * dpr; canvasEl.height  = H * dpr;
    canvasEl.style.width  = `${W}px`; canvasEl.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    function resizeOL() {
      sdimRef.current = { w: window.innerWidth, h: window.innerHeight };
      overlayEl.width  = window.innerWidth  * dpr;
      overlayEl.height = window.innerHeight * dpr;
      overlayEl.style.width  = `${window.innerWidth}px`;
      overlayEl.style.height = `${window.innerHeight}px`;
      oc.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeOL();
    window.addEventListener("resize", resizeOL);

    let prev = performance.now();

    function draw(now: number) {
      const dt = Math.min((now - prev) / 1000, 0.04);
      prev      = now;
      const t   = (now - t0Ref.current) / 1000;

      const { dragging: d, hasFiles: f, isSending: s } = propsRef.current;
      const state = d ? "drop" : s ? "send" : f ? "ready" : "idle";
      const acc: RGB = state === "send" ? [140, 80, 255] : [0, 200, 255];
      accentRef.current = acc;
      const [ar, ag, ab] = acc;

      const mesh  = meshRef.current;
      const ps    = particlesRef.current;
      const waves = wavesRef.current;
      const drag  = dragRef.current;
      const hover = hoverRef.current;
      const rect  = canvasEl.getBoundingClientRect();
      const { w: SW, h: SH } = sdimRef.current;

      stepMesh(mesh, dt,
        drag.active ? drag.cx : null,
        drag.active ? drag.cy : null,
        drag.stretch,
        hover && !drag.active ? hover.cx : null,
        hover && !drag.active ? hover.cy : null,
      );

      // ── Update shockwave rings ─────────────────────────────────────────────
      for (let i = waves.length - 1; i >= 0; i--) {
        const wv = waves[i];
        wv.r     += wv.spd * dt * 520;
        wv.alpha *= (1 - dt * 1.9);
        if (wv.r >= wv.maxR || wv.alpha < 0.006) waves.splice(i, 1);
      }

      // ── Update scattered particles ─────────────────────────────────────────
      for (const p of ps) {
        if (!p.scattered) continue;

        p.vy  += (mob ? 28 : 55) * dt;
        p.vx  *= 0.992; p.vy *= 0.992;
        p.sx  += p.vx * dt; p.sy += p.vy * dt;
        p.age += dt;

        if (mob) {
          // Hard bounce within canvas bounds — particles never leave the 260×260 frame
          if (p.sx < 0)   { p.vx =  Math.abs(p.vx) * 0.5; p.sx = 0;  }
          if (p.sx > W)   { p.vx = -Math.abs(p.vx) * 0.5; p.sx = W;  }
          if (p.sy < 0)   { p.vy =  Math.abs(p.vy) * 0.5; p.sy = 0;  }
          if (p.sy > H)   { p.vy = -Math.abs(p.vy) * 0.5; p.sy = H;  }
        } else {
          if (p.sx < -40)   p.vx =  Math.abs(p.vx) * 0.35;
          if (p.sx > SW+40) p.vx = -Math.abs(p.vx) * 0.35;
          if (p.sy < -40)   p.vy =  Math.abs(p.vy) * 0.35;
          if (p.sy > SH+40) p.vy = -Math.abs(p.vy) * 0.35;
        }

        if (p.age > 2.8) {
          const p3  = ringPos3D(p.ring, p.phase, t);
          const hsx = mob ? p3[0] + CX        : p3[0] + CX + rect.left;
          const hsy = mob ? p3[1] + CY        : p3[1] + CY + rect.top;
          const ddx = hsx - p.sx, ddy = hsy - p.sy;
          const rK  = Math.min(PK * (p.age - 2.8) * 0.85, 7);
          p.vx     += ddx * rK * dt * 60;
          p.vy     += ddy * rK * dt * 60;
          p.vx     *= 0.93; p.vy *= 0.93;
          if (Math.sqrt(ddx*ddx + ddy*ddy) < 12 && Math.abs(p.vx) < 8 && Math.abs(p.vy) < 8) {
            p.scattered = false; p.age = 0;
          }
        }
      }

      // ── Main canvas ────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, W, H);

      const ambAlpha = d ? 0.22 : f ? 0.12 : 0.07;
      const amb = ctx.createRadialGradient(CX, CY, SR*0.4, CX, CY, W*0.68);
      amb.addColorStop(0, `rgba(${ar},${ag},${ab},${ambAlpha})`);
      amb.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
      ctx.fillStyle = amb; ctx.fillRect(0, 0, W, H);

      const lz  = 0.6;
      const lnx = hover ? (hover.cx - CX)/W : -0.4;
      const lny = hover ? (hover.cy - CY)/H : -0.6;
      const nm  = Math.sqrt(lnx*lnx + lny*lny) || 0.001;
      const sc  = Math.sqrt(1 - lz*lz) / nm;
      const lx  = lnx*sc, ly = lny*sc;
      const ll  = Math.sqrt(lx*lx + ly*ly + lz*lz);
      const lxn = lx/ll, lynN = ly/ll, lzn = lz/ll;
      const hx  = lxn, hy = lynN, hz = lzn + 1;
      const hl  = Math.sqrt(hx*hx + hy*hy + hz*hz);
      const hxn = hx/hl, hyn = hy/hl;

      // ── PAINTER'S PASS 1: ring particles BEHIND sphere ────────────────────
      for (const p of ps) {
        if (p.scattered) continue;
        const p3 = ringPos3D(p.ring, p.phase, t);
        if (p3[2] >= 0) continue;
        const R  = meshRadiusAt(mesh, Math.atan2(p3[1], p3[0]));
        if (isOccluded(p3, R)) continue;
        const a  = depthAlpha(p3[2], p.ring.radius);
        if (a < 0.01) continue;
        const [pr, pg, pb] = p.ring.rgb;
        ctx.save();
        ctx.shadowColor = `rgba(${pr},${pg},${pb},${a})`;
        ctx.shadowBlur  = p.size * 3.2;
        ctx.globalAlpha = a;
        ctx.fillStyle   = `rgb(${pr},${pg},${pb})`;
        ctx.beginPath(); ctx.arc(p3[0]+CX, p3[1]+CY, p.size, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }

      // ── PAINTER'S PASS 2: sphere ──────────────────────────────────────────
      drawSphere(ctx, mesh, acc, lxn, lynN, lzn, hxn, hyn);

      // ── PAINTER'S PASS 3: ring particles IN FRONT of sphere ───────────────
      for (const p of ps) {
        if (p.scattered) continue;
        const p3 = ringPos3D(p.ring, p.phase, t);
        if (p3[2] < 0) continue;
        const R  = meshRadiusAt(mesh, Math.atan2(p3[1], p3[0]));
        if (isOccluded(p3, R)) continue;
        const a  = depthAlpha(p3[2], p.ring.radius);
        const [pr, pg, pb] = p.ring.rgb;
        ctx.save();
        ctx.shadowColor = `rgba(${pr},${pg},${pb},${a})`;
        ctx.shadowBlur  = p.size * 3.8;
        ctx.globalAlpha = a;
        ctx.fillStyle   = `rgb(${pr},${pg},${pb})`;
        ctx.beginPath(); ctx.arc(p3[0]+CX, p3[1]+CY, p.size, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }

      // Canvas-local shockwave rings — both platforms
      for (const wv of waves) if (!wv.screen) drawWave(ctx, wv);

      // ── Mobile: scattered particles + tentacle stay on main canvas ─────────
      if (mob) {
        for (const p of ps) {
          if (!p.scattered) continue;
          const [pr, pg, pb] = p.ring.rgb;
          const age   = Math.min(p.age, 3) / 3;
          const alpha = Math.max(0.1, 1 - age * 0.55);
          ctx.save();
          ctx.shadowColor = `rgba(${pr},${pg},${pb},${alpha})`;
          ctx.shadowBlur  = p.size * 4.5;
          ctx.globalAlpha = alpha;
          ctx.fillStyle   = `rgb(${pr},${pg},${pb})`;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, p.size*(1 + age*0.7), 0, Math.PI*2); ctx.fill();
          ctx.restore();
        }

        if (drag.active && drag.stretch > 0.02) {
          const tip = meshTip(mesh, drag.cx, drag.cy);
          drawTentacle(ctx, tip.x, tip.y, drag.cx, drag.cy, acc, drag.stretch, t);
        }
      }

      drawLabel(ctx, state, acc);

      // ── Overlay canvas (desktop only) ──────────────────────────────────────
      oc.clearRect(0, 0, SW, SH);

      if (!mob) {
        // Scattered particles on full-screen overlay
        for (const p of ps) {
          if (!p.scattered) continue;
          const [pr, pg, pb] = p.ring.rgb;
          const age   = Math.min(p.age, 3) / 3;
          const alpha = Math.max(0.1, 1 - age*0.55);
          oc.save();
          oc.shadowColor = `rgba(${pr},${pg},${pb},${alpha})`;
          oc.shadowBlur  = p.size * 4.5;
          oc.globalAlpha = alpha;
          oc.fillStyle   = `rgb(${pr},${pg},${pb})`;
          oc.beginPath(); oc.arc(p.sx, p.sy, p.size*(1 + age*0.7), 0, Math.PI*2); oc.fill();
          oc.restore();
        }

        if (drag.active && drag.stretch > 0.02) {
          const tip = meshTip(mesh, drag.cx, drag.cy);
          drawTentacle(oc, rect.left + tip.x, rect.top + tip.y, drag.sx, drag.sy, acc, drag.stretch, t);
        }

        // Screen-space shockwave rings
        for (const wv of waves) if (wv.screen) drawWave(oc, wv);
      }

      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);

    // ── Impact blast ──────────────────────────────────────────────────────────
    // _releaseY is kept for call-site symmetry (mouseup + touchend both pass x,y)
    // but vertical release position has no effect on trajectory in the current model.
    function launchImpact(stretch: number, releaseX: number, _releaseY: number) {
      const rect    = canvasEl.getBoundingClientRect();
      const accNow  = accentRef.current;
      const [r, g, b] = accNow;

      const meshNow = meshRef.current;
      for (let i = 0; i < ND; i++) {
        meshNow[i].vx += (Math.random() - 0.5) * stretch * 2600;
        meshNow[i].vy += (Math.random() - 0.5) * stretch * 2600;
      }

      const wavesNow = wavesRef.current;

      // Canvas-local rings — both platforms
      for (let i = 0; i < 3; i++) {
        const ii = i;
        setTimeout(() => {
          wavesNow.push({ x: CX, y: CY, r: 0, maxR: SR*(2+stretch*3.5),
            alpha: 0.75+stretch*0.2, rgb: accNow, screen: false, spd: 0.16+ii*0.05+stretch*0.1 });
        }, i * 100);
      }

      // Screen-space rings — desktop only
      // wCsx/wCsy named distinctly to avoid shadowing the particle explosion center below.
      if (!mob) {
        const wCsx = rect.left + CX, wCsy = rect.top + CY;
        const wCount = 4 + Math.floor(stretch * 4);
        for (let i = 0; i < wCount; i++) {
          const ii = i;
          setTimeout(() => {
            wavesNow.push({ x: wCsx, y: wCsy, r: 0,
              maxR: Math.max(window.innerWidth, window.innerHeight) * (0.85+ii*0.18),
              alpha: 0.65+stretch*0.28, rgb: accNow, screen: true, spd: 0.13+ii*0.03+stretch*0.09 });
          }, i * 85);
        }
      }

      const psNow = particlesRef.current;
      const tt    = (performance.now() - t0Ref.current) / 1000;
      const csx   = mob ? CX            : rect.left + CX;
      const csy   = mob ? CY            : rect.top  + CY;

      for (const p of psNow) {
        const p3  = ringPos3D(p.ring, p.phase, tt);
        const psx = mob ? p3[0] + CX : p3[0] + CX + rect.left;
        const psy = mob ? p3[1] + CY : p3[1] + CY + rect.top;
        const dx  = psx - csx, dy = psy - csy;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1;
        const spd = mob
          ? stretch * (48 + Math.random() * 65)
          : stretch * (280 + Math.random() * 480);
        p.sx = psx; p.sy = psy;
        if (mob) {
          p.vx = (dx/dist)*spd*(0.5+Math.random()*0.9);
          p.vy = (dy/dist)*spd*(0.5+Math.random()*0.9) - stretch*18;
        } else {
          p.vx = (dx/dist)*spd*(0.5+Math.random()*0.9) + (releaseX - window.innerWidth/2)*stretch*0.14;
          p.vy = (dy/dist)*spd*(0.5+Math.random()*0.9) - stretch*90;
        }
        p.scattered = true; p.age = 0;
      }

      const flash = document.createElement("div");
      flash.style.cssText = [
        "position:fixed", "inset:0", "pointer-events:none", "z-index:10000",
        `background:rgba(${r},${g},${b},${(0.07+stretch*0.14).toFixed(2)})`,
        "transition:opacity 0.42s ease",
      ].join(";");
      document.body.appendChild(flash);
      requestAnimationFrame(() => {
        flash.style.opacity = "0";
        setTimeout(() => flash.remove(), 460);
      });
    }

    // ── Desktop mouse listeners ────────────────────────────────────────────
    function onMouseMoveCanvas(e: globalThis.MouseEvent) {
      const r = canvasEl.getBoundingClientRect();
      hoverRef.current = { cx: e.clientX - r.left, cy: e.clientY - r.top };
    }

    function onMouseLeaveCanvas() {
      if (!dragRef.current.active) hoverRef.current = null;
    }

    function onMouseDownCanvas(e: globalThis.MouseEvent) {
      const r  = canvasEl.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      if (Math.sqrt((cx-CX)**2 + (cy-CY)**2) > SR * 1.5) return;

      canvasEl.style.cursor = "grabbing";
      dragRef.current = { active: true, cx, cy, sx: e.clientX, sy: e.clientY, stretch: 0 };

      function onMove(ev: globalThis.MouseEvent) {
        const cr = canvasEl.getBoundingClientRect();
        const nx = ev.clientX - cr.left;
        const ny = ev.clientY - cr.top;
        const ddx = nx - CX, ddy = ny - CY;
        const dist = Math.sqrt(ddx*ddx + ddy*ddy);
        const maxD = Math.max(window.innerWidth, window.innerHeight) * 0.72;
        dragRef.current.cx      = nx;
        dragRef.current.cy      = ny;
        dragRef.current.sx      = ev.clientX;
        dragRef.current.sy      = ev.clientY;
        dragRef.current.stretch = Math.min(1, dist / maxD);
        hoverRef.current = { cx: nx, cy: ny };
      }

      function onUp(ev: globalThis.MouseEvent) {
        cleanupDragRef.current?.();
        cleanupDragRef.current = null;
        const saved = { ...dragRef.current };
        dragRef.current  = { active: false, cx: 0, cy: 0, sx: 0, sy: 0, stretch: 0 };
        hoverRef.current = null;
        canvasEl.style.cursor = "grab";
        launchImpact(saved.stretch, ev.clientX, ev.clientY);
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp, { once: true });
      cleanupDragRef.current = () => window.removeEventListener("mousemove", onMove);
    }

    // ── Mobile touch listeners ─────────────────────────────────────────────
    function onTouchStartCanvas(e: globalThis.TouchEvent) {
      e.preventDefault();
      const r     = canvasEl.getBoundingClientRect();
      const touch = e.touches[0];
      const cx    = touch.clientX - r.left;
      const cy    = touch.clientY - r.top;
      // Slightly more generous hit area on mobile — finger > cursor
      if (Math.sqrt((cx-CX)**2 + (cy-CY)**2) > SR * 2.2) return;

      dragRef.current  = { active: true, cx, cy, sx: touch.clientX, sy: touch.clientY, stretch: 0 };
      hoverRef.current = { cx, cy };

      function onTouchMove(ev: globalThis.TouchEvent) {
        ev.preventDefault();
        const cr  = canvasEl.getBoundingClientRect();
        const tch = ev.touches[0];
        const nx  = tch.clientX - cr.left;
        const ny  = tch.clientY - cr.top;
        const ddx = nx - CX, ddy = ny - CY;
        const dist = Math.sqrt(ddx*ddx + ddy*ddy);
        const maxD = Math.max(W, H) * 0.85;
        dragRef.current.cx      = nx;
        dragRef.current.cy      = ny;
        dragRef.current.sx      = tch.clientX;
        dragRef.current.sy      = tch.clientY;
        dragRef.current.stretch = Math.min(1, dist / maxD);
        hoverRef.current = { cx: nx, cy: ny };
      }

      function onTouchEnd(ev: globalThis.TouchEvent) {
        cleanupTouchRef.current?.();
        cleanupTouchRef.current = null;
        const saved = { ...dragRef.current };
        dragRef.current  = { active: false, cx: 0, cy: 0, sx: 0, sy: 0, stretch: 0 };
        hoverRef.current = null;
        const ch = ev.changedTouches[0];
        launchImpact(saved.stretch, ch?.clientX ?? saved.sx, ch?.clientY ?? saved.sy);
      }

      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend",  onTouchEnd,  { once: true });
      cleanupTouchRef.current = () => document.removeEventListener("touchmove", onTouchMove);
    }

    // Register event handlers by platform
    if (mob) {
      canvasEl.addEventListener("touchstart", onTouchStartCanvas, { passive: false });
    } else {
      canvasEl.addEventListener("mousemove",  onMouseMoveCanvas);
      canvasEl.addEventListener("mouseleave", onMouseLeaveCanvas);
      canvasEl.addEventListener("mousedown",  onMouseDownCanvas);
    }

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", resizeOL);
      cleanupDragRef.current?.();
      cleanupTouchRef.current?.();
      if (mob) {
        canvasEl.removeEventListener("touchstart", onTouchStartCanvas);
      } else {
        canvasEl.removeEventListener("mousemove",  onMouseMoveCanvas);
        canvasEl.removeEventListener("mouseleave", onMouseLeaveCanvas);
        canvasEl.removeEventListener("mousedown",  onMouseDownCanvas);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          display:    "block",
          cursor:     isMobile ? "default" : "grab",
          flexShrink: 0,
          position:   "relative",
          zIndex:     2,
        }}
      />
      {/* Overlay: desktop uses it for full-screen particles, tentacle, and shockwaves.
          Mobile keeps it in the DOM for the ref but sinks it below all content;
          nothing is drawn on it in mobile mode. */}
      <canvas
        ref={overlayRef}
        style={{
          position:      "fixed",
          inset:         0,
          pointerEvents: "none",
          zIndex:        isMobile ? -1 : 9999,
        }}
      />
    </>
  );
}