import { describe, expect, it } from "vitest";
import { ALL_KINDS } from "./calendar.ts";
import { busyLevel, countedKinds, planYear, stepYear, YEAR_KINDS, yearAsks, yearDays, yearLabel, yearMonths, yearStart, yearTally } from "./year.ts";

describe("the year's days", () => {
  it("are 1 January to 31 December, 366 in a leap year", () => {
    const days = yearDays("2026-10-29");
    expect(days).toHaveLength(365);
    expect(days[0]).toBe("2026-01-01");
    expect(days.at(-1)).toBe("2026-12-31");
    expect(yearDays("2028-02-10")).toHaveLength(366);
    expect(yearDays("2028-02-10")).toContain("2028-02-29");
    expect(yearStart("2026-10-29")).toBe("2026-01-01");
  });

  it("make twelve months, each by its first day", () => {
    const months = yearMonths("2026-10-29");
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-01-01");
    expect(months[9]).toBe("2026-10-01");
    expect(months[11]).toBe("2026-12-01");
  });

  it("step a year onto its 1 January, or onto today in today's year", () => {
    const today = "2026-10-29";
    expect(stepYear(today, -1, today)).toBe("2025-01-01");
    expect(stepYear("2025-01-01", 1, today)).toBe(today);
    expect(stepYear(today, 1, today)).toBe("2027-01-01");
    expect(stepYear("2024-02-29", -3, today)).toBe("2021-01-01");
  });
});

describe("what a year asks for", () => {
  it("is each charted kind's chart by day, messages and agent messages coming from the day summaries", () => {
    const asks = yearAsks(1, 2, null);
    expect(asks.map((ask) => [ask.kind, ask.tab, ask.measure])).toEqual([
      ["calls", "calls", "calls"],
      ["hangouts", "hangouts", "hangouts"],
      ["workouts", "workouts", "workouts"],
      ["habits", "habits", "rituals"],
    ]);
    expect(asks.every((ask) => ask.filters.from === 1 && ask.filters.to === 2)).toBe(true);
  });

  it("with a person picked, asks for what they are in alone, with them", () => {
    expect(yearAsks(1, 2, null, { unknown: false, missed: true }).find((ask) => ask.kind === "calls")!.filters.choices).toEqual({ caller: ["known"] });
    expect(yearAsks(1, 2, null, { unknown: false, missed: false }).find((ask) => ask.kind === "calls")!.filters.choices).toEqual({ caller: ["known"], answered: ["yes", "unknown"] });
    expect(yearAsks(1, 2, null).find((ask) => ask.kind === "calls")!.filters.choices).toEqual({});
    const asks = yearAsks(1, 2, 3);
    expect(asks.map((ask) => ask.kind)).toEqual(["calls", "hangouts"]);
    expect(asks.every((ask) => ask.filters.person === 3)).toBe(true);
  });

  it("names each kind over its summary", () => {
    expect(YEAR_KINDS.map(yearLabel)).toEqual(["Messages", "Calls", "Hangouts", "Agent messages", "Workouts", "Rituals"]);
  });
});

describe("how a day of the year is shaded", () => {
  it("takes a kind's busy day as the 90th percentile of its days with any, at least 1", () => {
    expect(busyLevel([])).toBe(1);
    expect(busyLevel([0, 0])).toBe(1);
    expect(busyLevel([0, 1, 1, 1])).toBe(1);
    // Ten days with any, 10 to 100: the ninth is the 90th percentile; the one outlier does not set the scale.
    expect(busyLevel([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 1000])).toBe(90);
    expect(busyLevel([0.5])).toBe(1);
  });

  const days = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];

  it("gives each kind on up to a point, its count against its busy day, and adds them up", () => {
    // Messages' busy day is 200 (the 90th percentile of 50, 100, 200); hangouts' is 1.
    const counts = { messages: { "2026-03-01": 50, "2026-03-02": 100, "2026-03-03": 200 }, hangouts: { "2026-03-02": 1, "2026-03-04": 1 } };
    const plan = planYear(counts, days, ALL_KINDS);
    expect(plan.kinds).toEqual([
      { kind: "messages", total: 350, days: 3, busy: 200 },
      { kind: "hangouts", total: 2, days: 2, busy: 1 },
    ]);
    expect(plan.days.map((d) => d.points)).toEqual([0.25, 1.5, 1, 1, 0]);
    // Quarters of the fullest day (1.5): 0.25 is the first, 1 the third, 1.5 the fourth; nothing is none.
    expect(plan.days.map((d) => d.shade)).toEqual([1, 4, 3, 3, 0]);
    expect(plan.days[1].counts).toEqual({ messages: 100, hangouts: 1 });
  });

  it("is the kind chips' counts: each kind's total on how many days", () => {
    const counts = { messages: { "2026-03-01": 1200, "2026-03-03": 200 }, hangouts: { "2026-03-02": 1 } };
    expect(yearTally(planYear(counts, days, ALL_KINDS))).toEqual({
      messages: { label: "Messages", value: "1,400", note: "on 2 days" },
      hangouts: { label: "Hangouts", value: "1", note: "on 1 day" },
    });
    expect(yearTally(planYear(counts, days, ["hangouts"]))).toEqual({ hangouts: { label: "Hangouts", value: "1", note: "on 1 day" } });
  });

  it("counts only the kinds on that were read, so one kind on shades by it alone", () => {
    const counts = { messages: { "2026-03-01": 50, "2026-03-02": 100, "2026-03-03": 200 }, hangouts: { "2026-03-02": 1, "2026-03-04": 1 } };
    const hangouts = planYear(counts, days, ["hangouts"]);
    expect(hangouts.kinds.map((k) => k.kind)).toEqual(["hangouts"]);
    expect(hangouts.days.map((d) => d.shade)).toEqual([0, 4, 0, 4, 0]);
    expect(countedKinds(counts, ["calls", "hangouts", "messages"])).toEqual(["messages", "hangouts"]);
    expect(planYear({}, days, ALL_KINDS).kinds).toEqual([]);
    expect(planYear({}, days, ALL_KINDS).days.every((d) => d.shade === 0)).toBe(true);
  });
});
