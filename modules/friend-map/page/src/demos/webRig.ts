// The spider's rig (webSpider.ts draws it): how the spider at the Spider web's hub
// moves as one creature with parts of its own. The head looks toward whoever
// is looked at almost at once, within the range it can turn on its neck;
// someone merely hovered within 45° either side of where the body faces (a
// cone of 90° in front, CONE) it looks at with its head alone, and a target
// beyond that cone, or anyone selected, the head looks at first, then the
// chassis follows, slower, until it faces them (the body follows a free
// cursor only once it has been held out of the head's reach a while); the abdomen
// trails the chassis on a spring, overshooting a little. Each of the eight
// legs keeps a foothold on the web: as the chassis turns, a leg whose
// foothold has drifted from where it will rest once the turn is done (its
// footholds are planned from where the body is going, not where it is, so the
// legs set off with the turn rather than after it) steps toward it, lifting,
// swinging a stride at most round the hub, so its foot keeps the stance's
// width through the turn, a little outward at the middle, and planting with
// a soft settle, a leg already folded in stepping before any other; the
// chassis turns no faster than its legs can carry it round; steps start a
// few dozen milliseconds apart, several legs in the air at once, but never a
// leg beside, or across from, one already in the air, so the body is always
// borne, and the planted legs flex as the body turns over them; the body
// leans a little away from whichever legs are in the air (sway). At rest, now and then, never on a loop, it does something
// of its own (startIdle): a leg shifts its weight, a leg lifts and plucks
// the web twice, a front leg folds up beside the face (a groom), the head
// looks round and back, the body settles into a crouch and rises, or the
// abdomen flexes. A leg is a real spider's, in three dimensions: a coxa at the
// body, then the femur up to a knee high above the web, the patella, the
// tibia down, the metatarsus and the tarsus to the foot. Where it bends is
// solved from its hip and its foothold (legPose, two bones twice: the femur
// against the shin, then the tibia against the metatarsus and tarsus) in a
// plane that leans back from the vertical, more as the leg folds, so from
// above the femurs fan out round the body like a star, the knees well
// outside it, and each leg arches from its knee down to its foot as a
// spider's does, and turns because its foot stays put, never as a rotated
// picture;
// each leg stands and bends a little unlike its opposite and its neighbours
// (QUIRKS), so the pose is never mirror-perfect, and always the same; and
// each leg may stand anywhere within a range of its own round that rest, a
// few degrees round its hip and a little in or out (FREEDOM, wider on the
// front pair than the rear): at each turn every leg picks a new place within
// it, at random, and steps there, so the stance after a turn is never the
// one before it, and at rest, now and then, one leg at a time (never beside
// or across from one in the air) drifts a little within it, lifting barely
// off the web (drift). A
// stepping foot lifts off the web. Every
// joint keeps its height, for the shadows and the shading. Under reduced
// motion every part goes straight to where it is headed. Pure, with angles
// in screen radians, so it can be tested.

import { easeCubicInOut, easeCubicOut } from "d3";
import type { XY } from "./webDraw.ts";

export interface XYZ {
  x: number;
  y: number;
  /** Height above the web, in the same pixels. */
  z: number;
}

/** How far the head turns on its neck, either way, in radians (about 65°). */
export const HEAD_RANGE = 1.15;
/** How fast the head turns: most of the way in this many ms. */
export const HEAD_TAU = 45;
/** How fast the chassis turns, and the fastest it turns, radians a second (no faster than its legs carry it round, so they are never left folded behind it); how long after the head has looked it sets off, how far someone selected must be off before it bothers, and how near before it stops. */
export const CHASSIS_TAU = 420;
export const CHASSIS_RATE = 2.6;
export const CHASSIS_DELAY = 180;
export const CHASSIS_DEAD = 0.3;
export const CHASSIS_STOP = 0.06;
/** How far either side of where the chassis faces a target not selected (someone hovered) may be and be looked at by the head alone, radians: 45°, a cone of 90° in front; beyond it the chassis turns to face them. */
export const CONE = Math.PI / 4;
/** How long a free cursor must sit beyond the head's reach before the body follows it, ms. */
export const FOLLOW_AFTER = 600;
/** The abdomen's spring: stiffness, per s², and its damping. */
const ABDOMEN_K = 90;
const ABDOMEN_C = 2 * Math.sqrt(ABDOMEN_K) * 0.55;
/** A foothold this far from where the leg will rest, as a share of the body's length, makes the leg step. */
export const STEP_TRIGGER = 0.14;
/** How long a step takes, ms; the longest stride, round the hub, as a share of the body's length; and how far past its mark a step reaches before settling. */
export const STEP_MS = 210;
export const STRIDE = 1.5;
export const OVERSHOOT = 0.06;
/** A leg whose foot has come this much nearer its hip than it stands at rest (a share of that) is folded, and steps before any other. */
export const FOLD_LIMIT = 0.1;
/** The least time between one step's start and the next's, and a landed leg's rest before it steps again, ms. */
export const STEP_SPACING = 40;
export const REFRACTORY = 90;
/**
 * A leg's segments as shares of the length `s` the rig is built on (the body
 * itself is drawn smaller than that, BODY of it), from the body out: the
 * coxa, the femur up to the knee, the patella (the knee cap), the tibia, the
 * metatarsus and the tarsus to the foot.
 */
