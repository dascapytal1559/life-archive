// The LLM warehouse end to end on a made-up home: every tool's sessions read into a core of the test's own (one the
// tool has deleted, from the archive's copy of it), the connector's own session only measured, the pass resumed and
// read again without a change, the calendar keeping the warehouse's sessions out, and the tags: the rules' over T3's
// and firstmate's records (made up too, through its provenance adapter, firstmate.ts), the same each time they run,
// none of firstmate's without it, and the captain's own over them.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { openCore } from "../archive/coreDb.ts";
import type { Db } from "../archive/db.ts";
import { EventIndex, EventWriter } from "../archive/events.ts";
import { latestLlmSession } from "../archive/llmContent.ts";
import { indexRows } from "../calendar/eventIndex.ts";
import { EMPTY_CONTEXT, readContext, type RuleContext } from "./context.ts";
import { configuredProvenance } from "./provenance.ts";
import { firstmateOrchestrator, firstmateProvenance, noRecords, type FirstmateRecords } from "./firstmate.ts";
import { classifierOf } from "./markers.ts";
import { deviceOfStamp, matchMessages, projectOf, sessionKindOf, type SessionRecord } from "./rules.ts";
import { warehouseSources } from "./sources.ts";
import { retag, sessionRecords, tagByHand, untagByHand } from "./tags.ts";
import { importWarehouse, type ImportOptions } from "./warehouse.ts";

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute)).toISOString();
const ms = (minute: number) => Date.parse(at(minute));

let root: string;
let home: string;
let dataDir: string;
let db: Db;
const FIRSTMATE = "/home/sample/Projects/firstmate";
const WORKTREE = "/home/sample/.treehouse/garden-planner-ab12cd/1/garden-planner";

