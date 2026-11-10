// A habit's deadline: the clock time its tick should come by, judged from the time it was done (its habit events).
//
// Wind-down has one, midnight at the end of its logical date: done before it is green, after it red. Its day still
// closes at 06:00 like every habit's, so a tick after midnight counts as done for completion; the deadline only
// says whether it came in time. It is derived on every read, never stored, and judges nothing it does not know: a tick
// with no time is done without a verdict, and an open day with no answer is not judged until its deadline has passed
// (red after midnight), then late at once, though it can still be ticked until 06:00.
import { Result } from "effect";
import type { Cell, Habit } from "./applicability.ts";
import type { RequiresReview } from "./errors.ts";
import { type EventBasis, type HabitEvent, microsOf } from "./habitEvents.ts";
import { addDays, fromLocal, isoformat, isoformatLocal, type Micros } from "./instants.ts";

/** The hour of the next calendar day (local time) by which each habit with a deadline is due: 0 is midnight. */
export const HABIT_DEADLINES: Partial<Record<Habit, number>> = { wind_down: 0 };

export interface Deadline {
  /** When it is due, in the store's time zone with its offset: midnight after the logical date for wind-down. */
  readonly at: string;
  /** Done before `at` (true); done at or after it, not done once answered or closed, or still unanswered once `at` has passed (false); not judged (null). */
  readonly on_time: boolean | null;
  /** The first known time it was done that day, with its offset, or null when no time is known. */
  readonly done_at: string | null;
  /** How that time is known; `unknown` for a tick with no time, null when it was not done. */
  readonly time_basis: EventBasis | null;
}

/**
 * How `habit`'s cell on `day` stands against its deadline at `asOf`, from that day's events of the habit; null for a
 * habit with none, or a day it was not asked.
 */
export const deadlineOf = (
  habit: Habit,
  day: string,
  cell: Cell,
  events: ReadonlyArray<Pick<HabitEvent, "habit" | "date" | "done_at" | "basis">>,
  asOf: Micros,
): Result.Result<Deadline | null, RequiresReview> =>
  Result.gen(function* () {
    const hour = HABIT_DEADLINES[habit];
    if (hour === undefined || cell.status === "not_applicable") return null;
    const due = fromLocal(addDays(day, 1), hour);
    const at = isoformat(due.micros, due.offsetSeconds);
    if (cell.status !== "done") return { at, on_time: cell.status === "not_done" || asOf >= due.micros ? false : null, done_at: null, time_basis: null };
    let first: { micros: number; basis: EventBasis } | null = null;
    for (const event of events) {
      if (event.habit !== habit || event.date !== day || event.done_at === null) continue;
      const micros = yield* microsOf(event.done_at);
      if (first === null || micros < first.micros) first = { micros, basis: event.basis };
    }
    if (first === null) return { at, on_time: null, done_at: null, time_basis: "unknown" };
    return { at, on_time: first.micros < due.micros, done_at: isoformatLocal(first.micros), time_basis: first.basis };
  });
