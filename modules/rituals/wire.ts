// What the module's tabs (Events' Daily rituals, Fitness's Habits) and its server half say to each other
// (server/http.ts), the addresses both halves share, and the shape of rituals' view as the page reads it: what rituals'
// own read-only view prints (src/view.ts, its VIEW_FORMAT: the daily matrix as its dashboard derives it, each habit's
// times, each weekly target's progress and the temporary items with their marks day by day), read in-process from the
// store in the archive's folder (server/view.ts) and handed on whole, or as the dashboard tabs read it. These types are
// the view's shape as the page needs it: server/view.ts holds rituals' own View to them, so a change to rituals'
// envelope fails the typecheck here rather than on the page.
//
//   GET /life-archive/api/m/rituals             -> RitualsAnswer: the whole view (no tab reads it since the Rituals
//                                                  page's Previous tab went)
//   GET /life-archive/api/m/rituals/dashboard   -> RitualsDashboardAnswer: what rituals' own dashboard served, which
//                                                  both tabs read (server/dashboard.ts)
//
// Both are under the viewer's /life-archive/, which Tailscale Serve passes on to the tailnet whole, so the captain's
// phone reaches them as it reaches the rest of the viewer; the tailnet's ACL admits only his own devices. A target's
// notes and a workout's details are his own words (content), shown to him on the page by his choice, as rituals' own
// dashboard showed them on his phone.

import { moduleApi } from "../../sdk/wire.ts";

/** The module's routes' address: the whole view there, the dashboard's under it. */
export const RITUALS_API = moduleApi("rituals");
export const RITUALS_DASHBOARD_API = `${RITUALS_API}/dashboard`;

/** How a habit stands on a day: done, not done, not asked that day, or not reported yet (the day still open). */
export const CELL_STATUSES = ["done", "not_done", "not_applicable", "unreported"] as const;

/**
 * Why it stands so: excused that day, a day before the habit joined the ritual (wind-down's before 2026-11-09, or the
 * days an exception with no start covers), a
 * source's report, the captain's own report, no answer by the day's close (rituals' rates count that as not done), or
 * the day still open.
 */
export const CELL_BASES = ["exception", "not_started", "source_report", "explicit_report", "missing_after_close", "open_day"] as const;

/**
 * How a habit with a deadline stood against it on a day it was asked: wind-down's, midnight at the end of its day (done
 * before it green, after it red). Rituals judges it from the first known time it
 * was done; the day still closes at 06:00, so a late tick is done all the same.
 */
export interface RitualsDeadline {
  /** When it was due, with rituals' offset (2026-11-10T00:00:00+11:00). */
  readonly at: string;
  /** Done in time (true); done at or after it, answered not done, closed with no answer, or the day still open and unanswered past it (false); not judged (null: a tick with no time, or the day still open before it). */
  readonly on_time: boolean | null;
  /** The first known time it was done, with rituals' offset, or null. */
  readonly done_at: string | null;
  /** How that time is known; `unknown` for a tick with no time, null when not done. */
  readonly time_basis: HabitBasis | null;
}

export interface RitualsCell {
  readonly status: (typeof CELL_STATUSES)[number];
  readonly basis: (typeof CELL_BASES)[number];
  /** What the cell shows: a mark (✓ × N/A ·), or the plank's m:ss. */
  readonly text: string;
  /** The same in words ("Done", "66 seconds"). */
  readonly label: string;
  /** A time (the plank's) rather than a mark. */
  readonly numeric: boolean;
  /** Only for a habit with a deadline (wind-down), on a day it was asked. */
  readonly deadline?: RitualsDeadline;
}

export interface RitualsRate {
  readonly done: number;
  /** The closed days the habit applied on (for workouts, every closed day). */
  readonly denominator: number;
  readonly percentage: number | null;
}

/** How the time of a check-in is known: a message's receipt, the imported source's record, or recorded as given. */
export const CHECKIN_BASES = ["message_received", "source_recorded", "recorded"] as const;
export type CheckinBasis = (typeof CHECKIN_BASES)[number];

export interface RitualsCheckin {
  /** The instant, with rituals' offset (2026-10-15T21:40:00+11:00). */
  readonly datetime: string;
  /** Its time of day, 21:40. */
  readonly text: string;
  /** Days after the ritual's own date it came (1 for a check-in after midnight). */
  readonly day_offset: number;
  /** The same in words ("+1 day"), empty on the day itself. */
  readonly day_label: string;
  readonly basis: CheckinBasis;
  /** The whole instant and its basis in words. */
  readonly label: string;
}

