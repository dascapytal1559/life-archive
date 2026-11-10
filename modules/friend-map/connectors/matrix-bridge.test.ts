import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSampleChats, CAPTAIN, FakeRig, ghost, SAMPLE, SELF_ID, type RecordedRequest } from "../fixtures/matrix.ts";
import { ALLOWED_REQUESTS, ForbiddenRequestError, isAllowedRequest, MatrixClient } from "./matrix-bridge/client.ts";
import { TELEGRAM, telegramCallNotice } from "./matrix-bridge/rig.ts";
import { callsOf } from "../server/calls.ts";

let dir: string;
let rig: FakeRig;
let archive: TestArchive | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-matrix-"));
  rig = await FakeRig.create(join(dir, "rig"));
  archive = null;
});

afterEach(async () => {
  await archive?.host.stopLive();
  archive?.close();
  await rig.close();
  await rm(dir, { recursive: true, force: true });
});

const { ADA, BEA, CAL, DM, GROUP } = SAMPLE;
const sampleChats = () => addSampleChats(rig);

async function openArchive(): Promise<TestArchive> {
  const dataDir = join(dir, "data");
  await mkdir(join(dataDir, "connectors"), { recursive: true });
  await writeFile(join(dataDir, "connectors", "matrix-bridge.json"), JSON.stringify({ enabled: true, ...rig.settings }));
  archive = await openTestArchive(dataDir);
  return archive;
}

const rows = <T>(sql: string, ...params: Array<string | number>) => archive!.db.prepare(sql).all(...params) as T[];

/** Every request made of the homeserver was one the client allows, and none a receipt, marker, typing or presence. */
function expectOnlyAllowed(requests: RecordedRequest[]): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    if (request.path === "/_matrix/mau/live") continue;
    expect(isAllowedRequest(request.method, request.path), `${request.method} ${request.path}`).toBe(true);
    expect(request.path).not.toMatch(/receipt|read_markers|typing|presence/);
    if (request.path === "/_matrix/client/v3/sync") expect(request.query.set_presence).toBe("offline");
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the Matrix client", () => {
  it("refuses read receipts, read markers, typing, presence and every event but a text message, before anything is sent", async () => {
    const client = new MatrixClient(rig.url);
    await client.login("captain", "sample-password");
    const before = rig.requests.length;
    const room = encodeURIComponent(DM);
    const forbidden: Array<["GET" | "POST" | "PUT", string]> = [
      ["POST", `/_matrix/client/v3/rooms/${room}/receipt/m.read/%24e1`],
      ["POST", `/_matrix/client/v3/rooms/${room}/receipt/m.read.private/%24e1`],
      ["POST", `/_matrix/client/v3/rooms/${room}/read_markers`],
      ["PUT", `/_matrix/client/v3/rooms/${room}/typing/${encodeURIComponent(CAPTAIN)}`],
      ["PUT", `/_matrix/client/v3/presence/${encodeURIComponent(CAPTAIN)}/status`],
      ["PUT", `/_matrix/client/v3/rooms/${room}/send/m.reaction/t1`],
      ["PUT", `/_matrix/client/v3/rooms/${room}/send/m.room.redaction/t1`],
      ["PUT", `/_matrix/client/v3/rooms/${room}/state/m.room.name/`],
      ["PUT", `/_matrix/client/v3/user/${encodeURIComponent(CAPTAIN)}/account_data/m.fully_read`],
      ["PUT", `/_matrix/client/v3/rooms/${room}/redact/%24e1/t1`],
      ["POST", `/_matrix/client/v3/rooms/${room}/leave`],
    ];
    for (const [method, path] of forbidden) {
      await expect(client.request(method, path, {})).rejects.toThrow(ForbiddenRequestError);
    }
    expect(rig.requests.length).toBe(before);
    // Nothing on the list could make one either.
    for (const allowed of ALLOWED_REQUESTS) expect(String(allowed.path)).not.toMatch(/receipt|read_markers|typing|presence|fully_read/);
  });

  it("says it is offline on every sync", async () => {
    const client = new MatrixClient(rig.url);
    await client.login("captain", "sample-password");
    await client.sync({ timeoutMs: 0, filter: {} });
    expect(rig.requests.at(-1)).toMatchObject({ path: "/_matrix/client/v3/sync", query: { set_presence: "offline" } });
  });
});

