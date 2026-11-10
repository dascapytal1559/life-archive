// Catch-ups, which the page calls hangouts (eventWords.ts): time the captain
// spent with people in person, which the message archive cannot see. Each is on a local date (at a time, when he says: shown, and
// where it sits in the chat, never in the score), with one or more people (and any
// number of others he does not name, a crowd at a wedding, say), lasted
// some hours, and may have a short note. A call is never one: it is logged as a call. In the closeness score
// (src/demos/closeness.ts) each counts as its hours times the hour's worth
// (catchUpHourWorth in data/settings.json, settings.ts) of direct messages on
// its date, times each person's share of it (groupShare: with several people
// there, the unnamed others too, part of it is shared by all and the rest
// split equally; 3 hours with one friend and 2 others at the default half
// shared: 150 × (½ + ½ ÷ 3) = 100 for the friend). The server keeps them
// (server/archive/catchUps.ts); this is what the page and the server share.
// A day's answered calls with someone count the same way, by how long they
// were (callHours), beside any catch-up that day (callCatchUps in
// src/demos/closeness.ts); a call he logged on the phone with them alone may be
// one the phone's call history has too, so the two count the longer, never
// both (callDays in server/archive/calls.ts).
// One may be over several days (trip: a trip away together, in person), from
// when it began (its day and time) to when it ended (the trip's last day and
// end time), less a private window each day (asleep, time alone: midnight to
// 10 am unless he says). Each of its days counts the time together it had,
// dated that day, as a hangout of those hours on it would (tripDayHours); it
// is one hangout, added, changed and deleted whole.

import type { CallDay, CatchUp, ClosenessSettings, GroupPerson, Trip } from "./archive.ts";
import { dayKey, wallClock, LOCALE } from "./time.ts";

/** The most hours a catch-up may last: it is on one date. */
export const HOURS_MOST = 24;

/** The most unnamed others a catch-up may have. */
export const OTHERS_MOST = 10_000;

/** The most days a catch-up over several days may be on, its first and last counted. */
export const DAYS_MOST = 366;

/** Each day's private window on a trip, unless the captain says: midnight to 10 am, asleep or apart. */
export const PRIVATE_FROM = "00:00";
export const PRIVATE_TO = "10:00";

/** A new catch-up with `person` (or nobody yet, as the Calendar's day panel starts one), as Add event in their panel starts a hangout: today, no time, an hour, in person, nobody else. */
export function freshCatchUp(person?: GroupPerson): Omit<CatchUp, "id"> {
  return { day: dayKey(Date.now()), time: null, trip: null, hours: 1, note: "", people: person ? [person] : [], others: 0 };
}

/** Every local date a catch-up is on (YYYY-MM-DD), the first first: its day, to its trip's last day when it has one. */
export function catchUpDays({ day, trip }: Pick<CatchUp, "day" | "trip">): string[] {
  const days = [day];
  while (trip !== null && days.length < DAYS_MOST && days.at(-1)! < trip.lastDay) days.push(dayAfter(days.at(-1)!));
  return days;
}

/** How many local dates a catch-up is on: 1, or its first to its trip's last, both counted. */
export function catchUpDayCount({ day, trip }: Pick<CatchUp, "day" | "trip">): number {
  return trip === null ? 1 : Math.round((utcDate(trip.lastDay) - utcDate(day)) / 86_400_000) + 1;
}

/** Whether a catch-up is on `day` (YYYY-MM-DD): its date, or any from its first to its trip's last. */
export function isOnDay({ day: first, trip }: Pick<CatchUp, "day" | "trip">, day: string): boolean {
  return first <= day && day <= (trip?.lastDay ?? first);
}

/**
 * How many hours of each of a trip's days were time together, its first first: from when it began (`day` at `time`,
 * the day's start without one) to when it ended (its last day at its end time), less the private window on each day,
 * by the clock (a day is 24 hours, the change to or from daylight saving aside). A day may have none.
 */
export function tripDayHours(day: string, time: string | null, trip: Trip): Array<{ day: string; hours: number }> {
  const windows = privateWindows(trip.privateFrom, trip.privateTo);
  const days = catchUpDays({ day, trip });
  return days.map((date, i) => {
    const from = i === 0 ? minutesOf(time ?? "00:00") : 0;
    const to = i === days.length - 1 ? minutesOf(trip.endTime) : MINUTES_A_DAY;
    const kept = windows.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(to, b) - Math.max(from, a)), 0);
    return { day: date, hours: Math.max(0, to - from - kept) / 60 };
  });
}

/** A trip's time together in all (tripDayHours added up), in hours to two decimal places: what the archive keeps as its hours. */
export function tripHours(day: string, time: string | null, trip: Trip): number {
  return Math.round(tripDayHours(day, time, trip).reduce((sum, d) => sum + d.hours, 0) * 100) / 100;
}

/** The hours a catch-up counts on each of its dates: its hours on its date, or a trip's time together each day (tripDayHours). */
export function catchUpDayHours({ day, time, trip, hours }: Pick<CatchUp, "day" | "time" | "trip" | "hours">): Array<{ day: string; hours: number }> {
  return trip === null ? [{ day, hours }] : tripDayHours(day, time, trip);
}

/** The hours a catch-up counts on `day` (YYYY-MM-DD; catchUpDayHours): none on a date it is not on. */
export function catchUpHoursOn(catchUp: Pick<CatchUp, "day" | "time" | "trip" | "hours">, day: string): number {
  return catchUpDayHours(catchUp).find((d) => d.day === day)?.hours ?? 0;
}

