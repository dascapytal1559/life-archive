// The Calendar view's read path (calendar.ts) and a chat's day (content.ts):
// Melbourne days cut at their own midnights, on either side of the clocks
// changing and at a month's ends; what counts (not system messages,
// Marketplace or dropped chats); who is in each chat, call and catch-up, with
// their tags for Hide; and a day's messages a page at a time, oldest first.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchiveEvent, type CalendarMonth, type Db, InvalidInputError, transaction } from "../../../sdk/server.ts";
import { ArchiveCalendar } from "./calendarView.ts";
import { ArchiveContent } from "./content.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let calendar: ArchiveCalendar;
let content: ArchiveContent;

const account = (name: string, isSelf = false): ArchiveEvent => ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf });
let next = 0;
const message = (conversation: string, sender: string | null, sentAt: string, type: "text" | "system" = "text"): ArchiveEvent => ({
  kind: "message", id: `m${++next}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt: Date.parse(sentAt), type, text: `line ${next}`, raw: {},
});

function importEvents(platform: string, events: ArchiveEvent[]): void {
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
      .run(platform).lastInsertRowid);
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
}

const idOf = (name: string) => (db.prepare("SELECT id FROM person WHERE name = ?").get(name) as { id: number }).id;
const chatOf = (platformId: string) => (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = ?").get(platformId) as { id: number }).id;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-calendar-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  const structure = new ArchiveStructure(db, people);
  calendar = new ArchiveCalendar(db, people, structure);
  content = new ArchiveContent(db, dataDir);
  importEvents("messenger", [
    account("Me", true), account("Ada Example"), account("Bea Example"), account("Cy Example"), account("Dee Example"), account("Eve Example"), account("Seller Example"), account("Stranger Example"),
    { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada Example"] },
    { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy Example"] },
    // A small group I write in, untitled; Eve is listed and never writes, and Dee was taken out (below).
    { kind: "conversation", id: "friends", type: "group", members: ["Me", "Ada Example", "Bea Example", "Dee Example", "Eve Example"] },
    // A group dropped by the captain, and a Marketplace chat: neither counts.
    { kind: "conversation", id: "bulk", type: "group", title: "Bulk", members: ["Me", "Ada Example", "Cy Example"] },
    // A chat only they wrote in: the rules archive them.
    { kind: "conversation", id: "stranger", type: "direct", members: ["Me", "Stranger Example"] },
    { kind: "conversation", id: "bike", type: "direct", title: "Seller · Bike", members: ["Me", "Seller Example"], marketplace: true },
    // October 2025: AEST (+10) until 2 am on Sunday the 5th, then AEDT (+11).
    message("ada", "Ada Example", "2025-09-30T23:59:59.999+10:00"),
    message("ada", "Me", "2025-10-01T00:00:00+10:00"),
    message("ada", "Ada Example", "2025-10-04T23:59:59+10:00"),
    message("ada", "Ada Example", "2025-10-05T00:30:00+10:00"),
    message("ada", "Me", "2025-10-05T09:00:00+11:00"),
    message("cy", "Cy Example", "2025-10-05T08:00:00+11:00"),
    message("ada", "Me", "2025-10-05T23:59:00+11:00"),
    message("ada", "Ada Example", "2025-10-06T00:00:00+11:00"),
    message("ada", "Ada Example", "2025-10-31T23:59:59+11:00"),
    message("ada", "Me", "2025-11-01T00:00:00+11:00"),
    message("friends", "Bea Example", "2025-10-05T10:00:00+11:00"),
    message("friends", "Me", "2025-10-05T10:05:00+11:00"),
    message("friends", "Bea Example", "2025-10-05T10:06:00+11:00"),
    message("friends", null, "2025-10-05T10:07:00+11:00", "system"),
    message("friends", "Ada Example", "2025-10-12T10:00:00+11:00"),
    message("bulk", "Me", "2025-10-05T12:00:00+11:00"),
    message("stranger", "Stranger Example", "2025-10-05T14:00:00+11:00"),
    message("bike", "Seller Example", "2025-10-05T13:00:00+11:00"),
    message("bike", "Me", "2025-10-05T13:05:00+11:00"),
    // April 2025: AEDT (+11) until 3 am on Sunday the 6th, then AEST (+10).
    message("cy", "Cy Example", "2025-04-05T23:59:59+11:00"),
    message("cy", "Me", "2025-04-06T00:00:00+11:00"),
    message("cy", "Cy Example", "2025-04-06T23:59:59+10:00"),
    message("cy", "Me", "2025-04-07T00:00:00+10:00"),
  ]);
  // Ada's number: the rules join it to her by name.
  importEvents("phone", [
    { kind: "account", key: "+61491571266", keyKind: "id", displayName: "Ada Example", handle: "+61491571266" },
    { kind: "call", id: "c1", with: "+61491571266", at: Date.parse("2025-10-05T18:00:00+11:00"), durationSeconds: 1860, direction: "outgoing", answered: true, service: "phone", raw: {} },
    { kind: "call", id: "c2", with: "+61491571266", at: Date.parse("2025-10-05T21:00:00+11:00"), durationSeconds: 0, direction: "incoming", answered: false, service: "phone", raw: {} },
    { kind: "call", id: "c3", with: "+61491571266", at: Date.parse("2025-11-01T00:30:00+11:00"), durationSeconds: 60, direction: "incoming", answered: true, service: "phone", raw: {} },
  ]);
  people.runRules();
  people.dropGroup(chatOf("bulk"));
  people.removeFromGroup(chatOf("friends"), idOf("Dee Example"));
  people.setTags(idOf("Bea Example"), ["archive"]);
  people.setTags(idOf("Cy Example"), ["climbing"]);
  people.addCatchUp({ day: "2025-10-05", hours: 3, note: "dinner", personIds: [idOf("Ada Example"), idOf("Cy Example")] });
  people.addCatchUp({ day: "2025-10-20", hours: 1, note: "", personIds: [idOf("Cy Example")] });
});

afterAll(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A month's days as day -> chat platform ids and their counts. */
function counts(month: CalendarMonth) {
  const name = new Map((db.prepare("SELECT id, platform_conversation_id AS key FROM conversation").all() as { id: number; key: string }[]).map((c) => [c.id, c.key]));
  return Object.fromEntries(month.days.map((d) => [d.day, Object.fromEntries(d.chats.map((c) => [name.get(c.chat), c.messages]))]));
}

describe("a month of the calendar", () => {
  it("counts each chat's messages on the Melbourne day they were sent, cut at its own midnight, either side of the clocks changing", () => {
    expect(counts(calendar.month("2025-10"))).toEqual({
      // The last millisecond of 30 September is not October's; midnight starts the 1st.
      "2025-10-01": { ada: 1 },
      "2025-10-04": { ada: 1 },
      // The day the clocks go forward begins at midnight AEST and ends at midnight AEDT, 23 hours later.
      "2025-10-05": { ada: 3, cy: 1, friends: 3, stranger: 1 },
      "2025-10-06": { ada: 1 },
      "2025-10-12": { friends: 1 },
      "2025-10-20": {},
      // The last second of the month is its own; November's first midnight is not.
      "2025-10-31": { ada: 1 },
    });
    // The day the clocks go back is 25 hours long.
    expect(counts(calendar.month("2025-04"))).toEqual({ "2025-04-05": { cy: 1 }, "2025-04-06": { cy: 2 }, "2025-04-07": { cy: 1 } });
    expect(counts(calendar.month("2025-09"))).toEqual({ "2025-09-30": { ada: 1 } });
    expect(calendar.month("2024-01")).toMatchObject({ chats: [], days: [], people: [] });
  });

  it("leaves out system messages, the Marketplace chat and the dropped group", () => {
    const month = calendar.month("2025-10");
    const chats = month.chats.map((c) => c.id).sort((a, b) => a - b);
    expect(chats).toEqual([chatOf("ada"), chatOf("cy"), chatOf("friends"), chatOf("stranger")].sort((a, b) => a - b));
  });

  it("names everyone in each chat but the captain: the one other person, or a group's members less anyone taken out", () => {
    const month = calendar.month("2025-10");
    const chat = (key: string) => month.chats.find((c) => c.id === chatOf(key))!;
    expect(chat("ada")).toEqual({ id: chatOf("ada"), type: "direct", people: [idOf("Ada Example")] });
    expect(chat("friends").type).toBe("group");
    expect(chat("friends").people).toEqual(["Ada Example", "Bea Example", "Eve Example"].map(idOf).sort((a, b) => a - b));
  });

  it("has the calls and catch-ups of each day, by who they were with", () => {
    const month = calendar.month("2025-10");
    const day = (d: string) => month.days.find((x) => x.day === d)!;
    expect(day("2025-10-05").calls).toEqual([
      { person: idOf("Ada Example"), answered: true, seconds: 1860, group: null },
      { person: idOf("Ada Example"), answered: false, seconds: 0, group: null },
    ]);
    expect(day("2025-10-05").catchUps).toEqual([{ id: 1, people: [idOf("Ada Example"), idOf("Cy Example")], hours: 3 }]);
    expect(day("2025-10-20")).toEqual({ day: "2025-10-20", chats: [], calls: [], catchUps: [{ id: 2, people: [idOf("Cy Example")], hours: 1 }] });
    // The call half an hour into November is November's.
    expect(calendar.month("2025-11").days.map((d) => [d.day, d.calls.length])).toEqual([["2025-11-01", 1]]);
  });

  it("gives everyone in it with their tags, the rules' archive as \"archive\", for Hide", () => {
    const month = calendar.month("2025-10");
    const tags = Object.fromEntries(month.people.map((p) => [p.id, p.tags]));
    // The stranger only wrote to me: the rules archive them. The captain archived Bea himself, and tagged Cy.
    expect(tags[idOf("Stranger Example")]).toEqual(["archive"]);
    expect(tags[idOf("Bea Example")]).toEqual(["archive"]);
    expect(tags[idOf("Cy Example")]).toEqual(["climbing"]);
    // Eve is kept, as everyone in a small group the captain writes in is.
    expect(tags[idOf("Eve Example")]).toEqual([]);
    expect(tags[idOf("Ada Example")]).toEqual([]);
    expect(month.people.some((p) => p.id === idOf("Seller Example") || p.id === idOf("Me"))).toBe(false);
  });

  it("says the first and last days with anything, to navigate by", () => {
    expect(calendar.month("2025-10").span).toEqual({ first: "2025-04-05", last: "2025-11-01" });
  });

  it("counts from the message_time index, reading only the month's rows", () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      WITH day(n, start, stop) AS (SELECT key, value ->> 0, value ->> 1 FROM json_each(?))
      SELECT day.n, m.conversation_id, m.sender_account_id, count(*), min(m.sent_at), max(m.sent_at)
      FROM day JOIN message m ON m.sent_at >= day.start AND m.sent_at < day.stop WHERE m.type != 'system'
      GROUP BY day.n, m.conversation_id, m.sender_account_id`).all("[[0, 1]]") as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toMatch(/SEARCH m USING COVERING INDEX message_time \(sent_at>\? AND sent_at<\?\)/);
  });

  it("refuses what is not a month or a day", () => {
    for (const wrong of ["2026-13", "2026-1", "October", ""]) expect(() => calendar.month(wrong)).toThrow(InvalidInputError);
    for (const wrong of ["2026-02-30", "2026-10-4", "today"]) expect(() => calendar.day(wrong)).toThrow(InvalidInputError);
  });
});

