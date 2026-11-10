// The Spider web view's drawing (Orbits.tsx with the web look), on the canvas under
// the SVG (WebLayer.tsx) with the helpers in webDraw.ts, its boot timed by
// webChoreography.ts, in Amber, the Spider web's own (amber strands, teal
// rings), or a custom colour (webColour.ts), the teal kept for the spider's
// eyes and its beams in every colour. Only the palette differs.
//
// The look: a holographic wireframe on a deep ground with a fine grid and
// scanlines, a trace of chromatic split, and a web that runs out past the
// edges of the screen (webGeometry.ts), fading toward them, as strong as the
// Web strength slider says (webStrength.ts): an orb web with as many spokes
// and its cross threads sagging as deep as its sliders say (webStyle.ts), whose rings
// are the rank rings, drawn stronger than the thinner rings between them and
// never fainter than the guide rings they stand in for, each broken where its
// label sits. The spider sits at the hub
// (webSpider.ts, on the rig in webRig.ts), growing gently with the zoom
// (SPIDER_GROWTH) so its detail can be looked at: its head looks toward
// whoever is selected (their panel open), else whoever is hovered, almost at
// once, so while someone is held hovering others turns nothing; its chassis
// follows later and slower to face whoever is selected, and anyone else
// only from beyond the cone of 90° in front of it (CONE), its abdomen
// trails, its legs keep their footholds on the web and step when the body turns, and it holds where it last turned, the cursor
// itself meaning nothing; its eyes have a life of their own (webEyes.ts), at
// rest it grooms, plucks the web, looks round, settles and flexes of its
// own, never on a loop. The Spider web boots when it opens, and again whenever
// you re-query: a flicker, then a scan line from the top of the
// stage to the bottom materialises the web as it passes and locks in everyone
// it names (its Show top names) with a bracket. Hovering someone, with nobody
// held, fires a beam at them from the spider's eyes: it runs out, locks with
// a flash, and holds, energised, until they are looked away from, when it
// breaks up. Selecting someone takes them up (webHold.ts): a line is laid
// out to them from the mouth with a little slack, draws taut and snaps with
// a flash and a twang, and holds them as an energised beam, with no reticle
// on them, a beam from the eyes on them giving way to it; deselected, it
// reels back into the mouth. While someone is held the hold is the only
// line: hovering someone else fires no beam. The square targeting reticle goes
// with the hover: it snaps onto whoever is hovered, someone held or not, and
// springs off as the pointer leaves them, but never marks whoever is held.
//
// Two canvases (WebLayer.tsx). Under the SVG, in this order: the ground, the
// web (as far as the scan has reached), halos under people, the spider, then
// a hole of the ground's colour under every marker (none under a name in its
// place), so the web ends at each
// icon's rim and never shows through it (Orbits
// draws the fainter tiers' icons translucent), and a fade under the header.
// Once booted, what of that holds still (the strands, their fade, the halos
// that do not swell, the holes) is drawn once for each scene Orbits gives and
// copied in each frame (stillWeb), so a frame draws only what moves.
// Over the SVG (drawWebOver): the beam to whoever is hovered and the reticle
// on them, and over those the hold on whoever is selected, above everything,
// other people's icons included, as you asked. The colours, the canvas's and those of Orbits' own SVG
// marks (the sun's gradient, the markers' rims, the trails, the names), are
// the colour's theme (webTheme.ts).

import { easeCubicOut } from "d3";
import { mix } from "../identicon.ts";
import type { Frame } from "./orbitsSky.ts";
import { glowLook, pulseAt, SWELL } from "./reachGlow.ts";
import { appearAt, BOOT_MS, easeOutBack, easeOutExpo, SCAN, travelEase, type WebMotion } from "./webChoreography.ts";
import type { WebColour } from "./webColour.ts";
import { webTheme, type Ink } from "./webTheme.ts";
import { bracketPath, clamp01, drawHalo, flicker, glowDot, glowStroke, lerp, rgba, ringsPath, spokesPath, strandPath, type Ctx, type XY } from "./webDraw.ts";
import { ringTop, strandSag, type WebShape } from "./webGeometry.ts";
import { eyesAt, newEyeState, type EyeState, type Eyes } from "./webEyes.ts";
import { BEAM_TIMING, holdPhase, HOLD_TIMING, lookedAt, MARK_TIMING, newHoldState, stepHold, type HoldState, type LetGo } from "./webHold.ts";
import { newRig, updateRig, wrapAngle, type Rig } from "./webRig.ts";
import { beamOrigin, drawSpider, type BeamFrom, type SpiderInk } from "./webSpider.ts";

export type { WebMotion };

/** Someone on the map, as the drawing needs them: their id and their identicon's main colour. */
export interface WebPerson {
  id: number;
  colour: string;
}

