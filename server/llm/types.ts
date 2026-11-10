// What the warehouse's readers (claude.ts, codex.ts, grok.ts, pi.ts) give for one session file: the session and its
// turns as the event index keeps them (connectors/contract.ts's llm-session and llm-turn events), with their measures
// (tokens, cost, pictures, tool calls, where the tool records them) and the facts the tag rules read (rules.ts). Facts
// are what the tool's file says of a session or turn, or what its text was classified as (markers.ts): never a word of it.

import type { LlmSessionEvent, LlmTurnEvent } from "../connectors/contract.ts";
import type { Marker } from "./markers.ts";

/** Tokens, as a tool records them; input counts every token the model was given, cached or not. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The warehouse's name for itself in the index's sources (source.connector): what its sessions are known by. */
export const WAREHOUSE_CONNECTOR = "llm-warehouse";

/** The tools the warehouse reads, each its own origin in the index. */
export const WAREHOUSE_ORIGINS = ["claude-code", "codex", "grok-cli", "pi"] as const;
export type WarehouseOrigin = (typeof WAREHOUSE_ORIGINS)[number];

/** What a session's file says of it (none of its content). */
export interface SessionFacts {
  /** Which of the tool's homes it is in: claude (~/.claude), or a profile's name (second, z); the tool's own for the rest. */
  account?: string;
  /** Codex: the app that ran it (its originator: codex-tui, Codex Desktop, codex_exec, t3code_desktop, ...) and how (its source: cli, exec, vscode, subagent). */
  originator?: string;
  source?: string;
  /** A session another started: its parent's id, when the file says it. */
  parent?: string;
  /** A subagent's session (Claude Code's subagents/, Codex's thread_spawn, Grok's subagent kind). */
  subagent?: boolean;
  /** Grok CLI: its session_kind (headless) and agent. */
  kind?: string;
  agent?: string;
  /** Read from the warehouse's own copy (data/transcripts/), its tool having deleted it. */
  gone?: boolean;
}

/** What a turn's entry says of it, and what its text was classified as. */
export interface TurnFacts {
  /** How the tool says the prompt came: Claude Code's promptSource or turnOrigin (typed, queued, sdk, system, human), Codex's and Grok's own. */
  source?: string;
  marker?: Marker;
}

export interface WarehouseTurn extends LlmTurnEvent {
  tokens?: Tokens;
  facts?: TurnFacts;
}

export interface WarehouseSession {
  origin: WarehouseOrigin;
  event: Omit<LlmSessionEvent, "device">;
  turns: WarehouseTurn[];
  tokens?: Tokens;
  costUsd?: number;
  images: number;
  toolCalls: number;
  facts: SessionFacts;
}

/** Counts something left out or noticed, by a name that never quotes content. */
export type Tally = (name: string, n?: number) => void;

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** The key seen most often (the first of those seen as often), or undefined for none. */
export function mostOf(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  for (const [key, n] of counts) if (best === undefined || n > counts.get(best)!) best = key;
  return best;
}

export type JsonLine = { entry: Record<string, unknown>; line: number; offset: number; length: number };

/**
 * The whole lines of a buffer that are JSON objects, each with where it is, one at a time (a session file can be
 * hundreds of megabytes, its pictures in it, so no reader holds them all); a last line with no newline is being
 * written, and is left out.
 */
export function* eachJsonLine(buffer: Buffer): Generator<JsonLine> {
  let offset = 0;
  for (let line = 1; ; line++) {
    const end = buffer.indexOf(0x0a, offset);
    if (end === -1) return;
    let entry: unknown;
    try {
      entry = JSON.parse(buffer.toString("utf8", offset, end));
    } catch {
      entry = null; // Not a whole JSON entry: passed over.
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) yield { entry: entry as Record<string, unknown>, line, offset, length: end - offset };
    offset = end + 1;
  }
}

/** Every JSON line of a small file at once. */
export function jsonLines(buffer: Buffer): JsonLine[] {
  return [...eachJsonLine(buffer)];
}

/** An ISO time (or ms number) as ms since the epoch, or null. */
export function msOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}
