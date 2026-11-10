// Made-up wind-down reports only: the sixth habit (schema version 12), the day it joined the ritual, its midnight
// deadline, how it counts in full completion, what the view says of it, and the migration that adds it.
import { expect, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Clock, Effect, Result } from "effect";
import * as path from "node:path";
import { type Cell, HABIT_CHECK_SQL, HABIT_SINCE, TABLE_SQL } from "../src/applicability.ts";
import { deadlineOf } from "../src/deadlines.ts";
import { HABIT_EVENT_SQL } from "../src/habitEvents.ts";
import { openStore } from "../src/store.ts";
import { readView } from "../src/view.ts";
import { stoppedAt } from "../fixtures/rituals.ts";
import { BEFORE_WIND_DOWN_SQL, inspect, messageOf, migratedRows, tempDirectory, untimed, withDatabase } from "./helpers/fixtures.ts";

// 03:00 UTC is 14:00 in Melbourne (AEDT, +11): Saturday 14 November 2026 is the open day, the 13th closed.
const NOW = Date.parse("2026-11-14T03:00:00Z");
const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Clock.Clock, stoppedAt(NOW));

const OLD_HABITS = { magnesium: true, protein: true, stretching: true, journalling: true, plank_seconds: 60 };

const put = (date: string, patch: Record<string, unknown>, events: ReadonlyArray<Record<string, unknown>>, id: string) => ({
  op: "ritual_put",
  date,
  patch,
  events,
  request_id: `fictional-wind-down:${id}`,
  source_text: `Fictional wind-down report ${id}; times as stated.`,
});
const windDownAt = (done_at: string | null) => ({ habit: "wind_down", done_at, basis: done_at === null ? "unknown" : "user_stated" });

/** A store at the current schema in a rituals root of its own (data/ under it), as the view reads one. */
const newStore = Effect.gen(function* () {
  const root = yield* tempDirectory;
  return { root, store: yield* openStore(path.join(root, "data")) };
});

const cell = (status: Cell["status"]): Cell => ({ status, basis: "explicit_report", raw: null, applicable: true, included_in_completion: true, exception_id: null });