describe("a day of the calendar", () => {
  it("lists its chats in the order their first message came, each with its messages that day, and what names it", () => {
    const day = calendar.day("2025-10-05");
    expect(day.chats.map((c) => [c.id, c.type, c.messages, c.first, c.last])).toEqual([
      [chatOf("ada"), "direct", 3, Date.parse("2025-10-05T00:30:00+10:00"), Date.parse("2025-10-05T23:59:00+11:00")],
      [chatOf("cy"), "direct", 1, Date.parse("2025-10-05T08:00:00+11:00"), Date.parse("2025-10-05T08:00:00+11:00")],
      [chatOf("friends"), "group", 3, Date.parse("2025-10-05T10:00:00+11:00"), Date.parse("2025-10-05T10:06:00+11:00")],
      [chatOf("stranger"), "direct", 1, Date.parse("2025-10-05T14:00:00+11:00"), Date.parse("2025-10-05T14:00:00+11:00")],
    ]);
    const friends = day.chats[2];
    // Untitled: named by its people, most messages there first, and counted as its header counts them (Dee is out).
    expect(friends).toMatchObject({ platform: "messenger", title: null, size: 4 });
    expect(friends.namedBy.map((p) => p.name)).toEqual(["Bea Example", "Ada Example", "Eve Example"]);
    expect(day.chats[0]).toMatchObject({ size: 2, namedBy: [], people: [idOf("Ada Example")] });
  });

  it("has its calls in time order and its catch-ups, and everyone in them with their names, identicon and tags", () => {
    const day = calendar.day("2025-10-05");
    expect(day.calls.map((c) => [c.person, c.answered, c.durationSeconds, c.direction])).toEqual([
      [idOf("Ada Example"), true, 1860, "outgoing"],
      [idOf("Ada Example"), false, 0, "incoming"],
    ]);
    expect(day.catchUps.map((c) => [c.hours, c.note, c.people.map((p) => p.name)])).toEqual([[3, "dinner", ["Ada Example", "Cy Example"]]]);
    const ada = day.people.find((p) => p.id === idOf("Ada Example"))!;
    expect(ada).toMatchObject({ name: "Ada Example", aliases: [], tags: [] });
    expect(ada.identiconSeed).toMatch(/^[0-9a-f]+$/);
    expect(day.people.map((p) => p.name).sort()).toEqual(["Ada Example", "Bea Example", "Cy Example", "Eve Example", "Stranger Example"]);
  });

  it("is empty on a day with nothing", () => {
    expect(calendar.day("2025-10-02")).toEqual({ day: "2025-10-02", catchUps: [], calls: [], chats: [], people: [] });
  });
});

