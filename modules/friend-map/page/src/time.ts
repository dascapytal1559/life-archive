// Calendar days and months in your time zone, used wherever messages are
// grouped or aged by day (the timeline, "last spoke", the months the map counts).
// The zone is the backend's: the page's entry and friend-map's server set it from
// the contract's handshake (GET /api/archive/contract, src/contract.ts) before
// anything is counted, so a day here is the day the backend's months and days
// are; until then it is this machine's own.

/** The time zone this machine's clock reads in: the zone used until the handshake names one. */
export function machineTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

let zone = machineTimeZone();

/** The time zone days and months are counted in (an IANA name, such as "Europe/Berlin"). */
export function timeZone(): string {
  return zone;
}

/** Counts days and months in `name` from now on; a RangeError, with nothing changed, for a zone that is not one. */
export function setTimeZone(name: string): void {
  zone = new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
}

// The locale numbers and dates are written in: the backend's, from the same handshake when it names one (contract
// 1.3.0), else this browser's.
let lang = new Intl.NumberFormat().resolvedOptions().locale;

/** The locale numbers and dates are written in (a BCP 47 tag, such as "de-DE"). */
export function locale(): string {
  return lang;
}

/** Writes numbers and dates in `name` from now on. */
export function setLocale(name: string): void {
  lang = new Intl.NumberFormat(name).resolvedOptions().locale;
}

/**
 * A date format in the time zone (timeZone()) and the locale (locale(), unless `fixed` names one, as a day key's
 * "en-CA" does for its YYYY-MM-DD), made again when either changes, so a module may make one as it loads.
 */
export function zonedFormat(options: Omit<Intl.DateTimeFormatOptions, "timeZone">, fixed?: string): Pick<Intl.DateTimeFormat, "format" | "formatToParts"> {
  let made: { zone: string; lang: string; format: Intl.DateTimeFormat } | null = null;
  const current = () => {
    const writing = fixed ?? lang;
    if (made?.zone !== zone || made.lang !== writing) made = { zone, lang: writing, format: new Intl.DateTimeFormat(writing, { ...options, timeZone: zone }) };
    return made.format;
  };
  return { format: (date) => current().format(date), formatToParts: (date) => current().formatToParts(date) };
}

/** A number as the locale writes it: 12,345 or 12.345. */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(lang, options);
}

const dayFormat = zonedFormat({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}, "en-CA");

/** The calendar date of an instant in the time zone, as YYYY-MM-DD. */
export function dayKey(ms: number): string {
  return dayFormat.format(ms);
}

/** The calendar month of an instant in the time zone, as YYYY-MM. */
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

/** Whole calendar days in the time zone from `fromMs` to `toMs` (0 when both fall on the same day). */
export function daysBetween(fromMs: number, toMs: number): number {
  const utcMidnight = (ms: number) => Date.parse(`${dayKey(ms)}T00:00:00Z`);
  return Math.round((utcMidnight(toMs) - utcMidnight(fromMs)) / 86_400_000);
}

/** "today", "yesterday", "3 days ago" or the date, counted in days of the time zone. */
export function relativeDay(ms: number, now = Date.now()): string {
  const days = daysBetween(ms, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return dayKey(ms);
}

const clockFormat = zonedFormat({
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
}, "en-CA");

/** How far the time zone's clocks are ahead of UTC at an instant, in ms (Berlin's are 1 or 2 hours). */
function offsetAt(ms: number): number {
  const part = Object.fromEntries(clockFormat.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * When a calendar day in the time zone (YYYY-MM-DD) begins, its midnight, in ms since the epoch. The offset is read twice,
 * near the day and then at the midnight found, so a day whose clocks change still begins at its own midnight (in most
 * zones they change in the small hours, never at midnight; where they skip midnight itself, the day begins as the
 * clocks reach it).
 */
export function dayStart(day: string): number {
  return wallClock(day, "00:00");
}

/**
 * The instant the time zone's clocks read `time` (HH:MM) on `day` (YYYY-MM-DD), in ms since the epoch, the offset read
 * twice as dayStart says. A time the clocks skip (2:30 am as they go forward) is read at the offset before the change,
 * an hour later by the clock.
 */
export function wallClock(day: string, time: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  return wall - offsetAt(wall - offsetAt(wall));
}

const timeOfDayFormat = zonedFormat({ hourCycle: "h23", hour: "2-digit", minute: "2-digit" }, "en-GB");

/** The time of day of an instant in the time zone, as HH:MM (19:30): what wallClock reads back. */
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
