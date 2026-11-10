// Friend map's rows of the calendar (rows.ts), pushed from the archive's social tables until friend map is a module
// of its own (the plan's M6), and its owner's answers (owners.ts): every call as a moment (the Calls tab's rows, as
// friend-map's Table lists them, without their notes), every hangout as a moment (a catch-up: with whom, how long,
// in person), and two summaries a day: whom the captain messaged, one row a day for each person (the Messages tab's
// person facet over the day: everyone who wrote to him and everyone whose one-to-one chat he wrote in, with how many
// messages), and how many messages the day had. Never a message, a note or a name: the people are the archive's person
// ids, which the owner names at read time.
//
// The days are the Events calendar's (src/calendarDay.ts: from 06:00), so a message at two in the morning is the day
// before's, as the calendar already counted it. push.ts pushes the calls after any import that brought one, the
// summaries for the days an import's messages fell on, and everything again (the summaries only when who is whom
// changed: friendMapVersion) after the people rules or an edit that touched what these rows read (FRIEND_MAP_TABLES),
// so a merge, a link or a dropped group reaches the calendar by itself.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addDays, calendarDayOf, calendarDayStart, type CalendarRow, dayKey, dayOf, type Db, type EventOwner, FRIEND_MAP, HANGOUT, namesOf, only, type OwnerDetail, wallClock, withEach } from "../../../sdk/server.ts";
import { hiddenAmong } from "./archiving.ts";
import { PERSON_CALLS } from "./calls.ts";

/** The origin of friend map's own rows: its hangouts, and its day summaries; a call's origin is its platform. */
export const FRIEND_MAP_ORIGIN = "friend-map";

/** The kinds friend map pushes: its moments, and its day summaries. */
export const CALL = "call";
export const HANGOUT_KIND = "hangout";
export const MESSAGED = "messaged";
export const MESSAGES = "messages";
export const DAY_KINDS: readonly string[] = [MESSAGED, MESSAGES];

/** The tables a changeset (archive/changes.ts) can change these rows through: what the calls, hangouts and day summaries read that an edit writes. */
export const FRIEND_MAP_TABLES: readonly string[] = [
  "person", "import_person", "conversation", "conversation_member", "catch_up", "catch_up_person", "call_length", "call_answered", "manual_call",
];

/**
 * The characters a number written as a name is made of (isNumberName in archive/names.ts): a person whose name is
 * nothing but these (or no name at all) has no name the archive knows, and a call none of whose people has one is an
 * unknown caller's ("+61491570006"), which the calendar's Calls chip can hide (the captain: "it will not show me any
 * unknown calls like calls without a name associated to it").
 */
const NUMBER_CHARACTERS = "+0123456789 ()[].-/";

/**
 * One row for each call: its key (as friend-map's listCalls keys it), when, its platform and app (FaceTime apart from
 * the phone's calls, by its service, or a call logged on iMessage or FaceTime), which way, whether it was answered
 * (yes, no, unknown), how long in seconds (NULL when not known), where it came from, everyone on it (a JSON array of
 * person ids), how many more its app did not name, and whether anyone on it has a name the archive knows (known) or not
 * (unknown). A call's rows (PERSON_CALLS, one for each person on it) agree on all but the person, so min() reads them.
 */
