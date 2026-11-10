// The captain's corrections to the workouts (db.ts's workout_correction and workout_note): what he changed of a copy
// from the Workouts table (its sport, when it started or ended, how far), kept beside the copy, never written over it,
// so the next import of it (which brings the copy as its source has it, workoutIndex.ts's WorkoutWriter) cannot undo
// them, as a person's name or a call's length is kept; and his note on it, content, read only by its editor
// (workoutEdits.ts) through the trail. The index reads every copy with its corrections over it (WorkoutIndex), so the
// calendar's rows, its rebuild, the Fitness page and the agents' tools all see them. A correction back to what the
// source says, at the precision the editor writes it (a minute, 10 m, the sport's word), is no correction: its row goes.
//
// An activity's copies (Polar's API and its export, say) are corrected alike, each with its own rows, so they stay one
// activity (workouts.ts's sameActivity) however its times move.

import type { DatabaseSync } from "node:sqlite";
import { dayKey, type SportFamily } from "../../../sdk/server.ts";
import { sportFamily } from "../connectors/polar/exercise.ts";
import type { WorkoutRow } from "./workoutIndex.ts";

/** What a correction can change of a copy, by its column. */
export const CORRECTED = ["sport", "at", "at_end", "distance_m"] as const;
export type Corrected = (typeof CORRECTED)[number];

/** A copy's columns a correction can stand over, as its source gave them. */
export interface Raw {
  sport: string;
  at: number;
  at_end: number;
  distance_m: number | null;
}

/** What the Workouts table calls each column a correction changes, for its "edited" marks (calendar.ts's facts). */
export const EDITED_COLUMN: Record<Corrected, string> = { sport: "sport", at: "when", at_end: "length", distance_m: "distance" };

const key = (origin: string, nativeId: string) => `${origin}\u0000${nativeId}`;

/** Every copy's corrections (or those of the copies `of`), by copy. */
export function correctionsOf(db: DatabaseSync, of?: ReadonlyArray<{ origin: string; nativeId: string }>): Map<string, Partial<Raw>> {
  const rows = (of === undefined
    ? db.prepare("SELECT origin, native_id, field, value FROM workout_correction").all()
    : db.prepare(`SELECT c.origin, c.native_id, c.field, c.value FROM workout_correction c
        JOIN json_each(?) j ON j.value ->> 0 = c.origin AND j.value ->> 1 = c.native_id`).all(JSON.stringify(of.map((c) => [c.origin, c.nativeId])))) as Array<{
    origin: string; native_id: string; field: Corrected; value: string | number | null;
  }>;
  const found = new Map<string, Partial<Raw>>();
  for (const row of rows) {
    const copy = found.get(key(row.origin, row.native_id)) ?? {};
    (copy as Record<string, unknown>)[row.field] = row.value;
    found.set(key(row.origin, row.native_id), copy);
  }
  return found;
}

/** `row` (as its source gave it) with `corrections` over it: its sport and family, times and day, and distance, and what they were (`corrected`). */
export function withCorrections(row: WorkoutRow, corrections: Partial<Raw> | undefined): WorkoutRow {
  if (!corrections || Object.keys(corrections).length === 0) return row;
  const sport = corrections.sport ?? row.workout.sport;
  const at = corrections.at ?? row.at;
  const atEnd = corrections.at_end ?? row.atEnd;
  return {
    ...row,
    subkind: corrections.sport === undefined ? row.subkind : sportFamily(sport),
    at,
    atEnd,
    day: dayKey(at),
    workout: { ...row.workout, sport, distanceMeters: "distance_m" in corrections ? corrections.distance_m ?? null : row.workout.distanceMeters },
    corrected: {
      fields: CORRECTED.filter((field) => field in corrections),
      original: { sport: row.workout.sport, family: row.subkind, at: row.at, atEnd: row.atEnd, distanceMeters: row.workout.distanceMeters },
    },
  };
}

/** Over a list of copies as their source gave them: every one with its corrections over it. */
export function correctAll(db: DatabaseSync, rows: readonly WorkoutRow[], of?: ReadonlyArray<{ origin: string; nativeId: string }>): WorkoutRow[] {
  const corrections = correctionsOf(db, of);
  return rows.map((row) => withCorrections(row, corrections.get(key(row.origin, row.nativeId))));
}

/** Copy `origin`/`nativeId`'s columns as its source gave them; null for none. */
export function rawOf(db: DatabaseSync, origin: string, nativeId: string): Raw | null {
  return (db.prepare("SELECT sport, at, at_end, distance_m FROM workout WHERE origin = ? AND native_id = ?").get(origin, nativeId) as Raw | undefined) ?? null;
}

