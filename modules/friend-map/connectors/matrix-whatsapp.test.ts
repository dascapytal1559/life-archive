// matrix-whatsapp: the matrix-bridge reader over the rig's WhatsApp bridge,
// on a made-up rig (fixtures/matrix.ts) whose people are those of the
// made-up WhatsApp copy (fixtures/whatsapp.ts), so a whatsapp-db import and
// the live connector can be seen to agree.

import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWhatsAppSampleChats, BOT, FakeRig, WA_SAMPLE, WA_SELF, waGhost, type RecordedRequest } from "../fixtures/matrix.ts";
import { writeWhatsAppFixture } from "../fixtures/whatsapp.ts";
import { type CommandOutcome, type ConnectorCommand, type ConnectorEvent, runBackground, runPromise } from "../../../sdk/server.ts";
import { isAllowedRequest } from "./matrix-bridge/client.ts";
import { matrixBridge } from "./matrix-bridge/read.ts";
import { WHATSAPP } from "./matrix-bridge/rig.ts";
import { manifest } from "./matrix-whatsapp/manifest.ts";

let dir: string;
let rig: FakeRig;
let archive: TestArchive | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-matrix-whatsapp-"));
  rig = await FakeRig.create(join(dir, "rig"), "whatsapp");
  archive = null;
});

afterEach(async () => {
  await archive?.host.stopLive();
  archive?.close();
  await rig.close();
  await rm(dir, { recursive: true, force: true });
});

const { ada, bruno, cleo, stranger } = WA_SAMPLE.people;
const phoneKey = (phone: string) => `${phone}@s.whatsapp.net`;
const ADA = phoneKey(ada.phone);
const BRUNO = phoneKey(bruno.phone);
const CLEO = phoneKey(cleo.phone);
const STRANGER = `${stranger.lid}@lid`;
const SELF_CHAT = phoneKey(WA_SELF.phone);

async function openArchive(connectors: Record<string, Record<string, unknown>> = {}): Promise<TestArchive> {
  const dataDir = join(dir, "data");
  await mkdir(join(dataDir, "connectors"), { recursive: true });
  await writeFile(join(dataDir, "connectors", "matrix-whatsapp.json"), JSON.stringify({ enabled: true, ...rig.settings }));
  for (const [id, settings] of Object.entries(connectors)) await writeFile(join(dataDir, "connectors", `${id}.json`), JSON.stringify({ enabled: true, ...settings }));
  archive = await openTestArchive(dataDir);
  return archive;
}

const rows = <T>(sql: string, ...params: Array<string | number>) => archive!.db.prepare(sql).all(...params) as T[];
const count = (sql: string, ...params: Array<string | number>) => rows<{ n: number }>(sql, ...params)[0].n;

function expectOnlyAllowed(requests: RecordedRequest[]): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    if (request.path === "/_matrix/mau/live") continue;
    expect(isAllowedRequest(request.method, request.path), `${request.method} ${request.path}`).toBe(true);
    expect(request.path).not.toMatch(/receipt|read_markers|typing|presence/);
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const liveState = async (a: TestArchive) => (await a.host.statuses()).find((s) => s.id === "matrix-whatsapp")?.live?.state;