/** What the drawing works from, as of one render of Orbits: the stage, the zoom, where everyone is, and who is picked out. */
export interface WebScene {
  colour: WebColour;
  /** How strongly the web is drawn, 0 to 1 (webStrength.ts). */
  webStrength: number;
  /** How strongly everyone to reach out to glows, 0 (the usual) to 1 (reachGlow.ts). */
  reachGlow: number;
  /** Whether the spider casts its shadow on the web (webShadow.ts). */
  shadow: boolean;
  width: number;
  height: number;
  /** The header's height: the web fades under it. */
  top: number;
  /** Where the sun is on the stage, and the zoom. */
  sun: XY;
  k: number;
  inner: number;
  outer: number;
  shape: WebShape;
  frames: ReadonlyMap<number, Frame>;
  /** Everyone drawn, the most talked-to first. */
  people: readonly WebPerson[];
  /** How strongly each is drawn (Orbits' strength), and how far they have arrived where they are headed (1 once there). */
  strength: (id: number) => number;
  arrived: (id: number) => number;
  /** Who locks in with a bracket as the Spider web boots: whoever it surely names unzoomed (its Show top names, topNames.ts). */
  lockIn: (id: number) => boolean;
  focusId: number | null;
  linked: ReadonlySet<number>;
  /** Whose reach-out glow is drawn: everyone's, but while someone is held only theirs and their links', and nobody's under No name except… (glowsOf). */
  glows: (id: number) => boolean;
  /** Who is under the pointer, and who is selected (their panel open, and drawn): the spider holds and looks at the second, else looks at the first (webHold.ts). */
  hoverId: number | null;
  heldId: number | null;
  reduced: boolean;
  /**
   * Whoever is drawn as their name alone, in place of their icon (everyone named), with
   * their name's width and height as placed, centred on them: their marks fit round the name (markOf), and they
   * have no halo and no hole cut under them.
   */
  names?: ReadonlyMap<number, { wide: number; tall: number }>;
}

/** What the drawing keeps between frames: the spider's rig and eyes, its hold and beam, and patterns made once. */
export interface LookState {
  /** Which way the spider faces when its rig is first made (radians, as the rig's headings: -π/2 up). */
  heading: number;
  rig: Rig | null;
  lastFrame: number;
  eyes: EyeState;
  /** The hold on whoever is selected, and the beam to and reticle on whoever is hovered (webHold.ts); beams let go of, breaking up, holds let go of, reeling in, and reticles let go of, springing off. */
  hold: HoldState;
  leaving: Array<{ id: number; left: number; at: XY; from: XY }>;
  reeling: Array<{ id: number; left: number; at: XY }>;
  unmarking: Array<{ id: number; left: number; at: XY }>;
  /** Where the beams come from this frame, on the spider's head: the hold from the mouth, the hover's beam from the eyes. */
  origin: Record<BeamFrom, XY>;
  patterns: Map<string, CanvasPattern | null>;
  /** What of the web holds still, drawn once for each scene (stillWeb). */
  still: StillWeb;
}

/** The spider facing up, as tests and a still capture draw it unless they ask for another way. */
export const UP = -Math.PI / 2;

/** A drawing's state from its first frame; `still` may be one kept from an earlier drawing, so a still drawn each change (reduced motion) makes no new canvas each time. */
export function newLookState(heading = UP, still = newStillWeb()): LookState {
  return { heading, rig: null, lastFrame: 0, eyes: newEyeState(performance.now()), hold: newHoldState(), leaving: [], reeling: [], unmarking: [], origin: { mouth: { x: 0, y: 0 }, eyes: { x: 0, y: 0 } }, patterns: new Map(), still };
}

/** Where a person is now, in pixels relative to the sun at the scene's zoom; null if they are not on the map. */
function spot(scene: WebScene, id: number): XY | null {
  const f = scene.frames.get(id);
  if (!f || f.opacity <= 0.01) return null;
  return { x: Math.cos(f.angle) * f.r * scene.k, y: Math.sin(f.angle) * f.r * scene.k };
}

/** How far the square targeting reticle (the hover's) reaches past a marker's edge on each side, px: kept small so its corners stay off the names. */
const RETICLE_PAD = 3;

/** How long a boot lock-in bracket stays on someone once the scan reaches them, ms: snapping on, then fading, all within the boot (BOOT_MS). */
export const LOCK_FLASH_MS = 520;

/** The targeting reticle's width round a marker of radius `r`. */
function reticleSize(r: number): number {
  return r * 2 + RETICLE_PAD * 2;
}

/** A marker's radius as drawn: Orbits' drawnSize, for the halos and the brackets round people. */
function sized(scene: WebScene, f: Frame): number {
  return f.silent ? f.size : Math.max(f.size, Math.min(9, f.size * scene.k));
}

/**
 * What stands for a person on the map, as a box centred on them: their marker (a square as wide as it), or, with Name
 * only, their name in its place (`name`); `wide` and `tall` across, px.
 */
export function markOf(scene: Pick<WebScene, "frames" | "k" | "names">, id: number): { wide: number; tall: number; name: boolean } {
  const name = scene.names?.get(id);
  if (name) return { ...name, name: true };
  const f = scene.frames.get(id);
  const d = 2 * (f ? sized(scene as WebScene, f) : 6);
  return { wide: d, tall: d, name: false };
}

/**
 * Where a line from `from` to someone at `at` ends: at them, or, for a name in place of their icon, at
 * the edge of its box `pad` out, so no beam runs across the name.
 */
export function lineEnd(scene: Pick<WebScene, "frames" | "k" | "names">, id: number, at: XY, from: XY, pad = 2): XY {
  const mark = markOf(scene, id);
  if (!mark.name) return at;
  const [dx, dy] = [from.x - at.x, from.y - at.y];
  const s = Math.min(Math.abs(dx) > 1e-9 ? (mark.wide / 2 + pad) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? (mark.tall / 2 + pad) / Math.abs(dy) : Infinity);
  return s >= 1 ? at : { x: at.x + dx * s, y: at.y + dy * s };
}

