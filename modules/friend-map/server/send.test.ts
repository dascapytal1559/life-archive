import { createServer, type Server } from "node:http";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SendResult, SendTarget } from "../../../sdk/server.ts";
import { FakeRig, ghost, SELF_ID } from "../fixtures/matrix.ts";
import { archiveHandler } from "../testing/routes.ts";
import { SENDING } from "./send.ts";

const ADA = "5550002";
const BEA = "5550003";

let dir: string;
let rig: FakeRig;
let archive: TestArchive;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-send-"));
  rig = await FakeRig.create(join(dir, "rig"));
  rig.addRoom("!dm-ada:lab.localhost", { channel: `user:${ADA}`, dm: true, channelName: "Ada Sample", members: [{ id: ADA, name: "Ada Sample" }] });
  rig.addRoom("!group:lab.localhost", { channel: "chat:9990001", name: "Book club (sample)", members: [{ id: ADA, name: "Ada Sample" }, { id: BEA, name: "Bea Example" }] });
  rig.addRoom("!saved:lab.localhost", { channel: `user:${SELF_ID}`, dm: true, members: [{ id: SELF_ID, name: "Sample Captain" }] });
  rig.post("!dm-ada:lab.localhost", ghost(ADA), { msgtype: "m.text", body: "hello" });
  rig.post("!group:lab.localhost", ghost(BEA), { msgtype: "m.text", body: "hello all" });
  const dataDir = join(dir, "data");
  await mkdir(join(dataDir, "connectors"), { recursive: true });
  await writeFile(join(dataDir, "connectors", "matrix-bridge.json"), JSON.stringify({ enabled: true, ...rig.settings }));
  archive = await openTestArchive(dataDir);
  server = createServer(archiveHandler(archive));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/archive`;
});

afterEach(async () => {
  await archive.stopLive();
  archive.close();
  server.closeAllConnections();
  server.close();
  await rig.close();
  await rm(dir, { recursive: true, force: true });
});

async function connected(): Promise<void> {
  archive.startLive();
  for (let i = 0; i < 500; i++) {
    if (archive.host.sendingPlatforms()[0].state.state === "connected") {
      // The rules link the new import people to people.
      archive.people.runRules();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("never connected");
}

const personOf = (key: string) =>
  (archive.db.prepare("SELECT person_id FROM import_person WHERE platform = 'telegram' AND key = ?").get(key) as { person_id: number }).person_id;
const conversationOf = (id: string) =>
  (archive.db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = ?").get(id) as { id: number }).id;

function send(conversation: number, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/content/conversations/${conversation}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("while sending is off (SENDING, for now)", () => {
  it("refuses every send, connected or not, with why, and records and sends nothing", async () => {
    await connected();
    expect(SENDING).toBe(false);
    const refused = await send(conversationOf(`user:${ADA}`), { text: "hi Ada" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/sending is turned off in friend-map for now/);
    expect(archive.db.prepare("SELECT count(*) AS n FROM outgoing_message").get()).toEqual({ n: 0 });
    expect(rig.sentByCaptain().filter((e) => e.type === "m.room.message")).toEqual([]);
  });
});

describe("sending, turned on (the code kept for when it is back)", () => {
  beforeEach(() => {
    archive.sends.sending = true;
  });

  it("lists where a person's composer can send, sends through the connector, records how it went, and archives the message once", async () => {
    await connected();
    const targets = (id: number) => fetch(`${base}/people/${id}/send-targets`).then((r) => r.json() as Promise<SendTarget[]>);
    expect(await targets(personOf(ADA))).toEqual([
      { conversationId: conversationOf(`user:${ADA}`), platform: "telegram", title: "Ada Sample", connector: "matrix-bridge", state: expect.objectContaining({ state: "connected" }) },
    ]);
    // Bea shares only a group: nowhere to send. The captain's own chat is Saved Messages.
    expect(await targets(personOf(BEA))).toEqual([]);
    expect((await targets(personOf(SELF_ID))).map((t) => t.title)).toEqual(["Saved Messages"]);

    const response = await send(conversationOf(`user:${ADA}`), { text: "hi Ada" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as SendResult;
    expect(result).toMatchObject({ status: "sent", error: null, messageId: expect.stringMatching(/^user:5550002\/\d+$/) });
    expect(archive.db.prepare("SELECT * FROM outgoing_message").all()).toEqual([
      expect.objectContaining({ id: result.id, connector: "matrix-bridge", status: "sent", platform_message_id: result.messageId, error: null }),
    ]);
    for (let i = 0; i < 500 && !archive.db.prepare("SELECT 1 FROM message WHERE platform_message_id = ?").get(result.messageId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(archive.db.prepare("SELECT text, is_from_self FROM message WHERE platform_message_id = ?").all(result.messageId)).toEqual([{ text: "hi Ada", is_from_self: 1 }]);

    rig.sendOutcome = "refused";
    expect(await (await send(conversationOf(`user:${ADA}`), { text: "and again" })).json())
      .toMatchObject({ status: "failed", error: "Telegram refused the message (sample)" });
  });

  it("refuses what it should not send, and requests from other sites", async () => {
    await connected();
    const ada = conversationOf(`user:${ADA}`);
    expect((await send(ada, { text: "   " })).status).toBe(400);
    expect((await send(ada, { text: "x".repeat(4097) })).status).toBe(400);
    expect((await send(conversationOf("chat:9990001"), { text: "to the group" })).status).toBe(400);
    expect((await send(99_999, { text: "nowhere" })).status).toBe(404);
    // What a form on another web site could send: no JSON type, or another origin.
    expect((await send(ada, '{"text":"from a form"}', { "content-type": "text/plain" })).status).toBe(400);
    expect((await send(ada, { text: "from elsewhere" }, { origin: "https://example.com" })).status).toBe(403);
    expect((await send(ada, { text: "from elsewhere" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(rig.sentByCaptain().filter((e) => e.type === "m.room.message")).toEqual([]);

    await archive.stopLive();
    const stopped = await send(ada, { text: "while stopped" });
    expect(stopped.status).toBe(409);
    expect(((await stopped.json()) as { error: string }).error).toMatch(/matrix-bridge is not connected \(stopped\)/);
    expect(archive.db.prepare("SELECT count(*) AS n FROM outgoing_message").get()).toEqual({ n: 0 });
  });

  it("marks a send the server stopped in the middle of as unconfirmed", async () => {
    archive.db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('telegram', 'user:1', 'direct')").run();
    archive.db.prepare("INSERT INTO outgoing_message (connector, conversation_id, requested_at, status) VALUES ('matrix-bridge', 1, 1, 'sending')").run();
    archive.startLive();
    expect(archive.db.prepare("SELECT status, error FROM outgoing_message").get())
      .toEqual({ status: "unconfirmed", error: "the server stopped before the platform answered" });
  });
});
