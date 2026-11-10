// The LLM warehouse's made-up sessions for the testing data (npm run testing-data -- <folder> --crowd), so its
// Prompts, Agent sessions and LLM tags tables have something to show: six weeks of firstmate's workers (a launch
// brief, then steers and wake-ups), the captain's own conversations through T3 from his phone and his desktop,
// firstmate's own thread, the programs' calls and a few Codex and Grok CLI sessions, as the warehouse indexes them,
// then tagged by the rules over a made-up T3 and firstmate (its provenance adapter, llm/firstmate.ts, over made-up records). Only their structure is made up: there are no session
// files behind them, so their words cannot be read. Seeded, so they are the same every time.

import type { Db } from "../archive/db.ts";
import { transaction } from "../archive/db.ts";
import { EventWriter } from "../archive/events.ts";
import type { RuleContext, T3Message } from "../llm/context.ts";
import { firstmateOrchestrator, noRecords, type FirstmateRecords } from "../llm/firstmate.ts";
import { retag } from "../llm/tags.ts";
import { WAREHOUSE_CONNECTOR, type WarehouseSession, type WarehouseTurn } from "../llm/types.ts";
import { indexSession } from "../llm/warehouse.ts";

const PROJECTS = ["garden-planner", "recipe-box", "trail-map"];
const TASKS = ["frost-warning", "scale-recipes", "trail-climbs", "hut-list", "soup-sort", "watering-rain"];
const FIRSTMATE = "/home/sample/Projects/firstmate";
const MAIN = "thread-firstmate";
const DAY = 86_400_000;

