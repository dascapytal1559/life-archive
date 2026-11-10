// An activity's delete from the Fitness page, on made-up copies only (../fixtures/polar.ts, modules/health/fixtures/health.ts): every copy
// of it gone (AccessLink's JSON and FIT, the export's session and its entry in the export's zip, the index's rows),
// only a tombstone left that holds no heart rate, route or file; what cannot be deleted whole refused with nothing
// changed, every activity while the runs by hand are unknown; and no source bringing it back: the export imported again or downloaded anew, AccessLink listing it again,
// a copy under another id of the same activity, a copy written straight to the index.

import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect, EXPORTS_FOLDER, runPromise, transaction, ZipFile, type ModuleLive, type ModuleStore } from "../../../sdk/server.ts";
import { testingLifeArchive, writeZip, type TestingLifeArchive } from "../../../sdk/testing.ts";
import { accessLink } from "../connectors/polar/api.ts";
import { workoutEvent } from "../connectors/polar/exercise.ts";
import { copiedEvents, COPIES, fetchNew } from "../connectors/polar/read.ts";
import { fakeAccessLink, madeUpExercise, madeUpSession, RUNS_BY_HAND, TESTING_EXPORT, TESTING_RUNS, writeMadeUpPolar } from "../fixtures/polar.ts";
import exercise from "../module.ts";
import type { ActivityDeleted, ActivityDetail, ExerciseAnswer } from "../wire.ts";
import { applyWorkouts } from "./apply.ts";
import { DELETED_SETTING, DELETED_TALLY, deletedWorkouts } from "./deletedWorkouts.ts";
import { createExerciseApi } from "./http.ts";
import { WorkoutIndex } from "./workoutIndex.ts";

type Context = ModuleStore & ModuleLive;

const OCTOBER = TESTING_RUNS.october;
/** The October run's session file in the testing export. */
const SESSION = `training-session_${OCTOBER.start.replace(/:/g, "-")}_7000000002.json`;
const MAY_SESSION = `training-session_${TESTING_RUNS.may.start.replace(/:/g, "-")}_7000000001.json`;
const ZIP = "polar-user-data-export_made-up.zip";

