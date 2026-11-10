// The Events calendar's day of chats (dayChats.ts, under chat.ts's CHAT_PATH) over a made-up archive, through the
// archive's server's door: a day's chats by count on the calendar's days (from 06:00), adding up to the day's summary;
// a person's day and a chat's day read only when asked, each kept in the trail as a day read; nothing read for a
// request it refuses; and who friend map hides, in the calendar's day summaries.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendJson, transaction, type ArchiveEvent, type DayChatPage, type DayChatsAnswer } from "../../../sdk/server.ts";
import { archiveServer, contentHandler, CONTENT_API, type CalendarDaysAnswer } from "../../../sdk/testing.ts";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { archiveHandler, viewerHandler } from "../testing/routes.ts";
import { CHAT_PATH } from "./chat.ts";
import { ImportSession } from "./write.ts";

let dir: string;
let archive: TestArchive;
let server: Server;
let port: number;
let viewer: { reads: ReturnType<TestArchive["reads"]> };

/** A made-up Friday, 6 November 2026, as the Events calendar counts it: from 06:00 that day to 06:00 the next. */
const DAY = "2026-11-06";
const at = (when: string) => Date.parse(`${when}+11:00`);
const message = (id: string, chat: string, sender: string, when: string, platform = "messenger"): ArchiveEvent & { platform: string } => ({
  kind: "message", id, idKind: "platform", conversation: chat, sender, isFromSelf: sender === "Riley Self", sentAt: at(when), type: "text", text: `made-up line ${id}`, raw: {}, platform,
});
const ACCOUNTS: ArchiveEvent[] = ["Riley Self", "Mia Wong", "Ada Sample", "Bruno Example"].map((name) => ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf: name === "Riley Self" }));
const MESSENGER: ArchiveEvent[] = [
  ...ACCOUNTS,
  { kind: "conversation", id: "direct:Mia", type: "direct", title: "Mia Wong", members: ["Riley Self", "Mia Wong"] },
  // Before 06:00 on the 6th: the 5th's, as the calendar counts it.
  message("mia-early", "direct:Mia", "Mia Wong", "2026-11-06T05:50:00"),
  message("mia-1", "direct:Mia", "Riley Self", "2026-11-06T08:09:00"),
  message("mia-2", "direct:Mia", "Mia Wong", "2026-11-06T08:10:00"),
  message("mia-3", "direct:Mia", "Mia Wong", "2026-11-06T21:41:00"),
  // The small hours of the 7th: still the 6th's.
  message("mia-late", "direct:Mia", "Riley Self", "2026-11-07T02:00:00"),
];
const WHATSAPP: ArchiveEvent[] = [
  ...ACCOUNTS,
  { kind: "conversation", id: "direct:Ada", type: "direct", title: "Ada Sample", members: ["Riley Self", "Ada Sample"] },
  message("ada-1", "direct:Ada", "Ada Sample", "2026-11-06T12:00:00"),
  message("ada-2", "direct:Ada", "Riley Self", "2026-11-06T12:05:00"),
  { kind: "conversation", id: "group:climbers", type: "group", title: "Sunday climbers", members: ["Riley Self", "Mia Wong", "Ada Sample", "Bruno Example"] },
  message("group-1", "group:climbers", "Mia Wong", "2026-11-06T10:00:00"),
  message("group-2", "group:climbers", "Bruno Example", "2026-11-06T10:01:00"),
  message("group-3", "group:climbers", "Riley Self", "2026-11-06T10:02:00"),
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-day-chats-"));
  archive = await openTestArchive(join(dir, "data"));
  transaction(archive.db, () => {
    for (const [platform, events] of [["messenger", MESSENGER], ["whatsapp", WHATSAPP]] as const) {
      const source = Number(archive.db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')").run(platform).lastInsertRowid);
      const session = new ImportSession(archive.db, platform, source, "export");
      for (const event of events) session.apply(event);
    }
  });
  archive.people.runRules();
  archive.calendar.rebuild();
  viewer = { reads: archive.reads() };
  server = archiveServer({
    hosts: [],
    viewer: {
      api: viewerHandler(() => viewer.reads), content: contentHandler(archive.core), page: (_req, res) => sendJson(res, 404, {}),
      mounts: [{ path: CHAT_PATH, handler: archiveHandler(archive) }],
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.close();
  archive.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => void archive.calendarDb.exec("DELETE FROM content_read"));

function get<T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { "sec-fetch-site": "same-origin", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as T }));
    }).on("error", reject).end();
  });
}

