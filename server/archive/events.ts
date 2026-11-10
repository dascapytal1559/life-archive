// The life archive's event index (migration 47): one row in `event` for each thing that happened, by when (an
// instant, and its local day), what kind, whether the captain did it, on which device, from which import, and
// how big its content is, never the content itself; its detail is in a typed table (`detail`, `detail_id`). Every
// row is keyed on its source's own id (origin, native_id), so importing the same source again changes nothing, and
// one that has grown (a session still going on) brings its rows up to date. Read freely: the index is structure
// (AGENTS.md's tiers 0 and 1); what has content behind it (has_content) is read only through the content path
// (llmContent.ts).
//
// The first source is the captain's conversations with an LLM (the llm-sessions connector):
//   llm_session  a session: how it was run (subkind), where (llm_session.project), from its first entry to its last,
//                the size of its file
//   llm_prompt   a prompt the captain wrote: its length in characters
//   llm_reply    the reply he was given to what started its turn (subkind: human, his prompt, or a notification
//                such as task-notification): its length, from its first entry to its last
// llm_turn holds where each prompt and reply is in its session's file, and llm_session where that file is: the
// archive's copy of it (connectors/sessionCopies.ts), named relative to the archive's folder (llm/claude-code/...),
// so the folder can move; a file outside the folder (as sessions imported before the copies were) by its full path.
//
// The rituals were the second (kinds `ritual_checkin`, `ritual_habit`, `ritual_day` and `ritual_workouts`, the rituals
// connector's) until rituals became a module of its own (modules/rituals), which reads its own store and pushes its
// rows into the calendar itself; and workouts the third (kind `workout`, the polar connectors') until exercise became
// one (modules/exercise), with its own database. The archive's rows of both from before (and the `ritual_*` detail
// tables, the `workout` rows and the `deleted_workout` tombstones) stay as they were, read by nothing here, until the
// migrations drop them (archive/legacy.ts; docs/modules.md). Messages, calls and hangouts are not in the index.

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DeviceEvent, LlmSessionEvent, LlmTurnEvent } from "../connectors/contract.ts";
import { dayKey } from "../../src/time.ts";
import type { EventCounts } from "../connectors/counts.ts";
import type { Db } from "./db.ts";

