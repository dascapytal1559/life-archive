// How the Fitness page writes an activity's numbers, as a training log does: distance in kilometres, time as
// "41m 2s", pace as minutes a kilometre on foot ("6:12 /km"), speed on a bike ("24.3 km/h"), pace a 100 metres in the
// water; the weeks, from Monday, local days, for the weekly summary and the zone 2 target; and a workout logged in
// Rituals as he wrote it, its gym sets a line an exercise.

import { addDays, dayKey, dayStart, LOCALE } from "../../../sdk/wire.ts";
import { zoneSeconds, type ActivitySummary, type Family, type ZoneSettings } from "../wire.ts";

/** Where the zones are from, in a line for the pages: exercise.json's (and whose), counted here, or Polar's own and why. */
export function zonesNote(zones: ZoneSettings): string {
  return zones.starts ? `Zones by ${zones.source}, counted from each workout's heart rate, not Polar's` : `Zones are Polar's own: ${zones.why}`;
}

/** Whose an activity's zones are, in words ("zones by Sample Clinic, May 2025", "Polar's zones"); null with none. */
export function zonesByText(by: ActivitySummary["zonesBy"], zones: ZoneSettings): string | null {
  if (by === "archive") return zones.starts ? `zones by ${zones.source}` : "your zones";
  return by === "polar" ? "Polar's zones" : null;
}

/** Kilometres, two places under a hundred: "5.32 km". */
export function distanceText(metres: number | null): string {
  if (metres === null) return "—";
  const km = metres / 1000;
  return `${km.toLocaleString(LOCALE, { minimumFractionDigits: km < 100 ? 2 : 1, maximumFractionDigits: km < 100 ? 2 : 1 })} km`;
}

