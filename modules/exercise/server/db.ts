// The exercise module's own database, exercise.sqlite in modules/exercise/ of the archive's folder, which the core
// opens for it (sdk/server.ts's ModuleDatabase; server/modules/store.ts runs the migrations and the take-over):
//
//   workout          one row for each copy a source keeps of an activity (the polar connector's, origin polar, keyed on
//                    Polar's exercise id; polar-export's, keyed export/<id>; Strava's or Garmin's export later): from its
//                    start to its end, its sport family, the bytes of its copy, and what the copy holds, never a heart
//                    rate or a coordinate: the sport in the source's word, how far, what recorded it, which sample
//                    streams it has (a JSON object: each stream's samples and how often, in seconds), and where the copy
//                    is (file, and the source's own recording beside it, raw_file), named relative to the archive's
//                    folder. The copies of one activity are kept apart, each as its source gave it; which are one
//                    activity, and which to show, is worked out over them (workouts.ts), never stored. Its id is an
//                    activity's address on the Fitness page.
//   deleted_workout  a tombstone for each copy the captain deleted from the Fitness page (deletedWorkouts.ts), so no
//                    source brings it back: the copy's source and id, its family and times, and when; nothing it held.
//   workout_correction  what the captain changed of a copy from the Workouts table (corrections.ts): its sport, start,
//                    end or distance, one row a field, kept beside the copy so an import of it again never overwrites
//                    it; the index reads every copy with its corrections over it.
//   workout_note     his note on a copy (each copy of an activity has the same): content, read only by its editor.
//   changeset, change_row     the change log his corrections and notes are made under (the core's changes.ts), so each
//                    can be undone exactly.
//   source, connector_state   the host's record of the module's connectors' runs (sdk/server.ts's CONNECTOR_TABLES).
//   meta             the core's (taken_over), and the module's.
//
// The take-over (takeOver): when this database is new beside an archive, the rows the archive held for exercise before
// it was a module (its `event` rows of kind workout with their `workout` rows, its `deleted_workout` tombstones, and
// the polar connectors' `source` and `connector_state` rows) are copied in, ids kept, so an activity's address and the
// live connector's cursor keep meaning. The archive is only read; its rows stay until `npm run archive -- migrate
// friend-map-module` drops them (server/archive/legacy.ts).

import type { DatabaseSync } from "node:sqlite";
import { CHANGE_LOG_TABLES, CONNECTOR_TABLES, type ModuleDatabase, type TableSpec } from "../../../sdk/server.ts";

/** The module's id, which names its folder in modules/ of both the checkout and the archive's folder, and its rows in the calendar. */
export const EXERCISE = "exercise";

/** The database's file, in modules/exercise/ of the archive's folder. */
export const EXERCISE_DB = "exercise.sqlite";

/** The connectors that were the core's and are this module's: their runs came across in the take-over. */
export const OWN_CONNECTORS = ["polar", "polar-export"] as const;