export const CALLS_SOURCE = `
  SELECT id, at, platform, app, service, direction, coalesce(direction, 'logged') AS way, answered,
    CASE answered WHEN 1 THEN 'yes' WHEN 0 THEN 'no' ELSE 'unknown' END AS answered_word, seconds, origin, person_ids, others,
    CASE WHEN EXISTS (SELECT 1 FROM json_each(person_ids) AS j JOIN person AS p ON p.id = j.value
      WHERE trim(coalesce(p.name, ''), '${NUMBER_CHARACTERS}') <> '') THEN 'known' ELSE 'unknown' END AS caller
  FROM (
    SELECT
      CASE WHEN call_group IS NOT NULL THEN (CASE WHEN manual_call_id IS NULL THEN 'call:' ELSE 'logged:' END) || call_group
        WHEN message_id IS NOT NULL THEN 'record:' || message_id
        WHEN call_id IS NOT NULL THEN 'call:' || call_id
        ELSE 'logged:' || manual_call_id END AS id,
      min(at) AS at, min(platform) AS platform,
      CASE WHEN min(service) IN ('facetime-audio', 'facetime-video') OR min(platform) IN ('imessage', 'facetime') THEN 'facetime'
        ELSE min(platform) END AS app,
      min(service) AS service, min(direction) AS direction, min(answered) AS answered, min(duration_seconds) AS seconds,
      CASE WHEN min(manual_call_id) IS NOT NULL THEN 'logged' WHEN min(message_id) IS NOT NULL THEN 'chat'
        WHEN min(platform) = 'phone' THEN 'history' ELSE 'app' END AS origin,
      json_group_array(DISTINCT person_id) AS person_ids, max(others) AS others
    FROM (${PERSON_CALLS}) GROUP BY 1
  )`;

interface CallSourceRow {
  id: string;
  at: number;
  platform: string;
  app: string;
  service: string | null;
  direction: "incoming" | "outgoing" | null;
  way: string;
  answered: number | null;
  answered_word: "yes" | "no" | "unknown";
  seconds: number | null;
  origin: string;
  person_ids: string;
  others: number | null;
  caller: "known" | "unknown";
}

/** Every call, as a moment each. */
export function callRows(db: Db): CalendarRow[] {
  return (db.prepare(`${CALLS_SOURCE} ORDER BY at, id`).all() as unknown as CallSourceRow[]).map((raw): CalendarRow => ({
    module: FRIEND_MAP,
    origin: raw.platform,
    nativeId: raw.id,
    shape: "moment",
    kind: CALL,
    subkind: raw.app,
    at: raw.at,
    atEnd: raw.answered === 1 && raw.seconds !== null && raw.seconds > 0 ? raw.at + raw.seconds * 1000 : null,
    day: dayKey(raw.at),
    self: true,
    direction: raw.direction === "incoming" ? "in" : raw.direction === "outgoing" ? "out" : null,
    size: null,
    hasContent: false,
    people: JSON.parse(raw.person_ids) as number[],
    facts: {
      service: raw.service, way: raw.way, answered: raw.answered_word, seconds: raw.seconds, from: raw.origin,
      others: raw.others ?? 0, caller: raw.caller,
    },
    summary: null,
  }));
}

/** The people at a hangout, by the alias `c`: a JSON array of person ids. */
const HANGOUT_PEOPLE = "(SELECT json_group_array(cp.person_id) FROM catch_up_person cp WHERE cp.catch_up_id = c.id) AS person_ids";

/** A hangout as its drawer reads it: as the archive keeps it, a trip's end and private hours too, and never its note. */
const HANGOUT_DETAIL = `
  SELECT c.day, c.time, c.trip_last_day, c.trip_end_time, c.trip_private_from, c.trip_private_to, c.others, ${HANGOUT_PEOPLE}
  FROM catch_up c WHERE c.id = ?`;

interface HangoutDetailRow {
  day: string;
  time: string | null;
  trip_last_day: string | null;
  trip_end_time: string | null;
  trip_private_from: string | null;
  trip_private_to: string | null;
  others: number;
  person_ids: string;
}

