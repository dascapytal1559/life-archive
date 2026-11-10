// The friend map step's one-time move (the core's server/archive/migrate.ts, `npm run archive -- migrate
// friend-map-module`) on a made-up archive as it was before friend map was a module: everything in archive.sqlite at the
// folder's root, the core's tables (an agent's session, an inspiration and its changeset, a trail of content reads,
// the core connectors' runs) beside the chats. Nothing opens it as it is; the dry run moves nothing; the move copies the
// core's tables into core.sqlite (ids kept, counts checked), the trail into the calendar, moves the archive into
// modules/friend-map/ and drops from it what is no longer its; and the archive opens after, every row in its place.
// It refuses a full core.sqlite, a behind schema and an archive another process holds; interrupted after any step, it
// finishes when run again, and nothing opens the folder until then. A new archive has the moved one's schema, friend
// map's tables alone, and the moved one opens to it with every row in place.

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreLedger, migrateFriendMap, MOVE_VERSION, openCalendar, openCore, testingLifeArchive, unmovedArchive } from "../../../sdk/testing.ts";
import { schemaVersion, transaction, type ArchiveEvent } from "../../../sdk/server.ts";
import friendMapModule from "../module.ts";
import { openTestArchive } from "../testing/archive.ts";
import { openUnmovedArchive } from "../testing/unmoved.ts";
import { openArchive, SCHEMA_VERSION } from "./db.ts";
import { People } from "./people.ts";
import { applyChats } from "./write.ts";

const AT = Date.parse("2026-03-06T08:00:00+11:00");
let dataDir: string;
const said: string[] = [];
const quiet = { log: (line: string) => void said.push(line), serverRunning: async () => false };

/** The inspiration the old archive held, as the move left it in the core's database (for the inspirations module to take over): its caption, tags and changesets. */
function coreInspiration(core: DatabaseSync): unknown {
  return core.prepare(
    `SELECT i.caption,
       (SELECT group_concat(t.name) FROM inspiration_item_tag it JOIN inspiration_tag t ON t.id = it.tag_id WHERE it.inspiration_id = i.id) AS tags,
       (SELECT group_concat(action) FROM changeset) AS changesets
     FROM inspiration i WHERE i.id = 1`,
  ).get();
}

