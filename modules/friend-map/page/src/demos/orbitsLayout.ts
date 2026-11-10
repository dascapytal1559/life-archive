// The geometry behind Orbits: you are the sun, and the distance from it
// is closeness (closeness.ts), by rank: the closest person sits next to the
// sun and the rest step outward in order. Whoever you live with
// (tagged "live-together", ranked first) sits in the sun itself, inside the
// closest orbit, evenly spaced round it (hearth). Nothing
// else places anyone: no slices. Everyone has a fixed direction, spread
// evenly around the sun in name order (directions), or, with friend circles
// chosen, in their order (friendCircles.ts, spread), and bodies are nudged apart
// from there only as much as it takes to stop them overlapping; and, on Orbits
// and the Spider web, whoever is named is turned further round their orbit until their name covers
// no other (fitNames). Pure
// functions, no DOM, so the layout can be tested with made-up people.

import { identicon, mix } from "../identicon.ts";
import { NameRoom } from "./nameRoom.ts";
import { COLORS } from "./palette.ts";
import { locale } from "../time.ts";

export { boxesMeet } from "./nameRoom.ts";

/** Rank eases in, so the closest two or three are not spread across the whole inner ring. */
const EASE_RANK = 2;

/**
 * 0 for the closest person, 1 for the last of `count`, on a log scale of the
 * rank softened by EASE_RANK: of 700 people, the closest ten take about a
 * quarter of the room and the closest hundred two thirds, and the long tail
 * of people from years ago shares the outer part.
 */
export function rankFraction(rank: number, count: number): number {
  if (count <= 1) return 0;
  const r = Math.min(Math.max(rank, 1), count);
  return Math.log((r + EASE_RANK) / (1 + EASE_RANK)) / Math.log((count + EASE_RANK) / (1 + EASE_RANK));
}

/**
 * How rank becomes distance from the sun. "log", Orbits' own: rankFraction,
 * the closest given the most room. "even", the Spider web's
 * (webGeometry.ts): the guide rings (rings) evenly spaced, the room from the
 * closest orbit to the outermost cut into equal bands, one inside each ring
 * and one past the last, and everyone spread evenly by rank within their band
 * (evenFraction), so each ring still sits between the last person inside it
 * and the first outside.
 */
export type RankScale = "log" | "even";

/**
 * 0 for the closest person, 1 for the last of `count`, on the even scale: a
 * straight run from one stop to the next, the stops 1, each of `bounds` (the
 * guide rings' ranks, in order) and `count`, each band between two stops the
 * same share of the room.
 */
export function evenFraction(rank: number, count: number, bounds: readonly number[]): number {
  if (count <= 1) return 0;
  const r = Math.min(Math.max(rank, 1), count);
  const stops = [1, ...bounds.filter((b) => b > 1 && b < count), count];
  const bands = stops.length - 1;
  let band = 1;
  while (band < bands && r > stops[band]) band++;
  return (band - 1 + (r - stops[band - 1]) / (stops[band] - stops[band - 1])) / bands;
}

/** How far from the sun whoever you live with sits, as a share of the closest orbit's radius: in the sun. */
export const HEARTH = 0.6;

/** The sun's glow round whoever you live with, as a share of the closest orbit's radius: under half the sun's (SUN_SHARE, 0.95). */
export const HEARTH_GLOW = 0.42;

/** The radius of that glow round someone drawn `size` pixels across: HEARTH_GLOW of `inner`, and always well past their marker. */
export function hearthGlowRadius(size: number, inner: number): number {
  return Math.max(inner * HEARTH_GLOW, size * 1.8);
}

/**
 * The orbit radius for someone ranked `rank` of `count` by closeness; null (no score) sits on the outermost orbit.
 * The first `together` ranks are whoever you live with (closenessRanks), in the sun at HEARTH; everyone
 * else steps outward from the closest orbit as if they were not there, so tagging someone moves nobody else. On
 * the `scale` given (RankScale): Orbits' own unless said.
 */
export function orbitRadius(rank: number | null, inner: number, outer: number, count: number, together = 0, scale: RankScale = "log"): number {
  if (rank !== null && rank <= together) return inner * HEARTH;
  if (rank === null) return outer;
  const fraction = scale === "even"
    ? evenFraction(rank - together, count - together, rings(count, "even").map((ring) => ring.rank - together))
    : rankFraction(rank - together, count - together);
  return inner + (outer - inner) * fraction;
}

