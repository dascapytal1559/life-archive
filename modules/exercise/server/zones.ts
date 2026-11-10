// An activity's time in each heart-rate zone, counted by the archive itself from its trusted heart rate's samples,
// by the zones the captain sets in exercise.json (heartRateZones: where zones 2 to 5 start, from his clinic's
// assessment), rather than by Polar's own zones, which are worked out from a maximum heart rate he cannot change.
//
// Each sample stands for its stream's interval (a second, in Polar's copies) at its reading; a gap in the stream (a
// strap that dropped out: a null, a NaN or a 0, which track.ts leaves out) stands for nothing, so no time is given to
// the zone beside it. Zone 1 is everything below zone 2's start, rest included, since the zones set start at zone 2.
//
// The time at each heart rate is worked out once a copy (heartRateTime, kept with the rest of what is read of it,
// activities.ts's copyReader), and the zones from it at each answer (zonesOf), so a new set of zones in exercise.json
// shows at the page's next load. An activity with no samples to count (a summary alone) keeps Polar's zones.

import { clock } from "../connectors/polar/exercise.ts";
import type { Zone } from "../wire.ts";
import type { Timed } from "./track.ts";

/** Seconds spent at each heart rate (bpm, as recorded), in no order. */
export type HeartRateTime = Array<[bpm: number, seconds: number]>;

/** The seconds spent at each heart rate of `heartRate`, each reading standing for `every` seconds; none without readings or a rate. */
export function heartRateTime(heartRate: readonly Timed[], every: number): HeartRateTime {
  if (!(every > 0)) return [];
  const seconds = new Map<number, number>();
  for (const { v } of heartRate) seconds.set(v, (seconds.get(v) ?? 0) + every);
  return [...seconds];
}

/**
 * The time in each of zones 1 to 5 of `time`, by `starts`, the heart rates zones 2 to 5 start at: zone 1 below the
 * first, zone 5 from the last up. Each zone's share is of all the time counted; zone 1 has no lower limit. None when
 * nothing was counted.
 */
export function zonesOf(time: HeartRateTime, starts: readonly number[]): Zone[] {
  const seconds = Array<number>(starts.length + 1).fill(0);
  for (const [bpm, s] of time) seconds[starts.filter((start) => bpm >= start).length] += s;
  const total = seconds.reduce((n, s) => n + s, 0);
  if (total === 0) return [];
  return seconds.map((s, i) => ({ zone: i + 1, share: Math.round((s / total) * 100), time: clock(s), from: i === 0 ? null : starts[i - 1] }));
}