/**
 * How many direct messages a catch-up of `hours` counts as on its date for each of the `people` at it: their share
 * (groupShare) of everyone there, the unnamed `others` counted too (whose shares count for nobody).
 */
export function catchUpWorth(settings: Pick<ClosenessSettings, "catchUpHourWorth" | "groupSharedPart">, hours: number, people = 1, others = 0): number {
  return hours * settings.catchUpHourWorth * groupShare(settings, people + others);
}

/**
 * Each person's share of the time of a hangout or a call with `people` besides the captain: the part everyone
 * shares whole (groupSharedPart, s), and an equal split of the rest, s + (1 − s) ÷ n. With s = ½: 1 for one person,
 * 75% each for 2, 63% for 4, 52% for 25; with s = 0, 1/n, an equal split. Talk in a group is partly to everyone at
 * once and partly to one person at a time, so an equal split understates what each person there had of it.
 */
export function groupShare(settings: Pick<ClosenessSettings, "groupSharedPart">, people: number): number {
  return people <= 1 ? 1 : settings.groupSharedPart + (1 - settings.groupSharedPart) / people;
}

/**
 * How long a day's answered calls with someone count as, in seconds (CallDay): the one-to-one calls whole, and each call
 * logged with several people at their share (groupShare), rounded to the second.
 */
export function callDaySeconds(settings: Pick<ClosenessSettings, "groupSharedPart">, day: Pick<CallDay, "seconds" | "groupCalls">): number {
  return day.seconds + (day.groupCalls ?? []).reduce((sum, call) => sum + Math.round(call.seconds * groupShare(settings, call.people)), 0);
}

/** "+20 others", "+1 other": the unnamed others at a catch-up; empty for none. */
export function othersLabel(others: number): string {
  return others > 0 ? `+${others.toLocaleString(LOCALE)} ${others === 1 ? "other" : "others"}` : "";
}

/**
 * How many hours a day's answered calls with someone count as: how long they were connected, in all, once that is at
 * least callMinimumMinutes; else none (a voicemail, a missed connection).
 */
export function callHours(settings: Pick<ClosenessSettings, "callMinimumMinutes">, seconds: number): number {
  return seconds > 0 && seconds >= settings.callMinimumMinutes * 60 ? seconds / 3600 : 0;
}

/** "1 hour", "2.5 hours", "0.25 hours": how long a catch-up lasted. */
export function hoursLabel(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} hours`;
}

/**
 * "2 hours", "34 hours over 3 days": how long a catch-up lasted,
 * and over how many `days` when more than one (a trip).
 */
export function catchUpTitle(hours: number, days = 1): string {
  return `${hoursLabel(hours)}${days > 1 ? ` over ${days.toLocaleString(LOCALE)} days` : ""}`;
}

/**
 * "4 Oct 2026": a catch-up's date (YYYY-MM-DD) as people read it; over several days, to its last (`lastDay`): "4–13
 * Oct 2026", "28 Sept – 3 Oct 2026", "30 Dec 2025 – 2 Jan 2026".
 */
export function catchUpWhen(day: string, lastDay: string | null = null): string {
  const read = (key: string, parts: Intl.DateTimeFormatOptions) => new Date(utcDate(key)).toLocaleDateString(LOCALE, { ...parts, timeZone: "UTC" });
  const whole = (key: string) => read(key, { day: "numeric", month: "short", year: "numeric" });
  if (lastDay === null || lastDay === day) return whole(day);
  if (day.slice(0, 7) === lastDay.slice(0, 7)) return `${read(day, { day: "numeric" })}–${whole(lastDay)}`;
  if (day.slice(0, 4) === lastDay.slice(0, 4)) return `${read(day, { day: "numeric", month: "short" })} – ${whole(lastDay)}`;
  return `${whole(day)} – ${whole(lastDay)}`;
}

/** "10 days": how many dates a catch-up over several days is on. */
export function daysLabel(days: number): string {
  return days === 1 ? "1 day" : `${days.toLocaleString(LOCALE)} days`;
}

/** "7:30 pm", "12:05 am": a catch-up's time (19:30, 00:05) as people read it. */
export function timeLabel(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

/**
 * Catch-ups in the order they happened, the oldest first: by date, then on one date those without a time (at its
 * start) before those with one, by time, then by when they were added.
 */
export function inOrder(a: Pick<CatchUp, "id" | "day" | "time">, b: Pick<CatchUp, "id" | "day" | "time">): number {
  const time = (c: Pick<CatchUp, "time">) => c.time ?? "";
  return (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0) || a.id - b.id;
}

/** When a catch-up began, in ms since the epoch: its time on its local date, or the start of that date without one. */
export function catchUpAt({ day, time }: Pick<CatchUp, "day" | "time">): number {
  return wallClock(day, time ?? "00:00");
}

const MINUTES_A_DAY = 24 * 60;

/** Minutes into the day of a time of day (19:30). */
function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** A day's private window from `from` to `to` (times of day) as spans of minutes: two across midnight, none when they are the same. */
function privateWindows(from: string, to: string): Array<[number, number]> {
  const [a, b] = [minutesOf(from), minutesOf(to)];
  return a === b ? [] : a < b ? [[a, b]] : [[0, b], [a, MINUTES_A_DAY]];
}

/** A date (YYYY-MM-DD) as ms since the epoch at its UTC midnight, for counting days between dates. */
function utcDate(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

/** The date after `day` (YYYY-MM-DD). */
export function dayAfter(day: string): string {
  return new Date(utcDate(day) + 86_400_000).toISOString().slice(0, 10);
}
