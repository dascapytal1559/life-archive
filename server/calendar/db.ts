// The calendar database: calendar.sqlite in the archive's folder, the core's own small index of what happened, which
// the modules push into (sink.ts) and the Events page's tables and calendar read (server/viewer/), rather than asking each
// module live (the captain: "it's not even a choice. It's more like the illusion of choice if we want speed and
// performance"). One file, read-only to the page, fast, and empty-safe when a module is off. It holds:
//
//   event         one row for each thing that happened (a moment: a call, a hangout, a workout, a habit done, an agent
//                 session, prompt or reply) or for a day's summary (whom you messaged, how many messages, how a day's
//                 rituals went), keyed on the module that pushed it and the source's own id, so a push again changes
//                 nothing; never content, and never a name: the people on it are the owning module's ids, named at read
//                 time through the module's hook (owners.ts)
//   content_read  the trail of content reads (archive/contentLog.ts), the core's: every read of content through the
//                 CLI, the app's routes, the viewer and the agents' door (server/mcp/), wherever the content lives
//   meta          what the pushers keep (push.ts): when the calendar was built, and each module's watermark
//
// Its events are derived: the modules' own stores are the truth, and they can be rebuilt from them at any time (push.ts's
// rebuild, `npm run archive -- calendar rebuild`), which calendar.test.ts proves gives back what the pushes made. The
// trail is not: this file is the only place it is kept, so the NAS backup sends a checked copy of it. Opened
// beside the archive (archive/index.ts), in WAL mode, so the page's read-only connection never waits on a push.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transaction } from "../archive/db.ts";

export type CalendarDb = DatabaseSync;

/** The calendar's file, in the archive's folder. */
export const CALENDAR_FILE = "calendar.sqlite";

/** The shapes a row can have: a moment (a card at a time) or a day's summary (one row a day, with counts). */
export const SHAPES = ["moment", "day"] as const;

/** Each entry moves the schema one version forward; never edit one that has shipped, add a new one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE event (
    id INTEGER PRIMARY KEY,
    module TEXT NOT NULL,                      -- the module that pushed it and answers for it (owners.ts): friend-map, exercise, rituals, core
    origin TEXT NOT NULL,                      -- where it comes from: a chat platform, claude-code, grok-bot, rituals, polar, friend-map
    native_id TEXT NOT NULL,                   -- the source's own id for it, the same every push
    shape TEXT NOT NULL CHECK (shape IN ('moment', 'day')),
    kind TEXT NOT NULL,                        -- call, hangout, llm_session, llm_prompt, llm_reply, workout, ritual_habit; messaged, messages, ritual_day
    subkind TEXT,                              -- a call's app, a session's way of running, a workout's sport family, a habit's basis
    at INTEGER NOT NULL,                       -- when, ms since the epoch; a day summary's: when its day begins
    at_end INTEGER CHECK (at_end >= at),       -- when it ended, for what lasts
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- a moment: the local date of at; a summary: its day (the calendar's own)
    self INTEGER NOT NULL CHECK (self IN (0, 1)),       -- the captain did it
    direction TEXT CHECK (direction IN ('in', 'out')),
    size INTEGER CHECK (size >= 0),            -- how big its content is, never the content
    has_content INTEGER NOT NULL CHECK (has_content IN (0, 1)),
    people TEXT NOT NULL CHECK (json_valid(people) AND json_type(people) = 'array'),      -- the owning module's person ids, for its hook
    facts TEXT NOT NULL CHECK (json_valid(facts) AND json_type(facts) = 'object'),        -- a moment's metadata its tab reads beyond these columns: never a word of content
    summary TEXT CHECK (summary IS NULL OR (json_valid(summary) AND json_type(summary) = 'object')),  -- a day summary's counts
    UNIQUE (module, origin, native_id)
  );
  CREATE INDEX event_kind_at ON event(kind, at);
  CREATE INDEX event_shape_day ON event(shape, day);
  CREATE INDEX event_module_kind ON event(module, kind);

  CREATE TABLE content_read (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,                       -- the first read, ms since the epoch
    last_at INTEGER NOT NULL,                  -- the last read added to it
    reads INTEGER NOT NULL DEFAULT 1 CHECK (reads >= 1),
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'app', 'viewer')),
    reader TEXT,                               -- who, as $LIFE_ARCHIVE_READER named them; null when unnamed (the app's, the viewer's)
    what TEXT NOT NULL,                        -- the command or route: timeline, search, event-content, conversation, day or attachments
    scope_json TEXT NOT NULL,                  -- what it read: {"person":12}, {"conversation":41,"day":"2026-10-04"}, ...
    why TEXT                                   -- the captain's words for the job, when given
  );
  CREATE INDEX content_read_last_at ON content_read(last_at);

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // The agents' door (server/mcp/): a read of content through it is the trail's too, its surface 'mcp' and its reader
  // the agent whose key asked. SQLite cannot widen a CHECK in place, so the table is made again, every row and id kept.
  `
  CREATE TABLE content_read_new (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    reads INTEGER NOT NULL DEFAULT 1 CHECK (reads >= 1),
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'app', 'viewer', 'mcp')),
    reader TEXT,                               -- who: $LIFE_ARCHIVE_READER on the CLI, the key's agent on the agents' door
    what TEXT NOT NULL,                        -- the command, route or agents' tool
    scope_json TEXT NOT NULL,
    why TEXT
  );
  INSERT INTO content_read_new (id, at, last_at, reads, surface, reader, what, scope_json, why)
    SELECT id, at, last_at, reads, surface, reader, what, scope_json, why FROM content_read;
  DROP TABLE content_read;
  ALTER TABLE content_read_new RENAME TO content_read;
  CREATE INDEX content_read_last_at ON content_read(last_at);
  `,
];

/** The schema version this code writes. */
export const CALENDAR_SCHEMA_VERSION = MIGRATIONS.length;

/** Opens (creating if need be) the calendar at `file` and brings its schema up to date. */
export function openCalendar(file: string): CalendarDb {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 10_000 });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const version = calendarVersion(db);
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(`the calendar is at schema version ${version}, newer than this code knows (${MIGRATIONS.length})`);
  }
  for (let next = version; next < MIGRATIONS.length; next++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
  return db;
}

/** The schema version of the calendar open in `db`. */
export function calendarVersion(db: CalendarDb): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** A value kept in the calendar's meta table, or null when it has never been set. */
export function getCalendarMeta(db: CalendarDb, key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function setCalendarMeta(db: CalendarDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}
