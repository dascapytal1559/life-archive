// friend map's migration 21 (db.ts): the copies of attachments named relative to the data folder.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openArchive } from "./db.ts";
import { ImportSession } from "./write.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-media-paths-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = { sha256: "0".repeat(64), size: 1 };

describe("migration 21", () => {
  it("names every copy there was relative to the data folder, and leaves missing files missing", () => {
    const path = join(dir, "archive.sqlite");
    // An archive from before the migration, its attachments written as the writer did then (relative to archive/media/).
    const older = openArchive(path, { version: 20 });
    const source = Number(older.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 't', 'export', 't', 0, 'ok')").run().lastInsertRowid);
    const session = new ImportSession(older, "messenger", source, "export");
    session.apply({ kind: "account", key: "A", keyKind: "name", displayName: "A" });
    session.apply({ kind: "conversation", id: "c", type: "direct", members: ["A"] });
    // The message goes in as SQL: today's writer writes columns version 20 does not have (call_seconds).
    older.prepare(
      `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, sender_account_id, is_from_self, sent_at, type, first_source_id, last_source_id, raw_json)
       SELECT 'messenger', c.id, 'm', 'synthetic', a.id, 0, 1, 'media', ?, ?, '{}' FROM conversation c, import_person a`,
    ).run(source, source);
    session.apply({ kind: "attachment", message: "m", ordinal: 0, type: "image", stored: { ...file, path: "messenger/ab/abc.jpg" } });
    session.apply({ kind: "attachment", message: "m", ordinal: 1, type: "image" });
    older.exec("UPDATE attachment SET local_path = 'messenger/ab/abc.jpg' WHERE local_path IS NOT NULL");
    older.close();
    const migrated = openArchive(path);
    expect(migrated.prepare("SELECT local_path FROM attachment ORDER BY ordinal").all().map((row) => ({ ...row })))
      .toEqual([{ local_path: "archive/media/messenger/ab/abc.jpg" }, { local_path: null }]);
    migrated.close();
  });
});
