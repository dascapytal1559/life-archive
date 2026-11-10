// The Calendar view's read path (GET /api/archive/calendar/:month and
// /api/archive/calendar/:day, see http.ts): what each local day had, its
// chats' message counts, its calls and its catch-ups, with who was in each, so
// the page can leave out whoever its Hide does. Structure only, as
// structure.ts is: it never selects message text; a day's messages come from
// content.ts, a chat at a time (ArchiveContent.conversationDay).
//
// A day is local, from its midnight to the next (dayStart in
// src/time.ts), whatever the clocks' offset that day. Messages are counted in
// the database, per day, chat and sender, from the message_time index
// (migration 30), which holds every message by when it was sent with its
// chat, sender and type, so a month reads only its own rows of the index and
// nothing else of the messages. System messages, Marketplace chats and dropped group chats
// count in nothing, as everywhere. A group's people here are its listed
// members (less anyone taken out) and whoever wrote there in the month or on
// the day asked for: everyone who ever wrote there would take reading the
// group's whole history.

import { addDays, type CalendarChat, type CalendarDay, type CalendarDayChat, type CalendarMonth, type CalendarPerson, type CalendarTagged, catchUpHoursOn, dayKey, dayStart, type Db, identiconSeedOf, InvalidInputError, isDay, isMonth, isOnDay, monthDays, NAMED_BY, tagsWithRule } from "../../../sdk/server.ts";
import { archiveReason } from "./archiving.ts";
import { callsBetween } from "./calls.ts";
import type { People, PersonRow } from "./people.ts";
import type { ArchiveStructure } from "./structure.ts";

/** Messages per day, chat and sender, with the first and last of them. */
interface CountRow {
  /** The day's place in the days asked for, 0 first. */
  day: number;
  chat: number;
  sender: number | null;
  messages: number;
  first: number;
  last: number;
}

interface ChatRow {
  id: number;
  type: "direct" | "group";
  platform: string;
  title: string | null;
}

/** A chat's counts over the days asked for: per day, and everyone in it. */
interface Counted {
  chat: ChatRow;
  people: number[];
  /** Per day (its place in the days asked for): messages, first and last. */
  days: Map<number, { messages: number; first: number; last: number }>;
}

export class ArchiveCalendar {
  private readonly db: Db;
  private readonly people: People;
  private readonly structure: ArchiveStructure;

  constructor(db: Db, people: People, structure: ArchiveStructure) {
    this.db = db;
    this.people = people;
    this.structure = structure;
  }

  /** A month (YYYY-MM): what each of its days had, with who was in each chat, call and catch-up (a trip on each of its days, with its time together that day). */
  month(month: string): CalendarMonth {
    if (!isMonth(month)) throw new InvalidInputError(`a month is written YYYY-MM, not ${JSON.stringify(month)}`);
    const days = monthDays(month);
    const bounds = [...days, addDays(days.at(-1)!, 1)].map(dayStart);
    const chats = this.counted(bounds);
    const calls = callsBetween(this.db, bounds[0], bounds.at(-1)!).map((call) => ({ ...call, day: dayKey(call.at) }));
    const catchUps = this.people.catchUps.list({ from: days[0], to: days.at(-1) });
    const ids = new Set([...chats.flatMap((c) => c.people), ...calls.map((c) => c.person), ...catchUps.flatMap((c) => c.people.map((p) => p.id))]);
    return {
      month,
      span: this.span(),
      chats: chats.map(({ chat, people }): CalendarChat => ({ id: chat.id, type: chat.type, people })),
      people: [...this.persons([...ids]).values()].map(({ id, tags }): CalendarTagged => ({ id, tags })),
      days: days
        .map((day, n) => ({
          day,
          chats: chats.flatMap(({ chat, days }) => (days.has(n) ? [{ chat: chat.id, messages: days.get(n)!.messages }] : [])),
          calls: calls.filter((call) => call.day === day).map((call) => ({ person: call.person, answered: call.answered, seconds: call.durationSeconds, group: call.group })),
          catchUps: catchUps.filter((c) => isOnDay(c, day)).reverse().map((c) => ({ id: c.id, people: c.people.map((p) => p.id), hours: catchUpHoursOn(c, day) })),
        }))
        .filter((d) => d.chats.length + d.calls.length + d.catchUps.length > 0),
    };
  }

