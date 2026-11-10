// How the Fitness page writes an activity's numbers, the weeks of its weekly summary and zone 2 target, and a Rituals
// log's words (format.ts).

import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../wire.ts";
import { clockText, deleteName, distanceText, durationText, gymKind, gymRows, gymSessionText, gymWeekText, gymWord, logLines, logLoad, minutesText, monthTicks, scaleLength, setLoadKg, speedText, sportTotals, sportTotalsNote, sportTotalsText, startText, weekElapsed, weekOf, weeksTo, weekSpan, zone2WeekText, zonesByText, zonesNote } from "./format.ts";
import { wallClock } from "../../../sdk/server.ts";

describe("an activity's numbers", () => {
  it("writes distance in kilometres, time as a log does and as a clock does", () => {
    expect([distanceText(5321), distanceText(120_400), distanceText(null)]).toEqual(["5.32 km", "120.4 km", "—"]);
    expect([durationText(2462), durationText(3720), durationText(45)]).toEqual(["41m 2s", "1h 2m", "45s"]);
    expect([clockText(372), clockText(3723)]).toEqual(["6:12", "1:02:03"]);
  });

  it("says whose zones they are: the ones set, counted here, or Polar's and why", () => {
    const set = { starts: [112, 130, 148, 160], source: "a made-up clinic, May 2026" };
    const none = { starts: null, why: "no zones are set" };
    expect(zonesNote(set)).toBe("Zones by a made-up clinic, May 2026, counted from each workout's heart rate, not Polar's");
    expect(zonesNote(none)).toBe("Zones are Polar's own: no zones are set");
    expect([zonesByText("archive", set), zonesByText("polar", set), zonesByText(null, set)]).toEqual(["zones by a made-up clinic, May 2026", "Polar's zones", null]);
  });

  it("names an activity for its delete's confirmation by its date, sport and distance, whatever today is", () => {
    expect(deleteName({ start: "2026-10-14T06:50", sport: "Running", distanceM: 5800 })).toBe("Wednesday, 14 Oct 2026 at 6:50 am · Running · 5.80 km");
    expect(deleteName({ start: "2026-10-31T18:05", sport: "Strength training", distanceM: null })).toBe("Saturday, 31 Oct 2026 at 6:05 pm · Strength training · no distance recorded");
  });

  it("writes pace on foot, speed on a bike and pace a 100 m in the water", () => {
    expect(speedText("run", 2100, 5800)).toBe("6:02 /km");
    expect(speedText("walk", 1800, 2000)).toBe("15:00 /km");
    expect(speedText("ride", 3600, 24_300)).toBe("24.3 km/h");
    expect(speedText("swim", 125, 100)).toBe("2:05 /100m");
    expect(speedText("run", 2100, null)).toBe("—");
  });

  it("says when as a feed does: today, yesterday, else the day", () => {
    expect(startText("2026-11-02T07:15", "2026-11-02")).toBe("Today at 7:15 am");
    expect(startText("2026-11-01T18:40", "2026-11-02")).toBe("Yesterday at 6:40 pm");
    expect(startText("2026-10-14T12:05", "2026-11-02")).toBe("Wednesday, 14 Oct 2026 at 12:05 pm");
  });

  it("says the day alone when only the day is known (a workout logged in Rituals)", () => {
    expect([startText("2026-11-02", "2026-11-02"), startText("2026-11-01", "2026-11-02"), startText("2026-10-14", "2026-11-02")]).toEqual(["Today", "Yesterday", "Wednesday, 14 Oct 2026"]);
    expect(deleteName({ start: "2026-10-31", sport: "Gym push", distanceM: null })).toBe("Saturday, 31 Oct 2026 · Gym push · no distance recorded");
    expect([durationText(null), speedText("ride", null, 12_000)]).toEqual(["—", "—"]);
  });

  it("writes the zone 2 target's minutes", () => {
    expect([minutesText(44), minutesText(300), minutesText(184.4), minutesText(90)]).toEqual(["44 min", "5h", "3h 4m", "1h 30m"]);
  });

  it("picks a round length for a scale bar", () => {
    expect([scaleLength(2300), scaleLength(900), scaleLength(60)]).toEqual([200, 100, 10]);
  });
});

