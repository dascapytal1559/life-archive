import { spawnSync } from "node:child_process";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRig, ghost } from "../fixtures/matrix.ts";
import { archiveHandler } from "../testing/routes.ts";

const ADA = "5550002";
const CY = "5550004";

let dir: string;
let rig: FakeRig;
let archive: TestArchive;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-live-"));
  rig = await FakeRig.create(join(dir, "rig"));
  rig.addRoom("!dm-ada:lab.localhost", { channel: `user:${ADA}`, dm: true, channelName: "Ada Sample", members: [{ id: ADA, name: "Ada Sample" }] });
  rig.post("!dm-ada:lab.localhost", ghost(ADA), { msgtype: "m.text", body: "hello" });
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

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

const count = (sql: string) => (archive.db.prepare(sql).get() as { n: number }).n;
const adaMessages = () => count("SELECT count(*) AS n FROM message m JOIN import_person a ON a.id = m.sender_account_id WHERE a.key = '5550002'");

describe("a live chat", () => {
  it("tells open pages only that messages came in when nobody changed, and that people changed when someone new wrote", async () => {
    archive.startLive(undefined, { rulesEveryMs: 50 });
    // The first batches bring Ada in, a new person, and her message, which the rules count (and archive her by).
    await until(() => count("SELECT coalesce(sum(s.direct_count), 0) AS n FROM import_person_stats s JOIN import_person a ON a.id = s.import_person_id WHERE a.key = '5550002'") === 1);
    const abort = new AbortController();
    const response = await fetch(`${base}/events`, { signal: abort.signal });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(": watching people\n\n");

    // Ada writes again: only what the messages add up to changed.
    const people = archive.people.version();
    const links = archive.people.linksVersion();
    rig.post("!dm-ada:lab.localhost", ghost(ADA), { msgtype: "m.text", body: "again" });
    expect((await reader.read()).value).toMatch(/^event: messages\ndata: "\d+"\n\n$/);
    expect(adaMessages()).toBe(2);
    expect(archive.people.version()).toBe(people);
    expect(archive.people.linksVersion()).not.toBe(links);
    expect((await (await fetch(`${base}/people/${archive.structure.listPeople().people.find((p) => p.name === "Ada Sample")!.id}`)).json()).messageCount).toBe(2);

    // Cy is new: people changed.
    rig.addRoom("!dm-cy:lab.localhost", { channel: `user:${CY}`, dm: true, channelName: "Cy Sample", members: [{ id: CY, name: "Cy Sample" }] });
    rig.post("!dm-cy:lab.localhost", ghost(CY), { msgtype: "m.text", body: "hi" });
    expect((await reader.read()).value).toMatch(/^event: people\ndata: "\d+"\n\n$/);
    expect(archive.people.version()).not.toBe(people);
    abort.abort();
  });
});

describe("the live bridges' lock", () => {
  let other: TestArchive | null = null;
  afterEach(async () => {
    await other?.stopLive();
    other?.close();
    other = null;
  });

  const state = (a: TestArchive) => a.host.sendingPlatforms()[0].state;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitingFor = `waiting: another process (pid ${process.pid}) runs the live bridges`;

  it("runs them in one archive at a time; the other waits, and takes over when the first stops, from its cursor", async () => {
    archive.startLive(undefined, { checkEveryMs: 50 });
    await until(() => state(archive).state === "connected");
    other = await openTestArchive(join(dir, "data"));
    const logged: string[] = [];
    other.startLive((line) => logged.push(line), { checkEveryMs: 50 });
    await wait(300);
    expect(state(other)).toMatchObject({ state: "waiting" });
    // Said once for each sync connector, however often it looks again.
    expect(logged).toEqual([`grok-bot: ${waitingFor}`, `llm-sessions: ${waitingFor}`, `matrix-bridge: ${waitingFor}`, `matrix-whatsapp: ${waitingFor}`]);
    expect(archive.host.liveOwner()).toMatchObject({ pid: process.pid, thisProcess: true });
    expect(other.host.liveOwner()).toMatchObject({ pid: process.pid, thisProcess: false });

    // Only the owner syncs: Ada's second message comes in once.
    rig.post("!dm-ada:lab.localhost", ghost(ADA), { msgtype: "m.text", body: "again" });
    await until(() => adaMessages() === 2);
    await archive.stopLive();
    expect(archive.host.liveOwner()).toBeNull();
    const walked = rig.requests.filter((r) => r.path.endsWith("/messages")).length;

    await until(() => state(other!).state === "connected");
    expect(other.host.liveOwner()).toMatchObject({ thisProcess: true });
    rig.post("!dm-ada:lab.localhost", ghost(ADA), { msgtype: "m.text", body: "third" });
    await until(() => adaMessages() === 3);
    await wait(200);
    expect(adaMessages()).toBe(3);
    expect(rig.requests.filter((r) => r.path.endsWith("/messages")).length).toBe(walked);
  });

  it("leaves a send going out from the owner alone, and marks it unconfirmed only once it takes over", async () => {
    archive.startLive(undefined, { checkEveryMs: 50 });
    await until(() => state(archive).state === "connected");
    const chat = (archive.db.prepare("SELECT id FROM conversation").get() as { id: number }).id;
    archive.db.prepare("INSERT INTO outgoing_message (connector, conversation_id, requested_at, status) VALUES ('matrix-bridge', ?, 1, 'sending')").run(chat);
    const status = () => (archive.db.prepare("SELECT status FROM outgoing_message").get() as { status: string }).status;
    other = await openTestArchive(join(dir, "data"));
    other.startLive(undefined, { checkEveryMs: 50 });
    await wait(200);
    expect(status()).toBe("sending");
    await archive.stopLive();
    await until(() => other!.host.liveOwner()?.thisProcess === true);
    expect(status()).toBe("unconfirmed");
  });

  it("takes over at once from a process that has died", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    archive.coreDb.prepare("INSERT INTO meta (key, value) VALUES ('live_owner', ?)")
      .run(JSON.stringify({ id: "gone", pid: dead, since: 1, beat: 1 }));
    archive.startLive(undefined, { checkEveryMs: 60_000 });
    expect(archive.host.liveOwner()).toMatchObject({ pid: process.pid, thisProcess: true });
    await until(() => state(archive).state === "connected");
  });

  it("takes over from an owner whose heartbeat has stood still, judged from when it first saw it", async () => {
    archive.startLive(undefined, { checkEveryMs: 50, heartbeatEveryMs: 60_000 });
    await until(() => state(archive).state === "connected");
    other = await openTestArchive(join(dir, "data"));
    other.startLive(undefined, { checkEveryMs: 50, staleAfterMs: 500 });
    await wait(200);
    expect(state(other).state).toBe("waiting");
    await until(() => other!.host.liveOwner()?.thisProcess === true);
    await until(() => state(other!).state === "connected");
  });

  it("stops them when another process has taken the lock, and waits for it again", async () => {
    const logged: string[] = [];
    archive.startLive((line) => logged.push(line), { checkEveryMs: 50, heartbeatEveryMs: 50 });
    await until(() => state(archive).state === "connected");
    archive.coreDb.prepare("UPDATE meta SET value = ? WHERE key = 'live_owner'")
      .run(JSON.stringify({ id: "elsewhere", pid: process.pid, since: 1, beat: 1 }));
    await until(() => state(archive).state === "waiting");
    expect(logged).toContain("another process took over the live bridges; stopping them here");
    expect(state(archive).detail).toBe(`another process (pid ${process.pid}) runs the live bridges`);
  });
});