/**
 * Where whoever you live with sits (`ids`), in the sun: at HEARTH of the closest orbit (`inner`), evenly
 * spaced round it in the order of the directions they would otherwise take (`aim`, A to Z or friend circles), the
 * first in their own direction, so one alone keeps their own spoke. Never pushed: nobody else comes this near.
 */
export function hearth(ids: readonly number[], aim: ReadonlyMap<number, Direction>, inner: number): Map<number, Placed> {
  const order = [...ids].sort((a, b) => aim.get(a)!.angle - aim.get(b)!.angle || a - b);
  const r = inner * HEARTH;
  return new Map(order.map((id, i) => {
    const angle = aim.get(order[0])!.angle + (2 * Math.PI * i) / order.length;
    return [id, { id, angle, r, x: Math.cos(angle) * r, y: Math.sin(angle) * r }];
  }));
}

/** How far past the belt, at the least, an aspiring friend's bubble keeps: never mistaken for someone on it. */
export const ASPIRING_CLEAR = 16;

/** An aspiring friend's bubble's radius on a map reaching `outer` from the sun: plainly bigger than the most talked-to's (at most 15). */
export function aspiringSize(outer: number): number {
  return Math.min(30, Math.max(14, outer * 0.07));
}

/** How far from the sun, along `angle`, the box `edge` round it ends. */
export function edgeReach(angle: number, edge: Box): number {
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const across = ux > 0 ? edge.right / ux : ux < 0 ? edge.left / ux : Infinity;
  const down = uy > 0 ? edge.bottom / uy : uy < 0 ? edge.top / uy : Infinity;
  return Math.min(across, down);
}

/** How finely the edge is walked for aspiring friends' places. */
const EDGE_STEPS = 720;

/**
 * Where aspiring friends (`ids`, in their order) sit: on `edge`, the furthest box round the sun they can be seen in
 * (relative to the sun), so as far out as the page goes. They go round it clockwise from its top right corner,
 * evenly over the stretches at least `clear` from the sun, which leaves out any of the edge the map itself reaches:
 * one sits in that corner, two in opposite ones. Nothing they do moves anyone else. An edge all too near has only
 * its corners left, and they are spread round it anyway.
 */
export function aspiringPlaces(ids: readonly number[], edge: Box, clear: number): Map<number, Placed> {
  const corner = Math.atan2(edge.top, edge.right);
  const turns = Array.from({ length: EDGE_STEPS }, (_, i) => corner + (2 * Math.PI * i) / EDGE_STEPS);
  const far = turns.filter((angle) => edgeReach(angle, edge) >= clear);
  const room = far.length > 0 ? far : turns;
  return new Map(ids.map((id, i) => {
    const angle = wrap(room[Math.floor((i * room.length) / ids.length)]);
    const r = edgeReach(angle, edge);
    return [id, { id, angle, r, x: Math.cos(angle) * r, y: Math.sin(angle) * r }];
  }));
}

/**
 * Where someone ranked at the start of the `months` months before month `at`
 * (`rank` per month, 0 with no score): where their comet trail starts. For
 * someone who first had a score during the window, their rank at the end of
 * that first month, so someone new has a short trail. Null if they had no
 * score before `at`.
 */
export function trailStartRank(rank: number[], at: number, months: number): number | null {
  for (let back = months; back >= 1; back--) {
    const r = rank[at - back];
    if (r !== undefined && r > 0) return r;
  }
  return null;
}

/**
 * A displacement trail's outline, relative to the sun: a straight tail along
 * the radius from the head (where someone sits now) back to `fromR`, where
 * they sat at the start of the look-back window, so it points outward for
 * someone getting closer and inward for someone drifting apart. It tapers
 * from `width` at the head to a point at the start. Null when they moved
 * less than `minShift`, as that is no real change. Returns the closed
 * outline and the tail's end, for a fade from head to tail.
 */
export function displacementTrail(
  head: { angle: number; r: number },
  fromR: number,
  { width, minShift }: { width: number; minShift: number },
): { outline: Array<[number, number]>; tail: [number, number] } | null {
  if (Math.abs(fromR - head.r) < minShift) return null;
  const [ux, uy] = [Math.cos(head.angle), Math.sin(head.angle)];
  const [nx, ny] = [-uy * (width / 2), ux * (width / 2)];
  const [hx, hy] = [ux * head.r, uy * head.r];
  const tail: [number, number] = [ux * fromR, uy * fromR];
  return { outline: [[hx + nx, hy + ny], tail, [hx - nx, hy - ny]], tail };
}

