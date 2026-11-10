// Habit events (schema version 7): when each habit was done, under the unchanged daily tick.
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { pack, sha } from "../src/encoding.ts";
import { instantZ, ritualDate } from "../src/instants.ts";
import { openStore } from "../src/store.ts";
import { migrate } from "../src/localClient.ts";
import {
  BEFORE_CHECK_TIMES_SQL,
  BUNDLE,
  inspect,
  listFiles,
  messageOf,
  tempDirectory,
  untimed,
  WEEKLY_SQL,
  withDatabase,
  migratedRows,
} from "./helpers/fixtures.ts";

const SOURCE = "Fictional words. Source ID FICTIONAL-1. Received at 2026-10-10T21:30:00+11:00.";

const put = (date: string, patch: object, events: Array<object>, request_id: string, source_text = SOURCE) => ({
  op: "ritual_put",
  date,
  patch,
  events,
  request_id,
  source_text,
});

const setup = Effect.gen(function* () {
  const dir = yield* tempDirectory;
  const store = yield* openStore(dir);
  yield* store.request({ op: "import", bundle: BUNDLE });
  return { dir, store };
});

const failure = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.flip, Effect.map(messageOf));

const eventsOf = (store: { request: (r: unknown) => Effect.Effect<unknown, unknown> }, from: string, to = from) =>
  store.request({ op: "habit_events", from, to }).pipe(Effect.map((r: any) => r.records as Array<any>));

