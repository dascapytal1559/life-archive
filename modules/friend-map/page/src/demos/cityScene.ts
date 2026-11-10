// The City in 3D (City.tsx): how the ground laid out in cityLayout.ts is
// built and seen. The camera is a rig, as a film crew's: it looks at a spot on
// the ground from `distance` away, turned `bearing` round it and leaned `tilt`
// from straight down (cityCamera.ts' Camera, so the compass reads it), through
// a perspective lens. Everything a pointer, a finger or the find box does to it
// is here (zoom about the spot under the pointer, drag the ground, pinch,
// glide), and so is what a frame needs from the layout: each friend's building
// as a stepped form, your tower, the roads the light runs along to the
// tower, which names are big enough to show, and what is under the pointer.
// Pure functions, no DOM or GPU, so all of it can be tested with made-up
// people; cityGl.ts draws it.
//
// Coordinates: the ground is the map of cityLayout.ts (x east, y south, the
// tower at the origin, in ground units); in the world, x is east, y is up
// and z is south (the map's y), so a ground point (x, y) is (x, 0, y).

import { clampCamera, cameraBetween, wrapAngle, type Camera } from "./cityCamera.ts";
import { avenues as avenueRoads, BOULEVARD_ANGLES, PLAZA, type CityLayout, type Plot } from "./cityLayout.ts";

/** The city's size in ground units, the same on every screen (the camera frames it): its radius and the closest building's distance. */
export const OUTER = 480;
export const INNER = OUTER * 0.16;
/** How tall the city is built, as a share of the layout's heights: low, massive forms rather than needles; every friend's alike, so taller still means closer. Your tower is built at the layout's full height, so it stands over them all. */
export const HEIGHT_SCALE = 0.6;
export const TOWER_SCALE = 1;

export type Vec3 = [number, number, number];
export type XY = { x: number; y: number };

/** The camera: the ground spot it looks at (`x`, `y`, on the map), how far away it is, and how it is turned and leaned (Camera). */
export interface Rig extends Camera {
  x: number;
  y: number;
  distance: number;
}

/** The canvas the city is drawn on, in CSS pixels, and how much of its top the header covers (the city is centred in the rest). */
export interface View {
  width: number;
  height: number;
  top: number;
}

/** The lens: its vertical field of view, a little long, as a film camera's, so the city keeps its shape. */
export const FOV = (34 * Math.PI) / 180;
/** How far the City leans: from straight down to nearly level with the street, lower than Orbits 3D goes. */
export const TILT_MOST = (80 * Math.PI) / 180;
/**
 * How the city is first seen: north up, looking up the south boulevard at
 * your tower, leaned 64° (26° above the street); on a screen taller than it
 * is wide (a phone held upright), from higher up, at 50°, so the city fills
 * more of the height.
 */
export const HOME_BEARING = 0;
export const HOME_TILT = (64 * Math.PI) / 180;
export const UPRIGHT_TILT = (50 * Math.PI) / 180;

/** The camera's turn and lean as the city is first seen on `view`. */
export function homeCamera(view: Pick<View, "width" | "height">): Camera {
  return { bearing: HOME_BEARING, tilt: view.width < view.height ? UPRIGHT_TILT : HOME_TILT };
}
/** How far in a zoom may go, as a share of the home distance, and how far out. */
export const ZOOM_MOST = 18;
export const ZOOM_LEAST = 0.6;

/** The camera kept within bounds: leaned no further than TILT_MOST, turned round the circle. */
export const clampTurn = (camera: Camera): Camera => clampCamera(camera, TILT_MOST);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Where the camera is in the world. */
export function eyeOf(rig: Rig): Vec3 {
  const across = Math.sin(rig.tilt) * rig.distance;
  return [rig.x + Math.sin(rig.bearing) * across, Math.cos(rig.tilt) * rig.distance, rig.y + Math.cos(rig.bearing) * across];
}

/**
 * The camera's axes in the world: `right` across the screen, `up` up it and
 * `forward` into it. Turned by the bearing as cityCamera's turn() turns the
 * map, so the compass and the drag read the same as they always have; straight
 * down, north is up the screen.
 */