/**
 * The guide rings worth drawing for `count` people: bands of the closest 10,
 * 25, 50 and so on, as far as there are people to fill them (a band that
 * would take in more than four in five of everyone is left out); on the
 * even scale (RankScale), none past the closest EVEN_LAST. Each ring sits
 * between the last person inside it and the first outside.
 */
export function rings(count: number, scale: RankScale = "log"): Array<{ rank: number; label: string }> {
  return RING_STOPS
    .filter((n) => n <= count * 0.8 && (scale === "log" || n <= EVEN_LAST))
    .map((n) => ({ rank: n + 0.5, label: `top ${n.toLocaleString(locale())}` }));
}

/** Where the guide rings can be: the closest 10, 25, 50 and so on. */
export const RING_STOPS: readonly number[] = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/** The outermost guide ring on the even scale: the closest 250, everyone further spread in the band beyond it. */
export const EVEN_LAST = 250;

/** The reach-out glow, 1 for someone you should reach out to and 0 for everyone else; tweened between the two when that changes. */
export function glowOf(person: { shouldReachOut: boolean }): number {
  return person.shouldReachOut ? 1 : 0;
}

/** A person's direction from the sun, in radians clockwise from the top (screen coordinates: -π/2 is up). */
export interface Direction {
  angle: number;
  /** How far the overlap pushing may move them round their orbit, either way. */
  lo: number;
  hi: number;
}

/**
 * Everyone's direction: evenly spaced round the sun in name order (A to Z,
 * clockwise from the top), leaving `topGap` radians clear at the top for the
 * ring labels. Directions depend on names only, not on closeness, so people
 * move in and out along fixed spokes as it changes, and a new person
 * shifts everyone else by a fraction of one space. Each may be pushed up to
 * `give` spaces either way to clear an overlap, but never into the gap at the top.
 */
export function directions(people: Array<{ id: number; name: string }>, topGap: number, give = 2.5): Map<number, Direction> {
  return spread([...people].sort(byName).map((p) => p.id), topGap, { give });
}

/** A to Z by name, ignoring case and accents, then by id: Orbits' default order round the sun. */
export function byName(a: { id: number; name: string }, b: { id: number; name: string }): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id - b.id;
}

/** The gaps between friend circles never take more than this share of the ring: past it, every gap narrows alike. */
export const GAPS_MOST = 0.2;
/** A gap's space is never narrower than this share of the ring, so gaps stay clear where a crowd makes everyone's narrow. */
export const GAP_SPACE_LEAST = 1 / 480;

/**
 * Directions for everyone in `order` (ids), round the sun in that order,
 * clockwise from the top, leaving `topGap` radians clear at the top for the
 * ring labels. Each takes a share of the ring by their `weights` (in `order`;
 * evenly without), and `gaps` leave room before some (where a new friend
 * circle starts), in spaces: an average person's share, or GAP_SPACE_LEAST
 * of the ring where that is wider. The gaps narrow alike when they would take
 * more than GAPS_MOST of the ring. Each may be pushed up
 * to `give` spaces either way to clear an overlap, but never into the gap at
 * the top. directions() is this in name order, evenly, with no gaps.
 */
export function spread(
  order: readonly number[],
  topGap: number,
  { give = 2.5, weights, gaps = [] }: { give?: number; weights?: readonly number[]; gaps?: ReadonlyArray<{ at: number; spaces: number }> } = {},
): Map<number, Direction> {
  const mean = weights && weights.length > 0 ? weights.reduce((sum, w) => sum + w, 0) / weights.length : 1;
  // Each person's share, in spaces.
  const share = (i: number) => (weights && mean > 0 ? weights[i] / mean : 1);
  const before = new Map<number, number>();
  for (const { at, spaces } of gaps) if (at > 0 && at < order.length && spaces > 0) before.set(at, (before.get(at) ?? 0) + spaces);
  const asked = [...before.values()].reduce((sum, s) => sum + s, 0);
  const ring = 2 * Math.PI - topGap;
  // A gap's space is a person's, or GAP_SPACE_LEAST of the ring where that is wider; `narrow` keeps the gaps within GAPS_MOST.
  let narrow = asked === 0 ? 0 : Math.min(1, (GAPS_MOST * order.length) / ((1 - GAPS_MOST) * asked));
  let space = ring / Math.max(1, order.length + asked * narrow);
  let gapSpace = space;
  if (asked > 0 && space < ring * GAP_SPACE_LEAST) {
    gapSpace = ring * GAP_SPACE_LEAST;
    narrow = Math.min(1, GAPS_MOST / (asked * GAP_SPACE_LEAST));
    space = (ring - asked * narrow * gapSpace) / Math.max(1, order.length);
  }
  const reach = Math.max(give * space, 0.04);
  const first = -Math.PI / 2 + topGap / 2;
  const last = first + 2 * Math.PI - topGap;
  // How many people's spaces, and how much gap, come before each person.
  let spaces = 0;
  let gap = 0;
  return new Map(order.map((id, i) => {
    gap += (before.get(i) ?? 0) * narrow * gapSpace;
    const angle = first + gap + space * (spaces + share(i) / 2);
    spaces += share(i);
    return [id, { angle, lo: Math.max(first, angle - reach), hi: Math.min(last, angle + reach) }];
  }));
}

