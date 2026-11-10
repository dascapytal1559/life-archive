// Bryan Johnson's five pillars of exercise, week by week, all of it pure: the Fitness page's Bryan Johnson tab draws
// them (Pillars.tsx), and the exercise_pillars tool answers with them (../server/agents.ts). Once the Don't Die page's,
// the rules are the exploration's (firstmate's la-fitness-pillars-explore, its build-data.mjs), on what the server
// already sends:
//
//   Strength Training       gym sessions logged in Rituals (format.ts's isGym), against liftWeeklySessions
//   Low Intensity Cardio    minutes in zone 2 (each activity's zone2), against zone2WeeklyMinutes
//   High Intensity Cardio   minutes in heart-rate zones 4 and 5 by the trusted strap (format.ts's hiitMinutesOf),
//                           against hiitWeeklyMinutes
//   Mobility & Flexibility  the days the stretching ritual was done, of those it was reported, against every day
//   Balance                 balance work, of which the archive logs none yet, so never a zero, against every day (planks
//                           never count: "Also don't count plank as balance. I just haven't done any balance.")
//
// A week is Monday to Sunday, local. A pillar with no value in a week (no reported days, or no balance logged) has
// nothing to draw that week, not a zero.

import { addDays } from "../../../sdk/wire.ts";
import type { ActivitySummary, PillarHabitDay, PillarTargets, WeeklyTarget } from "../wire.ts";
import { weekOf, weeksTo } from "./format.ts";

export type PillarKey = "lift" | "z2" | "hiit" | "mob" | "bal";

export interface Pillar {
  key: PillarKey;
  name: string;
  /** What its value counts. */
  unit: "sessions" | "min" | "days";
  /** What measures it, in a line. */
  how: string;
}

/** The five pillars, in the captain's order (mobility above balance). */
export const PILLARS: readonly Pillar[] = [
  { key: "lift", name: "Strength Training", unit: "sessions", how: "Gym sessions logged in Rituals (push, pull, legs)" },
  { key: "z2", name: "Low Intensity Cardio", unit: "min", how: "Minutes in zone 2 by the chest strap, else a Rituals log that says zone 2 and how long" },
  { key: "hiit", name: "High Intensity Cardio", unit: "min", how: "Minutes in heart-rate zones 4 and 5 by the chest strap" },
  { key: "mob", name: "Mobility & Flexibility", unit: "days", how: "Days the stretching ritual was done" },
  { key: "bal", name: "Balance", unit: "days", how: "Balance work, of which none is logged yet" },
];

/** A week's totals: what each pillar's value is made of. */
export interface Totals {
  lift: number;
  z2: number;
  hiit: number;
  /** Days stretched, of `mobOf` reported; null when none was reported. */
  mob: number | null;
  mobOf: number;
}

/** A Monday-to-Sunday week. */
export interface PillarWeek {
  /** Its Monday and its Sunday, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Its ISO week number. */
  week: number;
  /** It holds today: still in progress. */
  current: boolean;
  totals: Totals;
}

/** Each pillar's weekly target, or why it has none: balance and mobility are every day, the rest exercise.json's. */
export type Targets = Readonly<Record<PillarKey, WeeklyTarget>>;

export const targetsOf = (set: PillarTargets): Targets => ({ lift: set.lift, z2: set.zone2, hiit: set.hiit, mob: { amount: 7 }, bal: { amount: 7 } });

const DAY = 86_400_000;
const asMs = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

/** The ISO week number of `day`: the week holding its year's first Thursday is week 1. */
export function isoWeek(day: string): number {
  const ms = asMs(day);
  const thursday = ms + (3 - ((new Date(ms).getUTCDay() + 6) % 7)) * DAY;
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - yearStart) / (7 * DAY)) + 1;
}

/** It was reported: done or not done (not asked that day, or not yet answered, is neither). */
const reported = (status: string | undefined) => status === "done" || status === "not_done";

/**
 * Every week from the first with anything to count to today's, oldest first: its gym sessions, minutes in zone 2 and
 * in zones 4 and 5, and the days it stretched of those reported. Habits null: the rituals module is off.
 */
export function pillarWeeks(activities: readonly ActivitySummary[], habits: readonly PillarHabitDay[] | null, today: string): PillarWeek[] {
  const days = (habits ?? []).filter((d) => d.day <= today && reported(d.habits.stretching));
  const first = [...activities.map((a) => a.start.slice(0, 10)), ...days.map((d) => d.day)].filter((day) => day <= today).sort()[0] ?? today;
  const count = Math.round((asMs(weekOf(today)) - asMs(weekOf(first))) / (7 * DAY)) + 1;
  return weeksTo(activities, today, count).map((w) => {
    const to = addDays(w.from, 6);
    const mobDays = days.filter((d) => d.day >= w.from && d.day <= to);
    return {
      from: w.from,
      to,
      week: isoWeek(w.from),
      current: w.from === weekOf(today),
      totals: {
        lift: w.gym.length,
        z2: w.zone2Minutes,
        hiit: w.hiitMinutes,
        mob: mobDays.length ? mobDays.filter((d) => d.habits.stretching === "done").length : null,
        mobOf: mobDays.length,
      },
    };
  });
}

/** A pillar's value in a week: balance has none, since nothing logs balance work yet. */
export function valueOf(w: PillarWeek, key: PillarKey): number | null {
  return key === "bal" ? null : w.totals[key];
}

/** A pillar's weekly target, or null with none set. */
export const targetOf = (targets: Targets, key: PillarKey): number | null => targets[key].amount;

/** How many days mobility's value is of: those reported that week (null for the other pillars). */
export const reportedOf = (w: PillarWeek, key: PillarKey): number | null => (key === "mob" ? w.totals.mobOf : null);

/** A unit, singular for one: "session", "sessions", "min", "day". */
export const unitText = (unit: Pillar["unit"], n: number): string => (unit === "min" || n !== 1 ? unit : unit.slice(0, -1));

/** Why a pillar has no value in a week: "no balance logged", else "nothing reported". */
export const noValueText = (key: PillarKey): string => (key === "bal" ? "no balance logged" : "nothing reported");

/** A pillar's reading in a week: "2 / 3 sessions", "163 / 300 min", "5 / 7 days"; why when it has no value. */
export function readingText(w: PillarWeek, key: PillarKey, targets: Targets): { value: number | null; of: string } {
  const value = valueOf(w, key);
  const target = targetOf(targets, key);
  const unit = PILLARS.find((pl) => pl.key === key)!.unit;
  if (value === null) return { value: null, of: noValueText(key) };
  if (target === null) return { value: Math.round(value), of: "· no target set" };
  return { value: Math.round(value), of: `/ ${target} ${unitText(unit, target)}` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/** A week's name, with its year so a long history reads: "Week 45 · 2–8 Nov 2026", "Week 1 · 29 Dec – 4 Jan 2026". */
export function weekName(w: Pick<PillarWeek, "from" | "to" | "week">): string {
  const span = w.from.slice(5, 7) === w.to.slice(5, 7) ? `${Number(w.from.slice(8, 10))}–${md(w.to)}` : `${md(w.from)} – ${md(w.to)}`;
  return `Week ${w.week} · ${span} ${w.to.slice(0, 4)}`;
}