  /** A day (YYYY-MM-DD): its catch-ups (a trip on each of its days), calls and chats, in time order, and everyone in them. */
  day(day: string): CalendarDay {
    if (!isDay(day)) throw new InvalidInputError(`a day is written YYYY-MM-DD, not ${JSON.stringify(day)}`);
    const counted = this.counted([dayStart(day), dayStart(addDays(day, 1))]);
    const groups = counted.filter((c) => c.chat.type === "group");
    const sizes = this.structure.groupSizes(groups.map((c) => c.chat.id));
    // Only the untitled ones need their people, and only the first few.
    const members = this.structure.groupMembers(groups.filter((c) => c.chat.title === null).map((c) => c.chat.id));
    const chats = counted
      .map(({ chat, people, days }): CalendarDayChat => {
        const { messages, first, last } = days.get(0)!;
        return {
          id: chat.id,
          type: chat.type,
          people,
          platform: chat.platform,
          title: chat.title,
          size: sizes.get(chat.id) ?? 1 + people.length,
          namedBy: (members.get(chat.id) ?? []).slice(0, NAMED_BY).map(({ id, name, aliases }) => ({ id, name, aliases })),
          messages,
          first,
          last,
        };
      })
      .sort((a, b) => a.first - b.first || a.id - b.id);
    const calls = callsBetween(this.db, dayStart(day), dayStart(addDays(day, 1)));
    const catchUps = this.people.catchUps.list({ from: day, to: day }).reverse();
    const ids = new Set([...chats.flatMap((c) => c.people), ...calls.map((c) => c.person), ...catchUps.flatMap((c) => c.people.map((p) => p.id))]);
    return { day, catchUps, calls, chats, people: [...this.persons([...ids]).values()] };
  }

  /**
   * Every chat with messages between `bounds` (each day's midnight, then the midnight after the last), never a
   * Marketplace or dropped one, with its messages per day and everyone in it but the captain.
   */
  private counted(bounds: number[]): Counted[] {
    const days = JSON.stringify(bounds.slice(0, -1).map((start, n) => [start, bounds[n + 1]]));
    // Each day is a range of the message_time index; the day's own place among them is its key in the list.
    const rows = this.db
      .prepare(
        `WITH day(n, start, stop) AS (SELECT key, value ->> 0, value ->> 1 FROM json_each(:days))
         SELECT day.n AS day, m.conversation_id AS chat, m.sender_account_id AS sender,
           count(*) AS messages, min(m.sent_at) AS first, max(m.sent_at) AS last
         FROM day JOIN message m ON m.sent_at >= day.start AND m.sent_at < day.stop
         WHERE m.type != 'system'
         GROUP BY day.n, m.conversation_id, m.sender_account_id`,
      )
      .all({ days }) as unknown as CountRow[];
    if (rows.length === 0) return [];
    const chats = new Map((this.db
      .prepare(
        `SELECT id, type, platform, title FROM conversation
         WHERE id IN (SELECT value FROM json_each(?)) AND is_marketplace = 0 AND dropped_at IS NULL`,
      )
      .all(JSON.stringify([...new Set(rows.map((row) => row.chat))])) as unknown as ChatRow[]).map((chat) => [chat.id, chat]));
    const counted = new Map<number, Counted & { accounts: Set<number> }>();
    for (const row of rows) {
      const chat = chats.get(row.chat);
      if (!chat) continue;
      const entry = counted.get(chat.id) ?? { chat, people: [], days: new Map(), accounts: new Set<number>() };
      counted.set(chat.id, entry);
      if (row.sender !== null) entry.accounts.add(row.sender);
      const day = entry.days.get(row.day);
      if (day) {
        day.messages += row.messages;
        day.first = Math.min(day.first, row.first);
        day.last = Math.max(day.last, row.last);
      } else {
        entry.days.set(row.day, { messages: row.messages, first: row.first, last: row.last });
      }
    }
    const members = this.db
      .prepare("SELECT conversation_id AS chat, account_id AS account FROM conversation_member WHERE conversation_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL")
      .all(JSON.stringify([...counted.keys()])) as { chat: number; account: number }[];
    for (const { chat, account } of members) counted.get(chat)!.accounts.add(account);
    // Each account's person, the captain's own accounts left out.
    const personOf = new Map((this.db
      .prepare(
        `SELECT ip.id, ip.person_id FROM import_person ip JOIN person p ON p.id = ip.person_id
         WHERE ip.id IN (SELECT value FROM json_each(?)) AND ip.is_self = 0 AND p.is_self = 0`,
      )
      .all(JSON.stringify([...new Set([...counted.values()].flatMap((c) => [...c.accounts]))])) as { id: number; person_id: number }[])
      .map((row) => [row.id, row.person_id]));
    return [...counted.values()]
      .map(({ accounts, ...entry }) => ({
        ...entry,
        people: [...new Set([...accounts].flatMap((account) => (personOf.has(account) ? [personOf.get(account)!] : [])))].sort((a, b) => a - b),
      }))
      .sort((a, b) => a.chat.id - b.chat.id);
  }

