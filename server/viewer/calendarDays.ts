// The calendar's day summaries, for the Events calendar's page (viewer/wire.ts's CALENDAR_DAYS_API): over a range of
// days, each day's messages, whom the captain messaged (friend map's summaries, server/calendar/friendMap.ts), how
// many messages he sent agents (the core's prompts, counted on the calendar's days: src/calendarDay.ts) and how its
// rituals went (rituals' day summary, modules/rituals/server/calendar.ts), with the names of everyone named, from the
// owners (server/calendar/owners.ts). Read from the calendar alone; with a person, each day's messages are those with
// them, and the rest is left out, since nobody is in them.

import { calendarDayStart } from "../../src/calendarDay.ts";
import { addDays, dayStart, isDay } from "../../src/time.ts";
import { ownerOf } from "../calendar/owners.ts";
import { FRIEND_MAP } from "../calendar/rows.ts";
import { InvalidInputError } from "../errors.ts";
import type { CalendarDaysAnswer, DaySummary, RitualsDaySummary } from "../../viewer/wire.ts";
import type { Reads } from "./tab.ts";

/** The range asked for, as the query string gives it: from (a day) to (the day after the last), and a person. */
export function readDaysAsk(params: URLSearchParams): { from: string; to: string; person: number | null } {
  const from = params.get("from");
  const to = params.get("to");
  if (from === null || !isDay(from)) throw new InvalidInputError(`from is a day, YYYY-MM-DD, not ${JSON.stringify(from)}`);
  if (to === null || !isDay(to)) throw new InvalidInputError(`to is a day, YYYY-MM-DD, not ${JSON.stringify(to)}`);
  if (to <= from) throw new InvalidInputError("to must be after from");
  const personText = params.get("person");
  const person = personText === null ? null : Number(personText);
  if (person !== null && (!/^\d+$/.test(personText!) || !Number.isSafeInteger(person))) throw new InvalidInputError(`person is a person's id, not ${JSON.stringify(personText)}`);
  return { from, to, person };
}

/** The summaries of the days in [from, to), a day each (a day with nothing left out), the most messaged first on each. */
export function calendarDays(reads: Reads, { from, to, person }: { from: string; to: string; person: number | null }): CalendarDaysAnswer {
  const db = reads.calendar;
  const days = new Map<string, DaySummary>();
  const of = (day: string): DaySummary => days.get(day) ?? days.set(day, { day, messages: 0, messaged: [], agentMessages: 0, rituals: null }).get(day)!;
  if (person === null) {
    for (const row of db
      .prepare("SELECT day, summary ->> '$.messages' AS n FROM event WHERE shape = 'day' AND kind = 'messages' AND day >= ? AND day < ?")
      .all(from, to) as Array<{ day: string; n: number }>) of(row.day).messages = row.n;
    for (const row of db
      .prepare("SELECT day, people ->> '$[0]' AS person, summary ->> '$.messages' AS n FROM event WHERE shape = 'day' AND kind = 'messaged' AND day >= ? AND day < ?")
      .all(from, to) as Array<{ day: string; person: number; n: number }>) of(row.day).messaged.push({ id: row.person, count: row.n });
    const edges: Array<[string, number, number]> = [];
    for (let day = from; day < to; day = addDays(day, 1)) edges.push([day, calendarDayStart(day), calendarDayStart(addDays(day, 1))]);
    for (const row of db
      .prepare(
        `WITH d(day, lo, hi) AS (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?))
         SELECT d.day AS day, count(*) AS n FROM d JOIN event e ON e.kind = 'llm_prompt' AND e.at >= d.lo AND e.at < d.hi GROUP BY d.day`,
      )
      .all(JSON.stringify(edges)) as Array<{ day: string; n: number }>) of(row.day).agentMessages = row.n;
    for (const row of db
      .prepare("SELECT day, summary FROM event WHERE shape = 'day' AND kind = 'ritual_day' AND day >= ? AND day < ?")
      .all(from, to) as Array<{ day: string; summary: string }>) of(row.day).rituals = JSON.parse(row.summary) as RitualsDaySummary;
  } else {
    for (const row of db
      .prepare("SELECT day, summary ->> '$.messages' AS n FROM event WHERE shape = 'day' AND kind = 'messaged' AND day >= ? AND day < ? AND people ->> '$[0]' = ?")
      .all(from, to, person) as Array<{ day: string; n: number }>) of(row.day).messages = row.n;
  }
  const listed = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const day of listed) day.messaged.sort((a, b) => b.count - a.count || a.id - b.id);
  const ids = [...new Set(listed.flatMap((day) => day.messaged.map((who) => who.id)))];
  const owner = ownerOf(reads.owners, FRIEND_MAP);
  const named = ids.length === 0 ? {} : owner.labelPeople(ids);
  // Who of everyone on the days is hidden: whom he messaged, and everyone in the calls and hangouts.
  const everyone = [...new Set([...ids, ...cardPeople(db, from, to)])];
  return {
    days: listed,
    people: Object.fromEntries(ids.map((id) => [id, named[id] ?? `Person ${id}`])),
    hidden: everyone.length === 0 ? [] : (owner.hiddenPeople?.(everyone) ?? []),
  };
}

/** Everyone in friend map's calls and hangouts on the calendar's days [from, to): their person ids. */
function cardPeople(db: Reads["calendar"], from: string, to: string): number[] {
  // A hangout with no time is kept at its date's midnight, before its day's 06:00: read from the first date's midnight.
  return (db
    .prepare(
      `SELECT DISTINCT p.value AS id FROM event e, json_each(e.people) p
       WHERE e.module = ? AND e.shape = 'moment' AND e.at >= ? AND e.at < ?`,
    )
    .all(FRIEND_MAP, dayStart(from), calendarDayStart(to)) as Array<{ id: number }>).map((row) => row.id);
}