const personOf = (name: string) => (archive.db.prepare("SELECT id FROM person WHERE name = ?").get(name) as { id: number }).id;
const chatOf = (title: string) => (archive.db.prepare("SELECT id FROM conversation WHERE title = ?").get(title) as { id: number }).id;
const trail = () => archive.contentLog.list().map(({ surface, reader, what, scope, reads }) => ({ surface, reader, what, scope, reads }));
const ids = (page: DayChatPage) => page.messages.map((m) => m.text?.replace("made-up line ", ""));
const days = () => get<CalendarDaysAnswer>(`/life-archive/api/calendar/days?from=${DAY}&to=2026-11-07`);

describe("a day's chats", () => {
  it("lists every chat of the calendar's day by count, adding up to the day's own count, and reads nothing", async () => {
    const [mia, ada, bruno] = [personOf("Mia Wong"), personOf("Ada Sample"), personOf("Bruno Example")];
    const answer = await get<DayChatsAnswer>(`${CONTENT_API}/messages/days/${DAY}`);
    expect(answer.status).toBe(200);
    expect(answer.body.chats.map(({ type, app, title, people, messages }) => ({ type, app, title, people: people.toSorted(), messages }))).toEqual([
      { type: "direct", app: "Messenger", title: null, people: [mia], messages: 4 },
      { type: "group", app: "WhatsApp", title: "Sunday climbers", people: [mia, bruno].toSorted(), messages: 3 },
      { type: "direct", app: "WhatsApp", title: null, people: [ada], messages: 2 },
    ]);
    expect(answer.body.people).toEqual({ [mia]: "Mia Wong", [ada]: "Ada Sample", [bruno]: "Bruno Example" });
    expect(JSON.stringify(answer.body)).not.toContain("made-up line");
    const summary = (await days()).body.days[0];
    expect(answer.body.chats.reduce((sum, chat) => sum + chat.messages, 0)).toBe(summary.messages);
    expect(trail()).toEqual([]);
  });

  it("reads a person's day when asked: their one-to-one chats and what they said in groups, as many as the day counts them", async () => {
    const mia = personOf("Mia Wong");
    const page = await get<DayChatPage>(`${CONTENT_API}/messages/days/${DAY}/people/${mia}`);
    expect(page.status).toBe(200);
    expect(ids(page.body)).toEqual(["mia-1", "mia-2", "group-1", "mia-3", "mia-late"]);
    expect(page.body.messages.find((m) => m.text?.endsWith("group-1"))?.conversation).toMatchObject({ type: "group", title: "Sunday climbers" });
    expect(page.body.after).toBeNull();
    const counted = (await days()).body.days[0].messaged.find((who) => who.id === mia)?.count;
    expect(page.body.messages.length).toBe(counted);
    expect(trail()).toEqual([{ surface: "viewer", reader: null, what: "day", scope: { person: mia, day: DAY }, reads: 1 }]);
  });

  it("reads a group chat's day when asked, kept as a day read of the chat", async () => {
    const group = chatOf("Sunday climbers");
    const page = await get<DayChatPage>(`${CONTENT_API}/messages/days/${DAY}/chats/${group}`);
    expect(ids(page.body)).toEqual(["group-1", "group-2", "group-3"]);
    expect(trail()).toEqual([{ surface: "viewer", reader: null, what: "day", scope: { conversation: group, day: DAY }, reads: 1 }]);
  });

  it("refuses what it cannot read, and reads nothing for it", async () => {
    const mia = personOf("Mia Wong");
    expect((await get(`${CONTENT_API}/messages/days/${DAY}/people/${mia}`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(`${CONTENT_API}/messages/days/yesterday`)).status).toBe(400);
    expect((await get(`${CONTENT_API}/messages/days/${DAY}/people/${mia}?after=soon`)).status).toBe(400);
    expect((await get(`${CONTENT_API}/messages/days/${DAY}/people/999999`)).status).toBe(404);
    expect((await get(`${CONTENT_API}/messages/days/${DAY}/chats/999999`)).status).toBe(404);
    expect((await get(`${CONTENT_API}/messages/days/${DAY}/places/1`)).status).toBe(404);
    expect(trail()).toEqual([]);
  });
});

describe("who the calendar leaves out", () => {
  it("names, of everyone on the days, those friend map's Hide starts with on: tagged commercial or archived", async () => {
    const [mia, ada, bruno] = [personOf("Mia Wong"), personOf("Ada Sample"), personOf("Bruno Example")];
    const before = (await days()).body.hidden;
    expect(before).not.toContain(mia);
    expect(before).not.toContain(ada);
    archive.people.setTags(ada, ["commercial"]);
    archive.people.setTags(mia, ["archive"]);
    try {
      const hidden = (await days()).body.hidden;
      expect(hidden).toContain(ada);
      expect(hidden).toContain(mia);
      expect(hidden.includes(bruno)).toBe(before.includes(bruno));
    } finally {
      archive.people.setTags(ada, []);
      archive.people.setTags(mia, []);
    }
    expect((await days()).body.hidden).toEqual(before);
  });
});
