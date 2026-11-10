// Rituals' habits as rows of marks, the captain's: "we just need like small dots. We don't really need a row dedicated
// to each entry". One row a habit, one slot a day (or a week, for a weekly target), oldest at the left: green for done,
// red for a reported not done, hollow for today while it is still going (red at once for a habit past its deadline,
// wind-down after midnight), and no dot for a closed day with no answer or
// one the habit did not apply on by rituals' own rules (a row keeps those apart, `notAsked`, for the run to draw as a
// grey dot). A row's own `done` and `counted` are over its dots, so over the answered days (the captain once: "if it's
// missing then don't count it"); but Daily rituals' run is stricter, as he later said ("On daily rituals no answer is
// considered not done"): there a closed day with no answer is drawn and counted as a not done (run.ts), and only a day
// not asked is left out, as rituals' own rates do.
//
// Every status is rituals' own, already derived (../wire.ts, RitualsDashboard: its daily matrix, its temporary items
// and its weekly targets, with today's ritual date after the 06:00 cutoff): this only places them. Two pages read it:
// the Events page's Daily rituals (every habit, magnesium, protein, stretches, the plank, journalling and winding down
// before midnight, and the temporary checks running now, in the order they were added: byAdded), drawn as their whole run (RunRows.tsx, run.ts), and Fitness's Habits (the weekly
// targets, all but the fish one), drawn as rows of dots (DotRows.tsx).

import { addDays, LOCALE, WIND_DOWN_NAME } from "../../../sdk/wire.ts";
import type { DashboardTarget, DashboardTargets, HabitBasis, RitualsAttachment, RitualsAttachmentDay, RitualsAttachments, RitualsDaily, RitualsDay, RitualsDeadline } from "../wire.ts";

/**
 * How a slot of a row stands: done, not done, or today's, still going (a hollow circle). A habit with a deadline
 * (wind-down's midnight) has three more: `late`, ticked at or after its deadline (red, as the captain asked: "after
 * twelve it's red"), and `untimed`, ticked with no time given, so not judged (neutral), both done and counted as done;
 * and `overdue`, today's with no answer once its deadline has passed (red at once, though it can still be ticked until
 * the day closes at 06:00), not counted, as today's hollow circle is not.
 */
export type Mark = "done" | "not_done" | "open" | "late" | "untimed" | "overdue";

/** The marks that are a done. */
export const DONE_MARKS: ReadonlySet<Mark> = new Set<Mark>(["done", "late", "untimed"]);

export interface Dot {
  readonly mark: Mark;
  /** What it says after its date, in its tooltip: "Done · 07:30 as stated". */
  readonly words: string;
}

/** A place on the rows' axis: a day, or a week for the weekly targets. */
export interface Slot {
  /** The day, or the week's Monday, YYYY-MM-DD. */
  readonly key: string;
  /** Its date in words, for its dots' tooltips: "Fri 6 Nov", "Oct 26 – Nov 1". */
  readonly label: string;
  /** Its label on the rows' axis, where a month of weeks begins; none elsewhere, and none for a day. */
  readonly tick: string | null;
  /** Today's, or this week's. */
  readonly current: boolean;
}

export interface DotRow {
  readonly key: string;
  readonly name: string;
  /** A line under the name (a weekly target's progress this week), or none. */
  readonly note: string | null;
  /** The first slot it applies on (a habit's first day in rituals, a check's start, a target's first week counted). */
  readonly since: string;
  /** Its dots, by their slot's key; a slot with none has no dot. */
  readonly dots: ReadonlyMap<string, Dot>;
  /** The days (not weeks) it did not apply on by rituals' own rules, or a check was not asked: no dot, not counted. The run draws them as a grey dot. */
  readonly notAsked: ReadonlySet<string>;
  /** How many of its counted slots were done, and how many were counted (a filled dot, green or red). */
  readonly done: number;
  readonly counted: number;
}

/** Each habit's name, as rituals' dashboard heads it; one rituals adds later is its key in words ("cold_shower" is Cold shower). */
const HABIT_NAMES: Readonly<Record<string, string>> = {
  magnesium: "Magnesium",
  protein: "Protein",
  stretching: "Stretches",
  planks: "Plank",
  journalling: "Journalling",
  wind_down: WIND_DOWN_NAME,
};