export const COXA = 0.12;
export const FEMUR = 0.8;
export const PATELLA = 0.16;
export const TIBIA = 0.7;
export const METATARSUS = 0.52;
export const TARSUS = 0.26;
/** How big the body is drawn, as a share of the length the rig is built on: small, on long legs. */
export const BODY = 0.72;
/** How high the hips stand above the web, and how high a stepping foot lifts at the top of its stride, shares of `s`. */
export const BODY_HEIGHT = 0.3;
export const STEP_HEIGHT = 0.28;
/**
 * How far a leg's plane leans from the vertical, radians: straight-legged, and
 * more as the leg folds; and which way each pair leans, forward (+) or back
 * (−), and how much. Every pair leans back, so from above the front three
 * pairs' knees stand out behind the line from hip to foot (the femurs fanned
 * out round the body, the legs swinging forward from the knee to the foot),
 * and the rear pair, leaning almost along its own line, stands nearly straight.
 */
export const LEAN = 0.5;
export const LEAN_FOLD = 0.6;
export const LEG_LEAN: readonly number[] = [-0.7, -0.7, -0.6, -0.3];
/** The shin's chord against its length when the leg is straight, and how much shorter it gets as the leg folds (the ankle bends). */
const SHIN_CHORD = 0.975;
const SHIN_FOLD = 0.2;
/** The body's sway: how far it leans from a leg in the air, a share of `s`; and the lean's time, ms. */
export const SWAY = 0.045;
const SWAY_TAU = 140;
/** How far out a stepping foot swings at the middle of its stride, share of `s`. */
export const SWING = 0.1;
/** The least rest between one idle act and the next, and how much more at random, ms. */
export const IDLE_REST = 1800;
export const IDLE_SPREAD = 4800;
/** How far the body dips in a settle, as a share of its height; and how fast the body dips and rises, and the head looks round, ms. */
export const CROUCH = 0.4;
const CROUCH_TAU = 170;
const GAZE_TAU = 220;
/** How long a look round goes on easing the head home after its turn is over, ms. */
const LOOK_TAIL = 500;
/**
 * How far each pair of legs, front to back, may stand from its rest of its
 * own: degrees round its hip either way, and a share of its reach in or out
 * either way. The front pair, feelers as much as legs, roams widest; the
 * rear pair, which bears the body, least. Never so far that a leg crosses its
 * neighbour's line or stands straight.
 */
export const FREEDOM: ReadonlyArray<{ turn: number; reach: number }> = [
  { turn: 8, reach: 0.05 },
  { turn: 7, reach: 0.04 },
  { turn: 6, reach: 0.04 },
  { turn: 5, reach: 0.04 },
];
/** A drift at rest: the least wait between one and the next (any leg), and how much more at random, ms; how far a leg drifts at most, a share of its freedom either way (where -1 to 1 spans it); how long a drift takes, ms, and how much more at random; and how high it lifts against a plain step. */
export const DRIFT_REST = 1200;
export const DRIFT_SPREAD = 3600;
export const DRIFT_SHARE = 0.4;
export const DRIFT_MS = 480;
const DRIFT_MS_SPREAD = 220;
export const DRIFT_LIFT = 0.3;
/** Where a front leg grooms: beside the face, in the body's frame (shares of `s`, forward -y). */
const GROOM_AT: XY = { x: 0.3, y: -0.66 };

/**
 * The legs, front to back: where each hip sits on the chassis (x to the side,
 * y along the body) and where its foot rests (all in shares of `s`, forward
 * -y). A star, as a spider stands seen from above: the feet fanned round the
 * body, each about as far from the hub, the front pair reaching forward, 26°
 * either side of ahead, the second 35° forward of sideways, the third just
 * behind sideways and the rear pair back, 44° either side of behind; each
 * about seven tenths of the leg's reach from its hip, so the legs stand
 * spread with a bend to spare.
 */
