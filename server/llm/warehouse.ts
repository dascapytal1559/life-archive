// The LLM warehouse's import (docs/events.md's "The LLM warehouse"): every session of every LLM tool on this Mac
// (sources.ts) read into the core's event index (archive/events.ts: an llm_session event for each, an llm_prompt or
// llm_reply for each turn, by the tool's origin: claude-code, codex, grok-cli, pi), with its measures and facts
// (llm_session and llm_turn's token, cost, picture and tool columns, and `facts`), then tagged (tags.ts). Never a word
// of content: a prompt's text is read only to classify it (markers.ts) and to count its length.
//
// The sessions the agents' connectors already keep (the llm-sessions connector's, the conversations in the projects it
// reads; and Grok Bot's) stay theirs: the warehouse adds only their measures and facts to their rows,
// and tags them, so a session is never in the index twice. A Claude Code session is the connector's when the connector
// would keep it (connectors/llm-sessions/read.ts's readSession, over a session at the top of one of its projects'
// folders in ~/.claude/projects).
//
// Resumable: each file read is bookmarked (llm_file: its size and modification time, and what came of it), in the
// same transaction as its events, BATCH files to a transaction; a file whose size and time are as bookmarked is not
// read again, so a pass cut short goes on where it stopped (`again` reads every file again), unless what came of it
// may change with no change to the file (RETRIED: it failed, it could not be read, or its session was not in the index
// to measure yet), which is read again every pass. The sessions are written
// as the files are read, so a session's file read again brings its rows up to date, as a connector's do. One pass at
// a time, in any process (its lock, data/backups/llm-warehouse/.lock). Written in Effect (docs/effect.md): each batch
// is one step that runs to its end, so a signal stops the pass between two batches.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Data, Effect } from "effect";
import { storedBytes } from "../archive/transcripts.ts";
import { transaction, type Db } from "../archive/db.ts";
import { EventWriter } from "../archive/events.ts";
import { projectFolder, readSession } from "../connectors/llm-sessions/read.ts";
import type { EventCounts } from "../connectors/counts.ts";
import { holdLock } from "../archive/nasBackup.ts";
import { readClaudeSession } from "./claude.ts";
import { type Classify, markerOf } from "./markers.ts";
import { readCodexSession } from "./codex.ts";
import { grokFiles, readGrokSession } from "./grok.ts";
import { readPiSession } from "./pi.ts";
import { sessionFiles, type SessionFile, type WarehouseSource } from "./sources.ts";
import { type Tally, type Tokens, WAREHOUSE_CONNECTOR, type WarehouseSession } from "./types.ts";

/** Files to a transaction. */
const BATCH = 25;

/** What came of a connector's session read before the connector indexed it: nothing measured, so read again. */
const NOT_MEASURED = "not measured yet (the connector has not indexed its session)";

/** The outcomes read again every pass, the file unchanged: a failure, a file that could not be read (a .zst caught mid-write, a permission), a session not measured yet. */
const RETRIED = /^(?:failed|could not be read|not measured yet)/;

export class WarehouseError extends Data.TaggedError("WarehouseError")<{ readonly message: string }> {}

export interface ImportOptions {
  db: Db;
  /** The archive's folder: its copies of transcripts (read only), and what a session's file is named relative to. */
  dataDir: string;
  sources: WarehouseSource[];
  /** The projects the llm-sessions connector reads (absolute), and its source, ~/.claude/projects: what it keeps stays its. */
  connector: { root: string; projects: string[] };
  again?: boolean;
  log?: (line: string) => void;
  now?: () => number;
  /** Where the pass holds its lock; the archive's data/backups/llm-warehouse unless said. */
  lockDir?: string;
  /** How a prompt's text is classified (markers.ts): the tools' own shapes unless said, an orchestrator's first where one is configured. */
  classify?: Classify;
}

export interface ImportResult {
  files: number;
  read: number;
  /** Files whose session the index now has from the warehouse, those whose session is a connector's (measured), and those left out, by why. */
  indexed: number;
  measured: number;
  leftOut: Record<string, number>;
  counts: EventCounts;
  tallies: Record<string, number>;
  ms: number;
}