let root: string;
let dataDir: string;
let life: TestingLifeArchive;
let context: Context;
let url: string;
let close: () => void;
/** The October run's session, as the export holds it, to bring it back as a later download would. */
let sessionBytes: Buffer;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-exercise-delete-"));
  dataDir = join(root, "archive");
  life = await testingLifeArchive(dataDir, exercise);
  context = life.module.context as Context;
  await writeMadeUpPolar(context.db, dataDir);
  life.archive.calendar.rebuild();
  const exported = join(dataDir, TESTING_EXPORT);
  sessionBytes = await readFile(join(exported, SESSION));
  // The export's zip, kept beside what it unpacked to, as every export is.
  await writeZip(join(exported, ZIP), [
    { name: "account-profile-made-up.json", data: "{}" },
    { name: MAY_SESSION, data: await readFile(join(exported, MAY_SESSION)) },
    { name: SESSION, data: sessionBytes },
  ]);
  await writeFile(join(dataDir, "connectors", "polar-export.json"), JSON.stringify({ enabled: true }));
  // The runs by hand as the health module offers them (RunsByHand): one a second copy of the May run, which a delete takes too.
  const server = createServer(createExerciseApi(context, { now: () => Date.parse("2026-10-16T01:00:00Z"), byHand: RUNS_BY_HAND }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise/activities`;
  close = () => {
    server.close();
    life.close();
  };
});
afterAll(async () => {
  close();
  await rm(root, { recursive: true, force: true });
});

/** A delete as the page sends it: its Origin, a JSON body with the activity's start. */
const remove = (id: string, start: string, headers: Record<string, string> = {}, at = url) =>
  fetch(`${at}/${id}`, {
    method: "DELETE",
    headers: { origin: new URL(at).origin, "content-type": "application/json", ...headers },
    body: JSON.stringify({ start }),
  });

const activities = async () => ((await (await fetch(url)).json()) as ExerciseAnswer).activities;
/** Every byte of the calendar: its file and what its WAL holds. */
const calendarBytes = async () => Buffer.concat(await Promise.all(["calendar.sqlite", "calendar.sqlite-wal"].map((name) => readFile(join(dataDir, name)).catch(() => Buffer.alloc(0)))));
const workoutIds = (db = context.db) => new WorkoutIndex(db).all().map((w) => w.nativeId);

/** `ask`, given the routes' address, on a server whose reads see the runs by hand as `runs` gives them, as the server's do through the health module. */
async function withRunsByHand(runs: Effect.Effect<readonly never[], Error>, ask: (at: string) => Promise<void>): Promise<void> {
  const server = createServer(createExerciseApi(context, { runs }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await ask(`http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise/activities`);
  } finally {
    server.close();
  }
}

describe("an activity's delete", () => {
  it("refuses what is not the page's own, a stale page and a run transcribed by hand, changing nothing", async () => {
    const [, october] = await activities();
    expect(october.start).toBe("2026-10-14T06:50");
    expect((await remove(october.id, october.start, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await fetch(`${url}/${october.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await remove(october.id, october.start, { "content-type": "text/plain" })).status).toBe(400);
    const stale = await remove(october.id, "2026-10-14T06:51");
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/changed since the page was opened/);
    expect((await fetch(url, { method: "DELETE", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" })).status).toBe(405);

    // A run transcribed by hand is the captain's own file: the page says so instead of offering Delete.
    const hand = (await (await fetch(`${url}/hand-202606031840`)).json()) as ActivityDetail;
    expect(hand.cannotDelete).toMatch(/by-hand\.json/);
    expect((await remove(hand.id, hand.start)).status).toBe(409);
    const may = (await activities()).find((a) => a.start === "2026-05-20T07:15")!;
    expect((await remove(may.id, may.start)).status).toBe(409);

    expect(workoutIds()).toHaveLength(5);
    expect(deletedWorkouts(context.db)).toEqual([]);
  });

  it("refuses every delete, changing nothing, while the runs by hand are unknown, as a copy may be among them", async () => {
    const [, october] = await activities();
    const refused = (why: RegExp) => async (at: string) => {
      const detail = (await (await fetch(`${at}/${october.id}`)).json()) as ActivityDetail;
      expect(detail.cannotDelete).toMatch(why);
      const res = await remove(october.id, october.start, {}, at);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(why);
    };
    await withRunsByHand(Effect.fail(new Error("the health module is off")), refused(/not every copy of it can be known: the health module is off/));
    await withRunsByHand(Effect.fail(new Error("health/by-hand.json cannot be read")), refused(/not every copy of it can be known: health\/by-hand\.json cannot be read/));

    expect(workoutIds()).toHaveLength(5);
    expect(deletedWorkouts(context.db)).toEqual([]);
  });

  it("removes every copy of it, their files and their entry in the export's zip, leaving only a tombstone", async () => {
    const [, october] = await activities();
    const detail = (await (await fetch(`${url}/${october.id}`)).json()) as ActivityDetail;
    expect(detail).toMatchObject({ source: "Polar Flow", alsoIn: ["Polar Flow's account export"], cannotDelete: null });

    expect((await calendarBytes()).includes("MadeUp2Oct")).toBe(true);

    const res = await remove(october.id, october.start);
    expect(res.status).toBe(200);
    expect((await res.json()) as ActivityDeleted).toEqual({ id: october.id, copies: 2, files: 4 });

    // Its files: AccessLink's JSON and FIT, and the export's session.
    const copies = join(dataDir, EXPORTS_FOLDER, COPIES);
    expect((await readdir(copies)).filter((name) => name.startsWith("MadeUp2Oct"))).toEqual([]);
    expect(existsSync(join(dataDir, TESTING_EXPORT, SESSION))).toBe(false);
    expect(existsSync(join(dataDir, TESTING_EXPORT, MAY_SESSION))).toBe(true);
    // The zip holds the rest as it did, and not it.
    const zip = await ZipFile.open(join(dataDir, TESTING_EXPORT, ZIP));
    try {
      expect(zip.entries.map((e) => e.name)).toEqual(["account-profile-made-up.json", MAY_SESSION]);
      expect(await zip.read(zip.entries[1])).toEqual(await readFile(join(dataDir, TESTING_EXPORT, MAY_SESSION)));
    } finally {
      await zip.close();
    }
    expect((await readdir(join(dataDir, TESTING_EXPORT))).filter((name) => name.includes(".tmp"))).toEqual([]);

    // Its index rows, and the page's.
    expect(workoutIds()).not.toContain("MadeUp2Oct");
    expect(workoutIds()).not.toContain("export/7000000002");
    expect(context.db.prepare("SELECT count(*) AS n FROM workout").get()).toEqual({ n: 3 });
    expect((await activities()).map((a) => a.start)).not.toContain("2026-10-14T06:50");
    expect((await fetch(`${url}/${october.id}`)).status).toBe(404);

    // Its rows in the calendar, their bytes gone from the file and its WAL.
    expect(life.archive.calendar.sink.rowsOf("exercise").map((row) => row.nativeId).filter((id) => id === "MadeUp2Oct" || id === "export/7000000002")).toEqual([]);
    const left = await calendarBytes();
    expect(left.includes("MadeUp2Oct")).toBe(false);
    expect(left.includes("export/7000000002")).toBe(false);
    expect(life.archive.calendar.drift()).toEqual([]);

    // The tombstones: a copy's source, id, family and times, and when; nothing of what it held.
    const rows = context.db.prepare("SELECT * FROM deleted_workout ORDER BY native_id").all();
    expect(rows.map((row) => Object.keys(row).sort())).toEqual([["at", "at_end", "deleted_at", "family", "native_id", "origin"], ["at", "at_end", "deleted_at", "family", "native_id", "origin"]]);
    expect(rows.map((row) => [row.origin, row.native_id, row.family])).toEqual([["polar", "MadeUp2Oct", "run"], ["polar", "export/7000000002", "run"]]);
  });

  it("hands the tombstones to every connector in its settings, as a sync or an import runs with them", async () => {
    const { config } = await life.archive.host.connectorConfig("polar");
    expect(config[DELETED_SETTING]).toEqual([
      { origin: "polar", id: "MadeUp2Oct", family: "run", at: expect.any(Number), endAt: expect.any(Number) },
      { origin: "polar", id: "export/7000000002", family: "run", at: expect.any(Number), endAt: expect.any(Number) },
    ]);
    // Its file is left as the captain wrote it.
    expect(await readFile(join(dataDir, "connectors", "polar.json"), "utf8")).not.toContain(DELETED_SETTING);
  });
});