export const LEGS: ReadonlyArray<{ hip: XY; rest: XY }> = [
  { hip: { x: 0.13, y: -0.27 }, rest: { x: 0.88, y: -1.8 } },
  { hip: { x: 0.135, y: -0.21 }, rest: { x: 1.64, y: -1.15 } },
  { hip: { x: 0.135, y: -0.15 }, rest: { x: 1.95, y: 0.1 } },
  { hip: { x: 0.13, y: -0.09 }, rest: { x: 1.31, y: 1.35 } },
];

/** A leg's own character: how far its rest is turned round its hip (degrees, either way), how far out it stands against its pair's, and how much its plane leans against the pair's. */
export interface Quirk {
  turn: number;
  reach: number;
  lean: number;
}

/**
 * Each leg's own character, left side then right, front to back, so the
 * stance is never mirror-perfect: every leg stands and bends a little unlike
 * its opposite and its neighbours, as a living spider's do. Chosen once, by
 * hand, and small (a few degrees, a few hundredths), so the pose reads as
 * natural, never broken, and holds still.
 */
export const QUIRKS: Readonly<Record<-1 | 1, ReadonlyArray<Quirk>>> = {
  [-1]: [{ turn: 3, reach: 1.03, lean: 1.1 }, { turn: -2, reach: 0.97, lean: 0.9 }, { turn: 2.5, reach: 1.02, lean: 1.05 }, { turn: -3.5, reach: 0.98, lean: 0.93 }],
  [1]: [{ turn: -2, reach: 0.98, lean: 0.95 }, { turn: 3.5, reach: 1.02, lean: 1.08 }, { turn: -1.5, reach: 0.97, lean: 0.88 }, { turn: 2, reach: 1.04, lean: 1.13 }],
};

/** Where a leg stands within its freedom (FREEDOM): its turn round its hip and its reach in or out, each -1 to 1 across the range, 0 at its rest. */
export interface Placement {
  turn: number;
  reach: number;
}

/** A leg at its rest, the middle of its freedom. */
export const CENTRE: Placement = { turn: 0, reach: 0 };

export interface Step {
  from: XY;
  to: XY;
  start: number;
  length: number;
  /** How high it lifts against a plain step (1). */
  lift?: number;
  /** A step to take as soon as this one lands. */
  then?: { to: XY; length: number; lift: number } | null;
}

/** What the spider does of its own at rest, now and then: a leg shifts its weight, a leg plucks the web, a front leg grooms beside the face, the head looks round, the body settles, the abdomen flexes. */
export type IdleKind = "shift" | "pluck" | "groom" | "look" | "settle" | "flex";

export interface IdleAct {
  kind: IdleKind;
  start: number;
  length: number;
  /** The leg it uses, if any. */
  leg: Leg | null;
  /** Which way: a look's turn from the chassis, radians. */
  dir: number;
}

export interface Leg {
  side: -1 | 1;
  index: number;
  /** Where its foot grips the web, in pixels from the hub. */
  foot: XY;
  step: Step | null;
  /** When it last planted. */
  landedAt: number;
  /** Where it stands within its freedom. */
  placement: Placement;
}

export interface Rig {
  /** Where the head, the chassis and the abdomen face, radians. */
  head: number;
  chassis: number;
  abdomen: number;
  abdomenVel: number;
  /** Whether the chassis is on its way to a target (it keeps going until it is near, once it starts), and when it sets off. */
  turning: boolean;
  followAt: number | null;
  /** Since when a free cursor has been beyond the head's reach, or null. */
  strainedSince: number | null;
  legs: Leg[];
  /** When a step last began. */
  lastStepAt: number;
  /** What it is doing of its own at rest, and when it next does something. */
  idle: IdleAct | null;
  idleAt: number;
  /** When a leg next drifts within its freedom, at rest. */
  driftAt: number;
  /** How far the body is dipped, 0 standing to 1 settled. */
  crouch: number;
  /** How far the body has leaned from the hub, in pixels: away from the legs in the air. */
  sway: XY;
}

