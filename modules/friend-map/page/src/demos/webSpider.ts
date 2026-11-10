// The spider at the Spider web's hub (webLook.ts), drawn from its rig (webRig.ts),
// each part where the rig has it, and lit as a thing standing on the web:
// an armoured machine in a real spider's shape, a small body on long legs.
//
// The look. Every plate is dark chitin shaded by the light from the top left
// of the screen: a lit face toward it, a specular line along its lit edge, a
// rim of the web's own glow along its far edge, and an emissive seam of the
// Spider web's accent down its middle, like a circuit trace; a joint is a dark disc
// in a glowing ring with a bright core. Each joint of each leg keeps its
// height above the web (the rig solves the legs in three dimensions), so a
// steep segment is drawn darker than a flat one, and the whole spider casts a
// shadow on the web: each joint's shadow lies down and to the right of it by
// its height, so the knees' shadows stand far from the knees and a lifted
// foot's shadow comes away from it. The legs, from the body out: a coxa at
// the hip, the femur, a spindle, to the knee, the patella, the knee cap, the
// tibia and the metatarsus, each thinner, with spines on their outer edge,
// and the tarsus, a needle to the foot, with its claws, and a grip light on
// the web where a planted foot holds. The body: the abdomen, an egg hung
// from the pedicel at its own heading, its plates overlapping backward, a
// glowing seam with branching traces, a gloss on its shoulder, spinnerets at
// its tip, breathing slowly; the thorax, a shield over the hips, with the
// fovea, the groove at its middle, and its radial striae engraved; the neck, a glowing ball joint under two collar plates that turn
// with the head, with a cable each side; and the head, a faceted helmet with
// a glass visor across its front holding the eight eyes (the two big
// anterior median eyes in the middle, the lateral pair beside them, the four
// smaller ones in the row behind), which follow whoever is looked at and
// blink, glance and scan on their own (webEyes.ts), the chelicerae hanging
// under the face with their fangs curved in, and the pedipalps either side,
// waving slowly and curling in for a groom; a settle dips the body (the rig's crouch), its
// shadow drawing in under it and its plates a hair smaller. Its
// beams come from its head (beamOrigin): the hover's from its eyes, the
// middle of the visor, and the hold's from its mouth, between the fangs. Fine detail (the spines,
// the claws, the lit faces of the thinner segments) is drawn only once it
// would be more than a pixel, so the spider costs the same at the hub's size
// and shows its detail as it grows with the zoom. Under reduced motion
// nothing of it moves on its own: no breathing, no waving, the eyes still.
// Canvas 2D, drawn about (0, 0) with the hub there, in whatever scale the
// context is in.

import { mix } from "../identicon.ts";
import { drawHalo, glowStroke, lerp, rgba, type Ctx, type XY } from "./webDraw.ts";
import type { Eyes } from "./webEyes.ts";
import { BODY, BODY_HEIGHT, bodyToWeb, CROUCH, legPose, wrapAngle, type LegPose, type Rig, type XYZ } from "./webRig.ts";

/** The spider's inks: its lines and plates' rims, its accents (joints and seams), its glowing beams, its eyes, and the dark it is made of. */
export interface SpiderInk {
  line: string;
  accent: string;
  beam: string;
  eye: string;
  dark: string;
}

/** The spider's materials, mixed once from its inks. */
interface Material {
  /** A plate's body, its lit face, and its shadowed depth. */
  shell: string;
  lit: string;
  deep: string;
  /** The specular shine, the rim light (the web's glow), the emissive accent, the eyes, the visor's glass, and the lines. */
  spec: string;
  rim: string;
  core: string;
  coreBright: string;
  eye: string;
  glass: string;
  line: string;
}

const materials = new Map<string, Material>();

