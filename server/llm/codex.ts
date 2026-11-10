// The warehouse's reader of Codex's rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, and the
// .jsonl.zst Codex rewrites a quiet one as; ~/.codex/archived_sessions): one JSON line each, { timestamp, type, payload }.
//
// What is read of a line (a prompt's text only to classify it, markers.ts):
//   session_meta   the session: its id, cwd, cli_version, originator (the app: codex-tui, Codex Desktop, codex_exec,
//                  t3code_desktop, ...) and source (cli, exec, vscode, or { subagent: ... }, with its parent's id), and
//                  forked_from_id
//   turn_context   the model the turns after it run on
//   event_msg      item_completed with a UserMessage item: a prompt someone sent (newer Codex), its id and text parts
//                  (text, image, local_image); token_count: the session's running total_token_usage
//   response_item  a message from the user (older Codex's prompts; newer Codex sends its context and instructions as
//                  these too, which are no prompt), from the assistant (a reply's words), a function or custom tool
//                  call; an agent_message to this thread from another agent (multi-agent Codex: author, recipient)
// A prompt's turn runs until the next prompt: its reply is the assistant's messages and tool calls in it, its tokens
// what the running total grew by meanwhile. Codex keeps no id on a reply's lines, so a reply's id is the session's and
// its first line's number.

import { charsOf } from "../connectors/llm-sessions/entries.ts";
import { type Classify, markerOf, NOT_PROMPTS } from "./markers.ts";
import { eachJsonLine, type JsonLine, mostOf, msOf, type SessionFacts, type Tally, type Tokens, type TurnFacts, type WarehouseSession, type WarehouseTurn } from "./types.ts";

type Line = JsonLine;
type Part = { type?: unknown; text?: unknown };

/** A running total_token_usage as tokens (input counts the cached). */
function totalOf(usage: unknown): Tokens | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  return { input: n("input_tokens"), output: n("output_tokens"), cacheRead: n("cached_input_tokens"), cacheWrite: n("cache_write_input_tokens") };
}

const minus = (a: Tokens, b: Tokens): Tokens => ({
  input: Math.max(0, a.input - b.input), output: Math.max(0, a.output - b.output),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead), cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
});

const textOf = (parts: unknown): { text: string; images: number } => {
  const list = Array.isArray(parts) ? (parts as Part[]) : [];
  return {
    text: list.filter((p) => (p?.type === "text" || p?.type === "input_text" || p?.type === "output_text") && typeof p.text === "string").map((p) => p.text as string).join("\n"),
    images: list.filter((p) => p?.type === "image" || p?.type === "local_image" || p?.type === "input_image").length,
  };
};