/** One workout as the daily matrix shows it: its category (gym push, run, walk) and the captain's own words about it (content). */
export interface RitualsWorkout {
  readonly type: string;
  readonly details: string;
}

export interface RitualsDay {
  /** The ritual's date, YYYY-MM-DD: an evening's, even when it was reported after midnight. */
  readonly date: string;
  readonly display_date: string;
  readonly full_date: string;
  /** closed (counted), open (today's, still answerable) or upcoming. */
  readonly period: string;
  /** The note under the date: Open, No report, Activities only, or empty. */
  readonly annotation: string;
  /** The first check-in of the evening, when there was one. */
  readonly checkin_times: readonly RitualsCheckin[];
  /** Each habit's cell, by habit, in rituals' order. */
  readonly cells: Readonly<Record<string, RitualsCell>>;
  readonly workouts: {
    /** Each workout's title, else its category. */
    readonly labels: readonly string[];
    readonly count: number;
    readonly items: readonly RitualsWorkout[];
  };
}

export interface RitualsDaily {
  readonly generated_at: string;
  readonly updated_display: string;
  readonly timezone: string;
  readonly count: number;
  /** Each habit's rate over the closed days, and `workout`'s. */
  readonly rates: Readonly<Record<string, RitualsRate>>;
  /** Newest first. */
  readonly rows: readonly RitualsDay[];
}

/** How the time a habit was done is known: as the captain stated it, a message's receipt ("just took it"), or not. */
export const HABIT_BASES = ["user_stated", "message_received", "unknown"] as const;
export type HabitBasis = (typeof HABIT_BASES)[number];

export interface RitualsHabitEvent {
  /** Rituals' own id for it (he_...), the same when its time is corrected. */
  readonly id: string;
  /** The ritual's date, YYYY-MM-DD: an evening's, even when it was done after midnight. */
  readonly date: string;
  /** The habit, in rituals' word (magnesium, protein, stretching, planks, journalling, wind_down): a key of a day's cells. */
  readonly habit: string;
  /** The instant, with rituals' offset (2026-10-16T21:00:00+11:00), or null when no time was given. */
  readonly done_at: string | null;
  readonly basis: HabitBasis;
}

/** What a weekly target's amounts and minimum are kept in: whole times, a distance in km, or whole minutes. */
export const TARGET_UNITS = ["count", "km", "minutes"] as const;
export type TargetUnit = (typeof TARGET_UNITS)[number];

export interface RitualsTargetEntry {
  /** Rituals' own id for it (wte_...). */
  readonly id: string;
  /** The ritual's date it counts for, YYYY-MM-DD. */
  readonly date: string;
  /** "Wed 28". */
  readonly display_date: string;
  /** In the target's unit. */
  readonly amount: number;
  /** "1h 30m", "1 fish". */
  readonly amount_text: string;
  /** What was said of it, or null: content. */
  readonly note: string | null;
  /** Who made the report (the captain, or an assistant's name). */
  readonly logged_by: string;
}

export interface RitualsTarget {
  /** Rituals' own id for it (wt_...). */
  readonly id: string;
  readonly name: string;
  readonly unit: TargetUnit;
  /** What a count counts ("fish"), or null. */
  readonly noun: string | null;
  /** The week's minimum, in its unit. */
  readonly minimum: number;
  /** False once retired: then shown only in weeks with its entries. */
  readonly active: boolean;
  readonly position: number;
  readonly total: number;
  /** What is still needed, 0 once met. */
  readonly remaining: number;
  readonly met: boolean;
  /** total / minimum, at most 1: how full its bar is. */
  readonly fraction: number;
  readonly total_text: string;
  readonly minimum_text: string;
  readonly remaining_text: string;
  /** "1 / 2 fish", "3h 20m / 5h". */
  readonly progress_text: string;
  /** By date. */
  readonly entries: readonly RitualsTargetEntry[];
}

export interface RitualsTargetWeek {
  /** The Monday it starts, YYYY-MM-DD. */
  readonly week_start: string;
  readonly week_end: string;
  readonly display: string;
  readonly full: string;
  /** The week holding today's ritual date, still open: not met there is not yet. */
  readonly current: boolean;
  /** How many of its targets are met. */
  readonly met: number;
  /** In display order. */
  readonly targets: readonly RitualsTarget[];
}