function materialOf(ink: SpiderInk): Material {
  const key = `${ink.dark}|${ink.line}|${ink.accent}|${ink.beam}|${ink.eye}`;
  let m = materials.get(key);
  if (!m) {
    // A colour picker dragged makes a new one every step; keep only the latest few.
    if (materials.size > 32) materials.clear();
    m = {
      shell: mix(ink.dark, ink.line, 0.14),
      lit: mix(ink.dark, "#ffffff", 0.3),
      deep: ink.dark,
      spec: mix("#ffffff", ink.beam, 0.25),
      rim: ink.line,
      core: ink.accent,
      coreBright: mix(ink.accent, "#ffffff", 0.55),
      eye: ink.eye,
      glass: mix(ink.dark, ink.eye, 0.14),
      line: ink.line,
    };
    materials.set(key, m);
  }
  return m;
}

/** Toward the light, on the screen (from the top left), as a unit vector. */
const LIGHT: XY = { x: -0.6, y: -0.8 };
/** Where a point's shadow falls on the web, per pixel of its height: down and to the right. */
const SHADOW: XY = { x: 0.3, y: 0.42 };
const SHADOW_ALPHA = 0.3;

/** Where the head's neck sits on the chassis, and where on the head the beams come from, in the body's frame (shares of the rig's length, forward -y): the mouth, between the fangs, and the eyes, the middle of their cluster on the visor. */
const NECK: XY = { x: 0, y: -0.44 * BODY };
const MOUTH: XY = { x: 0, y: -0.46 * BODY };
const EYES: XY = { x: 0, y: -0.2 * BODY };

/** Where on the head a beam comes from: the hover's from the eyes, the hold's from the mouth. */
export type BeamFrom = "mouth" | "eyes";

/** Where the spider's beams come from, in pixels from the hub: the mouth or the eyes, on the head, turned with it, the body swayed. */
export function beamOrigin(rig: Rig, s: number, from: BeamFrom): XY {
  const neck = bodyToWeb(NECK, rig.chassis, s);
  const on = bodyToWeb(from === "mouth" ? MOUTH : EYES, rig.head, s);
  return { x: neck.x + on.x + rig.sway.x, y: neck.y + on.y + rig.sway.y };
}

// Shapes.

/** A closed curve smoothed through the midpoints of `points` (each a corner it rounds), scaled by `k`. */
function blob(path: Path2D, points: ReadonlyArray<readonly [number, number]>, k: number): void {
  const n = points.length;
  const mid = (i: number): [number, number] => {
    const a = points[i % n];
    const b = points[(i + 1) % n];
    return [((a[0] + b[0]) / 2) * k, ((a[1] + b[1]) / 2) * k];
  };
  const [sx, sy] = mid(n - 1);
  path.moveTo(sx, sy);
  for (let i = 0; i < n; i++) {
    const [mx, my] = mid(i);
    path.quadraticCurveTo(points[i][0] * k, points[i][1] * k, mx, my);
  }
  path.closePath();
}

/** A segment as a plate from `a`, `wa` wide, to `b`, `wb` wide, its sides bowing out by `bulge` at the middle (a spindle). */
function plate(path: Path2D, a: XY, b: XY, wa: number, wb: number, bulge = 0): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / d;
  const ny = dx / d;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const c = (wa + wb) / 2 + 2 * bulge;
  path.moveTo(a.x + nx * wa, a.y + ny * wa);
  path.quadraticCurveTo(mx + nx * c, my + ny * c, b.x + nx * wb, b.y + ny * wb);
  path.lineTo(b.x - nx * wb, b.y - ny * wb);
  path.quadraticCurveTo(mx - nx * c, my - ny * c, a.x - nx * wa, a.y - ny * wa);
  path.closePath();
}

function line(a: XY, b: XY): Path2D {
  const p = new Path2D();
  p.moveTo(a.x, a.y);
  p.lineTo(b.x, b.y);
  return p;
}