describe("Telegram ids", () => {
  it("prefix each message's own id with its chat", () => {
    expect(TELEGRAM.messageId("user:777000", "124233", "")).toBe("user:777000/124233");
    expect(TELEGRAM.messageId("chat:900000002", "88", "")).toBe("chat:900000002/88");
    expect(TELEGRAM.messageId("channel:1000000001", "1000000001.16537", "")).toBe("channel:1000000001/16537");
    expect(TELEGRAM.messageId("channel:1000000001", "1000000001.16537", "1")).toBe("channel:1000000001/16537#1");
  });
});

describe("matrix-bridge history", () => {
  it("imports every bridged chat with Telegram's ids, the captain as self, edits, reactions, replies and files, and a second import changes nothing", async () => {
    const { question } = sampleChats();
    const a = await openArchive();
    const first = await a.importHistory("matrix-bridge", undefined);
    expect(first.platform).toBe("telegram");
    expect(first.counts.conversations.added).toBe(4);
    expect(first.counts.messages).toMatchObject({ added: 7, edited: 1 });
    expect(first.counts.reactions.added).toBe(1);
    expect(first.counts.attachments).toMatchObject({ added: 2, stored: 2, missing: 0 });
    expect(first.counts.tallies).toEqual({ "not-from-a-platform-user": 1, deleted: 1 });

    expect(rows("SELECT platform_conversation_id AS id, type, title FROM conversation ORDER BY id")).toEqual([
      { id: "channel:1234567", type: "group", title: "Sample walkers" },
      { id: "chat:9990001", type: "group", title: "Book club (sample)" },
      { id: `user:${SELF_ID}`, type: "direct", title: "Saved Messages" },
      { id: `user:${ADA}`, type: "direct", title: "Ada Sample" },
    ]);
    const messages = rows<{ id: string; text: string | null; self: number; type: string; reply: string | null; edited: number | null }>(
      "SELECT platform_message_id AS id, text, is_from_self AS self, type, reply_to_platform_id AS reply, edited_at AS edited FROM message ORDER BY sent_at",
    );
    expect(messages.map((m) => m.id)).toEqual([
      `user:${ADA}/124233`, `user:${ADA}/1000`, `user:${ADA}/1001`, "chat:9990001/1002", "chat:9990001/1003", "chat:9990001/1004", "channel:1234567/42",
    ]);
    expect(messages[0]).toMatchObject({ text: "hello from Ada!", self: 0, edited: expect.any(Number) });
    expect(messages[1]).toMatchObject({ text: "hi Ada, from my phone", self: 1 });
    expect(messages[2]).toMatchObject({ text: "look at this", type: "media" });
    expect(messages[4]).toMatchObject({ text: "I have", reply: `chat:9990001/${rig.bridged(question)!.id}` });
    expect(messages[6]).toMatchObject({ type: "sticker", text: null });
    expect(rows("SELECT text FROM message_version")).toEqual([{ text: "hello from Ada" }]);

    const people = rows<{ key: string; name: string; self: number }>("SELECT key, display_name AS name, is_self AS self FROM import_person ORDER BY key");
    expect(people).toEqual([
      { key: SELF_ID, name: "Me", self: 1 },
      { key: ADA, name: "Ada Sample", self: 0 },
      { key: BEA, name: "Bea Example", self: 0 },
      { key: CAL, name: "Telegram user", self: 0 },
    ]);
    expect(rows("SELECT emoji FROM reaction")).toEqual([{ emoji: "👍" }]);
    const files = rows<{ type: string; path: string }>("SELECT type, local_path AS path FROM attachment ORDER BY id");
    expect(files.map((f) => f.type)).toEqual(["image", "sticker"]);
    expect(await readFile(join(dir, "data", files[0].path), "utf8")).toBe("not really a jpeg");

    const second = await a.importHistory("matrix-bridge", undefined);
    expect(second.counts.messages).toMatchObject({ added: 0, updated: 0, edited: 0 });
    expect(second.counts.reactions.added).toBe(0);
    expectOnlyAllowed(rig.requests);
    // Reading never joins, sends or writes anything.
    expect(rig.sentByCaptain()).toEqual([]);
  });
});