describe("a deleted workout, brought again", () => {
  it("is left out when its export is imported again, or a new download holds it under another id", async () => {
    const exported = join(dataDir, TESTING_EXPORT);
    await writeFile(join(exported, SESSION), sessionBytes);
    const again = await life.archive.importHistory("polar-export", exported);
    expect(again.counts.events).toEqual({ workout: { added: 0, updated: 0, unchanged: 1 } });
    expect(again.counts.tallies).toEqual({ [DELETED_TALLY]: 1 });
    expect(workoutIds()).not.toContain("export/7000000002");

    // A later download: the same run, under an id of its own, is the same activity, and left out too.
    const later = join(dataDir, EXPORTS_FOLDER, "polar", "2026-11-01");
    await mkdir(later, { recursive: true });
    await writeFile(join(later, `training-session_${OCTOBER.start.replace(/:/g, "-")}_7000000099.json`), JSON.stringify(madeUpSession("7000000099", OCTOBER)));
    const download = await life.archive.importHistory("polar-export", later);
    expect(download.counts.tallies).toEqual({ [DELETED_TALLY]: 1 });
    expect(workoutIds()).not.toContain("export/7000000099");
    await rm(join(exported, SESSION));
  });

  it("is never fetched from AccessLink again, by its id or as the same activity under another", async () => {
    const deleted = deletedWorkouts(context.db);
    const fake = await fakeAccessLink({
      token: "made-up-token",
      exercises: [madeUpExercise("MadeUp2Oct", OCTOBER), madeUpExercise("MadeUp9Oct", OCTOBER), madeUpExercise("MadeUp3Oct", TESTING_RUNS.latest)],
    });
    try {
      const dir = join(root, "fetched", COPIES);
      const fetched = await runPromise(fetchNew(accessLink(fake.url, "made-up-token"), dir, deleted));
      expect(fetched).toEqual({ copied: 1, tallies: { deleted: 2 } });
      // Never asked for the deleted one by its id; the other id fetched, seen to be it, and not kept.
      expect(fake.asked.map((a) => a.path)).not.toContain("/v3/exercises/MadeUp2Oct");
      expect((await readdir(dir)).sort()).toEqual(["MadeUp3Oct.fit", "MadeUp3Oct.json"]);
      // A copy left in the folder is not read back as an event.
      await writeFile(join(dir, "MadeUp2Oct.json"), JSON.stringify(madeUpExercise("MadeUp2Oct", OCTOBER)));
      const { events } = await runPromise(copiedEvents(dir, deleted));
      expect(events.map((e) => e.id)).toEqual(["MadeUp3Oct"]);
    } finally {
      await fake.close();
    }
  });

  it("is never written to the index, whatever brings it", () => {
    const event = workoutEvent(madeUpExercise("MadeUp2Oct", OCTOBER), { file: join(root, "MadeUp2Oct.json"), bytes: 10 });
    const { db } = context;
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('polar', 'polar', 'live', 'sync', ?, 'running')")
      .run(Date.now()).lastInsertRowid);
    const applied = transaction(db, () => applyWorkouts([event, { ...event, id: "MadeUp8Oct" }], db, { id: source, platform: "polar", kind: "export", seenAt: 0, folder: dataDir }));
    expect(applied.counts.tallies).toEqual({ [DELETED_TALLY]: 2 });
    expect(applied.rows).toEqual([]);
    expect(workoutIds()).not.toContain("MadeUp2Oct");
    expect(workoutIds()).not.toContain("MadeUp8Oct");
    // Another run, at another time, is not.
    const other = workoutEvent(madeUpExercise("MadeUp5Oct", { ...OCTOBER, start: "2026-10-14T07:30:00" }), { file: join(root, "MadeUp5Oct.json"), bytes: 10 });
    const added = transaction(db, () => applyWorkouts([other], db, { id: source, platform: "polar", kind: "export", seenAt: 0, folder: dataDir }));
    expect(added.rows.map((row) => [row.module, row.kind, row.nativeId])).toEqual([["exercise", "workout", "MadeUp5Oct"]]);
    expect(workoutIds()).toContain("MadeUp5Oct");
    life.archive.calendar.rebuild();
  });
});

