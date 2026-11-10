// Weekly targets (schema version 8): a weekly minimum per target, its own log of entries, and each week's progress.
// Schema version 10 dates the minimum: each target keeps the minimum in force from each week on (`minimums`), so a
// week is always judged against the minimum it had, and a change never re-judges the weeks before it.
//
// A target's unit is what its amounts and minimum are stored in: `count` (whole times, with an optional display noun),
// `km` (a distance, up to three decimals) or `minutes` (a duration, whole minutes, also written "45m", "1h30m" or
// "1.5h"). An entry counts for a logical ritual date (00:00–05:59 belongs to the day before, as for daily rituals), and
// a week is the Monday-to-Sunday of logical dates. Progress is derived on every read, never
// stored: each target's total for the week against its minimum, whether it is met, and the entries behind it.
import { Effect, Result } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import type { SqlError } from "effect/sql/SqlError";
import { reject, type RequiresReview } from "./errors.ts";
import { addDays, DAYS_SHORT, weekday, weekLabels, weekStart } from "./instants.ts";

export const WEEKLY_TARGET_SQL = `CREATE TABLE weekly_targets(
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name))>0),
 unit TEXT NOT NULL CHECK(unit IN ('count','km','minutes')),
 noun TEXT CHECK(noun IS NULL OR unit='count'),
 minimum REAL NOT NULL CHECK(minimum>0),
 start_date TEXT NOT NULL CHECK(date(start_date) IS start_date),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 position INTEGER NOT NULL CHECK(position>=0)
);
CREATE TABLE weekly_target_entries(
 id TEXT PRIMARY KEY,
 target_id TEXT NOT NULL REFERENCES weekly_targets(id),
 date TEXT NOT NULL CHECK(date(date) IS date),
 amount REAL NOT NULL CHECK(amount>0),
 note TEXT,
 logged_by TEXT NOT NULL CHECK(length(trim(logged_by))>0)
);
CREATE INDEX idx_weekly_target_entries_date ON weekly_target_entries(date,target_id);
CREATE INDEX idx_weekly_target_entries_target_date ON weekly_target_entries(target_id,date);`;

// Version 10 replaces the single minimum with its dated history. SQLite adds a NOT NULL column only with a default;
// every write supplies the history (never empty, see validMinimums), so the default is never kept. The migration fills
// each existing target's history between these two statements (store.ts).
export const MINIMUMS_ADD_SQL = `ALTER TABLE weekly_targets ADD COLUMN minimums TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(minimums) AND json_type(minimums)='array')`;
export const MINIMUMS_DROP_SQL = `ALTER TABLE weekly_targets DROP COLUMN minimum`;

export const UNITS = ["count", "km", "minutes"] as const;
export type Unit = (typeof UNITS)[number];
export const isUnit = (value: unknown): value is Unit => UNITS.includes(value as Unit);

/** The minimum in force from the week starting `week_start` (a Monday) until the next one in the history. */
export interface MinimumFrom {
  readonly week_start: string;
  readonly minimum: number;
}

export interface Target {
  readonly id: string;
  readonly name: string;
  readonly unit: Unit;
  /** What a count counts, for display ("2 laps"); null for km and minutes, or a bare count. */
  readonly noun: string | null;
  /** Oldest first; the first one starts at the target's first week (the week of its start date). */
  readonly minimums: ReadonlyArray<MinimumFrom>;
  /** The first logical date it counts from; its week is the first week the target is shown in. */
  readonly start_date: string;
  readonly active: boolean;
  /** Display order, lowest first. */
  readonly position: number;
}

export interface TargetEntry {
  readonly id: string;
  readonly target_id: string;
  readonly date: string;
  readonly amount: number;
  readonly note: string | null;
  /** Who logged it: the person or assistant that made the report (free text, such as an assistant's name). */
  readonly logged_by: string;
}

/** How many weeks progress covers by default: the current one and the seven before it. */
export const DEFAULT_WEEKS = 8;
const LIMIT = 1_000_000;

const DURATION = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?$/i;
const DISTANCE = /^(\d+(?:\.\d+)?)\s*(?:km)?$/i;

const positive = (value: number, field: string): Result.Result<number, RequiresReview> =>
  Number.isFinite(value) && value > 0 && value <= LIMIT
    ? Result.succeed(value)
    : Result.fail(reject(`${field} must be a positive amount`));

/**
 * An amount or minimum in the target's unit, as stored: a count is a whole number; km a number (or "5km") with at most
 * three decimals; minutes a whole number of minutes, or a duration such as "45m", "1h30m", "1h 30m" or "1.5h".
 */
