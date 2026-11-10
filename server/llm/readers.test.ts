// The warehouse's readers over made-up session files, one per tool: what a file gives as sessions, turns, measures and
// facts, and what its text was classified as (markers.ts). Every word in them is made up.

import { describe, expect, it } from "vitest";
import { readClaudeSession, turnStart } from "./claude.ts";
import { readCodexSession } from "./codex.ts";
import { readGrokSession } from "./grok.ts";
import { firstmateMarkerOf, firstmateProvenance } from "./firstmate.ts";
import { classifierOf, markerOf } from "./markers.ts";
import { readPiSession } from "./pi.ts";
import type { WarehouseSession } from "./types.ts";
import { EMPTY_CONTEXT } from "./context.ts";
import { tagsOf, type SessionRecord } from "./rules.ts";

const jsonl = (entries: unknown[]) => Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const tally = () => {};
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute)).toISOString();
const ok = (session: WarehouseSession | string): WarehouseSession => {
  if (typeof session === "string") throw new Error(session);
  return session;
};

describe("the prompt classifier", () => {
  const BRIEF = "⁣FIRSTMATE_OP: v1 launch-brief: # Task\nappend to '/home/sample/firstmate/state/garden-frost.status'";
  const STEER = ": Firstmate instruction waiting: list \"$FM_TASK_INBOX\"/*.msg in your 'garden-frost.inbox' steering inbox";

  it("knows firstmate's launch brief, its doorbells, a tool's notices, and leaves words alone, with FirstMate's provenance", () => {
    const classify = classifierOf(firstmateProvenance("/home/sample/firstmate"));
    expect(classify(BRIEF)).toBe("launch-brief");
    expect(classify(STEER)).toBe("steer-doorbell");
    expect(classify("FIRSTMATE_OP: v1 watcher: wake")).toBe("operational");
    expect(classify("<task-notification>\n<status>completed</status>")).toBe("task-notification");
    expect(classify("Add a frost warning to the planting calendar.")).toBeNull();
  });

  it("knows only the tools' own shapes without an orchestrator's provenance", () => {
    expect(classifierOf(null)).toBe(markerOf);
    expect(markerOf(BRIEF)).toBeNull();
    expect(markerOf(STEER)).toBeNull();
    expect(markerOf("<task-notification>\n<status>completed</status>")).toBe("task-notification");
    expect(markerOf("Stop hook feedback:\nrun the tests")).toBe("stop-hook");
    expect(markerOf("<command-name>/compact</command-name>")).toBe("command");
    expect(markerOf("[Request interrupted by user]")).toBe("interrupted");
    expect(markerOf("<environment_context>\n  <cwd>/home/sample</cwd>")).toBe("tool-context");
    expect(markerOf("<system-reminder>x</system-reminder>")).toBe("reminder");
    expect(markerOf("<system-reminder>x</system-reminder> and add the frost warning")).toBeNull();
    expect(markerOf("Add a frost warning to the planting calendar.")).toBeNull();
  });

  it("reads what an operational doorbell's record holds, and says when the record is gone", () => {
    const doorbell = ": Firstmate operational input waiting: read '/home/sample/firstmate/state/operational-inbox/ab12.msg' and handle its contents as Firstmate operational input.";
    const brief = "⁣FIRSTMATE_OP: v1 launch-brief: # Task\n'/home/sample/firstmate/state/recipe-scale.status'";
    expect(firstmateMarkerOf(doorbell, () => brief)).toBe("launch-brief");
    expect(firstmateMarkerOf(doorbell, () => "⁣FIRSTMATE_OP: v1 watcher: wake")).toBe("operational");
    expect(firstmateMarkerOf(doorbell, () => null)).toBe("operational-doorbell");
  });
});