describe("Telegram's calls", () => {
  it("are read from the bridge's words for them: a call with how long it was connected, a call ringing, a group's video chat", () => {
    expect(telegramCallNotice("Call ended (12 minutes and 5 seconds)")).toEqual({ kind: "call", seconds: 725 });
    expect(telegramCallNotice("Video call ended (1 hour, 2 minutes and 5 seconds)")).toEqual({ kind: "call", seconds: 3725 });
    expect(telegramCallNotice("Call disconnected (1 week and 1 day)")).toEqual({ kind: "call", seconds: 691_200 });
    expect(telegramCallNotice("Call missed")).toEqual({ kind: "call", seconds: 0 });
    expect(telegramCallNotice("Video call rejected")).toEqual({ kind: "call", seconds: 0 });
    expect(telegramCallNotice("Call ended (a while)")).toEqual({ kind: "call" });
    expect(telegramCallNotice("Started a call")).toEqual({ kind: "ring" });
    expect(telegramCallNotice("Started a video call")).toEqual({ kind: "ring" });
    expect(telegramCallNotice("Started a video chat")).toEqual({ kind: "call" });
    expect(telegramCallNotice("Ended the video chat (40 minutes)")).toEqual({ kind: "call", seconds: 2400 });
    for (const words of ["Invited Ada Sample to the video chat", "Created the group", "call ended", "Call ended (12 minutes) ok", "Video chat scheduled for Oct 9, 19:30"]) {
      expect(telegramCallNotice(words)).toBeNull();
    }
  });

  it("come in as call records in their chats, the ringing as a system message from no one, and count as calls with the person", async () => {
    rig.addRoom(DM, { channel: `user:${ADA}`, dm: true, channelName: "Ada Sample", members: [{ id: ADA, name: "Ada Sample" }] });
    rig.addRoom(GROUP, { channel: "chat:9990001", name: "Book club (sample)", members: [{ id: ADA, name: "Ada Sample" }, { id: BEA, name: "Bea Example" }] });
    rig.post(DM, ghost(ADA), { msgtype: "m.notice", body: "Started a call", "com.beeper.action_message": { type: "call", call_type: "voice" } }, { telegramId: "requested-77" });
    rig.post(DM, ghost(ADA), { msgtype: "m.notice", body: "Call ended (12 minutes and 5 seconds)" }, { telegramId: "2001" });
    rig.post(DM, ghost(SELF_ID), { msgtype: "m.notice", body: "Video call missed" }, { telegramId: "2002" });
    rig.post(DM, ghost(ADA), { msgtype: "m.notice", body: "Call me later" }, { telegramId: "2003" });
    rig.post(GROUP, ghost(BEA), { msgtype: "m.notice", body: "Started a video chat" }, { telegramId: "2004" });
    const a = await openArchive();
    await a.importHistory("matrix-bridge", undefined);
    expect(rows("SELECT platform_message_id AS id, type, call_seconds AS seconds, sender_account_id IS NOT NULL AS sender, is_from_self AS self FROM message ORDER BY sent_at")).toEqual([
      { id: `user:${ADA}/requested-77`, type: "system", seconds: null, sender: 0, self: 0 },
      { id: `user:${ADA}/2001`, type: "call", seconds: 725, sender: 1, self: 0 },
      { id: `user:${ADA}/2002`, type: "call", seconds: 0, sender: 1, self: 1 },
      { id: `user:${ADA}/2003`, type: "text", seconds: null, sender: 1, self: 0 },
      { id: "chat:9990001/2004", type: "call", seconds: null, sender: 1, self: 0 },
    ]);
    a.people.runRules();
    const ada = a.structure.listPeople().people.find((p) => p.name === "Ada Sample")!;
    expect(callsOf(a.db, ada.id).map((c) => [c.platform, c.direction, c.answered, c.durationSeconds])).toEqual([
      ["telegram", "outgoing", false, 0],
      ["telegram", "incoming", true, 725],
    ]);
    // The calls and the ringing count as no talking with her; "Call me later" does.
    expect(a.structure.relationships().people.find((p) => p.id === ada.id)!.totals).toMatchObject({ directFromThem: 1, directFromMe: 0 });
  });
});

