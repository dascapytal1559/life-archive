// The workouts the captain logs in rituals, as the Fitness page reads them (the RitualWorkouts service the SDK names,
// service.ts): each day's, as rituals' view shows them (a category, rituals' title for it, and what he said of it, which
// is content, read for his page alone), and the few things worked out of one, each never guessed: the minutes it
// states, whether it says it was zone 2, and its sport's family, so the Fitness page can lay it beside another
// source's copy of the same workout (modules/exercise/server/rituals.ts).
//
// Rituals keeps no duration, distance or sets of a workout (its HANDOFF.md: "Workouts have no duration/distance/
// split/sets columns"), only his words, so these read the words. Its own minutesOf (src/workouts.ts, for its titles)
// takes one stated duration; this takes that, or an hour and minutes said together ("1h 30m"), and nothing when more
// than that is said ("20 min warm-up, 40 min ride"). Were rituals' view to print the minutes, these would follow it.

import type { LoggedWorkout, SportFamily } from "../../../sdk/server.ts";
import type { RitualsView } from "../wire.ts";

/** One workout in rituals: its category (gym push, run), rituals' title for it, and what was said of it (content). */
export interface RitualsWorkout {
  type: string;
  title: string;
  details: string;
}

/** A day's workouts in rituals, in its order. */
export interface RitualsWorkoutDay {
  day: string;
  workouts: RitualsWorkout[];
}

/** The days rituals' view shows workouts on, oldest first, each with its workouts in rituals' order. */
export function workoutDays(view: RitualsView): RitualsWorkoutDay[] {
  return view.daily.rows
    .filter((row) => row.workouts.items.length > 0)
    .map((row) => ({
      day: row.date,
      // A day's labels are its workouts' titles (else their categories), in the same order as its items.
      workouts: row.workouts.items.map((item, i) => ({ type: item.type, title: row.workouts.labels[i] ?? item.type, details: item.details })),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

const DURATION = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|min|m)\b/gi;

/**
 * The minutes `details` state, or null when they state none or more than one duration: "44 minutes, zone 2" is 44,
 * "1h 30m" and "1 hour 30 minutes" are 90, "Bench press: 20 kg x 8" and "20 min warm-up, 40 min ride" are null.
 */
export function statedMinutes(details: string): number | null {
  const found = [...details.matchAll(DURATION)];
  const minutes = (match: RegExpMatchArray) => (/^h/i.test(match[2]) ? Number(match[1]) * 60 : Number(match[1]));
  if (found.length === 1) return positive(minutes(found[0]));
  // An hour and minutes said together: "1h 30m", "1 hour and 30 minutes".
  if (found.length === 2 && /^h/i.test(found[0][2]) && !/^h/i.test(found[1][2])) {
    const between = details.slice(found[0].index! + found[0][0].length, found[1].index);
    if (/^\s*(?:and\s*)?$/i.test(between)) return positive(minutes(found[0]) + minutes(found[1]));
  }
  return null;
}

const positive = (n: number) => (Number.isFinite(n) && n > 0 ? n : null);

/** Each heart-rate zone `details` name ("zone 2", "z2", "zone two"; both ends of "zone 2-3"). */
function zonesNamed(details: string): Set<number> {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const zone = "one|two|three|four|five|[1-5]";
  const named = new Set<number>();
  for (const match of details.matchAll(new RegExp(`\\b(?:zones?\\s*|z)(${zone})\\b(?:\\s*(?:-|–|to|and)\\s*(?:z|zone\\s*)?(${zone})\\b)?`, "gi"))) {
    for (const said of [match[1], match[2]]) if (said) named.add(words[said.toLowerCase()] ?? Number(said));
  }
  return named;
}

/** Whether `details` say the workout was zone 2: they name zone 2, and no other zone ("zone 2, then zone 4 intervals" is not). */
export function saysZone2(details: string): boolean {
  const named = zonesNamed(details);
  return named.size === 1 && named.has(2);
}

/** The family of sport a rituals category is (bike is a ride, gym push none of the others), to match it with another source's copy. */
export function familyOf(type: string): SportFamily {
  const words = type.trim().toLowerCase();
  if (/\b(bike|biking|cycl\w*|ride|riding)\b/.test(words)) return "ride";
  if (/\b(run|running|jog\w*)\b/.test(words)) return "run";
  if (/\b(walk\w*|hike|hiking)\b/.test(words)) return "walk";
  if (/\bswim\w*\b/.test(words)) return "swim";
  return "other";
}

/** Every workout logged in rituals that `view` shows, oldest day first, as the Fitness page reads them: its address is rituals-<day>-<place in the day, from 1>. */
export function loggedWorkouts(view: RitualsView): LoggedWorkout[] {
  return workoutDays(view).flatMap((day) =>
    day.workouts.map((workout, i) => ({
      id: `rituals-${day.day}-${i + 1}`,
      day: day.day,
      family: familyOf(workout.type),
      log: { type: workout.type, title: workout.title, details: workout.details, minutes: statedMinutes(workout.details), zone2: saysZone2(workout.details) },
    })),
  );
}
