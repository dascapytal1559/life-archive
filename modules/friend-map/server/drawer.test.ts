// The conversations a drawer opens (the chats, chat.ts, and the core's sessions, server/viewer/content.ts) over a made-up archive, through the archive's server's door: a chat
// around a message and its pages either way, an LLM session from its start or around a turn with its tool calls, each
// page kept in the trail of content reads with the surface viewer, and nothing read for a request it refuses.

import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendJson, transaction, type ArchiveEvent, type ChatPage } from "../../../sdk/server.ts";
import { archiveServer, contentHandler, type SessionPage, CONTENT_API, CONVERSATION_PAGE, PROJECT, SESSIONS, TEXTS, writeLlmSessionsFixture } from "../../../sdk/testing.ts";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { archiveHandler, viewerHandler } from "../testing/routes.ts";
import { CHAT_PATH } from "./chat.ts";
import { ImportSession } from "./write.ts";

let dir: string;
let archive: TestArchive;
let server: Server;
let port: number;
let viewer: { reads: ReturnType<TestArchive["reads"]> };

/** A made-up chat of 100 messages a minute apart from 1 March, Mia Wong's even and the captain's odd. */
const START = Date.parse("2026-03-01T09:00:00+11:00");
const said = (n: number) => `made-up line ${n}`;
const CHAT: ArchiveEvent[] = [
  { kind: "account", key: "Riley Self", keyKind: "name", displayName: "Riley Self", isSelf: true },
  { kind: "account", key: "Mia Wong", keyKind: "name", displayName: "Mia Wong" },
  { kind: "conversation", id: "direct:Mia Wong", type: "direct", title: "Mia Wong", members: ["Riley Self", "Mia Wong"] },
  ...Array.from({ length: 100 }, (_, n): ArchiveEvent => ({
    kind: "message", id: `m${n}`, idKind: "platform", conversation: "direct:Mia Wong", sender: n % 2 ? "Riley Self" : "Mia Wong",
    isFromSelf: n % 2 === 1, sentAt: START + n * 60_000, type: "text", text: said(n), raw: {},
  })),
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-content-"));
  const store = join(dir, "claude-projects");
  await writeLlmSessionsFixture(store);
  archive = await openTestArchive(join(dir, "data"));
  await archive.host.setEnabled("llm-sessions", true);
  await archive.importHistory("llm-sessions", store, { settings: { projects: [PROJECT] } });
  transaction(archive.db, () => {
    const source = Number(archive.db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')").run().lastInsertRowid);
    const session = new ImportSession(archive.db, "messenger", source, "export");
    for (const event of CHAT) session.apply(event);
  });
  archive.calendar.rebuild();
  viewer = { reads: archive.reads() };
  server = archiveServer({
    hosts: [],
    viewer: {
      api: viewerHandler(() => viewer.reads), content: contentHandler(archive.core), page: (_req, res) => sendJson(res, 404, {}),
      // The chats are friend map's, at its mount under the content routes (chat.ts).
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

// The trail is the core's, in the calendar's file (archive/contentLog.ts).
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

const messageId = (n: number) => (archive.db.prepare("SELECT id FROM message WHERE platform_message_id = ?").get(`m${n}`) as { id: number }).id;
const eventOf = (nativeId: string) => (archive.coreDb.prepare("SELECT id FROM event WHERE native_id = ?").get(nativeId) as { id: number }).id;
const trail = () => archive.contentLog.list().map(({ surface, reader, what, scope, reads }) => ({ surface, reader, what, scope, reads }));
const texts = (page: ChatPage) => page.messages.map((m) => m.text);
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => said(from + i));

describe("a chat opened from a message's drawer", () => {
  it("opens around the message, pages older and newer from there, and keeps the reads as one row of the trail", async () => {
    const id = messageId(50);
    const first = await get<ChatPage>(`${CONTENT_API}/messages/${id}/chat`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ conversation: { platform: "messenger", app: "Messenger", type: "direct", title: "Mia Wong" }, focus: id });
    expect(texts(first.body)).toEqual(lines(50 - CONVERSATION_PAGE / 2, 50 + CONVERSATION_PAGE / 2));
    expect(first.body.messages.find((m) => m.id === id)).toMatchObject({ sender: "Mia Wong", fromSelf: false });

    const older = await get<ChatPage>(`${CONTENT_API}/messages/${id}/chat?before=${first.body.before}`);
    expect(texts(older.body)).toEqual(lines(0, 30));
    expect([older.body.before, older.body.after, older.body.focus]).toEqual([null, null, null]);
    const newer = await get<ChatPage>(`${CONTENT_API}/messages/${id}/chat?after=${first.body.after}`);
    expect(texts(newer.body)).toEqual(lines(70, 100));
    expect([newer.body.before, newer.body.after]).toEqual([null, null]);

    expect(trail()).toEqual([
      { surface: "viewer", reader: null, what: "conversation", scope: { conversation: first.body.conversation.id, message: id }, reads: 3 },
    ]);
  });

  it("refuses what it cannot read, and reads nothing for it", async () => {
    const id = messageId(3);
    expect((await get(`${CONTENT_API}/messages/${id}/chat`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(`${CONTENT_API}/messages/${id}/chat?before=yesterday`)).status).toBe(400);
    expect((await get(`${CONTENT_API}/messages/${id}/chat?before=1:1&after=1:1`)).status).toBe(400);
    expect((await get(`${CONTENT_API}/messages/999999/chat`)).status).toBe(404);
    expect(trail()).toEqual([]);
  });

  it("is never read by the drawer itself, which says the row's metadata alone", async () => {
    const row = await get<{ row: { id: string } }>(`/life-archive/api/messages/row?id=${messageId(7)}`);
    expect(row.status).toBe(200);
    expect(JSON.stringify(row.body)).not.toContain(said(7));
    expect(trail()).toEqual([]);
  });
});

describe("an LLM session opened from an event's drawer", () => {
  it("opens a session at its start, each reply with its tool calls among its words", async () => {
    const talk = eventOf(SESSIONS.talk);
    const page = await get<SessionPage>(`${CONTENT_API}/llm/${talk}/session`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ session: { event: talk, project: PROJECT, app: "Claude Code" }, total: 7, offset: 0, focus: null });
    expect(page.body.turns.map((t) => [t.role, t.parts])).toEqual([
      ["prompt", [{ type: "text", text: TEXTS.p1 }]],
      ["reply", [{ type: "tool", name: "Bash", input: "ls" }, { type: "text", text: TEXTS.r1a }, { type: "text", text: TEXTS.r1b }]],
      ["prompt", [{ type: "text", text: TEXTS.p2 }]],
      ["reply", [{ type: "text", text: TEXTS.r2 }]],
      ["reply", [{ type: "text", text: TEXTS.r3 }]],
      ["prompt", [{ type: "text", text: TEXTS.p3 }]],
      ["prompt", [{ type: "text", text: TEXTS.p4 }]],
    ]);
    expect(page.body.turns[2].images).toBe(1);
    expect(trail()).toEqual([{ surface: "viewer", reader: null, what: "event-content", scope: { event: talk, kind: "llm_session" }, reads: 1 }]);
  });

  it("opens a turn's session a little before it, then any page by its offset, all one row of the trail", async () => {
    const talk = eventOf(SESSIONS.talk);
    const r3 = eventOf(`${SESSIONS.talk.slice(-4)}-r3`);
    const around = await get<SessionPage>(`${CONTENT_API}/llm/${r3}/session`);
    expect([around.body.offset, around.body.focus, around.body.turns.map((t) => t.event)[2]]).toEqual([2, r3, r3]);
    const start = await get<SessionPage>(`${CONTENT_API}/llm/${r3}/session?offset=0`);
    expect([start.body.offset, start.body.focus, start.body.turns.length]).toEqual([0, null, 7]);
    expect(trail()).toEqual([{ surface: "viewer", reader: null, what: "event-content", scope: { event: talk, kind: "llm_session", from: r3 }, reads: 2 }]);
  });

  it("says when the session's copy is not as it was imported, and refuses what it cannot read", async () => {
    expect((await get(`${CONTENT_API}/llm/${eventOf(SESSIONS.talk)}/session?offset=-1`)).status).toBe(400);
    expect((await get(`${CONTENT_API}/llm/999999/session`)).status).toBe(404);
    const continued = eventOf(SESSIONS.continued);
    const file = join(dir, "data", "llm", "claude-code", "-home-sample-Projects-firstmate", `${SESSIONS.continued}.jsonl`);
    await writeFile(file, "");
    const moved = await get<{ error: string }>(`${CONTENT_API}/llm/${continued}/session`);
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/is not as it was imported/);
    expect(trail()).toEqual([]);
  });
});
