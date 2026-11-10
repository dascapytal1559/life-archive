// Daily rituals' whole run, on rituals' made-up store (../fixtures/rituals.ts, its day Thursday 15 October 2026, as
// dots.test.ts has it) and on made-up spans of days: which days fit a width at three pixels a day or wider, the dates the
// axis names, its marks on the run (a grey dot for a day not asked, a not done for a closed day with no answer) and its
// count over the closed days shown, no answer counting as not done, never today. The days run newest first: yesterday at the left, beside today.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { madeUpRitualsView, writeMadeUpRituals } from "../fixtures/rituals.ts";
import { ritualsDashboard } from "../server/dashboard.ts";
import { viewOf } from "../server/view.ts";
import { openStore } from "../src/store.ts";
import type { RitualsDashboard } from "../wire.ts";
import { checkRow, daySlots, daySpan, habitRow, runningChecks } from "./dots.ts";
import { axisLabels, fitDays, MIN_DAY_PX, runCount, runMark, runWords } from "./run.ts";

const NOW = Date.parse("2026-10-15T10:00:00Z");
let dashboard: RitualsDashboard;
let today: string;

beforeAll(async () => {
  dashboard = ritualsDashboard(await madeUpRitualsView(NOW));
  today = dashboard.attachments.active_date;
}, 60_000);

/** The days before 15 October 2026, back to `from`: a run's history. */
const historyFrom = (from: string) => daySlots(from, "2026-10-14", "2026-10-15");

describe("the days that fit", () => {
  it("are all of them while each has three pixels or more, newest first", () => {
    const run = historyFrom("2026-08-24"); // 52 days
    expect(MIN_DAY_PX).toBe(3);
    expect(fitDays(run, 156)).toEqual({ days: run.toReversed(), cropped: false });
    expect(fitDays(run, 1000).cropped).toBe(false);
    expect(fitDays(run, 156).days[0].key).toBe("2026-10-14");
  });

  it("are the most recent that fit when they would be narrower: yesterday at the left, the oldest shown at the right", () => {
    const run = historyFrom("2025-08-24"); // over a year
    const { days, cropped } = fitDays(run, 270);
    expect(cropped).toBe(true);
    expect(days).toHaveLength(90);
    expect(days[0].key).toBe("2026-10-14");
    expect(days.at(-1)?.key).toBe("2026-07-17");
  });

  it("are all of them before the width is known", () => {
    const run = historyFrom("2025-08-24");
    expect(fitDays(run, 0)).toEqual({ days: run.toReversed(), cropped: false });
  });
});

describe("the axis", () => {
  it("names the newest day shown, then each Monday with room for its words before it, held to the Monday's right edge", () => {
    // Newest first from Wednesday 14 October to Saturday 3: Mondays 12 October (the third day) and 5 October (the tenth).
    const days = fitDays(historyFrom("2026-10-03"), 0).days;
    const named = (dayPx: number) => axisLabels(days, dayPx).map((label) => [label.at, label.edge, label.text]);
    // Roomy: the 14th from its left edge, and both Mondays, each clear of the date before it.
    expect(named(40)).toEqual([
      [0, "start", "14 Oct"],
      [2, "end", "12 Oct"],
      [9, "end", "5 Oct"],
    ]);
    // Tighter: the 12th would run into the 14th's date; the 5th has room.
    expect(named(20)).toEqual([
      [0, "start", "14 Oct"],
      [9, "end", "5 Oct"],
    ]);
    // Tight: neither Monday has room.
    expect(named(10)).toEqual([[0, "start", "14 Oct"]]);
  });
});

