import { describe, expect, it } from "vitest";
import { dayStart, wallClock } from "../../src/time.ts";
import { autoBuckets, bucketDay, bucketEdges, bucketsFor, MOST_BARS } from "./buckets.ts";

const HOUR = 3_600_000;

describe("the chart's buckets", () => {
  it("begin on the day, the Monday, the first of the month or of the year", () => {
    expect(bucketDay("2026-10-14", "day")).toBe("2026-10-14");
    expect(bucketDay("2026-10-14", "week")).toBe("2026-10-12");
    expect(bucketDay("2026-10-12", "week")).toBe("2026-10-12");
    expect(bucketDay("2026-10-18", "week")).toBe("2026-10-12");
    expect(bucketDay("2026-01-01", "week")).toBe("2025-12-29");
    expect(bucketDay("2026-10-14", "month")).toBe("2026-10-01");
    expect(bucketDay("2026-10-14", "year")).toBe("2026-01-01");
  });

  it("run from Melbourne midnight to midnight, a day the clocks change 25 or 23 hours long", () => {
    const april = bucketEdges(dayStart("2026-04-04") + HOUR, dayStart("2026-04-06"), "day")!;
    expect(april.map((b) => [b.day, (b.end - b.start) / HOUR])).toEqual([["2026-04-04", 24], ["2026-04-05", 25]]);
    const october = bucketEdges(dayStart("2026-10-04"), dayStart("2026-10-05"), "day")!;
    expect(october.map((b) => (b.end - b.start) / HOUR)).toEqual([23]);
    const months = bucketEdges(dayStart("2026-03-15"), dayStart("2026-05-02"), "month")!;
    expect(months.map((b) => b.day)).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
    expect(months[1].start).toBe(dayStart("2026-04-01"));
    expect(months[0].end).toBe(months[1].start);
  });

  it("cover the last instant before the range's end, and give up past the most asked for", () => {
    expect(bucketEdges(dayStart("2026-03-01"), dayStart("2026-03-03"), "day")!.map((b) => b.day)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(bucketEdges(dayStart("2020-01-01"), dayStart("2026-01-01"), "day", 100)).toBeNull();
  });

  it("are the finest grain that gives at most MOST_BARS, unless one is asked for that fits", () => {
    const from = dayStart("2025-01-01");
    expect(autoBuckets(from, dayStart("2025-03-01")).grain).toBe("day");
    expect(autoBuckets(from, dayStart("2027-01-01")).grain).toBe("week");
    expect(autoBuckets(from, dayStart("2035-01-01")).grain).toBe("month");
    const long = autoBuckets(dayStart("2009-06-01"), dayStart("2026-10-12"));
    expect(long.grain).toBe("month");
    expect(long.edges.length).toBeLessThanOrEqual(MOST_BARS);
    expect(autoBuckets(dayStart("1990-01-01"), dayStart("2026-10-12")).grain).toBe("year");
    expect(bucketsFor(from, dayStart("2027-01-01"), "day").grain).toBe("day");
    expect(bucketsFor(dayStart("1990-01-01"), dayStart("2026-10-12"), "day").grain).toBe("year");
  });
});

describe("the chart's buckets on days that begin at 06:00", () => {
  const six = (day: string) => wallClock(day, "06:00");

  it("run from 06:00 to 06:00, a bucket's small hours the day before's", () => {
    const days = bucketEdges(six("2026-11-02"), six("2026-11-04"), "day", undefined, "06:00")!;
    expect(days).toEqual([
      { day: "2026-11-02", start: six("2026-11-02"), end: six("2026-11-03") },
      { day: "2026-11-03", start: six("2026-11-03"), end: six("2026-11-04") },
    ]);
    // A range from 05:59 begins on the day before.
    expect(bucketEdges(wallClock("2026-11-03", "05:59"), six("2026-11-04"), "day", undefined, "06:00")!.map((b) => b.day)).toEqual(["2026-11-02", "2026-11-03"]);
  });

  it("make a week Monday 06:00 to the next Monday 06:00, and a month its 1st 06:00 to the next 1st's", () => {
    const [week] = bucketsFor(wallClock("2026-11-02", "05:59"), wallClock("2026-11-02", "06:00"), "week", "06:00").edges;
    expect(week).toEqual({ day: "2026-10-26", start: six("2026-10-26"), end: six("2026-11-02") });
    const [month] = bucketsFor(six("2026-11-01"), six("2026-12-01"), "month", "06:00").edges;
    expect(month).toEqual({ day: "2026-11-01", start: six("2026-11-01"), end: six("2026-12-01") });
  });
});
