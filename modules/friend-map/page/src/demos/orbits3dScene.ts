// Orbits 3D's scene (Orbits3D.tsx): the same sky as Orbits (orbitsSky.ts
// places everyone), seen through the City's camera (cityCamera.ts) and given
// depth. Seen from straight above, where the view starts, it is Orbits to the
// pixel: the camera is orthographic, so a height changes nothing until the
// view tilts. As it tilts, people are spheres on orbits that lean a little
// out of the sun's plane, each by their own inclination, so the disc opens
// into a solar system. Pure functions, no DOM, so the maths can be tested on
// its own: where each person is drawn and how near the viewer, in what order
// they are painted, how far the system reaches, and where the sun lights
// each sphere from.

import { clampCamera, lift, project, squash, turn, type Camera } from "./cityCamera.ts";
import type { Box } from "./orbitsLayout.ts";
import type { Frame, XY } from "./orbitsSky.ts";

/** Where the view starts, and where the compass takes it back: straight down, north up, which is Orbits. */
export const HOME_VIEW: Camera = { bearing: 0, tilt: 0 };

/** The steepest an orbit leans out of the sun's plane, in radians: enough to show depth, not enough to tangle the rings. */
export const INCLINE_MAX = (14 * Math.PI) / 180;
/** The least an orbit leans, as a share of INCLINE_MAX, so nobody's orbit is flat. */
const INCLINE_LEAST = 0.3;

/**
 * How far someone leans out of the sun's plane, per unit of radius, and
 * where their orbit crosses the plane: both from their identicon seed, so a
 * person always leans the same way and a reload never reshuffles the sky.
 * `slope` is sin(inclination), signed; `node` the direction, in radians, of
 * the orbit's rising node.
 */
export function inclinationOf(seed: string): { slope: number; node: number } {
  // The seed is 16 hex digits: its two halves are two 32-bit numbers, enough for a lean and a node each.
  const a = parseInt(seed.slice(0, 8), 16) / 0x100000000;
  const b = parseInt(seed.slice(8, 16), 16) / 0x100000000;
  const lean = INCLINE_MAX * (INCLINE_LEAST + (1 - INCLINE_LEAST) * (Number.isFinite(a) ? a : 0.5));
  const sign = (Number.isFinite(b) ? b : 0.5) < 0.5 ? -1 : 1;
  const node = 2 * Math.PI * ((Number.isFinite(b) ? b * 2 : 1) % 1);
  return { slope: sign * Math.sin(lean), node };
}

/**
 * How high above the sun's plane someone drawn at `frame` (their direction
 * and radius, unzoomed) sits: on an orbit leaning out of the plane by their
 * inclination, highest a quarter turn past its node, as a body on an
 * inclined circular orbit is. The belt (no closeness yet) stays flat, a ring
 * round the system; so does whoever sits in the sun. Zero in the plane.
 */
export function heightOf(frame: Pick<Frame, "angle" | "r" | "silent">, incline: { slope: number; node: number }, inSun: boolean): number {
  if (frame.silent || inSun) return 0;
  return frame.r * incline.slope * Math.sin(frame.angle - incline.node);
}

/** Where a body `h` above the plane at (`x`, `y`), unzoomed and relative to the sun, is drawn once the zoom spreads it by `k`. */
export function drawnAt(camera: Camera, x: number, y: number, h: number, k: number): XY {
  return project(camera, x * k, y * k, h * k);
}

/**
 * How near the viewer a body is: greater is nearer, and painted later. From
 * straight above, that is its height; leaning in, the near side of the
 * plane comes forward.
 */
export function nearness(camera: Camera, x: number, y: number, h: number): number {
  return turn(camera, x, y).y * lift(camera) + h * squash(camera);
}

/**
 * The sun's light on a sphere at (`x`, `y`, `h`), as the screen sees it: a
 * unit vector toward the sun, x across the screen, y down it, z out of it
 * toward the viewer. The sun is at the origin, so a body on the near side
 * of it is lit from behind and shows a crescent, as a planet does.
 */
export function lightOn(camera: Camera, x: number, y: number, h: number): [number, number, number] {
  const t = turn(camera, x, y);
  const [sq, lf] = [squash(camera), lift(camera)];
  // Toward the sun, in the camera's frame: across, along the ground toward the viewer, and up.
  const [ax, ay, ah] = [-t.x, -t.y, -h];
  const [sx, sy, sz] = [ax, ay * sq - ah * lf, ay * lf + ah * sq];
  const len = Math.hypot(sx, sy, sz) || 1;
  return [sx / len, sy / len, sz / len];
}

/**
 * How much of a sphere's shading shows: none from straight above, where the
 * view is Orbits' flat discs, and all of it once the view leans this far
 * (SHADE_TILT), eased in between, so the discs round into spheres as the
 * view tilts and nothing changes until it does.
 */
export const SHADE_TILT = (25 * Math.PI) / 180;
export function shadeAt(camera: Camera): number {
  const p = Math.min(1, Math.max(0, camera.tilt / SHADE_TILT));
  return p * p * (3 - 2 * p);
}

/**
 * Everyone in the order they are painted, from the furthest from the viewer
 * to the nearest, by `nearness`; those equally near (everyone, from straight
 * above a flat plane) keep the order they came in, Orbits' own, so from
 * straight above the painting is Orbits'.
 */
export function paintOrder<T>(bodies: readonly T[], nearnessOf: (body: T) => number): T[] {
  return bodies
    .map((body, i) => ({ body, i, near: nearnessOf(body) }))
    .sort((a, b) => a.near - b.near || a.i - b.i)
    .map((b) => b.body);
}

/**
 * How far the system reaches from the sun as `camera` sees it, drawn
 * unzoomed: across, the disc everyone is on (`reach`, the belt or anyone
 * nudged beyond it); up and down, that disc squashed by the tilt, plus the
 * highest and lowest anyone leans out of the plane (`above`, `below`, both
 * as heights, so `below` is at most 0), lifted by it. A disc is the same at
 * every bearing, so this costs nothing as the camera turns, and from
 * straight above it is the disc itself.
 */
export function sceneExtent(reach: number, above: number, below: number, camera: Camera): Box {
  const [sq, lf] = [squash(camera), lift(camera)];
  return { left: -reach, right: reach, top: -reach * sq - above * lf, bottom: reach * sq - below * lf };
}

/** A circle of radius `r` in the sun's plane, as `camera` sees it: an ellipse about the sun, `r` across and `r` squashed tall. */
export function ringAxes(camera: Camera, r: number): { rx: number; ry: number } {
  return { rx: r, ry: r * squash(camera) };
}

/** `camera` clamped as the City's is (the tilt within bounds, the bearing wrapped), from this view's home. */
export const clampView = clampCamera;
