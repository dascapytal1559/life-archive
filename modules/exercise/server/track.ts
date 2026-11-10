// A workout copy's track, as the Fitness page draws it: its heart rate and distance sample by sample and its route,
// read from the copy itself (content: the route says where he went, the samples his heart rate), from either of
// Polar's shapes (AccessLink's exercise, the account export's session), and what is worked out from them: the time
// moving, the splits a kilometre at a time, the heart rate over time for a chart, and the route as a shape.
//
// The route leaves here as a shape: each point in metres east and north of the route's own south-west corner, thinned
// to what a drawing needs. Where a map the archive keeps on this Mac covers it (maps/), the page is also told that
// corner, to lay the shape on the map; elsewhere it learns its shape and size alone. No map is ever fetched from a tile
// server, which would be told where he went (the module's privacy lines, privacy.ts).

import type { SportFamily } from "../../../sdk/server.ts";
import { isoSeconds, sampleRate, sampleType, type PolarExercise } from "../connectors/polar/exercise.ts";
import { exportId, type PolarSession } from "../connectors/polar-export/session.ts";
import type { Shape, Split } from "../wire.ts";
import type { Bounds } from "./maps/tiles.ts";

// The playback (playback.ts) reads the same track whole: every timed point of the route, with distance, altitude and
// the trusted heart rate at its time, for the page to replay it on the map.

/** A reading at a time: seconds from the start, and its value. */
export interface Timed {
  t: number;
  v: number;
}

/** What a copy holds, sample by sample: heart rate (bpm), distance so far (metres), altitude (metres) and the route's points. */
export interface Track {
  heartRate: Timed[];
  /** The seconds each heart-rate reading stands for, its stream's interval; 0 with no heart-rate stream. */
  heartRateEvery: number;
  distance: Timed[];
  altitude: Timed[];
  route: Array<{ lat: number; lon: number; t: number | null }>;
}

export const NO_TRACK: Track = { heartRate: [], heartRateEvery: 0, distance: [], altitude: [], route: [] };

/** A stream's readings at their times, and the seconds between two of them. */
interface Stream {
  readings: Timed[];
  every: number;
}

const NO_STREAM: Stream = { readings: [], every: 0 };

/** A stream read every `every` seconds: a gap (null, NaN, a heart rate of 0) is left out, its time kept by position. */
function timed(values: ReadonlyArray<number | string | null>, every: number, isHeartRate: boolean): Stream {
  const readings: Timed[] = [];
  values.forEach((raw, i) => {
    const v = typeof raw === "number" ? raw : raw === null || raw.trim() === "" || raw.trim() === "null" ? Number.NaN : Number(raw);
    if (Number.isFinite(v) && !(isHeartRate && v <= 0)) readings.push({ t: i * every, v });
  });
  return { readings, every };
}

/** The track of an AccessLink exercise: its samples (0 heart rate, 10 distance) and its route. */
export function exerciseTrack(exercise: PolarExercise): Track {
  const stream = (type: string): Stream => {
    const sample = (exercise.samples ?? []).find((s) => sampleType(s) === type);
    const every = sample ? (sampleRate(sample) ?? 0) : 0;
    return sample && every > 0 ? timed((sample.data ?? "").split(","), every, type === "0") : NO_STREAM;
  };
  const route = (exercise.route ?? [])
    .filter((p): p is { latitude: number; longitude: number; time?: string } => typeof p.latitude === "number" && typeof p.longitude === "number")
    .map((p) => ({ lat: p.latitude, lon: p.longitude, t: isoSeconds(p.time) }));
  const heart = stream("0");
  return { heartRate: heart.readings, heartRateEvery: heart.every, distance: stream("10").readings, altitude: stream("3").readings, route };
}

