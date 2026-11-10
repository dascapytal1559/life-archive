// Applicability and completion views; never overwrite raw observations.
// Pure functions: they return Result values and the store lifts them into Effects.
import { Result } from "effect";
import { ApplicabilityConflict, RequiresReview, reject } from "./errors.ts";
import {
  addDays,
  DAY_START_CLOCK,
  isoformat,
  isoformatUtc,
  parseDate,
  parseDateTime,
  ritualDate,
  ritualDayStart,
  TIMEZONE,
  type Micros,
} from "./instants.ts";
import { sameJson } from "./encoding.ts";

/** Alphabetical, which is the order Python's sorted(HABITS) produced everywhere. */
export const HABITS = ["journalling", "magnesium", "planks", "protein", "stretching", "wind_down"] as const;
export type Habit = (typeof HABITS)[number];
export const isHabit = (value: unknown): value is Habit => HABITS.includes(value as Habit);

/**
 * The first logical date a habit joined the daily ritual, for one added after the store began: before it the habit was
 * never asked, so those days are not applicable and every earlier completion stays as it was. Wind-down (ticked by
 * midnight, schema version 12) joined on 2026-11-09. A habit not named here applies from the start.
 */
export const HABIT_SINCE: Partial<Record<Habit, string>> = { wind_down: "2026-11-09" };

/** Whether `habit` was part of the ritual on logical date `day`. */
export const habitStarted = (habit: Habit, day: string): boolean => (HABIT_SINCE[habit] ?? "") <= day;

/** The check on a habit column (applicability_exceptions', habit_events'): every habit. Version 12 rebuilt both tables to add wind_down. */
export const HABIT_CHECK_SQL = `CHECK(habit IN ('magnesium','protein','stretching','journalling','planks','wind_down'))`;

export const TABLE_SQL = `CREATE TABLE applicability_exceptions(
 id TEXT PRIMARY KEY,
 habit TEXT NOT NULL ${HABIT_CHECK_SQL},
 start_date TEXT,
 end_date TEXT NOT NULL,
 reason TEXT NOT NULL,
 CHECK(start_date IS NULL OR start_date <= end_date)
);`;

export interface ExceptionRow {
  readonly id: string;
  readonly habit: Habit;
  readonly start_date: string | null;
  readonly end_date: string;
  readonly reason: string;
}

const EXCEPTION_FIELDS = ["id", "habit", "start_date", "end_date", "reason"];

export const validateException = (
  row: Record<string, unknown>,
  existing: ReadonlyArray<Record<string, unknown>>,
): Result.Result<"replayed" | "new", RequiresReview> => {
  const keys = Object.keys(row);
  if (keys.length !== EXCEPTION_FIELDS.length || !EXCEPTION_FIELDS.every((k) => keys.includes(k))) {
    return Result.fail(reject("Exactly id, habit, start_date, end_date and reason are required"));
  }
  const reason = row.reason;
  if (!row.id || typeof reason !== "string" || reason.trim() === "" || !isHabit(row.habit)) {
    return Result.fail(reject("Valid ID, habit and reason are required"));
  }
  for (const field of ["start_date", "end_date"] as const) {
    const value = row[field];
    if (value === null && field === "start_date") continue;
    if (typeof value !== "string") return Result.fail(reject("Use ISO calendar dates"));
    const parsed = parseDate(value);
    if (Result.isFailure(parsed)) return Result.fail(reject(parsed.failure));
    if (parsed.success !== value) return Result.fail(reject("Use ISO calendar dates"));
  }
  const start = (row.start_date as string | null) ?? "0001-01-01";
  const end = row.end_date as string;
  if (start > end) return Result.fail(reject("Exception dates are reversed"));
  for (const old of existing) {
    if (old.id === row.id) {
      if (sameJson(old, row)) return Result.succeed("replayed");
      return Result.fail(reject("Exception ID already has different content"));
    }
    if (
      old.habit === row.habit &&
      start <= (old.end_date as string) &&
      ((old.start_date as string | null) ?? "0001-01-01") <= end
    ) {
      return Result.fail(reject("Overlapping exceptions for the same habit"));
    }
  }
  return Result.succeed("new");
};

export const applies = (exception: ExceptionRow, habit: Habit, day: string): boolean =>
  exception.habit === habit &&
  (exception.start_date === null || exception.start_date <= day) &&
  day <= exception.end_date;