export interface RigInput {
  /** Where the head should look: the cursor, or whoever is hovered; null to hold. */
  look: number | null;
  /** Where the body should face: whoever is selected or hovered; null for nobody. */
  target: number | null;
  /** Whether the target is someone selected, whom the body turns to face wherever they are; any other target turns it only from beyond CONE. */
  held?: boolean;
  reduced: boolean;
  random: () => number;
}

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** An angle difference brought into (-π, π]. */
export function wrapAngle(a: number): number {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** A spot in the body's frame (forward -y, body lengths), on the web: turned to `heading` and scaled by `s`. */
export function bodyToWeb(p: XY, heading: number, s: number): XY {
  const a = heading + Math.PI / 2;
  return { x: (p.x * Math.cos(a) - p.y * Math.sin(a)) * s, y: (p.x * Math.sin(a) + p.y * Math.cos(a)) * s };
}

/** Where leg `index` on `side` rests, in the body's frame, as its own quirk turns and sets it and where it stands within its freedom (`placement`). */
export function restOf(side: -1 | 1, index: number, placement: Placement = CENTRE): XY {
  const { hip, rest } = LEGS[index];
  const quirk = QUIRKS[side][index];
  const free = FREEDOM[index];
  const a = ((quirk.turn + placement.turn * free.turn) * Math.PI) / 180;
  const vx = (rest.x - hip.x) * quirk.reach * (1 + placement.reach * free.reach);
  const vy = (rest.y - hip.y) * quirk.reach * (1 + placement.reach * free.reach);
  const x = hip.x + vx * Math.cos(a) - vy * Math.sin(a);
  const y = hip.y + vx * Math.sin(a) + vy * Math.cos(a);
  return { x: side * x, y };
}

/** How far leg `index` on `side` stands from its hip at rest, where it stands within its freedom, in shares of `s`. */
export function standOf(side: -1 | 1, index: number, placement: Placement = CENTRE): number {
  const { hip } = LEGS[index];
  const rest = restOf(side, index, placement);
  return Math.hypot(rest.x - side * hip.x, rest.y - hip.y);
}

/**
 * A point `t` of the way from `a` to `b` round the hub: its angle the
 * shortest way round, its distance straight, so a foot stepping through a
 * turn keeps its stance's width instead of cutting across toward the body.
 */
export function roundLerp(a: XY, b: XY, t: number): XY {
  const ra = Math.hypot(a.x, a.y);
  const rb = Math.hypot(b.x, b.y);
  const from = Math.atan2(a.y, a.x);
  const angle = from + wrapAngle(Math.atan2(b.y, b.x) - from) * t;
  const r = ra + (rb - ra) * t;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

/** How far it is from `a` to `b` round the hub: along the arc between their angles at their mean distance, and in or out. */
export function roundDistance(a: XY, b: XY): number {
  const ra = Math.hypot(a.x, a.y);
  const rb = Math.hypot(b.x, b.y);
  return Math.abs(wrapAngle(Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x))) * ((ra + rb) / 2) + Math.abs(rb - ra);
}

/** A new place for a leg anywhere within its freedom, at random: where it stands after a turn. */
export function placeAnew(random: () => number): Placement {
  return { turn: random() * 2 - 1, reach: random() * 2 - 1 };
}

/** A place a little from `from`, at random, DRIFT_SHARE at most either way and never past its freedom's edge: where a leg drifts at rest. */
export function drift(from: Placement, random: () => number): Placement {
  const near = (v: number) => {
    const low = Math.max(-1, v - DRIFT_SHARE);
    const high = Math.min(1, v + DRIFT_SHARE);
    return low + random() * (high - low);
  };
  return { turn: near(from.turn), reach: near(from.reach) };
}

/** A rig facing `heading`, every leg planted at rest (the middle of its freedom), for a body `s` pixels long. */
export function newRig(heading: number, now: number, s: number): Rig {
  const legs: Leg[] = [];
  for (const side of [-1, 1] as const) {
    for (let index = 0; index < 4; index++) legs.push({ side, index, foot: bodyToWeb(restOf(side, index), heading, s), step: null, landedAt: now, placement: CENTRE });
  }
  return {
    head: heading, chassis: heading, abdomen: heading, abdomenVel: 0, turning: false, followAt: null, strainedSince: null, legs, lastStepAt: -1e9,
    idle: null, idleAt: now + 2500, driftAt: now + 2500 + DRIFT_REST, crouch: 0, sway: { x: 0, y: 0 },
  };
}

/** Where a leg's foot should rest on the web, where it stands within its freedom, for a body facing `heading` (the chassis's own heading unless said), in pixels from the hub. */
export function legRest(rig: Rig, leg: Leg, s: number, heading = rig.chassis): XY {
  return bodyToWeb(restOf(leg.side, leg.index, leg.placement), heading, s);
}

/** How far through its stride a stepping foot is, 0 to 1: eased, reaching a little past its mark, then settling onto it. */
export function stepShare(p: number): number {
  if (p >= 1) return 1;
  if (p < 0.8) return easeCubicInOut(p / 0.8) * (1 + OVERSHOOT);
  return 1 + OVERSHOOT * (1 - easeCubicOut((p - 0.8) / 0.2));
}

/** How far a stepping leg is lifted through its stride, 0 to 1: quickly up, and down softly to plant. */
export function stepLift(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return Math.sin(Math.PI * Math.pow(p, 0.85));
}

/** How far a look round has turned, 0 to 1 and back, through `p` of its act: out, a hold, and back. */
export function lookShare(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.3) return easeCubicInOut(p / 0.3);
  if (p < 0.7) return 1;
  return 1 - easeCubicInOut((p - 0.7) / 0.3);
}