describe("a delete the calendar stops", () => {
  it("can be tried again, and finishes, as the index still names the copies", async () => {
    const dir = join(root, "stopped");
    const stopped = await testingLifeArchive(dir, exercise);
    const own = stopped.module.context as Context;
    const server = createServer(createExerciseApi(own));
    try {
      await writeMadeUpPolar(own.db, dir);
      stopped.archive.calendar.rebuild();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise/activities`;
      const list = ((await (await fetch(base)).json()) as ExerciseAnswer).activities;
      const october = list.find((a) => a.start === "2026-10-14T06:50")!;
      const forget = vi.spyOn(own.calendar, "forget").mockImplementationOnce(() => {
        throw new Error("the calendar is busy");
      });
      const stoppedPart = await remove(october.id, october.start, {}, base);
      expect(stoppedPart.status).toBe(409);
      expect(((await stoppedPart.json()) as { error: string }).error).toMatch(/can be tried again/);
      expect(workoutIds(own.db)).toContain("MadeUp2Oct");
      expect(forget).toHaveBeenCalledTimes(1);

      expect((await remove(october.id, october.start, {}, base)).status).toBe(200);
      expect(workoutIds(own.db)).not.toContain("MadeUp2Oct");
      expect(stopped.archive.calendar.drift()).toEqual([]);
    } finally {
      server.close();
      stopped.close();
    }
  });
});

describe("a delete while the archive is not open", () => {
  it("answers that the archive is not available, as the page always had it, with nothing touched", async () => {
    const dir = join(root, "closed");
    const closed = await testingLifeArchive(dir, exercise);
    const own = closed.module.context as Context;
    const notOpen = (): never => {
      throw new Error("the archive is not available: made-up reason");
    };
    const server = createServer(createExerciseApi({ ...own, pausingLive: notOpen }));
    try {
      await writeMadeUpPolar(own.db, dir);
      closed.archive.calendar.rebuild();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise/activities`;
      const list = ((await (await fetch(base)).json()) as ExerciseAnswer).activities;
      const october = list.find((a) => a.start === "2026-10-14T06:50")!;
      const before = workoutIds(own.db);

      const answer = await remove(october.id, october.start, {}, base);
      expect(answer.status).toBe(503);
      expect(await answer.json()).toEqual({ error: "the archive is not available: made-up reason" });
      expect(workoutIds(own.db)).toEqual(before);
      expect(deletedWorkouts(own.db)).toEqual([]);
      expect(existsSync(join(dir, TESTING_EXPORT, SESSION))).toBe(true);
      expect(closed.archive.calendar.drift()).toEqual([]);
    } finally {
      server.close();
      closed.close();
    }
  });
});