  /** People by id: their names, identicon and tags with the rules' archive, as Hide reads them. */
  private persons(ids: number[]): Map<number, CalendarPerson> {
    const tagsOf = this.people.tags.byPerson(ids);
    const rows = this.db.prepare("SELECT * FROM person WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id").all(JSON.stringify(ids)) as unknown as PersonRow[];
    return new Map(rows.map((row) => {
      const tags = tagsOf.get(row.id) ?? [];
      return [row.id, {
        id: row.id,
        name: row.name,
        aliases: JSON.parse(row.aliases_json) as string[],
        tags: tagsWithRule({ tags, archived: archiveReason({ ...row, tags }) }),
        identiconSeed: row.identicon_seed ?? identiconSeedOf(row.id, row.created_at),
        identiconHue: row.identicon_hue,
      }];
    }));
  }

  /** The first and last days with any message, call or catch-up in the archive (a trip's last day). */
  private span(): CalendarMonth["span"] {
    const row = this.db
      .prepare(
        `SELECT (SELECT sent_at FROM message WHERE type != 'system' ORDER BY sent_at LIMIT 1) AS first_message,
           (SELECT sent_at FROM message WHERE type != 'system' ORDER BY sent_at DESC LIMIT 1) AS last_message,
           (SELECT min(at) FROM (SELECT min(at) AS at FROM call UNION ALL SELECT min(at) FROM manual_call)) AS first_call,
           (SELECT max(at) FROM (SELECT max(at) AS at FROM call UNION ALL SELECT max(at) FROM manual_call)) AS last_call,
           (SELECT min(day) FROM catch_up) AS first_catch_up, (SELECT max(coalesce(trip_last_day, day)) FROM catch_up) AS last_catch_up`,
      )
      .get() as Record<"first_message" | "last_message" | "first_call" | "last_call", number | null> & Record<"first_catch_up" | "last_catch_up", string | null>;
    const days = (times: Array<number | null>, catchUp: string | null) =>
      [...times.flatMap((at) => (at === null ? [] : [dayKey(at)])), ...(catchUp === null ? [] : [catchUp])].sort();
    return {
      first: days([row.first_message, row.first_call], row.first_catch_up)[0] ?? null,
      last: days([row.last_message, row.last_call], row.last_catch_up).at(-1) ?? null,
    };
  }
}
