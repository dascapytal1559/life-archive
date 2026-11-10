// Weekly review answers are gone (schema version 9): migration 9 drops them and their audit, nothing else changes.
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { TABLE_SQL } from "../src/applicability.ts";
import { sha } from "../src/encoding.ts";
import { migrate } from "../src/localClient.ts";
import { openStore, SCHEMA } from "../src/store.ts";
import {
  inspect,
  listFiles,
  tempDirectory,
  toVersion9Targets,
  untimed,
  WEEKLY_SQL,
  withDatabase,
  migratedRows,
} from "./helpers/fixtures.ts";

const SOURCE = "Fictional source, isolated test only";
const ZONE = {
  op: "target_add",
  record: { id: "fictional-zone", name: "Fictional zone", unit: "minutes", minimum: "5h", start_date: "2026-09-28" },
  request_id: "fictional-zone",
  source_text: SOURCE,
};
const ENTRY = {
  op: "target_log",
  record: { target_id: "fictional-zone", date: "2026-09-30", amount: "45m", logged_by: "fictional" },
  request_id: "fictional-zone-log",
  source_text: SOURCE,
};
const ANSWERS: ReadonlyArray<readonly [string, string]> = [
  ["2026-09-21", "Fictional quiet week"],
  ["2026-09-28", "Fictional shipped a prototype"],
];

/**
 * A version 8 store: version 9's schema (today's with the single minimum of version 8–9 targets) plus version 3's
 * weekly review table, with a target, an entry, a ritual and weekly answers each audited like a version 8 weekly_put.
 */
const version8Store = (dir: string) =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openStore(dir);
        yield* store.request(ZONE);
        yield* store.request(ENTRY);
        yield* store.request({
          op: "ritual_put",
          date: "2026-09-28",
          patch: { protein: true },
          events: untimed("protein"),
          request_id: "fictional-ritual",
          source_text: SOURCE,
        });
      }),
    );
    withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
      toVersion9Targets(db);
      db.exec(WEEKLY_SQL + "DELETE FROM schema_migrations WHERE version=9;");
      for (const [week, answer] of ANSWERS) {
        db.prepare("INSERT INTO weekly_reviews VALUES(?,?)").run(week, answer);
        db.prepare(
          "INSERT INTO changes(request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          `fictional-weekly:${week}`,
          "fixture-hash",
          "2026-10-04T10:00:00Z",
          "weekly_put",
          "weekly_reviews",
          week,
          null,
          JSON.stringify({ week_start: week, answer }),
          SOURCE,
          null,
          "{}",
        );
      }
    });
    fs.rmSync(path.join(dir, "backups"), { recursive: true, force: true });
  });

const weeklyAudit = (file: string): number =>
  inspect(file, (db) => (db.prepare("SELECT COUNT(*) AS c FROM changes WHERE entity='weekly_reviews'").get() as any).c);

