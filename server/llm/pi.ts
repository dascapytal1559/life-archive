// The warehouse's reader of Pi's sessions (~/.pi/agent/sessions/<cwd, its slashes made "-">/<time>_<id>.jsonl): one
// JSON line each, the first { type: "session", id, cwd, version, timestamp }, then entries, each with its id and time.
// A `message` entry's message has a role: user (a prompt, its content text and image blocks; its text read only to
// classify it, markers.ts), assistant (the reply: text, thinking and toolCall blocks, its model and usage, Pi's own
// cost included), toolResult and system (neither a turn). A custom_message is Pi's or an extension's, no prompt.

import { charsOf } from "../connectors/llm-sessions/entries.ts";
import { type Classify, markerOf, NOT_PROMPTS } from "./markers.ts";
import { addTokens, jsonLines, mostOf, msOf, NO_TOKENS, type Tally, type Tokens, type WarehouseSession, type WarehouseTurn } from "./types.ts";

function tokensOf(usage: unknown): { tokens: Tokens; cost: number } | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  const cost = (u.cost as { total?: unknown } | undefined)?.total;
  return { tokens: { input: n("input") + n("cacheRead") + n("cacheWrite"), output: n("output"), cacheRead: n("cacheRead"), cacheWrite: n("cacheWrite") }, cost: typeof cost === "number" ? cost : 0 };
}

export function readPiSession(file: string, buffer: Buffer, { gone = false, tally, classify = markerOf }: { gone?: boolean; tally: Tally; classify?: Classify }): WarehouseSession | string {
  const lines = jsonLines(buffer);
  const head = lines[0]?.entry;
  if (head?.type !== "session" || typeof head.id !== "string" || head.id === "") return "Pi sessions with no session line, left out";
  const id = head.id;
  const turns: WarehouseTurn[] = [];
  const models = new Map<string, number>();
  let tokens = NO_TOKENS;
  let cost = 0;
  let images = 0;
  let toolCalls = 0;
  let startedAt = msOf(head.timestamp) ?? Infinity;
  let endedAt = -Infinity;
  let reply: { prompt?: WarehouseTurn; first?: { id: string; line: number; offset: number; at: number }; end: number; endAt: number; texts: string[]; toolCalls: number; tokens: Tokens; model?: string } | null = null;
  const flush = () => {
    if (reply?.first && reply.texts.length + reply.toolCalls > 0) {
      turns.push({
        kind: "llm-turn", id: reply.first.id, session: id, role: "reply", answers: reply.prompt ? "human" : "unseen", ...(reply.prompt ? { replyTo: reply.prompt.id } : {}),
        at: reply.first.at, endAt: reply.endAt, ...(reply.model ? { model: reply.model } : {}), chars: charsOf(reply.texts.join("\n\n")),
        toolCalls: reply.toolCalls, line: reply.first.line, offset: reply.first.offset, length: reply.end - reply.first.offset, tokens: reply.tokens,
      });
      if (reply.prompt && reply.model) reply.prompt.model = reply.model;
    }
    reply = null;
  };
  for (const { entry, line, offset, length } of lines) {
    const at = msOf(entry.timestamp);
    if (at !== null) {
      startedAt = Math.min(startedAt, at);
      endedAt = Math.max(endedAt, at);
    }
    if (entry.type !== "message" || at === null || typeof entry.id !== "string") continue;
    const message = entry.message as { role?: unknown; content?: unknown; model?: unknown; usage?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message.content as Array<{ type?: unknown; text?: unknown }>) : [];
    if (message?.role === "user") {
      const text = typeof message.content === "string" ? message.content : blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
      const marker = classify(text);
      if (marker !== null && NOT_PROMPTS.has(marker)) {
        tally(`lines of the tool's own (${marker}), not prompts`);
        continue;
      }
      flush();
      const pictures = blocks.filter((b) => b?.type === "image").length;
      images += pictures;
      const prompt: WarehouseTurn = { kind: "llm-turn", id: entry.id, session: id, role: "prompt", at, chars: charsOf(text), images: pictures, line, offset, length, facts: { source: "user", ...(marker ? { marker } : {}) } };
      turns.push(prompt);
      reply = { prompt, end: 0, endAt: at, texts: [], toolCalls: 0, tokens: NO_TOKENS };
      continue;
    }
    if (message?.role !== "assistant") continue;
    reply ??= { end: 0, endAt: at, texts: [], toolCalls: 0, tokens: NO_TOKENS };
    reply.first ??= { id: entry.id, line, offset, at };
    reply.end = offset + length;
    reply.endAt = Math.max(reply.endAt, at);
    reply.texts.push(...blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string));
    const calls = blocks.filter((b) => b?.type === "toolCall").length;
    reply.toolCalls += calls;
    toolCalls += calls;
    const used = tokensOf(message.usage);
    if (used) {
      reply.tokens = addTokens(reply.tokens, used.tokens);
      tokens = addTokens(tokens, used.tokens);
      cost += used.cost;
    }
    if (typeof message.model === "string") {
      reply.model = message.model;
      models.set(message.model, (models.get(message.model) ?? 0) + 1);
    }
  }
  flush();
  if (turns.length === 0) return "Pi sessions with no turn, left out";
  const model = mostOf(models);
  return {
    origin: "pi",
    event: {
      kind: "llm-session", id, entrypoint: "pi", project: typeof head.cwd === "string" && head.cwd !== "" ? head.cwd : "unknown", file,
      ...(typeof head.version === "string" || typeof head.version === "number" ? { version: String(head.version) } : {}), ...(model ? { model } : {}),
      startedAt, endedAt: Math.max(endedAt, startedAt), bytes: buffer.lastIndexOf(0x0a) + 1,
    },
    turns,
    tokens,
    costUsd: cost,
    images,
    toolCalls,
    facts: { account: "pi", ...(gone ? { gone: true } : {}) },
  };
}