export const EVENT_KINDS = ["llm_session", "llm_prompt", "llm_reply"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The kinds the index reads, as SQL: the rows of a kind that became a module's are left alone. */
const KINDS_SQL = EVENT_KINDS.map((kind) => `'${kind}'`).join(", ");


/** An event's own fields, as the index keeps them. */
interface EventFields {
  kind: EventKind;
  subkind: string | null;
  at: number;
  at_end: number | null;
  self: 0 | 1;
  direction: "in" | "out" | null;
  device_id: number | null;
  size: number | null;
  has_content: 0 | 1;
}

/** The typed tables an event's detail can be in, and their columns; names only from here, never from an event. */
const DETAIL_COLUMNS = {
  llm_session: ["project", "file", "version", "model"],
  llm_turn: ["session_id", "role", "reply_to", "model", "images", "tool_calls", "line", "byte_offset", "byte_length"],
} as const;
type DetailTable = keyof typeof DETAIL_COLUMNS;

/** Writes one import's events into the index, in the import's transaction (see write.ts). */
export class EventWriter {
  private readonly db: Db;
  private readonly origin: string;
  private readonly sourceId: number;
  private readonly counts: EventCounts;
  private readonly devices = new Map<string, number>();
  /** The archive's folder, which a session's file is kept relative to when it is inside it. */
  private readonly dataDir: string | undefined;
  /** The events this import added or changed, by id: what the calendar is pushed afresh (server/calendar/push.ts). */
  readonly touched = new Set<number>();

  constructor(db: Db, origin: string, sourceId: number, counts: EventCounts, dataDir?: string) {
    this.db = db;
    this.origin = origin;
    this.sourceId = sourceId;
    this.counts = counts;
    this.dataDir = dataDir;
  }

  /** A device, made the first time a source names it, its name and kind kept up to date. */
  device(event: DeviceEvent): void {
    this.db
      .prepare("INSERT INTO device (key, name, kind) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, kind = excluded.kind")
      .run(event.key, event.name, event.deviceKind);
    this.devices.set(event.key, (this.db.prepare("SELECT id FROM device WHERE key = ?").get(event.key) as { id: number }).id);
  }

  llmSession(event: LlmSessionEvent): void {
    this.upsert(event.id, {
      kind: "llm_session", subkind: event.entrypoint, at: event.startedAt, at_end: event.endedAt, self: 1, direction: null,
      device_id: event.device === undefined ? null : this.deviceId(event.device), size: event.bytes, has_content: 1,
    }, "llm_session", { project: event.project, file: storedSessionFile(event.file, this.dataDir), version: event.version ?? null, model: event.model ?? null });
  }

  llmTurn(event: LlmTurnEvent): void {
    const session = this.detailOf(event.session, "llm_session", "a session");
    const prompt = event.role === "prompt";
    // A turn a continued session repeats stays with the session that brought it first, whichever pass reads the other.
    const owner = this.db
      .prepare("SELECT t.session_id FROM event e JOIN llm_turn t ON t.id = e.detail_id WHERE e.origin = ? AND e.native_id = ? AND e.detail = 'llm_turn'")
      .get(this.origin, event.id) as { session_id: number } | undefined;
    if (owner && owner.session_id !== session.detail_id) {
      (this.counts[prompt ? "llm_prompt" : "llm_reply"] ??= { added: 0, updated: 0, unchanged: 0 }).unchanged++;
      return;
    }
    this.upsert(event.id, {
      kind: prompt ? "llm_prompt" : "llm_reply", subkind: prompt ? null : (event.answers ?? null), at: event.at,
      at_end: event.endAt ?? null, self: prompt ? 1 : 0, direction: prompt ? "out" : "in", device_id: session.device_id,
      size: event.chars, has_content: 1,
    }, "llm_turn", {
      session_id: session.detail_id, role: event.role,
      reply_to: event.replyTo === undefined ? null : this.detailOf(event.replyTo, "llm_prompt", "a prompt").detail_id,
      model: event.model ?? null, images: event.images ?? 0, tool_calls: event.toolCalls ?? 0, line: event.line,
      byte_offset: event.offset, byte_length: event.length,
    });
  }

  /**
   * Adds an event and its detail row, or brings both up to date: an event already there with the same values is
   * unchanged; one whose values differ takes the new ones, and this import as the last to touch it.
   */
  private upsert(nativeId: string, fields: EventFields, table: DetailTable, detail: Record<string, string | number | null>): void {
    const counts = (this.counts[fields.kind] ??= { added: 0, updated: 0, unchanged: 0 });
    const day = dayKey(fields.at);
    const existing = this.db
      .prepare("SELECT id, kind, detail, detail_id, subkind, at, at_end, day, self, direction, device_id, size, has_content FROM event WHERE origin = ? AND native_id = ?")
      .get(this.origin, nativeId) as (EventFields & { id: number; detail: string; detail_id: number; day: string }) | undefined;
    const columns = DETAIL_COLUMNS[table];
    if (!existing) {
      const detailId = Number(this.db
        .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => detail[column])).lastInsertRowid);
      const added = this.db
        .prepare(
          `INSERT INTO event (origin, native_id, kind, subkind, at, at_end, day, self, direction, detail, detail_id, device_id, size,
             has_content, first_source_id, last_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.origin, nativeId, fields.kind, fields.subkind, fields.at, fields.at_end, day, fields.self, fields.direction, table, detailId,
          fields.device_id, fields.size, fields.has_content, this.sourceId, this.sourceId,
        );
      this.touched.add(Number(added.lastInsertRowid));
      counts.added++;
      return;
    }
    // The same id for another kind of thing is a connector's mistake, not an update.
    if (existing.kind !== fields.kind || existing.detail !== table) {
      throw new Error(`a ${fields.kind} event has the id of a ${existing.kind} already in the index`);
    }
    const current = this.db.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE id = ?`).get(existing.detail_id) as Record<string, unknown>;
    const detailChanged = columns.some((column) => current[column] !== detail[column]);
    const eventChanged = existing.day !== day || (Object.keys(fields) as Array<keyof EventFields>).some((key) => existing[key] !== fields[key]);
    if (!detailChanged && !eventChanged) {
      counts.unchanged++;
      return;
    }
    if (detailChanged) {
      this.db
        .prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...columns.map((column) => detail[column]), existing.detail_id);
    }
    this.db
      .prepare(
        `UPDATE event SET subkind = ?, at = ?, at_end = ?, day = ?, self = ?, direction = ?, device_id = ?, size = ?, has_content = ?,
           last_source_id = ? WHERE id = ?`,
      )
      .run(fields.subkind, fields.at, fields.at_end, day, fields.self, fields.direction, fields.device_id, fields.size, fields.has_content, this.sourceId, existing.id);
    this.touched.add(existing.id);
    counts.updated++;
  }

  /** The detail row and device of an event this origin has given (in this import or before), by its id. */
  private detailOf(nativeId: string, kind: EventKind, what: string): { detail_id: number; device_id: number | null } {
    const row = this.db.prepare("SELECT detail_id, device_id FROM event WHERE origin = ? AND native_id = ? AND kind = ?").get(this.origin, nativeId, kind) as
      { detail_id: number; device_id: number | null } | undefined;
    // An id can be anything, so the error names only what kind of thing is missing.
    if (!row) throw new EventOrderError(`an event refers to ${what} that no earlier event announced`);
    return row;
  }

  private deviceId(key: string): number {
    const id = this.devices.get(key) ?? (this.db.prepare("SELECT id FROM device WHERE key = ?").get(key) as { id: number } | undefined)?.id;
    if (id === undefined) throw new EventOrderError("an event refers to a device that no earlier event announced");
    return id;
  }
}

