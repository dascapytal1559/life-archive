// What the Spider web view draws with (WebLayer.tsx; the drawing itself is in
// webLook.ts): strokes with a bloom, the web's parts as paths at a zoom
// (webGeometry.ts), soft halos under people, and the thread's shapes (a
// strand, a bracket reticle); the spider is in webSpider.ts. Canvas 2D throughout, drawn
// relative to the sun; nothing here knows React or the page.

import { strandControl, strandSag, xy, type Ring, type WebShape } from "./webGeometry.ts";

export type Ctx = CanvasRenderingContext2D;

export interface XY {
  x: number;
  y: number;
}

/** #rrggbb with an alpha, as rgba(). */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** A stroke with a bloom under it: a wide, faint pass, then the core. */
export function glowStroke(ctx: Ctx, path: Path2D, colour: string, core: number, bloom: number, coreAlpha = 1, bloomAlpha = 0.35): void {
  if (bloom > 0 && bloomAlpha > 0.005) {
    ctx.globalAlpha = bloomAlpha;
    ctx.lineWidth = bloom;
    ctx.strokeStyle = colour;
    ctx.stroke(path);
  }
  if (core > 0 && coreAlpha > 0.005) {
    ctx.globalAlpha = coreAlpha;
    ctx.lineWidth = core;
    ctx.strokeStyle = colour;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

/** A dot with a soft glow round it. */
export function glowDot(ctx: Ctx, x: number, y: number, r: number, colour: string, bloom: number, alpha = 1): void {
  if (bloom > 0) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r + bloom);
    g.addColorStop(0, colour);
    g.addColorStop(Math.min(0.9, r / (r + bloom)), colour);
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r + bloom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// The web's parts as paths at zoom k, relative to the sun.

/** The spokes, each from the hub out as far as it runs. */
export function spokesPath(shape: WebShape, k: number): Path2D {
  const path = new Path2D();
  for (const spoke of shape.spokes) {
    const [x0, y0] = xy({ angle: spoke.angle, r: shape.hub }, k);
    const [x1, y1] = xy(spoke, k);
    path.moveTo(x0, y0);
    path.lineTo(x1, y1);
  }
  return path;
}

/** The web's rings that `pick` says, each a thread from spoke to spoke all the way round, sagging toward the hub as the web's curve says (strandSag; straight with none, a regular polygon). */
export function ringsPath(shape: WebShape, k: number, pick: (ring: Ring) => boolean = () => true): Path2D {
  const path = new Path2D();
  const { spokes } = shape;
  for (const ring of shape.rings) {
    if (!pick(ring)) continue;
    const sag = strandSag(shape, ring.r);
    const [x0, y0] = xy({ angle: spokes[0].angle, r: ring.r }, k);
    path.moveTo(x0, y0);
    spokes.forEach((spoke, i) => {
      const next = spokes[(i + 1) % spokes.length];
      const [x, y] = xy({ angle: next.angle, r: ring.r }, k);
      if (sag === 0) path.lineTo(x, y);
      else {
        const [cx, cy] = strandControl(ring.r, spoke.angle, next.angle, sag, k);
        path.quadraticCurveTo(cx, cy, x, y);
      }
    });
    path.closePath();
  }
  return path;
}

// Threads.

/** A strand from `a` to `b` that bows sideways by `bow` pixels at its middle (a quadratic); straight with none. */
export function strandPath(a: XY, b: XY, bow = 0): Path2D {
  const path = new Path2D();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = -dy / d;
  const ny = dx / d;
  path.moveTo(a.x, a.y);
  if (bow === 0) path.lineTo(b.x, b.y);
  else path.quadraticCurveTo((a.x + b.x) / 2 + nx * bow, (a.y + b.y) / 2 + ny * bow, b.x, b.y);
  return path;
}

/** Four corner brackets round a point, `size` across (and `tall` high, else square), each arm `arm` long, turned by `spin`. */
export function bracketPath(p: XY, size: number, arm: number, spin = 0, tall = size): Path2D {
  const path = new Path2D();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const cx = (sx * size) / 2;
    const cy = (sy * tall) / 2;
    const rot = (x: number, y: number): [number, number] => [p.x + x * Math.cos(spin) - y * Math.sin(spin), p.y + x * Math.sin(spin) + y * Math.cos(spin)];
    const [x0, y0] = rot(cx - sx * arm, cy);
    const [x1, y1] = rot(cx, cy);
    const [x2, y2] = rot(cx, cy - sy * arm);
    path.moveTo(x0, y0);
    path.lineTo(x1, y1);
    path.lineTo(x2, y2);
  }
  return path;
}

// Halos under people: one soft disc per colour, drawn once and reused.

const halos = new Map<string, HTMLCanvasElement>();
const HALO = 32;

/** A soft disc of `colour`, HALO pixels across at full size, made once per colour. */
export function halo(colour: string): HTMLCanvasElement {
  let sprite = halos.get(colour);
  if (sprite) return sprite;
  if (halos.size > 1200) halos.clear();
  sprite = document.createElement("canvas");
  sprite.width = sprite.height = HALO * 2;
  const ctx = sprite.getContext("2d")!;
  const g = ctx.createRadialGradient(HALO, HALO, 0, HALO, HALO, HALO);
  g.addColorStop(0, rgba(colour, 0.85));
  g.addColorStop(0.3, rgba(colour, 0.4));
  g.addColorStop(0.7, rgba(colour, 0.08));
  g.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, HALO * 2, HALO * 2);
  halos.set(colour, sprite);
  return sprite;
}

/** Draws a halo of `colour` round (x, y), `r` pixels out, at `alpha`. */
export function drawHalo(ctx: Ctx, x: number, y: number, r: number, colour: string, alpha: number): void {
  if (alpha <= 0.01 || r <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(halo(colour), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

/** A seeded run of numbers that repeats every few frames: a flicker that holds still long enough to see. */
export function flicker(now: number, period = 50): () => number {
  let a = Math.floor(now / period) * 2654435761;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