const MIGRATIONS: readonly string[] = [
  `
  ${CONNECTOR_TABLES}
  CREATE TABLE workout (
    id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL,                      -- the source: polar (Strava's or Garmin's export would be more)
    native_id TEXT NOT NULL,                   -- the source's own id for the copy, the same every import
    family TEXT NOT NULL CHECK (family IN ('run', 'walk', 'ride', 'swim', 'other')),
    at INTEGER NOT NULL,                       -- when it started, ms since the epoch
    at_end INTEGER NOT NULL CHECK (at_end >= at),
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- the local date of at
    size INTEGER NOT NULL CHECK (size >= 0),   -- the bytes of its copy
    sport TEXT NOT NULL CHECK (sport <> ''),
    distance_m REAL CHECK (distance_m >= 0),
    recorder TEXT,
    streams TEXT NOT NULL CHECK (json_valid(streams) AND json_type(streams) = 'object'),
    file TEXT NOT NULL,
    raw_file TEXT,
    first_source_id INTEGER NOT NULL REFERENCES source(id),
    last_source_id INTEGER NOT NULL REFERENCES source(id),
    UNIQUE (origin, native_id)
  );
  CREATE INDEX workout_at ON workout(at);

  CREATE TABLE deleted_workout (
    origin TEXT NOT NULL CHECK (origin <> ''),
    native_id TEXT NOT NULL CHECK (native_id <> ''),
    family TEXT NOT NULL,
    at INTEGER NOT NULL,
    at_end INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (origin, native_id)
  );
  CREATE INDEX deleted_workout_at ON deleted_workout(at);
  `,
  // The captain's corrections (corrections.ts): what he changed of a copy from the Workouts table, kept beside the copy
  // so an import of it again never overwrites them, and his note on it; and the change log they are made under, so
  // each can be undone (the core's changes.ts, over this database).
  `
  ${CHANGE_LOG_TABLES}
  CREATE TABLE workout_correction (
    origin TEXT NOT NULL,                      -- the copy, as workout keys it
    native_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('sport', 'at', 'at_end', 'distance_m')),
    value,                                     -- what he says it is: the sport in its source's word, an instant (ms), metres, or NULL for none
    set_at INTEGER NOT NULL,
    PRIMARY KEY (origin, native_id, field)
  );
  CREATE TABLE workout_note (
    origin TEXT NOT NULL,                      -- the copy, as workout keys it: each copy of an activity has the same note
    native_id TEXT NOT NULL,
    note TEXT NOT NULL CHECK (note <> ''),     -- his words on it: content, which only its editor reads, through the trail
    set_at INTEGER NOT NULL,
    PRIMARY KEY (origin, native_id)
  );
  `,
];

/** The tables the module's change log logs (the core's Changes, over this database): his corrections and notes. */
export const EXERCISE_CHANGE_TABLES: Record<string, TableSpec> = {
  workout_correction: { key: ["origin", "native_id", "field"], columns: ["value", "set_at"], loose: ["set_at"] },
  workout_note: { key: ["origin", "native_id"], columns: ["note", "set_at"], loose: ["set_at"] },
};

/** The archive's rows that were exercise's, copied in with their ids (the archive attached as `archive`; see the top of this file). */
function takeOver(db: DatabaseSync): void {
  const connectors = JSON.stringify(OWN_CONNECTORS);
  db.prepare(
    `INSERT INTO source (id, platform, connector, kind, label, content_sha256, started_at, finished_at, status, counts_json, error)
     SELECT id, platform, connector, kind, label, content_sha256, started_at, finished_at, status, counts_json, error FROM archive.source
     WHERE connector IN (SELECT value FROM json_each(?))
        OR id IN (SELECT first_source_id FROM archive.event WHERE kind = 'workout' UNION SELECT last_source_id FROM archive.event WHERE kind = 'workout')`,
  ).run(connectors);
  db.prepare(
    `INSERT INTO connector_state (connector, status, last_run_at, last_ok_at, last_error, last_error_at, failures, retry_after, cursor_json)
     SELECT connector, status, last_run_at, last_ok_at, last_error, last_error_at, failures, retry_after, cursor_json FROM archive.connector_state
     WHERE connector IN (SELECT value FROM json_each(?))`,
  ).run(connectors);
  db.exec(
    `INSERT INTO workout (id, origin, native_id, family, at, at_end, day, size, sport, distance_m, recorder, streams, file, raw_file, first_source_id, last_source_id)
     SELECT e.id, e.origin, e.native_id, coalesce(e.subkind, 'other'), e.at, coalesce(e.at_end, e.at), e.day, coalesce(e.size, 0),
       w.sport, w.distance_m, w.recorder, w.streams, w.file, w.raw_file, e.first_source_id, e.last_source_id
     FROM archive.event e JOIN archive.workout w ON e.detail = 'workout' AND w.id = e.detail_id
     WHERE e.kind = 'workout';
     INSERT INTO deleted_workout (origin, native_id, family, at, at_end, deleted_at)
     SELECT origin, native_id, family, at, at_end, deleted_at FROM archive.deleted_workout;`,
  );
}

/** The database as the module declares it (module.ts). */
export const EXERCISE_DATABASE: ModuleDatabase = { file: EXERCISE_DB, migrations: MIGRATIONS, takeOver };

/** What the database holds, for `npm run exercise -- status` and the migration's check. */
export function counts(db: DatabaseSync): { workouts: number; deleted: number; sources: number; states: number } {
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { workouts: count("workout"), deleted: count("deleted_workout"), sources: count("source"), states: count("connector_state") };
}
