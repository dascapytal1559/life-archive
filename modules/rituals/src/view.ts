// The read-only view other local programs consume: the same daily and weekly-target projections the dashboard serves.
//
// It reads through the dashboard's mode=ro client only. It never opens the store read-write, changes file
// modes or regenerates data/views, so it works on a read-only copy and leaves every file as it found it.
import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { type Attachment, type AttachmentCheck, type AttachmentsView, attachmentsView } from "./attachments.ts";
import { dateLabels, readOnlyClient } from "./dashboard.ts";
import { reject, type RequiresReview } from "./errors.ts";
import { type EventView, eventView, type HabitEvent } from "./habitEvents.ts";
import { nowMicros, ritualDate, type Micros } from "./instants.ts";
import {
  type DashboardData,
  readDashboardData,
  readTargetsData,
  type ReadError,
  type TargetsData,
} from "./dashboardWeb.ts";

/** Bump on any change to the envelope's shape, including the daily and weekly-target projections inside it. */
export const VIEW_FORMAT = 7;

export interface View {
  readonly format: number;
  readonly daily: DashboardData;
  readonly events: ReadonlyArray<EventView>;
  readonly weekly_targets: TargetsData;
  readonly attachments: AttachmentsView;
}

/**
 * Every habit event, oldest logical date first and unknown times last within a day. A store not yet migrated to
 * version 7 has no events table, and no events: none can be recorded before the migration.
 */
export const readEvents = (root: string): Effect.Effect<Array<EventView>, SqlError | RequiresReview> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* readOnlyClient(root);
      const table = yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='habit_events'`;
      if (table.length === 0) return [];
      const rows =
        yield* sql<HabitEvent>`SELECT id,date,habit,done_at,basis FROM habit_events ORDER BY date,done_at IS NULL,done_at,id`;
      return yield* Effect.forEach(rows, (row) => Effect.fromResult(eventView({ ...row })));
    }),
  );

/**
 * Every ritual's temporary items with their marks up to `activeDate`. A store not yet migrated to version 4 has none;
 * one not yet at version 11 has no times, so its ticks read as unknown.
 */
export const readAttachments = (
  root: string,
  activeDate: string,
): Effect.Effect<AttachmentsView, SqlError | RequiresReview> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* readOnlyClient(root);
      const table = yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ritual_attachments'`;
      if (table.length === 0) return { active_date: activeDate, items: [] };
      const [items, checks] = yield* sql.withTransaction(
        Effect.all([
          sql<Attachment>`SELECT * FROM ritual_attachments ORDER BY ritual,start_date,id`,
          sql<AttachmentCheck>`SELECT * FROM ritual_attachment_checks ORDER BY date,id`,
        ]),
      );
      const decoded = checks.map((row) => ({ ...row, done: row.done === null ? null : Boolean(row.done) }));
      return yield* Effect.fromResult(attachmentsView(items, decoded, activeDate, dateLabels));
    }),
  );

/**
 * All projections at one instant: `daily` is /api/dashboard's body (with `daysThroughActive`, its rows through the
 * active day: readDashboardData's `through`), then the events, then `weekly_targets`, /api/targets' progress with each
 * entry's note and who logged it (and no dashboard-only text), then each ritual's temporary items with their marks day
 * by day.
 */
export const readView = (root: string, asOf?: Micros, { daysThroughActive = false } = {}): Effect.Effect<View, ReadError> =>
  Effect.gen(function* () {
    const stamp = asOf ?? (yield* nowMicros);
    const daily = yield* readDashboardData(root, stamp, daysThroughActive ? ritualDate(stamp) : undefined);
    const events = yield* readEvents(root);
    const weekly_targets = yield* readTargetsData(root, stamp);
    const attachments = yield* readAttachments(root, ritualDate(stamp));
    return { format: VIEW_FORMAT, daily, events, weekly_targets, attachments };
  });

export const main = (argv: ReadonlyArray<string>, root: string): Effect.Effect<View, ReadError | RequiresReview> =>
  argv.length > 0 ? Effect.fail(reject("Usage: ritual-view")) : readView(root);
