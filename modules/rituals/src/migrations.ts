// The reviewed migrations' steps: what moves a store from its schema version to the current one (store.ts's `migrate`
// runs them in one transaction, after its backup, and only when asked: HANDOFF.md's "Schema migrations"). Each step is
// the change its version made and nothing else; none writes an audit row, so every revision and request hash stays.
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import type { SqlError } from "effect/sql/SqlError";
import { TABLE_SQL } from "./applicability.ts";
import { ATTACHMENT_CHECK_TIME_SQL, ATTACHMENT_SQL, ATTACHMENT_WEEKDAY_SQL } from "./attachments.ts";
import { pack } from "./encoding.ts";
import { HABIT_EVENT_SQL } from "./habitEvents.ts";
import { nowMicros, stampZ, weekStart as mondayOf } from "./instants.ts";
import { type MinimumFrom, MINIMUMS_ADD_SQL, MINIMUMS_DROP_SQL, WEEKLY_TARGET_SQL } from "./weeklyTargets.ts";
import { WORKOUT_TITLE_SQL } from "./workouts.ts";

// Version 9 removes weekly review answers: their table (added by version 3) and their audit rows.
const DROP_WEEKLY_SQL = `DROP TABLE IF EXISTS weekly_reviews;
DELETE FROM changes WHERE entity='weekly_reviews';`;

// Version 12 adds the wind-down tick: a nullable column of rituals, as the other habits have.
export const WIND_DOWN_SQL = "ALTER TABLE rituals ADD COLUMN wind_down INTEGER CHECK(wind_down IN (0,1));";

// ...and rebuilds the two tables whose habit check lists the habits, so a wind-down event or exception is allowed:
// same columns, same rows, the new check (TABLE_SQL's and HABIT_EVENT_SQL's).
const HABIT_TABLES_REBUILD_SQL = `ALTER TABLE applicability_exceptions RENAME TO applicability_exceptions_v11;
${TABLE_SQL}
INSERT INTO applicability_exceptions SELECT id,habit,start_date,end_date,reason FROM applicability_exceptions_v11;
DROP TABLE applicability_exceptions_v11;
DROP INDEX IF EXISTS idx_habit_events_date;
DROP INDEX IF EXISTS idx_habit_events_habit_done_at;
ALTER TABLE habit_events RENAME TO habit_events_v11;
${HABIT_EVENT_SQL}
INSERT INTO habit_events SELECT id,date,habit,done_at,basis FROM habit_events_v11;
DROP TABLE habit_events_v11;`;

/** A script's statements, one by one (none of the store's own scripts has a semicolon inside a statement). */
export const statements = (script: string): Array<string> =>
  script
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const runScript = (sql: SqliteClient.SqliteClient, script: string): Effect.Effect<void, SqlError> =>
  Effect.forEach(statements(script), (statement) => sql.unsafe(statement), { discard: true });

/** Every step after version `from`, in order, each recorded in schema_migrations; run inside the caller's transaction. */
export const migrationSteps = (sql: SqliteClient.SqliteClient, from: number): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const applied = (version: number) => Effect.flatMap(nowMicros, (now) => sql`INSERT INTO schema_migrations VALUES(${version},${stampZ(now)})`);
    if (from < 3) {
      // Version 3 added weekly review answers, which version 9 removes again: nothing to create or move now.
      yield* applied(3);
    }
    if (from < 4) {
      yield* runScript(sql, ATTACHMENT_SQL);
      yield* applied(4);
    }
    if (from < 5) {
      yield* runScript(sql, ATTACHMENT_WEEKDAY_SQL);
      yield* applied(5);
    }
    if (from < 6) {
      yield* runScript(sql, WORKOUT_TITLE_SQL);
      yield* applied(6);
    }
    if (from < 7) {
      // Version 7 adds habit events only; no history gets an invented event or time.
      yield* runScript(sql, HABIT_EVENT_SQL);
      yield* applied(7);
    }
    if (from < 8) {
      // Version 8 adds weekly targets and their entries, empty: targets are set up by request afterwards.
      yield* runScript(sql, WEEKLY_TARGET_SQL);
      yield* applied(8);
    }
    if (from < 9) {
      // Version 9 removes the weekly review answers and their audit; the backup taken before keeps both.
      yield* runScript(sql, DROP_WEEKLY_SQL);
      yield* applied(9);
    }
    if (from < 10) {
      // Version 10 dates each target's minimum: the one it had is in force from its first week, so every week is
      // judged exactly as before.
      yield* sql.unsafe(MINIMUMS_ADD_SQL);
      for (const row of yield* sql<{
        id: string;
        start_date: string;
        minimum: number;
      }>`SELECT id,start_date,minimum FROM weekly_targets ORDER BY id`) {
        const minimums: Array<MinimumFrom> = [{ week_start: mondayOf(row.start_date), minimum: row.minimum }];
        yield* sql`UPDATE weekly_targets SET minimums=${pack(minimums)} WHERE id=${row.id}`;
      }
      yield* sql.unsafe(MINIMUMS_DROP_SQL);
      yield* applied(10);
    }
    if (from < 11) {
      // Version 11 adds a check's time; every check already recorded keeps none.
      yield* runScript(sql, ATTACHMENT_CHECK_TIME_SQL);
      yield* applied(11);
    }
    // Version 12 adds the wind-down tick: every day already recorded keeps it null (it applies from HABIT_SINCE on, so
    // no earlier day is asked it), and the two habit tables keep their rows.
    yield* runScript(sql, WIND_DOWN_SQL);
    yield* runScript(sql, HABIT_TABLES_REBUILD_SQL);
    yield* applied(12);
  });