describe("the weeks", () => {
  const activity = (start: string, distanceM: number | null, movingS: number | null, zone2: ActivitySummary["zone2"] = null) => ({ start, distanceM, movingS, zone2, zones: [] }) as unknown as ActivitySummary;

  it("start on Monday", () => {
    expect([weekOf("2026-11-02"), weekOf("2026-11-08"), weekOf("2026-11-09")]).toEqual(["2026-11-02", "2026-11-02", "2026-11-09"]);
  });

  it("add up each week's distance, moving time and activities, the last to today's, oldest first", () => {
    const weeks = weeksTo([activity("2026-11-03T07:00", 5000, 1800), activity("2026-11-02T06:00", 3000, 1200), activity("2026-10-27T07:00", 10_000, 3600), activity("2026-01-01T07:00", 1, 1)], "2026-11-04", 3);
    expect(weeks).toEqual([
      { from: "2026-10-19", distanceM: 0, movingS: 0, count: 0, zone2Minutes: 0, zone2Sessions: 0, hiitMinutes: 0, gym: [] },
      { from: "2026-10-26", distanceM: 10_000, movingS: 3600, count: 1, zone2Minutes: 0, zone2Sessions: 0, hiitMinutes: 0, gym: [] },
      { from: "2026-11-02", distanceM: 8000, movingS: 3000, count: 2, zone2Minutes: 0, zone2Sessions: 0, hiitMinutes: 0, gym: [] },
    ]);
  });

  it("add up each week's minutes in zone 2, Monday to Sunday, each activity's once, a day-only one by its day", () => {
    const weeks = weeksTo([
      // Sunday night is the week before; Monday morning the week of the 2nd.
      activity("2026-11-01T21:30", 20_000, 3000, { minutes: 31.5, from: "heart-rate" }),
      activity("2026-11-02T06:00", 8000, 2700, { minutes: 22, from: "heart-rate" }),
      activity("2026-11-03", null, 2640, { minutes: 44, from: "rituals" }),
      activity("2026-11-04", null, null, null),
      activity("2026-11-08T08:00", 5000, 1800, { minutes: 0, from: "heart-rate" }),
      activity("2026-11-09T08:00", 5000, 1800, { minutes: 60, from: "heart-rate" }),
    ], "2026-11-04", 2);
    expect(weeks.map((w) => [w.from, w.zone2Minutes, w.zone2Sessions, w.count, w.movingS])).toEqual([
      ["2026-10-26", 31.5, 1, 1, 3000],
      ["2026-11-02", 66, 2, 4, 7140],
    ]);
  });

  it("add up each week's minutes in heart-rate zones 4 and 5, from each activity's trusted zones", () => {
    const zoned = (start: string, zones: ActivitySummary["zones"]) => ({ ...activity(start, 5000, 1800), zones }) as ActivitySummary;
    const weeks = weeksTo([
      zoned("2026-11-03T07:00", [{ zone: 5, share: 22, time: "9:01", from: 162 }, { zone: 4, share: 48, time: "19:42", from: 145 }, { zone: 3, share: 20, time: "8:00", from: 127 }]),
      zoned("2026-11-04T07:00", [{ zone: 4, share: 100, time: "1:00:30", from: 145 }, { zone: 5, share: 0, time: null, from: 162 }]),
      zoned("2026-10-28T07:00", [{ zone: 2, share: 100, time: "40:00", from: 109 }]),
    ], "2026-11-04", 2);
    expect(weeks.map((w) => [w.from, Math.round(w.hiitMinutes * 100) / 100])).toEqual([
      ["2026-10-26", 0],
      ["2026-11-02", Math.round(((9 * 60 + 1 + 19 * 60 + 42 + 3630) / 60) * 100) / 100],
    ]);
  });

  it("count each week's gym sessions, any gym type, once each, Monday to Sunday", () => {
    const logged = (start: string, type: string) => ({ start, distanceM: null, movingS: null, zone2: null, zones: [], logged: { type } }) as unknown as ActivitySummary;
    const weeks = weeksTo([
      logged("2026-11-01", "gym legs"),
      logged("2026-11-02", "gym push"),
      logged("2026-11-03T18:00", "GYM PULL"),
      logged("2026-11-04", "gym"),
      logged("2026-11-05", "bike"),
      logged("2026-11-06", "gymnastics"),
      activity("2026-11-07T08:00", 5000, 1800),
    ], "2026-11-04", 2);
    expect(weeks.map((w) => [w.from, w.gym.length])).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 3],
    ]);
  });

  it("keep each week's gym sessions by day, oldest first, each with its kind and its type as logged", () => {
    const logged = (start: string, type: string) => ({ start, distanceM: null, movingS: null, zone2: null, zones: [], logged: { type } }) as unknown as ActivitySummary;
    const weeks = weeksTo([
      logged("2026-11-06", "gym legs"),
      logged("2026-11-02", "gym push"),
      logged("2026-11-04T18:00", "GYM PULL"),
      logged("2026-11-05", "gym core"),
      logged("2026-10-30", "gym leg"),
    ], "2026-11-04", 2);
    expect(weeks.map((w) => w.gym)).toEqual([
      [{ day: "2026-10-30", kind: "legs", type: "gym leg" }],
      [
        { day: "2026-11-02", kind: "push", type: "gym push" },
        { day: "2026-11-04", kind: "pull", type: "GYM PULL" },
        { day: "2026-11-05", kind: "other", type: "gym core" },
        { day: "2026-11-06", kind: "legs", type: "gym legs" },
      ],
    ]);
  });

  it("know a gym session's kind and name it by its day and type", () => {
    expect(["gym push", " GYM PULL ", "gym legs", "gym leg day", "gym", "gym pushups", "gym upper"].map(gymKind)).toEqual(["push", "pull", "legs", "legs", "other", "other", "other"]);
    expect(gymSessionText({ day: "2026-11-03", kind: "pull", type: "GYM PULL" })).toBe("Tuesday, 3 Nov 2026 · Gym pull");
  });

  it("say a week as the captain writes it, Monday to the next Monday", () => {
    expect(weekSpan("2026-10-26")).toBe("Oct 26 – Nov 2");
    expect(weekSpan("2026-10-05")).toBe("Oct 5 – Oct 12");
    expect(weekSpan("2026-12-28")).toBe("Dec 28 – Jan 4");
  });

  it("say a week of gym sessions by its span and its sessions by name", () => {
    const s = (kind: "push" | "pull" | "legs" | "other", type = `gym ${kind}`) => ({ day: "2026-10-27", kind, type });
    expect(gymWeekText({ from: "2026-10-26", gym: [s("push"), s("legs"), s("other", "gym core")] })).toBe("Oct 26 – Nov 2 · 3 sessions: Push, Legs, Core");
    expect(gymWeekText({ from: "2026-10-26", gym: [s("pull")] })).toBe("Oct 26 – Nov 2 · 1 session: Pull");
    expect(gymWeekText({ from: "2026-10-26", gym: [] })).toBe("Oct 26 – Nov 2 · no sessions");
    expect([s("other", "gym"), s("other", "GYM UPPER")].map(gymWord)).toEqual(["Gym", "Upper"]);
  });

  it("say a week of zone 2 by its span, its minutes and its sessions with zone 2 time", () => {
    expect(zone2WeekText({ from: "2026-10-26", zone2Minutes: 90, zone2Sessions: 3 })).toBe("Oct 26 – Nov 2 · 1h 30m, 3 sessions");
    expect(zone2WeekText({ from: "2026-10-26", zone2Minutes: 184.4, zone2Sessions: 1 })).toBe("Oct 26 – Nov 2 · 3h 4m, 1 session");
    expect(zone2WeekText({ from: "2026-10-26", zone2Minutes: 0, zone2Sessions: 0 })).toBe("Oct 26 – Nov 2 · 0 min");
  });

  it("know how far through its Melbourne week an instant is, Monday midnight to Sunday midnight", () => {
    expect(weekElapsed(wallClock("2026-11-02", "00:00"))).toBe(0);
    expect(weekElapsed(wallClock("2026-11-05", "12:00"))).toBeCloseTo(0.5, 6);
    expect(weekElapsed(wallClock("2026-11-08", "23:59"))).toBeCloseTo(1 - 1 / (7 * 24 * 60), 6);
    expect(weekElapsed(wallClock("2026-11-09", "00:00"))).toBe(0);
    // The week the clocks go forward (Sunday 4 Oct 2026, 2 am) is an hour short: its Sunday noon is 155 of 167 hours in.
    expect(weekElapsed(wallClock("2026-10-04", "12:00"))).toBeCloseTo(155 / 167, 6);
  });

  it("are labelled by month only at each month's first Monday, never for being the first week shown", () => {
    const froms = weeksTo([], "2026-11-04", 12).map((w) => w.from);
    expect(froms[0]).toBe("2026-08-17");
    expect(monthTicks(froms)).toEqual([null, null, null, "Sep", null, null, null, "Oct", null, null, null, "Nov"]);
  });

  it("label the first week shown when it is its month's first Monday", () => {
    expect(monthTicks(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"])).toEqual(["Sep", null, null, null, "Oct"]);
  });
});

