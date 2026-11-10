import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_FILE, CORE_SCHEMA_VERSION, openCore } from "./coreDb.ts";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-archive-core-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("the core's migrations", () => {
  it("take the task a launch brief's text named out of its turn's facts, and leave every other fact", () => {
    const file = join(folder, CORE_FILE);
    openCore(file).close();
    // A core the version before, holding what that code kept.
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO llm_session (id, project, file) VALUES (1, '/home/sample', '/x/s.jsonl')").run();
    const turn = raw.prepare("INSERT INTO llm_turn (id, session_id, role, line, byte_offset, byte_length, facts) VALUES (?, 1, 'prompt', 1, 0, 1, ?)");
    turn.run(1, JSON.stringify({ source: "sdk", marker: "launch-brief", task: "garden-frost" }));
    turn.run(2, JSON.stringify({ source: "typed" }));
    turn.run(3, null);
    // The version before it, and before the record's action, which came after.
    raw.exec("ALTER TABLE table_edit DROP COLUMN action");
    raw.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION - 2}`);
    raw.close();

    const db = openCore(file);
    const facts = db.prepare("SELECT id, facts FROM llm_turn ORDER BY id").all().map((row) => ({ ...row }));
    db.close();
    expect(facts).toEqual([
      { id: 1, facts: JSON.stringify({ source: "sdk", marker: "launch-brief" }) },
      { id: 2, facts: JSON.stringify({ source: "typed" }) },
      { id: 3, facts: null },
    ]);
  });

  it("read every edit the record kept before rows could be added and deleted as an edit of a field", () => {
    const file = join(folder, CORE_FILE);
    openCore(file).close();
    // A core the version before, with an edit in its record.
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE table_edit DROP COLUMN action");
    raw.prepare(`INSERT INTO table_edit (id, at, surface, kind, module, origin, native_id, row_kind, field, before_json, after_json, receipt)
      VALUES (1, 0, 'app', 'hangouts', 'friend-map', 'friend-map', '7', 'hangout', 'hours', '2', '3', '{}')`).run();
    raw.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION - 1}`);
    raw.close();

    const db = openCore(file);
    expect({ ...db.prepare("SELECT id, action, field FROM table_edit").get() }).toEqual({ id: 1, action: "edit", field: "hours" });
    expect(() => db.prepare("UPDATE table_edit SET action = 'move' WHERE id = 1").run()).toThrow(/CHECK/);
    db.close();
  });
});
