// The web itself, for the Spider web view of Orbits (webLook.ts draws it): a
// clean orb web round the hub (the sun), as many straight spokes as the Spider
// web's settings say (webStyle.ts) evenly round the hub and out past the
// edges, and rings of cross threads from spoke to spoke, each sagging toward
// the hub as deep as the settings say (straight, a regular polygon, by
// default): Orbits' rank rings themselves, the closest 10 to 250, their
// corners on the spokes at their rank's radius on Orbits' even scale, so
// evenly apart, with a few thinner ones where the rank rings stand far apart
// and on out to the edges. Everything is placed relative to the sun,
// unzoomed, as Orbits places people (orbitsLayout.ts); the zoom spreads it out
// when it is drawn. Pure, so it can be tested.

import { BELT } from "./orbitsSky.ts";

export interface Polar {
  angle: number;
  r: number;
}

/**
 * A ring of cross threads: a thread from spoke to spoke, sagging toward the
 * hub as deep as the web's curve says (strandSag), its corners on the spokes
 * `r` from the hub. A rank ring (Orbits' closest 10, 25 and so on) carries
 * its label; the rest, thinner, have none.
 */
export interface Ring {
  r: number;
  label: string | null;
}

/** One of Orbits' rank rings, as the web lays a ring at it: its radius, unzoomed, and its label. */
export interface Rank {
  r: number;
  label: string;
}

export interface WebShape {
  /** The hub's radius: where the spokes start. */
  hub: number;
  /** The belt's radius: where the people end (Orbits' outermost orbit plus the belt). */
  belt: number;
  /** How far the spokes run: past any edge of the screen. */
  far: number;
  /** The spokes, in order round the hub (screen coordinates: -π/2 is up). */
  spokes: Polar[];
  /** The rings of cross threads, from the hub out. */
  rings: Ring[];
  /** How deep each cross thread sags toward the hub, 0 (straight) to 1 (STRAND_DEPTH). */
  curve: number;
}

export interface WebOptions {
  /** The stage, as Orbits lays it out: the closest orbit's radius, the outermost's, and how many people there are. */
  inner: number;
  outer: number;
  count: number;
  /** How far the web must run to pass every edge of the screen, from the sun. */
  far: number;
  /** How many spokes, made even; by default, by the crowd's size (spokesFor). */
  spokes?: number;
  /** Orbits' rank rings, from the hub out: where the web lays its rank rings. */
  ranks?: readonly Rank[];
  /** How deep the cross threads sag, 0 (straight, unless said) to 1. */
  curve?: number;
}

/** How many spokes a crowd of `count` gets: 20 for a small map up to 30 for a long history. */
export function spokesFor(count: number): number {
  return Math.max(20, Math.min(30, Math.round(10 + count / 35)));
}

/** How far apart the web's rings stand at the least at radius r, close in by the hub and opening outward: a gap between rank rings this wide or more gets a thinner ring in it. */
export function ringGap(r: number): number {
  return 1.5 * (20 + 0.07 * r);
}

/**
 * The web for a stage: as many spokes as it is given, made even so the
 * web is the same mirrored left to right and top to bottom, evenly round the
 * hub with none straight up (the top is midway between two, so each rank
 * ring's label sits on a level thread), all running out past the edges. A ring
 * at the hub, where the spokes start; a rank ring at each of `ranks` (Orbits
 * lays them evenly apart, on its even scale); and thinner rings where a gap is
 * wide, evenly within it, about ringGap apart: inside the closest rank
 * ring, round the spider; as many in every gap between two rank rings, so
 * evenly spaced rank rings make every band alike; and on out to the edges.
 */
export function webShape({ inner, outer, count, far, spokes = spokesFor(count), ranks = [], curve = 0 }: WebOptions): WebShape {
  const hub = inner * 0.55;
  const belt = outer + BELT;
  const n = Math.max(4, 2 * Math.round(spokes / 2));
  const step = (2 * Math.PI) / n;
  const spokeList: Polar[] = Array.from({ length: n }, (_, i) => ({ angle: -Math.PI / 2 + (i + 0.5) * step, r: far }));
  const rings: Ring[] = [{ r: hub, label: null }];
  // How many thinner rings a gap `gap` wide takes at radius `at`, and laying `m` evenly between two radii.
  const fits = (gap: number, at: number) => Math.max(0, Math.round(gap / ringGap(at)) - 1);
  const between = (from: number, to: number, m: number) => {
    for (let i = 1; i <= m; i++) rings.push({ r: from + ((to - from) * i) / (m + 1), label: null });
  };
  // The rank rings that fit, in order, between the hub and the edges; between two of them, as many thinner rings as
  // their mean gap takes at their middle.
  const kept: Rank[] = [];
  for (const rank of ranks) if (rank.r > (kept[kept.length - 1]?.r ?? hub) && rank.r < far) kept.push(rank);
  const span = kept.length > 1 ? kept[kept.length - 1].r - kept[0].r : 0;
  const each = kept.length > 1 ? fits(span / (kept.length - 1), kept[0].r + span / 2) : 0;
  let last = hub;
  kept.forEach((rank, i) => {
    between(last, rank.r, i === 0 ? fits(rank.r - hub, (hub + rank.r) / 2) : each);
    rings.push({ r: rank.r, label: rank.label });
    last = rank.r;
  });
  // On out past the edges, the gaps opening outward.
  for (let r = last + ringGap(last); r <= far; r += ringGap(r)) rings.push({ r, label: null });
  return { hub, belt, far, spokes: spokeList, rings, curve: Math.max(0, Math.min(1, curve)) };
}

/** How deep a cross thread sags at its deepest (its curve at 1), as a share of the straight line from spoke to spoke: its middle that far nearer the hub. */
export const STRAND_DEPTH = 0.5;

/**
 * How far the middle of a cross thread of the web's ring `r`
 * sags toward the hub from the straight line between its two spokes,
 * unzoomed: the web's curve of STRAND_DEPTH of that line's length, so every
 * thread, near the hub or far out, sags in the same proportion.
 */
export function strandSag(shape: Pick<WebShape, "spokes" | "curve">, r: number): number {
  return shape.curve * STRAND_DEPTH * 2 * r * Math.sin(Math.PI / shape.spokes.length);
}

/**
 * The control point of a cross thread of ring `r` from the spoke at `from` to
 * the next at `to` (a quadratic, so the thread is a parabola, as a sagging
 * strand nearly is), sagging `sag` (strandSag) at its middle: on the line
 * from the hub through the middle between the spokes, twice the sag inside
 * the straight line between them. On that line with no sag, so the thread is
 * straight.
 */
export function strandControl(r: number, from: number, to: number, sag: number, k = 1): [number, number] {
  const half = wrapAngle(to - from) / 2;
  return xy({ angle: from + half, r: r * Math.cos(half) - 2 * sag }, k);
}

/**
 * How far straight up from the hub a ring of radius `r` lies: the middle of
 * the thread across its top, midway between two spokes (where its label
 * sits), level from spoke to spoke and as low as it sags.
 */
export function ringTop(shape: Pick<WebShape, "spokes" | "curve">, r: number): number {
  return r * Math.cos(Math.PI / shape.spokes.length) - strandSag(shape, r);
}

/** Where a polar spot is, in pixels, at zoom `k`. */
export function xy(p: Polar, k = 1): [number, number] {
  return [Math.cos(p.angle) * p.r * k, Math.sin(p.angle) * p.r * k];
}

/** An angle difference brought into (-π, π]. */
export function wrapAngle(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
