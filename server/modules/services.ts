// The services the SDK names (docs/effect.md, "Services and Layers"; docs/modules.md, "The seams"): what one part of
// the archive offers and another asks for without reading its code. Each is declared here, in the core, so both sides
// agree on its tag whichever module offers it; a module offers one through its `services` Layer (sdk/server.ts), and
// another asks for it optionally (Effect.serviceOption) at request time, so it lives without it when that module is
// switched off. The core provides none of them itself.
//
//   Exercise        the highest heart rate a trusted recording holds: the exercise module offers it (modules/exercise),
//                   and the health module asks for it for its physical assessment
//   RunsByHand      the runs transcribed by hand from Polar's sharing pages, kept in health's by-hand.json: the health
//                   module offers them, and the Fitness page shows them as copies of their activities
//   RitualWorkouts  the workouts the captain logged in Rituals, each read from rituals' store: the rituals module offers
//                   them (modules/rituals/server/service.ts), and the Fitness page lays each on the activity it is
//   RitualHabits    how each day's habits stood in Rituals (done, not done, not asked, not reported), statuses alone:
//                   the rituals module offers them (the same file), and Fitness's Bryan Johnson tab counts the stretching days
//                   as mobility

import { Context, type Effect } from "effect";
import type { SportFamily } from "../connectors/contract.ts";

/** A run recorded with a chest strap and transcribed by hand from its sharing page, as health's by-hand.json keeps it. */
export interface Run {
  /** When it started, local time, YYYY-MM-DDTHH:MM. */
  start: string;
  sport: string;
  /** The device whose heart rate it is ("Polar H10"); a wrist device's is never trusted (docs/features.md's "Health"). */
  device: string;
  trusted: boolean;
  duration: string;
  distanceMi: number | null;
  avgHr: number;
  maxHr: number;
  minHr: number;
  /** The recording app's own max heart rate setting, which its zones are worked out from. */
  hrMaxSetting?: number;
  /** Each zone's share of the run, with its time and lower bound where the page gives them. */
  zones?: Array<{ zone: number; share: number; time?: string; from?: number }>;
  source: string;
}

/**
 * The highest heart rate a trusted recording holds: when, on what, from which source, and the Fitness page's activity it
 * was recorded in (the page that links it builds its address, as the console is mounted).
 */
export interface Peak {
  bpm: number;
  /** The day, YYYY-MM-DD. */
  date: string;
  sensor: string | null;
  recorder: string | null;
  source: string;
  activity: string;
}

/** The runs transcribed by hand, which the health module offers (its by-hand.json) and the Fitness page shows as copies. */
export class RunsByHand extends Context.Service<RunsByHand, {
  /** Every run transcribed by hand, read afresh; the error, its message shown on the page, when they cannot be read. */
  readonly runs: Effect.Effect<readonly Run[], Error>;
}>()("life-archive/RunsByHand") {}

/** What the Fitness page knows that another part may ask for: the exercise module offers it. */
export class Exercise extends Context.Service<Exercise, {
  /** The highest heart rate a trusted recording holds, or null without one; read afresh each time. */
  readonly peak: Effect.Effect<Peak | null>;
}>()("life-archive/Exercise") {}

/** A workout as the captain logged it in Rituals: its category, Rituals' title, what he said of it and what that states. */
export interface RitualsLog {
  /** Rituals' category ("gym push", "bike"). */
  type: string;
  /** Rituals' title for it ("Gym Push", "Bike 44 min"), else its category. */
  title: string;
  /** His words about it (sets, a duration, the zone): content, shown to him alone. */
  details: string;
  /** The minutes it states, when it states one; null otherwise. */
  minutes: number | null;
  /** It says it was zone 2 (and no other zone). */
  zone2: boolean;
}

/** A workout logged in Rituals, as the Fitness page reads it. */
export interface LoggedWorkout {
  /** Its address, rituals-<day>-<place in the day, from 1>. */
  id: string;
  day: string;
  family: SportFamily;
  log: RitualsLog;
}

/** The workouts the captain logged in Rituals, oldest first, which the rituals module offers. */
export class RitualWorkouts extends Context.Service<RitualWorkouts, {
  /** Every workout logged there, each read from rituals' store; read afresh each time. */
  readonly logged: Effect.Effect<readonly LoggedWorkout[]>;
}>()("life-archive/RitualWorkouts") {}

/** How a habit stood on a day in Rituals: done, not done, not asked that day, or not reported yet (the day still open). */
export type HabitStatus = "done" | "not_done" | "not_applicable" | "unreported";

/** One ritual day's habits: its date (an evening's, YYYY-MM-DD) and each habit's status, by Rituals' word for it ("stretching", "planks"). */
export interface HabitDay {
  day: string;
  habits: Readonly<Record<string, HabitStatus>>;
}

/** How each day's habits stood in Rituals, oldest first, which the rituals module offers: statuses alone, never a time, a plank's seconds or a note. */
export class RitualHabits extends Context.Service<RitualHabits, {
  /** Every day Rituals' view shows, read afresh each time; none while there is no store, or it cannot be read. */
  readonly days: Effect.Effect<readonly HabitDay[]>;
}>()("life-archive/RitualHabits") {}