describe("a copy shared with another workout", () => {
  it("is refused, changing nothing: a session of several sports is deleted whole or not at all", async () => {
    const dir = join(root, "shared");
    const shared = await testingLifeArchive(dir, exercise);
    const own = shared.module.context as Context;
    try {
      await writeMadeUpPolar(own.db, dir);
      // The October run's session holds a second exercise, a ride after it.
      const session = new WorkoutIndex(own.db).all().find((row) => row.origin === "polar" && row.nativeId === "export/7000000002")!.workout;
      const source = Number(own.db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('polar', 'polar-export', 'export', 'x', 0, 'ok')").run().lastInsertRowid);
      transaction(own.db, () =>
        applyWorkouts(
          [{ kind: "workout", id: "export/7000000003", sport: "CYCLING", family: "ride", at: Date.parse("2026-10-13T21:00:00Z"), endAt: Date.parse("2026-10-13T21:30:00Z"), streams: {}, file: join(dir, session.file), bytes: 1 }],
          own.db, { id: source, platform: "polar", kind: "export", seenAt: 0, folder: dir },
        ),
      );
      const server = createServer(createExerciseApi(own));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise/activities`;
      try {
        const list = ((await (await fetch(base)).json()) as ExerciseAnswer).activities;
        const october = list.find((a) => a.start === "2026-10-14T06:50")!;
        const res = await fetch(`${base}/${october.id}`, { method: "DELETE", headers: { origin: new URL(base).origin, "content-type": "application/json" }, body: JSON.stringify({ start: october.start }) });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toMatch(/also holds another workout/);
        expect(existsSync(join(dir, session.file))).toBe(true);
        expect(existsSync(join(dir, EXPORTS_FOLDER, COPIES, "MadeUp2Oct.json"))).toBe(true);
        expect(deletedWorkouts(own.db)).toEqual([]);
      } finally {
        server.close();
      }
    } finally {
      shared.close();
    }
  });
});