/** Every hangout, as a moment each: at when it began (its day's midnight when he gave no time), for its hours; whether it has a note, never the note. */
export function hangoutRows(db: Db): CalendarRow[] {
  const rows = db
    .prepare(`SELECT c.id, c.day, c.time, c.hours, c.others, (c.note IS NOT NULL AND c.note <> '') AS has_note, ${HANGOUT_PEOPLE} FROM catch_up c ORDER BY c.id`)
    .all() as unknown as Array<{ id: number; day: string; time: string | null; hours: number; others: number; has_note: number; person_ids: string }>;
  return rows.map((raw): CalendarRow => {
    const at = wallClock(raw.day, raw.time ?? "00:00");
    const people = JSON.parse(raw.person_ids) as number[];
    return {
      module: FRIEND_MAP,
      origin: FRIEND_MAP_ORIGIN,
      nativeId: String(raw.id),
      shape: "moment",
      kind: HANGOUT_KIND,
      subkind: null,
      at,
      atEnd: raw.time === null ? null : at + Math.round(raw.hours * 3600 * 1000),
      day: raw.day,
      self: true,
      direction: null,
      size: null,
      hasContent: raw.has_note === 1,
      people,
      facts: {
        time: raw.time, hours: raw.hours, others: raw.others, size: people.length + raw.others,
      },
      summary: null,
    };
  });
}

/** Who is whom: the captain's own accounts, each account's person, and each one-to-one chat's other person. */
export interface WhoIsWhom {
  self: Set<number>;
  personOf: Map<number, number>;
  otherOf: Map<number, number>;
}

/** Who is whom as the archive says now: what the day summaries and the Messages tab both count people by. */
export function whoIsWhom(db: Db): WhoIsWhom {
  const self = new Set<number>();
  const personOf = new Map<number, number>();
  for (const row of db.prepare("SELECT ip.id, ip.person_id, ip.is_self OR coalesce(p.is_self, 0) AS self FROM import_person ip LEFT JOIN person p ON p.id = ip.person_id ORDER BY ip.id").all() as
    Array<{ id: number; person_id: number | null; self: number }>) {
    if (row.self) self.add(row.id);
    if (row.person_id !== null) personOf.set(row.id, row.person_id);
  }
  const otherOf = new Map<number, number>();
  for (const row of db.prepare("SELECT cm.conversation_id AS chat, cm.account_id AS account FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id WHERE c.type = 'direct' ORDER BY 1, 2").all() as
    Array<{ chat: number; account: number }>) {
    const person = personOf.get(row.account);
    if (self.has(row.account) || person === undefined || otherOf.has(row.chat)) continue;
    otherOf.set(row.chat, person);
  }
  return { self, personOf, otherOf };
}

