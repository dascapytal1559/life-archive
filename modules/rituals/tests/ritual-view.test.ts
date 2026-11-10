// bin/ritual-view prints the dashboard's own projections and never writes: not the store, its mode or data/views.
import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generate } from "../src/dashboard.ts";
import { dashboardTargets, readTargetsData } from "../src/dashboardWeb.ts";
import { openStore } from "../src/store.ts";
import { readView, VIEW_FORMAT } from "../src/view.ts";
import { parseDateTime, ritualDate } from "../src/instants.ts";
import { BEFORE_CHECK_TIMES_SQL, BUNDLE, mode, NODE_MODULES, REPO, tempDirectory, withDatabase } from "./helpers/fixtures.ts";

// Today's logical date, so the fixture's target entry is always in the current week.
const TODAY = ritualDate(Date.now() * 1000);

/** A throwaway installation: the real bin/ wrappers, a copy of the repository's sources and a store built from the fixtures. */
const installation = Effect.gen(function* () {
  const root = yield* tempDirectory;
  fs.mkdirSync(path.join(root, "bin"));
  for (const name of ["node.sh", "ritual-view"])
    fs.copyFileSync(path.join(REPO, "bin", name), path.join(root, "bin", name));
  // A copy, not a symlink: ROOT is resolved from the real path of src/ (with no config/root beside it), and the store must be this one.
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.symlinkSync(NODE_MODULES, path.join(root, "node_modules"));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openStore(path.join(root, "data"));
      yield* store.request({ op: "import", bundle: BUNDLE });
      yield* store.request({
        op: "ritual_put",
        date: "2026-09-30",
        patch: {},
        events: [
          { habit: "magnesium", done_at: null, basis: "unknown" },
          { habit: "protein", done_at: "2026-09-30T21:05:00+10:00", basis: "user_stated" },
        ],
        request_id: "view-events",
        source_text: "Test fixture only",
      });
      yield* store.request({
        op: "target_add",
        record: { id: "fictional-target", name: "Fictional target", unit: "minutes", minimum: "5h", start_date: TODAY },
        request_id: "view-target",
        source_text: "Test fixture only",
      });
      yield* store.request({
        op: "target_log",
        record: {
          target_id: "fictional-target",
          date: TODAY,
          amount: "1h30m",
          note: "Fictional entry note",
          logged_by: "fictional assistant",
        },
        request_id: "view-target-log",
        source_text: "Test fixture only",
      });
      for (const [id, ritual, role, start_date, end_date] of [
        ["fictional-review", "morning", "required_check", "2026-09-28", "2026-09-30"],
        ["fictional-note", "noon", "reminder_only", TODAY, null],
        ["fictional-parked", "evening", "required_check", "9999-12-31", "9999-12-31"],
      ] as const)
        yield* store.request({
          op: "attachment_add",
          record: { id, ritual, text: `Fictional ${id}`, start_date, end_date, role },
          request_id: `view-${id}`,
          source_text: "Test fixture only",
        });
      yield* store.request({
        op: "attachment_check",
        attachment_id: "fictional-review",
        date: "2026-09-29",
        done: true,
        done_at: "2026-09-29T07:30:00+10:00",
        basis: "user_stated",
        request_id: "view-tick",
        source_text: "Test fixture only",
      });
      yield* store.request({
        op: "attachment_check",
        attachment_id: "fictional-review",
        date: "2026-09-28",
        done: false,
        request_id: "view-not-done",
        source_text: "Test fixture only",
      });
    }),
  );
  return root;
});