/** The archive's folder as it was before the move: one archive.sqlite holding the chats and the core's tables. */
async function oldArchive(): Promise<void> {
  const db = openUnmovedArchive(join(dataDir, "archive.sqlite"), { dataDir });
  const source = (platform: string, connector: string) =>
    Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES (?, ?, 'export', 'made up', 1, 2, 'ok')").run(platform, connector).lastInsertRowid);
  transaction(db, () => {
    const chats: ArchiveEvent[] = [
      { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
      { kind: "account", key: "Ada Sample", keyKind: "name", displayName: "Ada Sample" },
      { kind: "conversation", id: "ada", type: "direct", title: null, members: ["Me", "Ada Sample"] },
      { kind: "message", id: "m1", idKind: "platform", conversation: "ada", sender: "Ada Sample", isFromSelf: false, sentAt: AT, type: "text", text: "made-up words", raw: {} },
    ] as ArchiveEvent[];
    applyChats(chats, db, { id: source("messenger", "messenger-export"), platform: "messenger", kind: "export", seenAt: 2, folder: dataDir }, () => {});
    coreLedger(db).apply([
      { kind: "llm-session", id: "session-1", entrypoint: "cli", project: "/home/sample/Projects/garden-planner", file: join(dataDir, "session-1.jsonl"), startedAt: AT, endedAt: AT + 60_000, bytes: 100 },
    ] as ArchiveEvent[], { id: source("claude-code", "llm-sessions"), platform: "claude-code", kind: "export", seenAt: 2, folder: dataDir });
    db.prepare("INSERT INTO connector_state (connector, status, last_ok_at, cursor_json) VALUES ('llm-sessions', 'idle', 2, '{\"files\":{}}')").run();
    db.prepare("INSERT INTO content_read (at, last_at, reads, surface, reader, what, scope_json, why) VALUES (1, 1, 1, 'cli', 'made-up', 'timeline', '{\"person\":2}', 'a made-up reason')").run();
  });
  new People(db).runRules();
  // An inspiration tagged craft, and the changeset of his caption for it, in the change log the old archive kept the
  // inspirations' tables in beside the people's: as the inspirations' code, the core's then, wrote them.
  db.exec(`
    INSERT INTO inspiration (id, link, platform, form, caption, created_at, edited_at) VALUES (1, 'https://example.com/vase', 'web', 'article', 'a made-up caption', ${AT}, ${AT});
    INSERT INTO inspiration_save (inspiration_id, origin, link, saved_at) VALUES (1, 'cli', 'https://example.com/vase', ${AT});
    INSERT INTO inspiration_tag (id, name, sort_order, created_at) VALUES (1, 'craft', 0, ${AT});
    INSERT INTO inspiration_item_tag (inspiration_id, tag_id, added_at) VALUES (1, 1, ${AT});
    INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ${AT}, 'cli', 'inspiration caption #1', '{}');
    INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json)
      VALUES (1, 'inspiration', '[1]', '{"caption":"","hidden_at":null,"edited_at":null}', '{"caption":"a made-up caption","hidden_at":null,"edited_at":${AT}}');
  `);
  db.close();
  // The calendar as the core made it before: built, but never given the trail.
  openCalendar(join(dataDir, "calendar.sqlite")).close();
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-migrate-"));
  said.length = 0;
  await oldArchive();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("the move of friend map's archive", () => {
  it("leaves nothing to open the archive as it is: the core refuses it, and friend map's module is broken", async () => {
    expect(unmovedArchive(dataDir)).toMatch(/npm run archive -- migrate friend-map-module/);
    await expect(testingLifeArchive(dataDir, friendMapModule)).rejects.toThrow(/before friend map was a module/);
    expect(existsSync(join(dataDir, "core.sqlite"))).toBe(false);
  });

  it("says what it would do in a dry run, and changes nothing", async () => {
    const move = await migrateFriendMap(dataDir, { apply: false, ...quiet });
    expect(Object.fromEntries(move!.copied.map((c) => [c.table, c.rows]))).toMatchObject({
      source: 1, connector_state: 1, event: 1, llm_session: 1, inspiration: 1, inspiration_tag: 1, changeset: 1,
    });
    expect(move!.trail).toBe(1);
    expect(said.at(-1)).toMatch(/Nothing changed \(a dry run\)/);
    expect(existsSync(join(dataDir, "archive.sqlite"))).toBe(true);
    expect(existsSync(join(dataDir, "core.sqlite"))).toBe(false);
    expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite"))).toBe(false);
  });

  it("copies the core's tables out, moves the archive into its module's folder, and the archive opens after, every row in its place", async () => {
    await migrateFriendMap(dataDir, { apply: true, ...quiet });
    expect(said).toContainEqual(expect.stringMatching(/^Backed up to .*before-friend-map-module\.sqlite, integrity ok\.$/));
    expect(said).toContainEqual(expect.stringMatching(/every count checked\.$/));
    expect(existsSync(join(dataDir, "archive.sqlite"))).toBe(false);
    const moved = new DatabaseSync(join(dataDir, "modules", "friend-map", "archive.sqlite"), { readOnly: true });
    try {
      const tables = (moved.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      for (const gone of ["event", "llm_session", "llm_turn", "device", "inspiration", "content_read", "workout"]) expect(tables).not.toContain(gone);
      expect(moved.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 1 });
      expect(moved.prepare("SELECT connector FROM source").all()).toEqual([{ connector: "messenger-export" }]);
      expect(moved.prepare("SELECT count(*) AS n FROM changeset").get()).toEqual({ n: 0 });
    } finally {
      moved.close();
    }
    // A second run finds it done.
    expect(await migrateFriendMap(dataDir, { apply: true, ...quiet })).toBeNull();
    expect(said.at(-1)).toMatch(/at .*modules\/friend-map\/archive\.sqlite already: nothing to move\./);

    const archive = await openTestArchive(dataDir);
    try {
      expect(archive.events.summary()).toEqual([{ origin: "claude-code", kind: "llm_session", count: 1, firstDay: "2026-03-06", lastDay: "2026-03-06" }]);
      expect(coreInspiration(archive.coreDb)).toEqual({ caption: "a made-up caption", tags: "craft", changesets: "inspiration caption #1" });
      expect(archive.contentLog.list().map((read) => read.why)).toEqual(["a made-up reason"]);
      expect((await archive.host.statuses()).find((c) => c.id === "llm-sessions")?.lastOkAt).toBe(2);
      expect(archive.structure.listPeople().people.map((p) => p.name)).toEqual(["Ada Sample"]);
      expect(archive.calendar.drift()).toEqual([]);
      expect(archive.calendar.sink.rowsOf("core").map((row) => row.nativeId)).toEqual(["session-1"]);
    } finally {
      archive.close();
    }
    expect((await readdir(join(dataDir, "backups"))).some((name) => name.endsWith("before-friend-map-module.calendar.sqlite"))).toBe(true);
  });

  it("refuses while the server answers, and moves nothing", async () => {
    await expect(migrateFriendMap(dataDir, { apply: true, log: () => {}, serverRunning: async () => true })).rejects.toThrow(/stop it first/);
    expectUnmoved();
  });

  it("refuses while core.sqlite holds anything, and moves nothing", async () => {
    const core = openCore(join(dataDir, "core.sqlite"));
    core.prepare("INSERT INTO device (id, key, name, kind) VALUES (1, 'computer:made-up', 'made-up laptop', 'computer')").run();
    core.close();
    await expect(migrateFriendMap(dataDir, { apply: true, ...quiet })).rejects.toThrow(/holds 1 rows already: it is not the one this move makes/);
    expect(existsSync(join(dataDir, "archive.sqlite"))).toBe(true);
    expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite"))).toBe(false);
  });

  it("refuses an archive whose schema is not the one friend map had when it moved, and moves nothing", async () => {
    const db = new DatabaseSync(join(dataDir, "archive.sqlite"));
    db.exec(`PRAGMA user_version = ${MOVE_VERSION - 1}`);
    db.close();
    await expect(migrateFriendMap(dataDir, { apply: true, ...quiet })).rejects.toThrow(new RegExp(`schema version ${MOVE_VERSION - 1}, and the move takes one at ${MOVE_VERSION}`));
    expectUnmoved();
  });

  it("refuses while another process has the archive open, and a run after it closes moves it", async () => {
    let other: DatabaseSync | null = null;
    const opened = (step: number) => {
      if (step !== 4) return;
      other = new DatabaseSync(join(dataDir, "archive.sqlite"));
      other.exec("PRAGMA journal_mode = WAL");
      other.prepare("SELECT count(*) FROM message").get();
    };
    await expect(migrateFriendMap(dataDir, { apply: true, ...quiet, after: opened })).rejects.toThrow(/another process has/);
    expect(existsSync(join(dataDir, "archive.sqlite"))).toBe(true);
    expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite"))).toBe(false);
    expect(unmovedArchive(dataDir)).not.toBeNull();
    other!.close();
    await migrateFriendMap(dataDir, { apply: true, ...quiet });
    await expectMoved();
  });

  for (const step of [3, 4, 5, 6]) {
    it(`finishes, when run again, a move interrupted after step ${step}, and nothing opens the folder until then`, async () => {
      await expect(migrateFriendMap(dataDir, { apply: true, ...quiet, after: (done) => interruptAt(done, step) })).rejects.toThrow(/interrupted/);
      expect(unmovedArchive(dataDir)).toMatch(/npm run archive -- migrate friend-map-module/);
      expect(existsSync(join(dataDir, "core.sqlite"))).toBe(false);
      said.length = 0;
      // A dry run says what is left and changes nothing: from the root while the archive is there, the rest after.
      const dry = await migrateFriendMap(dataDir, { apply: false, ...quiet });
      if (step < 5) expect(dry).not.toBeNull();
      else expect(said.at(-1)).toMatch(/was interrupted .*it would be finished\. Nothing changed/);
      await migrateFriendMap(dataDir, { apply: true, ...quiet });
      expect(existsSync(join(dataDir, "core.sqlite.partial"))).toBe(false);
      await expectMoved();
    });
  }

  it("finishes a move the code before this one left with core.sqlite made and the moved archive still holding the core's tables", async () => {
    await expect(migrateFriendMap(dataDir, { apply: true, ...quiet, after: (done) => interruptAt(done, 5) })).rejects.toThrow(/interrupted/);
    // The code before this one built core.sqlite in place, so its crash after the rename left this.
    await rename(join(dataDir, "core.sqlite.partial"), join(dataDir, "core.sqlite"));
    // Nothing refuses to open it so (unmovedArchive does not see it): this code's migrations leave its tables, rows in
    // them, as they are, for the move to drop.
    const before = schemaOf(movedFile());
    openArchive(movedFile(), { dataDir }).close();
    expect(schemaOf(movedFile())).toEqual({ ...before, version: SCHEMA_VERSION });
    said.length = 0;
    await migrateFriendMap(dataDir, { apply: true, ...quiet });
    expect(said[0]).toMatch(/was interrupted \(friend map's archive still holds the core's tables\): finishing it\./);
    await expectMoved();
  });
});

describe("a new archive's schema", () => {
  /** The schema of a new archive, made by this code. */
  const fresh = () => {
    const file = join(dataDir, "fresh", "archive.sqlite");
    openArchive(file).close();
    return schemaOf(file);
  };

  it("is the moved archive's: friend map's tables alone, none of the core's or the other modules'", async () => {
    await migrateFriendMap(dataDir, { apply: true, ...quiet });
    // The moved archive, at the schema the move takes, opens to this code's with every table and row as they were.
    const moved = schemaOf(movedFile());
    expect(moved.version).toBe(MOVE_VERSION);
    const rows = rowCounts(movedFile());
    openArchive(movedFile(), { dataDir }).close();
    expect(schemaOf(movedFile())).toEqual({ ...moved, version: SCHEMA_VERSION });
    expect(rowCounts(movedFile())).toEqual(rows);

    expect(fresh()).toEqual(schemaOf(movedFile()));
    const tables = fresh().objects.filter((o) => o.type === "table").map((o) => o.name);
    for (const gone of ["event", "device", "llm_session", "llm_turn", "content_read", "inspiration", "inspiration_fetch", "workout", "deleted_workout", "ritual_day", "ritual_checkin"]) {
      expect(tables).not.toContain(gone);
    }
    expect(tables).toEqual(expect.arrayContaining(["person", "message", "source", "connector_state", "changeset", "change_row", "meta"]));
  });

  it("is what an archive the code before this one made new becomes, its empty tables of others' dropped", () => {
    const file = join(dataDir, "older", "archive.sqlite");
    openUnmovedArchive(file).close();
    expect(schemaOf(file).objects.map((o) => o.name)).toContain("event");
    openArchive(file).close();
    expect(schemaOf(file)).toEqual(fresh());
  });
});

/** Where the move puts friend map's archive. */
const movedFile = () => join(dataDir, "modules", "friend-map", "archive.sqlite");

/** The schema of the database at `file`: its version, and every table, index and trigger as SQLite keeps it. */
function schemaOf(file: string): { version: number; objects: Array<{ type: string; name: string; tbl_name: string; sql: string | null }> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: schemaVersion(db),
      objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name").all() as never,
    };
  } finally {
    db.close();
  }
}