describe("WhatsApp ids", () => {
  const ids = { phoneOfLid: (lid: string) => (lid === "111" ? "61491571266" : null) };

  it("key people and one-to-one chats by phone number, as whatsapp-db does, through the LID map when the bridge keys them by LID", () => {
    expect(WHATSAPP.accountKey("61491571266", ids)).toBe("61491571266@s.whatsapp.net");
    expect(WHATSAPP.accountKey("lid-111", ids)).toBe("61491571266@s.whatsapp.net");
    expect(WHATSAPP.accountKey("lid-222", ids)).toBe("222@lid");
    expect(WHATSAPP.accountKey("bot-333", ids)).toBe("333@bot");
    expect(WHATSAPP.conversationId("111@lid", ids)).toBe("61491571266@s.whatsapp.net");
    expect(WHATSAPP.conversationId("222@lid", ids)).toBe("222@lid");
    expect(WHATSAPP.conversationId("61491574118@s.whatsapp.net", ids)).toBe("61491574118@s.whatsapp.net");
    expect(WHATSAPP.conversationId("120363000000000001@g.us", ids)).toBe("120363000000000001@g.us");
    expect(WHATSAPP.directPartner("111@lid")).toBe("lid-111");
    expect(WHATSAPP.directPartner("120363000000000001@g.us")).toBeNull();
    expect(WHATSAPP.handle("61491571266@s.whatsapp.net")).toBe("+61491571266");
    expect(WHATSAPP.handle("222@lid")).toBeUndefined();
  });

  it("make a message's id its stanza id, whatsapp-db's id for it, and keep the whole id of one the bridge made up", () => {
    expect(WHATSAPP.messageId("111@lid", "111@lid:61491570737@s.whatsapp.net:3EB0ABCDEF", "")).toBe("3EB0ABCDEF");
    expect(WHATSAPP.messageId("120363000000000001@g.us", "120363000000000001@g.us:222@lid:3A0012", "1")).toBe("3A0012#1");
    expect(WHATSAPP.messageId("111@lid", "fake:111@lid:111@lid:call-X", "")).toBe("fake:111@lid:111@lid:call-X");
    expect(WHATSAPP.bridgeMade("fake:111@lid:111@lid:call-X")).toBe(true);
    expect(WHATSAPP.bridgeMade("111@lid:111@lid:3EB0ABCDEF")).toBe(false);
    expect(WHATSAPP.isBroadcast("120363999999999999@newsletter", {})).toBe(true);
    expect(WHATSAPP.isBroadcast("status@broadcast", {})).toBe(true);
    expect(WHATSAPP.isBroadcast("120363000000000001@g.us", {})).toBe(false);
  });
});