/** The track of the exercise `id` (as exportId names it) of an exported session. */
export function sessionTrack(session: PolarSession, id: string): Track {
  const exercise = (session.exercises ?? []).find((e) => exportId(e) === id);
  if (!exercise) return NO_TRACK;
  const stream = (type: string): Stream => {
    const sample = exercise.samples?.samples?.find((s) => s.type === type);
    return sample?.intervalMillis ? timed(sample.values ?? [], sample.intervalMillis / 1000, type === "HEART_RATE") : NO_STREAM;
  };
  const route = (exercise.routes?.route?.wayPoints ?? [])
    .filter((p): p is { latitude: number; longitude: number; elapsedMillis?: number } => typeof p.latitude === "number" && typeof p.longitude === "number")
    .map((p) => ({ lat: p.latitude, lon: p.longitude, t: typeof p.elapsedMillis === "number" ? p.elapsedMillis / 1000 : null }));
  const heart = stream("HEART_RATE");
  return { heartRate: heart.readings, heartRateEvery: heart.every, distance: stream("DISTANCE").readings, altitude: stream("ALTITUDE").readings, route };
}

const EARTH_M = 6_371_000;
const RAD = Math.PI / 180;

/** The metres between two points on the earth (haversine). */
export function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance so far over time: the copy's own distance samples, else added up along the route where its points have times. */
export function distanceOverTime(track: Pick<Track, "distance" | "route">): Timed[] {
  if (track.distance.length > 1) return track.distance;
  const out: Timed[] = [];
  let sum = 0;
  track.route.forEach((p, i) => {
    if (i > 0) sum += metresBetween(track.route[i - 1], p);
    if (p.t !== null) out.push({ t: p.t, v: sum });
  });
  return out.length > 1 ? out : [];
}

/** Below this speed (metres a second) a stretch is a stop, not moving: a slow walk on foot, a slow roll on a bike. */
export const MOVING_SPEED: Record<SportFamily, number> = { run: 0.5, walk: 0.3, ride: 1, swim: 0.1, other: 0.3 };

/** A stretch longer than this between two samples is a gap in the recording (a pause), not time spent moving. */
const LONGEST_STEP_S = 30;

/**
 * The seconds spent moving, from distance over time: each stretch between two samples counts when it covered ground
 * at least at the family's moving speed; null with no distance over time to tell by.
 */
export function movingSeconds(distance: readonly Timed[], family: SportFamily): number | null {
  if (distance.length < 2) return null;
  let moving = 0;
  for (let i = 1; i < distance.length; i++) {
    const dt = distance[i].t - distance[i - 1].t;
    if (dt <= 0 || dt > LONGEST_STEP_S) continue;
    if ((distance[i].v - distance[i - 1].v) / dt >= MOVING_SPEED[family]) moving += dt;
  }
  return Math.round(moving);
}

/** A last split shorter than this is folded into none: a few steps past the last kilometre. */
const SHORTEST_SPLIT_M = 50;

/**
 * Each kilometre's split: its moving seconds (by the same rule as movingSeconds) and its average heart rate from
 * `heartRate` (none given: no heart rate), the last a part kilometre when there is one, each stretch shared out
 * between the kilometres it crosses by the ground it covered in each.
 */
