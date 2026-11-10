// Made-up temporary checks only; no real configuration, health reports or schedule delivery.
import { expect, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { TABLE_SQL } from "../src/applicability.ts";
import { checkId } from "../src/attachments.ts";
import { call, enqueue, replay } from "../src/localClient.ts";
import { addDays } from "../src/instants.ts";
import { openStore, SCHEMA } from "../src/store.ts";
import {
  BEFORE_CHECK_TIMES_SQL,
  inspect,
  messageOf,
  tempDirectory,
  untimed,
  WEEKLY_SQL,
  withDatabase,
  migratedRows,
} from "./helpers/fixtures.ts";

const item = (id = "fictional-check", role = "required_check", ritual = "evening") => ({
  op: "attachment_add",
  record: { id, ritual, text: "Fictional temporary check", start_date: "2026-10-03", end_date: "2026-10-09", role },
  request_id: `${id}:setup`,
  source_text: "Fictional configured scope, not a completion report",
});
const check = (
  done: unknown = true,
  day = "2026-10-09",
  id = "fictional-check",
  requestId = `${id}:${day}:report`,
) => ({
  op: "attachment_check",
  attachment_id: id,
  date: day,
  done,
  ...(done === true ? { done_at: null, basis: "unknown" } : {}),
  request_id: requestId,
  source_text: "Fictional explicit answer; receipt distinct from logical date and actual occurrence",
});
const morningItem = {
  op: "attachment_add",
  record: {
    id: "fictional-review",
    ritual: "morning",
    text: "Fictional morning review",
    start_date: "2026-10-03",
    end_date: null,
    role: "required_check",
  },
  request_id: "fictional-review:setup",
  source_text: "Fictional daily scope, not a completion report",
};
/** A tick of the morning review, which needs a stated time or an explicit unknown; `time` is what the request carries. */
const reviewed = (day: string, requestId: string, time: Record<string, unknown>, sourceText = "Fictional report") => ({
  op: "attachment_check",
  attachment_id: "fictional-review",
  date: day,
  done: true,
  ...time,
  request_id: requestId,
  source_text: sourceText,
});
const core = (
  day = "2026-10-09",
  patch = { magnesium: true, protein: true, stretching: true, journalling: true, plank_seconds: 62 },
) => ({
  op: "ritual_put",
  date: day,
  patch,
  events: untimed(...["magnesium", "protein", "stretching", "journalling"].filter((h) => (patch as any)[h] === true)),
  request_id: `fictional-core:${day}`,
  source_text: "Fictional core only; no check-in",
});
const checklist = (day = "2026-10-09", ritual = "evening", asOf = "2026-10-09T16:00:00Z") => ({
  op: "ritual_checklist",
  date: day,
  ritual,
  as_of: asOf,
});

layer(NodeServices.layer, { excludeTestServices: true })("ritual attachments", (it) => {
  it.effect("required check makes full completion distinct from completed core and unchanged percentages", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(core());
      const request = { op: "ritual_status", from: "2026-10-09", to: "2026-10-09", as_of: "2026-10-10T02:00:00Z" };
      const before = (yield* store.request(request)) as any;
      yield* store.request(item());
      const partial = (yield* store.request(checklist())) as any;
      expect(partial.full_completion).toMatchObject({
        core_complete: true,
        required_checks_complete: false,
        complete: false,
        remaining_attached: ["fictional-check"],
      });
      expect(partial.attachments[0]).toMatchObject({
        done: null,
        status: "unreported",
        requires_response: true,
        revision: 0,
      });
      yield* store.request(check());
      const after = (yield* store.request(request)) as any;
      expect(after.records[0].full_completion.complete).toBe(true);
      expect(after.completion).toEqual(before.completion);
      expect(after.by_habit).toEqual(before.by_habit);
      expect(((yield* store.request(checklist())) as any).checkins).toEqual([]);
    }),
  );

  it.effect("checks cannot complete a ritual while a core item remains unknown", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request({ ...core(), patch: { protein: true }, events: untimed("protein") });
      yield* store.request(item());
      yield* store.request(check());
      const view = (yield* store.request(checklist())) as any;
      expect(view.full_completion.required_checks_complete).toBe(true);
      expect(view.full_completion.complete).toBe(false);
      expect(view.full_completion.remaining_core).toContain("journalling");
    }),
  );

  it.effect("inclusive logical dates survive wall-clock expiry and never invent past answers", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(item());
      for (const [day, count] of [
        ["2026-10-02", 0],
        ["2026-10-03", 1],
        ["2026-10-09", 1],
        ["2026-10-10", 0],
      ] as const) {
        const view = (yield* store.request(checklist(day, "evening", "2026-10-11T03:00:00Z"))) as any;
        expect(view.attachments).toHaveLength(count);
        if (count) expect(view.attachments[0].status).toBe("unreported");
      }
      yield* store.request(check()); // a late historical answer is allowed for an applicable logical date
      expect(
        ((yield* store.request(checklist("2026-10-09", "evening", "2026-11-01T02:00:00Z"))) as any).attachments[0].done,
      ).toBe(true);
      expect(
        ((yield* store.request(checklist("2026-10-08", "evening", "2026-11-01T02:00:00Z"))) as any).attachments[0].done,
      ).toBeNull();
      expect(((yield* store.request({ op: "rituals", from: "2026-10-01", to: "2026-10-11" })) as any).records).toEqual(
        [],
      );
    }),
  );

  it.effect("reminder-only item is included without a tick or response requirement", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(core());
      yield* store.request(item("fictional-note", "reminder_only"));
      const view = (yield* store.request(checklist())) as any;
      expect(view.full_completion.complete).toBe(true);
      expect(view.attachments[0]).toMatchObject({
        role: "reminder_only",
        requires_response: false,
        check_id: null,
        status: "reminder_only",
      });
      expect((yield* store.request(check(true, "2026-10-09", "fictional-note")).pipe(Effect.flip)).message).toMatch(
        /no tick/,
      );
    }),
  );

  it.effect("ritual identity isolates attachments, with ongoing and DST date boundaries", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(item("fictional-morning", "required_check", "morning"));
      const ongoing = item("fictional-ongoing");
      yield* store.request({ ...ongoing, record: { ...ongoing.record, end_date: null } });
      const evening = (yield* store.request(checklist("2026-10-10"))) as any;
      expect(evening.attachments.map((a: any) => a.id)).toEqual(["fictional-ongoing"]);
      const morning = (yield* store.request(checklist("2026-10-05", "morning", "2026-10-04T16:00:00Z"))) as any;
      expect(morning.attachments.map((a: any) => a.id)).toEqual(["fictional-morning"]);
      expect(morning.habits).toEqual({});
      expect(morning.checkins).toEqual([]);
      expect(morning.full_completion.complete).toBe(false);
      expect(((yield* store.request(checklist("2026-10-03"))) as any).closes_at).toBe("2026-10-04T06:00:00+11:00");
    }),
  );

  it.effect("idempotency, nullable answers and guarded corrections retain exact source history", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(item());
      const first = (yield* store.request(check())) as any;
      expect(((yield* store.request(check())) as any).replayed).toBe(true);
      expect((yield* store.request({ ...check(), done: false }).pipe(Effect.flip)).message).toMatch(
        /different content/,
      );
      expect(
        (yield* store
          .request(check(false, "2026-10-09", "fictional-check", "fresh-but-not-correction"))
          .pipe(Effect.flip)).message,
      ).toMatch(/correct/);
      const correction = {
        op: "correct",
        entity: "ritual_attachment_checks",
        id: first.record.id,
        patch: { done: false },
        expected_revision: first.revision,
        reason: "Fictional corrected answer",
        request_id: "fictional-fix",
        source_text: "Exact fictional correction",
      };
      const fixed = (yield* store.request(correction)) as any;
      expect(fixed.record.done).toBe(false);
      expect((yield* store.request({ ...correction, request_id: "stale-fix" }).pipe(Effect.flip)).message).toMatch(
        /Revision conflict/,
      );
      yield* store.request({
        ...correction,
        patch: { done: null },
        expected_revision: fixed.revision,
        request_id: "fictional-unknown",
      });
      const history = (yield* store.request({
        op: "history",
        entity: "ritual_attachment_checks",
        id: checkId("fictional-check", "2026-10-09"),
      })) as any[];
      expect(history).toHaveLength(3);
      expect(history[0].source_text).toBe(check().source_text);
      expect(((yield* store.request(checklist())) as any).attachments[0].done).toBeNull();
    }),
  );

  it.effect("rejects unknown definitions, out-of-range dates, invalid role/date/value and scope rewrite", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      expect((yield* store.request(check()).pipe(Effect.flip)).message).toMatch(/does not apply/);
      const added = (yield* store.request(item())) as any;
      for (const day of ["2026-10-02", "2026-10-10"])
        expect((yield* store.request(check(true, day)).pipe(Effect.flip)).message).toMatch(/does not apply/);
      expect((yield* store.request(check("yes")).pipe(Effect.flip)).message).toMatch(/true, false, or null/);
      const badRole = item("fictional-bad");
      expect(
        (yield* store.request({ ...badRole, record: { ...badRole.record, role: "made-up" } }).pipe(Effect.flip))
          .message,
      ).toMatch(/role/);
      expect(
        (yield* store.request({ ...badRole, record: { ...badRole.record, end_date: "2026-10-01" } }).pipe(Effect.flip))
          .message,
      ).toMatch(/date range/);
      expect(
        (yield* store
          .request({
            op: "correct",
            entity: "ritual_attachments",
            id: "fictional-check",
            patch: { end_date: "2026-10-05" },
            expected_revision: added.revision,
            reason: "Fictional change",
            request_id: "fictional-scope-rewrite",
            source_text: "Fictional",
          })
          .pipe(Effect.flip)).message,
      ).toMatch(/historical scope/);
    }),
  );

  it.effect("offline replay uses the same writes, preserves reports and stops on conflicts", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      yield* enqueue(item(), root);
      yield* enqueue(check(), root);
      expect(((yield* replay(root)) as any).remaining).toBe(0);
      yield* enqueue(check(), root);
      expect(((yield* replay(root)) as any).synced[0].replayed).toBe(true);
      yield* enqueue({ ...check(), done: false, request_id: "fictional-conflict" }, root);
      yield* enqueue(check(true, "2026-10-08"), root);
      const conflict = (yield* replay(root)) as any;
      expect(conflict.remaining).toBe(2);
      expect(((yield* call(checklist(), root)) as any).attachments[0].done).toBe(true);
      expect(((yield* call(checklist("2026-10-08"), root)) as any).attachments[0].done).toBeNull();
    }),
  );

  it.effect("export roundtrip retains config, exact answers, source history and revision", () =>
    Effect.gen(function* () {
      const first = yield* openStore(yield* tempDirectory);
      yield* first.request(item());
      yield* first.request(check());
      const snapshot = (yield* first.request({ op: "export" })) as any;
      expect(snapshot.schema_version).toBe(12);
      const restored = yield* openStore(yield* tempDirectory);
      yield* restored.request({ op: "restore", snapshot });
      expect(((yield* restored.request({ op: "export" })) as any).data_sha256).toBe(snapshot.data_sha256);
      expect(((yield* restored.request(checklist())) as any).attachments).toEqual(
        ((yield* first.request(checklist())) as any).attachments,
      );
      expect(((yield* restored.request(check())) as any).replayed).toBe(true);
    }),
  );

  it.effect("future-only expiry edits preserve recorded checks and do not erase historical scope", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      const configured = item("fictional-ongoing");
      const first = (yield* store.request({ ...configured, record: { ...configured.record, end_date: null } })) as any;
      const today = ((yield* store.request({ op: "ritual_checklist", date: "2026-10-09", ritual: "evening" })) as any)
        .active_date;
      const futureEnd = addDays(today, 10);
      const futureReport = addDays(today, 20);
      yield* store.request(check(true, futureReport, "fictional-ongoing"));
      const correction = {
        op: "correct",
        entity: "ritual_attachments",
        id: "fictional-ongoing",
        patch: { end_date: futureEnd },
        expected_revision: first.revision,
        reason: "Fictional future expiry",
        request_id: "fictional-future-end",
        source_text: "Fictional explicitly chosen future expiry",
      };
      expect((yield* store.request(correction).pipe(Effect.flip)).message).toMatch(/exclude a recorded check/);
      expect(
        (yield* store
          .request({ ...correction, patch: { end_date: addDays(today, -1) }, request_id: "fictional-past-end" })
          .pipe(Effect.flip)).message,
      ).toMatch(/historical scope/);
      const extended = (yield* store.request({
        ...correction,
        patch: { end_date: addDays(today, 30) },
        request_id: "fictional-valid-end",
      })) as any;
      expect(extended.record.end_date).toBe(addDays(today, 30));
      expect(((yield* store.request(checklist(futureReport))) as any).attachments[0].done).toBe(true);
    }),
  );

  it.effect("attachments are exported privately and remain absent from permanent dashboard content", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      yield* call(core(), root);
      yield* call(item(), root);
      const html = fs.readFileSync(path.join(root, "data/views/ritual-dashboard.html"), "utf8");
      expect(html).not.toContain("Fictional temporary check");
      expect(((yield* call({ op: "export" }, root)) as any).tables.ritual_attachments[0].text).toBe(
        "Fictional temporary check",
      );
    }),
  );

  it.effect("a frozen version 3 backup is read-only and has no invented attachments", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
        db.exec(SCHEMA + TABLE_SQL + WEEKLY_SQL);
        db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old')");
      });
      fs.writeFileSync(path.join(dir, "FROZEN_BACKUP.json"), "{}");
      const store = yield* openStore(dir);
      expect(((yield* store.request(checklist())) as any).attachments).toEqual([]);
      expect((yield* store.request(item()).pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect((yield* store.migrate.pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect(store.schemaVersion()).toBe(3);
    }),
  );

  it.effect("version 3 migration is explicit, backed up and preserves all original tables", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
        db.exec(SCHEMA + TABLE_SQL + WEEKLY_SQL);
        db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old')");
        db.exec("INSERT INTO rituals(date,protein) VALUES('2026-10-09',1)");
      });
      const store = yield* openStore(dir);
      const before = (yield* store.request({ op: "export" })) as any;
      expect((yield* store.request(checklist()).pipe(Effect.flip)).message).toMatch(/--migrate/);
      const result = yield* store.migrate;
      expect([result.from_version, result.schema_version]).toEqual([3, 12]);
      expect(
        inspect(result.backup!, (db) => (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v),
      ).toBe(3);
      const after = (yield* store.request({ op: "export" })) as any;
      // Migration 9 removes the weekly review answers; every other table is unchanged.
      for (const name of Object.keys(before.tables).filter((t) => t !== "weekly_reviews"))
        expect(after.tables[name]).toEqual(migratedRows(name, before.tables[name]));
      expect(after.tables.weekly_reviews).toBeUndefined();
      expect(after.tables.ritual_attachment_checks).toEqual([]);
      expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 12 });
      expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(1);
    }),
  );

  it.effect("a morning check ticks with its time, by a habit's rules, and stays out of the evening", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(morningItem);
      const refusal = (request: unknown) => store.request(request).pipe(Effect.flip, Effect.map(messageOf));
      expect(yield* refusal(reviewed("2026-10-09", "no-time", {}))).toMatch(/Ticking fictional-review needs its time/);
      expect(
        yield* refusal(reviewed("2026-10-09", "early", { done_at: "2026-10-09T05:30:00+11:00", basis: "user_stated" })),
      ).toMatch(/outside ritual date/);
      expect(
        yield* refusal(
          reviewed("2026-10-09", "receipt", { done_at: "2026-10-09T07:30:00+11:00", basis: "message_received" }),
        ),
      ).toMatch(/Received at/);
      expect(yield* refusal(reviewed("2026-10-09", "no-basis", { done_at: "2026-10-09T07:30:00+11:00" }))).toMatch(
        /needs its basis/,
      );
      expect(
        yield* refusal({
          ...reviewed("2026-10-09", "not-done", { done_at: "2026-10-09T07:30:00+11:00", basis: "user_stated" }),
          done: false,
        }),
      ).toMatch(/Only a done check has a time/);

      const stated = reviewed("2026-10-09", "stated", { done_at: "2026-10-09T07:30:00+11:00", basis: "user_stated" });
      const first = (yield* store.request(stated)) as any;
      expect([first.record.done_at, first.record.basis]).toEqual(["2026-10-08T20:30:00Z", "user_stated"]);
      expect(((yield* store.request(stated)) as any).replayed).toBe(true);
      const morning = (yield* store.request(checklist("2026-10-09", "morning"))) as any;
      expect(morning.attachments[0]).toMatchObject({
        status: "done",
        done_at: "2026-10-08T20:30:00Z",
        basis: "user_stated",
      });
      expect(morning.full_completion.complete).toBe(true);
      const evening = (yield* store.request(checklist("2026-10-09"))) as any;
      expect(evening.attachments).toEqual([]);
      expect(evening.habits).not.toHaveProperty("fictional-review");

      // Saying it again keeps the time; a different time is a correction.
      const again = (yield* store.request(reviewed("2026-10-09", "again", {}))) as any;
      expect(again.record.done_at).toBe("2026-10-08T20:30:00Z");
      expect(
        yield* refusal(reviewed("2026-10-09", "moved", { done_at: "2026-10-09T08:00:00+11:00", basis: "user_stated" })),
      ).toMatch(/correct/);

      const unknown = (yield* store.request(
        reviewed("2026-10-10", "unknown", { done_at: null, basis: "unknown" }),
      )) as any;
      const told = (yield* store.request({
        op: "correct",
        entity: "ritual_attachment_checks",
        id: unknown.record.id,
        patch: { done_at: "2026-10-10T08:15:00+11:00", basis: "user_stated" },
        expected_revision: unknown.revision,
        reason: "Fictional later statement of the time",
        request_id: "told",
        source_text: "Fictional later words",
      })) as any;
      expect([told.record.done, told.record.done_at]).toEqual([true, "2026-10-09T21:15:00Z"]);
      const taken = (yield* store.request({
        op: "correct",
        entity: "ritual_attachment_checks",
        id: told.record.id,
        patch: { done: false },
        expected_revision: told.revision,
        reason: "Fictional retraction",
        request_id: "taken",
        source_text: "Fictional retraction words",
      })) as any;
      expect([taken.record.done, taken.record.done_at, taken.record.basis]).toEqual([false, null, null]);
      const retick = {
        op: "correct",
        entity: "ritual_attachment_checks",
        id: told.record.id,
        expected_revision: taken.revision,
        reason: "Fictional second thoughts",
        source_text: "Fictional words",
      };
      expect(yield* refusal({ ...retick, patch: { done: true }, request_id: "retick-bare" })).toMatch(/needs its time/);
      expect(
        yield* refusal({
          ...retick,
          patch: { done_at: "2026-10-10T08:15:00+11:00", basis: "user_stated" },
          request_id: "time-on-not-done",
        }),
      ).toMatch(/Only a done check has a time/);
      const history = (yield* store.request({
        op: "history",
        entity: "ritual_attachment_checks",
        id: told.record.id,
      })) as any[];
      expect(JSON.parse(history.at(-1).before_json).done_at).toBe("2026-10-09T21:15:00Z");
    }),
  );

  it.effect("attachment_days lists every item's mark on each date it applied, for one ritual or all", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(morningItem);
      yield* store.request(item());
      yield* store.request(item("fictional-note", "reminder_only", "noon"));
      yield* store.request(
        reviewed("2026-10-09", "day-9", { done_at: "2026-10-09T07:30:00+11:00", basis: "user_stated" }),
      );
      yield* store.request(check(false, "2026-10-09"));
      const days = (yield* store.request({ op: "attachment_days", from: "2026-10-09", to: "2026-10-10" })) as any;
      const brief = days.records.map((r: any) => [r.date, r.ritual, r.id, r.status, r.done_at]);
      // The evening item ended on the 9th and has a false answer; the morning one runs on, unreported on the 10th.
      expect(brief).toEqual([
        ["2026-10-09", "evening", "fictional-check", "not_done", null],
        ["2026-10-09", "morning", "fictional-review", "done", "2026-10-08T20:30:00Z"],
        ["2026-10-09", "noon", "fictional-note", "reminder_only", null],
        ["2026-10-10", "morning", "fictional-review", "unreported", null],
      ]);
      expect(days.count).toBe(4);
      expect(days.records[1]).toMatchObject({
        check_id: checkId("fictional-review", "2026-10-09"),
        text: "Fictional morning review",
        basis: "user_stated",
      });
      expect(days.records[1].revision).toBeGreaterThan(0);
      const one = (yield* store.request({
        op: "attachment_days",
        ritual: "morning",
        from: "2026-10-03",
        to: "2026-10-04",
      })) as any;
      expect(one.records.map((r: any) => [r.date, r.status])).toEqual([
        ["2026-10-03", "unreported"],
        ["2026-10-04", "unreported"],
      ]);
      expect(messageOf(yield* store.request({ op: "attachment_days" }).pipe(Effect.flip))).toMatch(/calendar date/);
    }),
  );

  it.effect("version 10 migrates: every check and audit row kept, an old tick's time unknown until told", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      const answered = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          yield* store.request(item());
          return (yield* store.request(check())) as any;
        }),
      );
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) => db.exec(BEFORE_CHECK_TIMES_SQL));
      const store = yield* openStore(dir);
      expect([store.schemaVersion(), store.migrationRequired()]).toEqual([10, true]);
      const before = (yield* store.request({ op: "export" })) as any;
      const result = yield* store.migrate;
      expect([result.from_version, result.schema_version]).toEqual([10, 12]);
      const after = (yield* store.request({ op: "export" })) as any;
      for (const name of Object.keys(before.tables).filter((t) => t !== "ritual_attachment_checks"))
        expect(after.tables[name]).toEqual(migratedRows(name, before.tables[name]));
      expect(after.tables.ritual_attachment_checks).toEqual(
        before.tables.ritual_attachment_checks.map((row: any) => ({ ...row, done_at: null, basis: null })),
      );
      const view = ((yield* store.request(checklist())) as any).attachments[0];
      expect([view.done, view.done_at, view.basis]).toEqual([true, null, "unknown"]);
      // An old tick restated needs no time, and a retry of its original request replays.
      expect(((yield* store.request(check())) as any).replayed).toBe(true);
      const told = (yield* store.request({
        op: "correct",
        entity: "ritual_attachment_checks",
        id: answered.record.id,
        patch: { done_at: "2026-10-09T21:00:00+11:00", basis: "user_stated" },
        expected_revision: answered.revision,
        reason: "Fictional later statement of the time",
        request_id: "told-later",
        source_text: "Fictional later words",
      })) as any;
      expect(told.record.done_at).toBe("2026-10-09T10:00:00Z");
      // A version 10 export restores with no times either.
      const restored = yield* openStore(yield* tempDirectory);
      yield* restored.request({ op: "restore", snapshot: before });
      const roundtrip = ((yield* restored.request({ op: "export" })) as any).tables.ritual_attachment_checks;
      expect(roundtrip).toEqual(after.tables.ritual_attachment_checks);
    }),
  );
});
