// The workouts the captain logged in Rituals, on the Fitness page: each laid beside the activity it is, when another
// source has it, else an activity of its own; and every activity's minutes in zone 2, for the weekly zone 2 target.
//
// The rituals module offers them (RitualWorkouts, sdk/server.ts, which the Exercise service asks for optionally:
// modules/rituals/server/service.ts, from rituals' store, which holds their titles and his words, content, read for his
// page alone).
//
// The same workout (matchLogs): Rituals keeps no time of day, so a log is another source's activity when it is
//   - of the same day (the activity's start, local) and the same family of sport (bike is a ride, gym push none of
//     run, walk, ride or swim: rituals' category read as one, by the rituals module), and
//   - as long: the minutes it states within 10 minutes, or a quarter, of the activity's elapsed or moving time, whichever
//     is the more; a log that states none only when it is the day's one log of that family and the day has one such
//     activity, so nothing is guessed between two.
// Each log is one activity's, and each activity has one log at most: the closest pairs first. A log matched is a copy
// of its activity like any other (the page names it among its sources); one matched to none is an activity of its
// own, known by its day alone.
//
// Zone 2 (zone2Of), counted once an activity, whatever its copies: its minutes in zone 2 by its trusted heart rate's
// zones (a chest strap's, by his rule: the zones the page shows, counted from its samples by exercise.json's zones,
// zones.ts, else Polar's), else, with no such zones, its Rituals log's stated
// minutes when the log says it was zone 2 (and no other zone). A watch's heart rate, which he does not trust, counts
// nothing, as the page shows none of it.

import type { LoggedWorkout } from "../../../sdk/server.ts";
import { zoneSeconds, type RitualsLog, type Zone, type Zone2 } from "../wire.ts";

/** What a log is matched against: an activity's day, family and how long it took. */
export interface MatchTarget {
  day: string;
  family: string;
  elapsedS: number | null;
  movingS: number | null;
}

/** A stated duration this close to an activity's, in minutes, is the same workout's ... */
export const SAME_MINUTES = 10;
/** ... or within this share of it, when that is more. */
export const SAME_SHARE = 0.25;

/** How far, in minutes, a log's stated duration is from an activity's (the nearer of its elapsed and moving time). */
function minutesOff(stated: number, target: MatchTarget): number {
  const times = [target.elapsedS, target.movingS].filter((s): s is number => s !== null).map((s) => Math.abs(s / 60 - stated));
  return times.length > 0 ? Math.min(...times) : Infinity;
}

/**
 * Which activity each log is (its index in `targets`), by the rule above: a map from the log's index in `logs` to the
 * activity's. A log of none is not in it.
 */
export function matchLogs(logs: ReadonlyArray<Pick<LoggedWorkout, "day" | "family" | "log">>, targets: readonly MatchTarget[]): Map<number, number> {
  const pairs: Array<{ log: number; target: number; off: number }> = [];
  logs.forEach((logged, l) => {
    const same = targets.flatMap((target, t) => (target.day === logged.day && target.family === logged.family ? [t] : []));
    if (logged.log.minutes === null) {
      // Nothing to tell two apart by: only the day's one log of its family, and the day's one activity of it.
      const logsOfKind = logs.filter((other) => other.day === logged.day && other.family === logged.family).length;
      if (same.length === 1 && logsOfKind === 1) pairs.push({ log: l, target: same[0], off: Infinity });
      return;
    }
    for (const t of same) {
      const off = minutesOff(logged.log.minutes, targets[t]);
      if (off <= Math.max(SAME_MINUTES, SAME_SHARE * logged.log.minutes)) pairs.push({ log: l, target: t, off });
    }
  });
  const matched = new Map<number, number>();
  const taken = new Set<number>();
  for (const pair of pairs.sort((a, b) => a.off - b.off || a.log - b.log || a.target - b.target)) {
    if (matched.has(pair.log) || taken.has(pair.target)) continue;
    matched.set(pair.log, pair.target);
    taken.add(pair.target);
  }
  return matched;
}

/**
 * An activity's minutes in zone 2: its trusted zones' zone 2 time when it has zones, else its Rituals log's stated
 * minutes when the log says zone 2; null when neither says.
 */
export function zone2Of(trustedZones: readonly Zone[], log: RitualsLog | null): Zone2 | null {
  if (trustedZones.length > 0) {
    const seconds = zoneSeconds(trustedZones.find((zone) => zone.zone === 2)?.time ?? null) ?? 0;
    return { minutes: Math.round((seconds / 60) * 10) / 10, from: "heart-rate" };
  }
  if (log?.zone2 && log.minutes !== null) return { minutes: log.minutes, from: "rituals" };
  return null;
}