describe("which chats matrix-bridge reads", () => {
  it("takes a room's chat from the bridge's record, not a clashing m.bridge state, and keeps a one-to-one chat to its two", async () => {
    sampleChats();
    // The homeserver gave another new chat the same room: its m.bridge state and its person are in Ada's room too.
    rig.addClashingBridgeState(DM, "user:5550009");
    rig.setMember(DM, "5550009", "Someone Else");
    rig.post(DM, ghost(ADA), { msgtype: "m.text", body: "after the clash" });
    const a = await openArchive();
    await a.importHistory("matrix-bridge", undefined);
    const chats = rows<{ chat: string; n: number }>(
      "SELECT c.platform_conversation_id AS chat, count(m.id) AS n FROM conversation c LEFT JOIN message m ON m.conversation_id = c.id GROUP BY c.id ORDER BY chat");
    expect(chats.find((c) => c.chat === `user:${ADA}`)?.n).toBe(4);
    expect(chats.some((c) => c.chat === "user:5550009")).toBe(false);
    const members = rows<{ key: string }>(
      `SELECT a.key FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id JOIN import_person a ON a.id = cm.account_id
       WHERE c.platform_conversation_id = ? ORDER BY a.key`, `user:${ADA}`);
    expect(members.map((m) => m.key)).toEqual([SELF_ID, ADA]);
    expect(rows("SELECT title FROM conversation WHERE platform_conversation_id = ?", `user:${ADA}`)).toEqual([{ title: "Ada Sample" }]);
  });

  it("does not read a group of more than twelve or a broadcast channel, counting each once, and reads groups of twelve or fewer and supergroups", async () => {
    sampleChats();
    const crowd = Array.from({ length: 12 }, (_, i) => ({ id: String(5551000 + i), name: `Crowd ${i} (sample)` }));
    // Thirteen with the captain, by Telegram's count or by the room's members: not read. Twelve: read.
    rig.addRoom("!big-group:lab.localhost", { channel: "chat:9990002", name: "Big group (sample)", members: crowd.slice(0, 3), metadata: { member_count: 13 } });
    rig.addRoom("!crowd:lab.localhost", { channel: "chat:9990003", name: "Crowd (sample)", members: crowd });
    rig.addRoom("!twelve:lab.localhost", { channel: "chat:9990004", name: "Twelve (sample)", members: crowd.slice(0, 11) });
    rig.addRoom("!news:lab.localhost", { channel: "channel:7654321", name: "News (sample)", members: [], metadata: { member_count: 3 } });
    rig.addRoom("!super:lab.localhost", { channel: "channel:7654322", name: "Super (sample)", members: crowd.slice(0, 2), metadata: { is_supergroup: true, member_count: 12 } });
    for (const room of ["!big-group:lab.localhost", "!crowd:lab.localhost", "!twelve:lab.localhost", "!news:lab.localhost", "!super:lab.localhost"]) {
      rig.post(room, ghost(crowd[0].id), { msgtype: "m.text", body: "hello all" });
    }
    const a = await openArchive();
    const result = await a.importHistory("matrix-bridge", undefined);
    const chats = rows<{ chat: string }>("SELECT platform_conversation_id AS chat FROM conversation ORDER BY chat").map((c) => c.chat);
    expect(chats).toEqual(["channel:1234567", "channel:7654322", "chat:9990001", "chat:9990004", `user:${SELF_ID}`, `user:${ADA}`]);
    expect(result.counts.tallies).toMatchObject({ "chats-not-read-channel": 1, "chats-not-read-group-of-13-or-more": 2 });
    expect(rows<{ n: number }>("SELECT count(*) AS n FROM message WHERE platform_message_id LIKE 'chat:9990004/%'")[0].n).toBe(1);
    expect(rows<{ n: number }>("SELECT count(*) AS n FROM message WHERE platform_message_id LIKE 'channel:7654322/%'")[0].n).toBe(1);
  });
});