/** A sport's short words, as some sources write it ("Run"), in the word the editor offers (workoutsTab.ts's SPORTS). */
const SPORT_WORDS: Readonly<Record<string, string>> = { RUN: "RUNNING", JOG: "RUNNING", WALK: "WALKING", HIKE: "HIKING", RIDE: "CYCLING", BIKE: "CYCLING", CYCLE: "CYCLING", SWIM: "SWIMMING", ROW: "ROWING" };

/** A sport as one word for all its spellings: "Run", "running" and "RUNNING" are RUNNING; "Road biking" is ROAD_BIKING. */
export function sportWord(sport: string): string {
  const word = sport.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return SPORT_WORDS[word] ?? word;
}

/**
 * Whether `value` is what the source says of `field` (`raw`), at the precision the editor writes it (workoutEdits.ts):
 * a time to the minute (07:00 is a start of 07:00:27), a distance to 10 m (5.01 km is 5012 m), a sport by its word
 * whatever its spelling (RUNNING is "Run").
 */
export function sameAsSource(field: Corrected, raw: string | number | null, value: string | number | null): boolean {
  if (raw === null || value === null) return raw === value;
  switch (field) {
    case "sport":
      return sportWord(String(raw)) === sportWord(String(value));
    case "at":
    case "at_end":
      return Math.floor(Number(raw) / 60_000) === Math.floor(Number(value) / 60_000);
    case "distance_m":
      return Math.round(Number(raw) / 10) === Math.round(Number(value) / 10);
  }
}

/**
 * Sets `field` of the copy to `value`, as the captain says: a correction beside it, or none when `value` is what its
 * source says at the precision the editor writes (sameAsSource). Run inside a changeset (the module's change log), so
 * it can be undone.
 */
export function setCorrection(db: DatabaseSync, copy: { origin: string; nativeId: string }, field: Corrected, value: string | number | null): void {
  const raw = rawOf(db, copy.origin, copy.nativeId);
  if (!raw) throw new Error(`the index has no workout ${copy.origin}/${copy.nativeId}`);
  if (sameAsSource(field, raw[field], value)) {
    db.prepare("DELETE FROM workout_correction WHERE origin = ? AND native_id = ? AND field = ?").run(copy.origin, copy.nativeId, field);
    return;
  }
  db.prepare(`INSERT INTO workout_correction (origin, native_id, field, value, set_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (origin, native_id, field) DO UPDATE SET value = excluded.value, set_at = excluded.set_at WHERE value IS NOT excluded.value`)
    .run(copy.origin, copy.nativeId, field, value, Date.now());
}

/** The note on copy `origin`/`nativeId`: its words (content), or null for none. */
export function noteOf(db: DatabaseSync, origin: string, nativeId: string): string | null {
  return (db.prepare("SELECT note FROM workout_note WHERE origin = ? AND native_id = ?").get(origin, nativeId) as { note: string } | undefined)?.note ?? null;
}

/** Gives the copy `note`, or takes its note away (null); in a changeset, as setCorrection. */
export function setNote(db: DatabaseSync, copy: { origin: string; nativeId: string }, note: string | null): void {
  if (note === null) {
    db.prepare("DELETE FROM workout_note WHERE origin = ? AND native_id = ?").run(copy.origin, copy.nativeId);
    return;
  }
  db.prepare(`INSERT INTO workout_note (origin, native_id, note, set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (origin, native_id) DO UPDATE SET note = excluded.note, set_at = excluded.set_at WHERE note IS NOT excluded.note`).run(copy.origin, copy.nativeId, note, Date.now());
}

/**
 * Takes the corrections and notes of the copies `of` away for good, and the change log's rows of them (which hold a
 * note's words): a delete (delete.ts, inside its overwriting) leaves nothing of them behind.
 */
export function forgetCorrections(db: DatabaseSync, of: ReadonlyArray<{ origin: string; nativeId: string }>): void {
  for (const copy of of) {
    db.prepare("DELETE FROM workout_correction WHERE origin = ? AND native_id = ?").run(copy.origin, copy.nativeId);
    db.prepare("DELETE FROM workout_note WHERE origin = ? AND native_id = ?").run(copy.origin, copy.nativeId);
    db.prepare("DELETE FROM change_row WHERE tbl IN ('workout_correction', 'workout_note') AND row_key ->> 0 = ? AND row_key ->> 1 = ?").run(copy.origin, copy.nativeId);
  }
}

/** The family a sport is of, as the connectors give it (polar's sportFamily). */
export const familyOf = (sport: string): SportFamily => sportFamily(sport);
