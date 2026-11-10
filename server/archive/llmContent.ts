// The content path for the event index's LLM events (AGENTS.md's tier 2): the text of a prompt or a reply, or of a
// whole session, read back from the session file where the index says it is (llm_session.file, the archive's own
// copy in data/llm, and each turn's lines there, llm_turn), never from archive.sqlite, which holds none of it, nor
// from the agent's own store, which deletes its sessions. Its callers, the CLI's event-content and the viewer's
// conversation (server/viewer/content.ts, a page of a session's turns at a time, with each reply's tool calls), keep
// every read in the trail of content reads (contentLog.ts).
//
// Each origin reads its copies its own way (READERS): Claude Code's turns from their lines where the index says they
// are, Grok Bot's by reading the bot's chat again. What it reads must be what was imported: a Claude Code turn's
// first line must be the entry the index names, a Grok Bot turn must be in its chat, and each turn's text must be as
// long as the index says. A file that is not (gone, moved, or its lines no longer where they were) is refused,
// saying to import again, rather than read wrong. A copy is only ever added to (connectors/sessionCopies.ts), so a
// session that went on still reads.

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename } from "node:path";
import { logLines, sessionsOf } from "../connectors/grok-bot/entries.ts";
import { charsOf, type Entry, joinReply, promptText, replyParts, timeOf } from "../connectors/llm-sessions/entries.ts";
import type { Db } from "./db.ts";
import { sessionFileAt } from "./events.ts";
import { WAREHOUSE_CONNECTOR } from "../llm/types.ts";

export interface LlmTurnContent {
  /** The turn's event. */
  event: number;
  role: "prompt" | "reply";
  at: number;
  model: string | null;
  text: string;
  /** Pictures in a prompt, given by count only. */
  images: number;
  /** Asked for (LlmPage's parts): the turn in order, its words and each tool the model called, by name and what it was given. */
  parts?: LlmPart[];
}

/** A turn's words, or a tool call in a reply (its input as the tool's main argument, or JSON, cut at TOOL_INPUT_CHARS). */
export type LlmPart = { type: "text"; text: string } | { type: "tool"; name: string; input: string };

/** How much of a tool call's input a part keeps. */
export const TOOL_INPUT_CHARS = 2000;

/** Which of a session's turns to read (from `offset`, `limit` of them), and whether with their parts. */
export interface LlmPage {
  offset?: number;
  limit?: number;
  parts?: boolean;
}

/** What an LLM event's content is: its session, and its turn's text, or every turn's for a session. */
export interface LlmContent {
  event: number;
  kind: string;
  session: { event: number; project: string; file: string };
  /** How many turns the event has in all (a session's, or 1), of which `turns` are those from `offset`. */
  total: number;
  offset: number;
  turns: LlmTurnContent[];
}

/** The session file is not as it was imported. */
export class ContentMovedError extends Error {}

/**
 * The content behind an LLM event (llm_session, llm_prompt or llm_reply), or null when there is no such event;
 * `dataDir` is the archive's folder, which the index names a session's file relative to. A session's turns can be
 * read a page at a time (`page`): only those turns are read from its file.
 */
export function readLlmContent(db: Db, dataDir: string, eventId: number, page: LlmPage = {}): LlmContent | null {
  const event = db.prepare("SELECT id, origin, kind, detail, detail_id FROM event WHERE id = ?").get(eventId) as
    { id: number; origin: string; kind: string; detail: string; detail_id: number } | undefined;
  if (!event) return null;
  if (event.detail !== "llm_session" && event.detail !== "llm_turn") throw new Error(`event ${eventId} is a ${event.kind}: event-content reads an LLM's sessions, prompts and replies`);
  const sessionId = event.detail === "llm_session"
    ? event.detail_id
    : (db.prepare("SELECT session_id FROM llm_turn WHERE id = ?").get(event.detail_id) as { session_id: number }).session_id;
  const row = db
    .prepare("SELECT s.project, s.file, e.id AS event FROM llm_session s JOIN event e ON e.detail = 'llm_session' AND e.detail_id = s.id WHERE s.id = ?")
    .get(sessionId) as { project: string; file: string; event: number };
  const session = { ...row, file: sessionFileAt(row.file, dataDir) };
  const which = event.detail === "llm_session" ? "t.session_id = ?" : "t.id = ?";
  const key = event.detail === "llm_session" ? sessionId : event.detail_id;
  const total = (db.prepare(`SELECT count(*) AS n FROM llm_turn t WHERE ${which}`).get(key) as { n: number }).n;
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const turns = db
    .prepare(
      `SELECT e.id AS event, e.native_id, e.at, e.size, t.role, t.model, t.byte_offset, t.byte_length
       FROM llm_turn t JOIN event e ON e.detail = 'llm_turn' AND e.detail_id = t.id
       WHERE ${which} ORDER BY t.byte_offset LIMIT ? OFFSET ?`,
    )
    .all(key, page.limit === undefined ? -1 : Math.max(0, Math.floor(page.limit)), offset) as unknown as TurnRow[];

  const reader = READERS[event.origin];
  if (!reader) throw new Error(`event ${eventId} is from ${event.origin}, whose conversations the archive cannot read back`);
  const moved = new ContentMovedError(`${session.file} is not as it was imported: import it again (npm run archive -- import ${reader.connector})`);
  const texts = reader.read(session.file, turns, moved);
  return {
    event: event.id,
    kind: event.kind,
    session,
    total,
    offset,
    turns: turns.map((turn, i) => {
      const { text, images, parts } = texts[i];
      if (charsOf(text) !== turn.size) throw moved;
      return { event: turn.event, role: turn.role, at: turn.at, model: turn.model, text, images, ...(page.parts ? { parts: parts ?? [{ type: "text", text }] } : {}) };
    }),
  };
}