export const parseAmount = (unit: Unit, value: unknown, field = "amount"): Result.Result<number, RequiresReview> => {
  if (unit === "count") {
    return typeof value === "number" && Number.isInteger(value)
      ? positive(value, field)
      : Result.fail(reject(`${field} of a count target must be a whole number`));
  }
  if (unit === "km") {
    const match = typeof value === "string" ? DISTANCE.exec(value.trim()) : null;
    const km = typeof value === "number" ? value : match ? Number(match[1]) : Number.NaN;
    if (!Number.isFinite(km) || Math.round(km * 1000) / 1000 !== km)
      return Result.fail(reject(`${field} of a km target is a distance in km such as 5, 4.2 or "4.2km"`));
    return positive(km, field);
  }
  const match = typeof value === "string" ? DURATION.exec(value.trim()) : null;
  const minutes =
    typeof value === "number"
      ? value
      : match && (match[1] !== undefined || match[2] !== undefined)
        ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
        : Number.NaN;
  if (!Number.isInteger(minutes))
    return Result.fail(
      reject(
        `${field} of a minutes target is whole minutes, as a number (90) or a duration such as "45m", "1h30m" or "1.5h"`,
      ),
    );
  return positive(minutes, field);
};

/** "3h 20m", "5h", "45m"; "0m" for nothing yet. */
export const durationText = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

/** A stored amount as it reads alone: "2", "2 laps", "4.2 km", "1h 30m". */
export const amountText = (target: Pick<Target, "unit" | "noun">, amount: number): string =>
  target.unit === "minutes"
    ? durationText(amount)
    : target.unit === "km"
      ? `${round(amount)} km`
      : target.noun === null
        ? String(amount)
        : `${amount} ${target.noun}`;

/** Total against minimum, the unit said once: "1 / 2 laps", "3.5 / 5 km", "3h 20m / 5h". */
export const progressText = (
  target: Pick<Target, "unit" | "noun"> & { readonly minimum: number },
  total: number,
): string =>
  target.unit === "minutes"
    ? `${durationText(total)} / ${durationText(target.minimum)}`
    : `${round(total)} / ${amountText(target, target.minimum)}`;

/** Sums of km keep three decimals, so 0.1 + 0.2 reads 0.3. Counts and minutes are whole already. */
const round = (value: number): number => Math.round(value * 1000) / 1000;

export interface EntryView {
  readonly id: string;
  readonly date: string;
  /** "Wed 28" */
  readonly display_date: string;
  readonly amount: number;
  readonly amount_text: string;
  readonly note: string | null;
  readonly logged_by: string;
}

export interface TargetProgress {
  readonly id: string;
  readonly name: string;
  readonly unit: Unit;
  readonly noun: string | null;
  readonly minimum: number;
  readonly active: boolean;
  readonly position: number;
  readonly total: number;
  readonly remaining: number;
  readonly met: boolean;
  /** total / minimum, at most 1: how full a progress bar is. */
  readonly fraction: number;
  readonly total_text: string;
  readonly minimum_text: string;
  readonly remaining_text: string;
  readonly progress_text: string;
  readonly entries: ReadonlyArray<EntryView>;
}

export interface WeekProgress {
  readonly week_start: string;
  readonly week_end: string;
  readonly display: string;
  readonly full: string;
  /** The week holding the current logical date: still open, so "not met" there means "not yet". */
  readonly current: boolean;
  readonly met: number;
  readonly targets: ReadonlyArray<TargetProgress>;
}

export interface Progress {
  readonly active_date: string;
  readonly current_week: string;
  readonly weeks: ReadonlyArray<WeekProgress>;
}

/** The minimum a week is judged against: the latest one in force from that week or before; the first before it. */
export const minimumFor = (minimums: ReadonlyArray<MinimumFrom>, week: string): number =>
  (minimums.findLast((m) => m.week_start <= week) ?? (minimums[0] as MinimumFrom)).minimum;

/** A change that repeats the minimum already in force is no change. */
const collapsed = (minimums: ReadonlyArray<MinimumFrom>): Array<MinimumFrom> =>
  minimums.filter((m, i) => i === 0 || m.minimum !== (minimums[i - 1] as MinimumFrom).minimum);

/** `minimum` from the week `from` on: earlier weeks keep theirs, and any later change already set is replaced. */
export const withMinimum = (minimums: ReadonlyArray<MinimumFrom>, from: string, minimum: number): Array<MinimumFrom> =>
  collapsed([...minimums.filter((m) => m.week_start < from), { week_start: from, minimum }]);

/**
 * The history re-anchored at a new first week (after a start_date correction): a first week moved earlier takes the
 * first minimum, one moved later the minimum that was in force then; the minimums of the weeks after it are kept.
 */
export const startingAt = (minimums: ReadonlyArray<MinimumFrom>, firstWeek: string): Array<MinimumFrom> =>
  collapsed([
    { week_start: firstWeek, minimum: minimumFor(minimums, firstWeek) },
    ...minimums.filter((m) => m.week_start > firstWeek),
  ]);

