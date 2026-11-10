// Weekly targets (schema version 8, dated minimums from version 10): made-up targets and entries only.
import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { openStore } from "../src/store.ts";
import { migrate } from "../src/localClient.ts";
import { readTargetProgress } from "../src/dashboard.ts";
import { parseDateTime } from "../src/instants.ts";
import { durationText, parseAmount, progress } from "../src/weeklyTargets.ts";
import {
  BEFORE_CHECK_TIMES_SQL,
  messageOf,
  NODE_MODULES,
  REPO,
  tempDirectory,
  toVersion9Targets,
  untimed,
  WEEKLY_SQL,
  withDatabase,
  migratedRows,
} from "./helpers/fixtures.ts";

const SOURCE = "Fictional words. Source ID FICTIONAL-T. Received at 2026-10-07T20:00:00+11:00.";

const addTarget = (record: object, request_id: string) => ({
  op: "target_add",
  record,
  request_id,
  source_text: SOURCE,
});
const log = (record: object, request_id: string) => ({ op: "target_log", record, request_id, source_text: SOURCE });
const LAPS = {
  id: "fictional-laps",
  name: "Fictional laps",
  unit: "count",
  noun: "laps",
  minimum: 2,
  start_date: "2026-10-07",
};
const ZONE = {
  id: "fictional-zone",
  name: "Fictional easy minutes",
  unit: "minutes",
  minimum: "5h",
  start_date: "2026-10-07",
};
// Wednesday 14 October, 10:00 Melbourne: the current week is Monday 12 to Sunday 18 October.
const AS_OF = "2026-10-14T10:00:00+11:00";

type Requester = { request: (r: unknown) => Effect.Effect<unknown, unknown> };

const failure = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.flip, Effect.map(messageOf));

const setup = Effect.gen(function* () {
  const store = yield* openStore(yield* tempDirectory);
  yield* store.request(addTarget(LAPS, "setup:laps"));
  yield* store.request(addTarget(ZONE, "setup:zone"));
  return store;
});

const progressOf = (store: Requester, extra: object = {}) =>
  store.request({ op: "weekly_progress", as_of: AS_OF, ...extra }) as Effect.Effect<any, unknown>;

const entriesOf = (store: Requester) =>
  store
    .request({ op: "weekly_target_entries", from: "2026-10-01", to: "2026-10-31" })
    .pipe(Effect.map((r: any) => r.records as Array<any>));

/** A throwaway installation with the real bin/ritualctl, for the command-line checks. */
const installation = Effect.gen(function* () {
  const root = yield* tempDirectory;
  fs.mkdirSync(path.join(root, "bin"));
  for (const name of ["node.sh", "ritualctl"])
    fs.copyFileSync(path.join(REPO, "bin", name), path.join(root, "bin", name));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.symlinkSync(NODE_MODULES, path.join(root, "node_modules"));
  return root;
});

const ritualctl = (root: string, args: Array<string>, input?: unknown) => {
  const result = spawnSync("/bin/sh", [path.join(root, "bin", "ritualctl"), ...args], {
    env: { RITUAL_NODE: process.execPath, PATH: "/usr/bin:/bin", RITUAL_TIME_ZONE: process.env.RITUAL_TIME_ZONE },
    input: input === undefined ? "" : JSON.stringify(input),
    encoding: "utf8",
  });
  return { status: result.status, json: JSON.parse(result.stdout) };
};

