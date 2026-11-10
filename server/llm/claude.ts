// The warehouse's reader of Claude Code's session files, every account's (~/.claude/projects and each profile's
// ~/.claude-profiles/<name>/projects), every session in them, headless and subagents' included: the same lines the
// llm-sessions connector reads (connectors/llm-sessions/entries.ts says what is read of an entry), into the same turns,
// with each reply's tokens and the facts the tag rules read.
//
// A turn begins at a user entry that is not a tool's result, a meta note, a compaction summary or a subagent's line
// (in a session's own file): Claude Code says what started it in origin.kind (older) or turnOrigin and promptSource
// (newer: human, typed, queued, sdk; task_notification), and an entry that says neither is a prompt when it holds words.
// A background task's notice starts a turn that is no prompt: its reply answers "task-notification", as the
// connector's do. Every other turn start is a prompt, its text read once to classify it (markers.ts) and its length
// kept; a tool's own line (what a local command printed, an interruption) starts nothing. A reply is the model's
// entries after it, until the next turn: its first entry's id, the model that wrote most of them, how many tools it
// called, and its tokens, each message's usage counted once (Claude Code writes a message's blocks as entries of their
// own, each with the message's usage, the last the whole of it). The session's cost is Claude Code's own, its last
// cost-state entry's totalCostUSD.
//
// A subagent's file (<project folder>/<session id>/subagents/agent-<id>.jsonl) is a session of its own, its lines all
// the subagent's (isSidechain), its id <session id>/agent-<id> and its parent the session.

import { basename, dirname } from "node:path";
import { charsOf, type Entry, joinReply, promptText, SYNTHETIC_MODEL } from "../connectors/llm-sessions/entries.ts";
import { type Classify, markerOf, NOT_PROMPTS } from "./markers.ts";
import { addTokens, eachJsonLine, mostOf, msOf, NO_TOKENS, type SessionFacts, type Tally, type Tokens, type TurnFacts, type WarehouseSession, type WarehouseTurn } from "./types.ts";

/** What a user entry starts: a prompt (with how it came), a notice's turn, or nothing. */
export function turnStart(entry: Entry, { subagent = false } = {}): { start: "prompt" | "notice"; source?: string } | null {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null;
  if (entry.isSidechain === true && !subagent) return null;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown }>) : null;
  if (blocks?.some((b) => b?.type === "tool_result")) return null;
  const origin = (entry.origin as { kind?: unknown } | undefined)?.kind;
  const turnOrigin = entry.turnOrigin;
  if (origin === "task-notification" || turnOrigin === "task_notification") return { start: "notice", source: "task-notification" };
  const source = [entry.promptSource, turnOrigin, origin].find((v): v is string => typeof v === "string" && v !== "");
  if (source !== undefined) return { start: "prompt", source };
  if (typeof content === "string" || blocks?.some((b) => b?.type === "text" || b?.type === "image")) return { start: "prompt" };
  return null;
}

/** A message's usage as tokens: input counts the cached tokens too. */
function tokensOf(usage: unknown): Tokens | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  const cacheRead = n("cache_read_input_tokens");
  const cacheWrite = n("cache_creation_input_tokens");
  return { input: n("input_tokens") + cacheRead + cacheWrite, output: n("output_tokens"), cacheRead, cacheWrite };
}

interface Gathering {
  answers: string;
  prompt?: WarehouseTurn;
  first?: { id: string; line: number; offset: number; at: number };
  end: number;
  endAt: number;
  texts: string[];
  toolCalls: number;
  models: Map<string, number>;
  /** Each message's usage, by its id, the last seen (the whole of it). */
  usage: Map<string, Tokens>;
}

/**
 * One Claude Code session file (`file`, as the index names it; `buffer`, its bytes): its session and turns, or why it
 * is left out (a tally's name). `account` is the home it is in; `subagent`, a subagent's file.
 */
