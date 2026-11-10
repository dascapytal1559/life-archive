// An activity's playback as time (../../wire.ts's PlaybackTrack, from the server's playback.ts): where the marker is at
// each moment, which way it is heading, and what the readouts say there. Pure, so its motion can be tested.
//
// Motion is what matters (a marker that jumps a metre each second looks broken), so:
//   - the recorder's pauses (a gap over 30 s between two points, the watch stopped) are cut to a second, so the
//     playback never sits still for a stop it did not record; a stop it recorded (a red light) is played as it was;
//   - the route is smoothed (a Gaussian over a few seconds' points) to take out the GPS's wander, and drawn as smoothed,
//     so the marker is always on the line;
//   - the marker moves along it by a distance that is a smooth function of time (a monotone cubic through each point's
//     distance at its time: no speed jumps at each sample, and never backwards), so it glides rather than ticks.
// The readouts are the recording's own at the moment shown: the distance so far, the speed over ten seconds about it,
// the trusted heart rate and its zone, and the altitude.

import type { PlaybackTrack } from "../../wire.ts";

/** A gap longer than this between two points is the recorder paused, cut to PAUSE_KEPT_S in the playback. */
export const PAUSE_S = 30;
export const PAUSE_KEPT_S = 1;

/** Less than this further between two points, by the recording's distance, is standing still. */
const STILL_M = 0.3;

/** The smoothing's spread, in points (a point a second, the recorders' usual). */
const SMOOTH_SIGMA = 2;

const EARTH_M = 6_371_000;
const RAD = Math.PI / 180;

/** What the playback shows at one moment. */
export interface Frame {
  /** The playback's own time, seconds (pauses cut). */
  at: number;
  lng: number;
  lat: number;
  /** The way of travel, degrees clockwise from north. */
  heading: number;
  /** The share of the drawn line behind the marker, by its length on the map (as MapLibre's line-progress measures). */
  progress: number;
  /** The line's segment the marker is on: from its point `index` to the next, `share` of the way along. */
  index: number;
  share: number;
  /** Seconds from the start, as the recorder counted (the pauses whole). */
  elapsed: number;
  distance: number;
  /** Metres a second, over the ten seconds about the moment. */
  speed: number;
  heartRate: number | null;
  zone: number | null;
  altitude: number | null;
}

export interface Timeline {
  /** The playback's length, seconds (pauses cut). */
  duration: number;
  /** The route as drawn, [lng, lat], smoothed. */
  line: Array<[number, number]>;
  /** Its box, [west, south, east, north]. */
  bounds: [number, number, number, number];
  /** The distance the readouts end at, metres. */
  totalDistance: number;
  /** The moment `at` (clamped to the playback). */
  frameAt(at: number): Frame;
  /** The point `ahead` metres further along the line from the one at `at` (behind, when negative). */
  pointAhead(at: number, ahead: number): [number, number];
}