/** A person to place: the orbit radius they belong on, and their drawn radius. */
export interface Body {
  id: number;
  orbit: number;
  size: number;
}

export interface Placed {
  id: number;
  angle: number;
  r: number;
  x: number;
  y: number;
}

export type Aimed = Body & Direction;

export interface PlaceOptions {
  /** Space kept between two bodies' edges. */
  padding?: number;
  /** How far a body may be nudged in from its true orbit, and out, to make room. */
  giveIn?: number;
  giveOut?: number;
  /** The closest any body's edge may come to the sun. */
  minR?: number;
  iterations?: number;
}

/**
 * Bodies placed on their orbits in their direction (see directions), pushed
 * apart until they no longer overlap: first round their orbits within their
 * reach and a little in or out, then, where a crowd is still too tight (near
 * the sun, where the orbits are short), whoever is further out steps further
 * out. No body's edge comes nearer the sun than `minR`. Deterministic;
 * positions are relative to the sun at (0, 0).
 *
 * Only near neighbours are compared, found through a grid of cells as wide as
 * the biggest gap two bodies need, so a crowd of hundreds (a decade of
 * history) places in a few milliseconds rather than comparing every pair.
 */
export function placeBodies(bodies: Aimed[], options: PlaceOptions = {}): Map<number, Placed> {
  const { padding = 1.5, giveIn = 6, giveOut = 18, minR = 0, iterations = 160 } = options;
  const nodes = bodies.map((body) => ({ ...body, r: body.orbit, x: 0, y: 0 }));
  const clamp = (node: (typeof nodes)[number]) => {
    node.r = Math.min(Math.max(node.r, node.orbit - giveIn, minR + node.size), Math.max(node.orbit + giveOut, minR + node.size));
    node.angle = Math.min(Math.max(node.angle, node.lo), node.hi);
    node.x = Math.cos(node.angle) * node.r;
    node.y = Math.sin(node.angle) * node.r;
  };
  nodes.forEach(clamp);
  const cell = Math.max(1, 2 * Math.max(0, ...nodes.map((n) => n.size)) + padding);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let moved = false;
    const cells = grid(cell);
    nodes.forEach((node, i) => cells.add(node.x, node.y, i));
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      cells.near(a.x, a.y, (j) => {
        if (j <= i) return;
        const b = nodes[j];
        const need = a.size + b.size + padding;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= need) return;
        if (distance < 1e-6) {
          // Exactly on top of each other: part them along the orbit.
          dx = -Math.sin(a.angle) * (a.id < b.id ? 1 : -1);
          dy = Math.cos(a.angle) * (a.id < b.id ? 1 : -1);
        } else {
          dx /= distance;
          dy /= distance;
        }
        // The bigger body moves less.
        const push = (need - distance) * 0.5;
        const share = b.size / (a.size + b.size);
        a.x -= dx * push * share * 2;
        a.y -= dy * push * share * 2;
        b.x += dx * push * (1 - share) * 2;
        b.y += dy * push * (1 - share) * 2;
        // Settled once every overlap left is a fraction of a pixel; the last step below clears those.
        if (need - distance > 0.25) moved = true;
      });
    }
    for (const node of nodes) {
      const angle = Math.atan2(node.y, node.x);
      node.angle += wrap(angle - node.angle);
      // Drift back toward the true orbit, so recency stays honest.
      node.r = Math.hypot(node.x, node.y) * 0.8 + node.orbit * 0.2;
      clamp(node);
    }
    if (!moved) break;
  }
  // Where a crowd was too tight to relax apart (near the sun, each person's
  // share of an orbit is only a few pixels long), step whoever is further out
  // a little further out until they clear everyone nearer in.
  const settled = grid(cell);
  const overlaps = (node: (typeof nodes)[number]) => {
    let found = false;
    settled.near(node.x, node.y, (j) => {
      const o = nodes[j];
      found = Math.hypot(o.x - node.x, o.y - node.y) < o.size + node.size + padding - 0.01;
      return found;
    });
    return found;
  };
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].orbit - nodes[b].orbit || nodes[a].id - nodes[b].id);
  for (const i of order) {
    const node = nodes[i];
    while (overlaps(node)) {
      node.r += 1;
      node.x = Math.cos(node.angle) * node.r;
      node.y = Math.sin(node.angle) * node.r;
    }
    settled.add(node.x, node.y, i);
  }
  return new Map(nodes.map((n) => [n.id, { id: n.id, angle: n.angle, r: n.r, x: n.x, y: n.y }]));
}