/** A problem with how a connector's events refer to each other, such as a message in a conversation, or a turn in a session, never announced. */
export class EventOrderError extends Error {}

/** One event of the index, with its detail as far as the index has it: never its content. */
export interface EventRow {
  id: number;
  origin: string;
  /** The source's own id for it. */
  nativeId: string;
  kind: string;
  subkind: string | null;
  at: number;
  atEnd: number | null;
  day: string;
  self: boolean;
  direction: "in" | "out" | null;
  /** How big its content is: characters of text, or bytes of a file (a session's). */
  size: number | null;
  hasContent: boolean;
  device: string | null;
  /** An LLM's events: the session's event and where it ran; a turn's model, pictures, tools and the prompt a reply answers. */
  llm: {
    session: number;
    project: string;
    model: string | null;
    /** A session's prompts and replies. */
    prompts?: number;
    replies?: number;
    images?: number;
    toolCalls?: number;
    /** A reply to a prompt: the prompt's event. */
    replyTo?: number | null;
  } | null;
}

/** How many events of a kind one origin has, and the first and last day. */
export interface EventSummary {
  origin: string;
  kind: string;
  count: number;
  firstDay: string;
  lastDay: string;
}

/** Reads the index: structure only, so anything may read it. */
export class EventIndex {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Each origin's kinds, with how many and the first and last day. */
  summary(): EventSummary[] {
    return this.db
      .prepare(`SELECT origin, kind, count(*) AS count, min(day) AS firstDay, max(day) AS lastDay FROM event WHERE kind IN (${KINDS_SQL}) GROUP BY origin, kind ORDER BY origin, kind`)
      .all() as unknown as EventSummary[];
  }