export function habitName(habit: string): string {
  const words = habit.replace(/_/g, " ");
  return HABIT_NAMES[habit] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rituals' habits, in its order, as its days' cells have them: every one is a daily ritual. */
export function habitsOf(daily: RitualsDaily): string[] {
  const row = daily.rows[0];
  return row ? Object.keys(row.cells) : Object.keys(daily.rates).filter((key) => key !== "workout");
}

/** The habit whose dots' tooltips say when he checked in that evening. */
export const CHECKIN_HABIT = "journalling";

/** How a habit's time is known, in a word or two. */
const BASIS_WORDS: Record<HabitBasis, string> = { user_stated: "as stated", message_received: "message receipt", unknown: "time not given" };

/** What a hollow circle says. */
export const STILL_GOING = "Today, still going";

const dayWords = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const tickWords = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
const monthWords = new Intl.DateTimeFormat(LOCALE, { month: "short", timeZone: "UTC" });
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
export const isMonday = (day: string) => utc(day).getUTCDay() === 1;
/** A day as an axis names it: "24 Aug". */
export const tickOf = (day: string) => tickWords.format(utc(day));

/** Every day from `from` to `to`, a slot each (the run names its own dates on its axis: run.ts's axisLabels). */
export function daySlots(from: string, to: string, today: string): Slot[] {
  const slots: Slot[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) slots.push({ key: day, label: dayWords.format(utc(day)), tick: null, current: day === today });
  return slots;
}

/** The days the rows span: from the first day rituals shows (a row, or an item's day) to today. */
export function daySpan(daily: RitualsDaily, items: readonly RitualsAttachment[], today: string): Slot[] {
  const days = [...daily.rows.map((row) => row.date), ...items.flatMap((item) => item.days.map((day) => day.date))].filter((day) => day <= today);
  const from = days.reduce((first, day) => (day < first ? day : first), today);
  return daySlots(from, today, today);
}

/** Where a tooltip `width` wide centres to sit over `x` and stay within a block `block` wide. */
export const tipCentre = (x: number, width: number, block: number): number => Math.max(width / 2, Math.min(x, block - width / 2));

/** How many of `dots` were done, of every filled one (today's, still open or overdue, is not counted). */
function countOf(dots: ReadonlyMap<string, Dot>): { done: number; counted: number } {
  let done = 0;
  let counted = 0;
  for (const dot of dots.values()) {
    if (dot.mark === "open" || dot.mark === "overdue") continue;
    counted += 1;
    if (DONE_MARKS.has(dot.mark)) done += 1;
  }
  return { done, counted };
}

/** A row, its counts from its dots. */
function rowOf(key: string, name: string, note: string | null, since: string, dots: Map<string, Dot>, notAsked: ReadonlySet<string> = new Set()): DotRow {
  return { key, name, note, since, dots, notAsked, ...countOf(dots) };
}

/** The time of day of an instant rituals gives with its offset: "23:40". */
const clockOf = (stamp: string) => stamp.slice(11, 16);

/** When a habit with a deadline is due, in words: "midnight", or its time of day. */
const dueWords = (deadline: RitualsDeadline): string => (clockOf(deadline.at) === "00:00" ? "midnight" : clockOf(deadline.at));

/**
 * A done tick of a habit with a deadline, as rituals judged it: green before it, red at or after it, neutral with no
 * time given; its words say when, how that is known and against what ("Done · 23:40 as stated, before midnight").
 */
function deadlineDot(deadline: RitualsDeadline): Dot {
  const due = dueWords(deadline);
  if (deadline.done_at === null || deadline.on_time === null) return { mark: "untimed", words: `Done · ${BASIS_WORDS.unknown}` };
  const when = `${clockOf(deadline.done_at)} ${BASIS_WORDS[deadline.time_basis ?? "unknown"]}`;
  return deadline.on_time ? { mark: "done", words: `Done · ${when}, before ${due}` } : { mark: "late", words: `Done · ${when}, after ${due}` };
}

/** Today's tick of a habit with a deadline, still unanswered once the deadline has passed ("Not done yet, past midnight"). */
function overdueDot(deadline: RitualsDeadline): Dot {
  return { mark: "overdue", words: `Not done yet, past ${dueWords(deadline)}` };
}

/** A day's dot for a habit, from its cell: none when it did not apply, or had no answer by the day's close; today's past its deadline red. */
function habitDot(row: RitualsDay, habit: string, today: string): Dot | null {
  const cell = row.cells[habit];
  if (!cell) return null;
  if (cell.status === "done" && cell.deadline) return deadlineDot(cell.deadline);
  if (cell.status === "done") return { mark: "done", words: cell.numeric ? `Done · held ${cell.text}` : "Done" };
  if (cell.status === "not_done" && cell.basis !== "missing_after_close") return { mark: "not_done", words: "Not done" };
  if (cell.status === "unreported" && row.date === today) return cell.deadline?.on_time === false ? overdueDot(cell.deadline) : { mark: "open", words: STILL_GOING };
  return null;
}

/**
 * A habit's row over the days rituals shows, to today (the dashboard's rows run through today, each derived by rituals:
 * a day an exception covers is not applicable, a closed day with no answer not done, today unreported). Today is still going until it is
 * answered: a hollow circle, or red once a deadline it has passed unanswered. With `checkins`, a dot's tooltip says when he checked in that evening.
 */
export function habitRow(daily: RitualsDaily, habit: string, today: string, { checkins = false } = {}): DotRow {
  const dots = new Map<string, Dot>();
  const notAsked = new Set<string>();
  const uncelled: string[] = [];
  let since = today;
  for (const row of daily.rows) {
    if (row.date > today) continue;
    // A day before the habit joined the ritual (rituals' not_started) is as a day it had no cell: before its first.
    const cell = row.cells[habit]?.basis === "not_started" ? undefined : row.cells[habit];
    if (cell && row.date < since) since = row.date;
    if (!cell) uncelled.push(row.date);
    else if (cell.status === "not_applicable") notAsked.add(row.date);
    const dot = habitDot(row, habit, today);
    if (!dot) continue;
    const checkin = checkins ? row.checkin_times[0] : undefined;
    dots.set(row.date, checkin ? { ...dot, words: `${dot.words} · checked in ${checkin.text}${checkin.day_label ? ` ${checkin.day_label}` : ""}` } : dot);
  }
  // A day rituals shows with no cell for the habit, after its first, did not ask it either; before its first the habit did not exist.
  for (const date of uncelled) if (date > since) notAsked.add(date);
  return rowOf(habit, habitName(habit), null, since, dots, notAsked);
}

/** The rituals in the order of a day; any other identity follows. */
const RITUAL_ORDER = ["morning", "noon", "evening"];

/**
 * The temporary checks with a row: the ones running now that ask for a tick (a reminder has none), the morning's
 * first, then noon, evening and any other, each ritual's in rituals' order. A finished one has no row.
 */
export function runningChecks(attachments: RitualsAttachments): RitualsAttachment[] {
  const rank = (ritual: string) => {
    const at = RITUAL_ORDER.indexOf(ritual);
    return at === -1 ? RITUAL_ORDER.length : at;
  };
  return attachments.items.filter((item) => item.active && item.role === "required_check").sort((a, b) => rank(a.ritual) - rank(b.ritual));
}

/**
 * Rows in the order they were added, oldest first, as the captain asked: "the habits that are added later to be at the
 * bottom". A row's added day is its `since` (a habit's first day rituals asks it, so wind-down's HABIT_SINCE; a check's
 * start), taken as `from`, the first day shown, when earlier; rows added the same day keep the order given.
 */
export function byAdded(rows: readonly DotRow[], from: string): DotRow[] {
  const added = (row: DotRow) => (row.since < from ? from : row.since);
  return [...rows].sort((a, b) => (added(a) < added(b) ? -1 : added(a) > added(b) ? 1 : 0));
}

/** A tick's words: rituals' label, then its time and how the time is known ("Done · 07:30 as stated"). */
export function tickWordsOf(day: Pick<RitualsAttachmentDay, "label" | "status" | "done_at" | "basis">): string {
  if (day.status !== "done") return day.label;
  return `${day.label} · ${day.done_at === null ? BASIS_WORDS.unknown : `${day.done_at.slice(11, 16)} ${BASIS_WORDS[day.basis ?? "unknown"]}`}`;
}

/**
 * A temporary check's row: its days as rituals marks them, today's hollow until it is answered. Rituals lists every date
 * a check applied on, so a date from its start to today that it does not list was not asked (a check for one weekday).
 */
export function checkRow(item: RitualsAttachment, today: string): DotRow {
  const dots = new Map<string, Dot>();
  const asked = new Set<string>();
  for (const day of item.days) {
    if (day.date > today) continue;
    asked.add(day.date);
    if (day.status === "done") dots.set(day.date, { mark: "done", words: tickWordsOf(day) });
    else if (day.status === "not_done") dots.set(day.date, { mark: "not_done", words: tickWordsOf(day) });
    else if (day.status === "unreported" && day.date === today) dots.set(day.date, { mark: "open", words: STILL_GOING });
  }
  const notAsked = new Set<string>();
  for (let day = item.start_date; day <= today; day = addDays(day, 1)) if (!asked.has(day)) notAsked.add(day);
  return rowOf(item.id, item.text, null, item.start_date, dots, notAsked);
}

/** A weekly target counted in fish, as rituals' dashboard keys its fish icons: by the count's noun, not the name. */
export const isFishTarget = (target: Pick<DashboardTarget, "unit" | "noun">): boolean => target.unit === "count" && target.noun === "fish";

/**
 * The weekly targets Fitness shows: all but the fish target, which the captain took off Fitness, each week's met count
 * over the rest, and a week left with no target gone. Rituals still keeps and counts the fish target; only this view
 * leaves it out.
 */
export function fitnessTargets(targets: DashboardTargets): DashboardTargets {
  const weeks = targets.weeks
    .map((week) => {
      const kept = week.targets.filter((target) => !isFishTarget(target));
      return { ...week, targets: kept, met: kept.filter((target) => target.met).length };
    })
    .filter((week) => week.targets.length > 0);
  return { ...targets, weeks };
}

/** The weeks of the weekly targets, oldest first, a slot each, a tick where a month begins. */
export function weekSlots(targets: DashboardTargets): Slot[] {
  const weeks = [...targets.weeks].reverse();
  return weeks.map((week, at) => {
    const month = week.week_start.slice(0, 7);
    const newMonth = at === 0 || weeks[at - 1].week_start.slice(0, 7) !== month;
    return { key: week.week_start, label: week.display, tick: newMonth ? monthWords.format(utc(week.week_start)) : null, current: week.current };
  });
}

/** The targets of the weeks, each once, in rituals' display order (its position, then its name). */
function targetsOf(targets: DashboardTargets): DashboardTarget[] {
  const seen = new Map<string, DashboardTarget>();
  for (const week of targets.weeks) for (const target of week.targets) if (!seen.has(target.id)) seen.set(target.id, target);
  return [...seen.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * A row a weekly target, a dot a week it was counted in: met green, missed red, this week hollow until met. Under its
 * name, this week's progress ("1 / 3 laps"); a week it was not counted in has no dot.
 */
export function targetRows(targets: DashboardTargets): DotRow[] {
  const current = targets.weeks.find((week) => week.current);
  return targetsOf(targets).map((target) => {
    const dots = new Map<string, Dot>();
    for (const week of targets.weeks) {
      const then = week.targets.find((candidate) => candidate.id === target.id);
      if (!then) continue;
      const mark: Mark = then.met ? "done" : week.current ? "open" : "not_done";
      const standing = then.met ? "met" : week.current ? `${then.remaining_text} to go` : "not met";
      dots.set(week.week_start, { mark, words: `${then.progress_text}, ${standing}` });
    }
    const now = current?.targets.find((candidate) => candidate.id === target.id);
    const since = [...dots.keys()].reduce((first, week) => (week < first ? week : first));
    return rowOf(target.id, target.name, now ? now.progress_text : null, since, dots);
  });
}