export type CellStatus = "done" | "not_done" | "not_applicable" | "unreported";
export type CellBasis =
  | "exception"
  | "not_started"
  | "source_report"
  | "explicit_report"
  | "missing_after_close"
  | "open_day";

export interface Cell {
  readonly status: CellStatus;
  readonly basis: CellBasis;
  readonly raw: unknown;
  readonly applicable: boolean;
  readonly included_in_completion: boolean;
  readonly exception_id: string | null;
}

/**
 * Closure is explicit input until the reporting cutoff is agreed.
 *
 * sourceDone can preserve a verified legacy completion without duration; callers must supply its
 * evidence rather than treating missing seconds as no.
 */
export const derive = (
  habit: Habit,
  day: string,
  raw: unknown,
  exceptions: ReadonlyArray<ExceptionRow>,
  closedThrough: string | null,
  sourceDone = false,
): Result.Result<Cell, ApplicabilityConflict | RequiresReview> => {
  if (!isHabit(habit)) return Result.fail(reject("Unknown habit"));
  const present = raw !== null && raw !== undefined;
  const done = sourceDone || (present && (habit === "planks" ? Number(raw) > 0 : Boolean(raw)));
  const match = exceptions.find((x) => applies(x, habit, day));
  if (match && done) {
    return Result.fail(
      new ApplicabilityConflict({ message: `${day} ${habit}: positive report conflicts with exception ${match.id}` }),
    );
  }
  const closed = closedThrough !== null && day <= closedThrough;
  // A day before the habit joined the ritual was never asked it: not applicable, like an exception's day, so it is
  // never a miss and no earlier rate changes. The store refuses an answer for such a day.
  if (!habitStarted(habit, day))
    return Result.succeed({
      status: "not_applicable",
      basis: "not_started",
      raw: present ? raw : null,
      applicable: false,
      included_in_completion: false,
      exception_id: null,
    });
  let status: CellStatus;
  let basis: CellBasis;
  if (match) [status, basis] = ["not_applicable", "exception"];
  else if (done) [status, basis] = ["done", sourceDone ? "source_report" : "explicit_report"];
  else if (present) [status, basis] = ["not_done", "explicit_report"];
  else if (closed) [status, basis] = ["not_done", "missing_after_close"];
  else [status, basis] = ["unreported", "open_day"];
  return Result.succeed({
    status,
    basis,
    raw: present ? raw : null,
    applicable: match === undefined,
    included_in_completion: closed && match === undefined,
    exception_id: match ? match.id : null,
  });
};

export interface Completion {
  readonly done: number;
  readonly applicable: number;
  readonly percentage: number | null;
}

export const completion = (cells: ReadonlyArray<Cell>): Completion => {
  const eligible = cells.filter((cell) => cell.included_in_completion);
  const done = eligible.filter((cell) => cell.status === "done").length;
  return { done, applicable: eligible.length, percentage: eligible.length > 0 ? (100 * done) / eligible.length : null };
};

/** An instant given as microseconds or as an offset-bearing ISO string (Z accepted). */
export const asInstant = (value: Micros | string): Result.Result<Micros, RequiresReview> => {
  if (typeof value === "number") return Result.succeed(value);
  const parsed = parseDateTime(value.replace("Z", "+00:00"));
  if (Result.isFailure(parsed)) return Result.fail(reject(parsed.failure));
  if (parsed.success.offsetSeconds === null) return Result.fail(reject("as_of must be an instant with an offset"));
  return Result.succeed(parsed.success.micros);
};

/** A day closes when the next one starts: DAY_START_HOUR the next morning, local time. */
export const closesAt = (day: string): string => {
  const close = ritualDayStart(addDays(day, 1));
  return isoformat(close.micros, close.offsetSeconds);
};

export interface Period {
  readonly as_of: string;
  readonly timezone: string;
  readonly cutoff: string;
  readonly active_date: string;
  readonly closed_through: string;
  readonly active_closes_at: string;
}

export const period = (value: Micros | string): Result.Result<Period, RequiresReview> =>
  Result.map(asInstant(value), (stamp) => {
    const active = ritualDate(stamp);
    return {
      as_of: isoformatUtc(stamp),
      timezone: TIMEZONE,
      cutoff: `${DAY_START_CLOCK} next day`,
      active_date: active,
      closed_through: addDays(active, -1),
      active_closes_at: closesAt(active),
    };
  });

