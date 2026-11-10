// Habit events (schema version 7): when each habit was done, under the daily tick the dashboard shows.
//
// A ritual day keeps one tick per habit; an event records one doing of a habit on that logical date (two doses of
// protein are two events) and when it happened, if that is known. An event always has a done tick above it: recording
// one sets the tick, and a tick cannot be taken back while events remain. Unknown time stays unknown (null), never
// invented: the time comes from the user's words, or from the message receipt when the words mean "just now".
import { Result } from "effect";
import { type Habit, HABIT_CHECK_SQL, HABITS, isHabit } from "./applicability.ts";
import { reject, type RequiresReview } from "./errors.ts";
import {
  addDays,
  DAY_START_CLOCK,
  isoformatLocal,
  type Micros,
  MICROS_PER_SECOND,
  parseDateTime,
  RECEIPT_STAMP,
  ritualDayStart,
  ZONE_PLACE,
} from "./instants.ts";

export const HABIT_EVENT_SQL = `CREATE TABLE habit_events(
 id TEXT PRIMARY KEY,
 date TEXT NOT NULL REFERENCES rituals(date),
 habit TEXT NOT NULL ${HABIT_CHECK_SQL},
 done_at TEXT,
 basis TEXT NOT NULL CHECK(basis IN ('user_stated','message_received','unknown')),
 CHECK((done_at IS NULL) = (basis = 'unknown'))
);
CREATE INDEX idx_habit_events_date ON habit_events(date);
CREATE INDEX idx_habit_events_habit_done_at ON habit_events(habit,done_at);`;

/**
 * How an event's time is known: the user said or clearly implied it (`user_stated`); it is the receipt time of a
 * message whose words mean "just now", labelled "Received at …" in source_text (`message_received`, as for
 * check-ins); or it is not known (`unknown`, done_at null).
 */
export const BASES = ["user_stated", "message_received", "unknown"] as const;
export type EventBasis = (typeof BASES)[number];
export const isBasis = (value: unknown): value is EventBasis => BASES.includes(value as EventBasis);

export interface HabitEvent {
  readonly id: string;
  readonly date: string;
  readonly habit: Habit;
  readonly done_at: string | null;
  readonly basis: EventBasis;
}

/**
 * The habits whose tick must come with an event (a time, or an explicit `unknown`) when a ritual_put sets it. Planks
 * are left out: their report is the seconds, and a bare completion has no time to give.
 */
export const TIMED_HABITS = [
  "journalling",
  "magnesium",
  "protein",
  "stretching",
  "wind_down",
] as const satisfies ReadonlyArray<Habit>;

/** The rituals column that holds a habit's tick. */
export const tickField = (habit: Habit): string => (habit === "planks" ? "plank_seconds" : habit);

/** Whether a ritual day's tick says the habit was done: true, or a positive plank time. */
export const ticked = (day: Record<string, unknown> | null, habit: Habit): boolean => {
  const value = day?.[tickField(habit)];
  return habit === "planks" ? typeof value === "number" && value > 0 : value === true;
};

/** Leeway for a stated time a little ahead of this machine's clock (a phone's receipt stamp, say). */
const CLOCK_SKEW = 5 * 60 * MICROS_PER_SECOND;

/** The instant of an offset-bearing timestamp, such as a stored done_at. */
export const microsOf = (stamp: string): Result.Result<Micros, RequiresReview> => {
  const parsed = parseDateTime(stamp.replace("Z", "+00:00"));
  if (Result.isFailure(parsed)) return Result.fail(reject(parsed.failure));
  if (parsed.success.offsetSeconds === null) return Result.fail(reject("Timestamp must include UTC offset"));
  return Result.succeed(parsed.success.micros);
};

/** Whole seconds, the precision a stored instant keeps. */
const second = (micros: Micros): number => Math.floor(micros / MICROS_PER_SECOND);

/**
 * The time rules for an event whose done_at is already a normalised instant (or null): basis agrees with done_at,
 * the instant lies inside its logical date (DAY_START_CLOCK that day to DAY_START_CLOCK the next, local time), is not
 * in the future, and a receipt-time basis names a "Received at" instant in the request's source_text. A ritual item's
 * check (attachments.ts) keeps its time by these same rules.
 */
export const checkTime = (
  event: Pick<HabitEvent, "date" | "done_at" | "basis">,
  sourceText: string,
  now: Micros,
): Result.Result<void, RequiresReview> =>
  Result.gen(function* () {
    if ((event.done_at === null) !== (event.basis === "unknown"))
      return yield* Result.fail(reject("An event's done_at is null exactly when its basis is unknown"));
    if (event.done_at === null) return;
    const at = yield* microsOf(event.done_at);
    const opens = ritualDayStart(event.date).micros;
    const closes = ritualDayStart(addDays(event.date, 1)).micros;
    if (at < opens || at >= closes)
      return yield* Result.fail(
        reject(
          `done_at ${event.done_at} is outside ritual date ${event.date} (${DAY_START_CLOCK} that day to ${DAY_START_CLOCK} the next, ${ZONE_PLACE} time)`,
        ),
      );
    if (at > now + CLOCK_SKEW)
      return yield* Result.fail(reject("done_at is in the future; record only a time that has passed"));
    if (event.basis === "message_received") {
      const receipts = [...sourceText.matchAll(RECEIPT_STAMP)].map((m) => microsOf(m[1] as string));
      if (!receipts.some((r) => Result.isSuccess(r) && second(r.success) === second(at)))
        return yield* Result.fail(
          reject("A message_received time must be the receipt instant stated as 'Received at …' in source_text"),
        );
    }
  });

/** The shape of one event in a ritual_put's `events`, before its instant is normalised. */
export const eventInput = (
  value: unknown,
): Result.Result<{ habit: Habit; done_at: unknown; basis: EventBasis }, RequiresReview> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return Result.fail(reject("Each event is an object with habit, done_at and basis"));
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((k) => k !== "habit" && k !== "done_at" && k !== "basis"))
    return Result.fail(reject("An event has only habit, done_at and basis"));
  if (!isHabit(row.habit)) return Result.fail(reject(`Unknown habit; use one of ${HABITS.join(", ")}`));
  if (!isBasis(row.basis)) return Result.fail(reject(`basis must be one of ${BASES.join(", ")}`));
  return Result.succeed({ habit: row.habit, done_at: "done_at" in row ? row.done_at : null, basis: row.basis });
};

/** An event as other local programs read it (bin/ritual-view): done_at in local time with its offset. */
export interface EventView {
  readonly id: string;
  readonly date: string;
  readonly habit: Habit;
  readonly done_at: string | null;
  readonly basis: EventBasis;
}

export const eventView = (event: HabitEvent): Result.Result<EventView, RequiresReview> =>
  Result.map(event.done_at === null ? Result.succeed(null) : microsOf(event.done_at), (at) => ({
    id: event.id,
    date: event.date,
    habit: event.habit,
    done_at: at === null ? null : isoformatLocal(at),
    basis: event.basis,
  }));