describe("a chat's day", () => {
  it("pages that day's messages oldest first, leaving out system messages and every other day", () => {
    const first = content.conversationDay(chatOf("friends"), "2025-10-05", { limit: 2 });
    expect(first.messages.map((m) => [m.sender, m.fromSelf, m.text !== null])).toEqual([["Bea Example", false, true], ["Me", true, true]]);
    expect(first.nextAfter).not.toBeNull();
    const second = content.conversationDay(chatOf("friends"), "2025-10-05", { limit: 2, after: first.nextAfter! });
    expect(second.messages.map((m) => m.sentAt)).toEqual([Date.parse("2025-10-05T10:06:00+11:00")]);
    expect(second.nextAfter).toBeNull();
    const ada = content.conversationDay(chatOf("ada"), "2025-10-05").messages.map((m) => m.sentAt);
    expect(ada).toEqual(["2025-10-05T00:30:00+10:00", "2025-10-05T09:00:00+11:00", "2025-10-05T23:59:00+11:00"].map(Date.parse));
    expect(content.conversationDay(chatOf("ada"), "2025-10-02").messages).toEqual([]);
  });
});

describe("a trip in the calendar", () => {
  // Last, as it moves the last day with anything. Away with Eve from 8 pm on 29 November to 9 am on 2 December, private
  // midnight to 10 am: 4 hours, 14, 14 and none.
  beforeAll(() => {
    people.addCatchUp({ day: "2025-11-29", time: "20:00", trip: { lastDay: "2025-12-02", endTime: "09:00" }, note: "the snow", personIds: [idOf("Eve Example")] });
  });

  it("is on each of its days in each month, one by its number, with its time together that day, none on one still listed", () => {
    const hours = (month: string) => calendar.month(month).days.flatMap((d) => d.catchUps.map((c) => [d.day, c.id, c.people, c.hours]));
    expect(hours("2025-11")).toEqual([["2025-11-29", 3, [idOf("Eve Example")], 4], ["2025-11-30", 3, [idOf("Eve Example")], 14]]);
    expect(hours("2025-12")).toEqual([["2025-12-01", 3, [idOf("Eve Example")], 14], ["2025-12-02", 3, [idOf("Eve Example")], 0]]);
  });

  it("is in each of its days whole, and its last day is the last with anything", () => {
    for (const day of ["2025-11-29", "2025-12-01", "2025-12-02"]) {
      expect(calendar.day(day).catchUps.map((c) => [c.hours, c.note, c.trip?.lastDay])).toEqual([[32, "the snow", "2025-12-02"]]);
    }
    expect(calendar.day("2025-12-03").catchUps).toEqual([]);
    expect(calendar.month("2025-12").span.last).toBe("2025-12-02");
  });
});