/** How far a settle has dipped, 0 to 1 and back, through `p` of its act: down, a hold, and up. */
export function crouchShare(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.35) return easeCubicInOut(p / 0.35);
  if (p < 0.6) return 1;
  return 1 - easeCubicInOut((p - 0.6) / 0.4);
}

/** Which idle act comes next, by a roll: mostly a shift of weight or a pluck, else a look round, a groom, a settle or a flex. */
export function pickIdle(roll: number): IdleKind {
  if (roll < 0.3) return "pluck";
  if (roll < 0.6) return "shift";
  if (roll < 0.72) return "groom";
  if (roll < 0.9) return "look";
  if (roll < 0.96) return "settle";
  return "flex";
}

/**
 * Starts an idle act of `kind` at `now`: a shift steps one leg a little
 * round its rest; a pluck lifts one leg high, sets it down beside its
 * foothold and steps it back; a groom folds a front leg up beside the face
 * and back to its rest; a look turns the head aside (dir) and back over a
 * second or two, then eases it home a while longer (LOOK_TAIL); a settle
 * dips the body and raises it; a flex pushes the
 * abdomen so it wags on its spring.
 */
export function startIdle(rig: Rig, kind: IdleKind, now: number, s: number, random: () => number): IdleAct {
  const act: IdleAct = { kind, start: now, length: 300, leg: null, dir: 0 };
  const any = rig.legs[Math.floor(random() * rig.legs.length)];
  switch (kind) {
    case "shift": {
      const rest = legRest(rig, any, s);
      const a = random() * Math.PI * 2;
      any.step = { from: any.foot, to: { x: rest.x + Math.cos(a) * 0.04 * s, y: rest.y + Math.sin(a) * 0.04 * s }, start: now, length: STEP_MS + 80 };
      act.leg = any;
      act.length = STEP_MS + 80;
      break;
    }
    case "pluck": {
      const a = random() * Math.PI * 2;
      any.step = {
        from: any.foot, to: { x: any.foot.x + Math.cos(a) * 0.02 * s, y: any.foot.y + Math.sin(a) * 0.02 * s }, start: now, length: 240, lift: 1.5,
        then: { to: legRest(rig, any, s), length: 260, lift: 1.2 },
      };
      act.leg = any;
      act.length = 520;
      break;
    }
    case "groom": {
      const side = random() < 0.5 ? -1 : 1;
      const front = rig.legs.find((leg) => leg.side === side && leg.index === 0)!;
      const at = bodyToWeb({ x: side * GROOM_AT.x, y: GROOM_AT.y }, rig.chassis, s);
      front.step = { from: front.foot, to: at, start: now, length: 380, lift: 1.6, then: { to: legRest(rig, front, s), length: 420, lift: 1.3 } };
      act.leg = front;
      act.length = 820;
      break;
    }
    case "look":
      act.dir = (random() < 0.5 ? -1 : 1) * (0.35 + random() * 0.5);
      act.length = 1600 + random() * 1000 + LOOK_TAIL;
      break;
    case "settle":
      act.length = 1800;
      break;
    case "flex":
      rig.abdomenVel += (random() < 0.5 ? -1 : 1) * 2.2;
      act.length = 300;
      break;
  }
  if (act.leg) rig.lastStepAt = now;
  rig.idle = act;
  return act;
}

/** Whether two legs are neighbours: beside each other on one side, or across from each other. */
export function neighbours(a: Leg, b: Leg): boolean {
  return (a.side === b.side && Math.abs(a.index - b.index) === 1) || (a.side !== b.side && a.index === b.index);
}