layer(NodeServices.layer, { excludeTestServices: true })("weekly targets", (it) => {
  it.effect("a new store has the target and entry tables, empty", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      const columns = (table: string) =>
        store.sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`).pipe(Effect.map((c) => c.map((r) => r.name)));
      expect(yield* columns("weekly_targets")).toEqual([
        "id",
        "name",
        "unit",
        "noun",
        "start_date",
        "active",
        "position",
        "minimums",
      ]);
      expect(yield* columns("weekly_target_entries")).toEqual([
        "id",
        "target_id",
        "date",
        "amount",
        "note",
        "logged_by",
      ]);
      const status = (yield* store.request({ op: "status" })) as any;
      expect([status.schema_version, status.counts.weekly_targets, status.counts.weekly_target_entries]).toEqual([
        12, 0, 0,
      ]);
      expect(yield* store.request({ op: "weekly_targets" })).toEqual({ records: [] });
      expect(((yield* progressOf(store)) as any).weeks).toEqual([]);
    }),
  );

  it("amounts are read in the target's unit: counts, km and durations", () => {
    const ok = (unit: "count" | "km" | "minutes", value: unknown) => Result.getOrThrow(parseAmount(unit, value));
    expect([ok("count", 1), ok("count", 3)]).toEqual([1, 3]);
    expect([ok("km", 5), ok("km", 4.25), ok("km", "4.2km"), ok("km", "3 km")]).toEqual([5, 4.25, 4.2, 3]);
    expect(["45m", "1h30m", "1h 30m", "1.5h", "2h", "90min", 90].map((v) => ok("minutes", v))).toEqual([
      45, 90, 90, 90, 120, 90, 90,
    ]);
    for (const [unit, value] of [
      ["count", 1.5],
      ["count", "2"],
      ["count", 0],
      ["km", -1],
      ["km", 1.2345],
      ["km", "far"],
      ["minutes", "1.33h"],
      ["minutes", "90"],
      ["minutes", ""],
      ["minutes", 0],
      ["minutes", 10.5],
    ] as const)
      expect(Result.isFailure(parseAmount(unit, value)), `${unit} ${String(value)}`).toBe(true);
    expect([0, 45, 60, 200, 300].map(durationText)).toEqual(["0m", "45m", "1h", "3h 20m", "5h"]);
  });

  it.effect("target_add stores the minimum in the unit, defaults active and order, and replays exactly", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      const first = (yield* store.request(addTarget(LAPS, "setup:laps"))) as any;
      const { minimum: _minimum, ...laps } = LAPS;
      // The minimum is in force from the first week: the week of the start date, from its Monday.
      expect(first.record).toEqual({
        ...laps,
        minimums: [{ week_start: "2026-10-05", minimum: 2 }],
        active: true,
        position: 0,
      });
      const second = (yield* store.request(addTarget(ZONE, "setup:zone"))) as any;
      expect(second.record).toMatchObject({
        minimums: [{ week_start: "2026-10-05", minimum: 300 }],
        noun: null,
        active: true,
        position: 1,
      });
      expect(yield* store.request(addTarget(ZONE, "setup:zone"))).toEqual({ ...second, replayed: true });
      const generated = (yield* store.request(
        addTarget({ name: "Fictional km", unit: "km", minimum: "10km", start_date: "2026-10-07" }, "setup:km"),
      )) as any;
      expect(generated.record.id).toMatch(/^wt_[0-9a-f]{24}$/);
      expect((yield* store.request({ op: "weekly_targets" })) as any).toMatchObject({
        records: [
          { id: "fictional-laps", revision: first.revision },
          { id: "fictional-zone", revision: second.revision },
          { id: generated.record.id, minimum: 10, position: 2 },
        ],
      });
      for (const [record, pattern] of [
        [{ ...LAPS, id: "x1", unit: "hours" }, /unit must be count, km or minutes/],
        [{ ...ZONE, id: "x2", noun: "laps" }, /Only a count target has a noun/],
        [{ ...LAPS, id: "x3", minimum: 1.5 }, /whole number/],
        [{ ...LAPS, id: "x4", start_date: undefined }, /Use a Melbourne calendar date|start_date/],
        [{ ...LAPS, id: "x5", name: " " }, /name must be a non-empty string/],
        [{ ...LAPS, id: "x6", colour: "red" }, /Unknown record fields/],
        [{ ...LAPS, id: "x7", minimums: [{ week_start: "2026-10-05", minimum: 2 }] }, /dated history/],
        [{ ...laps, id: "x8" }, /Required record fields/],
      ] as const)
        expect(yield* failure(store.request(addTarget(record, `bad:${record.id}`)))).toMatch(pattern);
    }),
  );

  it.effect("target_log defaults a count to 1, reads durations and guards the date and target", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      const one = (yield* store.request(
        log({ target_id: "fictional-laps", date: "2026-10-12", logged_by: "fictional assistant" }, "log:1"),
      )) as any;
      expect(one.record).toMatchObject({ amount: 1, note: null, date: "2026-10-12", logged_by: "fictional assistant" });
      expect(one.record.id).toMatch(/^wte_[0-9a-f]{24}$/);
      const zone = (yield* store.request(
        log(
          {
            target_id: "fictional-zone",
            date: "2026-10-13",
            amount: "1h30m",
            note: "Fictional ride",
            logged_by: "owner",
          },
          "log:2",
        ),
      )) as any;
      expect(zone.record.amount).toBe(90);
      // A lost acknowledgement retries with the same answer and no second entry.
      expect(
        (
          (yield* store.request(
            log(
              {
                target_id: "fictional-zone",
                date: "2026-10-13",
                amount: "1h30m",
                note: "Fictional ride",
                logged_by: "owner",
              },
              "log:2",
            ),
          )) as any
        ).replayed,
      ).toBe(true);
      expect((yield* entriesOf(store)).length).toBe(2);
      for (const [record, pattern] of [
        [{ target_id: "fictional-zone", date: "2026-10-13", logged_by: "owner" }, /A minutes entry needs its amount/],
        [{ target_id: "missing", date: "2026-10-13", logged_by: "owner" }, /Unknown target_id/],
        [{ target_id: "fictional-laps", date: "2026-10-04", logged_by: "owner" }, /before the first week .*2026-10-05/],
        [
          { target_id: "fictional-laps", date: "2099-01-01", logged_by: "owner" },
          /after the current logical ritual date/,
        ],
        [{ target_id: "fictional-laps", date: "2026-10-13" }, /Required record fields/],
      ] as const)
        expect(yield* failure(store.request(log(record, `bad:${JSON.stringify(record)}`)))).toMatch(pattern);
      // The first week includes the days of the start date's week before it.
      yield* store.request(log({ target_id: "fictional-laps", date: "2026-10-05", logged_by: "owner" }, "log:monday"));
    }),
  );

  it.effect("progress: Monday-to-Sunday logical weeks, totals against minimums, newest first", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      const entries = [
        { target_id: "fictional-laps", date: "2026-10-08", logged_by: "owner" },
        { target_id: "fictional-laps", date: "2026-10-11", amount: 2, logged_by: "owner" },
        { target_id: "fictional-laps", date: "2026-10-12", logged_by: "owner" },
        { target_id: "fictional-zone", date: "2026-10-12", amount: "2h", logged_by: "owner" },
        { target_id: "fictional-zone", date: "2026-10-13", amount: 80, note: "Fictional note", logged_by: "assistant" },
      ];
      for (const [i, entry] of entries.entries()) yield* store.request(log(entry, `log:${i}`));
      const view = (yield* progressOf(store)) as any;
      expect([view.active_date, view.current_week]).toEqual(["2026-10-14", "2026-10-12"]);
      // Weeks before the targets' first week are not shown at all.
      expect(view.weeks.map((w: any) => [w.week_start, w.week_end, w.current, w.met])).toEqual([
        ["2026-10-12", "2026-10-18", true, 0],
        ["2026-10-05", "2026-10-11", false, 1],
      ]);
      const [laps, zone] = view.weeks[0].targets;
      expect(laps).toMatchObject({
        id: "fictional-laps",
        total: 1,
        remaining: 1,
        met: false,
        fraction: 0.5,
        progress_text: "1 / 2 laps",
        remaining_text: "1 laps",
      });
      expect(zone).toMatchObject({
        total: 200,
        minimum: 300,
        met: false,
        progress_text: "3h 20m / 5h",
        total_text: "3h 20m",
        remaining_text: "1h 40m",
      });
      expect(zone.entries).toEqual([
        expect.objectContaining({ date: "2026-10-12", display_date: "Mon 12", amount: 120, amount_text: "2h" }),
        expect.objectContaining({ amount: 80, amount_text: "1h 20m", note: "Fictional note", logged_by: "assistant" }),
      ]);
      expect(view.weeks[1].targets.map((t: any) => [t.id, t.progress_text, t.met])).toEqual([
        ["fictional-laps", "3 / 2 laps", true],
        ["fictional-zone", "0m / 5h", false],
      ]);
      expect(view.weeks[1].targets[0].fraction).toBe(1);
      // A report at 01:00 on Monday still belongs to Sunday's logical date, and so to the week before.
      const afterMidnight = (yield* progressOf(store, { as_of: "2026-10-19T01:00:00+11:00", weeks: 1 })) as any;
      expect([afterMidnight.active_date, afterMidnight.weeks[0].week_start]).toEqual(["2026-10-18", "2026-10-12"]);
      const monday = (yield* progressOf(store, { as_of: "2026-10-19T06:00:00+11:00", weeks: 1 })) as any;
      expect(monday.weeks[0]).toMatchObject({ week_start: "2026-10-19", met: 0 });
      expect(yield* failure(progressOf(store, { weeks: 0 }))).toMatch(/weeks must be/);
    }),
  );

  it("progress orders targets by position, then name; retired ones show only in weeks with entries", () => {
    const target = (id: string, position: number, active = true) => ({
      id,
      name: id,
      unit: "count" as const,
      noun: null,
      minimums: [{ week_start: "2026-10-05", minimum: 1 }],
      start_date: "2026-10-05",
      active,
      position,
    });
    const view = progress(
      [target("b", 1), target("a", 1), target("first", 0), target("retired", 0, false)],
      [{ id: "e", target_id: "retired", date: "2026-10-06", amount: 1, note: null, logged_by: "owner" }],
      "2026-10-14",
    );
    expect(view.weeks.map((w) => w.targets.map((t) => t.id))).toEqual([
      ["first", "a", "b"],
      ["first", "retired", "a", "b"],
    ]);
    expect(view.weeks[1]!.targets[1]).toMatchObject({ active: false, met: true, progress_text: "1 / 1" });
  });

  it.effect("an entry is edited or undone with the revision guard, and its audit keeps what it was", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      const entry = (yield* store.request(
        log({ target_id: "fictional-zone", date: "2026-10-12", amount: "45m", logged_by: "owner" }, "log:edit"),
      )) as any;
      const correction = {
        op: "correct",
        entity: "weekly_target_entries",
        id: entry.record.id,
        patch: { amount: "1h", date: "2026-10-13", note: "Fictional correction" },
        expected_revision: entry.revision,
        reason: "Owner corrected the duration and day",
        request_id: "correct:1",
        source_text: SOURCE,
      };
      const corrected = (yield* store.request(correction)) as any;
      expect(corrected.record).toMatchObject({ amount: 60, date: "2026-10-13", note: "Fictional correction" });
      expect(yield* failure(store.request({ ...correction, request_id: "correct:stale" }))).toMatch(
        /Revision conflict/,
      );
      for (const [patch, pattern] of [
        [{ target_id: "fictional-laps" }, /Only an entry's amount, note and date can change/],
        [{ logged_by: "someone else" }, /Only an entry's amount, note and date can change/],
        [{ amount: "1.33h" }, /whole minutes/],
        [{ date: "2026-10-01" }, /before the first week/],
      ] as const)
        expect(
          yield* failure(
            store.request({
              ...correction,
              patch,
              expected_revision: corrected.revision,
              request_id: `bad:${JSON.stringify(patch)}`,
            }),
          ),
        ).toMatch(pattern);
      const removal = {
        op: "target_entry_remove",
        id: entry.record.id,
        expected_revision: corrected.revision,
        reason: "Logged by mistake",
        request_id: "undo:1",
        source_text: SOURCE,
      };
      const removed = (yield* store.request(removal)) as any;
      expect(removed.record).toBeNull();
      expect(((yield* store.request(removal)) as any).replayed).toBe(true);
      expect(yield* entriesOf(store)).toEqual([]);
      const history = (yield* store.request({
        op: "history",
        entity: "weekly_target_entries",
        id: entry.record.id,
      })) as any;
      expect(history.map((h: any) => h.action)).toEqual(["target_log", "correct", "target_entry_remove"]);
      expect(JSON.parse(history[2].before_json).amount).toBe(60);
    }),
  );

  it.effect("a target is edited or retired with correct; its unit is fixed and its start keeps its entries", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.request(
        log({ target_id: "fictional-zone", date: "2026-10-08", amount: 30, logged_by: "owner" }, "e"),
      );
      const revision = () =>
        store
          .request({ op: "weekly_targets" })
          .pipe(Effect.map((r: any) => r.records.find((t: any) => t.id === "fictional-zone").revision as number));
      const correct = (patch: object, request_id: string) =>
        Effect.gen(function* () {
          return (yield* store.request({
            op: "correct",
            entity: "weekly_targets",
            id: "fictional-zone",
            patch,
            expected_revision: yield* revision(),
            reason: "Owner changed the target",
            request_id,
            source_text: SOURCE,
          })) as any;
        });
      // A changed minimum is in force from the current week by default; the weeks before keep theirs.
      const current = ((yield* store.request({ op: "weekly_progress", weeks: 1 })) as any).current_week;
      expect((yield* correct({ minimum: "6h", name: "Fictional renamed" }, "c:1")).record).toMatchObject({
        minimums: [
          { week_start: "2026-10-05", minimum: 300 },
          { week_start: current, minimum: 360 },
        ],
        name: "Fictional renamed",
      });
      expect(yield* failure(correct({ unit: "km" }, "c:unit"))).toMatch(/unit is fixed/);
      expect(yield* failure(correct({ start_date: "2026-10-12" }, "c:start"))).toMatch(/would exclude a logged entry/);
      expect((yield* correct({ start_date: "2026-09-28" }, "c:earlier")).record.start_date).toBe("2026-09-28");
      expect((yield* correct({ active: false }, "c:retire")).record.active).toBe(false);
      expect(
        yield* failure(
          store.request(log({ target_id: "fictional-zone", date: "2026-10-13", amount: 5, logged_by: "o" }, "e2")),
        ),
      ).toMatch(/Target is retired/);
      const view = (yield* progressOf(store)) as any;
      // Retired: gone from the current week, still shown in the week its entry counted for.
      expect(view.weeks.map((w: any) => [w.week_start, w.targets.map((t: any) => t.id)])).toEqual([
        ["2026-10-12", ["fictional-laps"]],
        ["2026-10-05", ["fictional-laps", "fictional-zone"]],
      ]);
      expect((yield* correct({ active: true }, "c:back")).record.active).toBe(true);
    }),
  );

  it.effect("a past week keeps the minimum it had after the minimum changes", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      for (const [i, date] of ["2026-10-06", "2026-10-07", "2026-10-13", "2026-10-14"].entries())
        yield* store.request(log({ target_id: "fictional-laps", date, logged_by: "owner" }, `log:${i}`));
      const before = (yield* progressOf(store)) as any;
      const revision = ((yield* store.request({ op: "weekly_targets" })) as any).records[0].revision;
      // Any date names its week: Wednesday 14 October is the week from Monday 12 October.
      const raised = (yield* store.request({
        op: "correct",
        entity: "weekly_targets",
        id: "fictional-laps",
        patch: { minimum: 3 },
        effective_week: "2026-10-14",
        expected_revision: revision,
        reason: "Owner raised the target from this week",
        request_id: "raise:1",
        source_text: SOURCE,
      })) as any;
      expect(raised.record.minimums).toEqual([
        { week_start: "2026-10-05", minimum: 2 },
        { week_start: "2026-10-12", minimum: 3 },
      ]);
      const after = (yield* progressOf(store)) as any;
      const laps = (week: any) => week.targets.find((t: any) => t.id === "fictional-laps");
      expect(laps(after.weeks[0])).toMatchObject({
        minimum: 3,
        total: 2,
        remaining: 1,
        met: false,
        progress_text: "2 / 3 laps",
        minimum_text: "3 laps",
        remaining_text: "1 laps",
      });
      expect(laps(after.weeks[0]).fraction).toBeCloseTo(2 / 3);
      // The week before is exactly as it was judged before the change.
      expect(after.weeks[1]).toEqual(before.weeks[1]);
      expect(laps(after.weeks[1])).toMatchObject({ minimum: 2, met: true, progress_text: "2 / 2 laps" });
      expect([after.weeks[1].met, after.weeks[0].met]).toEqual([1, 0]);
      // The list shows the minimum in force this week next to its history; the audit keeps the history before.
      const listed = ((yield* store.request({ op: "weekly_targets" })) as any).records[0];
      expect([listed.minimum, listed.minimums, listed.revision]).toEqual([3, raised.record.minimums, raised.revision]);
      const history = (yield* store.request({ op: "history", entity: "weekly_targets", id: "fictional-laps" })) as any;
      expect(JSON.parse(history.at(-1).before_json).minimums).toEqual([{ week_start: "2026-10-05", minimum: 2 }]);
    }),
  );

  it.effect("a minimum changed from next week leaves the current week alone", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.request(log({ target_id: "fictional-laps", date: "2026-10-13", logged_by: "owner" }, "log:1"));
      const current = (yield* progressOf(store)) as any;
      const correct = (id: string, patch: object, extra: object, request_id: string) =>
        Effect.gen(function* () {
          const records = ((yield* store.request({ op: "weekly_targets" })) as any).records;
          return (yield* store.request({
            op: "correct",
            entity: "weekly_targets",
            id,
            patch,
            expected_revision: records.find((t: any) => t.id === id).revision,
            reason: "Owner changed the target",
            request_id,
            source_text: SOURCE,
            ...extra,
          })) as any;
        });
      const next = yield* correct("fictional-laps", { minimum: 3 }, { effective_week: "2026-10-19" }, "next:1");
      expect(next.record.minimums).toEqual([
        { week_start: "2026-10-05", minimum: 2 },
        { week_start: "2026-10-19", minimum: 3 },
      ]);
      // As of Wednesday 14 October the current week is unchanged; from Monday 19 October the new minimum applies.
      expect(yield* progressOf(store)).toEqual(current);
      const later = (yield* progressOf(store, { as_of: "2026-10-20T10:00:00+11:00" })) as any;
      expect(later.weeks.map((w: any) => [w.week_start, w.targets[0].minimum, w.targets[0].progress_text])).toEqual([
        ["2026-10-19", 3, "0 / 3 laps"],
        ["2026-10-12", 2, "1 / 2 laps"],
        ["2026-10-05", 2, "0 / 2 laps"],
      ]);
      // A change from an earlier week replaces a later one already set; repeating the minimum in force is no change.
      expect(
        (yield* correct("fictional-laps", { minimum: 4 }, { effective_week: "2026-10-12" }, "next:2")).record.minimums,
      ).toEqual([
        { week_start: "2026-10-05", minimum: 2 },
        { week_start: "2026-10-12", minimum: 4 },
      ]);
      expect(
        (yield* correct("fictional-laps", { minimum: 2 }, { effective_week: "2026-10-12" }, "next:3")).record.minimums,
      ).toEqual([{ week_start: "2026-10-05", minimum: 2 }]);
      // Without effective_week the change starts this week (the real one: tests run on the real clock).
      const week = ((yield* store.request({ op: "weekly_progress", weeks: 1 })) as any).current_week;
      expect((yield* correct("fictional-laps", { minimum: 5 }, {}, "now:1")).record.minimums.at(-1)).toEqual({
        week_start: week,
        minimum: 5,
      });
      for (const [patch, extra, pattern] of [
        [{ minimum: 3 }, { effective_week: "2026-10-04" }, /effective_week 2026-09-28 is before the first week/],
        [{ name: "Renamed" }, { effective_week: "2026-10-19" }, /effective_week only goes with a minimum/],
        [{ minimum: 3 }, { effective_week: "next week" }, /Use a Melbourne calendar date/],
        [{ minimums: [{ week_start: "2026-10-05", minimum: 9 }] }, {}, /dated history/],
        [{ minimum: 2.5 }, {}, /whole number/],
      ] as const)
        expect(
          yield* failure(correct("fictional-laps", patch, extra, `bad:${JSON.stringify([patch, extra])}`)),
        ).toMatch(pattern);
      // A start-date correction re-anchors the history at the new first week; a later week keeps its own minimum.
      expect(
        (yield* correct("fictional-zone", { minimum: "6h" }, { effective_week: "2026-10-19" }, "zone:1")).record
          .minimums,
      ).toEqual([
        { week_start: "2026-10-05", minimum: 300 },
        { week_start: "2026-10-19", minimum: 360 },
      ]);
      expect((yield* correct("fictional-zone", { start_date: "2026-10-14" }, {}, "zone:2")).record.minimums).toEqual([
        { week_start: "2026-10-12", minimum: 300 },
        { week_start: "2026-10-19", minimum: 360 },
      ]);
      expect((yield* correct("fictional-zone", { start_date: "2026-10-22" }, {}, "zone:3")).record.minimums).toEqual([
        { week_start: "2026-10-19", minimum: 360 },
      ]);
      expect((yield* correct("fictional-zone", { start_date: "2026-09-30" }, {}, "zone:4")).record.minimums).toEqual([
        { week_start: "2026-09-28", minimum: 360 },
      ]);
      // A target that has not started yet takes a change from its first week.
      yield* store.request(addTarget({ ...LAPS, id: "fictional-future", start_date: "2099-02-04" }, "setup:future"));
      expect((yield* correct("fictional-future", { minimum: 4 }, {}, "future:1")).record.minimums).toEqual([
        { week_start: "2099-02-02", minimum: 4 },
      ]);
      const [entry] = yield* entriesOf(store);
      expect(
        yield* failure(
          store.request({
            op: "correct",
            entity: "weekly_target_entries",
            id: entry.id,
            patch: { amount: 2 },
            effective_week: "2026-10-19",
            expected_revision: entry.revision,
            reason: "Owner corrected the amount",
            request_id: "bad:entry-week",
            source_text: SOURCE,
          }),
        ),
      ).toMatch(/effective_week only goes with a weekly target's minimum/);
    }),
  );

  it.effect("migration 10 dates each minimum from its first week and judges every week exactly as before", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const dir = path.join(root, "data");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          yield* store.request(addTarget(LAPS, "setup:laps"));
          yield* store.request(addTarget({ ...ZONE, start_date: "2026-09-30" }, "setup:zone"));
          for (const [i, entry] of [
            { target_id: "fictional-laps", date: "2026-10-06", amount: 2, logged_by: "owner" },
            { target_id: "fictional-laps", date: "2026-10-13", logged_by: "owner" },
            { target_id: "fictional-zone", date: "2026-10-01", amount: "5h", logged_by: "owner" },
            { target_id: "fictional-zone", date: "2026-10-12", amount: "2h", logged_by: "owner" },
          ].entries())
            yield* store.request(log(entry, `log:${i}`));
          const revision = ((yield* store.request({ op: "weekly_targets" })) as any).records[0].revision;
          yield* store.request({
            op: "correct",
            entity: "weekly_targets",
            id: "fictional-laps",
            patch: { name: "Fictional laps, renamed" },
            expected_revision: revision,
            reason: "Owner renamed it",
            request_id: "rename",
            source_text: SOURCE,
          });
        }),
      );
      withDatabase(path.join(dir, "ritual.sqlite3"), toVersion9Targets);
      fs.rmSync(path.join(dir, "backups"), { recursive: true, force: true });
      const asOf = Result.getOrThrow(parseDateTime(AS_OF)).micros;
      // The dashboard reads a version 9 store before its migration; its progress is the reference.
      const judged = yield* readTargetProgress(root, asOf);
      expect(judged.weeks.map((w) => w.targets.map((t) => [t.id, t.minimum, t.met]))).toEqual([
        [
          ["fictional-laps", 2, false],
          ["fictional-zone", 300, false],
        ],
        [
          ["fictional-laps", 2, true],
          ["fictional-zone", 300, false],
        ],
        [["fictional-zone", 300, true]],
      ]);
      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          expect([store.schemaVersion(), store.migrationRequired()]).toEqual([9, true]);
          expect(yield* failure(progressOf(store))).toMatch(/--migrate/);
          return (yield* store.request({ op: "export" })) as any;
        }),
      );
      expect(before.tables.weekly_targets.map((t: any) => t.minimum)).toEqual([2, 300]);
      const result = (yield* migrate(root)) as any;
      expect([result.migrated, result.from_version, result.schema_version]).toEqual([true, 9, 12]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          expect(yield* progressOf(store)).toEqual(judged);
          expect(yield* readTargetProgress(root, asOf)).toEqual(judged);
          const after = (yield* store.request({ op: "export" })) as any;
          // Every table and audit row is unchanged, so every revision is too; only the minimum is dated.
          for (const name of Object.keys(before.tables).filter((t) => t !== "weekly_targets"))
            expect(after.tables[name]).toEqual(migratedRows(name, before.tables[name]));
          expect(after.tables.weekly_targets).toEqual(
            before.tables.weekly_targets.map(({ minimum, ...t }: any) => ({
              ...t,
              minimums: [{ week_start: t.id === "fictional-laps" ? "2026-10-05" : "2026-09-28", minimum }],
            })),
          );
          const listed = ((yield* store.request({ op: "weekly_targets" })) as any).records;
          const audit = (id: string) =>
            Math.max(...before.tables.changes.filter((c: any) => c.entity_id === id).map((c: any) => c.id));
          expect(listed.map((t: any) => [t.id, t.revision])).toEqual([
            ["fictional-laps", audit("fictional-laps")],
            ["fictional-zone", audit("fictional-zone")],
          ]);
          expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 12 });
          // A version 9 export restores with the same history the migration records.
          const restored = yield* openStore(yield* tempDirectory);
          yield* restored.request({ op: "restore", snapshot: before });
          expect(yield* progressOf(restored)).toEqual(judged);
          expect(((yield* restored.request({ op: "export" })) as any).tables.weekly_targets).toEqual(
            after.tables.weekly_targets,
          );
        }),
      );
    }),
  );

  it.effect("version 7 migrates explicitly to 9: backed up first, everything kept, no target invented", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const dir = path.join(root, "data");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          yield* store.request({
            op: "ritual_put",
            date: "2026-10-05",
            patch: { protein: true },
            events: untimed("protein"),
            request_id: "before-8",
            source_text: SOURCE,
          });
        }),
      );
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) =>
        db.exec(
          WEEKLY_SQL +
            BEFORE_CHECK_TIMES_SQL +
            "DROP TABLE weekly_target_entries; DROP TABLE weekly_targets; DELETE FROM schema_migrations WHERE version>=8",
        ),
      );
      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          expect([store.schemaVersion(), store.migrationRequired()]).toEqual([7, true]);
          expect(yield* failure(store.request(addTarget(LAPS, "blocked")))).toMatch(/--migrate/);
          return (yield* store.request({ op: "export" })) as any;
        }),
      );
      const result = (yield* migrate(root)) as any;
      expect([result.migrated, result.from_version, result.schema_version]).toEqual([true, 7, 12]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(dir);
          const after = (yield* store.request({ op: "export" })) as any;
          for (const name of Object.keys(before.tables).filter((t) => t !== "weekly_reviews"))
            expect(after.tables[name]).toEqual(migratedRows(name, before.tables[name]));
          expect([after.tables.weekly_targets, after.tables.weekly_target_entries]).toEqual([[], []]);
          expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 12 });
          yield* store.request(addTarget(LAPS, "after-8"));
        }),
      );
    }),
  );

  it.effect("export and restore keep targets, entries and their audit", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.request(log({ target_id: "fictional-laps", date: "2026-10-12", logged_by: "owner" }, "log:x"));
      const snapshot = (yield* store.request({ op: "export" })) as any;
      expect([snapshot.tables.weekly_targets.length, snapshot.tables.weekly_target_entries.length]).toEqual([2, 1]);
      expect(snapshot.tables.weekly_targets[0].active).toBe(true);
      const restored = yield* openStore(yield* tempDirectory);
      expect(((yield* restored.request({ op: "restore", snapshot })) as any).data_sha256).toBe(snapshot.data_sha256);
      expect(yield* progressOf(restored)).toEqual(yield* progressOf(store));
    }),
  );

  it.effect("ritualctl --help lists every request and the weekly-target templates; targets work end to end", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      const help = ritualctl(root, ["--help"]);
      expect(help.status).toBe(0);
      expect(help.json.usage).toContain("--help");
      for (const op of ["target_add", "target_log", "target_entry_remove", "correct"])
        expect(Object.keys(help.json.writes)).toContain(op);
      for (const op of ["weekly_targets", "weekly_target_entries", "weekly_progress"])
        expect(Object.keys(help.json.reads)).toContain(op);
      expect(Object.keys(help.json.weekly_targets)).toEqual(
        expect.arrayContaining(["units", "add", "log", "list", "undo", "edit_entry", "edit_target", "retire"]),
      );
      // Every template in the help is one JSON request.
      for (const key of ["add", "log", "undo", "edit_entry", "edit_target"])
        expect(JSON.parse(help.json.weekly_targets[key].replace(/ \(.*\)$/, "")).op).toMatch(/^(target_|correct)/);
      expect(ritualctl(root, ["--init"]).status).toBe(0);
      const added = ritualctl(root, [], addTarget(ZONE, "cli:zone"));
      expect([added.status, added.json.record.minimums, added.json.dashboard.updated]).toEqual([
        0,
        [{ week_start: "2026-10-05", minimum: 300 }],
        true,
      ]);
      const logged = ritualctl(
        root,
        [],
        log({ target_id: "fictional-zone", date: "2026-10-12", amount: "1.5h", logged_by: "o" }, "cli:log"),
      );
      expect([logged.status, logged.json.record.amount]).toEqual([0, 90]);
      const unknown = ritualctl(root, [], { op: "target_list" });
      expect([unknown.status, unknown.json.error]).toEqual([1, expect.stringContaining("--help")]);
      // The weekly snapshot shows the targets.
      const snapshot = fs.readFileSync(path.join(root, "data", "views", "weekly-targets.html"), "utf8");
      expect(snapshot.indexOf('<section class="targets"')).toBeGreaterThan(0);
      expect(snapshot).not.toContain("<table");
    }),
  );
});
