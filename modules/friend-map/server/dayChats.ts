// A day's chats for the Events calendar's day (viewer/console/calendar/DayPeople.tsx), on its days from 06:00
// (src/calendarDay.ts), as the captain chose for reading a day's messages there ("actually you know what i would like
// A"): the day lists who was messaged and how many, and only a chat he opens is read, one at a time.
//
//   GET CONTENT_API/messages/days/:day                   -> DayChatsAnswer: every chat with messages that day, how many,
//                                                         when and who, with their names (never a message, so not
//                                                         kept in the trail)
//   GET CONTENT_API/messages/days/:day/people/:id?after= -> DayChatPage: a person's messages that day, everything in
//                                                         their one-to-one chats and what they said in groups, oldest
//                                                         first; kept in the trail as a day read of the person
//   GET CONTENT_API/messages/days/:day/chats/:id?after=  -> DayChatPage: one chat's messages that day (a group's),
//                                                         kept in the trail as a day read of the chat
//
// The counts are the calendar's own (calendarRows.ts's messageDayRows): every message counts, system and Marketplace
// ones too, so the chats add up to the day's Messages, and a person's list holds as many as their count.

import { addDays, calendarDayStart, type DayChat, type DayChatPage, type DayChatsAnswer, type Db, InvalidInputError, isDay, namesOf, NotFoundError } from "../../../sdk/server.ts";
import type { ArchiveContent } from "./content.ts";
import type { ContentRead } from "./contentReads.ts";
import { APPS } from "./tabs/messagesTab.ts";

/** The most messages a page of a day's chat holds; a day with more pages on. */
export const DAY_CHAT_PAGE = 500;

/** What a path under CHAT_PATH asks of a day: its chats, a person's day, or a chat's day; null for another path. */
export function dayAskOf(path: string): { day: string; person?: number; chat?: number } | null {
  const match = /^\/days\/([^/]+)(?:\/(people|chats)\/(\d+))?$/.exec(path);
  if (!match) return null;
  const day = decodeURIComponent(match[1]);
  if (!isDay(day)) throw new InvalidInputError(`a day is written YYYY-MM-DD, not ${JSON.stringify(day)}`);
  if (match[2] === "people") return { day, person: Number(match[3]) };
  if (match[2] === "chats") return { day, chat: Number(match[3]) };
  return { day };
}

/**
 * The answer to a day's ask under CHAT_PATH (`path` from /days on), with the read it is when it reads content (a
 * person's or a chat's day), null for the day's chats, which read none; null as a whole for a path that is not a day's.
 */
export function dayRead(db: Db, content: ArchiveContent, path: string, url: URL): { answer: unknown; read: Omit<ContentRead, "answer"> | null } | null {
  const ask = dayAskOf(path);
  if (ask === null) return null;
  const start = calendarDayStart(ask.day);
  const stop = calendarDayStart(addDays(ask.day, 1));
  const after = url.searchParams.get("after") ?? undefined;
  if (after !== undefined && !/^-?\d+:\d+$/.test(after)) throw new InvalidInputError(`after is a page's cursor, <ms>:<id>, not ${JSON.stringify(after)}`);
  if (ask.person !== undefined) {
    if (!db.prepare("SELECT 1 FROM person WHERE id = ?").get(ask.person)) throw new NotFoundError(`there is no person ${ask.person}`);
    const page = content.personBetween(ask.person, start, stop, { after, limit: DAY_CHAT_PAGE });
    return { answer: { messages: page.messages, after: page.nextAfter } satisfies DayChatPage, read: { what: "day", scope: { person: ask.person, day: ask.day } } };
  }
  if (ask.chat !== undefined) {
    if (!db.prepare("SELECT 1 FROM conversation WHERE id = ?").get(ask.chat)) throw new NotFoundError(`there is no chat ${ask.chat}`);
    const page = content.conversationBetween(ask.chat, start, stop, { after, limit: DAY_CHAT_PAGE });
    return { answer: { messages: page.messages, after: page.nextAfter } satisfies DayChatPage, read: { what: "day", scope: { conversation: ask.chat, day: ask.day } } };
  }
  return { answer: dayChats(db, ask.day), read: null };
}