/**
 * A stored history: at least one minimum, each from a Monday, in order, with no repeated value, the first from the
 * week of `startDate` (the target's first week).
 */
export const validMinimums = (value: unknown, startDate: string): Result.Result<Array<MinimumFrom>, RequiresReview> => {
  const shape = reject(
    "minimums must be the dated minimum history: [{week_start, minimum}, ...], oldest first, from the target's first week",
  );
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return Result.fail(shape);
  const out: Array<MinimumFrom> = [];
  for (const item of value as Array<unknown>) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return Result.fail(shape);
    const { week_start, minimum, ...rest } = item as Record<string, unknown>;
    if (
      Object.keys(rest).length > 0 ||
      typeof week_start !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(week_start) ||
      weekStart(week_start) !== week_start ||
      (out.length > 0 && week_start <= (out.at(-1) as MinimumFrom).week_start)
    )
      return Result.fail(shape);
    const amount = typeof minimum === "number" ? positive(minimum, "minimum") : Result.fail(shape);
    if (Result.isFailure(amount)) return Result.fail(amount.failure);
    out.push({ week_start, minimum: amount.success });
  }
  if ((out[0] as MinimumFrom).week_start !== weekStart(startDate) || collapsed(out).length !== out.length)
    return Result.fail(shape);
  return Result.succeed(out);
};

const byDisplayOrder = (a: Target, b: Target): number =>
  a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1);

/**
 * The current week (holding `activeDate`) and the `count - 1` before it, newest first. A target shows from the week of
 * its start date; a retired one only in weeks that have its entries. Weeks without any target to show are left out.
 * Each week is judged against the minimum in force for it.
 */
export const progress = (
  targets: ReadonlyArray<Target>,
  entries: ReadonlyArray<TargetEntry>,
  activeDate: string,
  count = DEFAULT_WEEKS,
): Progress => {
  const current = weekStart(activeDate);
  const ordered = targets.toSorted(byDisplayOrder);
  const weeks: Array<WeekProgress> = [];
  for (let back = 0; back < count; back++) {
    const start = addDays(current, -7 * back);
    const end = addDays(start, 6);
    const rows: Array<TargetProgress> = [];
    for (const target of ordered) {
      const logged = entries
        .filter((e) => e.target_id === target.id && e.date >= start && e.date <= end)
        .toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
      if (weekStart(target.start_date) > start || (!target.active && logged.length === 0)) continue;
      const minimum = minimumFor(target.minimums, start);
      const total = round(logged.reduce((sum, e) => sum + e.amount, 0));
      const remaining = round(Math.max(0, minimum - total));
      rows.push({
        id: target.id,
        name: target.name,
        unit: target.unit,
        noun: target.noun,
        minimum,
        active: target.active,
        position: target.position,
        total,
        remaining,
        met: total >= minimum,
        fraction: Math.min(1, total / minimum),
        total_text: amountText(target, total),
        minimum_text: amountText(target, minimum),
        remaining_text: amountText(target, remaining),
        progress_text: progressText({ ...target, minimum }, total),
        entries: logged.map((e) => ({
          id: e.id,
          date: e.date,
          display_date: `${DAYS_SHORT[weekday(e.date)]} ${Number(e.date.slice(8))}`,
          amount: e.amount,
          amount_text: amountText(target, e.amount),
          note: e.note,
          logged_by: e.logged_by,
        })),
      });
    }
    if (rows.length === 0) continue;
    weeks.push({
      week_start: start,
      ...weekLabels(start),
      current: back === 0,
      met: rows.filter((r) => r.met).length,
      targets: rows,
    });
  }
  return { active_date: activeDate, current_week: current, weeks };
};

/**
 * Every target and entry, through any client. A store not yet migrated to version 8 has neither; one at version 8 or
 * 9 has a single minimum per target, read as in force from its first week (exactly what migration 10 records).
 */
export const readTargets = (
  sql: SqliteClient.SqliteClient,
): Effect.Effect<{ targets: Array<Target>; entries: Array<TargetEntry> }, SqlError> =>
  Effect.gen(function* () {
    const table = yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='weekly_targets'`;
    if (table.length === 0) return { targets: [], entries: [] };
    const targets = (yield* sql<
      Omit<Target, "active" | "minimums"> & { active: number; minimums?: string; minimum?: number }
    >`SELECT * FROM weekly_targets ORDER BY position,id`).map(({ minimum, minimums, active, ...r }) => ({
      ...r,
      active: active === 1,
      minimums:
        minimums === undefined
          ? [{ week_start: weekStart(r.start_date), minimum: minimum as number }]
          : (JSON.parse(minimums) as Array<MinimumFrom>),
    }));
    const entries = (yield* sql<TargetEntry>`SELECT id,target_id,date,amount,note,logged_by
      FROM weekly_target_entries ORDER BY date,id`).map((r) => ({ ...r }));
    return { targets, entries };
  });