/** Every calendar day from the first message to the last; none with no messages. */
function everyDay(db: Db): string[] {
  const span = db.prepare("SELECT min(sent_at) AS first, max(sent_at) AS last FROM message").get() as { first: number | null; last: number | null };
  if (span.first === null || span.last === null) return [];
  const days: string[] = [];
  for (let day = calendarDayOf(span.first), last = calendarDayOf(span.last); day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * The day summaries of `days` (every day with messages, when none are given): one `messages` row a day, how many
 * messages it had, and one `messaged` row a day for each person messaged, how many messages with them (what they sent
 * anywhere, and everything in their one-to-one chats). Days with no messages have no rows.
 */
export function messageDayRows(db: Db, days?: readonly string[]): CalendarRow[] {
  const wanted = days ?? everyDay(db);
  if (wanted.length === 0) return [];
  const { self, personOf, otherOf } = whoIsWhom(db);
  const edges = JSON.stringify(wanted.map((day) => [day, calendarDayStart(day), calendarDayStart(addDays(day, 1))]));
  const cells = db
    .prepare(
      `WITH d(day, lo, hi) AS (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?))
       SELECT d.day AS day, m.conversation_id AS chat, m.sender_account_id AS sender, count(*) AS n
       FROM d JOIN message m ON m.sent_at >= d.lo AND m.sent_at < d.hi
       GROUP BY d.day, m.conversation_id, m.sender_account_id ORDER BY d.day`,
    )
    .all(edges) as Array<{ day: string; chat: number; sender: number | null; n: number }>;
  const totals = new Map<string, number>();
  const messaged = new Map<string, Map<number, number>>();
  for (const cell of cells) {
    totals.set(cell.day, (totals.get(cell.day) ?? 0) + cell.n);
    const sender = cell.sender === null || self.has(cell.sender) ? undefined : personOf.get(cell.sender);
    const other = otherOf.get(cell.chat);
    const people = messaged.get(cell.day) ?? new Map<number, number>();
    messaged.set(cell.day, people);
    for (const person of new Set([sender, other])) if (person !== undefined) people.set(person, (people.get(person) ?? 0) + cell.n);
  }
  const rows: CalendarRow[] = [];
  for (const [day, messages] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    const at = calendarDayStart(day);
    const atEnd = calendarDayStart(addDays(day, 1));
    const summary = (count: number, person?: number): CalendarRow => ({
      module: FRIEND_MAP,
      origin: FRIEND_MAP_ORIGIN,
      nativeId: person === undefined ? day : `${day}/${person}`,
      shape: "day",
      kind: person === undefined ? MESSAGES : MESSAGED,
      subkind: null,
      at,
      atEnd,
      day,
      self: true,
      direction: null,
      size: null,
      hasContent: true,
      people: person === undefined ? [] : [person],
      facts: {},
      summary: { messages: count },
    });
    rows.push(summary(messages));
    for (const [person, count] of [...(messaged.get(day) ?? [])].sort(([a], [b]) => a - b)) rows.push(summary(count, person));
  }
  return rows;
}

/** What the day summaries depend on beyond the messages themselves, as one string: the same string means they would come out the same. */
export function friendMapVersion(db: Db): string {
  const { self, personOf, otherOf } = whoIsWhom(db);
  return createHash("sha256").update(JSON.stringify([[...self], [...personOf], [...otherOf]])).digest("hex");
}

/** Friend map's answers: names from the person table, a call's or a hangout's drawer as its tab gave it, and who its Hide hides as it starts. */
export function friendMapOwner(archive: DatabaseSync): EventOwner {
  return {
    labelPeople: (ids) => namesOf(archive, [...ids]),
    detail: (kind, _origin, nativeId) => (kind === CALL ? callDetail(archive, nativeId) : kind === HANGOUT_KIND ? hangoutDetail(archive, nativeId) : null),
    hiddenPeople: (ids) => hiddenAmong(archive, ids),
  };
}

function callDetail(archive: DatabaseSync, id: string): OwnerDetail | null {
  const raw = archive.prepare(`SELECT * FROM (${CALLS_SOURCE}) WHERE id = ?`).get(id) as unknown as CallSourceRow | undefined;
  if (!raw) return null;
  const ids = JSON.parse(raw.person_ids) as number[];
  const names = namesOf(archive, ids);
  return {
    more: [{ label: "People on it", kind: "count", value: ids.length + Number(raw.others ?? 0) }],
    views: [{ label: "Messages that day", kind: "messages", filters: only(dayOf(raw.at)) }, ...withEach({ person_ids: raw.person_ids }, names, "Calls", "calls")],
  };
}

function hangoutDetail(archive: DatabaseSync, id: string): OwnerDetail | null {
  const raw = archive.prepare(HANGOUT_DETAIL).get(Number(id)) as unknown as HangoutDetailRow | undefined;
  if (!raw) return null;
  const at = wallClock(raw.day, raw.time ?? "00:00");
  const names = namesOf(archive, JSON.parse(raw.person_ids) as number[]);
  return {
    more: [
      { label: "Started", kind: "text", value: raw.time === null ? "Not said" : raw.time },
      ...(raw.trip_last_day === null ? [] : [
        { label: "Ended", kind: "text" as const, value: `${raw.trip_last_day} ${raw.trip_end_time}` },
        { label: "Private each day", kind: "text" as const, value: `${raw.trip_private_from}–${raw.trip_private_to}` },
      ]),
      { label: "Others not named", kind: "count", value: raw.others },
    ],
    views: [{ label: "Messages that day", kind: "messages", filters: only(dayOf(at)) }, ...withEach({ person_ids: raw.person_ids }, names, HANGOUT.Many, "hangouts")],
  };
}