describe("matrix-whatsapp history", () => {
  it("keys chats and people by phone number, knows the captain under their number and LID, and reads edits, reactions, replies, files and calls", async () => {
    addWhatsAppSampleChats(rig);
    const crowd = Array.from({ length: 12 }, (_, i) => ({ id: `613701001${String(i).padStart(2, "0")}`, name: `Crowd ${i} (sample)` }));
    rig.addRoom("!wa-big:lab.localhost", { channel: "120363000000000005@g.us", name: "Big group (sample)", members: crowd });
    rig.addRoom("!wa-news:lab.localhost", { channel: "120363999999999999@newsletter", name: "News (sample)", members: [] });
    rig.addRoom("!wa-community:lab.localhost", { channel: "120363000000000009@g.us", name: "Climbing club (sample)", space: true, members: crowd.slice(0, 2) });
    for (const room of ["!wa-big:lab.localhost", "!wa-news:lab.localhost"]) rig.post(room, waGhost(crowd[0].id), { msgtype: "m.text", body: "hello all" });
    const a = await openArchive();
    const result = await a.importHistory("matrix-whatsapp", undefined);
    expect(result.platform).toBe("whatsapp");
    expect(result.counts.tallies).toEqual({
      deleted: 1, "chats-not-read-channel": 1, "chats-not-read-community": 1, "chats-not-read-group-of-13-or-more": 1,
    });

    expect(rows("SELECT platform_conversation_id AS id, type, title FROM conversation ORDER BY id")).toEqual([
      { id: WA_SAMPLE.groupJid, type: "group", title: "Climbing crew" },
      { id: SELF_CHAT, type: "direct", title: "Me" },
      { id: ADA, type: "direct", title: "Ada Sample" },
      { id: BRUNO, type: "direct", title: null },
    ]);
    const messages = rows<{ id: string; conversation: string; sender: string | null; self: number; type: string; text: string | null; reply: string | null; kind: string }>(
      `SELECT m.platform_message_id AS id, c.platform_conversation_id AS conversation, a.key AS sender, m.is_from_self AS self, m.type,
              m.text, m.reply_to_platform_id AS reply, m.id_kind AS kind
       FROM message m JOIN conversation c ON c.id = m.conversation_id LEFT JOIN import_person a ON a.id = m.sender_account_id ORDER BY m.id`);
    expect(messages.map((m) => [m.id, m.conversation, m.sender])).toEqual([
      [WA_SAMPLE.imported.adaDinner, ADA, ADA],
      ["3A00000000000000L001", ADA, "me"],
      ["3A00000000000000L002", ADA, ADA],
      [`fake:${ada.lid}@lid:${ada.lid}@lid:call-SAMPLE1`, ADA, null],
      [WA_SAMPLE.imported.adaPhoto, ADA, ADA],
      [WA_SAMPLE.imported.adaContact, ADA, ADA],
      [WA_SAMPLE.imported.adaUnknown, ADA, ADA],
      ["3A00000000000000L003", BRUNO, BRUNO],
      [WA_SAMPLE.imported.groupAda, WA_SAMPLE.groupJid, ADA],
      [WA_SAMPLE.imported.groupStranger, WA_SAMPLE.groupJid, STRANGER],
      ["3A00000000000000L004", WA_SAMPLE.groupJid, CLEO],
      ["3A00000000000000L005", SELF_CHAT, "me"],
    ]);
    expect(messages[0]).toMatchObject({ text: "Dinner at mine on Thursday?", self: 0 });
    expect(messages[1]).toMatchObject({ self: 1, reply: WA_SAMPLE.imported.adaDinner });
    expect(messages[2]).toMatchObject({ type: "media", text: "the view" });
    // A call is what happened, from no one.
    expect(messages[3]).toMatchObject({ type: "system", self: 0, kind: "synthetic" });
    // The bridge's own words in place of a message are not its text: a photo it could not fetch is that photo, missing;
    // a contact card is a contact, named; an unsupported message is another kind, with no text.
    expect(messages.slice(4, 7).map((m) => [m.type, m.text])).toEqual([["media", "The crag"], ["contact", "Bruno Placeholder"], ["other", null]]);
    expect(rows("SELECT m.platform_message_id AS id, a.type, a.local_path IS NOT NULL AS stored FROM attachment a JOIN message m ON m.id = a.message_id ORDER BY a.id"))
      .toEqual([{ id: "3A00000000000000L002", type: "image", stored: 1 }, { id: WA_SAMPLE.imported.adaPhoto, type: "image", stored: 0 }, { id: WA_SAMPLE.imported.adaContact, type: "file", stored: 1 }]);
    expect(rows("SELECT a.key, r.emoji FROM reaction r JOIN import_person a ON a.id = r.actor_account_id")).toEqual([{ key: "me", emoji: "❤️" }]);
    const files = rows<{ path: string }>("SELECT local_path AS path FROM attachment ORDER BY id");
    expect(await readFile(join(dir, "data", files[0].path), "utf8")).toBe("not really a jpeg either");

    expect(rows("SELECT key, display_name AS name, name_source AS source, handle, is_self AS self FROM import_person ORDER BY key")).toEqual([
      { key: STRANGER, name: "WhatsApp user", source: "none", handle: null, self: 0 },
      { key: ADA, name: "Ada Sample", source: "profile", handle: `+${ada.phone}`, self: 0 },
      { key: BRUNO, name: `+${bruno.phone}`, source: "number", handle: `+${bruno.phone}`, self: 0 },
      { key: CLEO, name: "Cleo Example", source: "profile", handle: `+${cleo.phone}`, self: 0 },
      { key: "me", name: "Me", source: null, handle: null, self: 1 },
    ]);
    // A one-to-one chat is the two of you; the group is everyone in it, the captain once.
    const members = (chat: string) => rows<{ key: string }>(
      `SELECT a.key FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id JOIN import_person a ON a.id = cm.account_id
       WHERE c.platform_conversation_id = ? ORDER BY a.key`, chat).map((m) => m.key);
    expect(members(ADA)).toEqual([ADA, "me"]);
    expect(members(WA_SAMPLE.groupJid)).toEqual([STRANGER, ADA, CLEO, "me"]);
    expect(members(SELF_CHAT)).toEqual(["me"]);

    expect(rig.logins).toEqual(["FRIENDMAP_WHATSAPP"]);
    expectOnlyAllowed(rig.requests);
    expect(rig.sentByCaptain()).toEqual([]);
  });

  it("puts a person the bridge learns the number of later under their phone key from then on", async () => {
    addWhatsAppSampleChats(rig);
    const a = await openArchive();
    await a.importHistory("matrix-whatsapp", undefined);
    expect(count("SELECT count(*) AS n FROM message m JOIN import_person a ON a.id = m.sender_account_id WHERE a.key = ?", STRANGER)).toBe(1);
    rig.addLid(stranger.lid, "61491573770");
    rig.post(WA_SAMPLE.GROUP, waGhost(`lid-${stranger.lid}`), { msgtype: "m.text", body: "It's Sam, by the way" }, { stanza: "3A00000000000000L006" });
    await a.importHistory("matrix-whatsapp", undefined);
    expect(rows("SELECT a.key, a.handle FROM message m JOIN import_person a ON a.id = m.sender_account_id WHERE m.platform_message_id = '3A00000000000000L006'"))
      .toEqual([{ key: phoneKey("61491573770"), handle: "+61491573770" }]);
  });
});