/** One rollout (`file` as the index names it, `buffer` its bytes, decompressed): its session and turns, or why it is left out. */
export function readCodexSession(file: string, buffer: Buffer, { gone = false, tally, classify = markerOf }: { gone?: boolean; tally: Tally; classify?: Classify }): WarehouseSession | string {
  let meta: Record<string, unknown> | undefined;
  for (const l of eachJsonLine(buffer)) {
    if (l.entry.type !== "session_meta") continue;
    meta = l.entry.payload as Record<string, unknown> | undefined;
    break;
  }
  if (!meta || typeof meta.id !== "string" || meta.id === "") return "rollouts with no session_meta, left out";
  const id = meta.id;
  const source = meta.source;
  const subagent = typeof source === "object" && source !== null && "subagent" in source ? (source as { subagent: unknown }).subagent : null;
  const spawnedBy = (subagent as { thread_spawn?: { parent_thread_id?: unknown } } | null)?.thread_spawn?.parent_thread_id;
  const parent = [meta.parent_thread_id, spawnedBy, meta.forked_from_id].find((v): v is string => typeof v === "string" && v !== "");
  const ownPath = typeof meta.agent_path === "string" ? meta.agent_path : "/root";
  // Newer Codex's prompts are its UserMessage items (so its user messages are its own context); a text naming one is
  // escaped in the JSON, so the bytes say it only for an item's own type.
  const usesItems = buffer.includes('"type":"UserMessage"');

  const turns: WarehouseTurn[] = [];
  const models = new Map<string, number>();
  let model: string | undefined;
  let total: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let startedAt = msOf(meta.timestamp) ?? Infinity;
  let endedAt = -Infinity;
  let images = 0;
  let toolCalls = 0;
  let reply: { prompt?: WarehouseTurn; first?: Line & { at: number }; end: number; endAt: number; texts: string[]; toolCalls: number; from: Tokens; answers: string } | null = null;
  const flush = () => {
    if (reply?.first && reply.texts.length + reply.toolCalls > 0) {
      turns.push({
        kind: "llm-turn", id: `${id}:${reply.first.line}`, session: id, role: "reply", answers: reply.answers,
        ...(reply.prompt ? { replyTo: reply.prompt.id } : {}), at: reply.first.at, endAt: reply.endAt, ...(model ? { model } : {}),
        chars: charsOf(reply.texts.join("\n\n")), toolCalls: reply.toolCalls, line: reply.first.line, offset: reply.first.offset,
        length: reply.end - reply.first.offset, tokens: minus(total, reply.from),
      });
      if (reply.prompt && model) reply.prompt.model = model;
    }
    reply = null;
  };
  const begin = (l: Line, at: number, words: { text: string; images: number }, promptId: string, source: string) => {
    const marker = classify(words.text);
    if (marker !== null && NOT_PROMPTS.has(marker)) return tally(`lines of the tool's own (${marker}), not prompts`);
    flush();
    const facts: TurnFacts = { source, ...(marker ? { marker } : {}) };
    images += words.images;
    const prompt: WarehouseTurn = { kind: "llm-turn", id: promptId, session: id, role: "prompt", at, chars: charsOf(words.text), images: words.images, line: l.line, offset: l.offset, length: l.length, facts };
    turns.push(prompt);
    reply = { prompt, end: 0, endAt: at, texts: [], toolCalls: 0, from: total, answers: source === "agent" ? "agent" : "human" };
  };
  for (const l of eachJsonLine(buffer)) {
    const at = msOf(l.entry.timestamp);
    if (at !== null) {
      startedAt = Math.min(startedAt, at);
      endedAt = Math.max(endedAt, at);
    }
    const p = (l.entry.payload ?? {}) as Record<string, unknown>;
    if (l.entry.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (l.entry.type === "event_msg" && p.type === "token_count") {
      total = totalOf((p.info as { total_token_usage?: unknown } | null)?.total_token_usage) ?? total;
      continue;
    }
    if (at === null) continue;
    if (usesItems && l.entry.type === "event_msg" && p.type === "item_completed") {
      const item = p.item as { type?: unknown; id?: unknown; content?: unknown } | undefined;
      if (item?.type === "UserMessage") begin(l, at, textOf(item.content), typeof item.id === "string" && item.id !== "" ? item.id : `${id}:${l.line}`, "user");
      continue;
    }
    if (l.entry.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      if (!usesItems) begin(l, at, textOf(p.content), `${id}:${l.line}`, "user");
      continue;
    }
    if (p.type === "agent_message" && p.recipient === ownPath && p.author !== ownPath) {
      begin(l, at, { text: typeof p.content === "string" ? p.content : textOf(p.content).text, images: 0 }, `${id}:${l.line}`, "agent");
      continue;
    }
    const assistant = p.type === "message" && p.role === "assistant";
    const call = p.type === "function_call" || p.type === "custom_tool_call";
    if (!assistant && !call) continue;
    if (!reply) {
      reply = { end: 0, endAt: at, texts: [], toolCalls: 0, from: total, answers: "unseen" };
    }
    reply.first ??= { ...l, at };
    reply.end = l.offset + l.length;
    reply.endAt = Math.max(reply.endAt, at);
    if (assistant) {
      const { text } = textOf(p.content);
      if (text !== "") reply.texts.push(text);
      if (model) models.set(model, (models.get(model) ?? 0) + 1);
    } else {
      reply.toolCalls++;
      toolCalls++;
    }
  }
  flush();
  if (turns.length === 0) return "rollouts with no turn, left out";
  const facts: SessionFacts = {
    account: "codex",
    ...(typeof meta.originator === "string" ? { originator: meta.originator } : {}),
    source: typeof source === "string" ? source : subagent ? "subagent" : "unknown",
    ...(parent ? { parent } : {}), ...(subagent ? { subagent: true } : {}), ...(gone ? { gone: true } : {}),
  };
  const last = buffer.lastIndexOf(0x0a) + 1;
  const sessionModel = mostOf(models) ?? model;
  return {
    origin: "codex",
    event: {
      kind: "llm-session", id, entrypoint: typeof meta.originator === "string" && meta.originator !== "" ? meta.originator : "codex", project: typeof meta.cwd === "string" && meta.cwd !== "" ? meta.cwd : "unknown", file,
      ...(typeof meta.cli_version === "string" ? { version: meta.cli_version } : {}), ...(sessionModel ? { model: sessionModel } : {}),
      startedAt, endedAt: Math.max(endedAt, startedAt), bytes: last,
    },
    turns,
    tokens: total,
    images,
    toolCalls,
    facts,
  };
}