/** Moves every part of the rig on by `dt` ms to `now`. */
export function updateRig(rig: Rig, now: number, dt: number, s: number, input: RigInput): void {
  const { look, target, reduced, random } = input;
  const step = Math.min(64, Math.max(1, dt));
  // The chassis: follows a target once it is off the chassis's line, beyond the cone in front (CONE) unless they are
  // selected, setting off a moment after the head has looked (that moment counted afresh whenever the target comes
  // back within), and keeps going until it is near; a free cursor held beyond the head's reach for a while is followed too.
  const dead = input.held ? CHASSIS_DEAD : CONE;
  let follow = target;
  if (follow === null && look !== null && Math.abs(wrapAngle(look - rig.chassis)) > HEAD_RANGE) {
    rig.strainedSince ??= now;
    if (now - rig.strainedSince >= FOLLOW_AFTER) follow = look;
  } else rig.strainedSince = null;
  if (follow !== null) {
    const off = wrapAngle(follow - rig.chassis);
    if (!rig.turning && Math.abs(off) > dead) {
      rig.followAt ??= now + (reduced ? 0 : CHASSIS_DELAY);
      if (now >= rig.followAt) {
        rig.turning = true;
        // A turn: every leg picks a new place within its freedom, which its steps through the turn head for, so the
        // stance it ends in is never the one it began in; under reduced motion each keeps its own.
        if (!reduced) for (const leg of rig.legs) leg.placement = placeAnew(random);
      }
    } else rig.followAt = null;
    if (rig.turning) {
      if (reduced) rig.chassis = follow;
      else {
        const most = (CHASSIS_RATE * step) / 1000;
        rig.chassis += Math.max(-most, Math.min(most, off * (1 - Math.exp(-step / CHASSIS_TAU))));
      }
      if (Math.abs(wrapAngle(follow - rig.chassis)) < CHASSIS_STOP) {
        rig.turning = false;
        rig.followAt = null;
      }
    }
  } else {
    rig.turning = false;
    rig.followAt = null;
  }
  // The head: toward where it should look, as far as its neck allows, and within its range as the chassis comes round
  // under it; at once under reduced motion.
  if (look !== null) {
    const wanted = rig.chassis + Math.max(-HEAD_RANGE, Math.min(HEAD_RANGE, wrapAngle(look - rig.chassis)));
    rig.head = reduced ? wanted : rig.head + wrapAngle(wanted - rig.head) * (1 - Math.exp(-step / HEAD_TAU));
  } else if (rig.idle?.kind === "look" && !reduced) {
    // Looking round of its own: aside and back, slower than a look at someone.
    const wanted = rig.chassis + rig.idle.dir * lookShare((now - rig.idle.start) / (rig.idle.length - LOOK_TAIL));
    rig.head += wrapAngle(wanted - rig.head) * (1 - Math.exp(-step / GAZE_TAU));
  }
  rig.head = rig.chassis + Math.max(-HEAD_RANGE, Math.min(HEAD_RANGE, wrapAngle(rig.head - rig.chassis)));
  // The abdomen: a spring behind the chassis.
  if (reduced) {
    rig.abdomen = rig.chassis;
    rig.abdomenVel = 0;
  } else {
    const seconds = step / 1000;
    const pull = wrapAngle(rig.chassis - rig.abdomen);
    rig.abdomenVel += (ABDOMEN_K * pull - ABDOMEN_C * rig.abdomenVel) * seconds;
    rig.abdomen += rig.abdomenVel * seconds;
  }
  // The legs. Steps under way move on, and land. Then, where the body is going (its destination while it turns, else
  // where it faces) each leg's foothold is planned, and of the planted legs strained from theirs, with no neighbour in
  // the air, rested since landing, the most strained steps, a stride at most, toward it: one new step a frame, and
  // none within STEP_SPACING of the last, so the steps stagger through the turn rather than wait for its end.
  const going = follow !== null && (rig.turning || Math.abs(wrapAngle(follow - rig.chassis)) > dead) ? follow : rig.chassis;
  let idle = target === null;
  for (const leg of rig.legs) {
    if (!leg.step) continue;
    idle = false;
    const p = (now - leg.step.start) / leg.step.length;
    if (p >= 1) {
      leg.foot = leg.step.to;
      const then = leg.step.then;
      leg.step = then ? { from: leg.foot, to: then.to, start: now, length: then.length, lift: then.lift } : null;
      leg.landedAt = now;
    } else leg.foot = roundLerp(leg.step.from, leg.step.to, stepShare(p));
  }
  // Of the legs that may step, the most pressed: a folded leg (its foot drawn in toward its hip as the body turned over
  // it) before any, then the most strained.
  let next: { leg: Leg; rest: XY; press: number } | null = null;
  for (const leg of rig.legs) {
    if (leg.step) continue;
    const rest = legRest(rig, leg, s, going);
    const strain = Math.hypot(rest.x - leg.foot.x, rest.y - leg.foot.y);
    if (strain < STEP_TRIGGER * s) continue;
    if (reduced) {
      leg.foot = rest;
      continue;
    }
    if (now - leg.landedAt < REFRACTORY || rig.legs.some((other) => other.step && neighbours(leg, other))) continue;
    const folded = Math.max(0, 1 - Math.hypot(leg.foot.x - rig.sway.x - legHip(rig, leg, s).x, leg.foot.y - rig.sway.y - legHip(rig, leg, s).y) / (standOf(leg.side, leg.index, leg.placement) * s));
    const press = strain + (folded > FOLD_LIMIT ? 10 * s : 0) + folded * s;
    if (!next || press > next.press) next = { leg, rest, press };
  }
  if (next && now - rig.lastStepAt >= STEP_SPACING) {
    const { leg, rest } = next;
    // A stride at most, round the hub, so the foot keeps its stance's width through the turn.
    const reach = Math.min(1, (STRIDE * s) / (roundDistance(leg.foot, rest) || 1e-6));
    leg.step = { from: leg.foot, to: roundLerp(leg.foot, rest, reach), start: now, length: STEP_MS + random() * 60 };
    rig.lastStepAt = now;
    idle = false;
  }
  // At rest, now and then, something of its own (startIdle), the wait to the next drawn at random so it never loops;
  // nothing of it under reduced motion, and nothing while someone is looked at.
  if (rig.idle && (now >= rig.idle.start + rig.idle.length || reduced)) {
    rig.idle = null;
    rig.idleAt = now + IDLE_REST + random() * IDLE_SPREAD;
  }
  if (idle && !reduced && !rig.idle && now >= rig.idleAt) startIdle(rig, pickIdle(random()), now, s, random);
  // At rest, now and then, a leg drifts a little within its freedom (drift), lifting barely off the web: one at a time,
  // any leg that has rested since it landed with no neighbour in the air, alongside whatever it is doing of its own;
  // nothing of it while it turns or someone is looked at, nor under reduced motion.
  const calm = target === null && !reduced && !rig.turning && going === rig.chassis;
  if (calm && now >= rig.driftAt && now - rig.lastStepAt >= STEP_SPACING) {
    const free = rig.legs.filter((leg) => !leg.step && now - leg.landedAt >= REFRACTORY && !rig.legs.some((other) => other.step && neighbours(leg, other)));
    if (free.length > 0) {
      const leg = free[Math.floor(random() * free.length)];
      leg.placement = drift(leg.placement, random);
      leg.step = { from: leg.foot, to: legRest(rig, leg, s), start: now, length: DRIFT_MS + random() * DRIFT_MS_SPREAD, lift: DRIFT_LIFT };
      rig.lastStepAt = now;
      rig.driftAt = now + DRIFT_REST + random() * DRIFT_SPREAD;
    }
  }
  // The crouch: a settle's dip, and back up; still under reduced motion.
  const wantCrouch = !reduced && rig.idle?.kind === "settle" ? crouchShare((now - rig.idle.start) / rig.idle.length) : 0;
  rig.crouch = reduced ? 0 : rig.crouch + (wantCrouch - rig.crouch) * (1 - Math.exp(-step / CROUCH_TAU));
  // The body's weight: it leans a little away from the legs in the air; still under reduced motion.
  if (reduced) {
    rig.sway = { x: 0, y: 0 };
  } else {
    let wx = 0;
    let wy = 0;
    let inAir = 0;
    for (const leg of rig.legs) {
      if (!leg.step) continue;
      const d = Math.hypot(leg.foot.x, leg.foot.y) || 1;
      wx -= leg.foot.x / d;
      wy -= leg.foot.y / d;
      inAir++;
    }
    const wantX = (inAir ? (wx / inAir) * SWAY : 0) * s;
    const wantY = (inAir ? (wy / inAir) * SWAY : 0) * s;
    const g = 1 - Math.exp(-step / SWAY_TAU);
    rig.sway = { x: rig.sway.x + (wantX - rig.sway.x) * g, y: rig.sway.y + (wantY - rig.sway.y) * g };
  }
}