/**
 * The session event of an origin (claude-code, grok-bot) whose last turn is the latest, or of one way it was run
 * (`how`: cli, chat, call, backstage, ...), for picking up where an agent's conversation is; null when there is none.
 * The index alone: no content is read.
 */
export function latestLlmSession(db: Db, origin: string, how?: string): number | null {
  // A conversation the agents' connectors bring, never one the LLM warehouse does (a worker's, a program's call).
  const row = db
    .prepare(
      `SELECT id FROM event WHERE kind = 'llm_session' AND origin = ?${how === undefined ? "" : " AND subkind = ?"}
         AND first_source_id NOT IN (SELECT id FROM source WHERE connector = ?)
       ORDER BY coalesce(at_end, at) DESC, id DESC LIMIT 1`,
    )
    .get(...(how === undefined ? [origin] : [origin, how]), WAREHOUSE_CONNECTOR) as { id: number } | undefined;
  return row?.id ?? null;
}

/** A turn as the index has it: its event, and where it is in its session's copy. */
interface TurnRow {
  event: number;
  native_id: string;
  at: number;
  size: number;
  role: "prompt" | "reply";
  model: string | null;
  byte_offset: number;
  byte_length: number;
}

/**
 * How each origin's turns are read back from its copy: the text of each turn, in order, as its connector read it
 * (each checked against the index's length above), or `moved` thrown when the copy is not as it was imported.
 */
const READERS: Record<string, { connector: string; read(file: string, turns: TurnRow[], moved: Error): Array<{ text: string; images: number; parts?: LlmPart[] }> }> = {
  "claude-code": {
    connector: "llm-sessions",
    // Each turn's lines, where the index says they are: its first entry must be the one it names.
    read(file, turns, moved) {
      let fd: number;
      try {
        fd = openSync(file, "r");
      } catch {
        throw moved;
      }
      try {
        return turns.map((turn) => {
          const buffer = Buffer.alloc(turn.byte_length);
          if (readSync(fd, buffer, 0, turn.byte_length, turn.byte_offset) !== turn.byte_length) throw moved;
          let entries: Entry[];
          try {
            entries = buffer.toString("utf8").split("\n").map((line) => JSON.parse(line) as Entry);
          } catch {
            throw moved;
          }
          if (entries[0]?.uuid !== turn.native_id) throw moved;
          if (turn.role === "prompt") return promptText(entries[0]);
          // The model's entries, as the connector gathered them: those with an id and a time.
          const model = entries.filter((entry) => typeof entry.uuid === "string" && timeOf(entry) !== null && replyParts(entry) !== null);
          return { text: joinReply(model.flatMap((entry) => replyParts(entry)!.texts)), images: 0, parts: model.flatMap(partsOf) };
        });
      } finally {
        closeSync(fd);
      }
    },
  },
  "grok-bot": {
    connector: "grok-bot",
    // The bot's chat, read again from its log as the connector reads it, and each turn found by its id.
    read(file, turns, moved) {
      let content: Buffer;
      try {
        content = readFileSync(file);
      } catch {
        throw moved;
      }
      const sessions = sessionsOf(basename(file, ".jsonl"), logLines(content));
      if ("refused" in sessions) throw moved;
      const texts = new Map(sessions.flatMap((session) => session.turns.map((turn) => [turn.id, turn.text] as const)));
      return turns.map((turn) => {
        const text = texts.get(turn.native_id);
        if (text === undefined) throw moved;
        return { text, images: 0 };
      });
    },
  },
};

/** A model's entry as parts: its words and its tool calls, in order. */
function partsOf(entry: Entry): LlmPart[] {
  const blocks = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(blocks)) return [];
  return (blocks as Array<{ type?: unknown; text?: unknown; name?: unknown; input?: unknown }>).flatMap((block): LlmPart[] => {
    if (block?.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block?.type === "tool_use") return [{ type: "tool", name: typeof block.name === "string" ? block.name : "tool", input: toolInput(block.input) }];
    return [];
  });
}

/** The arguments that say what a call did, for the tools that have one (a command, a file, a search); else the JSON. */
const MAIN_ARGUMENTS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];

function toolInput(input: unknown): string {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const main = MAIN_ARGUMENTS.find((key) => typeof fields[key] === "string");
  const text = main ? (fields[main] as string) : JSON.stringify(input ?? null);
  return text.length > TOOL_INPUT_CHARS ? `${text.slice(0, TOOL_INPUT_CHARS)}…` : text;
}
