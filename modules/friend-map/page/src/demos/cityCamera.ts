// The camera the City (City.tsx, cityScene.ts) and Orbits 3D (Orbits3D.tsx)
// are seen through, as Google Maps' 3D view is: a bearing turns the view
// round its middle, and a tilt leans it from straight down (a map) to a low
// oblique that shows the sides of things. Here is what both views share: the
// camera, kept within bounds, the gestures that move it (a drag with the
// middle or right button or with Ctrl held, two fingers twisted or dragged up
// and down), the glide back, and Orbits 3D's orthographic projection of a
// ground point at some height. The City adds its perspective lens on top
// (cityScene.ts). Nothing here touches the DOM, so the maths can be tested on
// its own.
//
// Coordinates: the ground is a map seen from above, x to the right and y down
// as on Orbits, the middle at (0, 0); `project` turns a ground point `h`
// units up into where it is drawn, unzoomed, relative to the middle, with
// the viewer at the bottom of the screen looking in.

/** Where the view is seen from: turned `bearing` radians clockwise about its middle, and leaned `tilt` radians from straight down. */
export interface Camera {
  bearing: number;
  tilt: number;
}

/** How far the view may lean: from straight down (a map, no sides seen) to a low oblique. A view may lean further (the City does). */
export const TILT_MIN = 0;
export const TILT_MAX = (70 * Math.PI) / 180;

/** How much the ground is foreshortened, 1 straight down: a circle's height as a share of its width. */
export const squash = (camera: Camera): number => Math.cos(camera.tilt);
/** How much of a height shows: 0 straight down, nearly all at a low oblique. */
export const lift = (camera: Camera): number => Math.sin(camera.tilt);

/** `camera` with the tilt within bounds (up to `most`, TILT_MAX unless a view leans further) and the bearing wrapped to (−π, π]. */
export function clampCamera(camera: Camera, most = TILT_MAX): Camera {
  return { bearing: wrapAngle(camera.bearing), tilt: Math.min(most, Math.max(TILT_MIN, camera.tilt)) };
}

/** `a` wrapped to (−π, π]. */
export function wrapAngle(a: number): number {
  const w = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  return w <= -Math.PI ? w + 2 * Math.PI : w;
}

/** How far a mouse drag of one pixel turns (sideways) or tilts (up and down) the camera, in radians. */
export const TURN_PER_PX = Math.PI / 600;
export const TILT_PER_PX = Math.PI / 600;

/**
 * `from` after a camera drag of (`dx`, `dy`) pixels: sideways turns the view
 * round its middle the way the pointer goes (dragging the near side to the
 * right turns it that way); up leans the view further, down brings it back
 * toward straight down. Within bounds (clampCamera, up to `most`).
 */
export function turnCamera(from: Camera, dx: number, dy: number, most = TILT_MAX): Camera {
  return clampCamera({ bearing: from.bearing - dx * TURN_PER_PX, tilt: from.tilt - dy * TILT_PER_PX }, most);
}

/** Two fingers on the screen, each relative to the view's unzoomed middle. */
export type Fingers = readonly [{ x: number; y: number }, { x: number; y: number }];

/** A twist of two fingers smaller than this (radians), or a two-finger drag shorter than this (pixels), does nothing, so a pinch does not also turn or tilt. */
export const TWIST_DEADZONE = 0.05;
export const TILT_DEADZONE = 8;
/** How far a two-finger drag of one pixel up or down tilts the camera, in radians. */
export const TOUCH_TILT_PER_PX = Math.PI / 400;

/**
 * `from` after two fingers that were at `start` moved to `now`: twisting
 * them turns the view with them (a twist clockwise on the screen turns it
 * clockwise), and dragging them up or down together tilts the view (up
 * leans it further), each beyond a small deadzone so a pinch alone does
 * neither. Within bounds (clampCamera, up to `most`).
 */
export function twistCamera(from: Camera, start: Fingers, now: Fingers, most = TILT_MAX): Camera {
  const heading = ([a, b]: Fingers) => Math.atan2(b.y - a.y, b.x - a.x);
  const twist = wrapAngle(heading(now) - heading(start));
  const dy = (now[0].y + now[1].y - start[0].y - start[1].y) / 2;
  return clampCamera({
    bearing: from.bearing + beyond(twist, TWIST_DEADZONE),
    tilt: from.tilt - beyond(dy, TILT_DEADZONE) * TOUCH_TILT_PER_PX,
  }, most);
}

/** `v` past a deadzone of `dead` either way: 0 within it, and from there on counted from its edge, so nothing jumps. */
function beyond(v: number, dead: number): number {
  return Math.sign(v) * Math.max(0, Math.abs(v) - dead);
}

/** Part of the way, `e` from 0 to 1, from one camera to another, turning the short way round. */
export function cameraBetween(from: Camera, to: Camera, e: number): Camera {
  if (e >= 1) return clampCamera(to);
  return clampCamera({ bearing: from.bearing + wrapAngle(to.bearing - from.bearing) * e, tilt: from.tilt + (to.tilt - from.tilt) * e });
}

export type XY = { x: number; y: number };

/** The ground point (`x`, `y`) turned by the camera's bearing: x across the screen, y toward the viewer. */
export function turn(camera: Camera, x: number, y: number): XY {
  const [c, s] = [Math.cos(camera.bearing), Math.sin(camera.bearing)];
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Where a ground point (`x`, `y`) `h` units up is drawn, relative to the middle, unzoomed, seen orthographically (Orbits 3D). */
export function project(camera: Camera, x: number, y: number, h = 0): XY {
  const t = turn(camera, x, y);
  return { x: t.x, y: t.y * squash(camera) - h * lift(camera) };
}
