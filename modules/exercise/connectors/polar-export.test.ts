// The polar-export connector, on made-up sessions only (../fixtures/polar.ts): a session's exercise as a workout event
// under an id of its own, never a heart rate or a coordinate; and an export imported into the module's index through
// the core's host (again: nothing changes), a file it cannot read counted. The activities over every source are the
// Fitness page's (../server/exercise.test.ts).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleStore } from "../../../sdk/server.ts";
import { testingLifeArchive, validateEvent } from "../../../sdk/testing.ts";
import { FLOW_APP, madeUpSession, TESTING_EXPORT, TESTING_RUNS } from "../fixtures/polar.ts";
import exercise from "../module.ts";
import { WorkoutIndex } from "../server/workoutIndex.ts";
import { EXERCISE_DB } from "../server/db.ts";
import { UNREAD_TALLY } from "./polar-export/read.ts";
import { heartRateOf, workoutEvents } from "./polar-export/session.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-polar-export-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a session of Polar's account export", () => {
  const session = madeUpSession("7000000001", TESTING_RUNS.may);

  it("is a workout event of each exercise, keyed export/<its id>, holding its streams and never its values", () => {
    const [event] = workoutEvents(session, "/archive/platform-exports/polar/2026-10-16/training-session.json", 999);
    expect(event).toEqual({
      kind: "workout", id: "export/7000000001", sport: "RUNNING", family: "run", at: Date.parse("2026-05-19T21:15:00Z"),
      endAt: Date.parse("2026-05-19T21:56:00Z"), distanceMeters: 6600, recorder: FLOW_APP,
      // The speed's first value is a sensor's gap ("NaN").
      streams: { distance: { samples: 2460, everySeconds: 1 }, speed: { samples: 2459, everySeconds: 1 }, heartRate: { samples: 2460, everySeconds: 1 }, gps: { samples: 2460, everySeconds: 1 } },
      file: "/archive/platform-exports/polar/2026-10-16/training-session.json", bytes: 999,
    });
    expect(validateEvent(event)).toEqual({ event });
    expect(JSON.stringify(event)).not.toMatch(/note|weight|latitude|hrAvg/);
  });

  it("gives the Fitness page its heart rate, its zones from their milliseconds", () => {
    const hr = heartRateOf(session, "export/7000000001")!;
    expect(hr).toMatchObject({ average: session.hrAvg, maximum: session.hrMax });
    expect(hr.zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(heartRateOf(session, "export/1")).toBeNull();
  });
});

describe("an export in the module's index", () => {
  it("comes in once through the host, its files kept where they are, again changes nothing, and a file it cannot read is counted", async () => {
    const dataDir = join(root, "archive");
    const folder = join(dataDir, TESTING_EXPORT);
    await mkdir(folder, { recursive: true });
    for (const [id, run] of [["7000000001", TESTING_RUNS.may], ["7000000002", TESTING_RUNS.october]] as const) {
      await writeFile(join(folder, `training-session_${run.start.replace(/:/g, "-")}_${id}.json`), JSON.stringify(madeUpSession(id, run)));
    }
    await writeFile(join(folder, "training-session_broken.json"), "{");
    await writeFile(join(folder, "account-profile.json"), "{}");
    await mkdir(join(dataDir, "connectors"), { recursive: true });
    await writeFile(join(dataDir, "connectors", "polar-export.json"), JSON.stringify({ enabled: true }));
    const life = await testingLifeArchive(dataDir, exercise);
    try {
      const first = await life.archive.importHistory("polar-export", folder);
      expect(first.counts.events).toEqual({ workout: { added: 2, updated: 0, unchanged: 0 } });
      expect(first.counts.tallies).toEqual({ [UNREAD_TALLY]: 1 });
      const again = await life.archive.importHistory("polar-export", folder);
      expect(again.counts.events).toEqual({ workout: { added: 0, updated: 0, unchanged: 2 } });
      const { db } = life.module.context as ModuleStore;
      const rows = new WorkoutIndex(db).all();
      expect(rows.map((r) => [r.origin, r.nativeId])).toEqual([["polar", "export/7000000001"], ["polar", "export/7000000002"]]);
      expect(rows[0].workout.file).toMatch(/^platform-exports\/polar\/2026-10-16\/training-session_2026-05-20T07-15-00_7000000001\.json$/);
      // The host's record of the import is the module's, in its own database, and the rows are in the calendar, pushed as it committed.
      expect((db.prepare("SELECT count(*) AS n FROM source WHERE connector = 'polar-export' AND status = 'ok'").get() as { n: number }).n).toBe(2);
      expect(life.archive.calendar.sink.rowsOf("exercise").map((row) => row.nativeId).sort()).toEqual(["export/7000000001", "export/7000000002"]);
      expect(life.archive.calendar.drift()).toEqual([]);
      // What the Sources tab shows: the copies it holds that this connector first brought, however many runs saw them.
      expect(exercise.connectors!.brought(db)).toEqual([{ connector: "polar-export", kind: "workout", count: 2 }]);
    } finally {
      life.close();
    }
  });

  it("is counted by a dry run on a copy of the module's database, tombstones and all, and the real one stays as it was", async () => {
    const dataDir = join(root, "dry-run");
    const folder = join(dataDir, TESTING_EXPORT);
    await mkdir(folder, { recursive: true });
    const session = async (id: string, run: typeof TESTING_RUNS.may) => writeFile(join(folder, `training-session_${run.start.replace(/:/g, "-")}_${id}.json`), JSON.stringify(madeUpSession(id, run)));
    await session("7000000001", TESTING_RUNS.may);
    await mkdir(join(dataDir, "connectors"), { recursive: true });
    await writeFile(join(dataDir, "connectors", "polar-export.json"), JSON.stringify({ enabled: true }));
    const life = await testingLifeArchive(dataDir, exercise);
    try {
      await life.archive.importHistory("polar-export", folder);
    } finally {
      life.close();
    }
    await session("7000000002", TESTING_RUNS.october);
    const script = fileURLToPath(new URL("../../../server/archive/cli.ts", import.meta.url));
    const dryRun = async () => (await promisify(execFile)(process.execPath, ["--no-warnings", script, "import", "polar-export", folder, "--dry-run", "--data", dataDir])).stdout;
    const file = join(dataDir, "modules", "exercise", EXERCISE_DB);
    const held = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare("SELECT (SELECT count(*) FROM workout) AS workouts, (SELECT count(*) FROM source) AS sources").get();
      } finally {
        db.close();
      }
    };
    const before = held();
    expect(before).toEqual({ workouts: 1, sources: 1 });
    expect(await dryRun()).toContain("Events, workout: 1 new, 0 changed, 1 already had.");
    expect(held()).toEqual(before);

    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO deleted_workout (origin, native_id, family, at, at_end, deleted_at) VALUES ('polar', 'export/7000000002', 'run', ?, ?, ?)").run(
      Date.parse(TESTING_RUNS.october.start), Date.parse(TESTING_RUNS.october.start) + 60_000, Date.parse(TESTING_RUNS.october.start),
    );
    db.close();
    expect(await dryRun()).toContain("Events, workout: 0 new, 0 changed, 1 already had.");
    expect(held()).toEqual(before);
  }, 60_000);
});
