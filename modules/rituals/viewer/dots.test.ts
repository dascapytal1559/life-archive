// Rituals' habits as rows of dots, on rituals' made-up store: which habit goes to which tab, a dot a day as rituals
// marks it (green done, red a reported not done, none for a day not asked or with no answer, today hollow until
// answered), the counts that leave out a day with no dot, the temporary checks running now, and the weekly targets a
// week a dot. What each row should show is worked out by hand from the store's pattern (../fixtures/rituals.ts:
// madeUpStatus, its days with no report, its items and its targets' amounts), for its day, Thursday 15 October 2026.

import { beforeAll, describe, expect, it } from "vitest";
import { madeUpRitualsView } from "../fixtures/rituals.ts";
import { ritualsDashboard } from "../server/dashboard.ts";
import type { RitualsDashboard, RitualsDaily } from "../wire.ts";
import { byAdded, CHECKIN_HABIT, checkRow, daySlots, daySpan, fitnessTargets, habitName, habitRow, habitsOf, isFishTarget, runningChecks, STILL_GOING, targetRows, tickWordsOf, tipCentre, weekSlots, type DotRow } from "./dots.ts";

// 10:00 UTC is 21:00 in Melbourne: the evening of the 15th, still open.
const NOW = Date.parse("2026-10-15T10:00:00Z");
let dashboard: RitualsDashboard;
let today: string;

/** A row's marks on the days or weeks named, in their order: null where it has no dot. */
const marksOf = (row: DotRow, keys: readonly string[]) => keys.map((key) => row.dots.get(key)?.mark ?? null);
const counts = (row: DotRow) => [row.done, row.counted];

beforeAll(async () => {
  dashboard = ritualsDashboard(await madeUpRitualsView(NOW));
  today = dashboard.attachments.active_date;
}, 60_000);

describe("the habits Daily rituals shows", () => {
  it("are every habit of rituals', in its order, any it adds after", () => {
    expect(habitsOf(dashboard.daily)).toEqual(["magnesium", "protein", "stretching", "planks", "journalling", "wind_down"]);
    const added: RitualsDaily = { ...dashboard.daily, rows: dashboard.daily.rows.map((row) => ({ ...row, cells: { ...row.cells, cold_shower: row.cells.protein } })) };
    expect(habitsOf(added)).toEqual(["magnesium", "protein", "stretching", "planks", "journalling", "wind_down", "cold_shower"]);
    expect(CHECKIN_HABIT).toBe("journalling");
    expect(habitName("stretching")).toBe("Stretches");
    expect(habitName("cold_shower")).toBe("Cold shower");
  });
});

describe("a habit's row", () => {
  it("has a dot for each day answered: green done, red a reported not done, none for a day not asked or with no answer", () => {
    const row = habitRow(dashboard.daily, "stretching", today);
    const week = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
    // The 9th it was not asked; the 11th nothing was reported; the 15th is today, not answered yet.
    expect(marksOf(row, week)).toEqual(["done", null, "done", null, "not_done", "done", "not_done", "open"]);
    expect(row.dots.get("2026-10-12")?.words).toBe("Not done");
    // 28 days: 14 done, 7 reported not done, 3 not asked, 3 with no answer, and today.
    expect(counts(row)).toEqual([14, 21]);
  });

  it("gives a closed day with nothing reported no dot on any habit, and does not count it", () => {
    const gap = dashboard.daily.rows.find((day) => day.date === "2026-10-11")!;
    expect(gap.annotation).toBe("Activities only");
    expect(gap.cells.magnesium).toMatchObject({ status: "not_done", basis: "missing_after_close" });
    for (const habit of ["magnesium", "protein", "stretching", "planks", "journalling"]) expect(habitRow(dashboard.daily, habit, today).dots.has("2026-10-11"), habit).toBe(false);
    // Its 25 answered days, today's green dot among them, where rituals' own rate takes the 3 days with no report as not done.
    expect(counts(habitRow(dashboard.daily, "magnesium", today))).toEqual([18, 25]);
    expect(dashboard.daily.rates.magnesium).toMatchObject({ done: 17, denominator: 27 });
  });

  it("gives a habit left out of a day otherwise answered no dot, and does not count it", () => {
    // The 9th: magnesium was answered, the plank never was, though rituals says not done of it.
    const day = dashboard.daily.rows.find((row) => row.date === "2026-10-09")!;
    expect(day.annotation).toBe("");
    expect(day.cells.planks).toMatchObject({ status: "not_done", basis: "missing_after_close" });
    expect(habitRow(dashboard.daily, "magnesium", today).dots.get("2026-10-09")?.mark).toBe("done");
    const plank = habitRow(dashboard.daily, "planks", today);
    expect(plank.dots.has("2026-10-09")).toBe(false);
    // The made-up store only ever reports a plank held: nothing red, and 9 days not counted that rituals' rate counts.
    expect(counts(plank)).toEqual([18, 18]);
    expect(dashboard.daily.rates.planks).toMatchObject({ done: 18, denominator: 27 });
  });

  it("keeps today hollow until it is answered", () => {
    const row = habitRow(dashboard.daily, "journalling", today);
    expect(row.dots.get(today)).toEqual({ mark: "open", words: STILL_GOING });
  });

  it("says a plank's held time, and with check-ins asked for, when he checked in", () => {
    expect(habitRow(dashboard.daily, "planks", today).dots.get("2026-10-14")?.words).toBe("Done · held 1:17");
    const journalling = habitRow(dashboard.daily, "journalling", today, { checkins: true });
    expect(journalling.dots.get("2026-10-14")?.words).toBe("Done · checked in 21:13");
    expect(journalling.dots.get("2026-10-12")?.words).toBe("Done · checked in 00:13 +1 day");
  });
});