/** A name drawn in place of its person's icon, to fit round the sun: what it covers, as offsets from its person's spot, unzoomed. */
export interface FitName {
  id: number;
  box: Box;
  /** Never moved (whoever you live with, in the sun): the others fit round it. */
  fixed?: boolean;
}

/** How far round their orbit, in radians, fitNames may turn someone either way: about 20°. */
export const FIT_TURN = 0.35;
/** The step, in pixels along the orbit, between the spots fitNames tries. */
const FIT_STEP = 1;

/**
 * People whose names stand in for their icons, turned round their
 * orbits until no name covers another: the distance from the sun is closeness,
 * so only the angle changes, never `r`. `names` come closest first, and each
 * in turn keeps its own angle if its name is clear of those placed before it,
 * or else takes the nearest angle where it is, at most `turn` either way, a
 * pixel along the orbit at a time, clockwise first; a closer person is never
 * moved for a further one. A name with no clear angle within reach takes the
 * one where it covers the least. Names stay off the marks `around` them (the
 * ring labels) as off each other. Every name and mark keeps `pad` pixels clear
 * of every other, across and up and down: each is taken as half that wider all
 * round, and two only cover each other where those boxes overlap, so names that
 * just touch are `pad` apart. Never into the gap at the top (`topGap`, as
 * spread). Those `fixed` stay put, and everyone not in `names` is returned as
 * they were. Deterministic, so the same people give the same map.
 */
export function fitNames(
  placed: ReadonlyMap<number, Placed>,
  names: readonly FitName[],
  { topGap = 0, turn = FIT_TURN, around = [], pad = 0 }: { topGap?: number; turn?: number; around?: readonly Box[]; pad?: number } = {},
): Map<number, Placed> {
  const out = new Map(placed);
  const room = new NameRoom();
  const half = pad / 2;
  for (const box of around) room.take(grown(box, half));
  const first = -Math.PI / 2 + topGap / 2;
  const last = first + 2 * Math.PI - topGap;
  const boxes = new Map(names.map((n) => [n.id, grown(n.box, half)]));
  const at = (n: FitName, angle: number, r: number): LabelSpot => {
    const [x, y] = [Math.cos(angle) * r, Math.sin(angle) * r];
    const box = boxes.get(n.id)!;
    return { id: n.id, left: x + box.left, right: x + box.right, top: y + box.top, bottom: y + box.bottom, x, y, anchor: "middle", scale: 1 };
  };
  const covered = (spot: LabelSpot) =>
    room.blockers(spot).reduce((sum, t) => sum + Math.max(0, Math.min(t.right, spot.right) - Math.max(t.left, spot.left)) * Math.max(0, Math.min(t.bottom, spot.bottom) - Math.max(t.top, spot.top)), 0);
  for (const n of [...names.filter((n) => n.fixed), ...names.filter((n) => !n.fixed)]) {
    const p = placed.get(n.id);
    if (!p) continue;
    const own = at(n, p.angle, p.r);
    if (n.fixed || p.r <= 0 || room.free(own)) {
      room.take(own);
      continue;
    }
    // Nearest first, a pixel along the orbit at a time, clockwise then anticlockwise.
    let best = { spot: own, angle: p.angle, cover: covered(own) };
    const steps = Math.floor((turn * p.r) / FIT_STEP);
    for (let i = 1; i <= steps && best.cover > 0; i++) {
      for (const side of [1, -1]) {
        const angle = p.angle + (side * i * FIT_STEP) / p.r;
        if (angle < first || angle > last) continue;
        const spot = at(n, angle, p.r);
        const cover = room.free(spot) ? 0 : covered(spot);
        if (cover < best.cover) best = { spot, angle, cover };
        if (cover === 0) break;
      }
    }
    room.take(best.spot);
    out.set(n.id, { id: n.id, angle: best.angle, r: p.r, x: best.spot.x, y: best.spot.y });
  }
  return out;
}

