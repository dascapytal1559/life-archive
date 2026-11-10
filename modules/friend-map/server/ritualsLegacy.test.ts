// What the archive still holds of rituals' from before the rituals module (legacy.ts), on a made-up archive: counted,
// refused while the module has no store in the archive's folder to read in their place, and dropped whole, with
// their detail rows and the connector's runs, once it has.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transaction, type Db } from "../../../sdk/server.ts";
import { openUnmovedArchive } from "../testing/unmoved.ts";
import { dropRitualsLegacy, RITUAL_KINDS, ritualsLegacy, ritualsStoreFile, ritualsUnheld } from "../../../sdk/testing.ts";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-rituals-legacy-"));
  db = openUnmovedArchive(join(dir, "archive.sqlite"), { dataDir: dir });
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** The rows the rituals connector left: a run, its state, and one event of each kind with its detail row. */
function leaveRitualsRows(): void {
  transaction(db, () => {
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('rituals', 'rituals', 'app-db', 'made up', 0, 'ok')").run().lastInsertRowid);
    db.prepare("INSERT INTO connector_state (connector, status) VALUES ('rituals', 'idle')").run();
    const details: Record<(typeof RITUAL_KINDS)[number], string> = {
      ritual_checkin: "INSERT INTO ritual_checkin (date) VALUES ('2026-03-06')",
      ritual_habit: "INSERT INTO ritual_habit (date, habit) VALUES ('2026-03-06', 'magnesium')",
      ritual_day: `INSERT INTO ritual_day (date, cells) VALUES ('2026-03-06', '{"magnesium":{"status":"done"}}')`,
      ritual_workouts: "INSERT INTO ritual_workouts (date, workouts, file) VALUES ('2026-03-06', '[]', 'platform-exports/rituals/workouts/2026-03-06.json')",
    };
    for (const kind of RITUAL_KINDS) {
      const detail = Number(db.prepare(details[kind]).run().lastInsertRowid);
      db.prepare(
        "INSERT INTO event (origin, native_id, kind, at, at_end, day, self, direction, detail, detail_id, size, has_content, first_source_id, last_source_id) VALUES ('rituals', ?, ?, 0, NULL, '2026-03-06', 1, NULL, ?, ?, NULL, 0, ?, ?)",
      ).run(`${kind}/2026-03-06`, kind, kind, detail, source, source);
    }
  });
}

describe("the archive's rows of rituals' from before the module", () => {
  it("are counted, and the drop refused until the module's store is in the archive's folder", async () => {
    expect(ritualsLegacy(db)).toEqual({ events: 0, sources: 0, states: 0 });
    leaveRitualsRows();
    expect(ritualsLegacy(db)).toEqual({ events: 4, sources: 1, states: 1 });
    expect(ritualsUnheld(dir)).toBe(`there is no ${ritualsStoreFile(dir)}: move rituals' store into the archive's folder first (modules/rituals/README.md)`);
    await mkdir(join(dir, "modules", "rituals", "data"), { recursive: true });
    await writeFile(ritualsStoreFile(dir), "");
    expect(ritualsUnheld(dir)).toBeNull();
  });

  it("are dropped whole with their detail rows and the connector's runs, and nothing else", () => {
    const others = (db.prepare("SELECT count(*) AS n FROM source WHERE connector <> 'rituals'").get() as { n: number }).n;
    dropRitualsLegacy(db);
    expect(ritualsLegacy(db)).toEqual({ events: 0, sources: 0, states: 0 });
    for (const kind of RITUAL_KINDS) expect((db.prepare(`SELECT count(*) AS n FROM ${kind}`).get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM source WHERE connector <> 'rituals'").get() as { n: number }).n).toBe(others);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