const run = (root: string, ...args: Array<string>) => {
  const result = spawnSync("/bin/sh", [path.join(root, "bin", "ritual-view"), ...args], {
    env: { RITUAL_NODE: process.execPath, PATH: "/usr/bin:/bin", RITUAL_TIME_ZONE: process.env.RITUAL_TIME_ZONE },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, json: JSON.parse(result.stdout) };
};

/** A value as the dashboard's routes sent it: through JSON. */
const asJson = (value: unknown): any => JSON.parse(JSON.stringify(value));

/** The two clock stamps are the only fields that differ between reads a moment apart. */
const unstamped = ({ generated_at: _g, updated_display: _u, ...rest }: any) => rest;

/** A day's five marks as the dashboard shows them, in its order: magnesium, protein, stretching, plank, journalling. */
const marks = (row: any): string =>
  Object.values(row.cells)
    .map((cell: any) => cell.text)
    .join(" ");

/** Each rate's done and denominator, to set against a count made by hand from the fixture. */
const tally = (rates: Record<string, { done: number; denominator: number }>) =>
  Object.fromEntries(Object.entries(rates).map(([name, rate]) => [name, [rate.done, rate.denominator]]));

const at = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;

/** Every file under a folder with its modification time, to prove nothing was written or touched. */
const mtimes = (folder: string): Record<string, number> =>
  Object.fromEntries(
    fs
      .readdirSync(folder, { recursive: true, encoding: "utf8" })
      .map((name) => [name, fs.statSync(path.join(folder, name)).mtimeMs]),
  );

layer(NodeServices.layer, { excludeTestServices: true })("ritual view", (it) => {
  it.effect("the daily part is the fixture's days and marks; events follow in Melbourne time", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      const outcome = run(root);
      expect(outcome.status).toBe(0);
      expect(Object.keys(outcome.json)).toEqual(["format", "daily", "events", "weekly_targets", "attachments"]);
      expect([outcome.json.format, VIEW_FORMAT]).toEqual([7, 7]);
      const { daily } = outcome.json;
      expect(daily.generated_at).toBe(outcome.json.weekly_targets.generated_at);
      expect(daily.timezone).toBe("Australia/Melbourne");
      // 23 August to 30 September, newest first, the days nothing was reported on among them.
      expect(daily.count).toBe(39);
      expect(daily.rows).toHaveLength(39);
      expect([daily.rows[0].date, daily.rows[38].date]).toEqual(["2026-09-30", "2026-08-23"]);
      const day = (date: string) => daily.rows.find((row: any) => row.date === date);
      expect(day("2026-09-30")).toEqual({
        date: "2026-09-30",
        display_date: "Wed · Sep 30",
        full_date: "Wednesday, 30 September 2026",
        period: "closed",
        annotation: "",
        checkin_times: [
          {
            datetime: "2026-09-30T22:55:00+10:00",
            text: "22:55",
            day_offset: 0,
            day_label: "",
            basis: "source_recorded",
            label: "30 Sep 2026, 22:55:00 AEST · Evening check-in recorded in the imported source",
          },
        ],
        cells: {
          magnesium: { status: "done", basis: "explicit_report", text: "✓", label: "Done", numeric: false },
          protein: { status: "done", basis: "explicit_report", text: "✓", label: "Done", numeric: false },
          stretching: { status: "not_done", basis: "missing_after_close", text: "×", label: "Not done", numeric: false },
          planks: { status: "done", basis: "explicit_report", text: "1:06", label: "66 seconds", numeric: true },
          journalling: { status: "not_done", basis: "missing_after_close", text: "×", label: "Not done", numeric: false },
          wind_down: { status: "not_applicable", basis: "not_started", text: "N/A", label: "Not applicable", numeric: false },
        },
        workouts: { labels: [], count: 0, items: [] },
      });
      expect(
        ["2026-09-25", "2026-09-17", "2026-09-16", "2026-08-24", "2026-08-23"].map((date) => [date, marks(day(date))]),
      ).toEqual([
        ["2026-09-25", "✓ × × × × N/A"],
        ["2026-09-17", "× × × × × N/A"],
        ["2026-09-16", "× ✓ × × × N/A"],
        ["2026-08-24", "✓ ✓ × × × N/A"],
        ["2026-08-23", "× × ✓ × × N/A"],
      ]);
      expect(["2026-09-17", "2026-09-18", "2026-08-25"].map((date) => day(date).annotation)).toEqual([
        "",
        "No report",
        "Activities only",
      ]);
      expect(day("2026-08-25").workouts).toEqual({
        labels: ["walk"],
        count: 1,
        items: [{ type: "walk", details: "Fictional free-text details." }],
      });
      // 24 August's first check-in came at 01:01 on the 25th: before 06:00, so it is the 24th's, a day after its date.
      expect(day("2026-08-24").checkin_times).toEqual([
        {
          datetime: "2026-08-25T01:01:00+10:00",
          text: "01:01",
          day_offset: 1,
          day_label: "+1 day",
          basis: "source_recorded",
          label: "25 Aug 2026, 01:01:00 AEST · Evening check-in recorded in the imported source",
        },
      ]);
      expect(day("2026-08-25").checkin_times).toEqual([]);
      // Counted by hand from the bundle: every one of the 39 days is closed, and a day with two workouts counts once.
      expect(tally(daily.rates)).toEqual({
        magnesium: [4, 39],
        protein: [6, 39],
        stretching: [2, 39],
        planks: [1, 39],
        journalling: [0, 39],
        wind_down: [0, 0],
        workout: [9, 39],
      });
      expect(daily.rates.magnesium.percentage).toBeCloseTo(10.26, 2);
      expect(daily.rates.journalling.percentage).toBe(0);
      expect(daily.rates.workout.percentage).toBeCloseTo(23.08, 2);
      // Known times first, then unknown ones, within a logical date; no audit or source text.
      expect(outcome.json.events.map(({ id: _id, ...rest }: any) => rest)).toEqual([
        { date: "2026-09-30", habit: "protein", done_at: "2026-09-30T21:05:00+10:00", basis: "user_stated" },
        { date: "2026-09-30", habit: "magnesium", done_at: null, basis: "unknown" },
      ]);
      expect(outcome.json.events.every((e: any) => /^he_[0-9a-f]{24}$/.test(e.id))).toBe(true);
      expect(outcome.stdout).not.toContain("Test fixture");
      expect(outcome.stdout).not.toContain("Fictional note: topic placeholder.");
    }),
  );

  it.effect("a day stays open until 06:00 the next morning in Melbourne, and only then counts", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      const before = (yield* readView(root, at("2026-10-01T05:59:59+10:00"))).daily;
      const after = (yield* readView(root, at("2026-10-01T06:00:00+10:00"))).daily;
      const [open, closed] = [before.rows[0] as any, after.rows[0] as any];
      expect([open.date, open.period, open.annotation]).toEqual(["2026-09-30", "open", "Open"]);
      expect(marks(open)).toBe("✓ ✓ · 1:06 · N/A");
      expect(open.cells.stretching).toEqual({
        status: "unreported",
        basis: "open_day",
        text: "·",
        label: "Open — not reported",
        numeric: false,
      });
      expect(tally(before.rates)).toEqual({
        magnesium: [3, 38],
        protein: [5, 38],
        stretching: [2, 38],
        planks: [0, 38],
        journalling: [0, 38],
        wind_down: [0, 0],
        workout: [9, 38],
      });
      expect([closed.date, closed.period, closed.annotation]).toEqual(["2026-09-30", "closed", ""]);
      expect(marks(closed)).toBe("✓ ✓ × 1:06 × N/A");
      expect(tally(after.rates)).toEqual({
        magnesium: [4, 39],
        protein: [6, 39],
        stretching: [2, 39],
        planks: [1, 39],
        journalling: [0, 39],
        wind_down: [0, 0],
        workout: [9, 39],
      });
    }),
  );

  it.effect("weekly_targets is the dashboard's targets' progress plus each entry's note and who logged it", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      const targets = run(root).json.weekly_targets;
      expect(Object.keys(targets)).toEqual([
        "generated_at",
        "updated_display",
        "timezone",
        "active_date",
        "current_week",
        "weeks",
      ]);
      expect(targets.weeks[0].current).toBe(true);
      expect(targets.weeks[0].week_start).toBe(targets.current_week);
      expect(targets.weeks).toHaveLength(1);
      // 1h30m logged against a 5h minimum: 90 of 300 minutes, three tenths of the way, 210 still to do.
      expect(targets.weeks[0].targets[0]).toMatchObject({
        id: "fictional-target",
        unit: "minutes",
        minimum: 300,
        total: 90,
        remaining: 210,
        met: false,
        fraction: 0.3,
        total_text: "1h 30m",
        minimum_text: "5h",
        remaining_text: "3h 30m",
        progress_text: "1h 30m / 5h",
      });
      expect(targets.weeks[0].targets[0].entries[0]).toMatchObject({
        date: TODAY,
        amount: 90,
        amount_text: "1h 30m",
        note: "Fictional entry note",
        logged_by: "fictional assistant",
      });
      const api = asJson(dashboardTargets(yield* readTargetsData(root)));
      const strip = (data: any) => ({
        ...unstamped(data),
        weeks: data.weeks.map((w: any) => ({
          ...w,
          targets: w.targets.map(({ entries_text: _t, ...t }: any) => ({
            ...t,
            entries: t.entries.map(({ note: _n, logged_by: _l, ...e }: any) => e),
          })),
        })),
      });
      expect(strip(api)).toEqual(strip(targets));
      expect(JSON.stringify(api)).not.toContain("Fictional entry note");
      expect(JSON.stringify(api)).not.toContain("fictional assistant");
    }),
  );

  it.effect("attachments are every started item with its marks by day, newest first, and nothing private", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      const outcome = run(root);
      const { active_date, items } = outcome.json.attachments;
      expect(active_date).toBe(TODAY);
      // The parked item has not started, so it has no days and is not shown.
      expect(items.map((item: any) => [item.ritual, item.id, item.active])).toEqual([
        ["morning", "fictional-review", false],
        ["noon", "fictional-note", true],
      ]);
      expect(items[0]).toEqual({
        id: "fictional-review",
        ritual: "morning",
        text: "Fictional fictional-review",
        role: "required_check",
        start_date: "2026-09-28",
        end_date: "2026-09-30",
        weekday: null,
        active: false,
        days: [
          {
            date: "2026-09-30",
            display_date: "Wed · Sep 30",
            full_date: "Wednesday, 30 September 2026",
            status: "unreported",
            text: "·",
            label: "Not reported",
            done_at: null,
            basis: null,
          },
          {
            date: "2026-09-29",
            display_date: "Tue · Sep 29",
            full_date: "Tuesday, 29 September 2026",
            status: "done",
            text: "✓",
            label: "Done",
            done_at: "2026-09-29T07:30:00+10:00",
            basis: "user_stated",
          },
          {
            date: "2026-09-28",
            display_date: "Mon · Sep 28",
            full_date: "Monday, 28 September 2026",
            status: "not_done",
            text: "×",
            label: "Not done",
            done_at: null,
            basis: null,
          },
        ],
      });
      expect(items[1].days).toHaveLength(1);
      expect(items[1].days[0]).toMatchObject({
        date: TODAY,
        status: "reminder_only",
        text: "",
        label: "Reminder only, no tick",
        done_at: null,
        basis: null,
      });
      expect(JSON.stringify(outcome.json.attachments)).not.toMatch(/revision|check_id|source_text/);
      // A morning's item reads on a date the daily rows do not reach yet, with labels of its own.
      expect(outcome.json.daily.rows.map((row: any) => row.date)).not.toContain(TODAY);
      expect(items[1].days[0].display_date).toMatch(/^[A-Z][a-z]{2} · /);
      // The daily part stays the dashboard's: an item is never a habit cell.
      expect(Object.keys(outcome.json.daily.rows[0].cells)).toEqual([
        "magnesium",
        "protein",
        "stretching",
        "planks",
        "journalling",
        "wind_down",
      ]);
    }),
  );

  it.effect("reads a store not yet migrated to version 11: its ticks have no time", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      withDatabase(path.join(root, "data", "ritual.sqlite3"), (db) => db.exec(BEFORE_CHECK_TIMES_SQL));
      const outcome = run(root);
      expect(outcome.status).toBe(0);
      const day = outcome.json.attachments.items[0].days[1];
      expect([day.status, day.done_at, day.basis]).toEqual(["done", null, "unknown"]);
    }),
  );

  it.effect("works on a mode-0400 store and leaves the store and data/views untouched", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      const data = path.join(root, "data");
      const database = path.join(data, "ritual.sqlite3");
      yield* generate(root);
      fs.chmodSync(database, 0o400);
      const before = mtimes(data);
      expect(Object.keys(before)).toContain(path.join("views", "ritual-dashboard.html"));
      const outcome = run(root);
      expect(outcome.status).toBe(0);
      expect(outcome.json.daily.count).toBeGreaterThan(0);
      expect(mode(database)).toBe(0o400);
      expect(mtimes(data)).toEqual(before);
    }),
  );

  it.effect("the first line of config/root names the store's root, and nothing is made beside the code", () =>
    Effect.gen(function* () {
      const store = yield* installation;
      const code = yield* tempDirectory;
      for (const folder of ["bin", "src"])
        fs.cpSync(path.join(store, folder), path.join(code, folder), { recursive: true });
      fs.symlinkSync(NODE_MODULES, path.join(code, "node_modules"));
      fs.mkdirSync(path.join(code, "config"));
      fs.writeFileSync(path.join(code, "config", "root"), `${store}\nnot this line\n`);
      const outcome = run(code);
      expect(outcome.status).toBe(0);
      expect(outcome.json.daily.count).toBe(39);
      expect(fs.existsSync(path.join(code, "data"))).toBe(false);
    }),
  );

  it.effect("refuses any argument", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      for (const args of [["--init"], ["--migrate"], [""], ["a", "b"]]) {
        const outcome = run(root, ...args);
        expect(outcome.status).toBe(1);
        expect(outcome.json).toEqual({ ok: false, error: "Usage: ritual-view" });
      }
    }),
  );

  it.effect("a missing store is an error, never a new empty one", () =>
    Effect.gen(function* () {
      const root = yield* installation;
      fs.rmSync(path.join(root, "data"), { recursive: true });
      const outcome = run(root);
      expect(outcome.status).toBe(1);
      expect(outcome.json.ok).toBe(false);
      expect(fs.existsSync(path.join(root, "data"))).toBe(false);
    }),
  );
});
