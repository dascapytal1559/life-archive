// Zooming and panning Orbits. The layout (orbitsLayout.ts) places everyone
// relative to the sun as if unzoomed; a Zoom then spreads those places out by
// `k` and shifts them by (x, y), so a person at (px, py) from the sun is drawn
// at the sun's unzoomed spot plus (x + k * px, y + k * py). Only places
// spread: the sun, dots, names, ring labels and the hover card keep their
// size, so zooming in opens room between people rather than making them
// bigger. Pure functions, no DOM, so the maths can be tested on its own.

import type { Box } from "./orbitsLayout.ts";

/** How far the map is zoomed (`k`, 1 unzoomed) and shifted (`x`, `y`, in pixels). */
export interface Zoom {
  k: number;
  x: number;
  y: number;
}

/** Unzoomed: the whole system in view, as the map first draws it. */
export const HOME: Zoom = { k: 1, x: 0, y: 0 };
/** The furthest in: enough to part the crowd by the sun, and the long tail of a decade of history on the outer orbits. */
export const MAX_ZOOM = 12;
/** One press of + or −. */
export const ZOOM_STEP = 1.5;

/**
 * The system's reach from the sun, unzoomed, and, where less of the map is in
 * view across than the system spans (the person panel docked over a map that
 * keeps its size, Demos.tsx), what is in view across (`seen`), from the sun's
 * unzoomed spot, as `anchor` is for zoomAt.
 */
export type Bounds = Box & { seen?: { left: number; right: number } };

/**
 * The zoom's bounds for a system reaching `extent` from the sun on a map `width` wide, the middle `seen` of which is in
 * view across: where that is less than the whole map, the system's edges may come in to `margin` inside it.
 */
export function boundsOf(extent: Box, width: number, seen: number, margin = 0): Bounds {
  return seen < width ? { ...extent, seen: { left: margin - seen / 2, right: seen / 2 - margin } } : extent;
}

/**
 * `zoom` brought within bounds: from unzoomed (never further out, as the
 * whole system is in view there) to MAX_ZOOM, and shifted only so far that
 * the system's edge never comes inside where it sits unzoomed, or inside the
 * edge of what is in view (`bounds.seen`) where that is nearer the sun.
 * `bounds` is the system's reach from the sun, unzoomed. So unzoomed, with
 * the whole system in view, it cannot be shifted at all, and the further in,
 * the further it can go; with the panel hiding the system's edge, it can be
 * shifted as far as brings that edge into view.
 */
export function clampZoom(zoom: Zoom, bounds: Bounds): Zoom {
  const k = clamp(zoom.k, 1, MAX_ZOOM);
  const { left, right } = bounds.seen ?? bounds;
  // + 0: unzoomed, the bounds are -0 on one side, and the map is at 0, not -0.
  return {
    k,
    x: clamp(zoom.x, Math.min(bounds.right, right) - bounds.right * k, Math.max(bounds.left, left) - bounds.left * k) + 0,
    y: clamp(zoom.y, -bounds.bottom * (k - 1), -bounds.top * (k - 1)) + 0,
  };
}

/**
 * `zoom` zoomed by `factor` (above 1 in, below 1 out) about `anchor`, a point
 * relative to the sun's unzoomed spot (the pointer, or the middle of the
 * view), which stays where it is on screen, within bounds (see clampZoom).
 */
export function zoomAt(zoom: Zoom, factor: number, anchor: { x: number; y: number }, extent: Bounds): Zoom {
  const k = clamp(zoom.k * factor, 1, MAX_ZOOM);
  const grow = k / zoom.k;
  return clampZoom({ k, x: anchor.x - (anchor.x - zoom.x) * grow, y: anchor.y - (anchor.y - zoom.y) * grow }, extent);
}

/** `zoom` shifted by (dx, dy) pixels, within bounds (see clampZoom). */
export function panBy(zoom: Zoom, dx: number, dy: number, extent: Bounds): Zoom {
  return clampZoom({ ...zoom, x: zoom.x + dx, y: zoom.y + dy }, extent);
}

/** Two fingers on the map, each relative to the sun's unzoomed spot (as `anchor` is for zoomAt). */
export type Fingers = readonly [{ x: number; y: number }, { x: number; y: number }];

/**
 * `from` pinched: two fingers that were at `start` are now at `now`. It zooms
 * by how much they have spread or closed, and moves with the spot between
 * them, so what was between the fingers stays between them, within bounds
 * (see clampZoom).
 */
export function pinchZoom(from: Zoom, start: Fingers, now: Fingers, extent: Bounds): Zoom {
  const spread = ([a, b]: Fingers) => Math.hypot(b.x - a.x, b.y - a.y);
  const middle = ([a, b]: Fingers) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const [was, is] = [middle(start), middle(now)];
  const k = clamp((from.k * spread(now)) / Math.max(1, spread(start)), 1, MAX_ZOOM);
  const grow = k / from.k;
  return clampZoom({ k, x: is.x - (was.x - from.x) * grow, y: is.y - (was.y - from.y) * grow }, extent);
}