describe("Claude Code's reader", () => {
  const base = { sessionId: "c1", cwd: "/home/sample/Projects/garden-planner", version: "2.1.300", entrypoint: "cli" };
  const user = (uuid: string, minute: number, content: unknown, more: Record<string, unknown> = {}) => ({ ...base, type: "user", uuid, timestamp: at(minute), message: { role: "user", content }, ...more });
  const assistant = (uuid: string, minute: number, id: string, content: unknown[], usage: Record<string, number>) =>
    ({ ...base, type: "assistant", uuid, timestamp: at(minute), message: { id, model: "claude-opus-5-5", content, usage } });
  const file = jsonl([
    user("u1", 0, "Add a frost warning to the planting calendar.", { promptSource: "typed", turnOrigin: "human" }),
    // One message written as two entries, each with its usage: counted once, the last.
    assistant("a1", 1, "m1", [{ type: "text", text: "On it." }], { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 }),
    assistant("a2", 1, "m1", [{ type: "tool_use", name: "Bash", input: {} }], { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 }),
    user("t1", 2, [{ type: "tool_result", content: "ok" }]),
    assistant("a3", 3, "m2", [{ type: "text", text: "Done." }], { input_tokens: 2, output_tokens: 4 }),
    user("u2", 4, "[Request interrupted by user]"),
    user("n1", 5, "<task-notification>done</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system", turnOrigin: "task_notification" }),
    assistant("a4", 6, "m3", [{ type: "text", text: "The build finished." }], { input_tokens: 1, output_tokens: 1 }),
    user("u3", 7, [{ type: "text", text: "Looks good." }, { type: "image", source: {} }], { promptSource: "typed" }),
    assistant("a5", 8, "m4", [{ type: "text", text: "Committed." }], { input_tokens: 1, output_tokens: 2 }),
    { type: "cost-state", sessionId: "c1", totalCostUSD: 0.42 },
  ]);

  it("gives every turn, a reply's tokens each message once, the session's cost, and no tool's own line as a prompt", () => {
    const s = ok(readClaudeSession("/home/sample/.claude/projects/x/c1.jsonl", file, { account: "second", tally }));
    expect(s.origin).toBe("claude-code");
    expect(s.event).toMatchObject({ id: "c1", entrypoint: "cli", project: "/home/sample/Projects/garden-planner", version: "2.1.300", model: "claude-opus-5-5" });
    expect(s.turns.map((t) => [t.role, t.id, t.role === "reply" ? t.answers : t.facts?.source])).toEqual([
      ["prompt", "u1", "typed"], ["reply", "a1", "human"], ["reply", "a4", "task-notification"], ["prompt", "u3", "typed"], ["reply", "a5", "human"],
    ]);
    expect(s.turns[1]).toMatchObject({ replyTo: "u1", toolCalls: 1, tokens: { input: 117, output: 11, cacheRead: 100, cacheWrite: 5 } });
    expect(s.turns[3]).toMatchObject({ images: 1, chars: "Looks good.".length });
    expect(s.tokens).toEqual({ input: 119, output: 14, cacheRead: 100, cacheWrite: 5 });
    expect(s).toMatchObject({ costUsd: 0.42, images: 1, toolCalls: 1, facts: { account: "second" } });
  });

  it("reads a subagent's file, all its lines the subagent's, as a session under its parent", () => {
    const sub = jsonl([user("s1", 0, "Look for the watering code.", { isSidechain: true }), assistant("s2", 1, "m9", [{ type: "text", text: "Found it." }], { input_tokens: 1, output_tokens: 1 })]);
    const s = ok(readClaudeSession("/home/sample/.claude/projects/x/c1/subagents/agent-a7.jsonl", sub, { account: "claude", subagent: true, tally }));
    expect(s.event.id).toBe("c1/agent-a7");
    expect(s.facts).toEqual({ account: "claude", parent: "c1", subagent: true });
    expect(s.turns.map((t) => t.role)).toEqual(["prompt", "reply"]);
  });

  it("names a gone session by the archive's copy, any version of it, as the session it was", () => {
    for (const copy of ["c1.jsonl.zst", "c1.jsonl.changed-2.zst"]) {
      const s = ok(readClaudeSession(`/home/sample/life-archive-data/transcripts/claude-code/x/${copy}`, file, { account: "second", gone: true, tally }));
      expect(s.event.id).toBe("c1");
    }
  });

  it("starts no turn at a tool's result, a meta note or a compaction summary", () => {
    expect(turnStart({ type: "user", message: { content: [{ type: "tool_result" }] } })).toBeNull();
    expect(turnStart({ type: "user", isMeta: true, message: { content: "x" } })).toBeNull();
    expect(turnStart({ type: "user", isCompactSummary: true, message: { content: "x" } })).toBeNull();
    expect(turnStart({ type: "user", promptSource: "sdk", turnOrigin: "sdk", message: { content: "x" } })).toEqual({ start: "prompt", source: "sdk" });
  });
});