/** `box`, `by` wider on every side (narrower, for `by` below 0). */
export function grown(box: Box, by: number): Box {
  return by === 0 ? box : { left: box.left - by, right: box.right + by, top: box.top - by, bottom: box.bottom + by };
}

/** Points bucketed into square cells `size` wide, to find those near a spot without looking at all of them. */
function grid(size: number) {
  const cells = new Map<number, number[]>();
  // One number per cell; the map is a few thousand cells across at most.
  const key = (i: number, j: number) => (i + 32_768) * 65_536 + (j + 32_768);
  return {
    add(x: number, y: number, item: number): void {
      const k = key(Math.floor(x / size), Math.floor(y / size));
      const list = cells.get(k);
      if (list) list.push(item);
      else cells.set(k, [item]);
    },
    /** Every item in the cell at (x, y) and the eight around it: all within one cell width, and some a little further. */
    near(x: number, y: number, visit: (item: number) => boolean | void): void {
      const ci = Math.floor(x / size);
      const cj = Math.floor(y / size);
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          for (const item of cells.get(key(i, j)) ?? []) if (visit(item) === true) return;
        }
      }
    },
  };
}

/** A body as drawn at one moment: where (angle, radius), how big, how lit. */
export interface Drawn {
  angle: number;
  r: number;
  size: number;
  /** 1 for someone you should reach out to, 0 for everyone else (see glowOf); in between while that changes. */
  glow: number;
  opacity: number;
  silent: boolean;
}

/** Less than this, in pixels, is not worth animating. */
const UNSEEN = 0.5;

/**
 * Whether going from `from` to `to` changes anything one could see move:
 * someone new, moving or growing by half a pixel or more, fading, glowing, or
 * falling silent. A few new messages rarely do, and animating redraws the whole
 * map every frame, so a change that does not is taken in one step.
 */
export function movesVisibly(from: ReadonlyMap<number, Drawn>, to: ReadonlyMap<number, Drawn>): boolean {
  for (const [id, b] of to) {
    const a = from.get(id);
    if (!a || a.silent !== b.silent) return true;
    if (Math.abs(b.r - a.r) >= UNSEEN || Math.abs(b.size - a.size) >= UNSEEN || Math.abs(wrap(b.angle - a.angle)) * b.r >= UNSEEN) return true;
    if (Math.abs(b.opacity - a.opacity) >= 0.02 || Math.abs(b.glow - a.glow) >= 0.02) return true;
  }
  return false;
}