layer(NodeServices.layer, { excludeTestServices: true })("weekly review removal", (it) => {
  it.effect("a new store has no weekly review table or requests", () =>
    Effect.gen(function* () {
      const tmp = yield* tempDirectory;
      const store = yield* openStore(tmp);
      const status = (yield* store.request({ op: "status" })) as any;
      expect([status.schema_version, status.migration_required]).toEqual([12, false]);
      expect(Object.keys(status.counts)).not.toContain("weekly_reviews");
      expect(
        inspect(path.join(tmp, "ritual.sqlite3"), (db) =>
          db.prepare("SELECT name FROM sqlite_schema WHERE name='weekly_reviews'").all(),
        ),
      ).toEqual([]);
      for (const request of [
        { op: "weekly_reviews", from: "2026-09-01", to: "2026-10-31" },
        { op: "weekly_put", week_start: "2026-09-28", answer: "x", request_id: "fictional-gone", source_text: SOURCE },
        { op: "history", entity: "weekly_reviews", id: "2026-09-28" },
      ])
        expect((yield* store.request(request).pipe(Effect.flip))._tag).toBe("RequiresReview");
    }),
  );

  it.effect("migration 9 is explicit, backed up, and removes only the answers and their audit", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      yield* version8Store(dir);
      const store = yield* openStore(dir);
      expect([store.schemaVersion(), store.migrationRequired()]).toEqual([8, true]);
      expect((yield* store.request(ZONE).pipe(Effect.flip)).message).toMatch(/--migrate/);
      const before = (yield* store.request({ op: "export" })) as any;
      expect(before.tables.weekly_reviews).toHaveLength(2);
      const result = yield* store.migrate;
      expect([result.migrated, result.from_version, result.schema_version]).toEqual([true, 8, 12]);
      // The backup is the whole store before the change: answers and their audit included.
      expect(sha(fs.readFileSync(result.backup!))).toBe(result.backup_sha256);
      expect(
        inspect(result.backup!, (db) => db.prepare("SELECT week_start,answer FROM weekly_reviews ORDER BY 1").all()),
      ).toEqual(ANSWERS.map(([week_start, answer]) => ({ week_start, answer })));
      expect(weeklyAudit(result.backup!)).toBe(2);
      expect(weeklyAudit(path.join(dir, "ritual.sqlite3"))).toBe(0);
      const after = (yield* store.request({ op: "export" })) as any;
      expect(Object.keys(after.tables)).not.toContain("weekly_reviews");
      for (const table of Object.keys(after.tables)) {
        if (table === "changes")
          expect(after.tables.changes).toEqual(before.tables.changes.filter((c: any) => c.entity !== "weekly_reviews"));
        // Migration 10 dates the target's minimum from its first week; nothing else about it changes.
        else if (table === "weekly_targets")
          expect(after.tables[table]).toEqual(
            before.tables[table].map(({ minimum, ...t }: any) => ({
              ...t,
              minimums: [{ week_start: "2026-09-28", minimum }],
            })),
          );
        else expect(after.tables[table]).toEqual(migratedRows(table, before.tables[table]));
      }
      expect(((yield* store.request(ZONE)) as any).replayed).toBe(true);
      expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 12 });
      expect(listFiles(path.join(dir, "backups"), ".sqlite3")).toHaveLength(1);
    }),
  );

  it.effect("a version 2 store migrates to 9 without a weekly table and keeps its notes as written", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
        db.exec(SCHEMA + TABLE_SQL);
        db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old')");
        db.prepare("INSERT INTO rituals(date,protein,notes) VALUES(?,1,?)").run(
          "2026-09-27",
          "Fictional topic\nWeekly: Fictional line",
        );
      });
      const store = yield* openStore(dir);
      const result = yield* store.migrate;
      expect([result.from_version, result.schema_version]).toEqual([2, 12]);
      expect((yield* store.get("rituals", "2026-09-27"))!.notes).toBe("Fictional topic\nWeekly: Fictional line");
      expect(Object.keys(yield* store.counts)).not.toContain("weekly_reviews");
    }),
  );

  it.effect("frozen old copy reads but never migrates", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      yield* version8Store(dir);
      fs.writeFileSync(path.join(dir, "FROZEN_BACKUP.json"), "{}");
      const store = yield* openStore(dir);
      expect(((yield* store.request({ op: "rituals", from: "2026-09-01", to: "2026-09-30" })) as any).count).toBe(1);
      expect((yield* store.migrate.pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect(weeklyAudit(path.join(dir, "ritual.sqlite3"))).toBe(2);
    }),
  );

  it.effect("CLI migrate refreshes the weekly targets snapshot and never creates a store", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      expect((yield* migrate(root).pipe(Effect.flip))._tag).toBe("StorageUnavailable");
      expect(fs.existsSync(path.join(root, "data", "ritual.sqlite3"))).toBe(false);
      yield* version8Store(path.join(root, "data"));
      const result = (yield* migrate(root)) as any;
      expect(result.migrated && result.dashboard.updated).toBe(true);
      expect(path.basename(result.dashboard.weekly_path)).toBe("weekly-targets.html");
      const page = fs.readFileSync(result.dashboard.weekly_path, "utf8");
      expect(page).toContain("<title>Weekly targets</title>");
      expect(page).toContain("Fictional zone");
      for (const [, answer] of ANSWERS) expect(page).not.toContain(answer);
      expect(((yield* migrate(root)) as any).migrated).toBe(false);
    }),
  );

  it.effect("restoring a version 8 snapshot leaves out the answers and their audit", () =>
    Effect.gen(function* () {
      const old = yield* tempDirectory;
      yield* version8Store(old);
      const snapshot = (yield* Effect.scoped(
        Effect.flatMap(openStore(old), (source) => source.request({ op: "export" })),
      )) as any;
      expect(snapshot.schema_version).toBe(8);
      const dir = yield* tempDirectory;
      const target = yield* openStore(dir);
      const restored = (yield* target.request({ op: "restore", snapshot })) as any;
      expect(restored.source_data_sha256).toBe(snapshot.data_sha256);
      expect(Object.keys(restored.counts)).not.toContain("weekly_reviews");
      expect(restored.counts.weekly_target_entries).toBe(1);
      expect(weeklyAudit(path.join(dir, "ritual.sqlite3"))).toBe(0);
      expect(restored.counts.changes).toBe(
        snapshot.tables.changes.filter((c: any) => c.entity !== "weekly_reviews").length,
      );
    }),
  );
});