describe("a Rituals log's words", () => {
  it("are an exercise a line with its sets, when a line names one", () => {
    expect(logLines("Bench press: 20 kg x 8; 40 kg x 10\nDips: 3 x 12")).toEqual([
      { name: "Bench press", sets: ["20 kg x 8", "40 kg x 10"], text: null },
      { name: "Dips", sets: ["3 x 12"], text: null },
    ]);
  });

  it("are as written otherwise, a sentence a line, and none when there are none", () => {
    expect(logLines("44 minutes, zone 2")).toEqual([{ name: null, sets: [], text: "44 minutes, zone 2" }]);
    expect(logLines("Lunges: 3 x 10. Then a stretch.")).toEqual([
      { name: "Lunges", sets: ["3 x 10"], text: null },
      { name: null, sets: [], text: "Then a stretch" },
    ]);
    expect(logLines("")).toEqual([]);
  });
});

describe("the gym chart's height", () => {
  const week = (n: number) => ({ gym: Array.from({ length: n }, () => ({ day: "2026-11-02", kind: "push" as const, type: "gym push" })) });
  it("holds three sessions a week, however few were logged", () => {
    expect([gymRows([]), gymRows([week(0)]), gymRows([week(2), week(1)]), gymRows([week(3)])]).toEqual([3, 3, 3, 3]);
  });
  it("grows to a week with more than three", () => {
    expect(gymRows([week(1), week(5), week(4)])).toEqual(5);
  });
});