layer(NodeServices.layer, { excludeTestServices: true })("wind-down", (it) => {
  it.effect("joins the ritual on 2026-11-09: an earlier day was not asked it, takes no answer, and keeps its completion", () =>
    atNow(
      Effect.gen(function* () {
        const { store } = yield* newStore;
        expect(HABIT_SINCE.wind_down).toBe("2026-11-09");
        const early = yield* store.request(put("2026-11-08", { wind_down: true }, [windDownAt(null)], "early")).pipe(Effect.flip);
        expect(messageOf(early)).toMatch(/wind_down is part of the ritual from 2026-11-09/);
        const earlyEvent = yield* store.request(put("2026-11-08", {}, [windDownAt(null)], "early-event")).pipe(Effect.flip);
        expect(messageOf(earlyEvent)).toMatch(/from 2026-11-09/);
        // A day before it, every other habit done, is complete as it always was.
        yield* store.request(put("2026-11-08", OLD_HABITS, untimed("magnesium", "protein", "stretching", "journalling"), "old"));
        const status = (yield* store.request({ op: "ritual_status", from: "2026-11-08", to: "2026-11-08" })) as any;
        expect(status.records[0].habits.wind_down).toMatchObject({ status: "not_applicable", basis: "not_started", applicable: false, included_in_completion: false });
        expect(status.records[0].full_completion.complete).toBe(true);
        expect(status.by_habit.wind_down).toEqual({ done: 0, applicable: 0, percentage: null });
        expect(status.completion).toEqual({ done: 5, applicable: 5, percentage: 100 });
      }),
    ),
  );

  it.effect("is a core habit from then: its tick needs its time, and the ritual is complete only with it", () =>
    atNow(
      Effect.gen(function* () {
        const { store } = yield* newStore;
        const untold = yield* store.request(put("2026-11-13", { wind_down: true }, [], "untold")).pipe(Effect.flip);
        expect(messageOf(untold)).toMatch(/Ticking wind_down needs its time/);
        yield* store.request(put("2026-11-13", OLD_HABITS, untimed("magnesium", "protein", "stretching", "journalling"), "five"));
        const partial = (yield* store.request({ op: "ritual_checklist", ritual: "evening", date: "2026-11-13" })) as any;
        expect(partial.full_completion).toMatchObject({ complete: false, remaining_core: ["wind_down"] });
        const ack = (yield* store.request(put("2026-11-13", {}, [windDownAt("2026-11-13T23:20:00+11:00")], "tick"))) as any;
        expect(ack.record.wind_down).toBe(true);
        expect(ack.events).toHaveLength(1);
        const whole = (yield* store.request({ op: "ritual_checklist", ritual: "evening", date: "2026-11-13" })) as any;
        expect(whole.full_completion).toMatchObject({ complete: true, remaining_core: [] });
        const events = (yield* store.request({ op: "habit_events", from: "2026-11-13", to: "2026-11-13", habit: "wind_down" })) as any;
        expect(events.records.map((e: any) => [e.done_at, e.basis])).toEqual([["2026-11-13T12:20:00Z", "user_stated"]]);
        // An exception can excuse it, as any habit.
        yield* store.request({
          op: "exception_add",
          record: { habit: "wind_down", start_date: "2026-11-15", end_date: "2026-11-16", reason: "Fictional night flight" },
          request_id: "fictional-wind-down:exception",
          source_text: "Fictional exception",
        });
      }),
    ),
  );

  it.effect("is green before midnight, red at or after it or when its day closed without it, and unjudged with no time", () =>
    atNow(
      Effect.gen(function* () {
        const { root, store } = yield* newStore;
        yield* store.request(put("2026-11-09", { wind_down: true }, [windDownAt("2026-11-09T23:59:59+11:00")], "on-time"));
        yield* store.request(put("2026-11-10", { wind_down: true }, [windDownAt("2026-11-11T00:00:00+11:00")], "at-midnight"));
        yield* store.request(put("2026-11-11", { wind_down: true }, [windDownAt(null)], "untimed"));
        yield* store.request(put("2026-11-12", { magnesium: true }, untimed("magnesium"), "missed"));
        yield* store.request(put("2026-11-13", { wind_down: false }, [], "said-no"));
        const daily = (yield* readView(root, NOW * 1000, { daysThroughActive: true })).daily;
        const of = (date: string) => daily.rows.find((row) => row.date === date)!.cells.wind_down!;
        expect(of("2026-11-09").deadline).toEqual({ at: "2026-11-10T00:00:00+11:00", on_time: true, done_at: "2026-11-09T23:59:59+11:00", time_basis: "user_stated" });
        expect(of("2026-11-10").deadline).toEqual({ at: "2026-11-11T00:00:00+11:00", on_time: false, done_at: "2026-11-11T00:00:00+11:00", time_basis: "user_stated" });
        expect(of("2026-11-10").status).toBe("done");
        expect(of("2026-11-11").deadline).toMatchObject({ on_time: null, done_at: null, time_basis: "unknown" });
        expect([of("2026-11-12").status, of("2026-11-12").basis, of("2026-11-12").deadline?.on_time]).toEqual(["not_done", "missing_after_close", false]);
        expect([of("2026-11-13").status, of("2026-11-13").deadline?.on_time]).toEqual(["not_done", false]);
        expect([of("2026-11-14").status, of("2026-11-14").deadline]).toEqual(["unreported", { at: "2026-11-15T00:00:00+11:00", on_time: null, done_at: null, time_basis: null }]);
        // Every other habit's cell is as it was: no deadline.
        expect(daily.rows.every((row) => Object.entries(row.cells).every(([habit, c]) => (habit === "wind_down") === ("deadline" in c)))).toBe(true);
        // A late tick, and one with no time, still count as done: three of the five closed days it was asked.
        expect(daily.rates.wind_down).toEqual({ done: 3, denominator: 5, percentage: 60 });
      }),
    ),
  );

  it("judges the first known time of the day, against midnight after the logical date", () => {
    const events = [
      { habit: "wind_down" as const, date: "2026-11-09", done_at: "2026-11-09T13:30:00Z", basis: "user_stated" as const },
      { habit: "wind_down" as const, date: "2026-11-09", done_at: "2026-11-09T12:45:00Z", basis: "message_received" as const },
      { habit: "wind_down" as const, date: "2026-11-09", done_at: null, basis: "unknown" as const },
      { habit: "magnesium" as const, date: "2026-11-09", done_at: "2026-11-09T09:00:00Z", basis: "user_stated" as const },
    ];
    const later = NOW * 1000;
    const judged = Result.getOrThrow(deadlineOf("wind_down", "2026-11-09", cell("done"), events, later));
    expect(judged).toEqual({ at: "2026-11-10T00:00:00+11:00", on_time: true, done_at: "2026-11-09T23:45:00+11:00", time_basis: "message_received" });
    expect(Result.getOrThrow(deadlineOf("magnesium", "2026-11-09", cell("done"), events, later))).toBeNull();
    expect(Result.getOrThrow(deadlineOf("wind_down", "2026-11-09", cell("not_applicable"), events, later))).toBeNull();
  });

  it("leaves the open day with no answer unjudged before midnight, and late from midnight on, though it closes at 06:00", () => {
    const unanswered = (stamp: string) => Result.getOrThrow(deadlineOf("wind_down", "2026-11-09", cell("unreported"), [], Date.parse(stamp) * 1000))?.on_time;
    expect(unanswered("2026-11-09T23:59:59+11:00")).toBeNull();
    expect(unanswered("2026-11-10T00:00:00+11:00")).toBe(false);
    expect(unanswered("2026-11-10T00:30:00+11:00")).toBe(false);
    expect(unanswered("2026-11-10T05:59:59+11:00")).toBe(false);
  });

  it.effect("version 11 migrates explicitly: backed up first, every record kept, the habit tables taking wind-down", () =>
    atNow(
      Effect.gen(function* () {
        const { root, store: current } = yield* newStore;
        yield* current.request(put("2026-11-08", OLD_HABITS, [{ habit: "magnesium", done_at: "2026-11-08T21:00:00+11:00", basis: "user_stated" }, ...untimed("protein", "stretching", "journalling")], "history"));
        yield* current.request({
          op: "exception_add",
          record: { habit: "stretching", start_date: "2026-11-07", end_date: "2026-11-07", reason: "Fictional rest day" },
          request_id: "fictional-wind-down:old-exception",
          source_text: "Fictional exception",
        });
        const fresh = inspect(path.join(root, "data", "ritual.sqlite3"), (db) => db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all());
        // Back to version 11 as it was: no wind-down column, and the habit tables' old check.
        const OLD = HABIT_CHECK_SQL.replace(",'wind_down'", "");
        const dir = path.join(yield* tempDirectory, "data");
        yield* Effect.scoped(Effect.gen(function* () {
          const copy = yield* openStore(dir);
          yield* copy.request({ op: "restore", snapshot: yield* current.request({ op: "export" }) });
        }));
        withDatabase(path.join(dir, "ritual.sqlite3"), (db) =>
          db.exec(`${BEFORE_WIND_DOWN_SQL}
ALTER TABLE applicability_exceptions RENAME TO old_exceptions;
${TABLE_SQL.replace(HABIT_CHECK_SQL, OLD)}
INSERT INTO applicability_exceptions SELECT * FROM old_exceptions; DROP TABLE old_exceptions;
DROP INDEX idx_habit_events_date; DROP INDEX idx_habit_events_habit_done_at;
ALTER TABLE habit_events RENAME TO old_events;
${HABIT_EVENT_SQL.replace(HABIT_CHECK_SQL, OLD)}
INSERT INTO habit_events SELECT * FROM old_events; DROP TABLE old_events;`),
        );
        expect(() =>
          withDatabase(path.join(dir, "ritual.sqlite3"), (db) => db.exec("INSERT INTO habit_events VALUES('he_x','2026-11-08','wind_down',NULL,'unknown')")),
        ).toThrow(/CHECK/);
        yield* Effect.scoped(Effect.gen(function* () {
          const store = yield* openStore(dir);
          expect([store.schemaVersion(), store.migrationRequired()]).toEqual([11, true]);
          // The view reads it either side of the migration.
          const daily = (yield* readView(path.dirname(dir), NOW * 1000)).daily;
          expect(daily.rows.find((row) => row.date === "2026-11-08")!.cells.wind_down!.basis).toBe("not_started");
          const before = (yield* store.request({ op: "export" })) as any;
          expect(before.tables.rituals[0]).not.toHaveProperty("wind_down");
          const result = yield* store.migrate;
          expect([result.migrated, result.from_version, result.schema_version]).toEqual([true, 11, 12]);
          expect(inspect(result.backup!, (db) => (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v)).toBe(11);
          const after = (yield* store.request({ op: "export" })) as any;
          for (const name of Object.keys(before.tables)) expect(after.tables[name]).toEqual(migratedRows(name, before.tables[name]));
          expect(after.tables.rituals.map((row: any) => row.wind_down)).toEqual([null]);
          expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 12 });
          // Its schema is a new store's, so a wind-down event and exception are taken now.
          const migrated = inspect(path.join(dir, "ritual.sqlite3"), (db) => db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all());
          expect(migrated).toEqual(fresh);
          yield* store.request(put("2026-11-13", { wind_down: true }, [windDownAt("2026-11-13T22:10:00+11:00")], "after-migration"));
          yield* store.request({
            op: "exception_add",
            record: { habit: "wind_down", start_date: "2026-11-20", end_date: "2026-11-20", reason: "Fictional night out" },
            request_id: "fictional-wind-down:after-migration-exception",
            source_text: "Fictional exception",
          });
        }));
      }),
    ),
  );

  it.effect("an export from version 11 restores into a new store with no wind-down answered", () =>
    atNow(
      Effect.gen(function* () {
        const { store } = yield* newStore;
        yield* store.request(put("2026-11-08", OLD_HABITS, untimed("magnesium", "protein", "stretching", "journalling"), "for-export"));
        const dir = path.join(yield* tempDirectory, "data");
        yield* Effect.scoped(Effect.gen(function* () {
          const copy = yield* openStore(dir);
          yield* copy.request({ op: "restore", snapshot: yield* store.request({ op: "export" }) });
        }));
        withDatabase(path.join(dir, "ritual.sqlite3"), (db) => db.exec(BEFORE_WIND_DOWN_SQL));
        const old = (yield* Effect.scoped(Effect.flatMap(openStore(dir), (s) => s.request({ op: "export" })))) as any;
        expect(old.schema_version).toBe(11);
        const target = yield* openStore(yield* tempDirectory);
        yield* target.request({ op: "restore", snapshot: old });
        const back = (yield* target.request({ op: "export" })) as any;
        expect(back.tables.rituals).toEqual(migratedRows("rituals", old.tables.rituals));
      }),
    ),
  );
});