/** An angle difference brought into (-π, π]. */
export function wrap(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Who is named on the map without hovering, closest first: the `count`
 * people ranked closest as of month `at` (`rank` per month, 0 with no score).
 */
export function namedIds(people: Array<{ id: number; rank: number[] }>, at: number, count: number): number[] {
  return people
    .filter((p) => (p.rank[at] ?? 0) > 0)
    .sort((a, b) => a.rank[at] - b.rank[at])
    .slice(0, count)
    .map((p) => p.id);
}

/**
 * How strongly each tier of people is drawn, their marker, name, trail and glow
 * alike, closest first: a tier is everyone up to `closest` (the guide rings'
 * 10, 25, 50 and 100), from full strength for the closest ten down to 40% for
 * the 51st to the 100th, evenly between. Everyone further out is drawn at
 * TIER_FLOOR. Tune them here.
 */
export const TIERS: ReadonlyArray<{ closest: number; opacity: number }> = [
  { closest: 10, opacity: 1 },
  { closest: 25, opacity: 0.8 },
  { closest: 50, opacity: 0.6 },
  { closest: 100, opacity: 0.4 },
];

/** How strongly everyone past the last tier, and the belt, is drawn. */
export const TIER_FLOOR = 0.2;

/**
 * How strongly everyone else is drawn while someone is picked out: one flat
 * strength whatever their tier, so the picked-out person and their links stand
 * out from a quiet background.
 */
export const BACKGROUND = 0.2;

/**
 * How far Orbits and the Spider web dim their people's marks (markers, trails
 * and glows; not names) while someone is picked out: one opacity on the
 * layer holding them all, each kept at its own strength within it, so a
 * hover changes one property, not every mark (Orbits.tsx). It stands in for
 * BACKGROUND there: the closest come out stronger than that, and the faintest
 * fainter.
 */
export const DIM = 0.4;

/**
 * Tiers like TIERS for a fade from full strength for the closest `top` down
 * to `floor` past the closest `bottom`: a step at every guide ring between
 * (RING_STOPS) and at `bottom`, each the same step fainter, so the closest
 * 10 to the closest 100 down to 20% are TIERS. With `bottom` no further out
 * than `top`, the closest `top` are at full strength and everyone else at
 * `floor` at once.
 */
export function fadeTiers(top: number, bottom: number, floor: number): Array<{ closest: number; opacity: number }> {
  const steps = [top, ...RING_STOPS.filter((n) => n > top && n < bottom), ...(bottom > top ? [bottom] : [])];
  return steps.map((closest, i) => ({ closest, opacity: Math.round((1 - (i * (1 - floor)) / steps.length) * 1000) / 1000 }));
}

/**
 * How strongly the person `place`th closest (1 for the closest) is drawn;
 * anyone beyond the last tier, and anyone with no closeness yet (null, the
 * belt), at `floor`.
 */
export function tierOpacity(place: number | null, tiers = TIERS, floor = TIER_FLOOR): number {
  return tiers.find((tier) => place !== null && place <= tier.closest)?.opacity ?? floor;
}

/**
 * How strongly someone is drawn, their marker, name, trail and glow alike:
 * by their tier, and someone you should reach out to never fainter
 * than the last tier, the faintest of the named, wherever they are; a
 * stronger Reach-out glow lifts that least strength `lift` of the way from the
 * last tier's to full (glowLook in reachGlow.ts). Everyone past the last
 * tier is at `floor` (the Names settings' faintest, for names; nameFade.ts).
 */
export function personOpacity(
  place: number | null,
  reachOut: boolean,
  { tiers = TIERS, lift = 0, floor = TIER_FLOOR }: { tiers?: typeof TIERS; lift?: number; floor?: number } = {},
): number {
  const own = tierOpacity(place, tiers, floor);
  const last = tiers[tiers.length - 1].opacity;
  return reachOut ? Math.max(own, last + (1 - last) * lift) : own;
}

/** How far a name's colour goes from its person's identicon colour toward the plain light text (nameColour). */
export const NAME_TINT = 0.5;

/**
 * The colour of someone's name: a soft tint of their identicon's main colour,
 * NAME_TINT of the way to the plain light text, so where markers sit side by
 * side each name is easy to match to its own, and still reads almost as
 * plainly as light text on the night sky.
 */
export function nameColour(seed: string, hue: number | null): string {
  return mix(identicon(seed, hue).main, COLORS.star, NAME_TINT);
}

/**
 * The colour someone glows in when you should reach out to them, and their name on Orbits is written in: their
 * identicon's main colour, so the glow is plainly theirs.
 */
export function glowColour(seed: string, hue: number | null): string {
  return identicon(seed, hue).main;
}

/**
 * How far, in pixels, a glowing name's halo reaches, and how strong it is, at
 * full glow; and how much stronger, as a share, at the strongest Reach-out glow
 * (reachGlow.ts).
 */
export const NAME_GLOW = { blur: 3, alpha: 0.8, boosted: 0.25 };

/**
 * The wider halo a stronger Reach-out glow (reachGlow.ts) adds round a glowing
 * name, past NAME_GLOW's: its blur, `blur` pixels plus `more` times the
 * setting, and its strength, `alpha` times the setting; none at the usual look.
 */
export const NAME_HALO = { blur: 4, more: 6, alpha: 0.6 };

/** A share, 0 to 1, as the two hex digits of a colour's alpha. */
export function alphaHex(share: number): string {
  return Math.round(255 * Math.max(0, Math.min(1, share))).toString(16).padStart(2, "0");
}

/**
 * The CSS filter that gives someone's name a soft halo in their glow colour,
 * `glow` (0 to 1, as glowOf, tweened) of the way in; none without a glow. The
 * halo sits outside the name's dark outline, so the letters stay sharp. A
 * stronger Reach-out glow, `boost` (0, the usual, to 1; a pulse's swell may
 * pass 1), makes the near halo stronger and adds NAME_HALO round it.
 */
export function nameGlow(colour: string, glow: number, boost = 0): string | undefined {
  if (glow < 0.02) return undefined;
  const g = Math.min(glow, 1);
  const near = `drop-shadow(0 0 ${(NAME_GLOW.blur * g).toFixed(2)}px ${colour}${alphaHex(NAME_GLOW.alpha * g * (1 + NAME_GLOW.boosted * boost))})`;
  if (boost <= 0) return near;
  return `${near} drop-shadow(0 0 ${((NAME_HALO.blur + NAME_HALO.more * boost) * g).toFixed(2)}px ${colour}${alphaHex(NAME_HALO.alpha * boost * g)})`;
}

/** The smallest radius, in pixels, at which a marker's identicon reads: two and a bit pixels a cell. */
export const READABLE = 9;

/**
 * A marker's radius as drawn at zoom `k`, for one placed at radius `size`
 * unzoomed: its own size, grown toward READABLE as zooming spreads people
 * out, never faster than the zoom, so markers placed clear of each other stay
 * clear, and the identicons of the people zoomed in on can be read.
 */
export function drawnSize(size: number, k: number): number {
  return Math.max(size, Math.min(READABLE, size * k));
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LabelSpot extends Box {
  id: number;
  /** The text's baseline point for its anchor. */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** The type size, as a share of the full size. */
  scale: number;
}

/** East Asian wide and full-width characters (CJK, kana, Hangul, full-width forms, emoji): about a full em, two Latin widths. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
/** Joiners and variation selectors, which take no room of their own. */
const ZERO_WIDTH = /[\u200B-\u200D\uFE00-\uFE0F]/u;

/**
 * How many average Latin characters wide a text is: a wide character (see
 * WIDE) counts two, a joiner nothing, anything else one. A name's width is
 * this times the font's average character width.
 */
export function textUnits(text: string): number {
  let units = 0;
  for (const char of text) units += WIDE.test(char) ? 2 : ZERO_WIDTH.test(char) ? 0 : 1;
  return units;
}

/** A name's type: an average Latin character's width (textUnits) and a line's height, at full size. */
export interface NameType {
  charWidth?: number;
  height?: number;
}

/**
 * Names centred on their bodies, standing in for their icons, every one of
 * them, whatever they cover: no name is moved or left out here (useNameFit
 * turns people round their orbits first, so they cover no other). The text is
 * centred on the body, the baseline set so the line's middle is on it.
 */
export function centreOnIcons(
  candidates: Array<{ id: number; x: number; y: number; text: string; scale?: number }>,
  { charWidth = 6.6, height = 13 }: NameType = {},
): LabelSpot[] {
  return candidates.map((c) => {
    const scale = c.scale ?? 1;
    const [w, h] = [textUnits(c.text) * charWidth * scale, height * scale];
    return { id: c.id, left: c.x - w / 2, right: c.x + w / 2, top: c.y - h / 2, bottom: c.y + h / 2, x: c.x, y: c.y + 4 * scale, anchor: "middle", scale };
  });
}

/**
 * Where a friend circle's name goes: at `angle` round the sun, `r` from it
 * (just outside its arc), reaching away from the sun (to the right on the
 * right, the left on the left, centred at the top and bottom), and moved
 * along as far as it takes to stay inside `bounds`. Relative to the sun;
 * `x`, `y` and `anchor` place the text, `box` is what it covers.
 */
export function circleLabelSpot(
  angle: number,
  r: number,
  text: string,
  bounds: Box,
  { charWidth = 6.4, height = 11 }: { charWidth?: number; height?: number } = {},
): { x: number; y: number; anchor: "start" | "middle" | "end"; box: Box } {
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const width = textUnits(text) * charWidth;
  const anchor = ux > 0.35 ? "start" : ux < -0.35 ? "end" : "middle";
  const offset = anchor === "start" ? 0 : anchor === "end" ? width : width / 2;
  // The text's baseline: below the arc at the bottom, above it at the top, level with it at the sides.
  const baseline = uy * r + (uy > 0.35 ? height : uy < -0.35 ? 0 : height * 0.35);
  const left = Math.min(Math.max(ux * r - offset, bounds.left), bounds.right - width);
  const y = Math.min(Math.max(baseline, bounds.top + height), bounds.bottom);
  return { x: left + offset, y, anchor, box: { left, right: left + width, top: y - height, bottom: y } };
}
