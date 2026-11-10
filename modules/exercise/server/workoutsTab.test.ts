// The Workouts table (workoutsTab.ts), the module's, listed in the Events page's Tables, over the calendar's rows the module
// pushed, and the module's answers for them (calendar.ts): each activity listed once with its copies counted, never a
// heart rate or a route; a sport filter and the chart; a row's drawer from the owner's hook; the calendar's rebuild
// from the module's rows; and the module's take-over of an archive that held its rows before it was a module.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleStore, WorkoutEvent } from "../../../sdk/server.ts";
import { NO_FILTERS, openModuleDatabase, testingLifeArchive, type TestingLifeArchive } from "../../../sdk/testing.ts";
import exercise from "../module.ts";
import { applyWorkouts } from "./apply.ts";
import { exerciseEvents } from "./calendar.ts";
import { EXERCISE_DATABASE } from "./db.ts";
import { WorkoutIndex } from "./workoutIndex.ts";
import { WORKOUTS } from "./workoutsTab.ts";

/** A time on a Melbourne day (AEDT in March). */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+11:00`);

/**
 * Made-up workouts: a 5 km run at 7 am on 8 March, of which Polar's API and another source each keep a copy (the
 * other's a minute later and a little shorter: the same run), and a 24.1 km ride at 6 pm on 9 April with no distance's twin.
 */
const workout = (id: string, sport: string, family: WorkoutEvent["family"], start: number, minutes: number, more: Partial<WorkoutEvent> = {}): WorkoutEvent =>
  ({ kind: "workout", id, sport, family, at: start, endAt: start + minutes * 60_000, streams: {}, file: `/home/sample/${id}.json`, bytes: 100, ...more });
const RUN = workout("run1", "RUNNING", "run", at("2026-03-08", "07:00"), 30, { distanceMeters: 5012, recorder: "Polar Flow app" });
const RUN_COPY = workout("run1-copy", "Run", "run", at("2026-03-08", "07:01"), 28, { distanceMeters: 4990 });
const RIDE = workout("ride1", "ROAD_BIKING", "ride", at("2026-04-09", "18:00"), 65, { distanceMeters: 24_080, recorder: "Sample watch" });

let root: string;
let life: TestingLifeArchive;
let db: DatabaseSync;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-workouts-tab-"));
  life = await testingLifeArchive(join(root, "data"), exercise);
  db = (life.module.context as ModuleStore).db;
  const apply = (platform: string, events: WorkoutEvent[]) => {
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')").run(platform).lastInsertRowid);
    const { rows } = applyWorkouts(events, db, { id: source, platform, kind: "export", seenAt: 0, folder: join(root, "data") });
    life.archive.calendar.sink.push("exercise", rows);
  };
  apply("polar", [RUN, RIDE]);
  apply("strava", [RUN_COPY]);
});

afterAll(async () => {
  life.close();
  await rm(root, { recursive: true, force: true });
});

describe("the Workouts tab", () => {
  it("lists each activity once, newest first, its copies counted, never a heart rate or a route", () => {
    const answer = WORKOUTS.rows(life.reads(), NO_FILTERS, { offset: 0, limit: 100, sort: "when", direction: "desc", after: null });
    expect(answer.total).toBe(2);
    expect(answer.rows.map((row) => ["when", "sport", "distance", "length", "recorder", "origin"].map((key) => row.cells[key]))).toEqual([
      [RIDE.at, "Road biking", "24.1 km", 3900, "Sample watch", "Polar"],
      [RUN.at, "Running", "5.0 km", 1800, "Polar Flow app", "Polar"],
    ]);
    const detail = WORKOUTS.detail(life.reads(), answer.rows[1].id);
    expect(Object.fromEntries(detail.more.map((f) => [f.label, f.value]))).toMatchObject({ "Sport family": "Run", Copies: 2 });
    expect(detail.views.map((v) => v.label)).toEqual(["Messages that day"]);
    expect(JSON.stringify(answer)).not.toMatch(/heart|lat|lon/);
  });

  it("filters by sport and charts workouts or minutes", () => {
    const reads = life.reads();
    const page = { offset: 0, limit: 100, sort: "when", direction: "desc" as const, after: null };
    expect(WORKOUTS.rows(reads, { ...NO_FILTERS, choices: { family: ["ride"] } }, page).rows.map((r) => r.cells.sport)).toEqual(["Road biking"]);
    expect(WORKOUTS.rows(reads, NO_FILTERS, { ...page, sort: "distance", direction: "asc" }).rows.map((r) => r.cells.distance)).toEqual(["5.0 km", "24.1 km"]);
    const minutes = WORKOUTS.volume(reads, NO_FILTERS, { grain: "month", measure: "minutes", split: null });
    expect(minutes.buckets.map((b) => [b.day, b.value])).toEqual([["2026-03-01", 30], ["2026-04-01", 65]]);
    expect(WORKOUTS.facets(reads, NO_FILTERS).family.map((f) => [f.value, f.label, f.count])).toEqual([["ride", "Ride", 1], ["run", "Run", 1]]);
  });

  it("is the module's table, listed in Events' Tables, and answers for its rows", () => {
    expect(exercise.tabs).toEqual([WORKOUTS]);
    const events = exerciseEvents(db);
    expect(events.labelPeople([1])).toEqual({});
    expect(events.detail("workout", "polar", "nope")).toBeNull();
    expect(events.rows().map((row) => [row.module, row.kind, row.origin, row.nativeId, row.subkind, row.facts])).toEqual([
      ["exercise", "workout", "polar", "run1", "run", { sport: "RUNNING", distance_m: 5012, recorder: "Polar Flow app" }],
      ["exercise", "workout", "strava", "run1-copy", "run", { sport: "Run", distance_m: 4990, recorder: null }],
      ["exercise", "workout", "polar", "ride1", "ride", { sport: "ROAD_BIKING", distance_m: 24_080, recorder: "Sample watch" }],
    ]);
  });

  it("is what the calendar's rebuild makes from the module's rows, and nothing drifts", () => {
    expect(life.archive.calendar.drift()).toEqual([]);
    const counts = life.archive.calendar.rebuild();
    expect(counts.exercise).toEqual({ added: 0, updated: 0, unchanged: 3, forgotten: 0 });
    // A row pushed that the module no longer has is extra until a rebuild forgets it.
    db.prepare("DELETE FROM workout WHERE native_id = 'run1-copy'").run();
    expect(life.archive.calendar.drift()).toEqual([{ module: "exercise", origin: "strava", nativeId: "run1-copy", kind: "workout", change: "extra" }]);
    expect(life.archive.calendar.rebuild().exercise).toMatchObject({ forgotten: 1 });
    expect(life.archive.calendar.drift()).toEqual([]);
  });
});

