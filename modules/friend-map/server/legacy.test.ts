// The drop of what the archive still held of the exercise module's (legacy.ts), through the real command and the real
// take-over, on made-up rows: refused until the module's database is seen to hold them, whole or not at all, and
// overwritten for good. The module is found by its place, as the core finds it (server/modules/loader.ts).

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, ModuleConnectors } from "../../../sdk/server.ts";
import { closeModuleStores, dropExerciseLegacy, exerciseDatabaseFile, exerciseLegacy, exerciseUnheld, loadModules, migrateFriendMap, openModuleStores, runFacts } from "../../../sdk/testing.ts";
import { openUnmovedArchive } from "../testing/unmoved.ts";

const SCRIPT = fileURLToPath(new URL("../../../server/archive/cli.ts", import.meta.url));
const AT = Date.parse("2026-10-14T21:15:00Z");
const DAY = "2026-10-15";
/** In every made-up workout's row, to find its bytes in the file. */
const MARK = "MadeUpLegacyMark";

let dataDir: string;
let archiveFile: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-legacy-"));
  archiveFile = join(dataDir, "archive.sqlite");
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** One made-up workout event of `source`, with its `workout` row. */
function addWorkout(db: Db, source: number, nativeId: string): void {
  const detail = db.prepare("INSERT INTO workout (sport, distance_m, recorder, streams, file) VALUES ('RUNNING', 5000, ?, '{}', ?)").run(MARK, `platform-exports/polar/accesslink/${nativeId}.json`).lastInsertRowid;
  db.prepare(
    `INSERT INTO event (origin, native_id, kind, subkind, at, at_end, day, self, detail, detail_id, size, has_content, first_source_id, last_source_id)
     VALUES ('polar', ?, 'workout', 'run', ?, ?, ?, 1, 'workout', ?, 100, 1, ?, ?)`,
  ).run(nativeId, AT, AT + 60_000, DAY, detail, source, source);
}

const addSource = (db: Db, connector: string, kind: string, counts: unknown) =>
  Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status, counts_json) VALUES ('polar', ?, ?, 'made up', ?, ?, 'ok', ?)").run(connector, kind, AT, AT, JSON.stringify(counts)).lastInsertRowid);

/** An archive with made-up rows of exercise's as the core kept them: a live run whose counts name no events, as the real ones do, two workouts, a tombstone, and a cursor. */
function writeLegacy(): void {
  const db = openUnmovedArchive(archiveFile);
  const live = addSource(db, "polar", "live", { events: {}, tallies: {} });
  const exported = addSource(db, "polar-export", "export", { events: { workout: { added: 1, updated: 0, unchanged: 0 } }, tallies: {} });
  addWorkout(db, live, `${MARK}-live`);
  addWorkout(db, exported, `${MARK}-export`);
  db.prepare("INSERT INTO deleted_workout (origin, native_id, family, at, at_end, deleted_at) VALUES ('polar', 'gone-before', 'run', ?, ?, ?)").run(AT, AT, AT);
  db.prepare("INSERT INTO connector_state (connector, status, cursor_json) VALUES ('polar', 'idle', '{}')").run();
  db.close();
}

/** Opens the modules' databases as the server does as it starts, the take-over among it, hands the exercise module's to `work`, and closes them. */
async function start(work: (db: DatabaseSync, brought: ModuleConnectors["brought"]) => void = () => {}): Promise<void> {
  // The exercise module's alone: friend map's archive is the one this test keeps at the folder's root, as before the move.
  const modules = await loadModules({ all: true });
  const stores = openModuleStores({ ...modules, on: modules.on.filter((m) => m.id === "exercise") }, dataDir);
  try {
    const exercise = stores.on.find((m) => m.id === "exercise")!;
    work(exercise.db!, exercise.definition.connectors!.brought);
  } finally {
    closeModuleStores(stores);
  }
}

/** The friend map step's move (the core's migrate.ts), which drops these rows as it moves the archive: what it said, or why it refused. */
async function migrate(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const said: string[] = [];
  try {
    await migrateFriendMap(dataDir, { apply: args.includes("--apply"), log: (line) => void said.push(line), serverRunning: async () => false });
    return { code: 0, stdout: said.join("\n"), stderr: "" };
  } catch (error) {
    return { code: 1, stdout: said.join("\n"), stderr: (error as Error).message };
  }
}

const legacy = () => {
  const db = openUnmovedArchive(archiveFile);
  try {
    return exerciseLegacy(db);
  } finally {
    db.close();
  }
};

