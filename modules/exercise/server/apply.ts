// How the module's connectors' imports land (module.ts's `connectors`, sdk/server.ts's ModuleConnectors): the core's
// host runs the polar and polar-export connectors as it runs its own, checks every event they write, and hands each
// import's (or each live batch's) events here, inside its transaction of the module's database. Each `workout` event
// is one copy for the index (workoutIndex.ts's WorkoutWriter), a tally is counted, and anything else is a connector's
// mistake. What was added or changed comes back as calendar rows (calendar.ts), which the core pushes once the
// transaction has committed; the counts go in the import's record.

import type { DatabaseSync } from "node:sqlite";
import { emptyCounts, type AppliedSource, type ArchiveEvent, type CalendarRow, type ImportCounts } from "../../../sdk/server.ts";
import { calendarRow } from "./calendar.ts";
import { DELETED_SETTING, DELETED_TALLY, deletedWorkouts } from "./deletedWorkouts.ts";
import { WorkoutIndex, WorkoutWriter } from "./workoutIndex.ts";

/** Applies one import's events to the index on `db`, in the caller's transaction: the counts, and the calendar rows of what changed. */
export function applyWorkouts(events: Iterable<ArchiveEvent>, db: DatabaseSync, source: AppliedSource): { counts: ImportCounts; rows: CalendarRow[] } {
  const counts = emptyCounts();
  const writer = new WorkoutWriter(db, source.platform, source.id, source.folder);
  for (const event of events) {
    switch (event.kind) {
      case "workout":
        writer.workout(event);
        break;
      case "tally":
        counts.tallies[event.name] = (counts.tallies[event.name] ?? 0) + event.count;
        break;
      case "progress":
        break;
      default:
        throw new Error(`the exercise module's connectors write workouts and tallies, not a ${event.kind} event`);
    }
  }
  const { added, updated, unchanged, deleted } = writer.counts;
  counts.events.workout = { added, updated, unchanged };
  if (deleted > 0) counts.tallies[DELETED_TALLY] = (counts.tallies[DELETED_TALLY] ?? 0) + deleted;
  return { counts, rows: new WorkoutIndex(db).byIds([...writer.touched]).map(calendarRow) };
}

/** What the index holds now that each connector first brought, for the Sources tab: a run's own counts cannot say, as a live run's name no events. */
export function broughtWorkouts(db: DatabaseSync): Array<{ connector: string; kind: string; count: number }> {
  return db.prepare("SELECT s.connector, 'workout' AS kind, count(*) AS count FROM workout w JOIN source s ON s.id = w.first_source_id GROUP BY s.connector").all() as Array<{ connector: string; kind: string; count: number }>;
}

/** What every connector of the module runs with beyond its file's settings: the tombstones of the workouts the captain deleted, when there are any. */
export function connectorSettings(db: DatabaseSync): Record<string, unknown> {
  const deleted = deletedWorkouts(db);
  return deleted.length === 0 ? {} : { [DELETED_SETTING]: deleted };
}
