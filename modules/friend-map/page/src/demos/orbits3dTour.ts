// Orbits 3D's tours (Orbits3D.tsx): a scripted camera move, for recording a
// clip of the view. `?tour=<name>` in the address plays one as the map opens:
// the sky arrives seen from straight above, as Orbits, holds a beat, then the
// camera leans down to a low angle (fast in the middle, with a long ease-out)
// while it turns round the sun, and settles into a slow drift, so the flat
// map opens into a solar system. Any turn, zoom or pan stops it, as it stops
// a glide. Played on the page's own animation frames, so a recorder that
// steps the page's clock gets the same move every time. Pure functions, no
// DOM, so the path can be tested on its own.

import { clampCamera, type Camera } from "./cityCamera.ts";
import { HOME_VIEW } from "./orbits3dScene.ts";

/** A tour: how long it holds straight above, how long the lean takes, and where it goes, all times in ms. */
export interface Tour {
  /** How long the view holds straight above first, from when the map opens (its entrance takes 2 s). */
  hold: number;
  /** How long the lean down takes. */
  move: number;
  /** How far the camera leans, in radians from straight above. */
  tilt: number;
  /** How far the camera turns round the sun during the lean, in radians, clockwise. */
  sweep: number;
  /** How fast it goes on turning once the lean is done, in radians a second. */
  drift: number;
  /** How far it zooms in, as a factor, over `push` ms from when the lean starts (1: not at all). */
  zoom: number;
  push: number;
}

const DEG = Math.PI / 180;

/** The tours by name: a lean alone, a lean that turns round the sun and drifts on, and a lean with a slow push in. */
export const TOURS = {
  tilt: { hold: 3200, move: 2600, tilt: 62 * DEG, sweep: 0, drift: 0, zoom: 1, push: 1 },
  orbit: { hold: 3200, move: 2600, tilt: 62 * DEG, sweep: 40 * DEG, drift: 3 * DEG, zoom: 1.4, push: 4000 },
  push: { hold: 3200, move: 2600, tilt: 56 * DEG, sweep: 18 * DEG, drift: 1.5 * DEG, zoom: 2, push: 7000 },
} satisfies Record<string, Tour>;

/** The tour the address asks for (?tour=tilt, orbit or push), or none. */
export function tourOf(search: string): Tour | null {
  const name = new URLSearchParams(search).get("tour");
  return name !== null && Object.hasOwn(TOURS, name) ? TOURS[name as keyof typeof TOURS] : null;
}

/**
 * The lean's easing, 0 to 1 as `p` goes 0 to 1: at rest at both ends,
 * fastest a third of the way in, then a long ease-out (its speed is
 * 12p(1 − p)², a Beta(2, 3) curve).
 */
export function lean(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  return q * q * (6 - 8 * q + 3 * q * q);
}

/** The integral of `lean` from 0 to `p`, for 0 ≤ p ≤ 1: how far a drift has gone that speeds up as the lean does. */
function leanSum(p: number): number {
  return p * p * p * (2 - 2 * p + 0.6 * p * p);
}

/** Where a tour's camera is, and its zoom, `t` ms after the map opened. */
export function tourAt(tour: Tour, t: number): { camera: Camera; k: number } {
  const s = Math.max(0, t - tour.hold);
  const p = Math.min(1, s / tour.move);
  // The drift speeds up with the lean, so the turn's speed carries on smoothly from the sweep into the drift.
  const drifted = p < 1 ? tour.move * leanSum(p) : tour.move * leanSum(1) + (s - tour.move);
  return {
    camera: t <= tour.hold ? HOME_VIEW : clampCamera({ bearing: tour.sweep * lean(p) + (tour.drift * drifted) / 1000, tilt: tour.tilt * lean(p) }),
    k: tour.zoom ** lean(s / tour.push),
  };
}