/** Writes the made-up sessions into `core` (as the warehouse's import would) and tags them; gives how many. */
export function writeCrowdWarehouse(core: Db, end = Date.now()): number {
  const random = mulberry(20261107);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const sessions: WarehouseSession[] = [];
  const firstmate: FirstmateRecords = { ...noRecords(FIRSTMATE), tasks: new Set(TASKS), mainThread: MAIN };
  const context: RuleContext = {
    t3: { threadOfSession: new Map(), threads: new Map([[MAIN, { id: MAIN, createdBy: "user", creationSource: "web" }]]), messagesOfSession: new Map() },
    orchestrator: firstmateOrchestrator(firstmate),
  };
  let n = 0;
  const session = (origin: WarehouseSession["origin"], entrypoint: string, project: string, startedAt: number, prompts: Array<{ facts: WarehouseTurn["facts"]; chars: number }>, account: string): WarehouseSession => {
    const id = `crowd-${origin}-${n++}`;
    const turns: WarehouseTurn[] = [];
    let at = startedAt;
    for (const [i, p] of prompts.entries()) {
      turns.push({ kind: "llm-turn", id: `${id}-p${i}`, session: id, role: "prompt", at, chars: p.chars, line: i * 2 + 1, offset: 0, length: 1, facts: p.facts });
      at += 20_000 + Math.floor(random() * 300_000);
      const tokens = { input: 20_000 + Math.floor(random() * 80_000), output: 500 + Math.floor(random() * 4_000), cacheRead: 15_000, cacheWrite: 1_000 };
      turns.push({ kind: "llm-turn", id: `${id}-r${i}`, session: id, role: "reply", answers: "human", replyTo: `${id}-p${i}`, at, model: "claude-opus-5-5", chars: 200 + Math.floor(random() * 3000), toolCalls: Math.floor(random() * 6), line: i * 2 + 2, offset: 0, length: 1, tokens });
      at += 60_000 + Math.floor(random() * 1_200_000);
    }
    const s: WarehouseSession = {
      origin, turns, images: 0, toolCalls: turns.reduce((sum, t) => sum + (t.toolCalls ?? 0), 0), facts: { account },
      tokens: turns.reduce((sum, t) => ({ input: sum.input + (t.tokens?.input ?? 0), output: sum.output + (t.tokens?.output ?? 0), cacheRead: sum.cacheRead + (t.tokens?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (t.tokens?.cacheWrite ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      costUsd: Math.round(random() * 400) / 100,
      event: { kind: "llm-session", id, entrypoint, project, file: `/home/sample/.made-up/${id}.jsonl`, model: "claude-opus-5-5", startedAt, endedAt: at, bytes: 1000 },
    };
    sessions.push(s);
    return s;
  };
  /** The T3 messages that sent a session's prompts: the captain's from his phone (more of them as the weeks go) or desktop, or firstmate's. */
  const throughT3 = (s: WarehouseSession, thread: string, sender: (i: number, at: number) => Pick<T3Message, "createdBy" | "creationSource" | "notification">) => {
    context.t3.threadOfSession.set(s.event.id, thread);
    context.t3.messagesOfSession.set(s.event.id, s.turns.filter((t) => t.role === "prompt").map((t, i) => ({ id: `${t.id}-m`, thread, at: t.at + 1_500, ...sender(i, t.at) })));
  };
  const captain = (at: number) => ({ createdBy: "user", creationSource: random() < 0.15 + 0.45 * (1 - (end - at) / (42 * DAY)) ? "mobile" : "web", notification: false });

  for (let day = 42; day >= 1; day--) {
    const morning = end - day * DAY + 8 * 3_600_000;
    // firstmate's workers: each a task's launch brief, then a steer or two and a wake-up.
    for (let w = Math.floor(random() * 4); w >= 0; w--) {
      const project = pick(PROJECTS);
      const task = `${pick(TASKS)}-${day}${w}`;
      const prompts: Array<{ facts: WarehouseTurn["facts"]; chars: number }> = [{ facts: { source: "sdk", marker: "launch-brief" }, chars: 9000 }, ...Array.from({ length: Math.floor(random() * 3) }, () => ({ facts: { source: "sdk", marker: "steer-doorbell" as const }, chars: 160 }))];
      if (random() < 0.4) prompts.push({ facts: { source: "sdk", marker: "operational" as const }, chars: 300 });
      const s = session("claude-code", "t3-code", `/home/sample/.treehouse/${project}-ab12cd/${w + 1}/${project}`, morning + w * 5_400_000, prompts, "second");
      const thread = `thread-${s.event.id}`;
      context.t3.threads.set(thread, { id: thread, createdBy: "agent", creationSource: "mcp", crewOf: MAIN });
      firstmate.taskOfThread.set(thread, task);
      throughT3(s, thread, () => ({ createdBy: "agent", creationSource: "mcp", notification: false }));
    }
    // firstmate's own thread: the captain's words to it, and its notices.
    const main = session("claude-code", "t3-code", FIRSTMATE, morning - 3_600_000, Array.from({ length: 3 + Math.floor(random() * 8) }, () => ({ facts: { source: "sdk" }, chars: 40 + Math.floor(random() * 400) })), "second");
    throughT3(main, MAIN, (i, at) => (i % 4 === 3 ? { createdBy: "agent", creationSource: "provider", notification: true } : captain(at)));
    // His own conversations through T3, on most days.
    if (random() < 0.7) {
      const s = session("claude-code", "t3-code", `/home/sample/Projects/${pick(PROJECTS)}`, morning + 10 * 3_600_000, Array.from({ length: 2 + Math.floor(random() * 6) }, () => ({ facts: { source: "sdk" }, chars: 30 + Math.floor(random() * 300) })), "second");
      const thread = `thread-${s.event.id}`;
      context.t3.threads.set(thread, { id: thread, createdBy: "user", creationSource: "web" });
      throughT3(s, thread, (_i, at) => captain(at));
    }
    // The programs' calls, nobody at them.
    for (let p = Math.floor(random() * 4); p > 0; p--) session("claude-code", "sdk-cli", "/home/sample", morning + p * 3_000_000, [{ facts: { source: "sdk" }, chars: 800 }], "claude");
    // Now and then Codex in a terminal, or the Grok CLI run by a program.
    if (random() < 0.25) session("codex", "codex-tui", `/home/sample/Projects/${pick(PROJECTS)}`, morning + 12 * 3_600_000, [{ facts: { source: "user" }, chars: 120 }, { facts: { source: "user" }, chars: 60 }], "codex");
    if (random() < 0.2) session("grok-cli", "headless", "/home/sample", morning + 2 * 3_600_000, [{ facts: { source: "user" }, chars: 500 }], "grok");
  }

  transaction(core, () => {
    const source = Number(core.prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES ('llm', ?, 'app-db', 'crowd', ?, ?, 'ok')").run(WAREHOUSE_CONNECTOR, end, end).lastInsertRowid);
    const writers = new Map<string, EventWriter>();
    for (const s of sessions) {
      let writer = writers.get(s.origin);
      if (!writer) {
        writer = new EventWriter(core, s.origin, source, {});
        writer.device({ kind: "device", key: "computer:sample-mac", name: "sample-mac", deviceKind: "computer" });
        writers.set(s.origin, writer);
      }
      indexSession(core, writer, s, "computer:sample-mac");
    }
  });
  retag(core, context, end);
  return sessions.length;
}

/** A small seeded random number generator (as crowd.ts's). */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
