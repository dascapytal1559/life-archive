// The chart's buckets: local days, weeks (from Monday), calendar months or years, their edges worked out here
// with src/time.ts so a bucket that spans a change of the clocks still begins at its own midnight. A chart may ask for
// days that begin later than midnight (the Events calendar's, at 06:00): each bucket then begins at that time on its
// first date. The query counts rows into them in one statement (tabs.ts, volumeOf).

import { addDays, dayKeyAt, dayStartAt, MIDNIGHT } from "../../src/time.ts";
import type { Grain } from "../../viewer/wire.ts";

/**
 * The most bars the chart draws when it picks the grain itself: the finest grain that gives no more. Enough for the
 * archive's whole span by month (some 200 months for messages going back fifteen years or more), which a year's bars
 * would flatten.
 */
export const MOST_BARS = 240;

/** The most bars any grain may give, asked for or not: a finer one is coarsened until it fits. */
export const MOST_BARS_ASKED = 2000;

/** The local date the `grain` bucket holding `day` begins on. */
export function bucketDay(day: string, grain: Grain): string {
  switch (grain) {
    case "day":
      return day;
    case "week": {
      // getUTCDay of a date at UTC midnight is that date's weekday: Sunday 0, so Monday is 6 days back from it.
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      return addDays(day, -((weekday + 6) % 7));
    }
    case "month":
      return `${day.slice(0, 7)}-01`;
    case "year":
      return `${day.slice(0, 4)}-01-01`;
  }
}

/** The local date the bucket after the one beginning on `day` begins on. */
export function nextBucketDay(day: string, grain: Grain): string {
  switch (grain) {
    case "day":
      return addDays(day, 1);
    case "week":
      return addDays(day, 7);
    case "month": {
      const [year, month] = day.split("-").map(Number);
      return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    }
    case "year":
      return `${Number(day.slice(0, 4)) + 1}-01-01`;
  }
}

/** One bucket: the local date it begins on, and its edges in ms, [start, end). */
export interface BucketEdge {
  day: string;
  start: number;
  end: number;
}

/**
 * The `grain` buckets covering [from, to) (ms), the first holding `from` and the last `to - 1`, with days beginning at
 * `begins` (HH:MM); null when there would be more than `most`.
 */
export function bucketEdges(from: number, to: number, grain: Grain, most = MOST_BARS_ASKED, begins = MIDNIGHT): BucketEdge[] | null {
  const last = dayKeyAt(Math.max(from, to - 1), begins);
  const edges: BucketEdge[] = [];
  let day = bucketDay(dayKeyAt(from, begins), grain);
  while (day <= last) {
    if (edges.length === most) return null;
    const next = nextBucketDay(day, grain);
    edges.push({ day, start: dayStartAt(day, begins), end: dayStartAt(next, begins) });
    day = next;
  }
  return edges;
}

/** The finest grain whose buckets over [from, to) are at most MOST_BARS, with them (years always fit). */
export function autoBuckets(from: number, to: number, begins = MIDNIGHT): { grain: Grain; edges: BucketEdge[] } {
  for (const grain of ["day", "week", "month"] as const) {
    const edges = bucketEdges(from, to, grain, MOST_BARS, begins);
    if (edges) return { grain, edges };
  }
  return { grain: "year", edges: bucketEdges(from, to, "year", Number.MAX_SAFE_INTEGER, begins)! };
}

/**
 * The buckets over [from, to), days beginning at `begins`: `grain`'s when asked for and at most MOST_BARS_ASKED of
 * them, else (or when not asked) the finest grain that gives at most MOST_BARS.
 */
export function bucketsFor(from: number, to: number, grain: Grain | null, begins = MIDNIGHT): { grain: Grain; edges: BucketEdge[] } {
  const asked = grain === null ? null : bucketEdges(from, to, grain, MOST_BARS_ASKED, begins);
  return asked ? { grain: grain!, edges: asked } : autoBuckets(from, to, begins);
}