/** How many rows each table of the database at `file` holds. */
function rowCounts(file: string): Record<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    return Object.fromEntries(tables.map((table) => [table, (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}

/** A move interrupted, as by a crash, once it has done step `step`. */
function interruptAt(done: number, step: number): void {
  if (done === step) throw new Error(`interrupted after step ${step}`);
}

/** The folder as the move found it: the archive at the root, and no core or friend map's archive made. */
function expectUnmoved(): void {
  expect(existsSync(join(dataDir, "archive.sqlite"))).toBe(true);
  expect(existsSync(join(dataDir, "core.sqlite"))).toBe(false);
  expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite"))).toBe(false);
}

/** The folder after the move: the archive opens, every row in its place once (the trail not copied twice), nothing of the core's left in friend map's. */
async function expectMoved(): Promise<void> {
  expect(existsSync(join(dataDir, "archive.sqlite"))).toBe(false);
  const moved = new DatabaseSync(join(dataDir, "modules", "friend-map", "archive.sqlite"), { readOnly: true });
  try {
    const tables = (moved.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const gone of ["event", "llm_session", "inspiration", "content_read"]) expect(tables).not.toContain(gone);
    expect(moved.prepare("SELECT count(*) AS n FROM changeset").get()).toEqual({ n: 0 });
  } finally {
    moved.close();
  }
  expect(await migrateFriendMap(dataDir, { apply: true, ...quiet })).toBeNull();
  const archive = await openTestArchive(dataDir);
  try {
    expect(archive.events.summary()).toEqual([{ origin: "claude-code", kind: "llm_session", count: 1, firstDay: "2026-03-06", lastDay: "2026-03-06" }]);
    expect(coreInspiration(archive.coreDb)).toEqual({ caption: "a made-up caption", tags: "craft", changesets: "inspiration caption #1" });
    expect(archive.contentLog.list().map((read) => read.why)).toEqual(["a made-up reason"]);
    expect(archive.structure.listPeople().people.map((p) => p.name)).toEqual(["Ada Sample"]);
  } finally {
    archive.close();
  }
}