  /** A local day's events (or one kind of them), in the order they happened. */
  day(day: string, { kind }: { kind?: string } = {}): EventRow[] {
    return this.rows(`e.day = ?${kind ? " AND e.kind = ?" : ""} ORDER BY e.at, e.id`, kind ? [day, kind] : [day]);
  }

  get(id: number): EventRow | null {
    return this.rows("e.id = ?", [id])[0] ?? null;
  }

  /** The events with these ids, by id; one there is none of is left out. */
  byIds(ids: readonly number[]): EventRow[] {
    if (ids.length === 0) return [];
    return this.rows("e.id IN (SELECT value FROM json_each(?)) ORDER BY e.id", [JSON.stringify(ids)]);
  }

  /** Every event of the index, by id (the calendar's rebuild reads them all: server/calendar/eventIndex.ts). */
  all(): EventRow[] {
    return this.rows("1 = 1 ORDER BY e.id", []);
  }

  private rows(where: string, params: Array<string | number>): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.origin, e.native_id, e.kind, e.subkind, e.at, e.at_end, e.day, e.self, e.direction, e.size, e.has_content, d.name AS device,
           s.id AS session_id, se.id AS session_event, s.project, coalesce(t.model, s.model) AS model, t.images, t.tool_calls, pe.id AS reply_to,
           CASE WHEN e.kind = 'llm_session' THEN (SELECT count(*) FROM llm_turn WHERE session_id = s.id AND role = 'prompt') END AS prompts,
           CASE WHEN e.kind = 'llm_session' THEN (SELECT count(*) FROM llm_turn WHERE session_id = s.id AND role = 'reply') END AS replies
         FROM event e
         LEFT JOIN device d ON d.id = e.device_id
         LEFT JOIN llm_turn t ON e.detail = 'llm_turn' AND t.id = e.detail_id
         LEFT JOIN llm_session s ON s.id = CASE e.detail WHEN 'llm_session' THEN e.detail_id ELSE t.session_id END
         LEFT JOIN event se ON se.detail = 'llm_session' AND se.detail_id = s.id
         LEFT JOIN event pe ON pe.detail = 'llm_turn' AND pe.detail_id = t.reply_to
         WHERE e.kind IN (${KINDS_SQL}) AND ${where}`,
      )
      .all(...params) as Array<{
        id: number; origin: string; native_id: string; kind: string; subkind: string | null; at: number; at_end: number | null; day: string; self: number;
        direction: "in" | "out" | null; size: number | null; has_content: number; device: string | null; session_id: number | null;
        session_event: number | null; project: string | null; model: string | null; images: number | null; tool_calls: number | null;
        reply_to: number | null; prompts: number | null; replies: number | null;
      }>;
    return rows.map((row) => ({
      id: row.id, origin: row.origin, nativeId: row.native_id, kind: row.kind, subkind: row.subkind, at: row.at, atEnd: row.at_end, day: row.day,
      self: row.self === 1, direction: row.direction, size: row.size, hasContent: row.has_content === 1, device: row.device,
      llm: row.session_id === null ? null : {
        session: row.session_event!, project: row.project!, model: row.model,
        ...(row.kind === "llm_session"
          ? { prompts: row.prompts!, replies: row.replies! }
          : { images: row.images!, toolCalls: row.tool_calls!, ...(row.kind === "llm_reply" ? { replyTo: row.reply_to } : {}) }),
      },
    }));
  }
}

/** How llm_session.file keeps a session's file: relative to the archive's folder when inside it, else its full path. */
export function storedSessionFile(file: string, dataDir: string | undefined): string {
  if (!dataDir) return file;
  const inside = relative(resolve(dataDir), resolve(file));
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : file;
}

/** Where llm_session.file's file is, as storedSessionFile kept it. */
export function sessionFileAt(stored: string, dataDir: string): string {
  return isAbsolute(stored) ? stored : join(dataDir, stored);
}