function fillPath(ctx: Ctx, path: Path2D, colour: string, alpha = 1): void {
  if (alpha <= 0.005) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

function strokePath(ctx: Ctx, path: Path2D, colour: string, width: number, alpha = 1): void {
  if (alpha <= 0.005 || width <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

/** A joint: a dark disc in a ring, the ring glowing in the accent with a bright core when `core`, else a plain steel ring; `alight` (a stepping leg) turns it to the beam's colour and widens it. */
function joint(ctx: Ctx, at: XY, r: number, m: Material, ink: SpiderInk, alight: number, core: boolean): void {
  if (core) drawHalo(ctx, at.x, at.y, r * 2.6, m.core, 0.35 + 0.5 * alight);
  const disc = new Path2D();
  disc.arc(at.x, at.y, r, 0, Math.PI * 2);
  fillPath(ctx, disc, m.deep);
  strokePath(ctx, disc, alight > 0.05 ? ink.beam : core ? m.core : m.lit, 0.7 + 0.6 * alight, core ? 0.85 : 0.6);
  if (core) {
    const dot = new Path2D();
    dot.arc(at.x, at.y, r * 0.42, 0, Math.PI * 2);
    fillPath(ctx, dot, m.coreBright, 0.85);
  }
}

/**
 * A plate of a leg from `a` to `b` (on the web; `za`, `zb` their heights,
 * which say how steep it is): its shell, a lit face toward the light when
 * `detail` allows, a specular line along its lit edge, the web's rim light
 * along its far edge, an emissive seam when `seam`, and its outline.
 * `flat` is how much of its length lies along the web (1 flat, 0 upright),
 * which lights the face and the shine.
 */
function legPlate(ctx: Ctx, a: XYZ, b: XYZ, wa: number, wb: number, bulge: number, m: Material, px: number, seam: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3) return;
  const flat = d / (Math.hypot(d, b.z - a.z) || 1);
  const nx = -dy / d;
  const ny = dx / d;
  // Which edge faces the light.
  const toward = nx * LIGHT.x + ny * LIGHT.y >= 0 ? 1 : -1;
  const body = new Path2D();
  plate(body, a, b, wa, wb, bulge);
  fillPath(ctx, body, m.shell);
  const detail = Math.max(wa, wb) * px;
  if (detail >= 1.6) {
    const face = new Path2D();
    const shift = 0.3 * toward;
    plate(face, { x: a.x + nx * wa * shift, y: a.y + ny * wa * shift }, { x: b.x + nx * wb * shift, y: b.y + ny * wb * shift }, wa * 0.5, wb * 0.5, bulge * 0.5);
    fillPath(ctx, face, m.lit, 0.25 + 0.4 * flat);
  }
  const specAt = 0.62 * toward;
  strokePath(ctx, line({ x: a.x + nx * wa * specAt, y: a.y + ny * wa * specAt }, { x: b.x + nx * wb * specAt, y: b.y + ny * wb * specAt }), m.spec, 0.7, 0.2 + 0.55 * flat);
  const rimAt = -0.8 * toward;
  strokePath(ctx, line({ x: a.x + nx * wa * rimAt, y: a.y + ny * wa * rimAt }, { x: b.x + nx * wb * rimAt, y: b.y + ny * wb * rimAt }), m.rim, 0.6, 0.3);
  if (seam > 0 && detail >= 1.2) strokePath(ctx, line({ x: lerp(a.x, b.x, 0.12), y: lerp(a.y, b.y, 0.12) }, { x: lerp(a.x, b.x, 0.88), y: lerp(a.y, b.y, 0.88) }), m.core, 0.6, seam);
  strokePath(ctx, body, m.line, 0.5, 0.4);
}

/** The shadow a chain of joints casts on the web: each point moved by its height, as one stroke. */
function shadowOf(points: readonly XYZ[]): Path2D {
  const p = new Path2D();
  points.forEach((j, i) => {
    const x = j.x + j.z * SHADOW.x;
    const y = j.y + j.z * SHADOW.y;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  });
  return p;
}

/**
 * One leg, as the rig poses it: the coxa, the femur, the patella, the tibia,
 * the metatarsus and the tarsus, each a plate, a joint at every bend, spines
 * on the tibia and the metatarsus and claws at the foot once they would show
 * (`px`, how many screen pixels a rig pixel is), and the grip light where a
 * planted foot holds the web.
 */
function drawLeg(ctx: Ctx, pose: LegPose, s: number, m: Material, ink: SpiderInk, px: number, side: -1 | 1): void {
  const { hip, trochanter, knee, patella, ankle, tarsus, foot, up } = pose;
  legPlate(ctx, hip, trochanter, 0.085 * s, 0.07 * s, 0, m, px, 0);
  legPlate(ctx, trochanter, knee, 0.072 * s, 0.058 * s, 0.022 * s, m, px, 0.45);
  legPlate(ctx, knee, patella, 0.06 * s, 0.052 * s, 0.008 * s, m, px, 0);
  legPlate(ctx, patella, ankle, 0.05 * s, 0.036 * s, 0.006 * s, m, px, 0.4);
  legPlate(ctx, ankle, tarsus, 0.033 * s, 0.02 * s, 0, m, px, 0.25);
  legPlate(ctx, tarsus, foot, 0.018 * s, 0.003 * s, 0, m, px, 0);
  if (0.04 * s * px >= 1.4) {
    // Spines on the outer edge of the tibia and the metatarsus, and the claws at the foot.
    const spines = new Path2D();
    for (const [a, b, n] of [[patella, ankle, 2], [ankle, tarsus, 1]] as const) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const ox = (-dy / d) * side;
      const oy = (dx / d) * side;
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        const x = lerp(a.x, b.x, t);
        const y = lerp(a.y, b.y, t);
        spines.moveTo(x, y);
        spines.lineTo(x + (ox * 0.9 + (dx / d) * 0.45) * 0.035 * s, y + (oy * 0.9 + (dy / d) * 0.45) * 0.035 * s);
      }
    }
    const tx = foot.x - tarsus.x;
    const ty = foot.y - tarsus.y;
    const td = Math.hypot(tx, ty) || 1;
    for (const turn of [-0.5, 0.5]) {
      const cx = (tx / td) * Math.cos(turn) - (ty / td) * Math.sin(turn);
      const cy = (tx / td) * Math.sin(turn) + (ty / td) * Math.cos(turn);
      spines.moveTo(foot.x, foot.y);
      spines.lineTo(foot.x + cx * 0.03 * s, foot.y + cy * 0.03 * s);
    }
    strokePath(ctx, spines, m.line, 0.7, 0.75);
  }
  joint(ctx, knee, 0.052 * s, m, ink, up, true);
  joint(ctx, patella, 0.042 * s, m, ink, up, false);
  joint(ctx, ankle, 0.034 * s, m, ink, up, true);
  joint(ctx, tarsus, 0.022 * s, m, ink, up, false);
  if (up < 0.05) drawHalo(ctx, foot.x, foot.y, 2.6, ink.beam, 0.7);
}