export function readClaudeSession(
  file: string,
  buffer: Buffer,
  { account, subagent = false, gone = false, tally, classify = markerOf }: { account: string; subagent?: boolean; gone?: boolean; tally: Tally; classify?: Classify },
): WarehouseSession | string {
  const bytes = buffer.lastIndexOf(0x0a) + 1;
  const text = (entry: Entry, key: string) => (typeof entry[key] === "string" && entry[key] !== "" ? (entry[key] as string) : undefined);
  const name = basename(file).replace(/\.jsonl(\.changed-\d+)?(\.zst)?$/, "");
  const parent = subagent ? basename(dirname(dirname(file))) : undefined;
  const id = parent ? `${parent}/${name}` : name;
  // Where it ran and how, from the first entry that says; its version, from the last.
  let project: string | undefined;
  let entrypoint: string | undefined;
  let version: string | undefined;

  const turns: WarehouseTurn[] = [];
  const models = new Map<string, number>();
  const sessionUsage = new Map<string, Tokens>();
  let startedAt = Infinity;
  let endedAt = -Infinity;
  let images = 0;
  let toolCalls = 0;
  let cost: number | undefined;
  let current: Gathering | null = null;
  const flush = () => {
    if (current?.first && current.texts.length + current.toolCalls > 0) {
      const model = mostOf(current.models);
      const tokens = [...current.usage.values()].reduce(addTokens, NO_TOKENS);
      turns.push({
        kind: "llm-turn", id: current.first.id, session: id, role: "reply", answers: current.answers,
        ...(current.prompt ? { replyTo: current.prompt.id } : {}),
        at: current.first.at, endAt: current.endAt, ...(model ? { model } : {}), chars: charsOf(joinReply(current.texts)),
        toolCalls: current.toolCalls, line: current.first.line, offset: current.first.offset, length: current.end - current.first.offset,
        ...(current.usage.size > 0 ? { tokens } : {}),
      });
      if (current.prompt && model) current.prompt.model = model;
    }
    current = null;
  };
  for (const { entry, line, offset, length } of eachJsonLine(buffer)) {
    project ??= text(entry, "cwd");
    entrypoint ??= text(entry, "entrypoint");
    version = text(entry, "version") ?? version;
    const at = msOf(entry.timestamp);
    if (at !== null) {
      startedAt = Math.min(startedAt, at);
      endedAt = Math.max(endedAt, at);
    }
    if (entry.type === "cost-state" && typeof entry.totalCostUSD === "number") cost = entry.totalCostUSD;
    const uuid = text(entry, "uuid");
    const start = turnStart(entry, { subagent });
    if (start) {
      if (uuid === undefined || at === null) {
        tally("entries with no id or time, passed over");
        continue;
      }
      if (start.start === "notice") {
        flush();
        current = { answers: "task-notification", end: 0, endAt: at, texts: [], toolCalls: 0, models: new Map(), usage: new Map() };
        continue;
      }
      const prompt = promptText(entry);
      const marker = classify(prompt.text);
      if (marker !== null && NOT_PROMPTS.has(marker)) {
        tally(`lines of the tool's own (${marker}), not prompts`);
        continue;
      }
      flush();
      if (marker === "task-notification") {
        current = { answers: "task-notification", end: 0, endAt: at, texts: [], toolCalls: 0, models: new Map(), usage: new Map() };
        continue;
      }
      const facts: TurnFacts = { ...(start.source ? { source: start.source } : {}), ...(marker ? { marker } : {}) };
      images += prompt.images;
      const turn: WarehouseTurn = { kind: "llm-turn", id: uuid, session: id, role: "prompt", at, chars: charsOf(prompt.text), images: prompt.images, line, offset, length, facts };
      turns.push(turn);
      current = { answers: "human", prompt: turn, end: 0, endAt: at, texts: [], toolCalls: 0, models: new Map(), usage: new Map() };
      continue;
    }
    if (entry.type !== "assistant" || (entry.isSidechain === true && !subagent)) continue;
    const message = entry.message as { id?: unknown; model?: unknown; content?: unknown; usage?: unknown } | undefined;
    const model = typeof message?.model === "string" ? message.model : null;
    if (model === SYNTHETIC_MODEL) continue;
    const usage = tokensOf(message?.usage);
    const messageId = typeof message?.id === "string" ? message.id : uuid;
    if (usage && messageId) sessionUsage.set(messageId, usage);
    if (!current || uuid === undefined || at === null) continue;
    const blocks = Array.isArray(message?.content) ? (message.content as Array<{ type?: unknown; text?: unknown }>) : [];
    current.first ??= { id: uuid, line, offset, at };
    current.end = offset + length;
    current.endAt = Math.max(current.endAt, at);
    current.texts.push(...blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string));
    const calls = blocks.filter((b) => b?.type === "tool_use").length;
    current.toolCalls += calls;
    toolCalls += calls;
    if (usage && messageId) current.usage.set(messageId, usage);
    if (model) {
      current.models.set(model, (current.models.get(model) ?? 0) + 1);
      models.set(model, (models.get(model) ?? 0) + 1);
    }
  }
  flush();
  if (project === undefined) return "sessions that do not say where they ran, left out";
  if (turns.length === 0) return "sessions with no turn, left out";

  const model = mostOf(models);
  const facts: SessionFacts = { account, ...(parent ? { parent, subagent: true } : {}), ...(gone ? { gone: true } : {}) };
  return {
    origin: "claude-code",
    event: {
      kind: "llm-session", id, entrypoint: entrypoint ?? (subagent ? "subagent" : "unknown"), project, file,
      ...(version ? { version } : {}), ...(model ? { model } : {}), startedAt, endedAt: Math.max(endedAt, startedAt), bytes,
    },
    turns,
    ...(sessionUsage.size > 0 ? { tokens: [...sessionUsage.values()].reduce(addTokens, NO_TOKENS) } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    images,
    toolCalls,
    facts,
  };
}