describe("matrix-bridge sync", () => {
  it("reads the history, then follows new messages and chats live, sends when asked with the result, and resumes from its cursor", async () => {
    sampleChats();
    const a = await openArchive();
    const states: string[] = [];
    a.host.startLive({ checkEveryMs: 50, log: (line) => states.push(line) });
    const live = () => a.host.sendingPlatforms()[0].state;
    await until(() => live().state === "connected", "connected");
    const count = () => rows<{ n: number }>("SELECT count(*) AS n FROM message")[0].n;
    expect(count()).toBe(7);
    expect(states).toContain("matrix-bridge: connecting: reading 4 chats' history");

    // A message that reaches Matrix a moment before the bridge records it still comes in, once.
    rig.post(DM, ghost(ADA), { msgtype: "m.text", body: "are you there?" }, { bridged: "later" });
    await until(() => count() === 8, "the new message");

    // A new chat: the bridge invites the captain; it is joined and read.
    rig.addRoom("!new-chat:lab.localhost", { channel: "user:5550005", dm: true, channelName: "Dee Sample", members: [{ id: "5550005", name: "Dee Sample" }], invited: true });
    rig.post("!new-chat:lab.localhost", ghost("5550005"), { msgtype: "m.text", body: "hi, new here" });
    await until(() => count() === 9, "the new chat's message");
    expect(rows("SELECT type FROM conversation WHERE platform_conversation_id = 'user:5550005'")).toEqual([{ type: "direct" }]);

    // Sending: the result comes from the bridge's status event; the message arrives through sync, once.
    const sender = a.host.sender("telegram")!;
    const sent = await sender.command({ command: "send", conversation: `user:${ADA}`, text: "yes, here" });
    expect(sent).toMatchObject({ status: "sent", messageId: expect.stringMatching(new RegExp(`^user:${ADA}/\\d+$`)) });
    await until(() => count() === 10, "the sent message");
    expect(rows("SELECT is_from_self AS self, text FROM message WHERE platform_message_id = ?", sent.messageId!)).toEqual([{ self: 1, text: "yes, here" }]);
    expect(rig.sentByCaptain().filter((e) => e.type === "m.room.message").map((e) => e.content)).toEqual([{ msgtype: "m.text", body: "yes, here" }]);

    rig.sendOutcome = "refused";
    expect(await sender.command({ command: "send", conversation: `user:${ADA}`, text: "this one fails" }))
      .toMatchObject({ status: "failed", error: "Telegram refused the message (sample)" });
    expect(await sender.command({ command: "send", conversation: "user:0", text: "nowhere" }))
      .toMatchObject({ status: "failed", error: "there is no bridged room for this chat" });

    // Stopped and started again, it goes on from its cursor: nothing is walked again or doubled.
    await a.host.stopLive();
    const walkedBefore = rig.requests.filter((r) => r.path.endsWith("/messages")).length;
    rig.post(GROUP, ghost(BEA), { msgtype: "m.text", body: "see you all thursday" });
    const restarted = await openTestArchive(join(dir, "data"));
    archive!.close();
    archive = restarted;
    restarted.host.startLive({ checkEveryMs: 50 });
    await until(() => restarted.host.sendingPlatforms()[0].state.state === "connected", "connected again");
    await until(() => (restarted.db.prepare("SELECT count(*) AS n FROM message").get() as { n: number }).n === 11, "the message sent while it was stopped");
    expect(rig.requests.filter((r) => r.path.endsWith("/messages")).length).toBe(walkedBefore);
    expectOnlyAllowed(rig.requests);
  });

  it("reads a gap in a sync answer on from the last answer, not the whole room again", async () => {
    sampleChats();
    const a = await openArchive();
    const count = () => rows<{ n: number }>("SELECT count(*) AS n FROM message")[0].n;
    a.host.startLive({ checkEveryMs: 50 });
    await until(() => a.host.sendingPlatforms()[0].state.state === "connected", "connected");
    expect(count()).toBe(7);
    // The bridge filling a chat writes more than one sync answer holds.
    rig.timelineLimit = 2;
    const before = rig.requests.length;
    for (let i = 0; i < 5; i++) rig.post(DM, ghost(ADA), { msgtype: "m.text", body: `filled ${i}` });
    await until(() => count() === 12, "every message in the gap");
    const reads = rig.requests.slice(before).filter((r) => r.path.endsWith("/messages") && decodeURIComponent(r.path).includes(DM));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.query.from).toBeDefined();
    expectOnlyAllowed(rig.requests);
  });

  it("reads a new chat the bridge records a moment after inviting the captain to its room", async () => {
    sampleChats();
    const a = await openArchive();
    a.host.startLive({ checkEveryMs: 50 });
    await until(() => a.host.sendingPlatforms()[0].state.state === "connected", "connected");
    const count = () => rows<{ n: number }>("SELECT count(*) AS n FROM message")[0].n;
    expect(count()).toBe(7);
    rig.addRoom("!late:lab.localhost", { channel: "user:5550006", dm: true, channelName: "Eve Sample", members: [{ id: "5550006", name: "Eve Sample" }], invited: true, recordedLater: true });
    rig.post("!late:lab.localhost", ghost("5550006"), { msgtype: "m.text", body: "hi from Eve" });
    await until(() => count() === 8, "the late-recorded chat's message");
    expect(rows("SELECT type FROM conversation WHERE platform_conversation_id = 'user:5550006'")).toEqual([{ type: "direct" }]);
  });

  it("reads a wiped and refilled rig afresh, keeping what it had once", async () => {
    sampleChats();
    const a = await openArchive();
    const count = () => rows<{ n: number }>("SELECT count(*) AS n FROM message")[0].n;
    // A cursor from the rig before it was wiped: rooms that are gone, and a sync token from another server.
    a.db.prepare("INSERT INTO connector_state (connector, status, cursor_json) VALUES ('matrix-bridge', 'idle', ?)")
      .run(JSON.stringify({ since: "999999", walks: [], pending: [], walked: ["!gone:lab.localhost"] }));
    a.host.startLive({ checkEveryMs: 50 });
    await until(() => a.host.sendingPlatforms()[0].state.state === "connected", "connected");
    expect(count()).toBe(7);
    rig.post(DM, ghost(ADA), { msgtype: "m.text", body: "after the wipe" });
    await until(() => count() === 8, "a message on the new rig");
    const cursor = JSON.parse(rows<{ cursor_json: string }>("SELECT cursor_json FROM connector_state")[0].cursor_json) as { walked: string[] };
    expect(cursor.walked.sort()).toEqual([DM, GROUP, SAMPLE.SAVED, SAMPLE.SUPERGROUP].sort());
  });

  it("says when the bridge is logged out or not answering", async () => {
    sampleChats();
    const a = await openArchive();
    rig.bridgeUp = false;
    a.host.startLive({ checkEveryMs: 50 });
    await until(() => a.host.sendingPlatforms()[0].state.state === "bridge-offline", "bridge-offline");
    await a.host.stopLive();
    rig.bridgeUp = true;
    rig.bridgeDb.exec("DELETE FROM user_login");
    a.host.startLive({ checkEveryMs: 50 });
    await until(() => a.host.sendingPlatforms()[0].state.state === "logged-out", "logged-out");
    expect(a.host.sendingPlatforms()[0].state.detail).toMatch(/telegram-login\.sh/);
  });
});