/** One eye: a glowing disc with a bright pupil toward the gaze, shut to a line as `open` falls; the bigger ones bloom. */
function eye(ctx: Ctx, x: number, y: number, r: number, eyes: Eyes, m: Material, bloom: boolean): void {
  const open = Math.max(0.08, eyes.open);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, open);
  if (bloom) drawHalo(ctx, 0, 0, r * 1.9, m.eye, Math.min(1, 0.38 * eyes.glow));
  const disc = new Path2D();
  disc.arc(0, 0, r, 0, Math.PI * 2);
  fillPath(ctx, disc, m.eye, Math.min(1, 0.8 * eyes.glow));
  const pupil = new Path2D();
  pupil.arc(eyes.gaze.x * r * 0.3, eyes.gaze.y * r * 0.3 - r * 0.15, r * 0.4, 0, Math.PI * 2);
  fillPath(ctx, pupil, "#ffffff", Math.min(1, 0.6 * eyes.glow));
  ctx.restore();
}

/** A pedipalp's or chelicera's small plate between two points. */
function limb(ctx: Ctx, a: XY, b: XY, wa: number, wb: number, m: Material): void {
  const p = new Path2D();
  plate(p, a, b, wa, wb);
  fillPath(ctx, p, m.shell);
  strokePath(ctx, p, m.line, 0.5, 0.5);
}

function turn(p: XY, angle: number): XY {
  return { x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) };
}

