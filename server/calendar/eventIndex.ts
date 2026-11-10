// The event index's rows of the calendar (rows.ts), pushed from the archive's index (archive/events.ts), and their
// owner's answers (owners.ts): the conversations with agents, the core's own (CORE: sessions, prompts and replies as
// moments, each with its session's name for the LLM tab's filter). The workouts are the exercise module's
// (modules/exercise): its `apply` answers its rows from its own database, and the host pushes them under its name; and
// the rituals (each habit done a moment, each day a summary) are the rituals module's (modules/rituals), pushed from
// its own store. The archive's rows of both from before they were modules are left alone here until the migrations
// drop them (archive/legacy.ts).
//
// push.ts pushes the events an import added or changed (and every event of their sessions: a session's characters and
// counts follow its turns, and a turn's project, session name and, with none of its own, model follow its session),
// and everything again to rebuild.

import type { DatabaseSync } from "node:sqlite";
import { dayKey, LOCALE } from "../../src/time.ts";
import { dateText, timeText } from "../../viewer/format.ts";
import type { Db } from "../archive/db.ts";
import type { EventIndex, EventRow } from "../archive/events.ts";
import { WAREHOUSE_CONNECTOR } from "../llm/types.ts";
import { dayOf, only } from "../viewer/tab.ts";
import type { EventOwner, OwnerDetail } from "./owners.ts";
import { CORE, type CalendarRow } from "./rows.ts";

/** The modules the index pushes to, in order. */
export const INDEX_MODULES: readonly string[] = [CORE];

/** A folder's last part: /home/sample/Projects/firstmate is firstmate. */
export function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) || path;
}

/** "firstmate · 2026-03-01": a session's name, its project folder's name and its day, as the LLM tab's filter lists it. */
export const sessionName = (project: string, at: number): string => `${folderName(project)} · ${dayKey(at)}`;

/** What a session's rows need of it: its own id, when it began and its project, and its turns' characters together (null with no turns). */
interface SessionFacts {
  nativeId: string;
  at: number;
  project: string;
  chars: number | null;
}

/** The sessions `ids` name (by their event ids), as their turns and their own rows need them. */
function sessionsOf(db: Db, ids: readonly number[]): Map<number, SessionFacts> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT se.id, se.native_id, se.at, s.project,
         (SELECT sum(te.size) FROM llm_turn st JOIN event te ON te.detail = 'llm_turn' AND te.detail_id = st.id WHERE st.session_id = s.id) AS chars
       FROM event se JOIN llm_session s ON se.detail = 'llm_session' AND s.id = se.detail_id
       WHERE se.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as Array<{ id: number; native_id: string; at: number; project: string; chars: number | null }>;
  return new Map(rows.map((row) => [row.id, { nativeId: row.native_id, at: row.at, project: row.project, chars: row.chars }]));
}

/**
 * The session events the LLM warehouse brought (server/llm/warehouse.ts): every other tool's sessions, the workers' and
 * the programs' among them, which the calendar leaves out, keeping the conversations the agents' connectors bring
 * (firstmate's own, Grok Bot's). The warehouse's own tables show them (the Prompts and Agent sessions tables).
 */
function warehouseSessions(db: Db): Set<number> {
  const rows = db
    .prepare(`SELECT e.id FROM event e JOIN source src ON src.id = e.first_source_id WHERE e.detail = 'llm_session' AND src.connector = ?`)
    .all(WAREHOUSE_CONNECTOR) as Array<{ id: number }>;
  return new Set(rows.map((row) => row.id));
}

/** `ids`, and every event of the sessions any of them is in: the session's own, and each of its turns'. */
function withTheirSessions(db: Db, ids: readonly number[]): number[] {
  const rows = db
    .prepare(
      `WITH touched(session) AS (
         SELECT CASE e.detail WHEN 'llm_session' THEN e.detail_id ELSE t.session_id END
         FROM event e LEFT JOIN llm_turn t ON e.detail = 'llm_turn' AND t.id = e.detail_id
         WHERE e.id IN (SELECT value FROM json_each(?)) AND e.detail IN ('llm_session', 'llm_turn'))
       SELECT e.id FROM touched JOIN event e ON e.detail = 'llm_session' AND e.detail_id = touched.session
       UNION
       SELECT e.id FROM touched JOIN llm_turn t ON t.session_id = touched.session JOIN event e ON e.detail = 'llm_turn' AND e.detail_id = t.id`,
    )
    .all(JSON.stringify(ids)) as Array<{ id: number }>;
  return [...new Set([...ids, ...rows.map((row) => row.id)])];
}

/**
 * The calendar rows of the index's events: every event when `ids` is left out, else those and the rest of their
 * sessions. An event of a kind the calendar does not hold (a check-in, a day of workouts) makes no row.
 */
export function indexRows(db: Db, index: EventIndex, ids?: readonly number[]): CalendarRow[] {
  const events = ids ? index.byIds(withTheirSessions(db, ids)) : index.all();
  const sessions = sessionsOf(db, [...new Set(events.flatMap((event) => (event.llm ? [event.llm.session] : [])))]);
  const warehoused = warehouseSessions(db);
  return events.flatMap((event) => {
    if (event.llm && warehoused.has(event.llm.session)) return [];
    const row = rowOf(event, sessions);
    return row ? [row] : [];
  });
}

