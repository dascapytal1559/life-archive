// The module's workouts, read and written (db.ts's `workout` table): every copy a source keeps of an activity, as the
// connectors' `workout` events give them (sdk/connector.ts's WorkoutEvent). The writer applies one import's events in
// the host's transaction of the module's database (module.ts's apply): each copy keyed on its source's own id, so an
// import again changes nothing and one that differs is brought up to date; never a copy of a workout the captain deleted
// (deletedWorkouts.ts). The index reads them, structure only: never a heart rate or a coordinate, which stay in the
// copies the rows name.

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dayKey, type SportFamily, type StreamInfo, type WorkoutEvent, type WorkoutStream } from "../../../sdk/server.ts";
import { correctAll, type Corrected } from "./corrections.ts";
import { isDeletedIn } from "./deletedWorkouts.ts";

/** What the index keeps of a workout's copy: never a heart rate or a coordinate. */
export interface WorkoutDetail {
  sport: string;
  distanceMeters: number | null;
  recorder: string | null;
  streams: Partial<Record<WorkoutStream, StreamInfo>>;
  /** The copy, and the source's own recording beside it, relative to the archive's folder when inside it. */
  file: string;
  rawFile: string | null;
}

/** One copy of a workout, as the index keeps it. */
export interface WorkoutRow {
  /** Its id, an activity's address on the Fitness page. */
  id: number;
  origin: string;
  /** The source's own id for it. */
  nativeId: string;
  kind: "workout";
  /** Its sport family. */
  subkind: SportFamily;
  at: number;
  atEnd: number;
  day: string;
  /** The bytes of its copy. */
  size: number;
  workout: WorkoutDetail;
  /** The captain's corrections standing over it (corrections.ts): which columns, and what its source gave them. */
  corrected?: { fields: readonly Corrected[]; original: { sport: string; family: SportFamily; at: number; atEnd: number; distanceMeters: number | null } };
}

/** What an import did to the index: the counts the host records (sdk/server.ts's ImportCounts, its `events.workout`). */
export interface WorkoutCounts {
  added: number;
  updated: number;
  unchanged: number;
  /** Copies of deleted workouts left out. */
  deleted: number;
}

interface StoredRow {
  id: number;
  origin: string;
  native_id: string;
  family: SportFamily;
  at: number;
  at_end: number;
  day: string;
  size: number;
  sport: string;
  distance_m: number | null;
  recorder: string | null;
  streams: string;
  file: string;
  raw_file: string | null;
}

const COLUMNS = "id, origin, native_id, family, at, at_end, day, size, sport, distance_m, recorder, streams, file, raw_file";

const rowOf = (row: StoredRow): WorkoutRow => ({
  id: row.id, origin: row.origin, nativeId: row.native_id, kind: "workout", subkind: row.family, at: row.at, atEnd: row.at_end, day: row.day, size: row.size,
  workout: { sport: row.sport, distanceMeters: row.distance_m, recorder: row.recorder, streams: JSON.parse(row.streams) as WorkoutDetail["streams"], file: row.file, rawFile: row.raw_file },
});

/** Reads the index: structure only, so anything may read it; every copy with the captain's corrections over it (corrections.ts). */
export class WorkoutIndex {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Every copy, oldest first. */
  all(): WorkoutRow[] {
    return correctAll(this.db, (this.db.prepare(`SELECT ${COLUMNS} FROM workout ORDER BY at, id`).all() as unknown as StoredRow[]).map(rowOf)).sort((a, b) => a.at - b.at || a.id - b.id);
  }