/**
 * The spider at (0, 0), `s` pixels (the length its rig is built on; its body
 * is BODY of that), as its rig holds it, at `now`: the shadows first, then
 * the legs on their footholds, the abdomen at its own heading, the pedicel,
 * the thorax, the neck, and the head with the eyes, the chelicerae and the
 * palps. `px` is how many screen pixels a rig pixel is (the zoom's
 * growth), which decides how much fine detail is drawn.
 */
export function drawSpider(ctx: Ctx, rig: Rig, s: number, eyes: Eyes, ink: SpiderInk, now: number, options: { reduced: boolean; px: number; shadow: boolean }): void {
  const { reduced, px, shadow } = options;
  const m = materialOf(ink);
  const b = s * BODY;
  const swell = 1 - 0.03 * rig.crouch;
  const height = BODY_HEIGHT * s * (1 - CROUCH * rig.crouch);
  // A groom under way: how far the front leg has folded up, 0 to 1 and back, and on which side.
  const groom = rig.idle?.kind === "groom" ? Math.sin(Math.PI * Math.min(1, Math.max(0, (now - rig.idle.start) / rig.idle.length))) : 0;
  const groomSide = rig.idle?.leg?.side ?? 0;
  const breath = reduced ? 1 : 1 + 0.012 * Math.sin(now / 640);
  const poses = rig.legs.map((leg) => legPose(rig, leg, s, now));
  const pedicel = bodyToWeb({ x: 0, y: 0.02 * BODY }, rig.chassis, s);
  const neck = bodyToWeb(NECK, rig.chassis, s);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // The shadows, on the web, unless turned off (webShadow.ts): the body's parts by the hips' height, and each leg's chain of joints by its own.
  if (shadow) {
    ctx.save();
    ctx.globalAlpha = SHADOW_ALPHA;
    ctx.fillStyle = "#000000";
    ctx.strokeStyle = "#000000";
    ctx.translate(rig.sway.x + height * SHADOW.x, rig.sway.y + height * SHADOW.y);
    const bodyShadow = new Path2D();
    bodyShadow.ellipse(pedicel.x, pedicel.y, 0.2 * b, 0.2 * b, 0, 0, Math.PI * 2);
    const abdomenAt = bodyToWeb({ x: 0, y: 0.42 }, rig.abdomen, b);
    bodyShadow.ellipse(pedicel.x + abdomenAt.x, pedicel.y + abdomenAt.y, 0.3 * b, 0.4 * b, rig.abdomen + Math.PI / 2, 0, Math.PI * 2);
    const thoraxAt = bodyToWeb({ x: 0, y: -0.2 }, rig.chassis, b);
    bodyShadow.ellipse(thoraxAt.x, thoraxAt.y, 0.22 * b, 0.26 * b, rig.chassis + Math.PI / 2, 0, Math.PI * 2);
    const headAt = bodyToWeb({ x: 0, y: -0.14 }, rig.head, b);
    bodyShadow.ellipse(neck.x + headAt.x, neck.y + headAt.y, 0.16 * b, 0.22 * b, rig.head + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill(bodyShadow);
    ctx.restore();
    ctx.globalAlpha = SHADOW_ALPHA;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 0.036 * s;
    for (const pose of poses) {
      ctx.globalAlpha = SHADOW_ALPHA * Math.max(0.3, 1 - 0.35 * pose.up);
      ctx.stroke(shadowOf([pose.hip, pose.trochanter, pose.knee, pose.patella, pose.ankle, pose.tarsus, pose.foot]));
    }
    ctx.globalAlpha = 1;
  }

  // The legs, the rear pairs first.
  for (let i = rig.legs.length - 1; i >= 0; i--) drawLeg(ctx, poses[i], s, m, ink, px, rig.legs[i].side);

  // The body, swayed with its weight.
  ctx.translate(rig.sway.x, rig.sway.y);

  // The abdomen, hung from the pedicel at its own heading, breathing.
  ctx.save();
  ctx.translate(pedicel.x, pedicel.y);
  ctx.rotate(rig.abdomen + Math.PI / 2);
  ctx.scale(swell * breath, swell * breath);
  {
    const egg = new Path2D();
    blob(egg, [[0, 0], [0.2, 0.08], [0.32, 0.34], [0.28, 0.62], [0.14, 0.84], [0, 0.9], [-0.14, 0.84], [-0.28, 0.62], [-0.32, 0.34], [-0.2, 0.08]], b);
    const shade = ctx.createRadialGradient(-0.08 * b, 0.28 * b, 0.04 * b, 0, 0.42 * b, 0.58 * b);
    shade.addColorStop(0, m.lit);
    shade.addColorStop(0.45, m.shell);
    shade.addColorStop(1, m.deep);
    ctx.fillStyle = shade;
    ctx.fill(egg);
    // The plates, overlapping backward: a dark edge and a light one.
    const edges = new Path2D();
    const lights = new Path2D();
    for (const [y, w] of [[0.24, 0.29], [0.4, 0.31], [0.56, 0.28], [0.71, 0.21]] as const) {
      edges.moveTo(-w * b, y * b);
      edges.quadraticCurveTo(0, (y + 0.09) * b, w * b, y * b);
      lights.moveTo(-w * 0.92 * b, (y - 0.018) * b);
      lights.quadraticCurveTo(0, (y + 0.07) * b, w * 0.92 * b, (y - 0.018) * b);
    }
    strokePath(ctx, edges, m.deep, 0.9, 0.75);
    strokePath(ctx, lights, m.spec, 0.6, 0.2);
    // The seam, with its traces branching back.
    const seam = new Path2D();
    seam.moveTo(0, 0.07 * b);
    seam.lineTo(0, 0.8 * b);
    for (const y of [0.3, 0.46, 0.62]) {
      for (const side of [-1, 1]) {
        seam.moveTo(0, y * b);
        seam.lineTo(side * 0.06 * b, (y + 0.03) * b);
        seam.lineTo(side * 0.15 * b, (y + 0.09) * b);
      }
    }
    glowStroke(ctx, seam, m.core, 0.8, 3.2, 0.6, 0.18);
    // The gloss, and the rim: the outline lit by the web from the far side.
    const gloss = new Path2D();
    gloss.ellipse(-0.1 * b, 0.27 * b, 0.07 * b, 0.13 * b, 0.3, 0, Math.PI * 2);
    fillPath(ctx, gloss, m.spec, 0.13);
    const rim = ctx.createLinearGradient(-0.3 * b, 0, 0.3 * b, 0.9 * b);
    rim.addColorStop(0, rgba(m.line, 0.3));
    rim.addColorStop(1, rgba(m.rim, 0.85));
    ctx.strokeStyle = rim;
    ctx.lineWidth = 0.9;
    ctx.stroke(egg);
    // The spinnerets.
    for (const [x, y, glow] of [[-0.04, 0.9, false], [0.04, 0.9, false], [0, 0.935, true]] as const) {
      const nub = new Path2D();
      nub.arc(x * b, y * b, 0.026 * b, 0, Math.PI * 2);
      fillPath(ctx, nub, m.deep);
      strokePath(ctx, nub, m.line, 0.5, 0.6);
      if (glow) drawHalo(ctx, x * b, y * b, 0.06 * b, m.core, 0.55);
    }
  }
  ctx.restore();

  // The pedicel: the joint the abdomen hangs from, over it and under the thorax.
  joint(ctx, pedicel, 0.05 * b, m, ink, 0, true);

  // The thorax, at the chassis's heading: the shield with the hip sockets, the fovea and its striae, the seam and the gloss.
  ctx.save();
  ctx.rotate(rig.chassis + Math.PI / 2);
  ctx.scale(swell, swell);
  {
    const shield = new Path2D();
    blob(shield, [[0, -0.47], [0.16, -0.4], [0.24, -0.2], [0.2, -0.02], [0.1, 0.05], [-0.1, 0.05], [-0.2, -0.02], [-0.24, -0.2], [-0.16, -0.4]], b);
    const shade = ctx.createLinearGradient(-0.2 * b, -0.42 * b, 0.22 * b, 0.04 * b);
    shade.addColorStop(0, m.lit);
    shade.addColorStop(0.4, m.shell);
    shade.addColorStop(1, m.deep);
    ctx.fillStyle = shade;
    ctx.fill(shield);
    const striae = new Path2D();
    for (const [x, y] of [[0.19, -0.36], [0.22, -0.2], [0.19, -0.06], [-0.19, -0.36], [-0.22, -0.2], [-0.19, -0.06]] as const) {
      striae.moveTo(0, -0.17 * b);
      striae.lineTo(x * b, y * b);
    }
    strokePath(ctx, striae, m.deep, 0.7, 0.7);
    const fovea = new Path2D();
    fovea.moveTo(0, -0.23 * b);
    fovea.lineTo(0, -0.11 * b);
    strokePath(ctx, fovea, m.deep, 1.4, 0.9);
    const seam = new Path2D();
    seam.moveTo(0, -0.44 * b);
    seam.lineTo(0, -0.25 * b);
    seam.moveTo(-0.07 * b, -0.36 * b);
    seam.lineTo(0, -0.3 * b);
    seam.lineTo(0.07 * b, -0.36 * b);
    glowStroke(ctx, seam, m.core, 0.8, 3, 0.55, 0.16);
    const gloss = new Path2D();
    gloss.ellipse(-0.08 * b, -0.3 * b, 0.06 * b, 0.1 * b, 0.4, 0, Math.PI * 2);
    fillPath(ctx, gloss, m.spec, 0.12);
    strokePath(ctx, shield, m.line, 0.9, 0.55);
  }
  ctx.restore();

  // The neck: a ball joint under two collars that turn with the head, and a cable each side.
  const bend = wrapAngle(rig.head - rig.chassis);
  ctx.save();
  ctx.translate(neck.x, neck.y);
  ctx.rotate(rig.chassis + Math.PI / 2);
  {
    const cables = new Path2D();
    for (const side of [-1, 1] as const) {
      const from = { x: side * 0.15 * b, y: 0.1 * b };
      const to = turn({ x: side * 0.11 * b, y: 0.04 * b }, bend);
      cables.moveTo(from.x, from.y);
      cables.quadraticCurveTo((from.x + to.x) / 2 + side * 0.05 * b, (from.y + to.y) / 2, to.x, to.y);
    }
    strokePath(ctx, cables, ink.beam, 1.1, 0.55);
    drawHalo(ctx, 0, 0, 0.12 * b, m.core, 0.4);
    for (let i = 0; i < 2; i++) {
      ctx.save();
      ctx.rotate(bend * ((i + 1) / 3));
      ctx.translate(0, -i * 0.03 * b);
      const collar = new Path2D();
      collar.ellipse(0, 0, (0.14 - i * 0.02) * b, 0.05 * b, 0, 0, Math.PI * 2);
      fillPath(ctx, collar, m.shell);
      strokePath(ctx, collar, m.line, 0.7, 0.7);
      ctx.restore();
    }
  }
  ctx.restore();

  // The head, on the neck, at its own heading: the helmet, the visor with the eyes, the chelicerae and the palps.
  ctx.save();
  ctx.translate(neck.x, neck.y);
  ctx.rotate(rig.head + Math.PI / 2);
  ctx.scale(swell, swell);
  {
    const skull = new Path2D();
    blob(skull, [[0, -0.37], [0.1, -0.34], [0.17, -0.18], [0.16, 0], [0.09, 0.08], [0, 0.1], [-0.09, 0.08], [-0.16, 0], [-0.17, -0.18], [-0.1, -0.34]], b);
    const shade = ctx.createLinearGradient(-0.17 * b, -0.3 * b, 0.17 * b, 0.1 * b);
    shade.addColorStop(0, m.lit);
    shade.addColorStop(0.45, m.shell);
    shade.addColorStop(1, m.deep);
    ctx.fillStyle = shade;
    ctx.fill(skull);
    strokePath(ctx, line({ x: 0, y: 0.08 * b }, { x: 0, y: -0.34 * b }), m.spec, 0.7, 0.3);
    const facets = new Path2D();
    facets.moveTo(-0.13 * b, -0.05 * b);
    facets.lineTo(-0.06 * b, -0.12 * b);
    facets.lineTo(0.06 * b, -0.12 * b);
    facets.lineTo(0.13 * b, -0.05 * b);
    strokePath(ctx, facets, m.deep, 0.7, 0.6);
    strokePath(ctx, skull, m.line, 0.9, 0.6);
    // The visor: dark glass across the front, with a shine along its top.
    const visor = new Path2D();
    visor.moveTo(-0.15 * b, -0.14 * b);
    visor.quadraticCurveTo(0, -0.1 * b, 0.15 * b, -0.14 * b);
    visor.lineTo(0.14 * b, -0.3 * b);
    visor.quadraticCurveTo(0, -0.36 * b, -0.14 * b, -0.3 * b);
    visor.closePath();
    fillPath(ctx, visor, m.glass);
    strokePath(ctx, visor, m.line, 0.6, 0.5);
    const shine = new Path2D();
    shine.moveTo(-0.12 * b, -0.29 * b);
    shine.quadraticCurveTo(0, -0.34 * b, 0.12 * b, -0.29 * b);
    strokePath(ctx, shine, m.spec, 0.7, 0.35);
    for (const [x, y, r, bloom] of [[-0.05, -0.25, 0.038, true], [0.05, -0.25, 0.038, true], [-0.125, -0.215, 0.023, false], [0.125, -0.215, 0.023, false], [-0.045, -0.165, 0.014, false], [0.045, -0.165, 0.014, false], [-0.1, -0.135, 0.017, false], [0.1, -0.135, 0.017, false]] as const) {
      eye(ctx, x * b, y * b, Math.max(0.9, r * b), eyes, m, bloom);
    }
    // The chelicerae, hanging under the face, their fangs curved in.
    for (const side of [-1, 1] as const) {
      ctx.save();
      ctx.translate(side * 0.06 * b, -0.33 * b);
      limb(ctx, { x: 0, y: 0 }, { x: side * 0.012 * b, y: -0.11 * b }, 0.03 * b, 0.024 * b, m);
      const fang = new Path2D();
      fang.moveTo(side * 0.012 * b, -0.11 * b);
      fang.quadraticCurveTo(side * 0.008 * b, -0.19 * b, -side * 0.04 * b, -0.17 * b);
      strokePath(ctx, fang, m.core, 1.1, 0.9);
      ctx.restore();
    }
    // The pedipalps, waving slowly, and curling in for a groom, the groomed side most.
    for (const side of [-1, 1] as const) {
      const wave = reduced ? 0 : 0.16 * Math.sin(now / 850 + side * 1.3);
      const curl = groom * (side === groomSide ? 0.9 : 0.4);
      const base = { x: side * 0.12 * b, y: -0.29 * b };
      const first = turn({ x: side * 0.085 * b, y: -0.11 * b }, side * wave - side * 0.3 * curl);
      const one = { x: base.x + first.x, y: base.y + first.y };
      const second = turn({ x: -side * 0.01 * b, y: -0.13 * b }, side * wave * 1.6 - side * 0.9 * curl);
      const two = { x: one.x + second.x, y: one.y + second.y };
      limb(ctx, base, one, 0.028 * b, 0.022 * b, m);
      limb(ctx, one, two, 0.022 * b, 0.016 * b, m);
      joint(ctx, one, 0.024 * b, m, ink, 0, false);
      const bulb = new Path2D();
      bulb.arc(two.x, two.y, 0.03 * b, 0, Math.PI * 2);
      fillPath(ctx, bulb, m.shell);
      strokePath(ctx, bulb, m.core, 0.7, 0.8);
      drawHalo(ctx, two.x, two.y, 0.06 * b, m.core, 0.35);
    }
  }
  ctx.restore();
  ctx.restore();
}