/** Where a leg's hip is on the web, in pixels from the hub, before the body's sway. */
export function legHip(rig: Rig, leg: Leg, s: number): XY {
  const local = LEGS[leg.index].hip;
  return bodyToWeb({ x: leg.side * local.x, y: local.y }, rig.chassis, s);
}

/** How far a stepping leg is lifted, 0 planted to 1 at the top of a plain step's arc (higher for a pluck or a groom). */
export function legLift(leg: Leg, now: number): number {
  if (!leg.step) return 0;
  return stepLift(Math.min(1, Math.max(0, (now - leg.step.start) / leg.step.length))) * (leg.step.lift ?? 1);
}

/**
 * Where two bones meet: `upper` long from `a`, and `lower` to `b`. The joint
 * lies off the line between them, as far from it as the bones allow, on the
 * side of `toward` (the part of it across the line). An end too far to reach
 * is reached toward along the line, and one too near is pushed off.
 */
export function twoBone(a: XYZ, b: XYZ, upper: number, lower: number, toward: XYZ): { joint: XYZ; end: XYZ } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dz = b.z - a.z;
  let d = Math.hypot(dx, dy, dz) || 1e-6;
  const most = (upper + lower) * 0.995;
  const least = Math.abs(upper - lower) * 1.05;
  if (d > most || d < least) {
    const to = d > most ? most : least;
    dx *= to / d;
    dy *= to / d;
    dz *= to / d;
    d = to;
  }
  const end = { x: a.x + dx, y: a.y + dy, z: a.z + dz };
  const ux = dx / d;
  const uy = dy / d;
  const uz = dz / d;
  // The joint's distance along the line, and its height off it.
  const along = (upper * upper - lower * lower + d * d) / (2 * d);
  const off = Math.sqrt(Math.max(0, upper * upper - along * along));
  const dot = toward.x * ux + toward.y * uy + toward.z * uz;
  let nx = toward.x - ux * dot;
  let ny = toward.y - uy * dot;
  let nz = toward.z - uz * dot;
  let n = Math.hypot(nx, ny, nz);
  if (n < 1e-6) {
    // `toward` runs along the line: any way across it will do; up, unless the line itself is upright.
    [nx, ny, nz] = Math.abs(uz) < 0.9 ? [-ux * uz, -uy * uz, 1 - uz * uz] : [1 - ux * ux, -ux * uy, -ux * uz];
    n = Math.hypot(nx, ny, nz) || 1;
  }
  return { joint: { x: a.x + ux * along + (nx / n) * off, y: a.y + uy * along + (ny / n) * off, z: a.z + uz * along + (nz / n) * off }, end };
}