/** One pass (see the top of this file). */
export const importWarehouse = (options: ImportOptions): Effect.Effect<ImportResult, WarehouseError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { db, dataDir, log = () => {}, now = Date.now, classify = markerOf } = options;
      yield* holdLock(options.lockDir ?? join(dataDir, "backups", "llm-warehouse"), "LLM warehouse import").pipe(Effect.mapError((e) => new WarehouseError({ message: e.message })));
      const started = now();
      const files = options.sources.flatMap((source) => sessionFiles(source, dataDir));
      const bookmarks = new Map((db.prepare("SELECT path, size, mtime_ms, outcome FROM llm_file").all() as Array<{ path: string; size: number; mtime_ms: number; outcome: string }>).map((b) => [b.path, b]));
      const todo = options.again ? files : files.filter((f) => {
        const b = bookmarks.get(f.path);
        return !b || b.size !== f.size || b.mtime_ms !== f.mtimeMs || RETRIED.test(b.outcome);
      });
      log(`${files.length} session files found, ${todo.length} to read${options.again ? " (every one again)" : ""}`);
      const result: ImportResult = { files: files.length, read: 0, indexed: 0, measured: 0, leftOut: {}, counts: {}, tallies: {}, ms: 0 };
      const tally: Tally = (name, n = 1) => {
        if (n > 0) result.tallies[name] = (result.tallies[name] ?? 0) + n;
      };
      const sourceId = Number(db.prepare(
        "INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('llm', ?, 'app-db', 'every LLM tool on this Mac', ?, 'running')",
      ).run(WAREHOUSE_CONNECTOR, started).lastInsertRowid);
      const writers = new Map<string, EventWriter>();
      const writerOf = (origin: string) => {
        let writer = writers.get(origin);
        if (!writer) {
          writer = new EventWriter(db, origin, sourceId, result.counts, dataDir);
          writer.device({ kind: "device", key: `computer:${hostname()}`, name: hostname().replace(/\.local$/, ""), deviceKind: "computer" });
          writers.set(origin, writer);
        }
        return writer;
      };
      const connectorFolders = new Map(options.connector.projects.map((project) => [join(options.connector.root, projectFolder(project)), project]));

      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        yield* Effect.uninterruptible(Effect.try({
          try: () => transaction(db, () => {
            for (const file of batch) {
              // Each file in a savepoint of its own: one that fails is said and bookmarked as failed (read again next
              // pass), and the rest of the batch goes on.
              let read: { outcome: string; session: string | null };
              try {
                read = transaction(db, () => readOne(file, { db, tally, writerOf, connectorFolders, classify }));
              } catch (error) {
                read = { outcome: `failed: ${(error as Error).message}`, session: null };
                log(`could not index ${file.path}: ${(error as Error).message}`);
              }
              const { outcome, session } = read;
              result.read++;
              if (outcome === "indexed") result.indexed++;
              else if (outcome === "measured") result.measured++;
              else result.leftOut[outcome] = (result.leftOut[outcome] ?? 0) + 1;
              db.prepare(
                `INSERT INTO llm_file (path, origin, size, mtime_ms, session, outcome, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (path) DO UPDATE SET origin = excluded.origin, size = excluded.size, mtime_ms = excluded.mtime_ms, session = excluded.session, outcome = excluded.outcome, read_at = excluded.read_at`,
              ).run(file.path, originOf(file.source), file.size, file.mtimeMs, session, outcome, now());
            }
          }),
          catch: (error) => new WarehouseError({ message: `reading ${batch[0]?.path ?? "a batch"} and the files after it: ${(error as Error).message}` }),
        }));
        if ((i / BATCH) % 20 === 0) log(`read ${Math.min(i + BATCH, todo.length)} of ${todo.length}`);
      }
      result.ms = now() - started;
      db.prepare("UPDATE source SET finished_at = ?, status = 'ok', counts_json = ? WHERE id = ?").run(now(), JSON.stringify({ events: result.counts, leftOut: result.leftOut, tallies: result.tallies }), sourceId);
      return result;
    }),
  );