describe("matrix-whatsapp and a whatsapp-db import of the same account", () => {
  it("keep each message once, in the same chat, from the same account, and the live names never replace the address book's", async () => {
    addWhatsAppSampleChats(rig);
    const copy = join(dir, "data", "platform-exports", "whatsapp", "2026-09-28");
    await writeWhatsAppFixture(copy, { copy: "iphone" });
    const a = await openArchive({ "whatsapp-db": {} });
    const imported = await a.importHistory("whatsapp-db", copy);
    expect(imported.platform).toBe("whatsapp");
    const before = {
      messages: count("SELECT count(*) AS n FROM message"),
      conversations: rows<{ id: string }>("SELECT platform_conversation_id AS id FROM conversation").map((c) => c.id),
      accounts: count("SELECT count(*) AS n FROM import_person"),
      dinner: rows("SELECT id, conversation_id, sender_account_id FROM message WHERE platform_message_id = ?", WA_SAMPLE.imported.adaDinner),
    };
    expect(before.dinner).toHaveLength(1);

    const live = await a.importHistory("matrix-whatsapp", undefined);
    // Twelve messages bridged, six of them already imported; the three the bridge could not bridge keep the import's text.
    expect(live.counts.messages.added).toBe(6);
    expect(count("SELECT count(*) AS n FROM message_version")).toBe(1);
    expect(rows("SELECT type, text FROM message WHERE platform_message_id IN (?, ?, ?) ORDER BY sent_at",
      WA_SAMPLE.imported.adaPhoto, WA_SAMPLE.imported.adaContact, WA_SAMPLE.imported.adaUnknown))
      .toEqual([{ type: "media", text: "The crag" }, { type: "contact", text: "Bruno Placeholder" }, { type: "other", text: null }]);
    expect(count("SELECT count(*) AS n FROM message")).toBe(before.messages + 6);
    expect(count("SELECT count(*) AS n FROM message_alias")).toBe(0);
    for (const stanza of Object.values(WA_SAMPLE.imported)) expect(count("SELECT count(*) AS n FROM message WHERE platform_message_id = ?", stanza)).toBe(1);
    expect(rows("SELECT id, conversation_id, sender_account_id FROM message WHERE platform_message_id = ?", WA_SAMPLE.imported.adaDinner)).toEqual(before.dinner);
    // The only new chat is the captain's chat with themselves, which the copy does not have; nobody is new.
    const conversations = rows<{ id: string }>("SELECT platform_conversation_id AS id FROM conversation").map((c) => c.id);
    expect(conversations.filter((id) => !before.conversations.includes(id))).toEqual([SELF_CHAT]);
    expect(count("SELECT count(*) AS n FROM import_person")).toBe(before.accounts);
    const person = (key: string) => rows<{ name: string; handle: string | null }>("SELECT display_name AS name, handle FROM import_person WHERE key = ?", key)[0];
    expect(person(ADA)).toEqual({ name: "Ada Sample", handle: `+${ada.phone}` });
    // The bridge knows Bruno only by number; the copy's address book named him.
    expect(person(BRUNO)).toEqual({ name: "Bruno Placeholder", handle: `+${bruno.phone}` });
    expect(rows("SELECT is_from_self AS self FROM message WHERE platform_message_id = '3A00000000000000L001'")).toEqual([{ self: 1 }]);
    expect(rows("SELECT a.key FROM message m JOIN import_person a ON a.id = m.sender_account_id WHERE m.platform_message_id = '3A00000000000000L001'"))
      .toEqual([{ key: "me" }]);

    // Importing either again adds nothing.
    expect((await a.importHistory("whatsapp-db", copy)).counts.messages.added).toBe(0);
    expect((await a.importHistory("matrix-whatsapp", undefined)).counts.messages).toMatchObject({ added: 0, updated: 0 });
  });
});