const WHOLE = { workouts: 2, deleted: 1, sources: 2, states: 1 };
const backups = () => (existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")) : []);

describe("the drop of the archive's exercise rows", () => {
  it("is refused, with nothing taken and no backup, before the module has a database", async () => {
    writeLegacy();
    const { code, stderr } = await migrate("--apply");
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot drop yet: Nothing can be dropped yet: there is no .*exercise\.sqlite|cannot drop yet: there is no .*exercise\.sqlite/);
    expect(legacy()).toEqual(WHOLE);
    expect(backups()).toEqual([]);
  });

  it("is refused when the module's database took nothing over, having been new beside no archive", async () => {
    await start();
    writeLegacy();
    const { code, stderr } = await migrate("--apply");
    expect(code).toBe(1);
    expect(stderr).toMatch(/has not taken the archive's rows over \(its taken_over is nothing\)/);
    expect(legacy()).toEqual(WHOLE);
  });

  it("is refused when the module's database lacks a workout or a tombstone the archive holds, by its source and id", async () => {
    writeLegacy();
    await start((db) => {
      db.prepare("DELETE FROM workout WHERE native_id = ?").run(`${MARK}-live`);
      db.prepare("DELETE FROM deleted_workout").run();
    });
    const { code, stderr } = await migrate("--apply");
    expect(code).toBe(1);
    expect(stderr).toMatch(/lacks 1 of the archive's workouts and 1 of its tombstones/);
    expect(legacy()).toEqual(WHOLE);
    expect(backups()).toEqual([]);
  });

  it("takes a workout deleted since the take-over as held, by its tombstone, and overwrites every row for good after a checked backup", async () => {
    writeLegacy();
    await start((db) => {
      db.prepare("DELETE FROM workout WHERE native_id = ?").run(`${MARK}-live`);
      db.prepare("INSERT INTO deleted_workout (origin, native_id, family, at, at_end, deleted_at) VALUES ('polar', ?, 'run', ?, ?, ?)").run(`${MARK}-live`, AT, AT, AT);
    });
    const look = await migrate();
    expect(look.code).toBe(0);
    expect(look.stdout).toContain("Would drop the exercise module's 6 old rows and the rituals module's 0.");
    expect(legacy()).toEqual(WHOLE);

    const dropped = await migrate("--apply");
    expect(dropped.stderr).toBe("");
    expect(dropped.code).toBe(0);
    // Moved, its old rows of exercise's gone with the tables that held them, overwritten for good.
    archiveFile = join(dataDir, "modules", "friend-map", "archive.sqlite");
    const files = [archiveFile, `${archiveFile}-wal`].filter(existsSync);
    expect(files.some((file) => readFileSync(file).includes(MARK))).toBe(false);
    const taken = backups().find((name) => name.endsWith("-before-friend-map-module.sqlite"))!;
    expect(readFileSync(join(dataDir, "backups", taken)).includes(MARK)).toBe(true);
    expect((await migrate("--apply")).stdout).toContain("nothing to move");
  });

  it("is whole or not at all: a row something else still points at stops it, and everything stays", () => {
    writeLegacy();
    const db = openUnmovedArchive(archiveFile);
    try {
      const { id } = db.prepare("SELECT id FROM source WHERE connector = 'polar'").get() as { id: number };
      db.prepare(
        `INSERT INTO event (origin, native_id, kind, at, day, self, detail, detail_id, has_content, first_source_id, last_source_id)
         VALUES ('claude-code', 'made-up', 'llm_session', ?, ?, 1, 'llm_session', 1, 0, ?, ?)`,
      ).run(AT, DAY, id, id);
      expect(() => dropExerciseLegacy(db)).toThrow(/FOREIGN KEY|broken references/);
      expect(exerciseLegacy(db)).toEqual(WHOLE);
    } finally {
      db.close();
    }
  });

  it("finds nothing unheld right after the take-over", async () => {
    writeLegacy();
    await start();
    const file = exerciseDatabaseFile(dataDir);
    const db = openUnmovedArchive(archiveFile);
    try {
      expect(exerciseUnheld(db, file)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("the rows taken over", () => {
  it("give the Sources tab what polar brought, though the live run's counts name no events", async () => {
    writeLegacy();
    await start((db, brought) => {
      const facts = runFacts(db, brought);
      expect(facts.get("polar")?.brought.events).toEqual({ workout: 1 });
      expect(facts.get("polar-export")?.brought.events).toEqual({ workout: 1 });
    });
  });
});
