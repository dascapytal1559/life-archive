// What the archive still holds of a part that became a module of its own, until the migration firstmate runs drops it
// (`npm run archive -- migrate friend-map-module`, the friend map step's move, server/archive/migrate.ts; docs/modules.md). The exercise module
// (modules/exercise) copied its rows out of the archive once, when its database was new (server/modules/store.ts's
// take-over), and reads and writes only its own database since; the drop is refused until that database is seen to
// hold them (exerciseUnheld). The rituals module (modules/rituals) took nothing over: its store was always rituals'
// own, and the archive's rows were the rituals connector's index of it; the drop is refused until the store is in the
// archive's folder, where the module reads it (ritualsUnheld). Either way the archive's rows from before stay as they
// were, read by nothing (archive/events.ts leaves the kinds out), until dropped in one transaction, with foreign keys
// checked: a row something else still points at stops it whole. Overwritten for good (db.ts's overwriting), as a
// workout's delete is: until the drop, the archive and its backups still hold the index row of a workout deleted since
// the take-over (metadata only, docs/privacy.md).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDay } from "../../src/time.ts";
import { moduleFolder, TAKEN_OVER } from "../modules/store.ts";
import { getMeta, overwriting, transaction, type Db } from "./db.ts";

/** The connector that was the core's and is no more: the rituals module reads its own store. Its runs in `source` and `connector_state` go with its rows. */
export const RITUALS_CONNECTOR = "rituals";

/** The event kinds the rituals connector wrote, each with its detail table of the same name. */
export const RITUAL_KINDS = ["ritual_checkin", "ritual_habit", "ritual_day", "ritual_workouts"] as const;

const RITUAL_KINDS_JSON = JSON.stringify(RITUAL_KINDS);

/** What the archive still holds of rituals': the connector's events (with their detail rows) and its runs. */
export interface RitualsLegacy {
  events: number;
  sources: number;
  states: number;
}

export function ritualsLegacy(db: Db): RitualsLegacy {
  const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    events: count("SELECT count(*) AS n FROM event WHERE kind IN (SELECT value FROM json_each(?))", RITUAL_KINDS_JSON),
    sources: count("SELECT count(*) AS n FROM source WHERE connector = ?", RITUALS_CONNECTOR),
    states: count("SELECT count(*) AS n FROM connector_state WHERE connector = ?", RITUALS_CONNECTOR),
  };
}

/** Rituals' store in the archive's folder `dataDir`, where the rituals module reads it (modules/rituals/server/view.ts). */
export const ritualsStoreFile = (dataDir: string): string => join(moduleFolder(dataDir, "rituals"), "data", "ritual.sqlite3");

/** Why the archive's rows of rituals' cannot be dropped yet, or null: the rituals module must have its store, in the archive's folder, to read in their place. */
export function ritualsUnheld(dataDir: string): string | null {
  const file = ritualsStoreFile(dataDir);
  return existsSync(file) ? null : `there is no ${file}: move rituals' store into the archive's folder first (modules/rituals/README.md)`;
}

/** Drops what the archive still holds of rituals', in one transaction, its bytes overwritten. */
export function dropRitualsLegacy(db: Db): void {
  overwriting(db, () =>
    transaction(db, () => {
      for (const kind of RITUAL_KINDS) db.prepare(`DELETE FROM ${kind} WHERE id IN (SELECT detail_id FROM event WHERE detail = ?)`).run(kind);
      db.prepare("DELETE FROM event WHERE kind IN (SELECT value FROM json_each(?))").run(RITUAL_KINDS_JSON);
      db.prepare("DELETE FROM connector_state WHERE connector = ?").run(RITUALS_CONNECTOR);
      db.prepare("DELETE FROM source WHERE connector = ?").run(RITUALS_CONNECTOR);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`dropping rituals' rows would leave ${broken.length} broken references, e.g. ${JSON.stringify(broken[0])}; nothing was dropped`);
    }),
  );
}

