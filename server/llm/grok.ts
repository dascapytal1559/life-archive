// The warehouse's reader of the Grok CLI's sessions (~/.grok/sessions/<cwd, URL-encoded>/<session id>/), each a
// folder whose files the CLI writes as it goes. What is read of them (a prompt's text only to classify it, markers.ts):
//   summary.json        the session: info { id, cwd }, created_at, updated_at, current_model_id, session_kind
//                       (headless, subagent; none for a session someone was at) and agent_name
//   chat_history.jsonl  its turns, one JSON line each, with no time: a user line is a prompt (blocks of text and
//                       images), unless it is synthetic (synthetic_reason: a system reminder or the project's
//                       instructions are no prompt; a finished task's notice starts a turn that is none; a Stop hook's
//                       feedback is a prompt the hook sent); the assistant's lines (content, tool_calls, model_id) the
//                       reply, until the next prompt
//   updates.jsonl       the session's updates, each with its time: a user_message_chunk is a prompt being sent, so the
//                       n-th run of them gives the n-th prompt its time (a prompt without one takes the session's start)
//   usage.json          the session's tokens and cost (costUsdTicks, ten billion to the dollar)
// A turn's id is the session's and its line's number in chat_history.jsonl, which is the session's file in the index.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { charsOf } from "../connectors/llm-sessions/entries.ts";
import { type Classify, markerOf, NOT_PROMPTS } from "./markers.ts";
import { jsonLines, mostOf, msOf, type SessionFacts, type Tally, type Tokens, type WarehouseSession, type WarehouseTurn } from "./types.ts";

/** The files of a session's folder the reader takes, by name; a file that is not there is null. */
/** The files of a Grok session's folder the warehouse reads: a change to any of them is a change to the session. */
export const GROK_FILES = ["summary.json", "chat_history.jsonl", "updates.jsonl", "usage.json"] as const;

export type GrokFiles = Record<(typeof GROK_FILES)[number], Buffer | null>;

export function grokFiles(folder: string): GrokFiles {
  const read = (name: string) => {
    try {
      return readFileSync(join(folder, name));
    } catch {
      return null;
    }
  };
  return { "summary.json": read("summary.json"), "chat_history.jsonl": read("chat_history.jsonl"), "updates.jsonl": read("updates.jsonl"), "usage.json": read("usage.json") };
}

