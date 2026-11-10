// An activity's playback (../wire.ts's PlaybackTrack, GET .../activities/<id>/playback): its route whole, every timed
// point with the distance so far, the altitude and the trusted heart rate at its time, for the page to replay on its
// area's map in 3D (viewer/playback/). Content (where he went, his heart rate), so it is read from the copies as the
// activity's page is (activities.ts's PlaybackCopies), for the page alone, and only for a route inside a map kept on
// this Mac: the page is told where a route is only then (the module's privacy lines, privacy.ts).
//
// The heart rate may be another copy's than the route (a chest strap's recording beside the phone's GPS): each copy's
// times are from its own start, so the heart rate's are moved by the difference between the two starts.

import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { envSetting } from "../../../sdk/server.ts";
import type { ActivityDetail, Photoreal, PlaybackTrack } from "../wire.ts";
import type { PlaybackCopies, TimedCopy } from "./activities.ts";
import type { MapStore } from "./maps/tiles.ts";
import { metresBetween, trackOf, type Timed, type Track } from "./track.ts";
import { fileAt } from "./workoutIndex.ts";

/** `series`' value at `t`, read along the line between its two readings about it; null when it has none, or `t` is beyond it by more than `reach` s. */
export function valueAt(series: readonly Timed[], t: number, reach = 30): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  if (t <= series[0].t) return series[0].t - t <= reach ? series[0].v : null;
  if (t >= series[hi].t) return t - series[hi].t <= reach ? series[hi].v : null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  return b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The playback of the activity `detail` from its route's copy's `track`, with the heart rate of `heart`, the track of
 * the copy whose heart rate is trusted (the route's own, or another's, its times moved by `heartShiftS`); null when
 * the route has under two timed points. No `heart`, or an activity whose heart rate is not trusted, sends none.
 */
export function playbackTrack(
  detail: ActivityDetail,
  track: Track,
  { heart, heartShiftS = 0, terrain, photoreal }: { heart: Track | null; heartShiftS?: number; terrain: PlaybackTrack["terrain"]; photoreal: Photoreal | null },
): PlaybackTrack | null {
  if (!detail.map) return null;
  const timed = track.route.filter((p): p is { lat: number; lon: number; t: number } => p.t !== null).sort((a, b) => a.t - b.t);
  if (timed.length < 2) return null;
  // The distance so far: the copy's own samples where it has them, so the readout ends at the activity's distance; else along the route.
  let along = 0;
  const walked = timed.map((p, i) => (along += i === 0 ? 0 : metresBetween(timed[i - 1], p)));
  const distance = timed.map((p, i) => valueAt(track.distance, p.t, Number.POSITIVE_INFINITY) ?? walked[i]);
  for (let i = 1; i < distance.length; i++) distance[i] = Math.max(distance[i], distance[i - 1]);
  const altitude = track.altitude.length > 1 ? timed.map((p) => round(valueAt(track.altitude, p.t, Number.POSITIVE_INFINITY) ?? 0, 1)) : null;
  const beats = detail.heartRate && heart ? heart.heartRate.map(({ t, v }) => [round(t + heartShiftS, 1), v] as [number, number]) : [];
  return {
    id: detail.id,
    title: detail.title,
    start: detail.start,
    family: detail.family,
    points: {
      t: timed.map((p) => round(p.t, 2)),
      lat: timed.map((p) => round(p.lat, 7)),
      lon: timed.map((p) => round(p.lon, 7)),
      distance: distance.map((d) => round(d, 1)),
      altitude,
    },
    heartRate: beats.length > 0 ? beats : null,
    zones: detail.zones
      .map(({ zone, from }) => ({ zone, from: from ?? (zone === 1 ? 0 : null) }))
      .filter((z): z is { zone: number; from: number } => z.from !== null)
      .sort((a, b) => a.zone - b.zone),
    map: detail.map,
    terrain,
    photoreal,
  };
}

/** The photorealistic city's credentials, from the environment, then the archive's .env.local: Cesium ion's token first. */
export function photorealSetting(setting: (key: string) => string | undefined = envSetting): Photoreal | null {
  const token = setting("CESIUM_ION_TOKEN")?.trim();
  if (token) return { via: "cesium-ion", token };
  const key = setting("GOOGLE_MAPS_API_KEY")?.trim();
  return key ? { via: "google", key } : null;
}

/** A copy's track, read from the archive's folder `dataDir`. */
const readTrack = (dataDir: string, copy: TimedCopy): Promise<Track> =>
  readFile(fileAt(copy.file, dataDir), "utf8").then((text) => trackOf(JSON.parse(text) as unknown, copy.nativeId));

/** Why an activity has no playback, in a sentence for the captain. */
export const NO_PLAYBACK = {
  route: "This activity has no route with times to play back.",
  map: "Its area's map is not downloaded, so it cannot be played back here (npm run map -- download <region>).",
} as const;

/** The playback of an activity, its copies read from the archive's folder `dataDir`; a reason when it has none. */
export const readPlayback = (dataDir: string, detail: ActivityDetail, copies: PlaybackCopies | null, maps: MapStore, photoreal: Photoreal | null) =>
  Effect.gen(function* () {
    if (!detail.map) return { none: NO_PLAYBACK.map };
    if (!copies || copies.track.origin !== "polar") return { none: NO_PLAYBACK.route };
    const place = detail.map;
    const read = yield* Effect.promise(async () => {
      const track = await readTrack(dataDir, copies.track).catch(() => null);
      const trusted = copies.heartRate?.origin === "polar" ? copies.heartRate : null;
      const same = trusted !== null && trusted.file === copies.track.file && trusted.nativeId === copies.track.nativeId;
      const heart = !trusted ? null : same ? track : await readTrack(dataDir, trusted).catch(() => null);
      return { track, heart, shift: trusted && !same ? (trusted.at - copies.track.at) / 1000 : 0 };
    });
    if (!read.track) return { none: NO_PLAYBACK.route };
    const terrain = yield* Effect.promise(() => maps.terrain(place.region));
    const shift = read.shift;
    const played = playbackTrack(detail, read.track, { heart: read.heart, heartShiftS: shift, terrain, photoreal });
    return played ? { track: played } : { none: NO_PLAYBACK.route };
  });