const base = (event: EventRow, module: string): Omit<CalendarRow, "kind" | "shape" | "people" | "facts" | "summary"> => ({
  module,
  origin: event.origin,
  nativeId: event.nativeId,
  subkind: event.subkind,
  at: event.at,
  atEnd: event.atEnd,
  day: event.day,
  self: event.self,
  direction: event.direction,
  size: event.size,
  hasContent: event.hasContent,
});

/** One index event as a calendar row, or null for a kind the calendar does not hold. */
function rowOf(event: EventRow, sessions: Map<number, SessionFacts>): CalendarRow | null {
  switch (event.kind) {
    case "llm_session":
    case "llm_prompt":
    case "llm_reply": {
      const session = event.llm && sessions.get(event.llm.session);
      if (!event.llm || !session) return null;
      return {
        ...base(event, CORE), kind: event.kind, shape: "moment", people: [],
        facts: {
          project: event.llm.project, model: event.llm.model ?? "", session: session.nativeId, session_name: sessionName(session.project, session.at),
          chars: event.kind === "llm_session" ? session.chars : event.size,
        },
        summary: null,
      };
    }
    default:
      return null;
  }
}

/** The index's event an owner's row stands for, by its origin and the source's own id. */
function eventIdOf(archive: DatabaseSync, origin: string, nativeId: string): number | null {
  return (archive.prepare("SELECT id FROM event WHERE origin = ? AND native_id = ?").get(origin, nativeId) as { id: number } | undefined)?.id ?? null;
}

/** Each LLM event's session: its own for a session, its turn's for a prompt or reply, with the session's own id for the LLM tab's filter. */
const LLM_DETAIL = `
  SELECT e.id, e.at, e.at_end, e.kind, e.origin AS app, se.native_id AS session, s.project, s.file, s.version, t.images, t.tool_calls,
    CASE WHEN e.kind = 'llm_session' THEN (SELECT count(*) FROM llm_turn st WHERE st.session_id = s.id AND st.role = 'prompt') END AS prompts,
    CASE WHEN e.kind = 'llm_session' THEN (SELECT count(*) FROM llm_turn st WHERE st.session_id = s.id AND st.role = 'reply') END AS replies,
    CASE e.kind WHEN 'llm_session' THEN e.size END AS bytes,
    dv.name AS device
  FROM event e
  LEFT JOIN llm_turn t ON e.detail = 'llm_turn' AND t.id = e.detail_id
  LEFT JOIN llm_session s ON s.id = CASE e.detail WHEN 'llm_session' THEN e.detail_id ELSE t.session_id END
  LEFT JOIN event se ON se.detail = 'llm_session' AND se.detail_id = s.id
  LEFT JOIN device dv ON dv.id = e.device_id
  WHERE e.kind IN ('llm_session', 'llm_prompt', 'llm_reply') AND e.id = ?`;

/** The apps the conversations with agents come from, by origin. */
export const LLM_APPS: Record<string, string> = { "claude-code": "Claude Code", "grok-bot": "Grok Bot", codex: "Codex", "grok-cli": "Grok CLI", pi: "Pi" };

/** The core's answers for the conversations with agents: nobody is in a session, and a drawer says where its words are, never what. */
export function coreOwner(archive: DatabaseSync): EventOwner {
  return {
    labelPeople: () => ({}),
    detail: (_kind, origin, nativeId): OwnerDetail | null => {
      const id = eventIdOf(archive, origin, nativeId);
      const raw = id === null ? undefined : (archive.prepare(LLM_DETAIL).get(id) as Record<string, string | number | null> | undefined);
      if (id === null || !raw) return null;
      const when = (ms: number) => new Date(ms);
      return {
        more: [
          { label: "App", kind: "text", value: LLM_APPS[String(raw.app)] ?? String(raw.app) },
          ...(raw.at_end === null ? [] : [{ label: "Ended", kind: "text" as const, value: endedText(when(Number(raw.at_end))) }]),
          ...(raw.kind === "llm_session"
            ? [
                { label: "Prompts", kind: "count" as const, value: raw.prompts },
                { label: "Replies", kind: "count" as const, value: raw.replies },
                { label: "Its file's size", kind: "text" as const, value: raw.bytes === null ? null : `${Number(raw.bytes).toLocaleString(LOCALE)} bytes` },
              ]
            : [{ label: raw.kind === "llm_prompt" ? "Pictures" : "Tools used", kind: "count" as const, value: raw.kind === "llm_prompt" ? raw.images : raw.tool_calls }]),
          { label: "Project folder", kind: "text", value: raw.project },
          { label: "Session file", kind: "text", value: raw.file },
          { label: "Tool version", kind: "text", value: raw.version },
          { label: "Device", kind: "text", value: raw.device },
        ],
        views: [
          ...(raw.session === null ? [] : [{ label: "This session", kind: "llm", filters: only({ choices: { session: [String(raw.session)] } }) }]),
          { label: "Messages that day", kind: "messages", filters: only(dayOf(Number(raw.at))) },
        ],
        content: id,
      };
    },
  };
}

/** "6 Mar 2026 9:30 am": when something ended, as a drawer says it. */
const endedText = (at: Date): string => `${dateText(at.getTime())} ${timeText(at.getTime())}`;
