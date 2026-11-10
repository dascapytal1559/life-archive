// The trail of content reads (AGENTS.md's tier 2): every read of message text,
// search or an attachment's file through the CLI's timeline and search and the
// app's /api/archive/content/ routes, and of the text behind an event of the
// index (an LLM prompt, reply or session) through the CLI's event-content, and
// of a chat or an LLM session the viewer's drawer opens (server/viewer/content.ts),
// and of whatever an agent's content tool answers on the agents' door (server/mcp/),
// is kept in content_read, with where it came from (cli, app, viewer or mcp), who read it
// (LIFE_ARCHIVE_READER, or FRIEND_MAP_READER, its old name, which agents set to
// name themselves; on the agents' door, the agent its key is for; the app's page and the viewer are unnamed), what it
// read, and why, when the captain's words were given.
// `npm run archive -- content-log` shows it. The table is the core's, in the calendar's file (server/calendar/db.ts),
// since what is read may live in any module: the archive's own content_read table, which held it before, was copied
// into it once (archive/index.ts's copyTrail) and stays as it was.
//
// The same read again within FOLD_MS adds to its row rather than making
// another (a timeline read a page at a time, a chat's photos as they scroll
// in, a video seeking), so the trail says what was read, and how often,
// without a row per request. Nothing deletes from it.

import type { Db } from "./db.ts";

/** The environment variables an agent names itself in, for the trail: the first set wins (FRIEND_MAP_READER is the old name, from when the archive was friend-map's). */
export const READER_VARIABLES = ["LIFE_ARCHIVE_READER", "FRIEND_MAP_READER"] as const;

/** A read the same as one this recent adds to its row. */
export const FOLD_MS = 10 * 60_000;

/** What was read: a person, a chat, a day of one, search words, and how. Keys with no value are left out. */
export type ReadScope = Record<string, string | number | boolean | undefined>;

export interface ContentRead {
  surface: "cli" | "app" | "viewer" | "mcp";
  reader: string | null;
  /** The command, route or agents' tool: timeline, search, event-content, conversation, day, attachments, rituals_read. */
  what: string;
  scope: ReadScope;
  why?: string | null;
}

/** One row of the trail. */
export interface ContentReadRow extends Omit<ContentRead, "scope"> {
  id: number;
  at: number;
  lastAt: number;
  reads: number;
  scope: Record<string, string | number | boolean>;
  why: string | null;
}

export class ContentLog {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Keeps a read in the trail: a new row, or one more on the same read's row from within FOLD_MS. */
  record({ surface, reader, what, scope, why = null }: ContentRead, now = Date.now()): void {
    const scopeJson = JSON.stringify(scope);
    const same = this.db
      .prepare(
        `SELECT id FROM content_read
         WHERE surface = ? AND reader IS ? AND what = ? AND scope_json = ? AND why IS ? AND last_at >= ?
         ORDER BY last_at DESC LIMIT 1`,
      )
      .get(surface, reader, what, scopeJson, why, now - FOLD_MS) as { id: number } | undefined;
    if (same) this.db.prepare("UPDATE content_read SET last_at = ?, reads = reads + 1 WHERE id = ?").run(now, same.id);
    else {
      this.db
        .prepare("INSERT INTO content_read (at, last_at, surface, reader, what, scope_json, why) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(now, now, surface, reader, what, scopeJson, why);
    }
  }

  /** The trail, the latest read first. */
  list({ limit = 50 }: { limit?: number } = {}): ContentReadRow[] {
    const rows = this.db
      .prepare("SELECT id, at, last_at, reads, surface, reader, what, scope_json, why FROM content_read ORDER BY last_at DESC, id DESC LIMIT ?")
      .all(limit) as { id: number; at: number; last_at: number; reads: number; surface: ContentRead["surface"]; reader: string | null; what: string; scope_json: string; why: string | null }[];
    return rows.map(({ last_at, scope_json, ...row }) => ({ ...row, lastAt: last_at, scope: JSON.parse(scope_json) as ContentReadRow["scope"] }));
  }
}

/** Who is reading, as an agent named itself in LIFE_ARCHIVE_READER or FRIEND_MAP_READER; null when it did not. */
export function readerFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const variable of READER_VARIABLES) {
    const reader = env[variable]?.trim();
    if (reader) return reader;
  }
  return null;
}
