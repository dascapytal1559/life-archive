// Calendar days and months in the archive's time zone, used wherever messages
// are grouped or aged by day (the timeline, "last spoke", coverage).
//
// The zone and the locale are the archive's settings (server/settings.ts), the machine's unless said. setClock sets them
// before anything else loads: server/onSettings.ts in each of the server's entry points, viewer/main.tsx on the page, so a
// module's own Intl formatter, built as it loads, is built on them. "Local" in this project means this zone's.

const machine = Intl.DateTimeFormat().resolvedOptions();

/** The zone the archive's days are reckoned in. */
export let TIME_ZONE = machine.timeZone;

/** The locale numbers and dates are written in. */
export let LOCALE = machine.locale;

const makeDayFormat = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const makeClockFormat = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const makeTimeOfDayFormat = () => new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });

let dayFormat = makeDayFormat();
let clockFormat = makeClockFormat();
let timeOfDayFormat = makeTimeOfDayFormat();

/** Sets the archive's zone and locale, for all that loads after: the top of this file says when. */
export function setClock({ timeZone, locale }: { timeZone: string; locale: string }): void {
  TIME_ZONE = timeZone;
  LOCALE = locale;
  dayFormat = makeDayFormat();
  clockFormat = makeClockFormat();
  timeOfDayFormat = makeTimeOfDayFormat();
}

/** The Accept-Language a request to another site says: the locale, then any English. */
export function acceptLanguage(): string {
  return `${LOCALE},en;q=0.9`;
}

/** The place the zone is named for, for words a person reads: "New York" for America/New_York. */
export function zonePlace(): string {
  return TIME_ZONE.split("/").at(-1)!.replaceAll("_", " ");
}

/** The local calendar date of an instant, as YYYY-MM-DD. */
export function dayKey(ms: number): string {
  return dayFormat.format(ms);
}

/** The local calendar month of an instant, as YYYY-MM. */
export function monthKey(ms: number): string {
  return dayKey(ms).slice(0, 7);
}

/** Every month from `from` to `to` inclusive, as YYYY-MM. */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  let [year, month] = from.split("-").map(Number);
  const [endYear, endMonth] = to.split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month++;
    if (month > 12) [year, month] = [year + 1, 1];
  }
  return months;
}

/** Whole local calendar days from `fromMs` to `toMs` (0 when both fall on the same day). */
export function daysBetween(fromMs: number, toMs: number): number {
  const utcMidnight = (ms: number) => Date.parse(`${dayKey(ms)}T00:00:00Z`);
  return Math.round((utcMidnight(toMs) - utcMidnight(fromMs)) / 86_400_000);
}

/** "today", "yesterday", "3 days ago" or the date, counted in local days. */
export function relativeDay(ms: number, now = Date.now()): string {
  const days = daysBetween(ms, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return dayKey(ms);
}

/** How far the archive's clocks are ahead of UTC at an instant, in ms. */
function offsetAt(ms: number): number {
  const part = Object.fromEntries(clockFormat.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - Math.floor(ms / 1000) * 1000;
}

/** An instant as the archive's clocks read it, with their offset, to the second: 2026-11-02T01:44:48+11:00. */
export function isoAt(ms: number): string {
  const offset = offsetAt(ms) / 60_000;
  const wall = new Date(Math.floor(ms / 1000) * 1000 + offset * 60_000).toISOString().slice(0, 19);
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  return `${wall}${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/**
 * When a local calendar day (YYYY-MM-DD) begins, in ms since the epoch: its midnight, or where the clocks skip midnight
 * (they go from 00:00 to 01:00 in some zones) its first instant.
 */
export function dayStart(day: string): number {
  return wallClock(day, "00:00");
}

/**
 * The instant the archive's clocks read `time` (HH:MM) on `day` (YYYY-MM-DD), in ms since the epoch, the offset read
 * twice, near the time and then at the instant found, so a day whose clocks change is read at the offset that time has.
 * A time the clocks skip (2:30 am as they go forward) is read at the offset before the change, as much later by the
 * clock as they skip, in every zone.
 */
export function wallClock(day: string, time: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  const instant = wall - offsetAt(wall - offsetAt(wall));
  return instant + Math.max(0, wall - instant - offsetAt(instant));
}

/** The local time of day of an instant, as HH:MM (19:30): what wallClock reads back. */
export function timeOfDay(ms: number): string {
  return timeOfDayFormat.format(ms);
}

/** A time of day as the event form's time box holds it: the hour (1 to 12) and the minutes, each as typed, and am or pm. */
export interface TimeParts {
  hour: string;
  minute: string;
  pm: boolean;
}

/** HH:MM (19:30) as the time box shows it (7, 30, pm); no time is both boxes empty, on pm to start. */
export function timeParts(time: string): TimeParts {
  if (!time) return { hour: "", minute: "", pm: true };
  const [hour, minute] = time.split(":").map(Number);
  return { hour: String(hour % 12 || 12), minute: String(minute).padStart(2, "0"), pm: hour >= 12 };
}

/**
 * What the time box says, as HH:MM: an hour from 1 to 12 and the minutes from 0 to 59, or with none on the hour; ""
 * with both boxes empty (no time); null for anything else (an hour out of range, minutes with no hour).
 */
export function partsTime({ hour, minute, pm }: TimeParts): string | null {
  const h = hour.trim();
  const m = minute.trim();
  if (h === "" && m === "") return "";
  if (!/^\d{1,2}$/.test(h) || !/^\d{0,2}$/.test(m)) return null;
  const hours = Number(h);
  const minutes = m === "" ? 0 : Number(m);
  if (hours < 1 || hours > 12 || minutes > 59) return null;
  return `${String((hours % 12) + (pm ? 12 : 0)).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** `day` (YYYY-MM-DD) moved `n` days on (back, for a negative `n`), on the calendar alone. */
export function addDays(day: string, n: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + n)).toISOString().slice(0, 10);
}

/** `month` (YYYY-MM) moved `n` months on (back, for a negative `n`). */
export function addMonths(month: string, n: number): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** Every day of a month (YYYY-MM), as YYYY-MM-DD, the first first. */
export function monthDays(month: string): string[] {
  const [year, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Whether `text` is a real calendar day, YYYY-MM-DD (from the year 1000 on). */
export function isDay(text: string): boolean {
  return /^[1-9]\d{3}-\d{2}-\d{2}$/.test(text) && addDays(text, 0) === text;
}

/** Whether `text` is a real calendar month, YYYY-MM (from the year 1000 on). */
export function isMonth(text: string): boolean {
  return /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(text);
}

/** When a day begins by the clock, HH:MM: midnight for the calendar's own days. */
export const MIDNIGHT = "00:00";

/** Whether `text` is a time of day as a day may begin at, HH:MM (00:00 to 23:59). */
export function isClockTime(text: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
}

/**
 * The day an instant belongs to when days begin at `begins` (HH:MM) by the archive's clock rather than at midnight: a
 * day that keeps the small hours with the evening before, from `begins` on its own date to `begins` on the next, so an
 * instant before `begins` is the day before's. At MIDNIGHT it is dayKey.
 */
export function dayKeyAt(ms: number, begins: string): string {
  const day = dayKey(ms);
  return ms < wallClock(day, begins) ? addDays(day, -1) : day;
}

/** When `day` (YYYY-MM-DD) begins when days begin at `begins` (HH:MM): its `begins` by the archive's clock (dayStart at MIDNIGHT). */
export function dayStartAt(day: string, begins: string): number {
  return wallClock(day, begins);
}