describe("Codex's reader", () => {
  const line = (minute: number, type: string, payload: unknown) => ({ timestamp: at(minute), type, payload });
  const total = (input: number, cached: number, output: number) => ({ type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } });
  const rollout = jsonl([
    line(0, "session_meta", { id: "r1", timestamp: at(0), cwd: "/home/sample/Projects/recipe-box", originator: "codex-tui", cli_version: "0.166.0", source: "cli" }),
    line(0, "turn_context", { model: "gpt-5.5-codex", cwd: "/home/sample/Projects/recipe-box" }),
    // Codex's own context, sent as the user: no prompt.
    line(0, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n</environment_context>" }] }),
    line(1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Let me scale a recipe." }] }),
    line(1, "event_msg", { type: "item_completed", item: { type: "UserMessage", id: "um1", content: [{ type: "text", text: "Let me scale a recipe." }] } }),
    line(2, "response_item", { type: "function_call", name: "shell", arguments: "{}" }),
    line(2, "event_msg", total(1000, 800, 50)),
    line(3, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Scaled." }] }),
    line(3, "event_msg", total(1500, 1200, 80)),
    line(4, "event_msg", { type: "item_completed", item: { type: "UserMessage", id: "um2", content: [{ type: "text", text: "Now sort the soups." }, { type: "local_image", path: "/tmp/x.png" }] } }),
    line(5, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sorted." }] }),
    line(5, "event_msg", total(1700, 1300, 95)),
  ]);

  it("takes the prompts someone sent, not Codex's own context, and each turn's tokens from the running total", () => {
    const s = ok(readCodexSession("/home/sample/.codex/sessions/rollout-r1.jsonl", rollout, { tally }));
    expect(s.event).toMatchObject({ id: "r1", entrypoint: "codex-tui", project: "/home/sample/Projects/recipe-box", version: "0.166.0", model: "gpt-5.5-codex" });
    expect(s.turns.map((t) => [t.role, t.id])).toEqual([["prompt", "um1"], ["reply", "r1:6"], ["prompt", "um2"], ["reply", "r1:11"]]);
    expect(s.turns[1]).toMatchObject({ toolCalls: 1, chars: "Scaled.".length, tokens: { input: 1500, output: 80, cacheRead: 1200, cacheWrite: 0 }, replyTo: "um1" });
    expect(s.turns[3]).toMatchObject({ tokens: { input: 200, output: 15, cacheRead: 100, cacheWrite: 0 } });
    expect(s.turns[2]).toMatchObject({ images: 1 });
    expect(s.tokens).toEqual({ input: 1700, output: 95, cacheRead: 1300, cacheWrite: 0 });
    expect(s.facts).toEqual({ account: "codex", originator: "codex-tui", source: "cli" });
  });

  it("says a subagent's parent, and an agent's message to it is the agent's prompt", () => {
    const sub = jsonl([
      line(0, "session_meta", { id: "r2", cwd: "/home/sample", originator: "codex-tui", source: { subagent: { thread_spawn: { parent_thread_id: "r1" } } }, agent_path: "/root/scout" }),
      line(1, "response_item", { type: "agent_message", author: "/root", recipient: "/root/scout", content: "Find the trail data." }),
      line(2, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found." }] }),
    ]);
    const s = ok(readCodexSession("/home/sample/.codex/sessions/rollout-r2.jsonl", sub, { tally }));
    expect(s.facts).toMatchObject({ parent: "r1", subagent: true, source: "subagent" });
    expect(s.turns[0]).toMatchObject({ role: "prompt", facts: { source: "agent" } });
    expect(s.turns[1]).toMatchObject({ role: "reply", answers: "agent" });
  });
});

describe("the Grok CLI's reader", () => {
  it("times each prompt by its updates, and takes the session's tokens and cost", () => {
    const files = {
      "summary.json": Buffer.from(JSON.stringify({ info: { id: "g1", cwd: "/home/sample/Projects/trail-map" }, created_at: at(0), updated_at: at(9), current_model_id: "grok-4.7-build" })),
      "chat_history.jsonl": jsonl([
        { type: "system", content: "You are made up." },
        { type: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }], synthetic_reason: "system_reminder" },
        { type: "user", content: [{ type: "text", text: "Show each trail's climb." }], prompt_index: 0 },
        { type: "assistant", content: "Here it is.", tool_calls: [{ id: "x" }], model_id: "grok-4.7-build" },
        { type: "user", content: [{ type: "text", text: "Add the huts." }], prompt_index: 1 },
        { type: "assistant", content: "Added.", model_id: "grok-4.7-build" },
      ]),
      "updates.jsonl": jsonl([
        { timestamp: Date.parse(at(1)) / 1000, method: "session/update", params: { update: { sessionUpdate: "user_message_chunk" } } },
        { timestamp: Date.parse(at(1)) / 1000, method: "session/update", params: { update: { sessionUpdate: "user_message_chunk" } } },
        { timestamp: Date.parse(at(2)) / 1000, method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } },
        { timestamp: Date.parse(at(5)) / 1000, method: "session/update", params: { update: { sessionUpdate: "user_message_chunk" } } },
      ]),
      "usage.json": Buffer.from(JSON.stringify({ session: { inputTokens: 900, outputTokens: 40, cachedReadTokens: 600, cacheCreationTokens: 0, costUsdTicks: 50_000_000 } })),
    };
    const s = ok(readGrokSession("/home/sample/.grok/sessions/x/g1/chat_history.jsonl", files, { tally }));
    expect(s.origin).toBe("grok-cli");
    expect(s.turns.filter((t) => t.role === "prompt").map((t) => t.at)).toEqual([Date.parse(at(1)), Date.parse(at(5))]);
    expect(s.turns[1]).toMatchObject({ role: "reply", toolCalls: 1, model: "grok-4.7-build" });
    expect(s.tokens).toEqual({ input: 900, output: 40, cacheRead: 600, cacheWrite: 0 });
    expect(s.costUsd).toBeCloseTo(0.005);
  });
});

describe("Pi's reader", () => {
  it("gives its prompts and replies with their usage and Pi's own cost", () => {
    const file = jsonl([
      { type: "session", id: "p1", cwd: "/home/sample/Projects/trail-map", version: 3, timestamp: at(0) },
      { type: "message", id: "e1", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Map the coast walk." }] } },
      { type: "message", id: "e2", timestamp: at(2), message: { role: "assistant", model: "grok-4.5", content: [{ type: "text", text: "Mapped." }, { type: "toolCall" }], usage: { input: 50, output: 10, cacheRead: 20, cacheWrite: 0, cost: { total: 0.01 } } } },
      { type: "message", id: "e3", timestamp: at(3), message: { role: "toolResult", content: [] } },
    ]);
    const s = ok(readPiSession("/home/sample/.pi/agent/sessions/x/p1.jsonl", file, { tally }));
    expect(s.event).toMatchObject({ id: "p1", entrypoint: "pi", version: "3", model: "grok-4.5" });
    expect(s.turns.map((t) => t.role)).toEqual(["prompt", "reply"]);
    expect(s.turns[1]).toMatchObject({ tokens: { input: 70, output: 10, cacheRead: 20, cacheWrite: 0 }, toolCalls: 1 });
    expect(s.costUsd).toBeCloseTo(0.01);
  });
});

describe("the Grok CLI's reader, around its own prompts", () => {
  it("times a prompt it made itself (stop hook feedback) as the one before, and every later prompt by its own update", () => {
    const files = {
      "summary.json": Buffer.from(JSON.stringify({ info: { id: "g2", cwd: "/home/sample/Projects/trail-map" }, created_at: at(0), updated_at: at(9) })),
      "chat_history.jsonl": jsonl([
        { type: "user", content: [{ type: "text", text: "Show each trail's climb." }] },
        { type: "assistant", content: "Here it is.", model_id: "grok-4.7-build" },
        { type: "user", content: [{ type: "text", text: "Stop hook feedback:\nrun the tests" }], synthetic_reason: "stop_hook_feedback" },
        { type: "assistant", content: "Ran them.", model_id: "grok-4.7-build" },
        { type: "user", content: [{ type: "text", text: "Add the huts." }] },
        { type: "assistant", content: "Added.", model_id: "grok-4.7-build" },
      ]),
      // Only the two prompts sent as user messages have updates.
      "updates.jsonl": jsonl([
        { timestamp: Date.parse(at(1)) / 1000, method: "session/update", params: { update: { sessionUpdate: "user_message_chunk" } } },
        { timestamp: Date.parse(at(2)) / 1000, method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } },
        { timestamp: Date.parse(at(6)) / 1000, method: "session/update", params: { update: { sessionUpdate: "user_message_chunk" } } },
      ]),
      "usage.json": null,
    };
    const s = ok(readGrokSession("/home/sample/.grok/sessions/x/g2/chat_history.jsonl", files, { tally }));
    const prompts = s.turns.filter((t) => t.role === "prompt");
    expect(prompts.map((t) => [t.facts?.source, t.at])).toEqual([["user", Date.parse(at(1))], ["stop_hook_feedback", Date.parse(at(1))], ["user", Date.parse(at(6))]]);
  });
});

describe("the tool-record rule", () => {
  it("tags a Claude Code prompt whose source is system as the system's, not the person's at the terminal", () => {
    const session: SessionRecord = {
      id: 1, origin: "claude-code", nativeId: "c9", entrypoint: "cli", project: "/home/sample/Projects/garden-planner", at: 0, facts: { account: "claude" },
      prompts: [{ id: 10, at: 0, facts: { source: "typed" } }, { id: 11, at: 1, facts: { source: "system" } }],
    };
    const who = (turn: number) => tagsOf(session, EMPTY_CONTEXT).filter((p) => p.targetId === turn && p.family === "who" && p.rule === "tool-record").map((p) => p.value);
    expect(who(10)).toEqual(["human"]);
    expect(who(11)).toEqual(["system"]);
    expect(tagsOf(session, EMPTY_CONTEXT).some((p) => p.targetId === 11 && p.family === "device")).toBe(false);
  });
});