describe("the days the rows span", () => {
  it("run from the first day rituals shows to today, oldest first, a tick at each Monday", () => {
    const slots = daySpan(dashboard.daily, [], today);
    expect(slots).toHaveLength(28);
    expect(slots[0].key).toBe("2026-09-18");
    expect(slots.at(-1)).toMatchObject({ key: "2026-10-15", current: true });
    expect(slots.filter((slot) => slot.current)).toHaveLength(1);
    expect(daySlots("2026-10-10", "2026-10-13", "2026-10-13")[2].label).toMatch(/12/);
  });
});

describe("the temporary checks", () => {
  it("have a row while running and asking for a tick, the morning's first; a reminder or a finished one has none", () => {
    // The made-up store: a reminder (laying out clothes), the morning's priority list, the noon threads and a finished cold shower.
    expect(runningChecks(dashboard.attachments).map((item) => item.id)).toEqual(["morning-priority-review", "noon-reviewed-open-threads"]);
  });

  it("dot each day as rituals marks it, today hollow until answered, an unanswered day before it none", () => {
    const [morning, noon] = runningChecks(dashboard.attachments);
    const row = checkRow(morning, today);
    // Begun 12 days ago: answered no on the 3rd, the 8th and the 13th, yes on the rest.
    expect(marksOf(row, ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-08", "2026-10-13", "2026-10-14", "2026-10-15"])).toEqual([null, "not_done", "done", "not_done", "not_done", "done", "open"]);
    expect(counts(row)).toEqual([9, 12]);
    // Never answered: nothing before today, and nothing counted.
    expect([...checkRow(noon, today).dots.keys()]).toEqual(["2026-10-15"]);
    expect(counts(checkRow(noon, today))).toEqual([0, 0]);
  });

  it("sit with the habits in the order each was added, the latest at the bottom", () => {
    const habits = habitsOf(dashboard.daily).map((habit) => habitRow(dashboard.daily, habit, today));
    const checks = runningChecks(dashboard.attachments).map((item) => checkRow(item, today));
    const from = daySpan(dashboard.daily, runningChecks(dashboard.attachments), today)[0].key;
    // The five first habits from the store's first day; the noon check begun 14 days ago, before the morning's (12), so
    // ahead of it though the morning's comes first when added together; wind-down not asked until HABIT_SINCE, after
    // today, so its row begins today, last.
    expect(byAdded([...habits, ...checks], from).map((row) => row.key)).toEqual([
      "magnesium", "protein", "stretching", "planks", "journalling", "noon-reviewed-open-threads", "morning-priority-review", "wind_down",
    ]);
  });

  it("are ordered by added day, a row from before the first day shown as from that day, ties as given", () => {
    const row = (key: string, since: string): DotRow => ({ key, name: key, note: null, since, dots: new Map(), notAsked: new Set(), done: 0, counted: 0 });
    const rows = [row("old", "2026-09-01"), row("later", "2026-11-09"), row("check", "2026-11-05"), row("early-check", "2026-08-01"), row("same", "2026-11-05")];
    expect(byAdded(rows, "2026-09-01").map((r) => r.key)).toEqual(["old", "early-check", "check", "same", "later"]);
  });

  it("word a tick with its time and how it is known", () => {
    expect(tickWordsOf({ status: "done", label: "Done", done_at: "2026-10-14T07:30:00+11:00", basis: "user_stated" })).toBe("Done · 07:30 as stated");
    expect(tickWordsOf({ status: "done", label: "Done", done_at: null, basis: "unknown" })).toBe("Done · time not given");
    expect(tickWordsOf({ status: "not_done", label: "Not done", done_at: null, basis: null })).toBe("Not done");
  });
});

describe("the weekly targets", () => {
  it("are a row each, a dot a week it was counted in, oldest first: met green, missed red, this week hollow until met", () => {
    const { targets } = dashboard;
    const weeks = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
    const slots = weekSlots(targets);
    expect(slots.map((slot) => slot.key)).toEqual(weeks);
    expect(slots.at(-1)?.current).toBe(true);
    const rows = targetRows(targets);
    expect(rows.map((row) => row.key)).toEqual(["made-up-laps", "made-up-riding", "made-up-walks", "made-up-fish"]);
    const [laps, riding, walks, fish] = rows;
    // Laps, at least 3 a week: 3, 2, 3, 1, 3, 4, 2, 3, met this week already.
    expect(marksOf(laps, weeks)).toEqual(["done", "not_done", "done", "not_done", "done", "done", "not_done", "done"]);
    expect(counts(laps)).toEqual([5, 8]);
    // Riding, at least 300 minutes: 320, 135, 310, 215, 310, 190, 315, and 200 so far.
    expect(marksOf(riding, weeks)).toEqual(["done", "not_done", "done", "not_done", "done", "not_done", "done", "open"]);
    expect(counts(riding)).toEqual([4, 7]);
    // Long walks began three weeks ago, at least 10 km: 5.5, 11.5, and 4.2 so far.
    expect(marksOf(walks, weeks)).toEqual([null, null, null, null, null, "not_done", "done", "open"]);
    expect(counts(walks)).toEqual([1, 2]);
    expect([laps.since, walks.since]).toEqual(["2026-08-24", "2026-09-28"]);
    // Fish, at least 2: 2, 1, 2, 2, 1, 3, 2, and 1 so far.
    expect(marksOf(fish, weeks)).toEqual(["done", "not_done", "done", "done", "not_done", "done", "done", "open"]);
    expect(counts(fish)).toEqual([5, 7]);
    expect(fish.note).toBe("1 / 2 fish");
  });

  it("on Fitness leave out the fish target, its weeks' met counts over the rest, and a week left empty", () => {
    const { targets } = dashboard;
    const fitness = fitnessTargets(targets);
    expect(targetRows(fitness).map((row) => row.key)).toEqual(["made-up-laps", "made-up-riding", "made-up-walks"]);
    expect(fitness.weeks.flatMap((week) => week.targets).some(isFishTarget)).toBe(false);
    // This week: laps met, riding and walks not yet, fish not yet (so rituals' own count is 1 either way); the week of
    // 5 October had laps missed, riding met and walks met, fish met: 3 met there, 2 without fish.
    expect(targets.weeks.find((week) => week.week_start === "2026-10-05")?.met).toBe(3);
    expect(fitness.weeks.find((week) => week.week_start === "2026-10-05")?.met).toBe(2);
    expect(fitness.weeks.find((week) => week.current)).toMatchObject({ met: 1 });
    // Rituals' own targets are untouched: the fish is still there.
    expect(targetRows(targets).map((row) => row.key)).toContain("made-up-fish");
    // A week with only the fish target has nothing left to show.
    const onlyFish = { ...targets, weeks: targets.weeks.map((week) => ({ ...week, targets: week.targets.filter(isFishTarget) })) };
    expect(fitnessTargets(onlyFish).weeks).toEqual([]);
  });
});

describe("a dot's tooltip", () => {
  it("sits over its dot, moved in only as far as stays whole in the block", () => {
    // A 210px tip in a 350px block: today's dot 26px from the right edge, one 20px from the left, one in the middle.
    expect(tipCentre(324, 210, 350)).toBe(245);
    expect(tipCentre(20, 210, 350)).toBe(105);
    expect(tipCentre(175, 210, 350)).toBe(175);
  });
});