/** A Claude Code session's lines: a prompt (its text and how it came), and a reply with its usage. */
function claude(id: string, cwd: string, entrypoint: string, prompts: Array<{ text: string; minute: number; source?: string; origin?: string }>): string {
  const base = { sessionId: id, cwd, entrypoint, version: "2.1.300" };
  return jsonl(prompts.flatMap((p, i) => [
    { ...base, type: "user", uuid: `${id}-u${i}`, timestamp: at(p.minute), message: { role: "user", content: p.text }, ...(p.source ? { promptSource: p.source } : {}), ...(p.origin ? { origin: { kind: p.origin } } : {}) },
    { ...base, type: "assistant", uuid: `${id}-a${i}`, timestamp: at(p.minute + 1), message: { id: `${id}-m${i}`, model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]));
}

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

const options = (more: Partial<ImportOptions> = {}): ImportOptions => ({
  db, dataDir, sources: warehouseSources(home, join(home, ".claude-profiles")), connector: { root: join(home, ".claude", "projects"), projects: [FIRSTMATE] },
  lockDir: join(root, "lock"), classify: classifierOf(firstmateProvenance(FIRSTMATE)), ...more,
});
const run = (more: Partial<ImportOptions> = {}) => Effect.runPromise(importWarehouse(options(more)));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "llm-warehouse-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  db = openCore(join(dataDir, "core.sqlite"));
  const projects = join(home, ".claude", "projects");
  // firstmate's own session, the connector's: someone at it in a terminal, in its project.
  write(join(projects, "-home-sample-Projects-firstmate", "own1.jsonl"), claude("own1", FIRSTMATE, "cli", [{ text: "What is the fleet doing?", minute: 0, origin: "human", source: "typed" }]));
  // A worker's, through T3: its launch brief first, then a steer.
  write(join(home, ".claude-profiles", "second", "projects", "-home-sample--treehouse-garden-planner-ab12cd-1-garden-planner", "w1.jsonl"), claude("w1", WORKTREE, "t3-code", [
    { text: "⁣FIRSTMATE_OP: v1 launch-brief: # Task\nappend to '/home/sample/Projects/firstmate/state/garden-frost.status'", minute: 10, source: "sdk" },
    { text: ": Firstmate instruction waiting: list \"$FM_TASK_INBOX\"/*.msg in your 'garden-frost.inbox' steering inbox", minute: 20, source: "sdk" },
  ]));
  // The captain's own through T3, sent from his phone and then his desktop.
  write(join(home, ".claude-profiles", "second", "projects", "-home-sample-Projects-recipe-box", "c1.jsonl"), claude("c1", "/home/sample/Projects/recipe-box", "t3-code", [
    { text: "Let me scale a recipe.", minute: 30, source: "sdk" },
    { text: "Now sort the soups.", minute: 40, source: "sdk" },
  ]));
  // A program's call, nobody at it.
  write(join(projects, "-home-sample", "x1.jsonl"), claude("x1", "/home/sample", "sdk-cli", [{ text: "Tag this saved post.", minute: 50, source: "sdk" }]));
  // A Codex session in a terminal, and a Pi one.
  write(join(home, ".codex", "sessions", "2026", "11", "03", "rollout-2026-11-03-r1.jsonl"), jsonl([
    { timestamp: at(0), type: "session_meta", payload: { id: "r1", timestamp: at(0), cwd: "/home/sample/Projects/trail-map", originator: "codex-tui", cli_version: "0.166.0", source: "cli" } },
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add the huts." }] } },
    { timestamp: at(2), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added." }] } },
  ]));
  write(join(home, ".pi", "agent", "sessions", "--home-sample--", "2026_p1.jsonl"), jsonl([
    { type: "session", id: "p1", cwd: "/home/sample", timestamp: at(0) },
    { type: "message", id: "e1", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Map the coast walk." }] } },
    { type: "message", id: "e2", timestamp: at(2), message: { role: "assistant", model: "grok-4.5", content: [{ type: "text", text: "Mapped." }] } },
  ]));
  // A session Claude Code has deleted, which only the archive's copy of every transcript still has.
  const gone = Buffer.from(claude("g1", "/home/sample/Projects/trail-map", "cli", [{ text: "Show each trail's climb.", minute: 5, source: "typed" }]));
  const rel = "projects/-home-sample-Projects-trail-map/g1.jsonl";
  write(join(dataDir, "transcripts", "claude-code", `${rel}.zst`), "");
  writeFileSync(join(dataDir, "transcripts", "claude-code", `${rel}.zst`), zstdCompressSync(gone));
  writeFileSync(join(dataDir, "transcripts", "claude-code.json"), JSON.stringify({
    root: join(home, ".claude"),
    files: { [rel]: { size: gone.length, mtimeMs: 1, sha256: createHash("sha256").update(gone).digest("hex"), versions: 1, stored: 0, earlier: 0, goneAt: at(0) } },
  }));
  // The connector has firstmate's session already, as it writes it.
  const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('claude-code', 'llm-sessions', 'app-db', 'test', 0, 'ok')").run().lastInsertRowid);
  const writer = new EventWriter(db, "claude-code", source, {}, dataDir);
  writer.llmSession({ kind: "llm-session", id: "own1", entrypoint: "cli", project: FIRSTMATE, file: "/x/own1.jsonl", startedAt: ms(0), endedAt: ms(1), bytes: 10 });
  writer.llmTurn({ kind: "llm-turn", id: "own1-u0", session: "own1", role: "prompt", at: ms(0), chars: 24, line: 1, offset: 0, length: 1 });
  writer.llmTurn({ kind: "llm-turn", id: "own1-a0", session: "own1", role: "reply", answers: "human", replyTo: "own1-u0", at: ms(1), chars: 5, line: 2, offset: 0, length: 1 });
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** The T3 and firstmate records the rules read, made up: the worker's thread a live task's, the captain's messages from his phone and desktop. */
const CONTEXT: RuleContext = {
  t3: {
    threadOfSession: new Map([["w1", "thread-w"], ["c1", "thread-c"]]),
    threads: new Map([["thread-w", { id: "thread-w", createdBy: "agent", creationSource: "mcp", crewOf: "thread-main" }], ["thread-c", { id: "thread-c", createdBy: "user", creationSource: "web" }]]),
    messagesOfSession: new Map([
      ["c1", [
        { id: "m1", thread: "thread-c", at: ms(30) + 2_000, createdBy: "user", creationSource: "mobile", notification: false },
        { id: "m2", thread: "thread-c", at: ms(40) + 1_000, createdBy: "user", creationSource: "web", notification: false, deviceType: "desktop" },
      ]],
      ["w1", [{ id: "m3", thread: "thread-w", at: ms(20), createdBy: "agent", creationSource: "mcp", notification: false }]],
    ]),
  },
  orchestrator: firstmateOrchestrator({ ...noRecords(FIRSTMATE), tasks: new Set(["garden-frost"]), taskOfThread: new Map([["thread-w", "garden-frost"]]), mainThread: "thread-main" }),
};

/** A context with firstmate's records as given, and nothing of T3's. */
const firstmateOnly = (records: Partial<FirstmateRecords>): RuleContext => ({ ...EMPTY_CONTEXT, orchestrator: firstmateOrchestrator({ ...noRecords(FIRSTMATE), ...records }) });

describe("the warehouse's import", () => {
  it("indexes every tool's sessions, a deleted one from the archive's copy, and only measures the connector's", async () => {
    const result = await run();
    expect(result).toMatchObject({ files: 7, read: 7, indexed: 6, measured: 1 });
    const sessions = db.prepare("SELECT e.origin, e.native_id, s.file, s.facts FROM event e JOIN llm_session s ON s.id = e.detail_id WHERE e.kind = 'llm_session' ORDER BY e.native_id").all() as Array<{ origin: string; native_id: string; file: string; facts: string | null }>;
    expect(sessions.map((s) => `${s.origin}:${s.native_id}`)).toEqual(["claude-code:c1", "claude-code:g1", "claude-code:own1", "pi:p1", "codex:r1", "claude-code:w1", "claude-code:x1"]);
    // The deleted session is named by the archive's copy, relative to its folder.
    expect(sessions.find((s) => s.native_id === "g1")).toMatchObject({ file: "transcripts/claude-code/projects/-home-sample-Projects-trail-map/g1.jsonl.zst", facts: JSON.stringify({ account: "claude", gone: true }) });
    // The connector's session keeps its own file, and has its measures now.
    expect(sessions.find((s) => s.native_id === "own1")).toMatchObject({ file: "/x/own1.jsonl", facts: JSON.stringify({ account: "claude" }) });
    const reply = db.prepare("SELECT t.input_tokens, t.output_tokens FROM llm_turn t JOIN event e ON e.detail = 'llm_turn' AND e.detail_id = t.id WHERE e.native_id = 'own1-a0'").get();
    expect(reply).toEqual({ input_tokens: 10, output_tokens: 5 });
    const prompt = db.prepare("SELECT t.facts FROM llm_turn t JOIN event e ON e.detail = 'llm_turn' AND e.detail_id = t.id WHERE e.native_id = 'w1-u0'").get() as { facts: string };
    // A launch brief is known by its shape alone: the task its text names is never kept.
    expect(JSON.parse(prompt.facts)).toEqual({ source: "sdk", marker: "launch-brief" });
  });

  it("goes on where it stopped: a second pass reads nothing, and reading every file again changes nothing", async () => {
    expect(await run()).toMatchObject({ files: 7, read: 0 });
    const again = await run({ again: true });
    expect(again.read).toBe(7);
    for (const counts of Object.values(again.counts)) expect(counts).toMatchObject({ added: 0, updated: 0 });
  });

  it("keeps the warehouse's sessions out of the calendar, and the connector's in it", () => {
    const rows = indexRows(db, new EventIndex(db));
    expect([...new Set(rows.map((row) => (row.facts as { session: string }).session))]).toEqual(["own1"]);
  });

  it("leaves event-content's latest session the connectors' conversation, never a worker's or a program's", () => {
    const own = (db.prepare("SELECT id FROM event WHERE native_id = 'own1'").get() as { id: number }).id;
    expect(latestLlmSession(db, "claude-code")).toBe(own);
  });
});

describe("the tags", () => {
  const chosen = (nativeId: string, family: string) =>
    (db.prepare(`SELECT g.value, g.rule, g.guess FROM llm_tag g JOIN event e ON e.detail_id = g.target_id AND e.detail = CASE g.target WHEN 'session' THEN 'llm_session' ELSE 'llm_turn' END
      WHERE e.native_id = ? AND g.family = ? AND g.chosen = 1`).get(nativeId, family) as { value: string; rule: string; guess: number } | undefined) ?? null;

  it("say who sent each prompt, from which device and how, and what each session is", () => {
    retag(db, CONTEXT, 1);
    expect(chosen("w1", "session")).toMatchObject({ value: "worker", guess: 0 });
    expect(chosen("w1", "task")).toMatchObject({ value: "garden-frost" });
    expect(chosen("w1", "tool")).toMatchObject({ value: "claude-second" });
    expect(chosen("w1", "app")).toMatchObject({ value: "t3" });
    expect(chosen("w1", "project")).toMatchObject({ value: "garden-planner" });
    expect(chosen("w1-u0", "who")).toMatchObject({ value: "firstmate" });
    expect(chosen("w1-u0", "channel")).toMatchObject({ value: "initial-instructions" });
    expect(chosen("w1-u1", "channel")).toMatchObject({ value: "inbox-note" });
    expect(chosen("w1-u1", "device")).toBeNull();
    expect(chosen("c1-u0", "who")).toMatchObject({ value: "human", rule: "t3-message" });
    expect(chosen("c1-u0", "device")).toMatchObject({ value: "phone", guess: 0 });
    expect(chosen("c1-u1", "device")).toMatchObject({ value: "desktop", guess: 0 });
    expect(chosen("c1", "session")).toMatchObject({ value: "own" });
    expect(chosen("x1", "session")).toMatchObject({ value: "app-internal", guess: 1 });
    expect(chosen("x1-u0", "who")).toMatchObject({ value: "system", guess: 1 });
    expect(chosen("own1", "session")).toMatchObject({ value: "firstmate-main" });
    expect(chosen("own1-u0", "device")).toMatchObject({ value: "terminal", guess: 0 });
    expect(chosen("g1-u0", "who")).toMatchObject({ value: "human" });
    expect(chosen("r1", "tool")).toMatchObject({ value: "codex" });
    expect(chosen("p1", "tool")).toMatchObject({ value: "pi" });
  });

  it("are the same each time the rules run, and a rule no longer giving one takes it off", () => {
    expect(retag(db, CONTEXT, 2)).toMatchObject({ added: 0, removed: 0 });
    const before = chosen("c1-u0", "device");
    // Without T3's records, the captain's prompts through T3 lose their device (absent means not known).
    const without = retag(db, EMPTY_CONTEXT, 3);
    expect(without.removed).toBeGreaterThan(0);
    expect(chosen("c1-u0", "device")).toMatchObject({ value: "unknown", guess: 1 });
    retag(db, CONTEXT, 4);
    expect(chosen("c1-u0", "device")).toEqual(before);
  });

  it("take the captain's own over every rule's, and give the rules' back when he takes his off", () => {
    const event = (db.prepare("SELECT id FROM event WHERE native_id = 'x1-u0'").get() as { id: number }).id;
    tagByHand(db, event, "who", "human", "that was me, testing");
    expect(chosen("x1-u0", "who")).toMatchObject({ value: "human", rule: "hand" });
    retag(db, CONTEXT, 5);
    expect(chosen("x1-u0", "who")).toMatchObject({ value: "human", rule: "hand" });
    expect(untagByHand(db, event, "who")).toBe(true);
    expect(chosen("x1-u0", "who")).toMatchObject({ value: "system", rule: "tool-record" });
    expect(() => tagByHand(db, event, "colour", "blue", null)).toThrow(/family/);
  });

  it("give none of firstmate's without its provenance: T3's crew is a worker by guess, steered by an agent", () => {
    retag(db, { ...CONTEXT, orchestrator: null }, 6);
    const firstmates = db.prepare(`SELECT count(*) AS n FROM llm_tag WHERE family = 'task' OR (family, value) IN
      (VALUES ('session', 'firstmate-main'), ('session', 'secondmate'), ('who', 'firstmate'), ('channel', 'initial-instructions'), ('channel', 'inbox-note'), ('channel', 'steer'))`).get() as { n: number };
    expect(firstmates.n).toBe(0);
    expect(chosen("w1", "session")).toMatchObject({ value: "worker", guess: 1 });
    expect(chosen("w1-u1", "who")).toMatchObject({ value: "agent", rule: "t3-message", guess: 1 });
    expect(chosen("own1", "session")).toMatchObject({ value: "own" });
    expect(chosen("c1-u0", "device")).toMatchObject({ value: "phone", guess: 0 });
    retag(db, CONTEXT, 7);
    expect(chosen("w1-u0", "who")).toMatchObject({ value: "firstmate" });
    expect(chosen("own1", "session")).toMatchObject({ value: "firstmate-main" });
  });
});

describe("the rules", () => {
  const record = (more: Partial<SessionRecord>): SessionRecord => ({ id: 1, origin: "claude-code", nativeId: "s", entrypoint: "cli", project: "/home/sample", at: 0, facts: {}, prompts: [], ...more });

  it("match each prompt to the T3 message whose run started nearest it, within two minutes, each once", () => {
    const prompts = [{ id: 1, at: 1_000_000, facts: {} }, { id: 2, at: 1_005_000, facts: {} }, { id: 3, at: 9_000_000, facts: {} }];
    const message = (id: string, at: number) => ({ id, thread: "t", at, createdBy: "user", creationSource: "web", notification: false });
    const matched = matchMessages(prompts, [message("a", 1_001_000), message("b", 1_004_000)]);
    expect([...matched].map(([p, m]) => [p, m.id])).toEqual([[1, "a"], [2, "b"]]);
  });

  it("name a worker by its doorbell when its record is gone, and its task by the brief written as it began", () => {
    const context = firstmateOnly({ briefs: [{ task: "garden-frost", project: "garden-planner", at: 60_000 }, { task: "recipe-scale", project: "recipe-box", at: 61_000 }] });
    const kind = sessionKindOf(record({ project: WORKTREE, at: 90_000, prompts: [{ id: 1, at: 90_000, facts: { marker: "operational-doorbell" } }] }), context);
    expect(kind).toEqual({ kind: "worker", task: "garden-frost", guess: true });
    expect(sessionKindOf(record({ project: "/home/sample/.no-mistakes/worktrees/abc" }), context).kind).toBe("review-pipeline");
    expect(sessionKindOf(record({ facts: { subagent: true } }), context).kind).toBe("helper");
  });

  it("take a worker's task from firstmate's records alone, never from what its launch brief's text says", () => {
    const records = (briefs: FirstmateRecords["briefs"]): RuleContext => firstmateOnly({ briefs });
    // A turn kept from before: its facts still name the task its text gave, which no rule reads.
    const kept = { marker: "launch-brief", task: "garden-frost" } as unknown as SessionRecord["prompts"][number]["facts"];
    const briefed = record({ project: WORKTREE, at: 90_000, prompts: [{ id: 1, at: 90_000, facts: kept }] });
    expect(sessionKindOf(briefed, records([{ task: "recipe-scale", project: "garden-planner", at: 60_000 }]))).toEqual({ kind: "worker", task: "recipe-scale", guess: false });
    expect(sessionKindOf(briefed, records([]))).toEqual({ kind: "worker", guess: false });
  });

  it("read T3's device stamp as the device: its deviceType, as the T3 Code fork writes it", () => {
    expect(["desktop", "mobile", "tablet", "bot", "unknown"].map(deviceOfStamp)).toEqual(["desktop", "phone", "tablet", "unknown", "unknown"]);
  });

  it("find a project from the folder a session ran in", () => {
    const firstmate = firstmateOrchestrator(noRecords(FIRSTMATE));
    expect(projectOf(WORKTREE, firstmate)).toBe("garden-planner");
    expect(projectOf(`${FIRSTMATE}/projects/recipe-box`, firstmate)).toBe("recipe-box");
    expect(projectOf(FIRSTMATE, firstmate)).toBe("firstmate");
    expect(projectOf("/private/tmp/claude-501/-home-sample--treehouse-trail-map-ab12cd-2-trail-map/x", firstmate)).toBe("trail-map");
    expect(projectOf("/opt/elsewhere", firstmate)).toBeNull();
    // With no orchestrator configured, firstmate's folders are only folders.
    expect(projectOf(`${FIRSTMATE}/projects/recipe-box`, null)).toBe("firstmate");
  });

  it("ask firstmate only where the installation names its home", () => {
    expect(configuredProvenance({ firstmateHome: null })).toBeNull();
    expect(readContext({ t3File: null, provenance: null }).orchestrator).toBeNull();
    const fm = configuredProvenance({ firstmateHome: join(root, "no-such-home") });
    expect(fm?.markerOf("FIRSTMATE_OP: v1 watcher: wake")).toBe("operational");
    expect(readContext({ t3File: null, provenance: fm }).orchestrator?.homeKind(record({ project: join(root, "no-such-home") }))).toBe("firstmate-main");
  });

  it("read every session of the index with its prompts", () => {
    const records = sessionRecords(db);
    expect(records.find((r) => r.nativeId === "w1")?.prompts).toHaveLength(2);
  });
});