/**
 * Every chat with messages on the calendar day `day`, the most messages first: a one-to-one chat's person as the
 * calendar counts them (its first member who is not the captain's, with a person: calendarRows.ts's whoIsWhom), a
 * group's whoever wrote there that day; and their names.
 */
export function dayChats(db: Db, day: string): DayChatsAnswer {
  const cells = db
    .prepare(
      `SELECT m.conversation_id AS chat, m.sender_account_id AS sender, count(*) AS n, min(m.sent_at) AS first, max(m.sent_at) AS last
       FROM message m WHERE m.sent_at >= ? AND m.sent_at < ? GROUP BY 1, 2`,
    )
    .all(calendarDayStart(day), calendarDayStart(addDays(day, 1))) as Array<{ chat: number; sender: number | null; n: number; first: number; last: number }>;
  const chatIds = [...new Set(cells.map((cell) => cell.chat))];
  const chats = new Map(
    (db.prepare("SELECT id, type, platform, title FROM conversation WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(chatIds)) as
      Array<{ id: number; type: "direct" | "group"; platform: string; title: string | null }>).map((chat) => [chat.id, chat]),
  );
  // Each sender's person; none for the captain's own accounts.
  const senders = new Map(
    (db
      .prepare(
        `SELECT ip.id, ip.person_id AS person, ip.is_self OR coalesce(p.is_self, 0) AS self FROM import_person ip LEFT JOIN person p ON p.id = ip.person_id
         WHERE ip.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...new Set(cells.flatMap((cell) => (cell.sender === null ? [] : [cell.sender])))])) as Array<{ id: number; person: number | null; self: number }>)
      .map((row) => [row.id, row.self ? null : row.person]),
  );
  // Each one-to-one chat's other person: its first member, by account, who is not the captain and has a person.
  const otherOf = new Map<number, number>();
  for (const row of db
    .prepare(
      `SELECT cm.conversation_id AS chat, ip.person_id AS person FROM conversation_member cm JOIN import_person ip ON ip.id = cm.account_id
       LEFT JOIN person p ON p.id = ip.person_id
       WHERE cm.conversation_id IN (SELECT value FROM json_each(?)) AND NOT (ip.is_self OR coalesce(p.is_self, 0)) AND ip.person_id IS NOT NULL
       ORDER BY cm.conversation_id, cm.account_id`,
    )
    .all(JSON.stringify(chatIds.filter((id) => chats.get(id)?.type === "direct"))) as Array<{ chat: number; person: number }>) {
    if (!otherOf.has(row.chat)) otherOf.set(row.chat, row.person);
  }
  const byChat = new Map<number, DayChat>();
  for (const cell of cells) {
    const chat = chats.get(cell.chat);
    if (!chat) continue;
    let one = byChat.get(cell.chat);
    if (!one) {
      one = { id: chat.id, type: chat.type, app: APPS[chat.platform] ?? chat.platform, title: chat.type === "group" ? chat.title : null, people: [], messages: 0, first: cell.first, last: cell.last };
      byChat.set(cell.chat, one);
    }
    one.messages += cell.n;
    one.first = Math.min(one.first, cell.first);
    one.last = Math.max(one.last, cell.last);
    const who = chat.type === "direct" ? otherOf.get(chat.id) : cell.sender === null ? null : senders.get(cell.sender);
    if (who !== undefined && who !== null && !one.people.includes(who)) one.people.push(who);
  }
  const list = [...byChat.values()].sort((a, b) => b.messages - a.messages || a.first - b.first || a.id - b.id);
  return { day, chats: list, people: namesOf(db, [...new Set(list.flatMap((chat) => chat.people))]) };
}