describe("matrix-whatsapp sync", () => {
  it("follows new messages and chats, leaves the Telegram bridge's invitations to Telegram's connector, and never sends", async () => {
    addWhatsAppSampleChats(rig);
    const a = await openArchive();
    a.host.startLive({ checkEveryMs: 50 });
    await until(async () => (await liveState(a)) === "connected", "connected");
    const messages = () => count("SELECT count(*) AS n FROM message");
    expect(messages()).toBe(12);

    rig.post(WA_SAMPLE.ADA, waGhost(`lid-${ada.lid}`), { msgtype: "m.text", body: "see you Thursday" }, { bridged: "later" });
    await until(() => messages() === 13, "the new message");

    // A new chat the WhatsApp bridge invites the captain to is joined and read; one the Telegram bridge invites them to is not.
    rig.addRoom("!wa-new:lab.localhost", { channel: "61491574632@s.whatsapp.net", dm: true, channelName: "Nia Sample", members: [{ id: "61491574632", name: "Nia Sample" }], invited: true });
    rig.addRoom("!tg-new:lab.localhost", { members: [], invited: true, inviter: BOT });
    rig.post("!wa-new:lab.localhost", waGhost("61491574632"), { msgtype: "m.text", body: "hi, new here" });
    await until(() => messages() === 14, "the new chat's message");
    expect(rows("SELECT type FROM conversation WHERE platform_conversation_id = '61491574632@s.whatsapp.net'")).toEqual([{ type: "direct" }]);
    const joins = rig.requests.filter((r) => r.path.endsWith("/join")).map((r) => decodeURIComponent(r.path));
    expect(joins.some((path) => path.includes("!wa-new:"))).toBe(true);
    expect(joins.some((path) => path.includes("!tg-new:"))).toBe(false);

    // Read only: nothing offers a WhatsApp chat to send to, and a send is refused before it reaches the rig.
    expect(a.host.sender("whatsapp")).toBeNull();
    a.people.runRules();
    const adaPerson = rows<{ id: number }>("SELECT person_id AS id FROM import_person WHERE key = ?", ADA)[0].id;
    expect(a.sends.targets(adaPerson)).toEqual([]);
    const chat = rows<{ id: number }>("SELECT id FROM conversation WHERE platform_conversation_id = ?", ADA)[0].id;
    await expect(a.sends.send(chat, "hello from friend-map")).rejects.toThrow("sending is turned off");
    // And with sending back on, still refused: WhatsApp is read only.
    a.sends.sending = true;
    await expect(a.sends.send(chat, "hello from friend-map")).rejects.toThrow("friend-map cannot send on whatsapp");
    expect(rig.sentByCaptain()).toEqual([]);
    expect(rig.logins.every((device) => device === "FRIENDMAP_WHATSAPP")).toBe(true);
    expectOnlyAllowed(rig.requests);
  });

  it("refuses a send command itself, whoever asks", async () => {
    addWhatsAppSampleChats(rig);
    const events: ConnectorEvent[] = [];
    let handler: ((command: ConnectorCommand) => Effect.Effect<CommandOutcome, Error>) | null = null;
    const running = runBackground(matrixBridge(manifest, WHATSAPP).sync!({
      sources: [rig.folder], config: rig.settings, mediaDir: join(dir, "media"), cursor: null,
      emit: async (event) => void events.push(event),
      onCommand: (h) => void (handler = h),
    }).pipe(Effect.orDie));
    await until(() => handler !== null && events.some((e) => e.kind === "state" && e.state === "connected"), "connected");
    expect(await runPromise(handler!({ command: "send", request: "r1", conversation: ADA, text: "hello" })))
      .toEqual({ status: "failed", error: "friend-map does not send on WhatsApp" });
    await runPromise(Fiber.interrupt(running));
    expect(rig.sentByCaptain()).toEqual([]);
  });

  it("says when the bridge has no WhatsApp login", async () => {
    addWhatsAppSampleChats(rig);
    rig.bridgeDb.exec("DELETE FROM user_login");
    const a = await openArchive();
    a.host.startLive({ checkEveryMs: 50 });
    await until(async () => (await liveState(a)) === "logged-out", "logged-out");
    expect((await a.host.statuses()).find((s) => s.id === "matrix-whatsapp")?.live?.detail).toMatch(/whatsapp-login\.sh/);
  });
});
