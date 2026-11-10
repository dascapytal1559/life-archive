import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { type ExceptionRow, statusReport } from "../src/applicability.ts";
import * as dashboard from "../src/dashboard.ts";
import type { Records } from "../src/dashboard.ts";
import * as dashboardWeb from "../src/dashboardWeb.ts";
import { parseDateTime } from "../src/instants.ts";
import { progress as targetProgress } from "../src/weeklyTargets.ts";
import { count } from "./helpers/html.ts";

const at = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;
const fixture = (exceptions: ReadonlyArray<ExceptionRow> = []): Records => ({
  rituals: [
    { date: "2026-10-03", magnesium: null, protein: null, stretching: null, journalling: null, plank_seconds: null },
    { date: "2026-10-04", magnesium: 1, protein: 0, stretching: 1, journalling: null, plank_seconds: 60 },
  ],
  workouts: [
    { id: "a", date: "2026-10-03", type: "run", details: "Fictional 5 km easy" },
    { id: "b", date: "2026-10-03", type: "gym pull", details: "" },
  ],
  exceptions,
});
const data = (records: Records, stamp: string) => Result.getOrThrow(dashboardWeb.dashboardData(records, at(stamp)));

describe("dashboard web", () => {
  it("only the dashboard projection is returned", () => {
    const result = data(fixture(), "2026-10-05T12:00:00+11:00");
    expect(new Set(Object.keys(result))).toEqual(
      new Set(["generated_at", "updated_display", "timezone", "count", "rates", "rows"]),
    );
    expect(new Set(Object.keys(result.rows[0]!))).toEqual(
      new Set(["date", "display_date", "full_date", "period", "annotation", "cells", "workouts", "checkin_times"]),
    );
    const forbidden = new Set([
      "notes",
      "checkins",
      "source_text",
      "sources",
      "source_documents",
      "raw",
      "revision",
      "request_id",
      "details",
      "exception_id",
    ]);
    const check = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(check);
      else if (typeof value === "object" && value !== null) {
        for (const key of Object.keys(value)) expect(forbidden.has(key)).toBe(false);
        Object.values(value).forEach(check);
      }
    };
    // Workout details are the one deliberate exception, and only as type+details pairs for the owner's pop-up.
    for (const row of result.rows) {
      expect(new Set(Object.keys(row.workouts))).toEqual(new Set(["labels", "count", "items"]));
      for (const item of row.workouts.items) expect(Object.keys(item).toSorted()).toEqual(["details", "type"]);
      check({ ...row, workouts: { labels: row.workouts.labels, count: row.workouts.count } });
    }
    check({ ...result, rows: [] });
    expect(result.rates.workout).toEqual({ done: 1, denominator: 2, percentage: 50 });
    expect(result.rows[1]!.workouts.count).toBe(2);
  });

  it("each day lists its own workouts in order with their full details", () => {
    const result = data(fixture(), "2026-10-05T12:00:00+11:00");
    const byDate = Object.fromEntries(result.rows.map((r) => [r.date, r.workouts]));
    expect(byDate["2026-10-03"]).toEqual({
      labels: ["run", "gym pull"],
      count: 2,
      items: [
        { type: "run", details: "Fictional 5 km easy" },
        { type: "gym pull", details: "" },
      ],
    });
    expect(byDate["2026-10-04"]).toEqual({ labels: [], count: 0, items: [] });
  });

  it("the workout pop-up is text-only and lives on the live daily page alone", () => {
    const daily = dashboardWeb.frontend("daily");
    expect(count(daily, "<dialog")).toBe(1);
    expect(daily).toContain('<dialog id="workout-dialog"');
    expect(dashboardWeb.frontend("weekly")).not.toContain("<dialog");
    const script = dashboardWeb.SCRIPTS.daily;
    expect(script).toContain("dialog.showModal()");
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // The static snapshot never carries details: it has no script to open a pop-up.
    const records = fixture();
    const stamp = at("2026-10-05T12:00:00+11:00");
    const report = Result.getOrThrow(statusReport(records.rituals, records.workouts, [], stamp));
    const snapshot = Result.getOrThrow(
      dashboard.render(dashboard.matrix(records.rituals, records.workouts), stamp, report),
    );
    expect(snapshot).not.toContain("Fictional 5 km easy");
    expect(snapshot).not.toContain("<dialog");
  });

  it("the 06:00 cutoff and DST are computed on each request", () => {
    const before = data(fixture(), "2026-10-04T05:59:59+11:00");
    const after = data(fixture(), "2026-10-04T06:00:00+11:00");
    expect(before.rows[1]!.period).toBe("open");
    expect(before.rows[1]!.cells.magnesium.status).toBe("unreported");
    expect(before.rates.workout!.percentage).toBeNull();
    expect(after.rows[1]!.period).toBe("closed");
    expect(after.rows[1]!.cells.magnesium.status).toBe("not_done");
    expect(after.rates.workout!.percentage).toBe(100);
  });

  it("complete open day is a plain closed day on both dashboards; incomplete is not", () => {
    const records = fixture();
    const complete: Records = {
      ...records,
      rituals: [
        records.rituals[0]!,
        { date: "2026-10-04", magnesium: 1, protein: 1, stretching: 1, journalling: 1, plank_seconds: 60 },
      ],
    };
    const stamp = "2026-10-05T05:59:59+11:00";
    const closed = data(complete, stamp);
    expect([closed.rows[0]!.period, closed.rows[0]!.annotation]).toEqual(["closed", ""]);
    expect(closed.rates.protein).toEqual({ done: 1, denominator: 2, percentage: 50 });
    expect(closed.rates.workout).toEqual({ done: 1, denominator: 2, percentage: 50 });
    const open = data(records, stamp);
    expect(open.rows[0]!.annotation).toBe("Open");
    expect(open.rates.protein).toEqual({ done: 0, denominator: 1, percentage: 0 });
    expect(open.rates.workout).toEqual({ done: 1, denominator: 1, percentage: 100 });
    const snapshot = (r: Records) =>
      Result.getOrThrow(
        dashboard.render(
          dashboard.matrix(r.rituals, r.workouts),
          at(stamp),
          Result.getOrThrow(statusReport(r.rituals, r.workouts, [], at(stamp))),
        ),
      );
    expect(snapshot(complete)).toContain('<tr data-date="2026-10-04" data-period="closed">');
    expect(snapshot(complete)).not.toContain('class="open-badge"');
    expect(snapshot(complete)).toContain('title="1 of 2 closed days with a recorded workout"');
    expect(snapshot(records)).toContain('<small class="open-badge">Open</small>');
  });

  it("exceptions and open days stay out of the denominator", () => {
    const exceptions: Array<ExceptionRow> = [
      { id: "example", habit: "magnesium", start_date: "2026-10-03", end_date: "2026-10-03", reason: "Test" },
    ];
    const result = data(fixture(exceptions), "2026-10-04T12:00:00+11:00");
    expect(result.rows[1]!.cells.magnesium.status).toBe("not_applicable");
    expect(result.rates.magnesium!.percentage).toBeNull();
  });

  it("the days an exception with no start covers are before the habit's routine; a gap with a start is still a gap", () => {
    const exceptions: Array<ExceptionRow> = [
      { id: "open", habit: "planks", start_date: null, end_date: "2026-10-03", reason: "Not yet started" },
      { id: "gap", habit: "magnesium", start_date: "2026-10-03", end_date: "2026-10-03", reason: "Travel" },
    ];
    const [first, second] = data(fixture(exceptions), "2026-10-04T12:00:00+11:00").rows;
    // Both are not applicable, but only the before-start one says it had not started; the rows' order is newest first.
    const [past, later] = first!.date < second!.date ? [first!, second!] : [second!, first!];
    expect(past.cells.planks).toMatchObject({ status: "not_applicable", basis: "not_started" });
    expect(past.cells.magnesium).toMatchObject({ status: "not_applicable", basis: "exception" });
    expect(later.cells.planks!.basis).not.toBe("not_started");
  });

  it("both dashboards have wind-down's column, by the console's name: the snapshot draws its days, before it began not asked", () => {
    const records: Records = {
      rituals: [
        { date: "2026-11-08", magnesium: 1, protein: 1, stretching: 1, journalling: 1, plank_seconds: 60, wind_down: null },
        { date: "2026-11-09", magnesium: 1, protein: 1, stretching: 1, journalling: 1, plank_seconds: 60, wind_down: 1 },
        { date: "2026-11-10", magnesium: 1, protein: 0, stretching: 1, journalling: 1, plank_seconds: 60, wind_down: 0 },
      ],
      workouts: [],
      exceptions: [],
    };
    const stamp = at("2026-11-11T12:00:00+11:00");
    const report = Result.getOrThrow(statusReport(records.rituals, records.workouts, [], stamp));
    const snapshot = Result.getOrThrow(dashboard.render(dashboard.matrix(records.rituals, records.workouts), stamp, report));
    const windDownCell = (day: string) => new RegExp(`<tr data-date="${day}"[^>]*>.*?<td data-field="wind_down" data-status="([a-z_]+)"><span[^>]*title="([^"]*)"`, "s").exec(snapshot)!.slice(1);
    expect(windDownCell("2026-11-08")).toEqual(["not_applicable", "Not applicable: Before the habit joined the ritual"]);
    expect(windDownCell("2026-11-09")[0]).toBe("done");
    expect(windDownCell("2026-11-10")[0]).toBe("not_done");
    expect(snapshot).toMatch(/<th class="check-col" scope="col">Winding down before midnight <span class="header-metric">\(<span data-rate-habit="wind_down" title="1 of 2 applicable closed days">50\.0%<\/span>/);
    expect(count(snapshot, 'data-field="wind_down"')).toBe(3);
    const live = dashboardWeb.frontend("daily");
    expect(live).toContain('<th class="check-col" scope="col">Winding down before midnight<span class="header-metric">(<span data-rate="wind_down">');
    expect(live).not.toContain("Wind-down");
    expect(dashboardWeb.SCRIPTS.daily).toContain('const habits = ["magnesium","protein","stretching","planks","journalling","wind_down"];');
  });

  it("frontend has no record data or unsafe HTML sink", () => {
    for (const [ritual, name, url] of [
      ["daily", "Daily rituals", "api/dashboard"],
      ["weekly", "Weekly targets", "api/targets"],
    ] as const) {
      const page = dashboardWeb.frontend(ritual);
      expect(page).toContain(`load('${url}', render)`);
      expect(page).toContain("connect-src &#x27;self&#x27;");
      expect(page).toContain(dashboardWeb.scriptHash(dashboardWeb.SCRIPTS[ritual]));
      expect(dashboardWeb.SCRIPTS[ritual]).not.toContain("innerHTML");
      expect(page).toContain(`<h1>${name}</h1>`);
      expect(page).toContain(`<title>${name}</title>`);
      expect(count(page, "<select")).toBe(1);
      expect(page).toContain(
        '<option value="./"' +
          (ritual === "daily" ? " selected" : "") +
          '>Daily rituals</option><option value="weekly"' +
          (ritual === "weekly" ? " selected" : "") +
          ">Weekly targets</option>",
      );
      expect(page).not.toContain("2026-");
    }
    expect(dashboardWeb.frontend("daily")).toContain("Date<span");
    expect(dashboardWeb.frontend("weekly")).not.toContain("<table");
  });

  it("the weekly page shows only targets: live from api/targets, and in the snapshot, as text", () => {
    const weekly = dashboardWeb.frontend("weekly");
    expect(weekly).not.toContain("api/weekly");
    expect(weekly).toMatch(/<section class="targets" id="targets" aria-labelledby="targets-title" hidden>/);
    expect(dashboardWeb.frontend("daily")).not.toContain("api/targets");
    const target = (met: boolean, total: number) => ({
      id: "fictional",
      name: "Fictional <b>target</b>",
      unit: "minutes" as const,
      noun: null,
      minimum: 300,
      active: true,
      position: 0,
      total,
      remaining: Math.max(0, 300 - total),
      met,
      fraction: Math.min(1, total / 300),
      total_text: "",
      minimum_text: "5h",
      remaining_text: met ? "0m" : "1h 40m",
      progress_text: met ? "5h / 5h" : "3h 20m / 5h",
      entries: [
        {
          id: "e",
          date: "2026-10-13",
          display_date: "Tue 13",
          amount: total,
          amount_text: "x",
          note: "Fictional note",
          logged_by: "o",
        },
      ],
    });
    const week = (start: string, current: boolean, met: boolean, total: number) => ({
      week_start: start,
      week_end: "",
      display: start,
      full: start,
      current,
      met: met ? 1 : 0,
      targets: [target(met, total)],
    });
    const progress = {
      active_date: "2026-10-14",
      current_week: "2026-10-12",
      weeks: [week("2026-10-12", true, false, 200), week("2026-10-05", false, true, 300)],
    };
    const page = dashboard.renderWeekly(progress, at("2026-10-14T10:00:00+11:00"));
    expect(page).not.toContain("<table");
    expect(page).toContain(`<p class="empty" hidden>${dashboard.TARGETS_EMPTY}</p>`);
    expect(page).toContain("Fictional &lt;b&gt;target&lt;/b&gt;");
    expect(page).toContain('<p class="target-count">3h 20m / 5h</p>');
    expect(page).toContain('aria-valuenow="67"');
    expect(page).toContain("1h 40m to go");
    expect(page).toContain('<li class="mark done" title="2026-10-05: 5h / 5h, met"');
    expect(page).toContain("0 of 1 met");
    expect(page).not.toContain("Fictional note");
    // No current-week target, no section but the empty message; earlier weeks alone never bring it back.
    const empty = dashboard.renderWeekly({ ...progress, weeks: [progress.weeks[1]!] }, at("2026-10-14T10:00:00+11:00"));
    expect(empty).not.toContain('<section class="targets"');
    expect(empty).toContain(`<p class="empty">${dashboard.TARGETS_EMPTY}</p>`);
  });

  it("a fish target draws one fish per fish of the minimum, filled as they're logged, instead of a bar", () => {
    // Keyed by the count noun, not the name: the minutes target beside it keeps its bar, and a renamed target keeps fish.
    const targets = [
      {
        id: "fictional-fish",
        name: "Fictional renamed target",
        unit: "count" as const,
        noun: "fish",
        minimums: [{ week_start: "2026-10-12", minimum: 3 }],
        start_date: "2026-10-12",
        active: true,
        position: 0,
      },
      {
        id: "fictional-easy",
        name: "Fictional easy minutes",
        unit: "minutes" as const,
        noun: null,
        minimums: [{ week_start: "2026-10-12", minimum: 300 }],
        start_date: "2026-10-12",
        active: true,
        position: 1,
      },
    ];
    const fish = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `f${i}`,
        target_id: "fictional-fish",
        date: "2026-10-13",
        amount: 1,
        note: null,
        logged_by: "fictional",
      }));
    const icons = (n: number) => {
      const page = dashboard.renderWeekly(
        targetProgress(targets, fish(n), "2026-10-14"),
        at("2026-10-14T10:00:00+11:00"),
      );
      const row = /<div class="target-icons" role="progressbar"[^>]*>(.*?)<\/div>/.exec(page);
      expect(row).not.toBeNull();
      expect(count(page, 'class="target-bar"')).toBe(1);
      return [...row![1]!.matchAll(/class="target-icon( logged)?"/g)].map((m) => (m[1] ? "■" : "□")).join("");
    };
    expect(icons(0)).toBe("□□□");
    expect(icons(1)).toBe("■□□");
    expect(icons(3)).toBe("■■■");
    expect(icons(5)).toBe("■■■■■");
    const page = dashboard.renderWeekly(
      targetProgress(targets, fish(2), "2026-10-14"),
      at("2026-10-14T10:00:00+11:00"),
    );
    expect(page).toContain('aria-valuenow="67" aria-valuetext="2 / 3 fish"');
    expect(page).toContain(`d="${dashboard.TARGET_ICONS.fish}"`);
    expect(page).not.toMatch(/<(img|use|image)\b|href="http/);
    expect(dashboard.targetIcon({ unit: "count", noun: "laps" })).toBeUndefined();
    expect(dashboard.targetIcon({ unit: "count", noun: "constructor" })).toBeUndefined();
    // The live page carries the same icons and draws the same row from api/targets.
    expect(dashboardWeb.frontend("weekly")).toContain(JSON.stringify(dashboard.TARGET_ICONS));
  });

  it("live pages resolve every address relative to where they are mounted", () => {
    // Tailscale Serve strips a path mount (/rituals) before proxying, so the server sees / either way; a root-anchored
    // link, fetch or redirect in the page would leave the mount.
    for (const ritual of ["daily", "weekly"] as const) {
      const page = dashboardWeb.frontend(ritual);
      expect(page.match(/(?:value|href|src|action)="[^"]*"/g)).toEqual(['value="./"', 'value="weekly"']);
      expect(page).not.toMatch(/['"`]\/(?:api|weekly)/);
      expect(page).not.toContain("location.href");
    }
    // Only the base page adds its missing trailing slash, before its first relative fetch.
    const daily = dashboardWeb.SCRIPTS.daily;
    expect(daily.startsWith("if (!location.pathname.endsWith('/')) history.replaceState(")).toBe(true);
    expect(daily.indexOf("history.replaceState")).toBeLessThan(daily.indexOf("load('api/dashboard'"));
    expect(dashboardWeb.SCRIPTS.weekly).not.toContain("history");
  });
});