/** The fade under the header: the ground's colour over the top of the drawing, as Orbits' SVG mask fades its people there. */
function headerFade(ctx: Ctx, scene: WebScene, background: string): void {
  const from = Math.max(0, scene.top - 56);
  const to = Math.max(from + 1, scene.top - 12);
  const g = ctx.createLinearGradient(0, from, 0, to);
  g.addColorStop(0, rgba(background, 1));
  g.addColorStop(1, rgba(background, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, scene.width, to);
}

/** A repeating pattern made once per key. */
function pattern(ctx: Ctx, state: LookState, key: string, size: number, paint: (c: Ctx) => void): CanvasPattern | null {
  if (state.patterns.has(key)) return state.patterns.get(key)!;
  // A colour picker dragged makes a new grid every step; keep only the latest few.
  if (state.patterns.size > 32) state.patterns.clear();
  const tile = document.createElement("canvas");
  tile.width = tile.height = size;
  paint(tile.getContext("2d")!);
  const p = ctx.createPattern(tile, "repeat");
  state.patterns.set(key, p);
  return p;
}

/** The address's parameter that sets which way the spider first faces, in degrees clockwise from up, for tests and captures. */
export const HEADING_PARAM = "spider";

/**
 * Which way the spider faces when the Spider web loads: the degrees clockwise from up
 * that the address asks for (?spider=90 faces right), else a direction at
 * random, so each load it starts looking somewhere new.
 */
export function startHeading(search: string, random: () => number): number {
  const raw = new URLSearchParams(search).get(HEADING_PARAM);
  const degrees = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(degrees) ? wrapAngle(UP + (degrees * Math.PI) / 180) : wrapAngle(random() * Math.PI * 2);
}

/** How much the spider grows with the zoom: as its square root to this power, so at the zoom's limit of 12 it is about 3.5 times its size. */
export const SPIDER_GROWTH = 0.5;

/** How many times its unzoomed size the spider is drawn at zoom `k`. */
export function spiderGrowth(k: number): number {
  return Math.pow(Math.max(1, k), SPIDER_GROWTH);
}

/**
 * The spider this frame: its rig moved on (webRig.ts) toward whoever is looked
 * at (`focus`, where they are: selected, as `held` says, else hovered); at
 * rest it has a life of its own; and its eyes, which follow whoever is looked
 * at and otherwise live their own life (eyesAt). Under reduced motion every
 * part goes straight where it is headed and the eyes are still.
 */
function spiderPose(scene: WebScene, now: number, state: LookState, size: number, focus: XY | null, held: boolean): { rig: Rig; eyes: Eyes } {
  const dt = Math.min(64, state.lastFrame ? now - state.lastFrame : 16);
  state.lastFrame = now;
  state.rig ??= newRig(state.heading, now, size);
  // The head and the body face whoever is looked at; the cursor itself means nothing.
  const look = focus ? Math.atan2(focus.y, focus.x) : null;
  updateRig(state.rig, now, dt, size, { look, target: look, held, reduced: scene.reduced, random: Math.random });
  // The eyes look where the head is looking, as the head sees it: aside while the neck is still turning.
  const d = look === null ? 0 : wrapAngle(look - state.rig.head);
  const eyes = eyesAt(state.eyes, now, Math.random, { reduced: scene.reduced, look: look === null ? null : { x: Math.sin(d), y: -0.2 } });
  return { rig: state.rig, eyes };
}

/**
 * Sends off what stepHold let go of this frame (`gone`): a beam breaks up
 * from the eyes to where its person is, a hold reels in from where its
 * person is, and a reticle springs off them; and forgets what has finished,
 * or all of it under reduced motion.
 */
function letGo(scene: WebScene, state: LookState, now: number, gone: LetGo): void {
  const beamAt = gone.beam === null ? null : spot(scene, gone.beam);
  if (gone.beam !== null && beamAt) state.leaving.push({ id: gone.beam, left: now, at: beamAt, from: state.origin.eyes });
  const holdAt = gone.hold === null ? null : spot(scene, gone.hold);
  if (gone.hold !== null && holdAt) state.reeling.push({ id: gone.hold, left: now, at: holdAt });
  const markAt = gone.mark === null ? null : spot(scene, gone.mark);
  if (gone.mark !== null && markAt) state.unmarking.push({ id: gone.mark, left: now, at: markAt });
  if (state.leaving.length > 4) state.leaving.splice(0, state.leaving.length - 4);
  if (state.reeling.length > 3) state.reeling.splice(0, state.reeling.length - 3);
  if (state.unmarking.length > 4) state.unmarking.splice(0, state.unmarking.length - 4);
  state.leaving = state.leaving.filter((left) => !scene.reduced && now - left.left < BEAM_TIMING.release);
  state.reeling = state.reeling.filter((left) => !scene.reduced && now - left.left < HOLD_TIMING.reel);
  state.unmarking = state.unmarking.filter((left) => !scene.reduced && now - left.left < MARK_TIMING.off);
}

/** A line held energised from `origin` to `to` along `path`: `flash` (1 to 0) as it locks, and light running down it. */
function energised(ctx: Ctx, ink: Ink, now: number, reduced: boolean, origin: XY, to: XY, path: Path2D, flash: number): void {
  const dx = to.x - origin.x;
  const dy = to.y - origin.y;
  const d = Math.hypot(dx, dy) || 1;
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  glowStroke(ctx, path, mix(ink.beam, "#ffffff", flash), lerp(1.6, 2.2, flash), 8 + 10 * flash + 2 * pulse, 0.85, 0.22 + 0.4 * flash + 0.08 * pulse);
  if (!reduced) {
    for (let j = 0; j < 3; j++) {
      const along = (now / 420 + j / 3) % 1;
      glowDot(ctx, origin.x + dx * along, origin.y + dy * along, 1.8, "#ffffff", 5, 0.85 * Math.min(1, along * d / 30));
    }
  }
}

/**
 * The beam to whoever is hovered (state.hold.beam), at `focus`: running out
 * and flickering as it locks, held energised while it stays, and breaking
 * up into drifting segments once let go of. It comes from
 * `origin`, the spider's eyes, and is drawn over everything, other people's
 * icons included. Its reticle is the hover's (hoverReticle). Under reduced
 * motion the beam is simply there.
 */
function hoverBeam(ctx: Ctx, scene: WebScene, ink: Ink, state: LookState, now: number, focus: XY | null, origin: XY, random: () => number): void {
  const T = BEAM_TIMING;
  // Beams let go of: breaking into drifting segments.
  for (const gone of state.leaving) {
    const p = (now - gone.left) / T.release;
    const dx = gone.at.x - gone.from.x;
    const dy = gone.at.y - gone.from.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const fade = 1 - easeOutExpo(p);
    for (let i = 0; i < 4; i++) {
      const off = (i % 2 === 0 ? 1 : -1) * 10 * easeOutExpo(p) * (1 + i * 0.3);
      const a = { x: gone.from.x + dx * (i / 4) + nx * off, y: gone.from.y + dy * (i / 4) + ny * off };
      const b = { x: gone.from.x + dx * ((i + 0.8) / 4) + nx * off, y: gone.from.y + dy * ((i + 0.8) / 4) + ny * off };
      glowStroke(ctx, strandPath(a, b), ink.beam, 1.4, 6, 0.7 * fade, 0.2 * fade);
    }
  }
  const beam = state.hold.beam;
  if (!beam || !focus) return;
  const since = scene.reduced ? Infinity : now - beam.start;
  const dx = focus.x - origin.x;
  const dy = focus.y - origin.y;
  ctx.save();
  if (since < T.travel) {
    // Fired: the beam runs out to them with a bright head.
    const e = travelEase(since / T.travel);
    const tip = { x: origin.x + dx * e, y: origin.y + dy * e };
    glowStroke(ctx, strandPath(origin, tip), ink.beam, 1.2, 0, 0.85);
    glowDot(ctx, tip.x, tip.y, 2, "#ffffff", 6, 0.95);
  } else if (since < T.travel + T.reach) {
    // Locking: the beam flickers until it holds.
    glowStroke(ctx, strandPath(origin, focus), ink.beam, 1.2, 0, 0.7 + 0.3 * random());
  } else {
    // Held: energised, a flash as it locks, then a steady beam with light running down it.
    energised(ctx, ink, now, scene.reduced, origin, focus, strandPath(origin, focus), beamFlash(beam, now, scene.reduced));
  }
  ctx.restore();
}

/** How bright a hover beam's lock still flashes at `now`, 1 to 0: from when it has run out and locked, over its snap. */
function beamFlash(beam: { start: number }, now: number, reduced: boolean): number {
  const since = now - beam.start - BEAM_TIMING.travel - BEAM_TIMING.reach;
  return reduced || since < 0 ? 0 : Math.max(0, 1 - since / BEAM_TIMING.snap);
}

/**
 * The square targeting reticle on whoever is hovered (state.hold.mark), as
 * webHold.ts says whom: snapping on, spinning down from a little wider, then
 * breathing, and flashing white as the beam to them (with nobody held) locks;
 * and springing off, wider and turning, once let go of. Both are short, so a
 * sweep across many people stays readable. Under reduced motion it is simply
 * there, and gone.
 */
function hoverReticle(ctx: Ctx, scene: WebScene, ink: Ink, state: LookState, now: number): void {
  // Round a marker, a square; round a name in its place, a box as wide as the name, as far past it.
  const size = (id: number) => {
    const mark = markOf(scene, id);
    return { wide: reticleSize(mark.wide / 2), tall: reticleSize(mark.tall / 2) };
  };
  const brackets = (at: XY, id: number, grow: number, spin: number) => {
    const { wide, tall } = size(id);
    return bracketPath(at, wide + grow, 6, spin, tall + grow);
  };
  for (const gone of state.unmarking) {
    const p = clamp01((now - gone.left) / MARK_TIMING.off);
    const at = spot(scene, gone.id) ?? gone.at;
    glowStroke(ctx, brackets(at, gone.id, 16 * easeCubicOut(p), p * Math.PI / 4), ink.accent, 1.2, 0, 0.95 * (1 - p));
  }
  const mark = state.hold.mark;
  const at = mark && spot(scene, mark.id);
  if (!mark || !at) return;
  const p = clamp01((now - mark.start) / MARK_TIMING.on);
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  const beam = state.hold.beam;
  const flash = beam?.id === mark.id ? beamFlash(beam, now, scene.reduced) : 0;
  const grow = lerp(16, 2 * pulse, easeOutBack(p));
  glowStroke(ctx, brackets(at, mark.id, grow, (1 - p) * Math.PI / 4), flash > 0 ? mix(ink.accent, "#ffffff", flash) : ink.accent, 1.4, 6 * flash, 0.95 * Math.min(1, 0.4 + p), 0.5 * flash);
}

/** How slack the hold's line is as it is laid out, a share of its length; its twang as it snaps taut, the most it shakes, px, how fast that dies away, ms, and how fast it shakes, Hz. */
const SLACK = 0.05;
const TWANG = 2.6;
const TWANG_TAU = 170;
const TWANG_HZ = 19;
/** How many pieces a twanging line is drawn in, so it can shake. */
const TWANG_PIECES = 28;

/** A taut line from `a` to `b`, shaking sideways by `amp` at its middle at `phase` of its swing; straight without. */
function twangPath(a: XY, b: XY, amp: number, phase: number): Path2D {
  if (amp < 0.01) return strandPath(a, b);
  const path = new Path2D();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const swing = amp * Math.sin(phase);
  path.moveTo(a.x, a.y);
  for (let i = 1; i <= TWANG_PIECES; i++) {
    const u = i / TWANG_PIECES;
    const off = i === TWANG_PIECES ? 0 : Math.sin(Math.PI * u) * swing;
    path.lineTo(a.x + dx * u - (dy / d) * off, a.y + dy * u + (dx / d) * off);
  }
  return path;
}

/**
 * The hold on whoever is selected (state.hold.hold), from `origin`, the
 * spider's mouth, as webHold.ts times it: laid out with a bright head and a
 * little slack, in the beam's colour paled; drawing its slack in; a flash
 * as it snaps taut, the line twanging and dying away into the energised beam
 * that holds them. No reticle marks whoever is held, so nothing more covers
 * the names round them. A hold let go of reels in: its far end whips back to
 * the mouth in a slack curve, fading. Under reduced motion it is simply
 * there, still.
 */
function holdLine(ctx: Ctx, scene: WebScene, ink: Ink, state: LookState, now: number, origin: XY, random: () => number): void {
  const T = HOLD_TIMING;
  const silk = mix(ink.beam, "#ffffff", 0.5);
  for (const gone of state.reeling) {
    const p = clamp01((now - gone.left) / T.reel);
    const e = p * p;
    const end = { x: lerp(gone.at.x, origin.x, e), y: lerp(gone.at.y, origin.y, e) };
    const d = Math.hypot(gone.at.x - origin.x, gone.at.y - origin.y);
    const slack = (gone.id % 2 === 0 ? 1 : -1) * Math.sin(Math.PI * Math.min(1, p * 1.6)) * 0.14 * d * (1 - e);
    glowStroke(ctx, strandPath(origin, end, slack), ink.beam, 1.1, 4, 0.85 * (1 - p), 0.2 * (1 - p));
  }
  const hold = state.hold.hold;
  const at = hold && spot(scene, hold.id);
  if (!hold || !at) return;
  const to = lineEnd(scene, hold.id, at, origin);
  const { phase, p, since } = holdPhase(hold, now);
  const d = Math.hypot(to.x - origin.x, to.y - origin.y);
  const side = hold.id % 2 === 0 ? 1 : -1;
  ctx.save();
  if (phase === "lay") {
    // Laid out: the line runs out from the mouth with a bright head, a little slack.
    const e = travelEase(p);
    const tip = { x: origin.x + (to.x - origin.x) * e, y: origin.y + (to.y - origin.y) * e };
    glowStroke(ctx, strandPath(origin, tip, side * SLACK * d * e), silk, 0.9, 5, 0.9, 0.25);
    glowDot(ctx, tip.x, tip.y, 1.8, "#ffffff", 6, 0.95);
  } else if (phase === "reach") {
    // Reaching: the line draws its slack in, flickering.
    glowStroke(ctx, strandPath(origin, to, side * SLACK * d * (1 - easeCubicOut(p))), silk, 0.9, 5, 0.75 + 0.25 * random(), 0.25);
  } else {
    // Snapped taut with a flash, twanging and dying away; then held, energised.
    const snapped = since - T.lay - T.reach;
    const flash = phase === "snap" ? 1 - p : 0;
    const amp = scene.reduced ? 0 : TWANG * Math.exp(-snapped / TWANG_TAU);
    energised(ctx, ink, now, scene.reduced, origin, to, twangPath(origin, to, amp, (2 * Math.PI * TWANG_HZ * snapped) / 1000), flash);
  }
  ctx.restore();
}

/** How bright the web's rank rings are at the least, whatever the Web strength: as plain as the dashed guide rings they stand in for, so the bands keep their meaning with the web gone. */
export const RANK_FLOOR = 0.14;

/** How wide a rank ring's label is, px a character (orbits.css: 9.5px monospace, letter-spaced 0.2em), and how far its ring stays clear of it each side and above and below. */
const LABEL_CHAR = 9.5 * 0.8;
const LABEL_CLEAR = { x: 5, y: 6 };

/**
 * Where the web's rank rings' labels sit (Orbits draws them, on
 * the middle of the thread across each ring's top), as boxes the threads keep
 * clear of, relative to the sun: reaching up as far as a sagging thread rises
 * from its middle across the label's width, so it never runs into the label.
 */
export function labelBoxes(shape: WebShape, k: number): Array<{ x: number; y: number; width: number; height: number }> {
  const half = Math.sin(Math.PI / shape.spokes.length);
  return shape.rings.flatMap((ring) => {
    if (ring.label === null) return [];
    const width = ring.label.length * LABEL_CHAR + 2 * LABEL_CLEAR.x;
    // The thread is a parabola, rising from its middle by its sag times (x / half its span)², the whole sag at a spoke.
    const rise = strandSag(shape, ring.r) * k * Math.min(1, (width / 2 / (ring.r * half * k || 1)) ** 2);
    return [{ x: -width / 2, y: -ringTop(shape, ring.r) * k - LABEL_CLEAR.y - rise, width, height: 2 * LABEL_CLEAR.y + rise }];
  });
}

/** The web's strands as paths, relative to the sun: its spokes, its rank rings, its thinner rings within the people and beyond them, and the clip that breaks them where a rank ring's label sits. */
interface Strands {
  spokes: Path2D;
  ranks: Path2D;
  within: Path2D;
  beyond: Path2D;
  /** The stage less the labels' boxes, to clip to with "evenodd". */
  clip: Path2D;
}

function strandsOf(scene: WebScene): Strands {
  const { shape, k } = scene;
  const clip = new Path2D();
  clip.rect(-scene.sun.x, -scene.sun.y, scene.width, scene.height);
  for (const box of labelBoxes(shape, k)) clip.rect(box.x, box.y, box.width, box.height);
  return {
    spokes: spokesPath(shape, k),
    ranks: ringsPath(shape, k, (ring) => ring.label !== null),
    within: ringsPath(shape, k, (ring) => ring.label === null && ring.r < shape.belt),
    beyond: ringsPath(shape, k, (ring) => ring.label === null && ring.r >= shape.belt),
    clip,
  };
}

/**
 * The web's chromatic split, relative to the sun: its spokes, rank rings and thinner rings within the people again,
 * faintly, in the split's two colours, `split` px to either side; each broken where a rank ring's label sits, which
 * stays put as they shift. As strong as the Web strength says, under the strands themselves (mainStrands).
 */
function splitStrands(ctx: Ctx, strands: Strands, ink: Ink, strength: number, split: number): void {
  ctx.save();
  ctx.clip(strands.clip, "evenodd");
  for (const [dx, colour] of [[-split, ink.split[0]], [split, ink.split[1]]] as const) {
    ctx.save();
    ctx.translate(dx, 0);
    glowStroke(ctx, strands.spokes, colour, 0.8, 0, 0.12 * strength);
    glowStroke(ctx, strands.ranks, colour, 0.8, 0, 0.12 * strength);
    glowStroke(ctx, strands.within, colour, 0.5, 0, 0.06 * strength);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * The web's strands, relative to the sun, as strong as the Web strength says (1 is as strong as the web is drawn at
 * all): its spokes, its thinner rings (fainter past the people) and its rank rings, the strongest, never fainter than
 * RANK_FLOOR, every strand broken where a rank ring's label sits.
 */
function mainStrands(ctx: Ctx, strands: Strands, ink: Ink, strength: number): void {
  ctx.save();
  ctx.clip(strands.clip, "evenodd");
  glowStroke(ctx, strands.spokes, ink.strand, 0.8, 0, 0.46 * strength);
  glowStroke(ctx, strands.within, ink.rings, 0.5, 0, 0.26 * strength);
  glowStroke(ctx, strands.beyond, ink.rings, 0.5, 0, 0.2 * strength);
  glowStroke(ctx, strands.ranks, ink.rings, 1, 4, Math.max(RANK_FLOOR, 0.62 * strength), 0.08 * strength);
  ctx.restore();
}

/** The strands' fade toward the edges, relative to the sun, so the people's part of the web stays the clearest. */
function edgeFade(ctx: Ctx, scene: WebScene, ink: Ink): void {
  const { width, height, sun, k, shape } = scene;
  const fade = ctx.createRadialGradient(0, 0, shape.belt * k * 1.05, 0, 0, Math.max(width, height) * 1.1);
  fade.addColorStop(0, rgba(ink.background, 0));
  fade.addColorStop(1, rgba(ink.background, 0.42));
  ctx.fillStyle = fade;
  ctx.fillRect(-sun.x, -sun.y, width, height);
}

/** Which halos `halos` draws: all of them, only those that hold still, or only those that swell each frame. */
type HaloPick = "all" | "still" | "swelling";

/**
 * Halos under everyone drawn strongly, relative to the sun, someone to reach out to's in their colour, as far and as
 * bright as the Reach-out glow says, swelling past its halfway; while the Spider web boots (`t` ms in), everyone it
 * names locks in with a bracket as the scan reaches them, gone again within LOCK_FLASH_MS, well before the boot ends.
 * No bracket stays on anyone: the only lasting one is the hover's (hoverReticle).
 */
function halos(ctx: Ctx, scene: WebScene, ink: Ink, now: number, t: number, pick: HaloPick): void {
  const { sun, height, shape } = scene;
  const booted = t >= BOOT_MS;
  const reach = glowLook(scene.reachGlow);
  const swells = !scene.reduced && reach.pulse > 0;
  if (pick === "swelling" && !swells) return;
  const swell = swells ? 1 + SWELL.reach * reach.pulse * pulseAt(now) : 1;
  for (const person of scene.people) {
    const f = scene.frames.get(person.id);
    if (!f || f.opacity <= 0.01 || f.silent) continue;
    const strength = scene.strength(person.id);
    const p = spot(scene, person.id)!;
    const r = sized(scene, f);
    const mark = markOf(scene, person.id);
    if (!booted && scene.lockIn(person.id)) {
      const appear = appearAt({ angle: f.angle, r: f.r }, { cy: sun.y, height }, shape.belt);
      const since = t - appear.delay;
      if (since >= 0 && since < LOCK_FLASH_MS) {
        const q = clamp01(since / 280);
        const e = easeOutBack(q);
        glowStroke(ctx, bracketPath(p, lerp(40, mark.wide + 8, e), 5, (1 - q) * Math.PI / 2, lerp(40, mark.tall + 8, e)), ink.accent, 1.2, 0, 1 - clamp01((since - 280) / 240));
      }
    }
    // A name in place of an icon has no halo: it would only cloud the name.
    if (mark.name) continue;
    // Their reach-out glow, but while someone is held only if the hold is about them (glowShown); else the plain halo everyone has.
    const shine = scene.glows(person.id) ? f.glow : 0;
    if (strength < 0.35 && shine < 0.05 && person.id !== scene.focusId) continue;
    const swelling = swells && shine > 0.5;
    if ((pick === "still" && swelling) || (pick === "swelling" && !swelling)) continue;
    const a = f.opacity * scene.arrived(person.id);
    const glowing = shine * reach.reach * (shine > 0.5 ? swell : 1);
    drawHalo(ctx, p.x, p.y, r * 2.2 + 3 + 9 * glowing, shine > 0.5 ? person.colour : ink.beam, (0.22 + 0.3 * shine * reach.bright) * strength * a);
  }
}

/**
 * The holes under every marker, relative to the sun, as one path: a disc of the ground's colour under each, so nothing
 * drawn under the SVG shows through an icon; none under a name in place of one, which the web runs behind, the name's
 * own dark outline keeping it readable (the user's ask: names have no card).
 */
function holesOf(scene: WebScene): Path2D {
  const path = new Path2D();
  for (const person of scene.people) {
    const f = scene.frames.get(person.id);
    if (!f || f.opacity <= 0.01) continue;
    if (scene.names?.has(person.id)) continue;
    const p = spot(scene, person.id)!;
    const r = sized(scene, f) + 0.6;
    path.moveTo(p.x + r, p.y);
    path.arc(p.x, p.y, r, 0, Math.PI * 2);
  }
  return path;
}

/**
 * What of the drawing under the SVG holds still once the Spider web has booted, made once for each scene Orbits gives
 * (it gives a new one whenever it draws: a hover, a zoom, a pan, a resize, people moving, a setting) and kept between
 * frames: the strands, their fade and every halo that does not swell, drawn on a canvas of the stage's size; the
 * strands as paths, for the chromatic split, which shifts each frame; and the holes under the markers, as a path.
 */
export interface StillWeb {
  scene: WebScene | null;
  dpr: number;
  canvas: HTMLCanvasElement | null;
  strands: Strands | null;
  holes: Path2D | null;
  /** How many times it has been made: for the tests, which check it is made again only when it must be. */
  made: number;
}

export function newStillWeb(): StillWeb {
  return { scene: null, dpr: 0, canvas: null, strands: null, holes: null, made: 0 };
}

/** The still web for `scene` at `dpr` device pixels a CSS pixel: as kept, or made again on a new scene. */
function stillWeb(still: StillWeb, scene: WebScene, ink: Ink, now: number, dpr: number): StillWeb & { canvas: HTMLCanvasElement; strands: Strands; holes: Path2D } {
  if (still.scene !== scene || still.dpr !== dpr || !still.canvas || !still.strands || !still.holes) {
    const canvas = still.canvas ?? document.createElement("canvas");
    const [w, h] = [Math.round(scene.width * dpr), Math.round(scene.height * dpr)];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const strands = strandsOf(scene);
    const layer = canvas.getContext("2d");
    if (layer) {
      layer.setTransform(dpr, 0, 0, dpr, 0, 0);
      layer.clearRect(0, 0, scene.width, scene.height);
      layer.translate(scene.sun.x, scene.sun.y);
      layer.lineCap = "round";
      layer.lineJoin = "round";
      mainStrands(layer, strands, ink, scene.webStrength);
      edgeFade(layer, scene, ink);
      halos(layer, scene, ink, now, Infinity, "still");
    }
    Object.assign(still, { scene, dpr, canvas, strands, holes: holesOf(scene), made: still.made + 1 });
  }
  return still as StillWeb & { canvas: HTMLCanvasElement; strands: Strands; holes: Path2D };
}

/**
 * The Spider web, drawn: see the file's head. `dpr` is how many device pixels the canvas has to a CSS pixel, which the
 * still web is drawn at. While the Spider web boots, everything is drawn afresh each frame; once it has booted, what
 * holds still is drawn once for each scene (stillWeb) and copied in, and the rest is drawn each frame: the ground under
 * it all, whose scanlines drift (a few fills of the whole stage), the chromatic split, any halo that swells, the spider
 * and, over it, the holes and the fade under the header.
 */
export function drawWeb(ctx: Ctx, scene: WebScene, motion: WebMotion, now: number, state: LookState, dpr = 1): void {
  const { width, height, sun, k } = scene;
  const ink = webTheme(scene.colour).ink;
  const t = motion.bootStart === null ? Infinity : now - motion.bootStart;
  const booted = t >= BOOT_MS;
  const random = flicker(now, 50);

  // The ground: a fine grid, scanlines drifting down, a haze, and the boot's flicker.
  ctx.fillStyle = ink.background;
  ctx.fillRect(0, 0, width, height);
  const grid = pattern(ctx, state, `grid-${ink.grid}`, 40, (c) => {
    c.strokeStyle = ink.grid;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0.5, 0);
    c.lineTo(0.5, 40);
    c.moveTo(0, 0.5);
    c.lineTo(40, 0.5);
    c.stroke();
  });
  if (grid) {
    ctx.fillStyle = grid;
    ctx.fillRect(0, 0, width, height);
  }
  const scanlines = pattern(ctx, state, "scanlines", 3, (c) => {
    c.fillStyle = "rgba(0, 0, 0, 0.22)";
    c.fillRect(0, 0, 3, 1);
  });
  if (scanlines) {
    ctx.save();
    ctx.translate(0, scene.reduced ? 0 : (now / 40) % 3);
    ctx.fillStyle = scanlines;
    ctx.fillRect(0, -3, width, height + 3);
    ctx.restore();
  }
  const haze = ctx.createRadialGradient(sun.x, sun.y, Math.min(width, height) * 0.25, sun.x, sun.y, Math.max(width, height) * 0.8);
  haze.addColorStop(0, ink.haze[0]);
  haze.addColorStop(1, ink.haze[1]);
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, width, height);
  if (!booted && t < 220 && Math.floor(t / 40) % 2 === 0) {
    ctx.fillStyle = rgba(ink.beam, 0.06);
    ctx.fillRect(0, 0, width, height);
  }

  // The scan: on boot, once, a line from the top of the stage to the bottom that the web materialises behind.
  const scanShare = booted ? 1 : clamp01((t - SCAN.from) / SCAN.length);
  const scanY = -sun.y + height * scanShare;

  ctx.save();
  ctx.translate(sun.x, sun.y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // The web: a chromatic split under it (wide while it boots), then the strands, fading toward the edges, and the halos.
  const split = booted ? (scene.reduced ? 0 : 0.6 + 0.4 * Math.sin(now / 900)) : 3 + 6 * random();
  let holes: Path2D | null = null;
  if (booted) {
    // Booted: the strands, their fade and the halos that hold still are copied in as drawn for this scene.
    const still = stillWeb(state.still, scene, ink, now, dpr);
    splitStrands(ctx, still.strands, ink, scene.webStrength, split);
    // (A canvas with no width or height, a stage not yet measured, cannot be drawn in.)
    if (still.canvas.width > 0 && still.canvas.height > 0) ctx.drawImage(still.canvas, -sun.x, -sun.y, width, height);
    halos(ctx, scene, ink, now, t, "swelling");
    holes = still.holes;
  } else {
    // Booting: the web as far as the scan has reached.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-sun.x, -sun.y, width, Math.max(0, scanY + sun.y));
    ctx.clip();
    const strands = strandsOf(scene);
    splitStrands(ctx, strands, ink, scene.webStrength, split);
    mainStrands(ctx, strands, ink, scene.webStrength);
    edgeFade(ctx, scene, ink);
    ctx.restore();
    // The scan line, with static under it.
    if (scanShare > 0 && scanShare < 1) {
      glowStroke(ctx, strandPath({ x: -sun.x, y: scanY }, { x: width - sun.x, y: scanY }), ink.scan, 1.2, 10, 0.9, 0.35);
      for (let i = 0; i < 12; i++) {
        const y = scanY + 2 + random() * 24;
        const x = -sun.x + random() * width;
        glowStroke(ctx, strandPath({ x, y }, { x: x + 10 + random() * 60, y }), ink.scan, 1, 0, 0.5 * random());
      }
    }
    halos(ctx, scene, ink, now, t, "all");
  }
  // The hold on whoever is selected, and the beam to and reticle on whoever is hovered, moved on (webHold.ts), and whoever is looked at:
  // selected, else hovered.
  const onMap = (id: number | null) => (id !== null && spot(scene, id) ? id : null);
  const looks = { hoverId: onMap(scene.hoverId), heldId: onMap(scene.heldId) };
  const gone = stepHold(state.hold, now, { ...looks, reduced: scene.reduced });
  const looked = lookedAt(looks);
  const focus = looked === null ? null : spot(scene, looked);
  // The spider at the hub, fading in as the Spider web boots: a small body on legs standing wide, a little past the closest orbit, unzoomed,
  // and growing with the zoom, slower than the people spread, so it can be looked at closely and never reaches them.
  const size = scene.inner * 0.7;
  const grow = spiderGrowth(k);
  const spider = spiderPose(scene, now, state, size, focus, looks.heldId !== null);
  const spiderInk: SpiderInk = { line: ink.strand, accent: ink.accent, beam: ink.beam, eye: ink.eye, dark: ink.dark };
  ctx.save();
  ctx.scale(grow, grow);
  ctx.globalAlpha = booted ? 1 : clamp01((t - 200) / 500);
  drawSpider(ctx, spider.rig, size, spider.eyes, spiderInk, now, { reduced: scene.reduced, px: grow, shadow: scene.shadow });
  ctx.restore();
  // The hold comes from the spider's mouth, the hover's beam from its eyes.
  const from = (on: BeamFrom) => {
    const at = beamOrigin(spider.rig, size, on);
    return { x: at.x * grow, y: at.y * grow };
  };
  state.origin = { mouth: from("mouth"), eyes: from("eyes") };
  letGo(scene, state, now, gone);
  // A hole of the ground's colour under every marker, over the spider too (holesOf).
  ctx.fillStyle = ink.background;
  ctx.fill(holes ?? holesOf(scene));
  ctx.restore();
  headerFade(ctx, scene, ink.background);
}

/**
 * What is drawn over the SVG, above everything (drawWeb must have drawn this
 * frame first): the beam to whoever is hovered, from the eyes, and the
 * reticle on them, then over them the hold on whoever is selected, from the
 * mouth; and beams breaking up, reticles springing off and holds reeling in
 * once let go of.
 */
export function drawWebOver(ctx: Ctx, scene: WebScene, now: number, state: LookState): void {
  ctx.clearRect(0, 0, scene.width, scene.height);
  const ink = webTheme(scene.colour).ink;
  const random = flicker(now, 50);
  const beam = state.hold.beam;
  ctx.save();
  ctx.translate(scene.sun.x, scene.sun.y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const beamAt = beam && spot(scene, beam.id);
  hoverBeam(ctx, scene, ink, state, now, beamAt && lineEnd(scene, beam.id, beamAt, state.origin.eyes), state.origin.eyes, random);
  hoverReticle(ctx, scene, ink, state, now);
  holdLine(ctx, scene, ink, state, now, state.origin.mouth, random);
  ctx.restore();
}
