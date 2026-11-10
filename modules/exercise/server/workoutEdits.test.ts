// Editing the Workouts table (workoutEdits.ts, corrections.ts) through the core's one edit registry (server/edits/), on
// made-up workouts only: an activity's sport, start, end and distance corrected over every copy of it, a re-import that
// leaves the corrections standing, a note kept as content and read only through the trail, each edit recorded and its
// undo exact (refused once the field has changed since), the refusals of what the table does not let be edited, and the
// calendar's rows the corrected rows, which a rebuild from the module gives back unchanged.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answering, EDITS_API, Effect, ForbiddenError, InvalidInputError, NotFoundError, UnavailableError, wallText, type EditDone, type EditsAnswer, type EditState, type ModuleStore, type WorkoutEvent,
} from "../../../sdk/server.ts";
import { editsHandler, NO_FILTERS, testingLifeArchive, type TableEdits, type TestingLifeArchive } from "../../../sdk/testing.ts";
import exercise from "../module.ts";
import { applyWorkouts } from "./apply.ts";
import { WORKOUTS } from "./workoutsTab.ts";

const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+11:00`);
const workout = (id: string, sport: string, family: WorkoutEvent["family"], start: number, minutes: number, more: Partial<WorkoutEvent> = {}): WorkoutEvent =>
  ({ kind: "workout", id, sport, family, at: start, endAt: start + minutes * 60_000, streams: {}, file: `/home/sample/${id}.json`, bytes: 100, ...more });
/** A 5 km run that Polar and another source each keep a copy of (the other's a minute later), and a ride. */
const RUN = workout("run1", "RUNNING", "run", at("2026-03-08", "07:00"), 30, { distanceMeters: 5012, recorder: "Polar Flow app" });
const RUN_COPY = workout("run1-copy", "Run", "run", at("2026-03-08", "07:01"), 28, { distanceMeters: 4990 });
const RIDE = workout("ride1", "ROAD_BIKING", "ride", at("2026-04-09", "18:00"), 65, { distanceMeters: 24_080 });

const MINUTE = 60_000;
const SOURCE = { surface: "app", who: null, why: null } as const;

/** An edit's failure, as the route answers it (a route error); the edit succeeding fails the test. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(answering(NotFoundError, InvalidInputError, UnavailableError, ForbiddenError), Effect.flip)) as Promise<Error>;

let root: string;
let life: TestingLifeArchive;
let db: DatabaseSync;
let edits: TableEdits;
/** The run's row in the Workouts table: its calendar row's id. */
let run: string;

const apply = (platform: string, events: WorkoutEvent[]) => {
  const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')").run(platform).lastInsertRowid);
  const { rows } = applyWorkouts(events, db, { id: source, platform, kind: "export", seenAt: 0, folder: join(root, "data") });
  life.archive.calendar.sink.push("exercise", rows);
};
const drift = () => life.archive.calendar.drift().map((d) => `${d.nativeId}: ${d.change}`);
const rowOf = (id: string) => WORKOUTS.rows(life.reads(), NO_FILTERS, { offset: 0, limit: 100, sort: "when", direction: "desc", after: null }).rows.find((row) => row.id === id)!;
const edit = (field: string, value: unknown) => Effect.runPromise(edits.edit("workouts", run, field, value, SOURCE));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-workout-edits-"));
  life = await testingLifeArchive(join(root, "data"), exercise);
  db = (life.module.context as ModuleStore).db;
  edits = life.edits();
  apply("polar", [RUN, RIDE]);
  apply("strava", [RUN_COPY]);
  run = String((life.archive.calendarDb.prepare("SELECT id FROM event WHERE native_id = 'run1'").get() as { id: number }).id);
});

afterAll(async () => {
  life.close();
  await rm(root, { recursive: true, force: true });
});

describe("editing the Workouts table", () => {
  it("says what of a row can be edited, as it stands", () => {
    expect(edits.state("workouts", run)).toEqual({
      fields: {
        sport: { value: "RUNNING" },
        when: { value: wallText(RUN.at) },
        ended: { value: wallText(RUN.endAt) },
        distance: { value: 5.01 },
        note: { value: null, has: false },
      },
      people: {},
    });
  });

  it("corrects the sport, start, end and distance over every copy, kept beside them, and the row and the calendar say so", async () => {
    const sport = await edit("sport", "TRAIL_RUNNING");
    expect(sport.edit).toBeTypeOf("number");
    expect(sport.state!.fields.sport).toEqual({ value: "TRAIL_RUNNING", original: "RUNNING" });
    await edit("when", wallText(RUN.at + 10 * MINUTE));
    await edit("ended", wallText(RUN.endAt + 5 * MINUTE));
    await edit("distance", 5.5);
    const row = rowOf(run);
    expect(row.cells).toMatchObject({ sport: "Trail running", distance: "5.5 km", when: RUN.at + 10 * MINUTE, length: 25 * 60 });
    expect(row.edited?.sort()).toEqual(["distance", "length", "sport", "when"]);
    // Both copies took it, so they are still one activity: one row, and the drawer counts two copies.
    expect(WORKOUTS.rows(life.reads(), NO_FILTERS, { offset: 0, limit: 100, sort: "when", direction: "desc", after: null }).total).toBe(2);
    expect(WORKOUTS.detail(life.reads(), run).more.find((field) => field.label === "Copies")?.value).toBe(2);
    // What the import gave is as it was: the corrections are rows of their own.
    expect(db.prepare("SELECT sport, at, distance_m FROM workout WHERE native_id = 'run1'").get()).toEqual({ sport: "RUNNING", at: RUN.at, distance_m: 5012 });
    expect((db.prepare("SELECT count(*) AS n FROM workout_correction").get() as { n: number }).n).toBe(8);
    expect(drift()).toEqual([]);
  });

  it("keeps the corrections through an import of the same copies again", () => {
    apply("polar", [RUN, RIDE]);
    apply("strava", [RUN_COPY]);
    expect(rowOf(run).cells).toMatchObject({ sport: "Trail running", distance: "5.5 km", when: RUN.at + 10 * MINUTE });
    expect(drift()).toEqual([]);
  });

  it("keeps a note as content: never in the calendar, read only through the trail", async () => {
    const noted = await edit("note", "Felt strong on the hills");
    expect(noted.edit).toBeTypeOf("number");
    expect(noted.state!.fields.note).toEqual({ value: null, has: true });
    expect(JSON.stringify(life.archive.calendar.sink.rowsOf("exercise"))).not.toContain("Felt strong");
    expect(edits.record(noted.edit!)).toMatchObject({ label: "Note", before: null, after: null });
    expect(edits.note("workouts", run, "note")).toBe("Felt strong on the hills");
    const read = life.archive.contentLog.list().find((r) => r.what === "note")!;
    expect(read).toMatchObject({ surface: "viewer", scope: { table: "workouts", field: "note", row: "run1" } });
    // The same words again change nothing, and are not kept.
    expect((await edit("note", "Felt strong on the hills")).edit).toBeNull();
  });

  it("records each edit, and undoes one exactly, refusing it once its field has changed since or it was undone", async () => {
    const [distance] = edits.list({ kind: "workouts", id: run }).filter((e) => e.field === "distance");
    expect(distance).toMatchObject({ label: "Distance", before: "5.01 km", after: "5.5 km", surface: "app", undoneBy: null });
    const undone = await Effect.runPromise(edits.undo(distance!.id, SOURCE));
    expect(undone.state!.fields.distance).toEqual({ value: 5.01 });
    expect(rowOf(run).cells.distance).toBe("5.0 km");
    expect(rowOf(run).edited).not.toContain("distance");
    expect(await refusal(edits.undo(distance!.id, SOURCE))).toBeInstanceOf(UnavailableError);
    // An undo is an edit too, and can be undone.
    const redone = await Effect.runPromise(edits.undo(undone.edit!, SOURCE));
    expect(rowOf(run).cells.distance).toBe("5.5 km");
    expect(edits.record(distance!.id).undoneBy).toBeNull();
    // Its undo undone in turn: undone again, by the first undo, which stands again.
    await Effect.runPromise(edits.undo(redone.edit!, SOURCE));
    expect(rowOf(run).cells.distance).toBe("5.0 km");
    expect(edits.record(distance!.id).undoneBy).toBe(undone.edit);
    expect(await refusal(edits.undo(distance!.id, SOURCE))).toBeInstanceOf(UnavailableError);

    const [sport] = edits.list({ kind: "workouts", id: run }).filter((e) => e.field === "sport");
    await edit("sport", "HIKING");
    expect(await refusal(edits.undo(sport!.id, SOURCE))).toBeInstanceOf(UnavailableError);
    expect(rowOf(run).cells.sport).toBe("Hiking");
    expect(drift()).toEqual([]);
  });

  it("takes a value set back to what the source says, at the precision the field is written, as no correction", async () => {
    // A ride Polar recorded starting 27 seconds past the minute, 24,083 m long, as "Road biking".
    const LOOP = workout("loop1", "Road biking", "ride", at("2026-05-02", "08:00") + 27_000, 40, { distanceMeters: 24_083 });
    apply("polar", [LOOP]);
    const loop = String((life.archive.calendarDb.prepare("SELECT id FROM event WHERE native_id = 'loop1'").get() as { id: number }).id);
    const set = (field: string, value: unknown) => Effect.runPromise(edits.edit("workouts", loop, field, value, SOURCE));
    const corrections = () => (db.prepare("SELECT field FROM workout_correction WHERE native_id = 'loop1' ORDER BY field").all() as Array<{ field: string }>).map((c) => c.field);
    await set("distance", 25);
    await set("when", wallText(LOOP.at + 5 * MINUTE));
    await set("sport", "MOUNTAIN_BIKING");
    expect(corrections()).toEqual(["at", "distance_m", "sport"]);
    // Back as the drawer writes them: 24.08 km, the minute it started, and the sport in the editor's word.
    await set("distance", 24.08);
    await set("when", wallText(LOOP.at));
    await set("sport", "ROAD_BIKING");
    expect(corrections()).toEqual([]);
    expect(rowOf(loop).edited ?? []).toEqual([]);
    expect(drift()).toEqual([]);
  });

  it("refuses what the table does not let be edited, and a value its field does not take", async () => {
    expect(await refusal(edits.edit("workouts", run, "recorder", "Sample watch", SOURCE))).toBeInstanceOf(ForbiddenError);
    expect(await refusal(edits.edit("llm", run, "when", "2026-03-08T07:00", SOURCE))).toBeInstanceOf(ForbiddenError);
    expect(await refusal(edits.edit("nowhere", run, "when", "2026-03-08T07:00", SOURCE))).toBeInstanceOf(NotFoundError);
    expect(await refusal(edits.edit("workouts", "999999", "sport", "RUNNING", SOURCE))).toBeInstanceOf(NotFoundError);
    expect(await refusal(edits.edit("workouts", run, "sport", "SKY_DIVING", SOURCE))).toBeInstanceOf(InvalidInputError);
    expect(await refusal(edits.edit("workouts", run, "distance", -1, SOURCE))).toBeInstanceOf(InvalidInputError);
    expect(await refusal(edits.edit("workouts", run, "when", "8 March", SOURCE))).toBeInstanceOf(InvalidInputError);
    expect(await refusal(edits.edit("workouts", run, "when", wallText(RUN.endAt + 6 * 60 * MINUTE), SOURCE))).toBeInstanceOf(InvalidInputError);
  });

  it("leaves the calendar what a rebuild from the module makes, corrections and all", () => {
    expect(drift()).toEqual([]);
    const counts = life.archive.calendar.rebuild();
    expect(counts.exercise).toMatchObject({ added: 0, updated: 0, forgotten: 0 });
  });
});

describe("the edit route", () => {
  let server: Server;
  let base: string;
  let available = true;

  beforeAll(async () => {
    const handler = editsHandler(edits);
    const down = editsHandler(new Error("no archive here"));
    server = createServer((req, res) => void (available ? handler : down)(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${EDITS_API}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("answers a row's fields, makes an edit and undoes it, from the page itself", async () => {
    const state = (await (await fetch(`${base}/row?kind=workouts&id=${run}`)).json()) as EditState;
    expect(state.fields.sport).toMatchObject({ value: "HIKING" });
    const res = await post("", { kind: "workouts", id: run, field: "sport", value: "WALKING" });
    expect(res.status).toBe(200);
    const done = (await res.json()) as EditDone;
    expect(done.state?.fields.sport).toMatchObject({ value: "WALKING" });
    const undone = await post(`/${done.edit}/undo`, {});
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as EditDone).state?.fields.sport).toMatchObject({ value: "HIKING" });
    const record = (await (await fetch(`${base}?kind=workouts&id=${run}&limit=2`)).json()) as EditsAnswer;
    expect(record.edits.map((e) => [e.label, e.before, e.after])).toEqual([["Sport", "Walking", "Hiking"], ["Sport", "Hiking", "Walking"]]);
  });

  it("refuses a field the table does not let be edited (403), a bad edit (400), another site's page (403), a method it has not (405), and answers 503 with no archive", async () => {
    expect((await post("", { kind: "workouts", id: run, field: "origin", value: "garmin" })).status).toBe(403);
    expect((await post("", { kind: "messages", id: run, field: "when", value: "2026-03-08T07:00" })).status).toBe(404);
    expect((await post("", { kind: "workouts", id: run, field: "sport" })).status).toBe(400);
    expect((await post("", "not json")).status).toBe(400);
    expect((await post("", { kind: "workouts", id: run, field: "sport", value: "WALKING" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await fetch(base, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/note?kind=workouts&id=${run}&field=sport`)).status).toBe(400);
    available = false;
    try {
      expect((await fetch(`${base}/row?kind=workouts&id=${run}`)).status).toBe(503);
    } finally {
      available = true;
    }
  });
});