const json = (buffer: Buffer | null): Record<string, unknown> | null => {
  if (!buffer) return null;
  try {
    const value = JSON.parse(buffer.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** One session's folder: `file` its chat_history.jsonl as the index names it. */
export function readGrokSession(file: string, files: GrokFiles, { tally, classify = markerOf }: { tally: Tally; classify?: Classify }): WarehouseSession | string {
  const summary = json(files["summary.json"]);
  const chat = files["chat_history.jsonl"];
  const info = summary?.info as { id?: unknown; cwd?: unknown } | undefined;
  if (!summary || !chat || typeof info?.id !== "string" || info.id === "") return "Grok sessions with no summary or chat, left out";
  const id = info.id;
  const createdAt = msOf(summary.created_at) ?? msOf(summary.last_active_at);
  if (createdAt === null) return "Grok sessions with no time, left out";
  const updatedAt = Math.max(createdAt, msOf(summary.updated_at) ?? createdAt);

  // When each prompt was sent: the time of each run of user_message_chunk updates.
  const sent: number[] = [];
  let inRun = false;
  for (const { entry } of files["updates.jsonl"] ? jsonLines(files["updates.jsonl"]) : []) {
    const update = (entry.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update?.sessionUpdate;
    const at = msOf(entry.timestamp);
    if (update === "user_message_chunk") {
      if (!inRun && at !== null) sent.push(at);
      inRun = true;
    } else if (update !== undefined) inRun = false;
  }

  const turns: WarehouseTurn[] = [];
  const models = new Map<string, number>();
  let images = 0;
  let toolCalls = 0;
  let prompts = 0;
  /** The prompts sent as user messages, each timed by its run of updates, and the time the last prompt took. */
  let typed = 0;
  let lastAt: number | null = null;
  let reply: { prompt?: WarehouseTurn; first?: { line: number; offset: number }; end: number; texts: string[]; toolCalls: number; answers: string; model?: string } | null = null;
  const flush = () => {
    if (reply?.first && reply.texts.length + reply.toolCalls > 0) {
      const at = reply.prompt?.at ?? createdAt;
      turns.push({
        kind: "llm-turn", id: `${id}:${reply.first.line}`, session: id, role: "reply", answers: reply.answers, ...(reply.prompt ? { replyTo: reply.prompt.id } : {}),
        at, ...(reply.model ? { model: reply.model } : {}), chars: charsOf(reply.texts.join("\n\n")), toolCalls: reply.toolCalls,
        line: reply.first.line, offset: reply.first.offset, length: reply.end - reply.first.offset,
      });
      if (reply.prompt && reply.model) reply.prompt.model = reply.model;
    }
    reply = null;
  };
  for (const { entry, line, offset, length } of jsonLines(chat)) {
    if (entry.type === "user") {
      const synthetic = typeof entry.synthetic_reason === "string" ? entry.synthetic_reason : null;
      if (synthetic === "system_reminder" || synthetic === "project_instructions") continue;
      if (synthetic === "task_completed") {
        flush();
        reply = { end: 0, texts: [], toolCalls: 0, answers: "task-notification" };
        continue;
      }
      const blocks = Array.isArray(entry.content) ? (entry.content as Array<{ type?: unknown; text?: unknown }>) : [];
      const text = typeof entry.content === "string" ? entry.content : blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
      const marker = synthetic === "stop_hook_feedback" ? "stop-hook" : classify(text);
      if (marker !== null && NOT_PROMPTS.has(marker)) continue;
      flush();
      const pictures = blocks.filter((b) => b?.type === "image").length;
      images += pictures;
      // A prompt the CLI made itself (stop_hook_feedback) was never sent as a user message, so it takes no update's time
      // (that would shift every later prompt's by one): it is timed as the prompt before it.
      const at: number = synthetic === null ? (sent[typed] ?? (typed === 0 ? createdAt : updatedAt)) : (lastAt ?? createdAt);
      if (synthetic === null) typed++;
      lastAt = at;
      prompts++;
      const prompt: WarehouseTurn = {
        kind: "llm-turn", id: `${id}:${line}`, session: id, role: "prompt", at, chars: charsOf(text), images: pictures, line, offset, length,
        facts: { source: synthetic ?? "user", ...(marker ? { marker } : {}) },
      };
      turns.push(prompt);
      reply = { prompt, end: 0, texts: [], toolCalls: 0, answers: "human" };
      continue;
    }
    if (entry.type !== "assistant") continue;
    reply ??= { end: 0, texts: [], toolCalls: 0, answers: "unseen" };
    reply.first ??= { line, offset };
    reply.end = offset + length;
    if (typeof entry.content === "string" && entry.content !== "") reply.texts.push(entry.content);
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls.length : 0;
    reply.toolCalls += calls;
    toolCalls += calls;
    if (typeof entry.model_id === "string") {
      reply.model = entry.model_id;
      models.set(entry.model_id, (models.get(entry.model_id) ?? 0) + 1);
    }
  }
  flush();
  if (prompts === 0) tally("Grok sessions with no prompt");
  if (turns.length === 0) return "Grok sessions with no turn, left out";

  const usage = (json(files["usage.json"])?.session ?? null) as Record<string, unknown> | null;
  const n = (k: string) => (usage && typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const tokens: Tokens | undefined = usage
    // inputTokens holds the cached ones already: totalTokens is it and outputTokens.
    ? { input: n("inputTokens"), output: n("outputTokens"), cacheRead: n("cachedReadTokens"), cacheWrite: n("cacheCreationTokens") }
    : undefined;
  const facts: SessionFacts = {
    account: "grok",
    ...(typeof summary.session_kind === "string" ? { kind: summary.session_kind } : {}),
    ...(typeof summary.agent_name === "string" ? { agent: summary.agent_name } : {}),
    ...(summary.session_kind === "subagent" ? { subagent: true } : {}),
  };
  const model = mostOf(models) ?? (typeof summary.current_model_id === "string" ? summary.current_model_id : undefined);
  return {
    origin: "grok-cli",
    event: {
      kind: "llm-session", id, entrypoint: typeof summary.session_kind === "string" ? summary.session_kind : "interactive",
      project: typeof info.cwd === "string" && info.cwd !== "" ? info.cwd : "unknown", file, ...(model ? { model } : {}),
      startedAt: Math.min(createdAt, ...turns.map((t) => t.at)), endedAt: Math.max(updatedAt, ...turns.map((t) => t.at)), bytes: chat.lastIndexOf(0x0a) + 1,
    },
    turns,
    ...(tokens ? { tokens } : {}),
    ...(usage && typeof usage.costUsdTicks === "number" ? { costUsd: usage.costUsdTicks / 1e10 } : {}),
    images,
    toolCalls,
    facts,
  };
}
