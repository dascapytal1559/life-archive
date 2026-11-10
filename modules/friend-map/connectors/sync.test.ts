import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConnectorHost, type Db, loadRegistry, NotConnectedError } from "../../../sdk/server.ts";
import { openArchive } from "../server/db.ts";
import { ImportSession } from "../server/write.ts";
import { chatHost } from "../testing/host.ts";

const RUNTIME = fileURLToPath(new URL("../../../server/connectors/runtime.ts", import.meta.url));

let dataDir: string;
let db: Db;
let host: ConnectorHost | null;
let servers: Server[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-sync-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  host = null;
  servers = [];
});

afterEach(async () => {
  await host?.stopLive();
  for (const server of servers) server.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Resolves once `check` holds, looking every 20 ms for up to 10 s. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A sync connector that writes one batch per run (announcing a chat on the
 * first), then waits until stopped. With `crashOnce` (a file path) its second
 * run writes half a batch and dies, once. A `send` adds the sent message in a
 * batch of its own. With `invalid` it writes a malformed event mid-batch.
 * With `stopMidBatch` (a file path) its second run, once, writes half a batch,
 * makes that file (the test stops it then) and waits: with `finishOnStop`
 * a moment before it writes the rest and its checkpoint, the batch whole
 * (uninterruptible) however it is stopped; otherwise until it is stopped.
 */
const LIVE = `
import { existsSync, writeFileSync } from "node:fs";
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { runConnector } from ${JSON.stringify(RUNTIME)};
const say = (emit, event) => Effect.promise(() => emit(event));
await runConnector({
  manifest: { id: "live", platform: "telegram", sourceKind: "live", capabilities: { history: false, sync: true, send: true }, needs: [], description: "live" },
  sync: ({ cursor, config, emit, onCommand }) => Effect.gen(function* () {
    const n = cursor?.n ?? 0;
    yield* say(emit, { kind: "state", state: "connecting" });
    const message = (id, text, fromSelf = false) => ({
      kind: "message", id, idKind: "platform", conversation: "c1", sender: fromSelf ? "me" : "u1",
      isFromSelf: fromSelf, sentAt: 1000 + n, type: "text", text, raw: {} });
    if (n === 0) {
      yield* say(emit, { kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true });
      yield* say(emit, { kind: "account", key: "u1", keyKind: "id", displayName: "Someone" });
      yield* say(emit, { kind: "conversation", id: "c1", type: "direct", members: ["me", "u1"] });
    }
    if (config.invalid && n === 1) {
      yield* say(emit, message("m" + n, "one"));
      yield* say(emit, { kind: "message", id: "broken" });
    }
    if (config.crashOnce && n === 1 && !existsSync(config.crashOnce)) {
      writeFileSync(config.crashOnce, "");
      yield* say(emit, message("half", "half a batch"));
      process.stderr.write("lost the connection\\n");
      process.exit(3);
    }
    if (config.stopMidBatch && n === 1 && !existsSync(config.stopMidBatch)) {
      const batch = Effect.gen(function* () {
        yield* say(emit, message("m1a", "the first half"));
        writeFileSync(config.stopMidBatch, "");
        yield* Effect.sleep(config.finishOnStop ? "300 millis" : "1 hour");
        yield* say(emit, message("m1b", "the second half"));
        yield* say(emit, { kind: "checkpoint", cursor: { n: n + 1 } });
      });
      yield* config.finishOnStop ? Effect.uninterruptible(batch) : batch;
      return yield* Effect.never;
    }
    if (config.stopMidBatch && n === 1) {
      yield* say(emit, message("m1a", "the first half"));
      yield* say(emit, message("m1b", "the second half"));
    } else {
      yield* say(emit, message("m" + n, "hello " + n));
    }
    yield* say(emit, { kind: "checkpoint", cursor: { n: n + 1 } });
    onCommand((command) => Effect.gen(function* () {
      if (command.text === "fail") return { status: "failed", error: "the platform said no" };
      yield* say(emit, message("sent-" + command.request, command.text, true));
      yield* say(emit, { kind: "checkpoint", cursor: { n: n + 1, sent: command.request } });
      return { status: "sent", messageId: "sent-" + command.request };
    }));
    yield* say(emit, { kind: "state", state: "connected", detail: "run " + n });
    return yield* Effect.never;
  }),
});
`;

async function setUp(settings: Record<string, unknown>) {
  const dir = join(dataDir, "fake-connectors", "live");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.ts"),
    `export const manifest = { id: "live", platform: "telegram", sourceKind: "live",
       capabilities: { history: false, sync: true, send: true }, needs: ["companion"], description: "live",
       companion: { name: "the test rig", healthUrl: "http://127.0.0.1:9/" } };`,
  );
  await writeFile(join(dir, "main.ts"), LIVE);
  await mkdir(join(dataDir, "connectors"), { recursive: true });
  await writeFile(join(dataDir, "connectors", "live.json"), JSON.stringify({ enabled: true, source: dataDir, ...settings }));
  host = await chatHost(db, dataDir, await loadRegistry(join(dataDir, "fake-connectors")));
  return host;
}

/** An HTTP server that answers anything, standing in for the companion's health URL. */
async function companion(): Promise<string> {
  const server = createServer((_req, res) => res.end("{}"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

const live = () => host!.sendingPlatforms()[0].state;
const messageIds = () => db.prepare("SELECT platform_message_id FROM message ORDER BY id").all().map((r) => (r as { platform_message_id: string }).platform_message_id);
/** Each live run's messages added, in order. */
const addedBySource = () =>
  (db.prepare("SELECT counts_json FROM source WHERE started_at > 1 ORDER BY id").all() as Array<{ counts_json: string | null }>)
    .map((r) => (r.counts_json ? (JSON.parse(r.counts_json) as { messages: { added: number } }).messages.added : 0));
const cursor = () => (db.prepare("SELECT cursor_json FROM connector_state WHERE connector = 'live'").get() as { cursor_json: string | null } | undefined)?.cursor_json;

describe("sync mode", () => {
  it("waits quietly while the companion does not answer, then starts, applies each batch at its checkpoint and keeps the cursor", async () => {
    const url = await companion();
    const closed = "http://127.0.0.1:9/";
    const logged: string[] = [];
    const batches: number[] = [];
    const h = await setUp({ healthUrl: closed });
    h.startLive({ checkEveryMs: 50, log: (line) => logged.push(line), onBatch: (counts) => batches.push(counts.messages.added) });
    await until(() => live().state === "waiting", "waiting");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Still waiting, said once, and nothing started.
    expect(logged).toEqual([`live: waiting: the test rig does not answer at ${closed}`]);
    expect(count("source")).toBe(0);

    await writeFile(join(dataDir, "connectors", "live.json"), JSON.stringify({ enabled: true, source: dataDir, healthUrl: url }));
    await until(() => live().state === "connected", "connected");
    expect(count("message")).toBe(1);
    expect(JSON.parse(cursor()!)).toEqual({ n: 1 });
    expect(batches).toEqual([1]);
    expect(db.prepare("SELECT kind, status FROM source").get()).toEqual({ kind: "live", status: "running" });
    const status = (await h.statuses()).find((s) => s.id === "live")!;
    expect(status).toMatchObject({ status: "running", companion: "the test rig", live: { state: "connected", detail: "run 0" } });

    await h.stopLive();
    expect(live().state).toBe("stopped");
    expect(db.prepare("SELECT status, counts_json FROM source").get()).toMatchObject({ status: "ok" });
    expect(JSON.parse((db.prepare("SELECT counts_json FROM source").get() as { counts_json: string }).counts_json).messages.added).toBe(1);
  });

  it("drops a batch cut short by a crash, starts again after a wait, and resumes from the cursor", async () => {
    const url = await companion();
    const h = await setUp({ healthUrl: url, crashOnce: join(dataDir, "crashed") });
    // A cursor from an earlier run: this run is the second, which crashes once.
    db.prepare("INSERT INTO connector_state (connector, status, cursor_json) VALUES ('live', 'idle', ?)").run(JSON.stringify({ n: 1 }));
    // It needs the chat the first run would have announced.
    setUpChat();
    h.startLive({ checkEveryMs: 50, restartDelaysMs: [100] });
    await until(() => live().state === "error", "the crash");
    expect(live().detail).toMatch(/^it stopped \(lost the connection\); starting again in 0\.1 s$/);
    expect(count("message")).toBe(1); // only the chat's own message from setUpChat
    expect(db.prepare("SELECT status, error FROM source WHERE started_at > 1 ORDER BY id").get()).toMatchObject({ status: "failed", error: "lost the connection" });
    await until(() => live().state === "connected", "the restart");
    expect(db.prepare("SELECT platform_message_id FROM message ORDER BY id").all().map((r) => (r as { platform_message_id: string }).platform_message_id))
      .toEqual(["m0", "m1"]);
    expect(JSON.parse(cursor()!)).toEqual({ n: 2 });
    expect((db.prepare("SELECT failures FROM connector_state").get() as { failures: number }).failures).toBe(0);
  });

  it("fails the run on a malformed event, leaving that batch out", async () => {
    const url = await companion();
    const h = await setUp({ healthUrl: url, invalid: true });
    db.prepare("INSERT INTO connector_state (connector, status, cursor_json) VALUES ('live', 'idle', ?)").run(JSON.stringify({ n: 1 }));
    setUpChat();
    h.startLive({ checkEveryMs: 50, restartDelaysMs: [60_000] });
    await until(() => live().state === "error", "the failure");
    expect(live().detail).toMatch(/invalid event on line \d+: \(message\) idKind/);
    expect(count("message")).toBe(1);
    expect(JSON.parse(cursor()!)).toEqual({ n: 1 });
  });

  it("carries a send command to the connector and hands back its result", async () => {
    const url = await companion();
    const h = await setUp({ healthUrl: url });
    const runner = () => h.sender("telegram")!;
    h.startLive({ checkEveryMs: 50 });
    expect(() => runner().command({ command: "send", conversation: "c1", text: "too soon" })).toThrow(NotConnectedError);
    await until(() => live().state === "connected", "connected");
    // JSON leaves the line and paragraph separators unescaped, so a command holding one is still one line.
    const sent = await runner().command({ command: "send", conversation: "c1", text: "hi from\u2028the test\u2029" });
    expect(sent).toMatchObject({ kind: "send-result", status: "sent", messageId: `sent-${sent.request}` });
    await until(() => count("message") === 2, "the sent message");
    expect(db.prepare("SELECT text, is_from_self FROM message WHERE platform_message_id = ?").get(sent.messageId!))
      .toEqual({ text: "hi from\u2028the test\u2029", is_from_self: 1 });
    expect(await runner().command({ command: "send", conversation: "c1", text: "fail" }))
      .toMatchObject({ status: "failed", error: "the platform said no" });
    expect(h.sender("whatsapp")).toBeNull();
  });

  it("leaves a batch cut short by a stop out, and applies it once when the connector next runs", async () => {
    const url = await companion();
    const marker = join(dataDir, "stopped");
    const h = await setUp({ healthUrl: url, stopMidBatch: marker });
    db.prepare("INSERT INTO connector_state (connector, status, cursor_json) VALUES ('live', 'idle', ?)").run(JSON.stringify({ n: 1 }));
    setUpChat();
    h.startLive({ checkEveryMs: 50 });
    await until(() => existsSync(marker), "half a batch");
    await h.stopLive();
    // Stopped mid-batch: a clean stop, nothing of the half batch applied, the cursor where it was.
    expect(live().state).toBe("stopped");
    expect(messageIds()).toEqual(["m0"]);
    expect(JSON.parse(cursor()!)).toEqual({ n: 1 });
    expect(db.prepare("SELECT status, error, counts_json FROM source WHERE started_at > 1").get()).toEqual({ status: "ok", error: null, counts_json: null });

    h.startLive({ checkEveryMs: 50 });
    await until(() => live().state === "connected", "the next run");
    expect(messageIds()).toEqual(["m0", "m1a", "m1b"]);
    expect(JSON.parse(cursor()!)).toEqual({ n: 2 });
    expect(addedBySource()).toEqual([0, 2]);
  });

  it("applies a batch the connector finishes as it stops, once, and the next run goes on after it", async () => {
    const url = await companion();
    const marker = join(dataDir, "stopped");
    const h = await setUp({ healthUrl: url, stopMidBatch: marker, finishOnStop: true });
    db.prepare("INSERT INTO connector_state (connector, status, cursor_json) VALUES ('live', 'idle', ?)").run(JSON.stringify({ n: 1 }));
    setUpChat();
    h.startLive({ checkEveryMs: 50 });
    await until(() => existsSync(marker), "half a batch");
    await h.stopLive();
    // Read on after SIGTERM until it exited: the batch it finished is in, whole, with its cursor.
    expect(live().state).toBe("stopped");
    expect(messageIds()).toEqual(["m0", "m1a", "m1b"]);
    expect(JSON.parse(cursor()!)).toEqual({ n: 2 });
    expect(db.prepare("SELECT status FROM source WHERE started_at > 1").get()).toEqual({ status: "ok" });

    h.startLive({ checkEveryMs: 50 });
    await until(() => live().state === "connected", "the next run");
    expect(messageIds()).toEqual(["m0", "m1a", "m1b", "m2"]);
    expect(JSON.parse(cursor()!)).toEqual({ n: 3 });
    expect(addedBySource()).toEqual([2, 1]);
  });

  it("does nothing while switched off", async () => {
    const h = await setUp({});
    await writeFile(join(dataDir, "connectors", "live.json"), JSON.stringify({ enabled: false }));
    h.startLive({ checkEveryMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(live().state).toBe("off");
    expect(count("source")).toBe(0);
  });
});

/** The chat the connector's first run announces, written as that run would have. */
function setUpChat(): void {
  const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('telegram', 'live', 'live', 'sync', 1, 'ok')").run().lastInsertRowid);
  const session = new ImportSession(db, "telegram", source, "live");
  session.apply({ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true });
  session.apply({ kind: "account", key: "u1", keyKind: "id", displayName: "Someone" });
  session.apply({ kind: "conversation", id: "c1", type: "direct", members: ["me", "u1"] });
  session.apply({ kind: "message", id: "m0", idKind: "platform", conversation: "c1", sender: "u1", isFromSelf: false, sentAt: 1000, type: "text", text: "hello 0", raw: {} });
}