describe("a row on the run", () => {
  it("knows its first day: a habit's first day in rituals, a check's start", () => {
    // The made-up store's days run from 18 September; the morning's check began 12 days ago.
    expect(habitRow(dashboard.daily, "magnesium", today).since).toBe("2026-09-18");
    const [morning] = runningChecks(dashboard.attachments);
    expect(checkRow(morning, today).since).toBe("2026-10-03");
  });

  it("marks each day: done, not done, a grey dot for a day not asked, no answer as not done, nothing before it began", () => {
    const [morning] = runningChecks(dashboard.attachments);
    const row = checkRow(morning, today);
    expect(["2026-10-02", "2026-10-03", "2026-10-04"].map((day) => runMark(row, day))).toEqual(["before", "not_done", "done"]);
    // Stretches on the 9th was not asked: a grey dot. On the 11th nobody answered: a not done, like the 12th, which was reported.
    const stretches = habitRow(dashboard.daily, "stretching", today);
    expect(stretches.dots.has("2026-10-11")).toBe(false);
    expect(["2026-10-09", "2026-10-11", "2026-10-12"].map((day) => runMark(stretches, day))).toEqual(["not_asked", "not_done", "not_done"]);
    // Nothing is a grey dot before the habit began.
    expect(runMark(stretches, "2026-09-01")).toBe("before");
  });

  it("says in a tooltip that no answer is a not done, not asked is not asked, and rituals' own words stand", () => {
    const stretches = habitRow(dashboard.daily, "stretching", today);
    expect(runWords(stretches, "2026-10-11")).toBe("Not done (no answer)");
    expect(runWords(stretches, "2026-10-09")).toBe("Not asked");
    expect(runWords(stretches, "2026-10-12")).toBe("Not done");
  });

  it("knows the days a check was not asked: those from its start that rituals does not list it on", () => {
    const [morning] = runningChecks(dashboard.attachments);
    const everyDay = checkRow(morning, today);
    expect(everyDay.notAsked.size).toBe(0);
    // The same check for Mondays only: every other day since its start was not asked.
    const mondays = checkRow({ ...morning, weekday: 1, days: morning.days.filter((day) => day.date === "2026-10-12") }, today);
    expect(runMark(mondays, "2026-10-12")).not.toBe("not_asked");
    expect(runMark(mondays, "2026-10-13")).toBe("not_asked");
    expect(runMark(mondays, today)).toBe("not_asked");
    expect(runMark(mondays, "2026-10-02")).toBe("before");
  });

  it("counts over the closed days shown, never today: no answer counts as not done, not asked is not counted", () => {
    const row = habitRow(dashboard.daily, "stretching", today);
    const history = daySpan(dashboard.daily, [], today).slice(0, -1);
    const shown = fitDays(history, 1000).days;
    // Today is still going (or answered) and the row's own counts take it once answered; the run's never do.
    // 18 September to 14 October, 27 closed days, counted by hand from the made-up store: 9 and 2 October and 25
    // September not asked; 14 done; 10 not done, 11 October and 23 September (no report) and 18 September (no answer)
    // among them.
    expect(runCount(row, shown)).toEqual({ done: 14, counted: 24 });
    // The last week only: 8 to 14 October, 3 done of the 6 asked (the 9th not asked, the 11th no answer is a not done).
    expect(runCount(row, fitDays(history.slice(-7), 1000).days)).toEqual({ done: 3, counted: 6 });
  });

  it("counts a check's closed day with no answer as not done too", () => {
    const [morning] = runningChecks(dashboard.attachments);
    const unanswered = { ...morning, days: morning.days.map((day) => (day.date === "2026-10-12" ? { ...day, status: "unreported" as const } : day)) };
    const row = checkRow(unanswered, today);
    expect(row.dots.has("2026-10-12")).toBe(false);
    expect(runMark(row, "2026-10-12")).toBe("not_done");
    const week = fitDays(historyFrom("2026-10-11").slice(0, 3), 1000).days; // 11, 12, 13 October
    expect(runCount(row, week).counted).toBe(3);
  });

  it("leaves today out even once it is answered, and takes it in as a history day when the day closes", () => {
    const row = habitRow(dashboard.daily, "stretching", today);
    const answered = { ...row, dots: new Map([...row.dots, [today, { mark: "done" as const, words: "Done" }]]) };
    const history = daySpan(dashboard.daily, [], today).slice(0, -1);
    const before = runCount(answered, fitDays(history, 1000).days);
    expect(before).toEqual(runCount(row, fitDays(history, 1000).days));
    // The next day, with today a day of the history.
    const tomorrow = daySlots("2026-10-15", "2026-10-15", "2026-10-16");
    const after = runCount(answered, fitDays([...history, ...tomorrow], 1000).days);
    expect(after).toEqual({ done: before.done + 1, counted: before.counted + 1 });
  });

  it("draws a day not asked after the last report grey, today too, and counts it nowhere, a day with no report a not done", async () => {
    // The made-up store as written on 15 October, read on Sunday 18 October, stretches not asked from the 16th to the 18th.
    const root = await mkdtemp(join(tmpdir(), "life-archive-rituals-after-"));
    try {
      await writeMadeUpRituals(root, NOW);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openStore(join(root, "data"));
            yield* store.request({ op: "exception_add", request_id: "made-up:after-last-report", source_text: "Made-up fixture: after the last report.", record: { habit: "stretching", start_date: "2026-10-16", end_date: "2026-10-18", reason: "Made-up: away" } });
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      const later = ritualsDashboard(await Effect.runPromise(viewOf(root, Date.parse("2026-10-18T10:00:00Z"), { daysThroughActive: true })));
      const day = later.attachments.active_date;
      expect(day).toBe("2026-10-18");
      const stretches = habitRow(later.daily, "stretching", day);
      expect(["2026-10-16", "2026-10-17", day].map((date) => runMark(stretches, date))).toEqual(["not_asked", "not_asked", "not_asked"]);
      expect(stretches.dots.has(day)).toBe(false);
      // Magnesium was asked and nobody answered: the 16th and 17th are not done; today is still going.
      const magnesium = habitRow(later.daily, "magnesium", day);
      expect(["2026-10-16", "2026-10-17"].map((date) => runMark(magnesium, date))).toEqual(["not_done", "not_done"]);
      expect(magnesium.dots.get(day)?.mark).toBe("open");
      // 15 to 17 October: stretches asked on the 15th alone (no answer by its close), magnesium on all three.
      const days = fitDays(daySlots("2026-10-15", "2026-10-17", day), 1000).days;
      expect(runCount(stretches, days)).toEqual({ done: 0, counted: 1 });
      expect(runCount(magnesium, days)).toEqual({ done: 1, counted: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