/** A time as a log writes it: "41m 2s", "1h 2m", "45s"; a dash when nothing says. */
export function durationText(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** A time as a clock reads it: "6:12", "1:02:03". */
export function clockText(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** How a family's speed is written: pace a kilometre on foot, a 100 m in the water, speed on a bike or anything else. */
export type SpeedWay = "pace" | "pace-100m" | "speed";
export function speedWay(family: Family): SpeedWay {
  return family === "run" || family === "walk" ? "pace" : family === "swim" ? "pace-100m" : "speed";
}

/** Its label: Pace, or Avg speed. */
export const speedLabel = (family: Family): string => (speedWay(family) === "speed" ? "Avg speed" : "Pace");

/** Its value, from moving seconds over metres: "6:12 /km", "2:05 /100m", "24.3 km/h"; a dash without distance. */
export function speedText(family: Family, seconds: number | null, metres: number | null): string {
  if (!metres || metres <= 0 || !seconds || seconds <= 0) return "—";
  const way = speedWay(family);
  if (way === "speed") return `${((metres / seconds) * 3.6).toLocaleString(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km/h`;
  if (way === "pace-100m") return `${clockText((seconds / metres) * 100)} /100m`;
  return `${clockText((seconds / metres) * 1000)} /km`;
}

const DAY = 86_400_000;
const asDate = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const asDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday of the week `day` (YYYY-MM-DD) is in. */
export function weekOf(day: string): string {
  const ms = asDate(day);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return asDay(ms - weekday * DAY);
}

/** One week's totals. */
export interface WeekTotals {
  /** Its Monday, YYYY-MM-DD. */
  from: string;
  distanceM: number;
  movingS: number;
  count: number;
  /** Minutes in zone 2: each activity's once (its zone2), whatever its copies. */
  zone2Minutes: number;
  /** How many of its activities had any time in zone 2. */
  zone2Sessions: number;
  /** Minutes in heart-rate zones 4 and 5, by each activity's trusted zones (the Bryan Johnson tab's High Intensity Cardio). */
  hiitMinutes: number;
  /** Its gym sessions, oldest first: each activity logged in Rituals as a gym workout (gym push, pull, legs, any gym type), once. */
  gym: GymSession[];
}

/** A gym session's kind, by its Rituals category: push, pull, legs, or any other gym workout. */
export type GymKind = "push" | "pull" | "legs" | "other";

/** One gym session: its day (YYYY-MM-DD), its kind and its Rituals category as logged ("gym push"). */
export interface GymSession {
  day: string;
  kind: GymKind;
  type: string;
}

/** It is a gym session: logged in Rituals under a gym category ("gym push", "gym legs"). */
export const isGym = (activity: Pick<ActivitySummary, "logged">): boolean => /^gym\b/i.test(activity.logged?.type.trim() ?? "");

/** A gym category's kind: "gym push" is push, "gym pull" pull, "gym legs" (or "gym leg") legs, any other gym type other. */
export function gymKind(type: string): GymKind {
  const kind = /^gym\s+(push|pull|legs?)\b/i.exec(type.trim())?.[1].toLowerCase();
  return kind === "push" || kind === "pull" ? kind : kind ? "legs" : "other";
}

/** How hovering a session names it: "Tuesday, 3 Nov 2026 · Gym push". */
export function gymSessionText(session: GymSession): string {
  const type = session.type.trim();
  return `${WEEKDAYS[new Date(asDate(session.day)).getUTCDay()]}, ${dayText(session.day)} · ${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()}`;
}

/** An activity's minutes in heart-rate zones 4 and 5, by its trusted zones (none when its heart rate is not trusted). */
export const hiitMinutesOf = (activity: Pick<ActivitySummary, "zones">): number => activity.zones.filter((z) => z.zone >= 4).reduce((total, z) => total + (zoneSeconds(z.time) ?? 0), 0) / 60;

/** The last `count` weeks to `today`'s, oldest first, each with its activities' distance, moving time, number, minutes in zone 2, minutes in zones 4 and 5, and gym sessions (oldest first). */
export function weeksTo(activities: readonly ActivitySummary[], today: string, count: number): WeekTotals[] {
  const last = asDate(weekOf(today));
  const weeks: WeekTotals[] = Array.from({ length: count }, (_, i) => ({ from: asDay(last - (count - 1 - i) * 7 * DAY), distanceM: 0, movingS: 0, count: 0, zone2Minutes: 0, zone2Sessions: 0, hiitMinutes: 0, gym: [] }));
  const byFrom = new Map(weeks.map((week) => [week.from, week]));
  for (const activity of activities) {
    const week = byFrom.get(weekOf(activity.start.slice(0, 10)));
    if (!week) continue;
    week.distanceM += activity.distanceM ?? 0;
    week.movingS += activity.movingS ?? 0;
    week.count++;
    week.zone2Minutes += activity.zone2?.minutes ?? 0;
    if ((activity.zone2?.minutes ?? 0) > 0) week.zone2Sessions++;
    week.hiitMinutes += hiitMinutesOf(activity);
    if (isGym(activity)) week.gym.push({ day: activity.start.slice(0, 10), kind: gymKind(activity.logged?.type ?? ""), type: activity.logged?.type ?? "" });
  }
  for (const week of weeks) week.gym.sort((a, b) => a.day.localeCompare(b.day));
  return weeks;
}

/** Minutes as the zone 2 target writes them: "184 min", "5h", "5h 20m". */
export function minutesText(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One line of a Rituals log: an exercise and its sets ("Bench press", ["20 kg x 8", "40 kg x 10"]), or words alone. */
export interface LogLine {
  name: string | null;
  sets: string[];
  text: string | null;
}

/**
 * A Rituals log's words as lines to read: each line or sentence an exercise when it names one and its sets
 * ("Bench press: 20 kg x 8; 40 kg x 10" is Bench press, with 20 kg x 8 and 40 kg x 10), else as written.
 */
export function logLines(details: string): LogLine[] {
  return details
    .split(/\n|(?<=\.)\s+(?=[A-Z])/)
    .map((line) => line.trim().replace(/\.$/, ""))
    .filter((line) => line !== "")
    .map((line) => {
      const named = /^([^:;]{1,60}):\s*(.+)$/.exec(line);
      if (!named) return { name: null, sets: [], text: line };
      const sets = named[2].split(/\s*[;,]\s*/).filter((set) => set !== "");
      return { name: named[1].trim(), sets, text: null };
    });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A day as "2 Nov 2026". */
export function dayText(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** A wall-clock time "07:15" as "7:15 am". */
export function timeText(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${h < 12 ? "am" : "pm"}`;
}

/**
 * When an activity started, as a feed says it: "Today at 7:15 am", "Yesterday at …", else "Sunday, 2 Nov 2026 at …";
 * the day alone ("Today", "Sunday, 2 Nov 2026") when only its day is known.
 */
export function startText(start: string, today: string): string {
  const day = start.slice(0, 10);
  const at = start.length > 10 ? ` at ${timeText(start.slice(11, 16))}` : "";
  const daysAgo = Math.round((asDate(today) - asDate(day)) / DAY);
  if (daysAgo === 0) return `Today${at}`;
  if (daysAgo === 1) return `Yesterday${at}`;
  return `${WEEKDAYS[new Date(asDate(day)).getUTCDay()]}, ${dayText(day)}${at}`;
}

/** How a delete's confirmation names an activity, whatever today is: "Wednesday, 14 Oct 2026 at 6:50 am · Running · 5.80 km". */
export function deleteName(activity: Pick<ActivitySummary, "start" | "sport" | "distanceM">): string {
  const day = activity.start.slice(0, 10);
  const distance = activity.distanceM === null ? "no distance recorded" : distanceText(activity.distanceM);
  const at = activity.start.length > 10 ? ` at ${timeText(activity.start.slice(11, 16))}` : "";
  return `${WEEKDAYS[new Date(asDate(day)).getUTCDay()]}, ${dayText(day)}${at} · ${activity.sport} · ${distance}`;
}

/** A week's label under its bar: "27 Oct". */
export function weekLabel(from: string): string {
  return `${Number(from.slice(8, 10))} ${MONTHS[Number(from.slice(5, 7)) - 1]}`;
}

/** The weekly charts' x axis: each week whose Monday is its month's first Monday (the 1st to the 7th) labelled by that month ("Sep"), the rest null.
 *  No week is labelled for being first or last, so labels sit where months start and the spacing follows the calendar. */
export function monthTicks(froms: readonly string[]): (string | null)[] {
  return froms.map((from) => (Number(from.slice(8, 10)) <= 7 ? MONTHS[Number(from.slice(5, 7)) - 1] : null));
}

/** A week as the captain writes it, Monday to the next Monday: "Oct 26 – Nov 2". */
export function weekSpan(from: string): string {
  const md = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
  return `${md(from)} – ${md(asDay(asDate(from) + 7 * DAY))}`;
}

/** How far through its local week (Monday 00:00 to Sunday 24:00) the instant `now` is, 0 to 1; a week that
 *  changes the clocks is an hour shorter or longer, and counted so. */
export function weekElapsed(now: number): number {
  const monday = weekOf(dayKey(now));
  const start = dayStart(monday);
  return Math.min(1, Math.max(0, (now - start) / (dayStart(addDays(monday, 7)) - start)));
}

/** A gym session's word on its chip: "Push", "Pull", "Legs", else its own type without "gym" ("gym core" is "Core", "gym" alone "Gym"). */
export function gymWord(session: Pick<GymSession, "kind" | "type">): string {
  if (session.kind !== "other") return session.kind === "push" ? "Push" : session.kind === "pull" ? "Pull" : "Legs";
  const rest = session.type.trim().replace(/^gym\b\s*/i, "");
  return rest === "" ? "Gym" : `${rest.charAt(0).toUpperCase()}${rest.slice(1).toLowerCase()}`;
}

/** How many sessions tall the gym chart is: three, or its fullest week's count when one has more. */
export function gymRows(weeks: readonly Pick<WeekTotals, "gym">[]): number {
  return Math.max(3, ...weeks.map((w) => w.gym.length));
}

/** How pointing at a week of the gym chart says it: "Oct 26 – Nov 2 · 2 sessions: Push, Legs", "… · no sessions". */
export function gymWeekText(week: Pick<WeekTotals, "from" | "gym">): string {
  const n = week.gym.length;
  const said = n === 0 ? "no sessions" : `${n} ${n === 1 ? "session" : "sessions"}: ${week.gym.map(gymWord).join(", ")}`;
  return `${weekSpan(week.from)} · ${said}`;
}

/** How pointing at a week of the zone 2 chart says it: "Oct 26 – Nov 2 · 184 min in zone 2". */
export function zone2WeekText(week: Pick<WeekTotals, "from" | "zone2Minutes" | "zone2Sessions">): string {
  const sessions = week.zone2Sessions > 0 ? `, ${week.zone2Sessions} ${week.zone2Sessions === 1 ? "session" : "sessions"}` : "";
  return `${weekSpan(week.from)} · ${minutesText(week.zone2Minutes)}${sessions}`;
}

/** A length for a scale bar about a fifth of `metres` wide: 1, 2 or 5 times a power of ten. */
export function scaleLength(metres: number): number {
  const target = Math.max(1, metres / 5);
  const power = 10 ** Math.floor(Math.log10(target));
  return [5, 2, 1].map((n) => n * power).find((n) => n <= target) ?? power;
}

/** A scale bar's label: "500 m", "2 km". */
export function scaleText(metres: number): string {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}

/** A pound in kilograms. */
const LB_KG = 0.45359237;

/** It reads as a set: it says its reps ("x 8", "× 10"); a note in a log ("went well") does not. */
const isSet = (text: string): boolean => /[x×*]\s*\d/i.test(text);

/**
 * A gym set's load in kilograms, its weight times its reps: "40 kg x 10" is 400, "20 lb x 8" about 72.6, a note after
 * its reps ("40kg x8 (logged 18:02)", "40 kg × 8 easy") aside. Null for a set without a usable weight: one without a
 * unit ("3 x 12"), bodyweight or added to it ("+10kg x8"), unassisted, or assisted (whose load is the body's less the
 * help, and the body's weight is never guessed), each hand's ("12 kg each × 10"), or one whose reps are not plain ("x8 x3").
 */
export function setLoadKg(set: string): number | null {
  const said = set.trim().toLowerCase();
  if (/assist|body\s*weight|\bbw\b/.test(said)) return null;
  const parts = /^(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?|lb|lbs|pounds?)\s*[x×*]\s*(\d+)\b(.*)$/.exec(said);
  if (!parts || isSet(parts[4])) return null;
  const weight = Number(parts[1]) * (parts[2].startsWith("k") ? 1 : LB_KG);
  return weight * Number(parts[3]);
}

/**
 * A Rituals log's total load: every set's load summed (kg), and how many sets had no usable weight and were left out.
 * Its sets are those after an exercise's name ("Bench press: 40 kg x 10; 50 kg x 8") and those on lines of their own
 * ("- 40 kg × 8", under a heading); words that are not a set (no reps) are neither weighed nor left out.
 */
export function logLoad(details: string): { kg: number; leftOut: number } {
  let kg = 0;
  let leftOut = 0;
  for (const line of logLines(details)) {
    const sets = line.name !== null ? line.sets : (line.text ?? "").replace(/^[-•*]\s*/, "").split(/\s*[;,]\s*/);
    for (const set of sets.filter(isSet)) {
      const load = setLoadKg(set);
      if (load === null) leftOut++;
      else kg += load;
    }
  }
  return { kg, leftOut };
}

/** How a sport is measured in the By sport summary: its total time, its total distance, or (a gym type) its total load. */
export type SportMeasure = "time" | "distance" | "load";

/** One sport's row of the By sport summary. */
export interface SportTotals {
  /** As the feed names it ("Cycling", "Gym push"). */
  sport: string;
  count: number;
  measure: SportMeasure;
  /** Seconds, metres or kilograms, by its measure. */
  total: number;
  /** For load: how many sets had no usable weight and were left out of it. */
  leftOut: number;
}

/** A gym session's sport as the summary names it, by its Rituals category: "gym push" is "Gym push". */
const gymSport = (type: string) => {
  const t = type.trim().replace(/\s+/g, " ");
  return `${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()}`;
};

/**
 * Each sport's number of sessions and its own measure, in a fixed order that does not move as counts change: walking, running,
 * cycling, gym push, pull and legs, then any other gym type, then every other sport (each group by name). Running by distance, a gym type (push, pull,
 * legs, any gym workout logged in Rituals) by load, every other sport (cycling, walking, …) by time.
 */
export function sportTotals(activities: readonly ActivitySummary[]): SportTotals[] {
  const sports = new Map<string, SportTotals>();
  for (const activity of activities) {
    const gym = isGym(activity);
    const sport = gym ? gymSport(activity.logged!.type) : activity.sport;
    const measure: SportMeasure = gym ? "load" : activity.family === "run" ? "distance" : "time";
    const row = sports.get(sport) ?? { sport, count: 0, measure, total: 0, leftOut: 0 };
    row.count++;
    if (measure === "load") {
      const load = logLoad(activity.logged!.details);
      row.total += load.kg;
      row.leftOut += load.leftOut;
    } else row.total += (measure === "distance" ? activity.distanceM : (activity.movingS ?? activity.elapsedS)) ?? 0;
    sports.set(sport, row);
  }
  return [...sports.values()].sort((a, b) => sportRank(a) - sportRank(b) || a.sport.localeCompare(b.sport));
}

/** The captain's order for By sport: "walking, running, cycling, gym push, gym pull, gym legs", then other gym types, then the rest. */
const SPORT_ORDER = ["walking", "running", "cycling", "gym push", "gym pull", "gym legs"];
function sportRank(row: SportTotals): number {
  const i = SPORT_ORDER.indexOf(row.sport.toLowerCase());
  return i >= 0 ? i : row.measure === "load" ? SPORT_ORDER.length : SPORT_ORDER.length + 1;
}

/** A load in words: "12,340 kg". */
export const loadText = (kg: number): string => `${Math.round(kg).toLocaleString(LOCALE)} kg`;

/** A sport's row as the summary writes it: "12 · 6h 40m", "8 · 15.86 km", "5 · 12,340 kg". */
export function sportTotalsText(row: SportTotals): string {
  const total = row.measure === "load" ? loadText(row.total) : row.measure === "distance" ? distanceText(row.total) : durationText(row.total);
  return `${row.count} · ${total}`;
}

/** What hovering a sport's row says of its measure: total time, total distance, or the load and the sets left out of it. */
export function sportTotalsNote(row: SportTotals): string {
  if (row.measure === "time") return `${row.sport}: total time`;
  if (row.measure === "distance") return `${row.sport}: total distance`;
  const left = row.leftOut === 0 ? "every set had a weight" : `${row.leftOut} ${row.leftOut === 1 ? "set" : "sets"} without a usable weight (bodyweight, unassisted or assisted) left out`;
  return `${row.sport}: total load, weight × reps over every set, lb as kg; ${left}`;
}