  /** The copies with these ids, by id; one there is none of is left out. */
  byIds(ids: readonly number[]): WorkoutRow[] {
    if (ids.length === 0) return [];
    const rows = (this.db.prepare(`SELECT ${COLUMNS} FROM workout WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(ids)) as unknown as StoredRow[]).map(rowOf);
    return correctAll(this.db, rows, rows);
  }

  /** How many copies the index has whose copy or recording is the file stored as `stored`, beyond `ids`. */
  sharingFile(stored: string, ids: ReadonlySet<number>): number {
    const rows = this.db.prepare("SELECT id FROM workout WHERE file = ? OR raw_file = ?").all(stored, stored) as Array<{ id: number }>;
    return rows.filter((row) => !ids.has(row.id)).length;
  }

  /** Each origin's copies: how many, and the first and last day. */
  summary(): Array<{ origin: string; count: number; firstDay: string; lastDay: string }> {
    return this.db.prepare("SELECT origin, count(*) AS count, min(day) AS firstDay, max(day) AS lastDay FROM workout GROUP BY origin ORDER BY origin").all() as Array<{
      origin: string; count: number; firstDay: string; lastDay: string;
    }>;
  }
}

/** Writes one import's workout events into the index, in the import's transaction. */
export class WorkoutWriter {
  readonly counts: WorkoutCounts = { added: 0, updated: 0, unchanged: 0, deleted: 0 };
  /** The copies this import added or changed, by id: what the calendar is pushed afresh. */
  readonly touched = new Set<number>();
  private readonly db: DatabaseSync;
  private readonly origin: string;
  private readonly sourceId: number;
  private readonly dataDir: string | undefined;

  constructor(db: DatabaseSync, origin: string, sourceId: number, dataDir?: string) {
    this.db = db;
    this.origin = origin;
    this.sourceId = sourceId;
    this.dataDir = dataDir;
  }

  /**
   * Adds a copy, or brings it up to date: one already there with the same values is unchanged; one whose values differ
   * takes the new ones, and this import as the last to touch it. A copy of a workout the captain deleted is left out.
   */
  workout(event: WorkoutEvent): void {
    if (isDeletedIn(this.db, { origin: this.origin, id: event.id, family: event.family, at: event.at, endAt: event.endAt })) {
      this.counts.deleted++;
      return;
    }
    const fields = {
      family: event.family, at: event.at, at_end: event.endAt, day: dayKey(event.at), size: event.bytes, sport: event.sport,
      distance_m: event.distanceMeters ?? null, recorder: event.recorder ?? null, streams: streamsJson(event.streams),
      file: storedFile(event.file, this.dataDir), raw_file: event.rawFile === undefined ? null : storedFile(event.rawFile, this.dataDir),
    };
    const existing = this.db.prepare(`SELECT ${COLUMNS} FROM workout WHERE origin = ? AND native_id = ?`).get(this.origin, event.id) as StoredRow | undefined;
    if (!existing) {
      const columns = Object.keys(fields);
      const added = this.db
        .prepare(`INSERT INTO workout (origin, native_id, ${columns.join(", ")}, first_source_id, last_source_id) VALUES (?, ?, ${columns.map(() => "?").join(", ")}, ?, ?)`)
        .run(this.origin, event.id, ...Object.values(fields), this.sourceId, this.sourceId);
      this.touched.add(Number(added.lastInsertRowid));
      this.counts.added++;
      return;
    }
    if ((Object.keys(fields) as Array<keyof typeof fields>).every((key) => existing[key] === fields[key])) {
      this.counts.unchanged++;
      return;
    }
    const columns = Object.keys(fields);
    this.db.prepare(`UPDATE workout SET ${columns.map((column) => `${column} = ?`).join(", ")}, last_source_id = ? WHERE id = ?`).run(...Object.values(fields), this.sourceId, existing.id);
    this.touched.add(existing.id);
    this.counts.updated++;
  }
}

/** A workout's streams as the index keeps them: JSON, its streams in one order, so a copy read again is unchanged. */
function streamsJson(streams: WorkoutEvent["streams"]): string {
  return JSON.stringify(Object.fromEntries(Object.entries(streams).sort(([a], [b]) => a.localeCompare(b))));
}

/** How a copy's file is kept: relative to the archive's folder when inside it, else its full path. */
export function storedFile(file: string, dataDir: string | undefined): string {
  if (!dataDir) return file;
  const inside = relative(resolve(dataDir), resolve(file));
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : file;
}

/** Where a copy's file is, as storedFile kept it. */
export function fileAt(stored: string, dataDir: string): string {
  return isAbsolute(stored) ? stored : join(dataDir, stored);
}
