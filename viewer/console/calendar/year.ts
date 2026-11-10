// The Calendar's year (YearGrid.tsx draws it): twelve small months at a glance, each day shaded by how much happened
// on it, as GitHub's graph of contributions shades a day ("The calendar view also needs a yearly view"). Pure, so
// year.test.ts holds it: the year's days and months, stepping a year, what each kind is asked for, and the measure
// a day is shaded by.
//
// The measure: every kind on gives a day up to one point, its count against its own busy day of the year (the 90th
// percentile of the year's days that have any of it), so the kinds' scales do not drown one another: 400 messages on
// a year whose busy day has 300 is a point, as one hangout on a year whose busy day has one. A day's points add up,
// and its shade is a quarter of the year's fullest day a step (shadeOf, as the month tints its messages).

import { addDays } from "../../../src/time.ts";
import { NO_FILTERS, type Filters } from "../../wire.ts";
import { countText } from "../../format.ts";
import { callsChoices, shadeOf, wordsOf, type CalendarKind, type CallsShown, type Tally, ALL_CALLS } from "./calendar.ts";

/** The kinds a year counts, in the order its summary and a day's counts say them. */
export const YEAR_KINDS: readonly CalendarKind[] = ["messages", "calls", "hangouts", "llm", "workouts", "habits"];

/** A kind's name over the year's summary: the messages and agent messages counted, the other kinds' own names. */
export function yearLabel(kind: CalendarKind): string {
  return kind === "messages" ? "Messages" : kind === "llm" ? "Agent messages" : wordsOf(kind).label;
}

/** The first day of the year `day` is in. */
export const yearStart = (day: string): string => `${day.slice(0, 4)}-01-01`;

/** The days of the year `day` is in, 1 January to 31 December. */
export function yearDays(day: string): string[] {
  const days: string[] = [];
  const next = `${Number(day.slice(0, 4)) + 1}-01-01`;
  for (let d = yearStart(day); d < next; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The first day of each of the year's twelve months. */
export function yearMonths(day: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${day.slice(0, 4)}-${String(i + 1).padStart(2, "0")}-01`);
}

/** The day picked on the year `years` from `day`'s: today when that year is today's, else its 1 January. */
export function stepYear(day: string, years: number, today: string): string {
  const year = String(Number(day.slice(0, 4)) + years).padStart(4, "0");
  return today.slice(0, 4) === year ? today : `${year}-01-01`;
}

/**
 * How each kind a chart counts is counted by the day over [from, to): the tab whose chart by day counts it, its measure,
 * and its filters. Calls (those the Calls chip's menu shows) and hangouts with the person picked; workouts and rituals
 * only with nobody picked (nobody is in them, as nobody is in a workout's or a ritual's card), so with a person they are
 * not asked for. Messages and agent messages are not charts: they come from the calendar's day summaries.
 */
export function yearAsks(from: number, to: number, person: number | null, calls: CallsShown = ALL_CALLS): Array<{ kind: CalendarKind; tab: string; measure: string; filters: Filters }> {
  const anyone = { ...NO_FILTERS, from, to, person };
  const asks = [
    { kind: "calls" as const, tab: "calls", measure: "calls", filters: { ...anyone, choices: callsChoices(calls) } },
    { kind: "hangouts" as const, tab: "hangouts", measure: "hangouts", filters: anyone },
    { kind: "workouts" as const, tab: "workouts", measure: "workouts", filters: { ...NO_FILTERS, from, to } },
    { kind: "habits" as const, tab: "habits", measure: "rituals", filters: { ...NO_FILTERS, from, to } },
  ];
  return person === null ? asks : asks.filter((ask) => ask.kind !== "workouts" && ask.kind !== "habits");
}

/** A year's counts as read: each kind asked for, by day (YYYY-MM-DD); a kind not asked for is left out. */
export type YearCounts = Partial<Record<CalendarKind, Readonly<Record<string, number>>>>;

/** The 90th percentile of the values above nought (the nearest rank), at least 1: a kind's busy day of the year. */
export function busyLevel(values: Iterable<number>): number {
  const some = [...values].filter((n) => n > 0).sort((a, b) => a - b);
  if (some.length === 0) return 1;
  return Math.max(1, some[Math.ceil(0.9 * some.length) - 1]);
}

/** A day of the year: its count of each kind counted, its points, and its shade (0 for nothing, 1 to 4). */
export interface YearDay {
  day: string;
  counts: Partial<Record<CalendarKind, number>>;
  points: number;
  shade: number;
}

/** A kind's year: how many in all, on how many days, and its busy day's count (what a full point is). */
export interface KindYear {
  kind: CalendarKind;
  total: number;
  days: number;
  busy: number;
}

/** The year shaded: each of its days, and each kind counted. */
export interface YearPlan {
  days: YearDay[];
  kinds: KindYear[];
}

/** The kinds a year counts: those on and read, in YEAR_KINDS' order. */
export const countedKinds = (counts: YearCounts, kinds: readonly CalendarKind[]): CalendarKind[] => YEAR_KINDS.filter((kind) => kinds.includes(kind) && counts[kind] !== undefined);

/** `days` counted, pointed and shaded, of the kinds on that were read (see the measure above). */
export function planYear(counts: YearCounts, days: readonly string[], kinds: readonly CalendarKind[]): YearPlan {
  const counted = countedKinds(counts, kinds).map((kind): KindYear => {
    const values = days.map((day) => counts[kind]![day] ?? 0);
    return { kind, total: values.reduce((sum, n) => sum + n, 0), days: values.filter((n) => n > 0).length, busy: busyLevel(values) };
  });
  const planned = days.map((day): YearDay => {
    const of: Partial<Record<CalendarKind, number>> = {};
    let points = 0;
    for (const { kind, busy } of counted) {
      const n = counts[kind]![day] ?? 0;
      of[kind] = n;
      points += Math.min(1, n / busy);
    }
    return { day, counts: of, points, shade: 0 };
  });
  const fullest = Math.max(0, ...planned.map((d) => d.points));
  for (const d of planned) d.shade = shadeOf(d.points, fullest);
  return { days: planned, kinds: counted };
}

/** The year's totals as the kind chips carry them: each kind on and read, how many and on how many days, in its chip. */
export function yearTally(plan: YearPlan): Tally {
  const kinds: Tally = {};
  for (const k of plan.kinds) kinds[k.kind] = { label: yearLabel(k.kind), value: countText(k.total), note: `on ${countText(k.days)} ${k.days === 1 ? "day" : "days"}` };
  return kinds;
}