layer(NodeServices.layer, { excludeTestServices: true })("habit events", (it) => {
  it.effect("a new store has the events table: id, date, habit, done_at and basis", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const columns = yield* store.sql.unsafe<{ name: string }>("PRAGMA table_info(habit_events)");
      expect(columns.map((c) => c.name)).toEqual(["id", "date", "habit", "done_at", "basis"]);
      const status = (yield* store.request({ op: "status" })) as any;
      expect([status.schema_version, status.migration_required, status.counts.habit_events]).toEqual([12, false, 0]);
    }),
  );

  it.effect("a report with times sets the ticks and records each event, audited, with exact retries", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const request = put(
        "2026-10-10",
        { stretching: true },
        [
          { habit: "magnesium", done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" },
          { habit: "protein", done_at: "2026-10-10T21:30:00+11:00", basis: "message_received" },
          { habit: "stretching", done_at: null, basis: "unknown" },
        ],
        "FICTIONAL-1:ritual",
      );
      const ack = (yield* store.request(request)) as any;
      expect([ack.record.magnesium, ack.record.protein, ack.record.stretching, ack.record.journalling]).toEqual([
        true,
        true,
        true,
        null,
      ]);
      expect(ack.events.map(({ id: _id, revision: _r, ...rest }: any) => rest)).toEqual([
        { date: "2026-10-10", habit: "magnesium", done_at: "2026-10-10T10:00:00Z", basis: "user_stated" },
        { date: "2026-10-10", habit: "protein", done_at: "2026-10-10T10:30:00Z", basis: "message_received" },
        { date: "2026-10-10", habit: "stretching", done_at: null, basis: "unknown" },
      ]);
      expect(ack.events.every((e: any) => e.revision < ack.revision)).toBe(true);
      // A lost acknowledgement is retried with the identical payload and gets the same answer, no new events.
      expect(yield* store.request(request)).toEqual({ ...ack, replayed: true });
      expect((yield* eventsOf(store, "2026-10-10")).length).toBe(3);
      expect(yield* failure(store.request({ ...request, events: [request.events[0]] }))).toBe(
        "request_id already used for different content",
      );
      // Each event has its own audit carrying the report's source text.
      const history = (yield* store.request({ op: "history", entity: "habit_events", id: ack.events[0].id })) as any;
      expect(history.map((h: any) => [h.action, h.before_json, h.source_text])).toEqual([["ritual_put", null, SOURCE]]);
      // A report without events (planks are exempt from needing one) has no events key in its acknowledgement.
      const plain = (yield* store.request(put("2026-10-10", { plank_seconds: 30 }, [], "FICTIONAL-2:ritual"))) as any;
      expect("events" in plain).toBe(false);
    }),
  );

  it.effect("several events of one habit on one day, each with its own time or unknown", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(
        put(
          "2026-10-10",
          {},
          [{ habit: "protein", done_at: "2026-10-10T08:15:00+11:00", basis: "user_stated" }],
          "FICTIONAL-3:ritual",
        ),
      );
      yield* store.request(
        put(
          "2026-10-10",
          { protein: true },
          [
            { habit: "protein", done_at: "2026-10-10T15:00:00+11:00", basis: "user_stated" },
            { habit: "protein", basis: "unknown" },
          ],
          "FICTIONAL-4:ritual",
        ),
      );
      const records = yield* eventsOf(store, "2026-10-10");
      expect(records.map((r) => [r.habit, r.done_at, r.basis])).toEqual([
        ["protein", "2026-10-09T21:15:00Z", "user_stated"],
        ["protein", "2026-10-10T04:00:00Z", "user_stated"],
        ["protein", null, "unknown"],
      ]);
      expect(new Set(records.map((r) => r.id)).size).toBe(3);
      expect(records.every((r) => Number.isInteger(r.revision) && r.revision > 0)).toBe(true);
    }),
  );

  it.effect("unknown stays unknown and a time is never accepted without its basis", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const day = "2026-10-10";
      const at = "2026-10-10T21:00:00+11:00";
      const cases: Array<[object, RegExp]> = [
        [{ habit: "protein", done_at: at, basis: "unknown" }, /null exactly when its basis is unknown/],
        [{ habit: "protein", basis: "user_stated" }, /null exactly when its basis is unknown/],
        [{ habit: "protein", done_at: "2026-10-10T21:00:00", basis: "user_stated" }, /UTC offset/],
        [{ habit: "protein", done_at: at, basis: "scheduled" }, /basis must be one of/],
        [{ habit: "planks_seconds", done_at: at, basis: "user_stated" }, /Unknown habit/],
        [{ habit: "protein", done_at: at, basis: "user_stated", note: "x" }, /only habit, done_at and basis/],
        // Outside the logical date: before its 06:00 open (that still belongs to the day before), or at/after the next
        // day's 06:00.
        [{ habit: "protein", done_at: "2026-10-10T05:59:59+11:00", basis: "user_stated" }, /outside ritual date/],
        [{ habit: "protein", done_at: "2026-10-11T06:00:00+11:00", basis: "user_stated" }, /outside ritual date/],
        [{ habit: "protein", done_at: "2026-10-11T11:59:00+11:00", basis: "user_stated" }, /outside ritual date/],
        // A receipt-time basis must be the receipt instant the source text states.
        [{ habit: "protein", done_at: "2026-10-10T21:31:00+11:00", basis: "message_received" }, /Received at/],
      ];
      for (const [i, [event, message]] of cases.entries())
        expect(yield* failure(store.request(put(day, {}, [event], `bad-${i}`)))).toMatch(message);
      expect(yield* failure(store.request({ ...put(day, {}, [], "bad-shape"), events: {} }))).toMatch(
        /events must be an array/,
      );
      expect(yield* failure(store.request(put(day, {}, [], "empty")))).toMatch(/reported fields, events/);
      // An hour from now, on its own logical ritual date (before 06:00 that is the evening before), so only the future
      // rule can refuse it.
      const later = (Date.now() + 3_600_000) * 1000;
      const future = { habit: "protein", done_at: instantZ(later), basis: "user_stated" };
      expect(yield* failure(store.request(put(ritualDate(later), {}, [future], "future")))).toMatch(/in the future/);
      expect((yield* store.counts).habit_events).toBe(0);
      expect((yield* store.get("rituals", day)) ?? null).toBeNull();
    }),
  );

  it.effect("an after-midnight continuation belongs to the previous evening until 06:00", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const ack = (yield* store.request(
        put(
          "2026-10-10",
          {},
          [
            { habit: "magnesium", done_at: "2026-10-11T00:40:00+11:00", basis: "user_stated" },
            { habit: "magnesium", done_at: "2026-10-11T05:59:59+11:00", basis: "user_stated" },
          ],
          "late",
        ),
      )) as any;
      expect(ack.events.map((e: any) => e.done_at)).toEqual(["2026-10-10T13:40:00Z", "2026-10-10T18:59:59Z"]);
      const morning = (yield* store.request(
        put("2026-10-11", {}, [{ habit: "protein", done_at: "2026-10-11T06:00:00+11:00", basis: "user_stated" }], "am"),
      )) as any;
      expect(morning.events[0].done_at).toBe("2026-10-10T19:00:00Z");
    }),
  );

  it.effect("a plank event needs the day's seconds; a recorded 'not done' needs correct first", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const plank = { habit: "planks", done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" };
      expect(yield* failure(store.request(put("2026-10-10", {}, [plank], "p1")))).toMatch(/plank_seconds/);
      const ack = (yield* store.request(put("2026-10-10", { plank_seconds: 60 }, [plank], "p2"))) as any;
      expect([ack.record.plank_seconds, ack.events[0].habit]).toEqual([60, "planks"]);
      // 2026-09-25 recorded protein as not done in the fixtures.
      const protein = { habit: "protein", done_at: "2026-09-25T20:00:00+10:00", basis: "user_stated" };
      expect(yield* failure(store.request(put("2026-09-25", {}, [protein], "p3")))).toMatch(/requires correct/);
      expect((yield* store.get("rituals", "2026-09-25"))!.protein).toBe(false);
    }),
  );

  it.effect("an event conflicts with an applicability exception like any positive report", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request({
        op: "exception_add",
        record: { habit: "protein", start_date: "2026-10-09", end_date: "2026-10-11", reason: "Fictional pause" },
        request_id: "pause",
        source_text: "Fictional pause",
      });
      const event = { habit: "protein", done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" };
      expect(yield* failure(store.request(put("2026-10-10", {}, [event], "x")))).toMatch(/applicability exception/);
      expect((yield* store.counts).habit_events).toBe(0);
    }),
  );

  it.effect("a past day's time is added later with a fresh report; the tick stays as it was", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      // 2026-09-30 was imported with protein ticked and no times.
      const before = (yield* store.request({ op: "rituals", from: "2026-09-30", to: "2026-09-30" })) as any;
      const ack = (yield* store.request(
        put(
          "2026-09-30",
          {},
          [{ habit: "protein", done_at: "2026-09-30T19:00:00+10:00", basis: "user_stated" }],
          "LATER-MSG:ritual:2026-09-30",
          "Fictional later words: 'I had protein at 7 that night'. Source ID LATER-MSG. Received at 2026-10-12T09:00:00+11:00.",
        ),
      )) as any;
      const { revision: _r, ...unchanged } = before.records[0];
      expect(ack.record).toEqual(unchanged);
      expect((yield* eventsOf(store, "2026-09-30")).map((r) => r.done_at)).toEqual(["2026-09-30T09:00:00Z"]);
    }),
  );

  it.effect("corrections keep the revision guard; removal is audited; a tick waits for its events to go", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const ack = (yield* store.request(
        put("2026-10-10", {}, [{ habit: "magnesium", basis: "unknown" }], "FICTIONAL-5:ritual"),
      )) as any;
      const event = ack.events[0];
      const correct = (patch: object, expected_revision: number, request_id: string, source_text = SOURCE) =>
        store.request({
          op: "correct",
          entity: "habit_events",
          id: event.id,
          patch,
          expected_revision,
          reason: "User later said when",
          request_id,
          source_text,
        });
      expect(yield* failure(correct({ done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" }, 1, "c0"))).toMatch(
        /Revision conflict/,
      );
      expect(yield* failure(correct({ habit: "protein" }, event.revision, "c1"))).toMatch(/identity/);
      expect(yield* failure(correct({ basis: "user_stated" }, event.revision, "c2"))).toMatch(/null exactly/);
      const fixed = (yield* correct(
        { done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" },
        event.revision,
        "c3",
      )) as any;
      expect([fixed.record.done_at, fixed.record.basis]).toEqual(["2026-10-10T10:00:00Z", "user_stated"]);
      // The tick cannot be taken back while the event remains.
      const day = (yield* store.request({ op: "rituals", from: "2026-10-10", to: "2026-10-10" })) as any;
      const untick = (expected_revision: number, request_id: string) =>
        store.request({
          op: "correct",
          entity: "rituals",
          id: "2026-10-10",
          patch: { magnesium: false },
          expected_revision,
          reason: "User said it was not taken",
          request_id,
          source_text: SOURCE,
        });
      expect(yield* failure(untick(day.records[0].revision, "u1"))).toMatch(
        /Remove the magnesium events of 2026-10-10/,
      );
      const remove = (expected_revision: number, request_id: string) =>
        store.request({
          op: "habit_event_remove",
          id: event.id,
          expected_revision,
          reason: "User said it was not taken",
          request_id,
          source_text: SOURCE,
        });
      expect(yield* failure(remove(event.revision, "r0"))).toMatch(/Revision conflict/);
      const removed = (yield* remove(fixed.revision, "r1")) as any;
      expect(removed.record).toBeNull();
      expect(yield* remove(fixed.revision, "r1")).toEqual({ ...removed, replayed: true });
      expect(yield* eventsOf(store, "2026-10-10")).toEqual([]);
      const history = (yield* store.request({ op: "history", entity: "habit_events", id: event.id })) as any;
      expect(history.map((h: any) => [h.action, h.after_json === null])).toEqual([
        ["ritual_put", false],
        ["correct", false],
        ["habit_event_remove", true],
      ]);
      expect(JSON.parse(history[2].before_json).done_at).toBe("2026-10-10T10:00:00Z");
      expect(yield* failure(remove(removed.revision, "r2"))).toBe("Record not found");
      const unticked = (yield* untick(day.records[0].revision, "u2")) as any;
      expect(unticked.record.magnesium).toBe(false);
    }),
  );

  it.effect("the events read filters by date range and habit", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(
        put(
          "2026-10-10",
          {},
          [
            { habit: "protein", done_at: "2026-10-10T08:00:00+11:00", basis: "user_stated" },
            { habit: "magnesium", done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" },
          ],
          "read-1",
        ),
      );
      const only = (yield* store.request({
        op: "habit_events",
        from: "2026-10-01",
        to: "2026-10-31",
        habit: "magnesium",
      })) as any;
      expect([only.count, only.records[0].habit]).toEqual([1, "magnesium"]);
      expect(
        yield* failure(store.request({ op: "habit_events", from: "2026-10-01", to: "2026-10-31", habit: "fish" })),
      ).toBe("Unknown habit");
    }),
  );

  it.effect("export and restore keep events; a snapshot event without its tick is refused", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(
        put(
          "2026-10-10",
          {},
          [{ habit: "protein", done_at: "2026-10-10T08:00:00+11:00", basis: "user_stated" }],
          "exp-1",
        ),
      );
      const snapshot = (yield* store.request({ op: "export" })) as any;
      expect(snapshot.schema_version).toBe(12);
      expect(snapshot.tables.habit_events.length).toBe(1);
      const other = yield* openStore(yield* tempDirectory);
      const restored = (yield* other.request({ op: "restore", snapshot })) as any;
      expect(restored.data_sha256).toBe(snapshot.data_sha256);
      const broken = JSON.parse(JSON.stringify(snapshot));
      broken.tables.rituals = broken.tables.rituals.map((r: any) =>
        r.date === "2026-10-10" ? { ...r, protein: null } : r,
      );
      broken.data_sha256 = sha(pack(broken.tables));
      const third = yield* openStore(yield* tempDirectory);
      expect(yield* failure(third.request({ op: "restore", snapshot: broken }))).toMatch(/has no done tick/);
      expect((yield* third.counts).habit_events).toBe(0);
    }),
  );

  it.effect("version 6 migrates explicitly: backed up first, history unchanged, no event invented", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const dir = path.join(root, "data");
      // A version-6 store of the live store's shape, from the made-up fixtures.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          yield* store.request({ op: "import", bundle: BUNDLE });
          yield* store.request(
            put("2026-10-10", { magnesium: true, plank_seconds: 45 }, untimed("magnesium"), "v6-report"),
          );
        }),
      );
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) =>
        db.exec(
          WEEKLY_SQL +
            BEFORE_CHECK_TIMES_SQL +
            "DROP TABLE habit_events; DROP TABLE weekly_target_entries; DROP TABLE weekly_targets; DELETE FROM schema_migrations WHERE version>=7",
        ),
      );
      fs.rmSync(path.join(dir, "backups"), { recursive: true, force: true });
      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          expect([store.schemaVersion(), store.migrationRequired()]).toEqual([6, true]);
          expect(yield* failure(store.request(put("2026-10-10", {}, [], "blocked")))).toMatch(/--migrate/);
          return (yield* store.request({ op: "export" })) as any;
        }),
      );
      expect(before.schema_version).toBe(6);
      const result = (yield* migrate(root)) as any;
      expect([result.migrated, result.from_version, result.schema_version]).toEqual([true, 6, 12]);
      expect(result.dashboard.updated).toBe(true);
      expect(
        inspect(result.backup, (db) => (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v),
      ).toBe(6);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          const after = (yield* store.request({ op: "export" })) as any;
          for (const name of Object.keys(before.tables).filter((t) => t !== "weekly_reviews"))
            expect(after.tables[name]).toEqual(migratedRows(name, before.tables[name]));
          expect(after.tables.habit_events).toEqual([]);
          expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 12 });
          // Writes resume, and the ticks of migrated history stay without times.
          const day = (yield* store.request({ op: "rituals", from: "2026-10-10", to: "2026-10-10" })) as any;
          expect([day.records[0].magnesium, day.records[0].plank_seconds]).toEqual([true, 45]);
          yield* store.request(
            put(
              "2026-10-10",
              {},
              [{ habit: "magnesium", done_at: "2026-10-10T21:00:00+11:00", basis: "user_stated" }],
              "after-migration",
            ),
          );
        }),
      );
      expect(listFiles(path.join(dir, "backups"), ".sqlite3").length).toBe(2);
    }),
  );

  it.effect("ticking a habit without its event is refused, naming how to give the time", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const day = "2026-10-10";
      for (const habit of ["magnesium", "protein", "stretching", "journalling"]) {
        const message = yield* failure(store.request(put(day, { [habit]: true }, [], `bare-${habit}`)));
        expect(message).toContain(`Ticking ${habit} needs its time`);
        expect(message).toContain('"basis":"unknown"');
      }
      // An event for a different habit does not cover it, and nothing was saved by any refusal.
      const other = [{ habit: "protein", done_at: null, basis: "unknown" }];
      expect(yield* failure(store.request(put(day, { magnesium: true }, other, "wrong-habit")))).toContain(
        "Ticking magnesium needs its time",
      );
      expect([(yield* store.counts).habit_events, (yield* store.get("rituals", day)) ?? null]).toEqual([0, null]);
      // Saying the time is unknown is enough; so is a stated time.
      const unknown = (yield* store.request(
        put(day, { magnesium: true }, [{ habit: "magnesium", done_at: null, basis: "unknown" }], "unknown-ok"),
      )) as any;
      expect(unknown.events.map((e: any) => e.revision > 0)).toEqual([true]);
      // Planks are exempt: their report is the seconds.
      const planks = (yield* store.request(put(day, { plank_seconds: 45 }, [], "planks-ok"))) as any;
      expect(planks.record.plank_seconds).toBe(45);
      // A restatement of a habit the day already has ticked is not a new tick, so it needs no event; a false or an
      // untouched habit needs none either.
      const again = (yield* store.request(put(day, { magnesium: true }, [], "restated"))) as any;
      expect(again.record.magnesium).toBe(true);
      const notDone = (yield* store.request(put(day, { protein: false }, [], "not-done"))) as any;
      expect(notDone.record.protein).toBe(false);
      // An old request id still replays as it did, whatever the rule says today.
      expect(
        (
          (yield* store.request(
            put(day, { magnesium: true }, [{ habit: "magnesium", done_at: null, basis: "unknown" }], "unknown-ok"),
          )) as any
        ).replayed,
      ).toBe(true);
    }),
  );

  it.effect("journal_entry_at also records the journalling event at that instant", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const stamp = "2026-10-10T22:15:00+11:00";
      const journal = (patch: object, id: string, source = `Fictional journal. Received at ${stamp}.`) => ({
        op: "ritual_put",
        date: "2026-10-10",
        patch,
        journal_entry_at: stamp,
        request_id: id,
        source_text: source,
      });
      // An empty patch only sets the check-in, as before: journalling is not done, so there is nothing to time.
      const bare = (yield* store.request(journal({}, "j-bare"))) as any;
      expect([bare.record.journalling, "events" in bare, bare.record.checkins]).toEqual([
        null,
        false,
        ["2026-10-10T11:15:00Z"],
      ]);
      // Ticking journalling with it records the event: a receipt when source_text says so ...
      const ack = (yield* store.request(journal({ journalling: true }, "j-receipt"))) as any;
      expect(ack.events.map(({ id: _id, revision: _r, ...rest }: any) => rest)).toEqual([
        { date: "2026-10-10", habit: "journalling", done_at: "2026-10-10T11:15:00Z", basis: "message_received" },
      ]);
      expect(yield* eventsOf(store, "2026-10-10")).toHaveLength(1);
      // ... and the exact retry replays without a second event.
      expect(((yield* store.request(journal({ journalling: true }, "j-receipt"))) as any).replayed).toBe(true);
      expect(yield* eventsOf(store, "2026-10-10")).toHaveLength(1);
      // The day already has a journalling event, so a later journal report adds none.
      yield* store.request(journal({ journalling: true }, "j-later"));
      expect(yield* eventsOf(store, "2026-10-10")).toHaveLength(1);
    }),
  );

  it.effect("journal_entry_at is a stated time when no receipt is named, and yields to the request's own event", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const stamp = "2026-10-11T22:15:00+11:00";
      const request = (date: string, id: string, events?: Array<object>) => ({
        op: "ritual_put",
        date,
        patch: { journalling: true },
        ...(events ? { events } : {}),
        journal_entry_at: stamp,
        request_id: id,
        source_text: "Fictional journal with the time taken from its own recording, no receipt named.",
      });
      const stated = (yield* store.request(request("2026-10-11", "j-stated"))) as any;
      expect(stated.events.map((e: any) => [e.habit, e.done_at, e.basis])).toEqual([
        ["journalling", "2026-10-11T11:15:00Z", "user_stated"],
      ]);
      // The request's own journalling event wins; the instant is not recorded twice.
      const own = [{ habit: "journalling", done_at: "2026-10-12T21:00:00+11:00", basis: "user_stated" }];
      const explicit = (yield* store.request(request("2026-10-12", "j-own", own))) as any;
      expect(explicit.events.map((e: any) => e.done_at)).toEqual(["2026-10-12T10:00:00Z"]);
      // An instant outside its logical date is refused, as an explicit event would be, and saves nothing.
      expect(yield* failure(store.request(request("2026-10-13", "j-wrong-day")))).toMatch(/outside ritual date/);
      expect((yield* store.get("rituals", "2026-10-13")) ?? null).toBeNull();
    }),
  );
});
