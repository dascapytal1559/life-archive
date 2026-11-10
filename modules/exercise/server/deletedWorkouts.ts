// The workouts the captain deleted (the Fitness page's Delete, delete.ts), and how none comes back.
//
// A delete removes every copy of an activity: its files, its index rows, all of it (docs/features.md's "Exercise"). What stays is
// one tombstone a copy, in deleted_workout (db.ts): the copy's source and the source's own id for it, its sport
// family and from when to when, and when it was deleted. No heart rate, route, distance or file: only enough to know
// the activity again. A copy is the deleted activity's when it is a tombstone's own (same origin and id), or the same
// activity by workouts.ts's rule (same family, starting within two minutes, 80% of the shorter shared), so a later
// export's copy, under an id of its own, is known too.
//
// Three places keep it out:
//   - the index: WorkoutWriter.workout writes no tombstoned workout (workoutIndex.ts), whichever import or sync brings it;
//   - the connectors: the host hands every connector the tombstones in its settings (DELETED_SETTING, host.ts's
//     connectorConfig), and the polar connector fetches no copy of one, and polar-export reads none (both count what
//     they left, the tally DELETED_TALLY);
//   - the delete itself stops a running sync of the activity's sources while it runs (host.ts's pausingLive), so a pass
//     under way cannot bring a copy back, and starts it again with the new tombstones.

import type { DatabaseSync as Db } from "node:sqlite";
import type { SportFamily } from "../../../sdk/server.ts";
import { SAME_START_MS, sameActivity } from "./workouts.ts";

/** A deleted copy, as its tombstone keeps it. */
export interface DeletedWorkout {
  origin: string;
  /** The source's own id for the copy (Polar's exercise id; export/<id> for its account export's). */
  id: string;
  family: SportFamily;
  at: number;
  endAt: number;
}

/** The setting the host adds to every connector's settings, when the module's database has tombstones (apply.ts's connectorSettings): DeletedWorkout[]. */
export const DELETED_SETTING = "deletedWorkouts";

/** The tally a connector or an import counts each copy it left out as deleted under. */
export const DELETED_TALLY = "workouts-deleted";

/** Whether a copy is one of the deleted: a tombstone's own, or the same activity as one. */
export function isDeleted(deleted: readonly DeletedWorkout[], copy: DeletedWorkout): boolean {
  return deleted.some((gone) => (gone.origin === copy.origin && gone.id === copy.id) || sameActivity(gone, copy));
}

/** The tombstones in a connector's settings (DELETED_SETTING); none when it has none, or they are not a list of them. */
export function deletedIn(config: Record<string, unknown>): DeletedWorkout[] {
  const list = config[DELETED_SETTING];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is DeletedWorkout =>
      typeof item === "object" && item !== null && typeof item.origin === "string" && typeof item.id === "string" &&
      typeof item.family === "string" && Number.isFinite(item.at) && Number.isFinite(item.endAt),
  );
}

/** Every tombstone, oldest copy first. */
export function deletedWorkouts(db: Db): DeletedWorkout[] {
  return (db.prepare("SELECT origin, native_id, family, at, at_end FROM deleted_workout ORDER BY at, origin, native_id").all() as Array<{
    origin: string; native_id: string; family: SportFamily; at: number; at_end: number;
  }>).map((row) => ({ origin: row.origin, id: row.native_id, family: row.family, at: row.at, endAt: row.at_end }));
}

/** Whether the index must leave a copy out: the tombstones near its start, checked as isDeleted does. */
export function isDeletedIn(db: Db, copy: DeletedWorkout): boolean {
  const near = (db.prepare("SELECT origin, native_id, family, at, at_end FROM deleted_workout WHERE (origin = ? AND native_id = ?) OR at BETWEEN ? AND ?").all(
    copy.origin, copy.id, copy.at - SAME_START_MS, copy.at + SAME_START_MS,
  ) as Array<{ origin: string; native_id: string; family: SportFamily; at: number; at_end: number }>);
  return isDeleted(near.map((row) => ({ origin: row.origin, id: row.native_id, family: row.family, at: row.at, endAt: row.at_end })), copy);
}

/** Lays a tombstone for each copy (one already there is kept as it was). */
export function layTombstones(db: Db, copies: readonly DeletedWorkout[], deletedAt: number): void {
  const insert = db.prepare("INSERT OR IGNORE INTO deleted_workout (origin, native_id, family, at, at_end, deleted_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const copy of copies) insert.run(copy.origin, copy.id, copy.family, copy.at, copy.endAt, deletedAt);
}