/**
 * The zoom that shows someone found with the find box, placed at `at` from
 * the sun (unzoomed): `zoom` itself if they are in `view` (a box relative to
 * the sun's unzoomed spot, as `anchor` is for zoomAt) and zoomed in at least
 * `least`; otherwise zoomed in to `least` if need be (no further than
 * MAX_ZOOM) and centred on them in `view`, as near as the bounds allow (see
 * clampZoom).
 */
export function zoomToShow(zoom: Zoom, at: { x: number; y: number }, least: number, view: Box, extent: Bounds): Zoom {
  const k = clamp(Math.max(zoom.k, least), 1, MAX_ZOOM);
  const [x, y] = [zoom.x + at.x * zoom.k, zoom.y + at.y * zoom.k];
  if (k === zoom.k && x >= view.left && x <= view.right && y >= view.top && y <= view.bottom) return zoom;
  return clampZoom({ k, x: (view.left + view.right) / 2 - at.x * k, y: (view.top + view.bottom) / 2 - at.y * k }, extent);
}

/**
 * The zoom that keeps whoever's panel is open, placed at `at` from the sun
 * (unzoomed), in `view` (a box relative to the sun's unzoomed spot, as
 * `anchor` is for zoomAt) as the panel docks over the map: `zoom` itself if
 * they are in it, otherwise shifted, at the same zoom, only as far as brings
 * them to its edge, within bounds (see clampZoom).
 */
export function panToShow(zoom: Zoom, at: { x: number; y: number }, view: Box, extent: Bounds): Zoom {
  const [x, y] = [zoom.x + at.x * zoom.k, zoom.y + at.y * zoom.k];
  const [dx, dy] = [clamp(x, view.left, view.right) - x, clamp(y, view.top, view.bottom) - y];
  if (dx === 0 && dy === 0) return zoom;
  const to = clampZoom({ ...zoom, x: zoom.x + dx, y: zoom.y + dy }, extent);
  return to.x === zoom.x && to.y === zoom.y ? zoom : to;
}

/** Part of the way, `e` from 0 to 1, from one zoom to another: evenly in how far in, so a glide between them feels steady. */
export function zoomBetween(from: Zoom, to: Zoom, e: number): Zoom {
  const k = from.k * (to.k / from.k) ** e;
  // Where the sun is on the way, scaled with the zoom, so whatever stays put at both ends stays put on the way.
  const t = from.k === to.k ? e : (k - from.k) / (to.k - from.k);
  return { k, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** Pixels per line and per page, for a wheel that counts in those (Firefox's mouse wheel). */
const LINE = 16;
const PAGE = 400;
/** How much one pixel of wheel zooms: a mouse wheel's notch is about 100, a trackpad pinch's step a few. */
const WHEEL_RATE = 0.002;
const PINCH_RATE = 0.01;
/** The most one wheel event moves, in pixels, so a fast flick zooms quickly rather than all the way at once. */
const WHEEL_MOST = 150;

/**
 * The zoom factor for one wheel event. A trackpad pinch comes as a wheel
 * event with the control key held (in Chrome and Firefox), in small steps,
 * so it zooms faster per pixel than a mouse wheel or a two-finger scroll.
 * Scrolling down (or pinching in) zooms out.
 */
export function wheelFactor(event: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  const pixels = event.deltaY * (event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? PAGE : 1);
  return Math.exp(-clamp(pixels, -WHEEL_MOST, WHEEL_MOST) * (event.ctrlKey ? PINCH_RATE : WHEEL_RATE));
}

/** The most people named at once zooming in opens room for, so naming stays quick; never fewer than `room` (see chooseNamed). */
const MOST_NAMED = 300;

/**
 * Who is named at zoom `k`, out of `order` (everyone worth naming, closest
 * first), among those `shown` (in view): unzoomed, the first `named` of
 * them, as ever; zoomed in, room opens as the square of the zoom, and so
 * does the count, the next closest in view after them filling it. `required`
 * are those among the first `named` of everyone; `optional` are the rest
 * the zoom has opened room for. Every one of either is named, in place of
 * their icon. Those `always` named (people to reach out to) are required
 * wherever they are, if shown, and on top of the budget. With `room` more
 * than `named` (Show top names' All), that many are named even unzoomed.
 */
export function chooseNamed(
  order: readonly number[],
  named: number,
  k: number,
  shown: (id: number) => boolean,
  always: ReadonlySet<number> = new Set(),
  room = named,
): { required: number[]; optional: number[] } {
  const budget = Math.max(room, Math.min(MOST_NAMED, Math.round(named * k * k)));
  const required: number[] = [];
  const optional: number[] = [];
  for (let i = 0; i < order.length && required.length + optional.length < budget; i++) {
    if (!shown(order[i])) continue;
    (i < named || always.has(order[i]) ? required : optional).push(order[i]);
  }
  const chosen = new Set([...required, ...optional]);
  for (const id of always) if (!chosen.has(id) && shown(id)) required.push(id);
  return { required, optional };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
