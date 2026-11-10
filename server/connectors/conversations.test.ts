import { appendFile, mkdtemp, readFile, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { BOTS, pebbleEntries, writeChat, writeGrokBotFixture } from "../fixtures/grok-bot.ts";
import { moreOfTalk, PROJECT, SESSIONS, TEXTS, writeLlmSessionsFixture } from "../fixtures/llm-sessions.ts";
import { Archive } from "../archive/index.ts";
import { readLlmContent } from "../archive/llmContent.ts";
import { runBackground, runPromise } from "../effectRuntime.ts";
import type { ConnectorEvent, SyncOptions } from "./contract.ts";
import { type Change, type Changes, settled } from "./conversations.ts";
import { grokBot } from "./grok-bot/read.ts";
import { llmSessions } from "./llm-sessions/read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-conversations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Waits for `done`, 20 ms a try: up to 20 s, as long as a busy machine needs (vitest.config.ts), unless told. */
async function until(done: () => boolean | Promise<boolean>, what = "the condition", tries = 1_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Changes `file` and waits for what the change brings. macOS tells fs.watch of a change late when the machine is busy
 * (seconds late beside the rest of the suite and other work). So it waits long, and while the change is not heard
 * the file is touched again, in case its event was lost (its time alone: the change stays as made once).
 */
async function changeUntil(file: string, change: () => Promise<unknown>, done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  await change();
  for (let i = 0; i < 8; i++) {
    try {
      return await until(done, what, 250);
    } catch {
      const now = new Date();
      await utimes(file, now, now);
    }
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The made-up session file grown by one more prompt, as an agent writes it (its last, unfinished line cut first). */
async function growTalk(talk: string): Promise<void> {
  await truncate(talk, (await readFile(talk)).lastIndexOf(0x0a) + 1);
  await appendFile(talk, moreOfTalk());
}

/** Runs a connector's sync with quick timings until stopped (interrupted, as its process's edge stops it); its events, and how to stop it. */
function sync(connector: typeof llmSessions, source: string, copiesDir: string, cursor: unknown, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  const options: SyncOptions = {
    sources: [source], mediaDir: join(dir, "media"), copiesDir, cursor, onCommand: () => {},
    config: { settleMs: 50, maxWaitMs: 300, rescanMs: 60_000, ...config }, emit: async (event) => void events.push(event),
  };
  const running = runBackground(connector.sync!(options).pipe(Effect.orDie));
  // At least, never exactly: macOS can tell the watcher late of the files written just before it, and when a slow first
  // pass has let that settle a second pass, with nothing to read, follows within a millisecond or two.
  const batches = () => events.filter((e) => e.kind === "checkpoint").length;
  return { events, batches, stop: () => runPromise(Fiber.interrupt(running)) };
}

describe("the changes a sync passes over", () => {
  it.effect("are gathered until none has come for settleMs, or at most maxWaitMs after the first", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<Change>();
      const passes: Changes[] = [];
      const fiber = yield* Effect.forkChild(
        settled(changes, { settleMs: 2_000, maxWaitMs: 10_000 }).pipe(Stream.runForEach((only) => Effect.sync(() => passes.push(only)))),
        { startImmediately: true },
      );
      const change = (folder: string, name: string | null) => Queue.offer(changes, { folder, name });

      // Two changes 1.5 s apart settle 2 s after the second.
      yield* change("a", "x.jsonl");
      yield* TestClock.adjust(1_500);
      yield* change("a", "y.jsonl");
      yield* change("b", "z.jsonl");
      yield* TestClock.adjust(1_999);
      expect(passes).toEqual([]);
      yield* TestClock.adjust(1);
      expect(passes).toEqual([new Map([["a", new Set(["x.jsonl", "y.jsonl"])], ["b", new Set(["z.jsonl"])]])]);

      // A change the watcher cannot name stands for its whole folder.
      yield* change("a", "x.jsonl");
      yield* change("a", null);
      yield* change("a", "y.jsonl");
      yield* TestClock.adjust(2_000);
      expect(passes[1]).toEqual(new Map([["a", null]]));

      // Changes that keep coming are passed over 10 s after the first, and the rest after they settle.
      for (let i = 0; i < 8; i++) {
        yield* change("a", `${i}.jsonl`);
        yield* TestClock.adjust(1_500);
      }
      expect(passes.length).toBe(3);
      expect([...(passes[2].get("a") as Set<string>)]).toEqual(["0.jsonl", "1.jsonl", "2.jsonl", "3.jsonl", "4.jsonl", "5.jsonl", "6.jsonl"]);
      yield* TestClock.adjust(2_000);
      expect([...(passes[3].get("a") as Set<string>)]).toEqual(["7.jsonl"]);
      yield* Fiber.interrupt(fiber);
    }));
});

describe("an agent's conversations, live", () => {
  it("reads every conversation when it starts, then only what changes, a couple of seconds after it settles", async () => {
    const store = join(dir, "store");
    const files = await writeLlmSessionsFixture(store);
    const copies = join(dir, "llm", "claude-code");
    const live = sync(llmSessions, store, copies, null, { projects: [PROJECT] });
    await until(() => live.batches() >= 1, "the first pass");
    const first = live.events.filter((e) => e.kind === "llm-session").map((e) => (e as { id: string }).id);
    expect(first).toEqual([SESSIONS.talk, SESSIONS.continued]);

    // The session going on: a pass of its file alone, the other sessions not read again.
    const seen = live.events.length;
    const sessionsSince = () => live.events.slice(seen).filter((e) => e.kind === "llm-session").map((e) => (e as { id: string }).id);
    await changeUntil(files.talk, () => growTalk(files.talk), () => sessionsSince().length > 0 && live.events.at(-1)?.kind === "checkpoint", "the pass of what changed");
    const second = live.events.slice(seen);
    expect(sessionsSince()).toEqual([SESSIONS.talk]);
    expect(second.find((e) => e.kind === "tally" && e.name === "conversations that grew, their copies brought up to date")).toBeTruthy();
    const cursor = (second.findLast((e) => e.kind === "checkpoint") as { cursor: { files: Record<string, number> } }).cursor;
    expect(cursor.files["-home-sample-Projects-firstmate/0a1b2c3d-0000-4000-8000-000000000001.jsonl"]).toBe((await readFile(files.talk)).length);
    expect(live.events.find((e) => e.kind === "state")).toEqual({ kind: "state", state: "connecting", detail: "reading every conversation" });
    expect(live.events.filter((e) => e.kind === "state").at(-1)).toEqual({ kind: "state", state: "connected", detail: "watching 1 of 1 folder" });
    await live.stop();

    // Started again from its bookmarks, it reads nothing that has not changed since.
    const again = sync(llmSessions, store, copies, cursor, { projects: [PROJECT] });
    await until(() => again.batches() >= 1, "the first pass again");
    expect(again.events.filter((e) => e.kind === "llm-session" || e.kind === "llm-turn")).toEqual([]);
    await again.stop();
  }, 90_000);

  it("follows a Grok Bot chat as the app writes it whole", async () => {
    const cache = join(dir, "cache");
    const chats = await writeGrokBotFixture(cache);
    const live = sync(grokBot, cache, join(dir, "llm", "grok-bot"), null);
    await until(() => live.batches() >= 1, "the first pass");
    const seen = live.events.length;
    await changeUntil(chats.pebble, () => writeChat(cache, BOTS.pebble, pebbleEntries({ finished: true })), () => live.events.slice(seen).some((e) => e.kind === "llm-turn") && live.events.at(-1)?.kind === "checkpoint", "the pass of what changed");
    const reply = live.events.slice(seen).find((e) => e.kind === "llm-turn" && e.id === `${BOTS.pebble}/a12`);
    expect(reply).toMatchObject({ role: "reply", answers: "human" });
    await live.stop();
  }, 90_000);

  it("runs in the archive's server: a change is in the index, and readable, within seconds", async () => {
    const store = join(dir, "store");
    const files = await writeLlmSessionsFixture(store);
    const archive = await Archive.open(join(dir, "data"));
    try {
      await archive.host.setEnabled("llm-sessions", true);
      const settings = join(dir, "data", "connectors", "llm-sessions.json");
      await writeFile(settings, JSON.stringify({ enabled: true, source: store, projects: [PROJECT], settleMs: 50, maxWaitMs: 300 }));
      archive.startLive(undefined, { checkEveryMs: 50 });
      const count = (kind: string) => (archive.coreDb.prepare("SELECT count(*) AS n FROM event WHERE kind = ?").get(kind) as { n: number }).n;
      await until(() => count("llm_prompt") === 5, "the first pass in the index");
      await changeUntil(files.talk, () => growTalk(files.talk), () => count("llm_prompt") === 6, "the new prompt in the index");
      // Read back from the archive's copy, through the content path.
      const talk = (archive.coreDb.prepare("SELECT id FROM event WHERE native_id = ?").get(SESSIONS.talk) as { id: number }).id;
      expect(readLlmContent(archive.coreDb, join(dir, "data"), talk)!.turns.map((t) => t.text)).toContain(TEXTS.writing);
      // Its bookmarks are kept with what it read; one live source for the whole run.
      const state = archive.coreDb.prepare("SELECT cursor_json FROM connector_state WHERE connector = 'llm-sessions'").get() as { cursor_json: string };
      expect(Object.keys(JSON.parse(state.cursor_json).files)).toHaveLength(5);
      expect(archive.coreDb.prepare("SELECT count(*) AS n FROM source WHERE connector = 'llm-sessions'").get()).toEqual({ n: 1 });
    } finally {
      await archive.stopLive();
      archive.close();
    }
  }, 90_000);
});