/** A leg as drawn: its joints from the body out, each with its height above the web, how far it is folded, and how far it is lifted. */
export interface LegPose {
  hip: XYZ;
  trochanter: XYZ;
  knee: XYZ;
  patella: XYZ;
  ankle: XYZ;
  tarsus: XYZ;
  foot: XYZ;
  /** 0 stretched straight to 1 folded right in. */
  fold: number;
  /** 0 planted to 1 at the top of a step. */
  up: number;
}

function along3(a: XYZ, b: XYZ, t: number): XYZ {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * A leg's joints, in pixels from the hub, for a rig built on `s`, at `now`:
 * the hip on the chassis (swayed with
 * the body), the coxa out toward the foot, then the femur up to the knee and
 * the shin down to the foot, each bend solved by twoBone in the leg's plane,
 * which leans back from the vertical, the front pairs most, and more as the
 * leg folds (LEAN, LEAN_FOLD, LEG_LEAN), and within the
 * shin the tibia against the metatarsus and tarsus, the ankle rising; the
 * patella and the tarsus joint lie along their bones. A stepping foot is
 * lifted off the web and swung a little outward at the middle of its stride.
 */
export function legPose(rig: Rig, leg: Leg, s: number, now: number): LegPose {
  const at = legHip(rig, leg, s);
  const hip: XYZ = { x: at.x + rig.sway.x, y: at.y + rig.sway.y, z: BODY_HEIGHT * s * (1 - CROUCH * rig.crouch) };
  const up = legLift(leg, now);
  let fx = leg.foot.x;
  let fy = leg.foot.y;
  if (up > 0) {
    const d = Math.hypot(fx, fy) || 1;
    fx += (fx / d) * SWING * s * up;
    fy += (fy / d) * SWING * s * up;
  }
  const foot: XYZ = { x: fx, y: fy, z: STEP_HEIGHT * up * s };
  const dx = foot.x - hip.x;
  const dy = foot.y - hip.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const trochanter: XYZ = { x: hip.x + (dx / d) * COXA * s, y: hip.y + (dy / d) * COXA * s, z: hip.z - 0.02 * s };
  const length = (FEMUR + PATELLA + TIBIA + METATARSUS + TARSUS) * s;
  const stretch = Math.hypot(foot.x - trochanter.x, foot.y - trochanter.y, foot.z - trochanter.z);
  const fold = clamp01(1 - stretch / length);
  const shin = (PATELLA + TIBIA + METATARSUS + TARSUS) * s * (SHIN_CHORD - SHIN_FOLD * fold);
  const angle = (LEAN + LEAN_FOLD * fold) * QUIRKS[leg.side][leg.index].lean;
  const way = bodyToWeb({ x: 0, y: -LEG_LEAN[leg.index] }, rig.chassis, 1);
  const lean = (a: number): XYZ => ({ x: way.x * Math.sin(a), y: way.y * Math.sin(a), z: Math.cos(a) });
  const { joint: knee, end } = twoBone(trochanter, foot, FEMUR * s, shin, lean(angle));
  const { joint: ankle } = twoBone(knee, end, (PATELLA + TIBIA) * s, (METATARSUS + TARSUS) * s, lean(angle * 0.5));
  return {
    hip, trochanter, knee, patella: along3(knee, ankle, PATELLA / (PATELLA + TIBIA)), ankle, tarsus: along3(ankle, end, METATARSUS / (METATARSUS + TARSUS)), foot: end, fold, up,
  };
}