export function axesOf(rig: Camera): { right: Vec3; up: Vec3; forward: Vec3 } {
  const [sb, cb, st, ct] = [Math.sin(rig.bearing), Math.cos(rig.bearing), Math.sin(rig.tilt), Math.cos(rig.tilt)];
  const forward: Vec3 = [-st * sb, -ct, -st * cb];
  const right: Vec3 = [cb, 0, -sb];
  return { right, up: cross(right, forward), forward };
}

/** How far up the screen the target is lifted from the canvas's middle, in normalised device units, so it sits in the middle of the space under the header. */
function lensShift(view: View): number {
  const centre = view.top + (view.height - view.top) / 2;
  return 1 - (2 * centre) / view.height;
}

/** The near and far planes for a rig: near enough to come close to a building, far enough for the ground to reach the mist. */
export function clipOf(rig: Rig): { near: number; far: number } {
  return { near: Math.min(20, Math.max(0.5, rig.distance * 0.01)), far: rig.distance * 4 + OUTER * 8 };
}

/** The view and projection matrices (column-major, as WebGL takes them) and the camera's place. */
export function matricesOf(rig: Rig, view: View): { view: Float32Array; projection: Float32Array; eye: Vec3 } {
  const eye = eyeOf(rig);
  const { right: r, up: u, forward: f } = axesOf(rig);
  const viewM = new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
  const { near, far } = clipOf(rig);
  const g = 1 / Math.tan(FOV / 2);
  const aspect = view.width / Math.max(1, view.height);
  const projection = new Float32Array([
    g / aspect, 0, 0, 0,
    0, g, 0, 0,
    0, -lensShift(view), (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
  return { view: viewM, projection, eye };
}

/** Where a world point is drawn, in CSS pixels on the canvas, and how far in front of the camera it is (negative behind it). */
export function project(rig: Rig, view: View, p: Vec3): { x: number; y: number; depth: number } {
  const { right, up, forward } = axesOf(rig);
  const d = sub(p, eyeOf(rig));
  const depth = dot(d, forward);
  const g = 1 / Math.tan(FOV / 2);
  const aspect = view.width / Math.max(1, view.height);
  const nx = (g / aspect) * (dot(d, right) / depth);
  const ny = g * (dot(d, up) / depth) + lensShift(view);
  return { x: ((nx + 1) / 2) * view.width, y: ((1 - ny) / 2) * view.height, depth };
}

/** How many CSS pixels one ground unit spans at `depth` in front of the camera. */
export function pixelsPerUnit(view: View, depth: number): number {
  return view.height / (2 * Math.tan(FOV / 2) * Math.max(1e-6, depth));
}

/** The ray from the camera through a spot on the canvas (CSS pixels). */
export function rayAt(rig: Rig, view: View, px: number, py: number): { origin: Vec3; dir: Vec3 } {
  const { right, up, forward } = axesOf(rig);
  const t = Math.tan(FOV / 2);
  const aspect = view.width / Math.max(1, view.height);
  const nx = (2 * px) / view.width - 1;
  const ny = 1 - (2 * py) / view.height - lensShift(view);
  const a = nx * t * aspect;
  const b = ny * t;
  const dir: Vec3 = [forward[0] + right[0] * a + up[0] * b, forward[1] + right[1] * a + up[1] * b, forward[2] + right[2] * a + up[2] * b];
  const n = Math.hypot(...dir);
  return { origin: eyeOf(rig), dir: [dir[0] / n, dir[1] / n, dir[2] / n] };
}

/** The ground point under a spot on the canvas, or null where the ray goes over the horizon (or too nearly along the ground to count). */
export function groundAt(rig: Rig, view: View, px: number, py: number): XY | null {
  const { origin, dir } = rayAt(rig, view, px, py);
  if (dir[1] > -0.02) return null;
  const t = -origin[1] / dir[1];
  return { x: origin[0] + dir[0] * t, y: origin[2] + dir[2] * t };
}

/** How far from the tower the camera's spot may wander: as far as anyone stands. */
export function reachOf(layout: CityLayout): number {
  let reach = INNER;
  for (const plot of layout.plots.values()) reach = Math.max(reach, plot.r + plot.s);
  return reach;
}

/**
 * How far away the camera stands, as first seen, to show the whole city in
 * `view`: every avenue (or the closest few, with none), with the tower's top,
 * inside the space under the header, a little in from its edges; on an
 * upright screen the outermost avenue may run a little off the sides. The
 * far outskirts may sink into the mist.
 */
export function homeDistance(layout: CityLayout, view: View, camera: Camera = homeCamera(view)): number {
  const all = Math.max(INNER * 1.6, ...layout.avenues.map((a) => a.r), Math.min(reachOf(layout), OUTER));
  const ring = view.width < view.height ? all * 0.82 : all;
  const points: Vec3[] = [[0, layout.tower.h * TOWER_SCALE * CROWN_TOP, 0]];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    points.push([Math.cos(a) * ring, 0, Math.sin(a) * ring]);
  }
  const margin = { x: 0.04 * view.width, top: view.top + 0.04 * view.height, bottom: 0.96 * view.height };
  const fits = (distance: number) => {
    const rig = { ...camera, x: 0, y: 0, distance };
    return points.every((p) => {
      const s = project(rig, view, p);
      return s.depth > 0 && s.x >= margin.x && s.x <= view.width - margin.x && s.y >= margin.top && s.y <= margin.bottom;
    });
  };
  let [lo, hi] = [ring * 0.2, ring * 40];
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The camera as the city is first seen on `view`: on the tower, at the home distance. */
export function homeRig(home: number, view: Pick<View, "width" | "height"> = { width: 1, height: 0 }): Rig {
  return { ...homeCamera(view), x: 0, y: 0, distance: home };
}

/** `rig` within bounds: zoomed between ZOOM_LEAST and ZOOM_MOST of `home`, its spot within `reach` of the tower, leaned within TILT_MOST. */
export function clampRig(rig: Rig, home: number, reach: number): Rig {
  const distance = Math.min(home / ZOOM_LEAST, Math.max(home / ZOOM_MOST, rig.distance));
  const r = Math.hypot(rig.x, rig.y);
  const k = r > reach ? reach / r : 1;
  return { ...clampTurn(rig), x: rig.x * k, y: rig.y * k, distance };
}

/** How far in the camera is, as Orbits counts a zoom: 1 as first seen, 2 at half the distance. */
export const zoomOf = (rig: Rig, home: number): number => home / rig.distance;

/**
 * `rig` zoomed in by `factor` (out, below 1) about the ground point `anchor`,
 * which stays under the same spot on the screen: the camera and its spot both
 * move toward the anchor by the same share, so the ray through it is the same.
 */
export function zoomRig(rig: Rig, factor: number, anchor: XY): Rig {
  return { ...rig, x: anchor.x + (rig.x - anchor.x) / factor, y: anchor.y + (rig.y - anchor.y) / factor, distance: rig.distance / factor };
}

/** `rig` moved along the ground so that the ground point `from` comes to where `to` is now: a drag of the ground. */
export function panRig(rig: Rig, from: XY, to: XY): Rig {
  return { ...rig, x: rig.x + from.x - to.x, y: rig.y + from.y - to.y };
}

/** Part of the way, `e` from 0 to 1, from one rig to another: the turn the short way round, the distance evenly in its logarithm (so a zoom glides at an even pace). */
export function rigBetween(from: Rig, to: Rig, e: number): Rig {
  if (e >= 1) return to;
  const camera = cameraBetween(from, to, e);
  return {
    bearing: camera.bearing,
    tilt: from.tilt + (to.tilt - from.tilt) * e,
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    distance: Math.exp(Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * e),
  };
}

/** `shown` a step of `dt` seconds closer to `goal`, eased with time constant `tau` (0: at once): how the camera follows the wheel and the keys smoothly. */
export function easeRig(shown: Rig, goal: Rig, dt: number, tau: number): Rig {
  if (tau <= 0) return goal;
  const e = 1 - Math.exp(-dt / tau);
  const next = rigBetween(shown, goal, e);
  return rigsClose(next, goal) ? goal : next;
}

/** Whether two rigs are the same to the eye. */
export function rigsClose(a: Rig, b: Rig): boolean {
  return Math.abs(wrapAngle(a.bearing - b.bearing)) < 1e-4 && Math.abs(a.tilt - b.tilt) < 1e-4
    && Math.hypot(a.x - b.x, a.y - b.y) < 1e-3 * a.distance && Math.abs(Math.log(a.distance / b.distance)) < 1e-4;
}

/** How fast the camera drifts round the city at rest, in radians a second: once round in about five minutes, slow enough to read by. */
export const DRIFT = (2 * Math.PI) / 300;
/** How long the camera must be left alone before it drifts, and how long the drift takes to come up to speed, in ms. */
export const DRIFT_AFTER_MS = 6000;
export const DRIFT_RAMP_MS = 2500;

/** How fast the camera drifts `idle` ms after it was last moved, in radians a second: none at first, then easing up to DRIFT. */
export function driftSpeed(idle: number): number {
  const p = Math.min(1, Math.max(0, (idle - DRIFT_AFTER_MS) / DRIFT_RAMP_MS));
  return DRIFT * p * p * (3 - 2 * p);
}

/** Where a camera glides from as the city first appears: further out, lower and turned a little, so the opening is a slow push in. */
export function introRig(home: Rig): Rig {
  return { ...home, bearing: home.bearing - 0.42, tilt: Math.min(TILT_MOST, home.tilt + 0.16), distance: home.distance * 1.55 };
}

/**
 * Where the camera goes to show the ground point `at`: there, as close as
 * `wanted` (but never further out than it is), unless it is already in view,
 * within `margin` pixels of the edges, and seen from no further than `wanted`.
 */
export function rigShowing(rig: Rig, view: View, at: Vec3, wanted: number, margin: number): Rig {
  const s = project(rig, view, at);
  const inView = s.depth > 0 && s.x >= margin && s.x <= view.width - margin && s.y >= view.top + margin && s.y <= view.height - margin;
  if (inView && rig.distance <= wanted * 1.05) return rig;
  return { ...rig, x: at[0], y: at[2], distance: Math.min(rig.distance, wanted) };
}

// The buildings.

/**
 * A building as built: where it stands (x, z), which way it faces (its local
 * x axis along `facing`, out from the tower, so one face looks at the
 * tower), half the side of its base square (`half`: the footprint's
 * half-diagonal over √2, so the base covers what the layout gave it), its
 * height, and its tiers: each a square `scale` of the base wide, up to `tops`
 * (a share of the height), stepping in as it rises. `seed` varies the details.
 */
export interface Form {
  id: number;
  x: number;
  z: number;
  facing: number;
  half: number;
  h: number;
  scales: number[];
  tops: number[];
  seed: number;
}

/** The most tiers a form has (the shader takes four). */
export const TIERS_MOST = 4;

/** A number from 0 to 1 for `id` and `salt`, the same every time: what varies one building's details from the next. */
export function hashOf(id: number, salt = 0): number {
  let h = (Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Someone's building as a stepped form: the base exactly their footprint and
 * the top exactly their height (HEIGHT_SCALE of the layout's), so what the
 * layout says still reads; in between it steps in, more the more slender it
 * is: a low slab is one block, a mid-rise two, a tower three, each setback a
 * little different from the next building's.
 */
export function formOf(plot: Plot): Form {
  const half = plot.s / Math.SQRT2;
  const h = plot.h * HEIGHT_SCALE;
  const slender = h / Math.max(1e-6, 2 * half);
  const [a, b, c, d] = [hashOf(plot.id, 1), hashOf(plot.id, 2), hashOf(plot.id, 3), hashOf(plot.id, 4)];
  let scales: number[];
  let tops: number[];
  if (slender < 1.1) {
    scales = [1];
    tops = [1];
  } else if (slender < 2.6) {
    scales = [1, 0.72 + 0.12 * a];
    tops = [0.55 + 0.2 * b, 1];
  } else {
    const second = 0.76 + 0.1 * a;
    scales = [1, second, second - 0.18 - 0.08 * c];
    tops = [0.4 + 0.15 * b, 0.74 + 0.1 * d, 1];
  }
  return { id: plot.id, x: plot.x, z: plot.y, facing: plot.angle, half, h, scales, tops, seed: hashOf(plot.id, 5) };
}

/**
 * Your tower as built, in two forms: the podium, a broad stepped base filling
 * the plaza, and the shaft above it, its faces square to the boulevards (so
 * each boulevard runs straight at a face and its glowing core), with a crown
 * and a spire. The layout's height is the shaft's top before the crown;
 * whoever lives with you has their floors on the shaft.
 */
export function towerForms(layout: CityLayout, inner = INNER): { podium: Form; shaft: Form } {
  const shaftHalf = layout.tower.s / Math.SQRT2;
  const h = layout.tower.h * TOWER_SCALE;
  // The podium's corners stay inside the plaza.
  const podiumHalf = Math.max(shaftHalf * 1.2, (inner * PLAZA * 0.94) / Math.SQRT2);
  const step = podiumHalf * 0.09;
  const podium: Form = {
    id: -2, x: 0, z: 0, facing: 0, half: podiumHalf, h: h * PODIUM_SHARE,
    scales: [1, (podiumHalf - step) / podiumHalf, (podiumHalf - 2 * step) / podiumHalf, (podiumHalf - 3 * step) / podiumHalf],
    tops: [0.34, 0.6, 0.82, 1], seed: 0.5,
  };
  const shaft: Form = { id: -1, x: 0, z: 0, facing: 0, half: shaftHalf, h: h * CROWN_TOP, scales: [1, 0.74, 0.3], tops: [1 / CROWN_TOP, 1.07 / CROWN_TOP, 1], seed: 0.5 };
  return { podium, shaft };
}

/** The podium's height as a share of the tower's, and the spire's top. */
export const PODIUM_SHARE = 0.1;
export const CROWN_TOP = 1.2;

/** A tier of a form as a box: its middle on the ground, facing, half side, bottom and top. */
export function tierBoxes(form: Form): Array<{ half: number; bottom: number; top: number }> {
  return form.scales.map((scale, i) => ({ half: form.half * scale, bottom: i === 0 ? 0 : form.tops[i - 1] * form.h, top: form.tops[i] * form.h }));
}

/** Where a ray first meets one of a form's tiers (how far along the ray), or null. `rise` is how far it has risen out of the ground, 0 to 1. */
export function hitForm(ray: { origin: Vec3; dir: Vec3 }, form: Form, rise = 1): number | null {
  // Into the form's own frame: its foot at the origin, its x axis along `facing`.
  const [c, s] = [Math.cos(form.facing), Math.sin(form.facing)];
  const [ox, oz] = [ray.origin[0] - form.x, ray.origin[2] - form.z];
  const o: Vec3 = [ox * c + oz * s, ray.origin[1], -ox * s + oz * c];
  const d: Vec3 = [ray.dir[0] * c + ray.dir[2] * s, ray.dir[1], -ray.dir[0] * s + ray.dir[2] * c];
  let best: number | null = null;
  for (const box of tierBoxes(form)) {
    const lo: Vec3 = [-box.half, box.bottom * rise, -box.half];
    const hi: Vec3 = [box.half, box.top * rise, box.half];
    let [near, far] = [0, Infinity];
    let missed = false;
    for (let axis = 0; axis < 3 && !missed; axis++) {
      if (Math.abs(d[axis]) < 1e-12) {
        if (o[axis] < lo[axis] || o[axis] > hi[axis]) missed = true;
        continue;
      }
      let t1 = (lo[axis] - o[axis]) / d[axis];
      let t2 = (hi[axis] - o[axis]) / d[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      near = Math.max(near, t1);
      far = Math.min(far, t2);
      if (near > far) missed = true;
    }
    if (!missed && (best === null || near < best)) best = near;
  }
  return best;
}

/** What a ray hits first among `forms` (each risen `rise` of the way): whose, and the point it hits. */
export function pickAlong(ray: { origin: Vec3; dir: Vec3 }, forms: Iterable<Form>, rise: (form: Form) => number = () => 1): { id: number; at: Vec3 } | null {
  let best: { id: number; t: number } | null = null;
  for (const form of forms) {
    const t = hitForm(ray, form, rise(form));
    if (t !== null && (!best || t < best.t)) best = { id: form.id, t };
  }
  if (!best) return null;
  const { origin: o, dir: d } = ray;
  return { id: best.id, at: [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t] };
}

/** The nearest building's foot to a spot on the canvas within `reach` pixels (and its own drawn size), so the smallest are easy to catch. */
export function nearestFoot(rig: Rig, view: View, forms: Iterable<Form>, px: number, py: number, reach: number): number | null {
  let best: { id: number; d: number } | null = null;
  for (const form of forms) {
    const foot = project(rig, view, [form.x, 0, form.z]);
    if (foot.depth <= 0) continue;
    const d = Math.hypot(foot.x - px, foot.y - py);
    if (d <= reach + form.half * pixelsPerUnit(view, foot.depth) && (!best || d < best.d)) best = { id: form.id, d };
  }
  return best?.id ?? null;
}

/** Which floor of the tower a height (world units) is on, by the floors' bottoms and tops (the layout's, before TOWER_SCALE). */
export function floorAt(layout: CityLayout, height: number): number | null {
  const at = height / TOWER_SCALE;
  return layout.tower.floors.find((f) => at >= f.bottom && at < f.top)?.id ?? null;
}

// The light on the roads.

/** The ring road round the plaza, where the light from the closest comes on to the boulevards. */
export const plazaRing = (inner = INNER) => inner * PLAZA;

/** A route along the roads, as a polyline on the ground, with its length. */
export interface Route {
  points: XY[];
  length: number;
}

/** How far apart the points of a route's curves are, in ground units. */
const ROUTE_STEP = 4;

/**
 * The way the light from someone's building runs to your tower, along the
 * roads: in from the building to the ring road just inside it (the avenue
 * their band starts at, or the plaza's ring for the closest), round that to
 * the nearest boulevard, and down the boulevard to the tower's foot. `lane`,
 * 0 to 1, sets it a little to one side, so lights on the same road do not run
 * on one line; on a boulevard the light keeps to the side it came in on.
 */
export function routeOf(plot: Plot, layout: CityLayout, lane: number, inner = INNER): Route {
  const ring = Math.max(plazaRing(inner), ...layout.avenues.filter((a) => a.r < plot.r - plot.s).map((a) => a.r));
  const offset = (lane - 0.5) * 3;
  const r1 = ring + offset;
  // The nearest boulevard, and which way round.
  let target = BOULEVARD_ANGLES[0];
  for (const b of BOULEVARD_ANGLES) if (Math.abs(wrapAngle(b - plot.angle)) < Math.abs(wrapAngle(target - plot.angle))) target = b;
  const turn = wrapAngle(target - plot.angle);
  const side = turn >= 0 ? -1 : 1;
  const across = 2.2 + 3.2 * lane;
  // Round the ring to the boulevard's edge on the side the light comes from.
  const stop = target + side * Math.asin(Math.min(0.9, across / Math.max(1, r1)));
  const points: XY[] = [];
  const at = (angle: number, r: number) => ({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  points.push(at(plot.angle, Math.max(r1, plot.r - plot.s)));
  points.push(at(plot.angle, r1));
  const sweep = wrapAngle(stop - plot.angle);
  const steps = Math.max(1, Math.ceil((Math.abs(sweep) * r1) / ROUTE_STEP));
  for (let i = 1; i <= steps; i++) points.push(at(plot.angle + (sweep * i) / steps, r1));
  // Down the boulevard, `across` to the side, to the tower's podium.
  const [c, s] = [Math.cos(target), Math.sin(target)];
  const [nx, ny] = [-s * side, c * side];
  const end = layout.tower.s * 0.95 + 4;
  const along = Math.sqrt(Math.max(0, r1 * r1 - across * across));
  points.push({ x: c * along + nx * across, y: s * along + ny * across });
  points.push({ x: c * end + nx * across, y: s * end + ny * across });
  return { points, length: lengthOf(points) };
}

function lengthOf(points: readonly XY[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return length;
}

/** The stretch of a route from `from` to `to` (ground units along it), as a polyline. */
export function stretchOf(route: Route, from: number, to: number): XY[] {
  const out: XY[] = [];
  let walked = 0;
  const [a, b] = [Math.max(0, from), Math.min(route.length, to)];
  if (b <= a) return out;
  for (let i = 1; i < route.points.length; i++) {
    const [p, q] = [route.points[i - 1], route.points[i]];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const [s0, s1] = [walked, walked + len];
    walked = s1;
    if (s1 < a || len === 0) continue;
    if (s0 > b) break;
    const point = (s: number) => ({ x: p.x + ((q.x - p.x) * (s - s0)) / len, y: p.y + ((q.y - p.y) * (s - s0)) / len });
    if (out.length === 0) out.push(point(Math.max(a, s0)));
    out.push(point(Math.min(b, s1)));
  }
  return out;
}

/** How fast the light runs along the roads, in ground units a second, and how long a light is. */
export const TRAFFIC_SPEED = 110;
export const TRAFFIC_TAIL = 46;

// Names.

/**
 * How strongly a name shows for its building's size on the screen: none
 * while the building (`footPx` across at its foot) is small beside the name
 * (`textPx` wide), fading in as it grows, so zooming in names more and more
 * of the city and far, small buildings carry none until you come close.
 */
export function nameReadable(footPx: number, textPx: number): number {
  const p = Math.min(1, Math.max(0, (footPx / Math.max(1, textPx) - NAME_FIT_FROM) / (NAME_FIT_TO - NAME_FIT_FROM)));
  return p * p * (3 - 2 * p);
}
export const NAME_FIT_FROM = 0.2;
export const NAME_FIT_TO = 0.38;

/** A name's box on the screen, CSS pixels from its middle. */
export interface NameBox {
  x: number;
  y: number;
  wide: number;
  tall: number;
}

/**
 * Which names to draw so none covers another: in the order given (the most
 * important first: whoever is picked out, then the closest), each kept unless
 * its box, `pad` pixels larger all round, meets one kept already.
 */
export function declutter(boxes: readonly NameBox[], pad = 2): boolean[] {
  const kept: NameBox[] = [];
  return boxes.map((b) => {
    const meets = kept.some((k) => Math.abs(k.x - b.x) < k.wide + b.wide + pad && Math.abs(k.y - b.y) < k.tall + b.tall + pad);
    if (!meets) kept.push(b);
    return !meets;
  });
}

/** The avenues' labels: where each crosses the south boulevard, on the ground. */
export function avenueLabels(layout: CityLayout): Array<{ rank: number; label: string; at: Vec3 }> {
  return layout.avenues.map((a) => ({ rank: a.rank, label: a.label.toUpperCase(), at: [0, 0, a.r] }));
}

/** The avenues as they would be for `count` people (the Legend's list), at the City's own size. */
export function avenuesFor(count: number, together: number) {
  return avenueRoads(count, INNER, OUTER, together);
}

// How hard the GPU works.

/**
 * How much the City draws, by the screen: on a phone (or anything held in
 * the hand) fewer pixels, a smaller reflection, fewer bloom levels and fewer
 * steps through the mist; on a computer the screen's own pixels up to 2×.
 * `scale` is the share of the screen's pixels drawn, which the frame timer
 * may lower further where frames run slow.
 */
export interface Quality {
  name: "full" | "lite";
  pixelRatio: number;
  reflection: number;
  bloomLevels: number;
  mistSteps: number;
  grain: boolean;
}

export function qualityFor(phone: boolean, devicePixelRatio: number): Quality {
  if (phone) return { name: "lite", pixelRatio: Math.min(devicePixelRatio, 1.5), reflection: 0.35, bloomLevels: 4, mistSteps: 4, grain: false };
  return { name: "full", pixelRatio: Math.min(devicePixelRatio, 2), reflection: 0.5, bloomLevels: 6, mistSteps: 8, grain: true };
}

/** The lowest share of the quality's pixels the frame timer goes down to, and the frame time it aims under, in ms. */
export const SCALE_LEAST = 0.55;
export const FRAME_BUDGET_MS = 19;

/**
 * The next pixel scale for the frame timer, from the average frame time over
 * the last stretch: a step down when frames run over budget, a step back up
 * when there is plenty of room, never below SCALE_LEAST or above 1.
 */
export function nextScale(scale: number, averageMs: number): number {
  if (averageMs > FRAME_BUDGET_MS) return Math.max(SCALE_LEAST, scale * 0.85);
  if (averageMs < FRAME_BUDGET_MS * 0.55) return Math.min(1, scale / 0.9);
  return scale;
}
