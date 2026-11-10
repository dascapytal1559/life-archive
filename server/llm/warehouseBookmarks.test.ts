// The warehouse's bookmarks (warehouse.ts's llm_file) on a made-up home of their own: a file is passed over when it is
// as bookmarked, unless what came of it can change with the file unchanged (RETRIED): a file that could not be read
// (a Codex .zst caught mid-write) and a connector's session read before the connector indexed it are read again every
// pass, and a Grok session is read again when any of its files changes, not only its chat history.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCore } from "../archive/coreDb.ts";
import type { Db } from "../archive/db.ts";
import { EventWriter } from "../archive/events.ts";
import { warehouseSources } from "./sources.ts";
import { importWarehouse } from "./warehouse.ts";

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute)).toISOString();
const FIRSTMATE = "/home/sample/Projects/firstmate";

let root: string;
let home: string;
let dataDir: string;
let db: Db;

const write = (path: string, text: string | Buffer) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

const run = () =>
  Effect.runPromise(importWarehouse({
    db, dataDir, sources: warehouseSources(home, null), connector: { root: join(home, ".claude", "projects"), projects: [FIRSTMATE] }, lockDir: join(root, "lock"),
  }));

const outcomes = () => Object.fromEntries((db.prepare("SELECT path, outcome FROM llm_file").all() as Array<{ path: string; outcome: string }>).map((b) => [b.path.slice(home.length + 1), b.outcome]));

const grokFolder = () => join(home, ".grok", "sessions", "x", "g1");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "llm-bookmarks-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  db = openCore(join(dataDir, "core.sqlite"));
  // firstmate's own session, the connector's, which the connector has not indexed yet.
  write(join(home, ".claude", "projects", "-home-sample-Projects-firstmate", "own2.jsonl"), jsonl([
    { sessionId: "own2", cwd: FIRSTMATE, entrypoint: "cli", version: "2.1.300", type: "user", uuid: "own2-u0", timestamp: at(0), message: { role: "user", content: "What is the fleet doing?" }, promptSource: "typed", origin: { kind: "human" } },
    { sessionId: "own2", cwd: FIRSTMATE, entrypoint: "cli", version: "2.1.300", type: "assistant", uuid: "own2-a0", timestamp: at(1), message: { id: "m0", model: "claude-opus-5-5", content: [{ type: "text", text: "Two tasks." }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]));
  // A Codex rollout rewritten as .zst, caught mid-write: not yet a whole frame.
  write(join(home, ".codex", "sessions", "2026", "11", "03", "rollout-2026-11-03-r2.jsonl.zst"), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));
  // A Grok CLI session, with no usage yet.
  write(join(grokFolder(), "summary.json"), JSON.stringify({ info: { id: "g1", cwd: "/home/sample/Projects/trail-map" }, created_at: at(0), updated_at: at(2) }));
  write(join(grokFolder(), "chat_history.jsonl"), jsonl([
    { type: "user", content: [{ type: "text", text: "Show each trail's climb." }] },
    { type: "assistant", content: "Here it is.", model_id: "grok-4.7-build" },
  ]));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the warehouse's bookmarks", () => {
  it("read again every pass a file that could not be read and a connector's session not measured yet, and nothing else", async () => {
    expect(await run()).toMatchObject({ files: 3, read: 3, indexed: 1, measured: 0 });
    expect(outcomes()).toMatchObject({
      ".claude/projects/-home-sample-Projects-firstmate/own2.jsonl": expect.stringMatching(/^not measured yet/),
      ".codex/sessions/2026/11/03/rollout-2026-11-03-r2.jsonl.zst": expect.stringMatching(/^could not be read/),
      ".grok/sessions/x/g1": "indexed",
    });
    expect(await run()).toMatchObject({ read: 2, indexed: 0 });
  });

  it("measure the connector's session once the connector has it, and then pass it over", async () => {
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('claude-code', 'llm-sessions', 'app-db', 'test', 0, 'ok')").run().lastInsertRowid);
    const writer = new EventWriter(db, "claude-code", source, {}, dataDir);
    writer.llmSession({ kind: "llm-session", id: "own2", entrypoint: "cli", project: FIRSTMATE, file: "/x/own2.jsonl", startedAt: Date.parse(at(0)), endedAt: Date.parse(at(1)), bytes: 10 });
    expect(await run()).toMatchObject({ read: 2, measured: 1 });
    expect(outcomes()[".claude/projects/-home-sample-Projects-firstmate/own2.jsonl"]).toBe("measured");
    // Only the unreadable .zst is read again now.
    expect(await run()).toMatchObject({ read: 1 });
  });

  it("read a Grok session again when its usage changes, its chat history as it was", async () => {
    const usage = join(grokFolder(), "usage.json");
    writeFileSync(usage, JSON.stringify({ session: { inputTokens: 900, outputTokens: 40, cachedReadTokens: 600, cacheCreationTokens: 0 } }));
    const later = new Date(Date.now() + 60_000);
    utimesSync(usage, later, later);
    expect(await run()).toMatchObject({ read: 2, indexed: 1 });
    const tokens = db.prepare("SELECT s.input_tokens FROM llm_session s JOIN event e ON e.detail = 'llm_session' AND e.detail_id = s.id WHERE e.native_id = 'g1'").get();
    expect(tokens).toEqual({ input_tokens: 900 });
  });
});

describe("the warehouse's sources", () => {
  it("take no Claude Code profiles unless a folder of them is named, and each one in it when it is", () => {
    const named = (sources: ReturnType<typeof warehouseSources>) => sources.filter((s) => s.kind === "claude").map((s) => s.account);
    expect(named(warehouseSources(home, null))).toEqual(["claude"]);
    const profiles = join(root, "profiles");
    mkdirSync(join(profiles, "work", "projects"), { recursive: true });
    mkdirSync(join(profiles, "not-one"), { recursive: true });
    expect(named(warehouseSources(home, profiles))).toEqual(["claude", "work"]);
  });
});