/** The connectors that were the core's and are the exercise module's: their runs in `source` and `connector_state` moved with them. */
export const EXERCISE_CONNECTORS = ["polar", "polar-export"] as const;

/** What the archive still holds of exercise's: its workout events (and their `workout` rows), its tombstones, and its connectors' runs. */
export interface ExerciseLegacy {
  workouts: number;
  deleted: number;
  sources: number;
  states: number;
}

const CONNECTORS_JSON = JSON.stringify(EXERCISE_CONNECTORS);

export function exerciseLegacy(db: Db): ExerciseLegacy {
  const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    workouts: count("SELECT count(*) AS n FROM event WHERE kind = 'workout'"),
    deleted: count("SELECT count(*) AS n FROM deleted_workout"),
    sources: count("SELECT count(*) AS n FROM source WHERE connector IN (SELECT value FROM json_each(?))", CONNECTORS_JSON),
    states: count("SELECT count(*) AS n FROM connector_state WHERE connector IN (SELECT value FROM json_each(?))", CONNECTORS_JSON),
  };
}

/** The exercise module's database in the archive's folder `dataDir`. */
export const exerciseDatabaseFile = (dataDir: string): string => join(moduleFolder(dataDir, "exercise"), "exercise.sqlite");

/** Each row's source and id, as one key. */
function keysOf(db: DatabaseSync, sql: string): Set<string> {
  return new Set((db.prepare(sql).all() as Array<{ origin: string; native_id: string }>).map((row) => JSON.stringify([row.origin, row.native_id])));
}

/**
 * Why the module's database at `file` cannot yet stand for the archive's rows on `db`, or null when it can: it must have
 * taken them over (a dated `taken_over`), and hold each of the archive's tombstones, and each of its workouts, as a copy
 * or, for one the captain deleted since, as a tombstone. Only read.
 */
export function exerciseUnheld(db: Db, file: string): string | null {
  if (!existsSync(file)) return `there is no ${file}: start the server with the exercise module on first`;
  const module = new DatabaseSync(file, { readOnly: true });
  try {
    const taken = getMeta(module, TAKEN_OVER);
    if (taken === null || !isDay(taken)) return `${file} has not taken the archive's rows over (its taken_over is ${taken ?? "unset"})`;
    const tombstones = keysOf(module, "SELECT origin, native_id FROM deleted_workout");
    const held = new Set([...tombstones, ...keysOf(module, "SELECT origin, native_id FROM workout")]);
    const workouts = [...keysOf(db, "SELECT origin, native_id FROM event WHERE kind = 'workout'")].filter((key) => !held.has(key));
    const deleted = [...keysOf(db, "SELECT origin, native_id FROM deleted_workout")].filter((key) => !tombstones.has(key));
    if (workouts.length + deleted.length === 0) return null;
    return `${file} lacks ${workouts.length} of the archive's workouts and ${deleted.length} of its tombstones, e.g. ${[...workouts, ...deleted][0]}`;
  } finally {
    module.close();
  }
}

/** Drops what the archive still holds of exercise's, in one transaction, its bytes overwritten. */
export function dropExerciseLegacy(db: Db): void {
  overwriting(db, () =>
    transaction(db, () => {
      db.prepare("DELETE FROM workout WHERE id IN (SELECT detail_id FROM event WHERE detail = 'workout')").run();
      db.prepare("DELETE FROM event WHERE kind = 'workout'").run();
      db.prepare("DELETE FROM deleted_workout").run();
      db.prepare("DELETE FROM connector_state WHERE connector IN (SELECT value FROM json_each(?))").run(CONNECTORS_JSON);
      db.prepare("DELETE FROM source WHERE connector IN (SELECT value FROM json_each(?))").run(CONNECTORS_JSON);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`dropping exercise's rows would leave ${broken.length} broken references, e.g. ${JSON.stringify(broken[0])}; nothing was dropped`);
    }),
  );
}