export interface RitualLike {
  readonly date: string;
  readonly [field: string]: unknown;
}

export interface StatusRow {
  readonly date: string;
  readonly has_ritual: boolean;
  readonly has_activity: boolean;
  /** Closed days enter rates: past the next morning's close (closes_at), or the active day once every applicable habit is done. */
  readonly period: "closed" | "open" | "upcoming";
  readonly closes_at: string;
  readonly habits: Record<Habit, Cell>;
}

export interface StatusReport extends Period {
  readonly coverage: { readonly from: string; readonly to: string } | null;
  readonly records: ReadonlyArray<StatusRow>;
  readonly count: number;
  readonly active_period: StatusRow;
  readonly completion: Completion;
  readonly by_habit: Record<Habit, Completion>;
}

/** Derive a requested logical day without creating an observation or changing coverage. */
export const dailyStatus = (
  day: string,
  original: RitualLike | undefined,
  hasActivity: boolean,
  exceptions: ReadonlyArray<ExceptionRow>,
  context: Period,
): Result.Result<StatusRow, ApplicabilityConflict | RequiresReview> => {
  const habits = {} as Record<Habit, Cell>;
  for (const habit of HABITS) {
    const cell = derive(
      habit,
      day,
      original?.[habit === "planks" ? "plank_seconds" : habit],
      exceptions,
      context.closed_through,
    );
    if (Result.isFailure(cell)) return Result.fail(cell.failure);
    habits[habit] = cell.success;
  }
  // A complete active day closes at once: nothing left in it can become a miss before it closes.
  // Answers stay editable until closes_at; un-ticking a habit reopens the day.
  const complete = HABITS.every((habit) => habits[habit].status === "done" || !habits[habit].applicable);
  const closedEarly = day === context.active_date && complete;
  if (closedEarly)
    for (const habit of HABITS) habits[habit] = { ...habits[habit], included_in_completion: habits[habit].applicable };
  return Result.succeed({
    date: day,
    has_ritual: original !== undefined,
    has_activity: hasActivity,
    period: day <= context.closed_through || closedEarly ? "closed" : day === context.active_date ? "open" : "upcoming",
    closes_at: closesAt(day),
    habits,
  });
};

export const statusReport = (
  rituals: ReadonlyArray<RitualLike>,
  workouts: ReadonlyArray<{ readonly date: string }>,
  exceptions: ReadonlyArray<ExceptionRow>,
  asOf: Micros | string,
  start?: string | null,
  end?: string | null,
): Result.Result<StatusReport, ApplicabilityConflict | RequiresReview> => {
  const contextResult = period(asOf);
  if (Result.isFailure(contextResult)) return Result.fail(contextResult.failure);
  const context = contextResult.success;
  const raw = new Map(rituals.map((r) => [r.date, r] as const));
  const activityDates = new Set(workouts.map((w) => w.date));
  const known = [...new Set([...raw.keys(), ...activityDates])].toSorted();
  const row = (day: string) => dailyStatus(day, raw.get(day), activityDates.has(day), exceptions, context);
  const records: Array<StatusRow> = [];
  if (known.length > 0) {
    const firstKnown = known[0] as string;
    const lastKnown = known[known.length - 1] as string;
    const first = [firstKnown, start ?? firstKnown].toSorted()[1] as string;
    const last = [lastKnown, end ?? lastKnown].toSorted()[0] as string;
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const built = row(day);
      if (Result.isFailure(built)) return Result.fail(built.failure);
      records.push(built.success);
    }
  }
  const active = row(context.active_date);
  if (Result.isFailure(active)) return Result.fail(active.failure);
  const byHabit = {} as Record<Habit, Completion>;
  for (const habit of HABITS) byHabit[habit] = completion(records.map((r) => r.habits[habit]));
  return Result.succeed({
    ...context,
    coverage: known.length > 0 ? { from: known[0] as string, to: known[known.length - 1] as string } : null,
    records,
    count: records.length,
    active_period: active.success,
    completion: completion(records.flatMap((r) => Object.values(r.habits))),
    by_habit: byHabit,
  });
};