describe("a gym set's load and each sport's measure", () => {
  it("weighs a set as weight times reps, in kg, a pound as kg", () => {
    expect([setLoadKg("20 kg x 8"), setLoadKg("40 kg x 10"), setLoadKg("50kg × 6"), setLoadKg("12.5 kg x 10 reps")]).toEqual([160, 400, 300, 125]);
    expect(setLoadKg("20 lb x 8")).toBeCloseTo(72.57, 2);
    expect(setLoadKg("45 lbs x 10")).toBeCloseTo(204.12, 2);
    expect([setLoadKg("40kg x8 (logged 18:02)"), setLoadKg("40 kg × 8 easy")]).toEqual([320, 320]);
  });

  it("leaves out a set without a usable weight: no unit, bodyweight, unassisted or assisted", () => {
    const without = ["3 x 12", "bodyweight x 10", "BW x 15", "bodyweight + 10 kg × 8", "+10kg x8", "unassisted x 8", "30 lb assistance x 8", "assisted 20 kg x 6", "12 kg each × 10", "20 kg x8 x3", "felt strong"];
    expect(without.map(setLoadKg)).toEqual(without.map(() => null));
  });

  it("sums a log's sets over its exercises and counts those left out", () => {
    const load = logLoad("Bench press: 20 kg x 8; 40 kg x 10; 50 kg x 10\nAssisted dips: 30 lb assistance x 8; unassisted x 8\nDips: 3 x 12");
    expect(load).toEqual({ kg: 160 + 400 + 500, leftOut: 3 });
    expect(logLoad("Felt good, easy session\nDips: went well, recorded against this date")).toEqual({ kg: 0, leftOut: 0 });
  });

  it("reads sets on lines of their own, under a heading", () => {
    expect(logLoad("Bench press:\n- 40 kg × 10\n- 50 kg × 8\nAssisted pull-ups:\n- 30 lb assistance × 8\n- 20 lb × 10")).toEqual({ kg: 400 + 400 + 20 * 0.45359237 * 10, leftOut: 1 });
  });

  it("measures cycling and walking by time, running by distance and each gym type by load, in the captain's fixed order", () => {
    const activity = (over: Partial<ActivitySummary>): ActivitySummary => ({ ...({} as ActivitySummary), logged: null, distanceM: null, movingS: null, elapsedS: null, ...over });
    const gym = (type: string, details: string) => activity({ sport: type, family: "other", logged: { type, details } as ActivitySummary["logged"] });
    const rows = sportTotals([
      activity({ sport: "Cycling", family: "ride", movingS: 3600, distanceM: 24_000 }),
      activity({ sport: "Cycling", family: "ride", movingS: 1800, distanceM: 12_000 }),
      activity({ sport: "Running", family: "run", movingS: 1800, distanceM: 5_000 }),
      activity({ sport: "Walking", family: "walk", movingS: null, elapsedS: 2400 }),
      gym("gym push", "Bench press: 40 kg x 10; 50 kg x 8\nDips: 3 x 10"),
      gym("Gym push", "Overhead press: 20 lb x 10"),
      gym("gym legs", "Squats: 60 kg x 5"),
      activity({ sport: "Yoga", family: "other", movingS: 900 }),
    ]);
    expect(rows.map((r) => [r.sport, r.count, r.measure])).toEqual([
      ["Walking", 1, "time"],
      ["Running", 1, "distance"],
      ["Cycling", 2, "time"],
      ["Gym push", 2, "load"],
      ["Gym legs", 1, "load"],
      ["Yoga", 1, "time"],
    ]);
    expect(rows.map(sportTotalsText)).toEqual(["1 · 40m 0s", "1 · 5.00 km", "2 · 1h 30m", "2 · 891 kg", "1 · 300 kg", "1 · 15m 0s"]);
    expect(sportTotalsNote(rows[3])).toBe("Gym push: total load, weight × reps over every set, lb as kg; 1 set without a usable weight (bodyweight, unassisted or assisted) left out");
    expect(sportTotalsNote(rows[4])).toBe("Gym legs: total load, weight × reps over every set, lb as kg; every set had a weight");
    expect(sportTotalsNote(rows[2])).toBe("Cycling: total time");
  });
});