/** The index of the last of `xs` (ascending) at or before `x`, within [0, xs.length - 2]. */
function segment(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (x <= xs[0]) return 0;
  if (x >= xs[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Linear interpolation of `ys` over `xs` at `x`, clamped at the ends. */
export function lerpAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  if (xs.length === 1) return ys[0];
  const i = segment(xs, x);
  const span = xs[i + 1] - xs[i];
  const u = span <= 0 ? 0 : Math.min(1, Math.max(0, (x - xs[i]) / span));
  return ys[i] + (ys[i + 1] - ys[i]) * u;
}

/** Further than this from a heart-rate reading on either side (a strap's dropout), there is no heart rate. */
export const HEART_GAP_S = 30;

/** The heart rate of the readings (`ts`, ascending, and `vs`) at `t`: along the line between the two about it; null in a gap. */
export function heartRateAt(ts: ArrayLike<number>, vs: ArrayLike<number>, t: number): number | null {
  const n = ts.length;
  if (n === 0) return null;
  if (t <= ts[0]) return ts[0] - t <= HEART_GAP_S ? vs[0] : null;
  if (t >= ts[n - 1]) return t - ts[n - 1] <= HEART_GAP_S ? vs[n - 1] : null;
  const i = segment(ts, t);
  return ts[i + 1] - ts[i] > HEART_GAP_S ? null : lerpAt(ts, vs, t);
}

/**
 * A monotone cubic (Fritsch-Carlson) through (xs, ys), ys never falling: smooth, and never overshooting, so a
 * distance over time made of it never runs backwards nor creeps during a stop.
 */
export function monotoneCubic(xs: ArrayLike<number>, ys: ArrayLike<number>): (x: number) => number {
  const n = xs.length;
  if (n < 2) return () => ys[0] ?? 0;
  const slopes = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) slopes[i] = xs[i + 1] > xs[i] ? (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) : 0;
  const tangents = new Float64Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) tangents[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      tangents[i] = k * a * slopes[i];
      tangents[i + 1] = k * b * slopes[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    const i = segment(xs, x);
    const h = xs[i + 1] - xs[i];
    if (h <= 0) return ys[i];
    const u = (x - xs[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * tangents[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * tangents[i + 1];
  };
}

/** Each point's time in the playback: the recording's, its pauses (gaps over PAUSE_S) cut to PAUSE_KEPT_S. */
export function playbackTimes(t: readonly number[]): Float64Array {
  const out = new Float64Array(t.length);
  for (let i = 1; i < t.length; i++) {
    const dt = Math.max(0, t[i] - t[i - 1]);
    out[i] = out[i - 1] + (dt > PAUSE_S ? PAUSE_KEPT_S : dt);
  }
  return out;
}

/** `values` smoothed by a Gaussian of `sigma` points, the window shrinking at the ends so the first and last stay put. */
export function smoothed(values: ArrayLike<number>, sigma = SMOOTH_SIGMA): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const reach = Math.ceil(sigma * 3);
  const weights = Array.from({ length: reach + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    const r = Math.min(reach, i, n - 1 - i);
    let sum = 0;
    let total = 0;
    for (let k = -r; k <= r; k++) {
      sum += values[i + k] * weights[Math.abs(k)];
      total += weights[Math.abs(k)];
    }
    out[i] = sum / total;
  }
  return out;
}

/** Web Mercator's y of a latitude (unscaled), as MapLibre measures a line's length on the map. */
const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

/** The heart-rate zone of `bpm` by the zones' lower limits (lowest first); null below them all, or with none. */
export function zoneOf(bpm: number | null, zones: PlaybackTrack["zones"]): number | null {
  if (bpm === null) return null;
  let found: number | null = null;
  for (const z of zones) if (bpm >= z.from) found = z.zone;
  return found;
}

/** The timeline of a playback. */
export function timelineOf(track: PlaybackTrack): Timeline {
  const { t, lat, lon, distance, altitude } = track.points;
  const n = t.length;
  const times = playbackTimes(t);
  const duration = times[n - 1];

  // The route in metres about its first point, smoothed, then back to degrees. While the recording says he stood still
  // (its distance did not grow), the point is held where he stopped, so the GPS's wander at a red light is not played.
  const lat0 = lat[0];
  const kx = EARTH_M * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_M * RAD;
  const rawX = new Float64Array(n);
  const rawY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const still = i > 0 && distance[i] - distance[i - 1] < STILL_M;
    rawX[i] = still ? rawX[i - 1] : (lon[i] - lon[0]) * kx;
    rawY[i] = still ? rawY[i - 1] : (lat[i] - lat0) * ky;
  }
  const xs = smoothed(rawX);
  const ys = smoothed(rawY);
  const line: Array<[number, number]> = Array.from({ length: n }, (_, i) => [lon[0] + xs[i] / kx, lat0 + ys[i] / ky]);

  // The length along the smoothed line, in metres (for the motion) and on the map (for the line's progress).
  const along = new Float64Array(n);
  const onMap = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    along[i] = along[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    onMap[i] = onMap[i - 1] + Math.hypot((line[i][0] - line[i - 1][0]) * RAD, mercatorY(line[i][1]) - mercatorY(line[i - 1][1]));
  }
  const mapLength = onMap[n - 1] || 1;
  const lengthAt = monotoneCubic(times, along);

  const pointAt = (s: number): { i: number; u: number } => {
    const i = segment(along, s);
    const span = along[i + 1] - along[i];
    return { i, u: span <= 0 ? 0 : Math.min(1, Math.max(0, (s - along[i]) / span)) };
  };
  const position = (s: number): [number, number] => {
    if (n === 1) return line[0];
    const { i, u } = pointAt(s);
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * u, line[i][1] + (line[i + 1][1] - line[i][1]) * u];
  };
  const bearing = (from: [number, number], to: [number, number]) => {
    const dx = (to[0] - from[0]) * kx;
    const dy = (to[1] - from[1]) * ky;
    return (Math.atan2(dx, dy) / RAD + 360) % 360;
  };

  const beats = track.heartRate ?? [];
  const beatT = beats.map(([bt]) => bt);
  const beatV = beats.map(([, v]) => v);
  const lngs = line.map(([x]) => x);
  const lats = line.map(([, y]) => y);

  return {
    duration,
    line,
    bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    totalDistance: distance[n - 1],
    pointAhead: (at, ahead) => position(Math.min(along[n - 1], Math.max(0, lengthAt(at) + ahead))),
    frameAt(at) {
      const clamped = Math.min(duration, Math.max(0, at));
      const s = lengthAt(clamped);
      const [lng, latAt] = position(s);
      // The heading: the line about the marker, a little behind to well ahead, so a wiggle in the line does not swing it.
      const heading = bearing(position(Math.max(0, s - 15)), position(Math.min(along[n - 1], s + 40)));
      const { i, u } = pointAt(s);
      const progress = n === 1 ? 0 : (onMap[i] + (onMap[i + 1] - onMap[i]) * u) / mapLength;
      const elapsed = lerpAt(times, t, clamped);
      const distanceNow = lerpAt(times, distance, clamped);
      // Speed over the ten seconds about it, in the recording's own time and distance.
      const before = Math.max(t[0], elapsed - 5);
      const after = Math.min(t[n - 1], elapsed + 5);
      const speed = after > before ? (lerpAt(t, distance, after) - lerpAt(t, distance, before)) / (after - before) : 0;
      const beat = heartRateAt(beatT, beatV, elapsed);
      const heartRate = beat === null ? null : Math.round(beat);
      return {
        at: clamped,
        lng,
        lat: latAt,
        heading,
        progress: Math.min(1, Math.max(0, progress)),
        index: n === 1 ? 0 : i,
        share: n === 1 ? 0 : u,
        elapsed,
        distance: distanceNow,
        speed: Math.max(0, speed),
        heartRate,
        zone: zoneOf(heartRate, track.zones),
        altitude: altitude ? lerpAt(times, altitude, clamped) : null,
      };
    },
  };
}
