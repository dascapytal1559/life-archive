// How the viewer writes what it shows: times local, lengths as people say them, counts with their thousands
// marked, and each bucket of the chart by its grain.

import { callDuration } from "../src/calls.ts";
import { TIME_ZONE, LOCALE } from "../src/time.ts";
import type { Grain, MeasureSpec } from "./wire.ts";

const dateFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true });
const monthFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, month: "short", year: "numeric" });

/** "12 Oct 2026", the local date of an instant. */
export function dateText(ms: number): string {
  return dateFormat.format(ms);
}

/** "2:50 pm", the local time of an instant. */
export function timeText(ms: number): string {
  return timeFormat.format(ms).replace(/\s+/g, " ").toLowerCase();
}

/** A whole number with its thousands marked: "2,681". */
export function countText(n: number): string {
  return Math.round(n).toLocaleString(LOCALE);
}

/** A length in seconds as people say it ("45 s", "1 h 12 min"); none, or a call never connected, is "—". */
export function lengthText(seconds: number | null): string {
  return seconds === null || seconds === 0 ? "—" : callDuration(Math.round(seconds));
}

/** Minutes as hours and minutes for a total: "48 min", "312 h", "3 h 5 min". */
export function minutesText(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  if (hours >= 100 || whole % 60 === 0) return `${countText(Math.round(whole / 60))} h`;
  return `${hours} h ${whole % 60} min`;
}

const compact = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

/** A count for an axis, short once it is big: "950", "12K", "1.4M". */
export function shortCount(n: number): string {
  return n >= 10_000 ? compact.format(n) : countText(n);
}

/** A value of `measure`: a count, or minutes written as a length. */
export function measureText(value: number, measure: Pick<MeasureSpec, "unit">): string {
  return measure.unit === "minutes" ? minutesText(value) : countText(value);
}

/** A bucket by its grain, from the local date it begins on (YYYY-MM-DD): "12 Oct 2026", "week of 6 Oct 2026", "Oct 2026", "2026". */
export function bucketText(day: string, start: number, grain: Grain): string {
  switch (grain) {
    case "day":
      return dateText(start);
    case "week":
      return `week of ${dateText(start)}`;
    case "month":
      return monthFormat.format(start);
    case "year":
      return day.slice(0, 4);
  }
}