export interface RitualsTargets {
  readonly generated_at: string;
  readonly updated_display: string;
  readonly timezone: string;
  /** Today's ritual date (rituals' cutoff applied) and its week's Monday. */
  readonly active_date: string;
  readonly current_week: string;
  /** The current week and the seven before it, newest first; a week with no target to show is left out. */
  readonly weeks: readonly RitualsTargetWeek[];
}

/** How a temporary item stands on a day it applied: ticked, answered no, not answered yet, or only a reminder. */
export const ATTACHMENT_STATUSES = ["done", "not_done", "unreported", "reminder_only"] as const;

export interface RitualsAttachmentDay {
  /** The ritual's date, YYYY-MM-DD. */
  readonly date: string;
  /** "Tue · Sep 29", as a daily row's. */
  readonly display_date: string;
  /** "Tuesday, 29 September 2026". */
  readonly full_date: string;
  readonly status: (typeof ATTACHMENT_STATUSES)[number];
  /** The mark (✓ × ·), or empty for a reminder. */
  readonly text: string;
  /** The same in words. */
  readonly label: string;
  /** When it was ticked, with rituals' offset; null when that is unknown or it was not ticked. */
  readonly done_at: string | null;
  /** How that time is known: set on a tick, null on any other day. */
  readonly basis: HabitBasis | null;
}

/** What a temporary item asks: a check to answer, or a reminder with no answer. */
export const ATTACHMENT_ROLES = ["required_check", "reminder_only"] as const;

export interface RitualsAttachment {
  readonly id: string;
  /** The ritual it is added to (morning, noon, evening or any other identity): open text. */
  readonly ritual: string;
  /** The owner's words: content. */
  readonly text: string;
  readonly role: (typeof ATTACHMENT_ROLES)[number];
  readonly start_date: string;
  readonly end_date: string | null;
  /** ISO 1 to 7, or null for every day. */
  readonly weekday: number | null;
  /** False once its end date has passed. */
  readonly active: boolean;
  /** Newest first: every date it applied, up to `active_date`. */
  readonly days: readonly RitualsAttachmentDay[];
}

export interface RitualsAttachments {
  /** Today's ritual date (the 06:00 cutoff applied): stays yesterday's until then. */
  readonly active_date: string;
  /** By ritual, then start date (so evening sorts before morning); one not yet started is left out. */
  readonly items: readonly RitualsAttachment[];
}

/** Rituals' view, whole: what its read-only view prints (src/view.ts's View, format 7). */
export interface RitualsView {
  readonly format: number;
  readonly daily: RitualsDaily;
  /** Every habit event, oldest date first, known times in order, then unknown ones. */
  readonly events: readonly RitualsHabitEvent[];
  readonly weekly_targets: RitualsTargets;
  readonly attachments: RitualsAttachments;
}

/**
 * The route's answer, always 200: rituals' view, or why there is none: `unset` when the archive's folder has no rituals
 * store (modules/rituals/data/ritual.sqlite3), `failed` when rituals could not read it.
 */
export type RitualsAnswer =
  | { state: "ok"; view: RitualsView }
  | { state: "unset"; reason: string }
  | { state: "failed"; reason: string };

/** An entry of a target, as the dashboard has it: no note, no one who logged it. */
export type DashboardTargetEntry = Omit<RitualsTargetEntry, "note" | "logged_by">;

/** A target, as the dashboard has it: its entries without notes, and in one line ("Tue 27 · Thu 29"). */
export type DashboardTarget = Omit<RitualsTarget, "entries"> & {
  readonly entries_text: string;
  readonly entries: readonly DashboardTargetEntry[];
};

export type DashboardTargetWeek = Omit<RitualsTargetWeek, "targets"> & { readonly targets: readonly DashboardTarget[] };

/** Rituals' /api/targets as its dashboard served it: the weekly targets' progress, stamped, without notes. */
export type DashboardTargets = Omit<RitualsTargets, "weeks"> & { readonly weeks: readonly DashboardTargetWeek[] };

/**
 * What the dashboard tabs read (server/dashboard.ts): the daily matrix whole, the weekly targets without notes, and the
 * temporary items with their marks; never the habit events or anything else of the view.
 */
export interface RitualsDashboard {
  readonly daily: RitualsDaily;
  readonly targets: DashboardTargets;
  readonly attachments: RitualsAttachments;
}

/** The dashboard route's answer, always 200, as RitualsAnswer's. */
export type RitualsDashboardAnswer =
  | { state: "ok"; dashboard: RitualsDashboard }
  | { state: "unset"; reason: string }
  | { state: "failed"; reason: string };