const originOf = (source: WarehouseSource): string => ({ claude: "claude-code", codex: "codex", grok: "grok-cli", pi: "pi" })[source.kind];

/** A session file's bytes: the tool's, or the archive's copy when it is gone; a Codex .zst decompressed. */
function bytesOf(file: SessionFile): Buffer {
  if (file.stored) return storedBytes(file.stored);
  const raw = readFileSync(file.path);
  return file.path.endsWith(".zst") ? zstdDecompressSync(raw) : raw;
}

/** Reads one file and writes what it gives: "indexed", "measured" (a connector's session), or why it was left out; and the session's id. */
function readOne(
  file: SessionFile,
  { db, tally, writerOf, connectorFolders, classify }: { db: Db; tally: Tally; writerOf: (origin: string) => EventWriter; connectorFolders: Map<string, string>; classify: Classify },
): { outcome: string; session: string | null } {
  const gone = file.stored !== undefined;
  // The index names a gone session by the archive's copy (relative to its folder), else the tool's file.
  const named = file.stored ?? (file.source.kind === "grok" ? join(file.path, "chat_history.jsonl") : file.path);
  let session: WarehouseSession | string;
  let buffer: Buffer | null = null;
  try {
    if (file.source.kind === "grok") {
      session = readGrokSession(named, grokFiles(file.path), { tally, classify });
    } else {
      buffer = bytesOf(file);
      session = file.source.kind === "claude"
        ? readClaudeSession(named, buffer, { account: file.source.account, subagent: file.subagent, gone, tally, classify })
        : file.source.kind === "codex"
          ? readCodexSession(named, buffer, { gone, tally, classify })
          : readPiSession(named, buffer, { gone, tally, classify });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { outcome: `could not be read (${code ?? "unreadable"})`, session: null };
  }
  if (typeof session === "string") return { outcome: session, session: null };
  const id = session.event.id;

  // A Claude Code session the llm-sessions connector keeps: its measures and facts only.
  const connectorProject = file.source.kind === "claude" && !file.subagent ? connectorFolders.get(join(file.source.root, file.rel.split("/")[0])) : undefined;
  if (connectorProject !== undefined && buffer) {
    if (typeof readSession(file.path, buffer, connectorProject, () => {}) !== "string") {
      // Bookmarked as measured only once its row took the measures: before the connector indexes it, nothing does.
      if (measure(db, session) === 0) return { outcome: NOT_MEASURED, session: id };
      return { outcome: "measured", session: id };
    }
  }
  indexSession(db, writerOf(session.origin), session, `computer:${hostname()}`);
  return { outcome: "indexed", session: id };
}

/** Writes a session read by the warehouse into the index, by `writer` (its origin's, the device announced), with its measures and facts. */
export function indexSession(db: Db, writer: EventWriter, session: WarehouseSession, device: string): void {
  writer.llmSession({ ...session.event, device });
  for (const turn of session.turns) writer.llmTurn(turn);
  measure(db, session);
}

const tokenColumns = (tokens: Tokens | undefined) => (tokens ? [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite] : [null, null, null, null]);

/** Writes a session's and its turns' measures and facts onto their rows, found by origin and the tool's own ids; how many session rows took them (0 or 1). */
export function measure(db: Db, session: WarehouseSession): number {
  const updated = db.prepare(
    `UPDATE llm_session SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, images = ?, tool_calls = ?, facts = ?
     WHERE id = (SELECT detail_id FROM event WHERE origin = ? AND native_id = ? AND detail = 'llm_session')`,
  ).run(...tokenColumns(session.tokens), session.costUsd ?? null, session.images, session.toolCalls, JSON.stringify(session.facts), session.origin, session.event.id).changes;
  const turn = db.prepare(
    `UPDATE llm_turn SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, facts = ?
     WHERE id = (SELECT detail_id FROM event WHERE origin = ? AND native_id = ? AND detail = 'llm_turn')`,
  );
  for (const t of session.turns) turn.run(...tokenColumns(t.tokens), t.facts ? JSON.stringify(t.facts) : null, session.origin, t.id);
  return Number(updated);
}
