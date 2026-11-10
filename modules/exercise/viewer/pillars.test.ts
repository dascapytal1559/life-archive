// The five pillars' arithmetic (pillars.ts), on made-up activities and ritual days: the weeks, each pillar's value,
// target and reading, and the names; planks never count as balance.

import { describe, expect, it } from "vitest";
import type { ActivitySummary, PillarHabitDay } from "../wire.ts";
import { isoWeek, PILLARS, pillarWeeks, readingText, reportedOf, targetOf, targetsOf, valueOf, weekName, type Targets } from "./pillars.ts";

/** A made-up activity: its start, and what the pillars read of it. */
const activity = (start: string, { zone2 = 0, z45 = [] as string[], gym = "" } = {}) =>
  ({
    start,
    zone2: zone2 > 0 ? { minutes: zone2, from: "heart-rate" } : null,
    zones: z45.map((time, i) => ({ zone: 4 + i, share: 0, time, from: null })),
    logged: gym ? { type: gym, title: gym, details: "", minutes: null, zone2: false } : null,
    distanceM: null,
    movingS: null,
  }) as unknown as ActivitySummary;

const day = (date: string, stretching?: string, planks?: string): PillarHabitDay => ({ day: date, habits: { ...(stretching && { stretching }), ...(planks && { planks }) } as PillarHabitDay["habits"] });

const TARGETS: Targets = targetsOf({ zone2: { amount: 300 }, lift: { amount: 3 }, hiit: { amount: 20 } });

// Today is Wednesday 4 November 2026, in the week of Monday the 2nd (ISO week 45).
const TODAY = "2026-11-04";
const ACTIVITIES = [
  activity("2026-10-13T07:00", { zone2: 40 }),
  activity("2026-10-27", { gym: "gym push" }),
  activity("2026-10-29T18:00", { zone2: 45, z45: ["9:00", "3:30"] }),
  activity("2026-11-02", { gym: "gym legs" }),
  activity("2026-11-03T06:30", { zone2: 62.5 }),
  activity("2026-11-03", { gym: "gym pull" }),
];
const HABITS = [
  day("2026-10-26", "done", "done"),
  day("2026-10-27", "not_done", "done"),
  day("2026-10-28", "not_applicable", "not_done"),
  day("2026-11-02", "done", "done"),
  day("2026-11-03", "done", "not_done"),
  day("2026-11-04", "unreported", "unreported"),
  day("2026-11-05", "unreported"),
];

describe("the five pillars", () => {
  it("are named in the captain's order, mobility above balance", () => {
    expect(PILLARS.map((p) => p.name)).toEqual(["Strength Training", "Low Intensity Cardio", "High Intensity Cardio", "Mobility & Flexibility", "Balance"]);
  });
});

describe("the pillars' weeks", () => {
  const weeks = pillarWeeks(ACTIVITIES, HABITS, TODAY);

  it("run from the first week with anything to count to today's, Monday to Sunday, this one in progress", () => {
    expect(weeks.map((w) => [w.from, w.to, w.week, w.current])).toEqual([
      ["2026-10-12", "2026-10-18", 42, false],
      ["2026-10-19", "2026-10-25", 43, false],
      ["2026-10-26", "2026-11-01", 44, false],
      ["2026-11-02", "2026-11-08", 45, true],
    ]);
  });

  it("count the gym sessions, the minutes in zone 2 and in zones 4 and 5, and the days stretched of those reported, never the plank days", () => {
    expect(weeks[2].totals).toEqual({ lift: 1, z2: 45, hiit: 12.5, mob: 1, mobOf: 2 });
    // Today's open day and the days after it are not reported, so not counted.
    expect(weeks[3].totals).toEqual({ lift: 2, z2: 62.5, hiit: 0, mob: 2, mobOf: 2 });
    // A week no habit was reported in has no mobility at all, not a zero.
    expect(weeks[0].totals).toMatchObject({ z2: 40, mob: null, mobOf: 0 });
    expect([reportedOf(weeks[2], "mob"), reportedOf(weeks[2], "bal"), reportedOf(weeks[2], "lift")]).toEqual([2, null, null]);
  });

  it("have no habits with the rituals module off, and a single week with nothing at all", () => {
    expect(pillarWeeks(ACTIVITIES, null, TODAY).every((w) => w.totals.mob === null)).toBe(true);
    expect(pillarWeeks([], null, TODAY).map((w) => w.from)).toEqual(["2026-11-02"]);
  });

  it("name the ISO week and a week with its year", () => {
    expect([isoWeek("2026-01-01"), isoWeek("2025-12-29"), isoWeek("2026-11-02"), isoWeek("2027-01-03"), isoWeek("2020-12-31")]).toEqual([1, 1, 45, 53, 53]);
    expect(weekName(weeks[3])).toBe("Week 45 · 2–8 Nov 2026");
    expect(weekName(weeks[2])).toBe("Week 44 · 26 Oct – 1 Nov 2026");
  });
});

describe("a pillar's value", () => {
  const [week] = pillarWeeks([activity("2026-11-03T06:30", { zone2: 400, z45: ["10:00"] })], [day("2026-11-02", "done", "done")], TODAY);

  it("is what its week counted, against its weekly target", () => {
    expect(PILLARS.map((p) => valueOf(week, p.key))).toEqual([0, 400, 10, 1, null]);
    expect(PILLARS.map((p) => targetOf(TARGETS, p.key))).toEqual([3, 300, 20, 7, 7]);
  });

  it("leaves balance empty, whatever the plank days say", () => {
    // The week's one ritual day planked; planks are not balance.
    expect(valueOf(week, "bal")).toBeNull();
    expect(readingText(week, "bal", TARGETS)).toEqual({ value: null, of: "no balance logged" });
  });

  it("says why when there is no target set, or nothing reported", () => {
    const none = targetsOf({ zone2: { amount: 300 }, lift: { amount: null, why: "no target is set: set liftWeeklySessions in exercise.json" }, hiit: { amount: 20 } });
    expect(readingText(week, "lift", none)).toEqual({ value: 0, of: "· no target set" });
    expect(readingText(week, "z2", TARGETS)).toEqual({ value: 400, of: "/ 300 min" });
    expect(readingText(week, "lift", targetsOf({ zone2: { amount: 300 }, lift: { amount: 1 }, hiit: { amount: 20 } }))).toEqual({ value: 0, of: "/ 1 session" });
    const [quiet] = pillarWeeks([activity("2026-11-03", { zone2: 10 })], [], TODAY);
    expect(readingText(quiet, "mob", TARGETS)).toEqual({ value: null, of: "nothing reported" });
  });
});