export function splitsOf(distance: readonly Timed[], heartRate: readonly Timed[], family: SportFamily): Split[] {
  if (distance.length < 2) return [];
  const splits: Split[] = [];
  let seconds = 0;
  let from = distance[0].v;
  let startT = distance[0].t;
  const close = (endT: number, metres: number) => {
    const beats = heartRate.filter((h) => h.t >= startT && h.t < endT);
    const average = beats.length > 0 ? Math.round(beats.reduce((n, h) => n + h.v, 0) / beats.length) : null;
    splits.push({ distanceM: Math.round(metres), seconds: Math.round(seconds), heartRate: average });
    seconds = 0;
    startT = endT;
  };
  for (let i = 1; i < distance.length; i++) {
    const a = distance[i - 1];
    const b = distance[i];
    const dt = b.t - a.t;
    const dd = b.v - a.v;
    if (dt <= 0) continue;
    const moving = dt <= LONGEST_STEP_S && dd / dt >= MOVING_SPEED[family];
    let at = a.v;
    let t = a.t;
    // Each kilometre mark this stretch crosses closes a split, at the time the mark was passed.
    while (dd > 0 && b.v >= from + 1000) {
      const mark = from + 1000;
      const share = (mark - at) / dd;
      if (moving) seconds += share * dt;
      t += share * dt;
      at = mark;
      close(t, 1000);
      from = mark;
    }
    if (moving && dd > 0) seconds += ((b.v - at) / dd) * dt;
  }
  const last = distance.at(-1)!;
  if (last.v - from >= SHORTEST_SPLIT_M) close(last.t + 1, last.v - from);
  return splits;
}

/** Heart rate over time for a chart: at most `points` points, each the average of its stretch, at its middle. */
export function heartRateSeries(heartRate: readonly Timed[], points = 600): Array<[number, number]> {
  if (heartRate.length === 0) return [];
  const per = Math.max(1, Math.ceil(heartRate.length / points));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < heartRate.length; i += per) {
    const part = heartRate.slice(i, i + per);
    out.push([Math.round(part.reduce((n, h) => n + h.t, 0) / part.length), Math.round(part.reduce((n, h) => n + h.v, 0) / part.length)]);
  }
  return out;
}

/**
 * The route as a shape: each point in whole metres east (x) and north (y) of its south-west corner, on a flat
 * projection about its middle (fine over a run's or a ride's few kilometres), thinned (Douglas-Peucker) until no point
 * left out is more than `tolerance` of the shape's larger side from the line drawn; null with fewer than two points.
 */
export function shapeOf(route: Track["route"], tolerance: number): Shape | null {
  if (route.length < 2) return null;
  const lat0 = (Math.min(...route.map((p) => p.lat)) + Math.max(...route.map((p) => p.lat))) / 2;
  const kx = EARTH_M * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_M * RAD;
  const flat = route.map((p) => [p.lon * kx, p.lat * ky] as [number, number]);
  const minX = Math.min(...flat.map((p) => p[0]));
  const minY = Math.min(...flat.map((p) => p[1]));
  const shifted = flat.map(([x, y]) => [x - minX, y - minY] as [number, number]);
  const width = Math.max(...shifted.map((p) => p[0]));
  const height = Math.max(...shifted.map((p) => p[1]));
  const kept = thinned(shifted, tolerance * Math.max(width, height, 1));
  return { width: Math.round(width), height: Math.round(height), points: kept.map(([x, y]) => [Math.round(x), Math.round(y)]) };
}

/** The route's box in degrees, whose south-west corner is its shape's origin; null with fewer than two points. */
export function boundsOf(route: Track["route"]): Bounds | null {
  if (route.length < 2) return null;
  const lats = route.map((p) => p.lat);
  const lons = route.map((p) => p.lon);
  return { south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons) };
}

/** Douglas-Peucker: the points of `line` that keep it within `epsilon` of itself, the first and last always. */
function thinned(line: ReadonlyArray<[number, number]>, epsilon: number): Array<[number, number]> {
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let far = -1;
    let farthest = epsilon;
    for (let i = first + 1; i < last; i++) {
      const d = offLine(line[i], line[first], line[last]);
      if (d > farthest) {
        farthest = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([first, far], [far, last]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** How far `p` is from the segment from `a` to `b`. */
function offLine(p: [number, number], a: [number, number], b: [number, number]): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const u = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy));
}

/** The track a copy of either Polar shape holds, by its id: an export's are keyed export/<id>. */
export function trackOf(json: unknown, nativeId: string): Track {
  return nativeId.startsWith("export/") ? sessionTrack(json as PolarSession, nativeId) : exerciseTrack(json as PolarExercise);
}
