// The core's own database: core.sqlite in the archive's folder, what the life archive itself keeps beside its modules'
// databases (the captain: "we can honestly fold LLM sessions like directly into Life Archive"). It holds:
//
//   source, connector_state   the runs and cursors of the core's own connectors (llm-sessions, grok-bot), as a module's
//                             database holds its own connectors' (connectors/host.ts's ledgers)
//   device, event,            the event index (events.ts): the conversations with agents, sessions, prompts and
//   llm_session, llm_turn     replies, each event's detail in its typed table, never a word of their content (that stays
//                             in the session files, llmContent.ts)
//   inspiration...            the captain's inspirations as they were until 8 November 2026, when they became the
//   changeset, change_row     inspirations module (modules/inspirations/), with their change log, which logged nothing
//                             else: the module's database took them over once (its server/db.ts), and these are kept,
//                             read by nothing, until their owner says they may go (they may hold the only copy). Their
//                             schema stays in these migrations, which have shipped.
//   mcp_key, mcp_call         the agents' door (server/mcp/): each agent's key, hashed, with its grants, and every tool
//                             call an agent made, by whom and when (what the transcript warehouse tags agents' calls by)
//   meta                      what the core keeps of itself (the time zone its days are in, as every store here holds one,
//                             and the ready pages' mark, READY_MARKS_KEY)
//   llm_tag, llm_file         the LLM warehouse's tags on sessions and turns, and its bookmarks (server/llm/)
//   table_edit                the record of the tables' edits (server/edits/): every change made to a row of a table
//                             through its owner, and every row of the captain's own added or deleted, each undoable;
//                             what a note said is never in it
//
// The people, their chats, calls and hangouts are the friend map module's (modules/friend-map/, its archive.sqlite):
// nothing here names a person. Until the friend map step, these tables were the archive's own, in archive.sqlite;
// `npm run archive -- migrate friend-map-module` copies them in from there once, ids kept, so a session's calendar row
// and an inspiration's address go on unchanged (migrate.ts), the inspirations' for their module to take over after.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TIME_ZONE } from "../../src/time.ts";
import { getMeta, schemaVersion, setMeta, transaction, type Db } from "./db.ts";

/**
 * The inspirations' tables as this database keeps them from before they were a module (see the top), in the order a
 * copy fills them (references first): what the friend map step's move still copies in from an archive that had them,
 * for the inspirations module to take over from here.
 */
export const OLD_INSPIRATION_TABLES = [
  "inspiration", "inspiration_tag", "inspiration_item_tag", "inspiration_ai_tag", "inspiration_file", "inspiration_save", "inspiration_fetch",
] as const;

/** Of those, the ones a changeset could change: a changeset of the archive's that changed these alone was the inspirations'. */
export const OLD_INSPIRATION_LOGGED = ["inspiration", "inspiration_tag", "inspiration_item_tag"] as const;

/** The core's database's file, in the archive's folder. */
export const CORE_FILE = "core.sqlite";

/** Where the friend map step's move builds the core's database, renamed CORE_FILE once the move is done (migrate.ts). */
export const CORE_PARTIAL = `${CORE_FILE}.partial`;

/** The meta key that says code knowing the ready pages (src/pages.ts) has opened this database: one without it is older (readyPagesUpgrade.ts). */
export const READY_MARKS_KEY = "ready_marks";

/** The tables the core's database keeps that were the archive's, in the order a copy fills them (references first). */
export const CORE_TABLES = ["device", "llm_session", "llm_turn", "event", ...OLD_INSPIRATION_TABLES] as const;

/** Each entry moves the schema one version forward; never edit one that has shipped, add a new one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE changeset (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      surface TEXT NOT NULL CHECK (surface IN ('cli', 'app')),
      action TEXT NOT NULL,                    -- what was done, in a few words ("tag an inspiration")
      description TEXT,                        -- the captain's words, when an agent passed them
      backup TEXT,                             -- the backup taken just before (the CLI's), by file name
      summary_json TEXT NOT NULL,              -- what it changed, for showing
      undoes INTEGER,                          -- the changeset this one undid
      undone_by INTEGER                        -- the changeset that undid this one
    );
  CREATE INDEX changeset_at ON changeset(at);
  CREATE TABLE change_row (
      id INTEGER PRIMARY KEY,
      changeset_id INTEGER NOT NULL REFERENCES changeset(id) ON DELETE CASCADE,
      tbl TEXT NOT NULL,                       -- inspiration, inspiration_tag, inspiration_item_tag
      row_key TEXT NOT NULL,                   -- the row's key, as a JSON array
      before_json TEXT,                        -- the row before; NULL when the changeset added it
      after_json TEXT                          -- the row after; NULL when the changeset deleted it
    );
  CREATE INDEX change_row_changeset ON change_row(changeset_id);
  CREATE TABLE connector_state (
      connector TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'error')),
      last_run_at INTEGER,
      last_ok_at INTEGER,
      last_error TEXT,
      last_error_at INTEGER,
      failures INTEGER NOT NULL DEFAULT 0,       -- consecutive failed runs
      retry_after INTEGER,                       -- backoff: no automatic run before this time
      cursor_json TEXT
    );
  CREATE TABLE device (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,                  -- the connector's name for it, the same every import: computer:<host name>
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('computer', 'phone', 'other'))
    );
  CREATE TABLE event (
      id INTEGER PRIMARY KEY,
      origin TEXT NOT NULL,                      -- where it comes from: a chat platform, or claude-code
      native_id TEXT NOT NULL,                   -- the source's own id for it, the same every import
      kind TEXT NOT NULL,                        -- llm_session, llm_prompt, llm_reply (events.ts EVENT_KINDS)
      subkind TEXT,                              -- a session: how it was run; a reply: what started its turn
      at INTEGER NOT NULL,                       -- when, ms since the epoch
      at_end INTEGER CHECK (at_end >= at),       -- when it ended, for what lasts
      day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- the local date of at
      self INTEGER NOT NULL CHECK (self IN (0, 1)),       -- the captain did it
      direction TEXT CHECK (direction IN ('in', 'out')),
      detail TEXT NOT NULL,                      -- the typed table its detail is in, and its row there
      detail_id INTEGER NOT NULL,
      device_id INTEGER REFERENCES device(id),
      size INTEGER CHECK (size >= 0),            -- how big its content is, never the content: characters of text, bytes of a file
      has_content INTEGER NOT NULL CHECK (has_content IN (0, 1)),
      first_source_id INTEGER NOT NULL REFERENCES source(id),
      last_source_id INTEGER NOT NULL REFERENCES source(id),
      UNIQUE (origin, native_id),
      UNIQUE (detail, detail_id)
    );
  CREATE INDEX event_day ON event(day, at);
  CREATE INDEX event_kind_time ON event(kind, at);
  CREATE TABLE inspiration (
      id INTEGER PRIMARY KEY,
      link TEXT UNIQUE,                          -- canonical; NULL for a kept file with no link
      platform TEXT NOT NULL CHECK (platform <> ''),
      form TEXT NOT NULL CHECK (form IN ('post', 'reel', 'video', 'short', 'tweet', 'article', 'image', 'other')),
      title TEXT,
      author TEXT,
      description TEXT,
      image_url TEXT,
      caption TEXT NOT NULL DEFAULT '',          -- his words for it, written as a note is
      hidden_at INTEGER,                         -- hidden from the page, as the tag archive hides a person
      created_at INTEGER NOT NULL,
      edited_at INTEGER,                         -- when he last changed its caption, tags or hidden
      preview_state TEXT NOT NULL DEFAULT 'pending' CHECK (preview_state IN ('pending', 'done', 'none', 'failed')),
      ai_state TEXT NOT NULL DEFAULT 'pending' CHECK (ai_state IN ('pending', 'done', 'failed')),
      ai_model TEXT,
      ai_at INTEGER,
      ai_error TEXT,
      ai_tries INTEGER NOT NULL DEFAULT 0,
      ai_retry_at INTEGER NOT NULL DEFAULT 0     -- not asked again before this, after a failed try
    , preview_tries INTEGER NOT NULL DEFAULT 0, preview_retry_at INTEGER NOT NULL DEFAULT 0, preview_note TEXT, probe_requested_at INTEGER, probe_result TEXT, probe_result_at INTEGER);
  CREATE INDEX inspiration_created ON inspiration(created_at);
  CREATE INDEX inspiration_queue ON inspiration(preview_state, ai_state);
  CREATE TABLE inspiration_ai_tag (
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rank INTEGER NOT NULL,
      PRIMARY KEY (inspiration_id, name)
    );
  CREATE INDEX inspiration_ai_tag_name ON inspiration_ai_tag(name);
  CREATE TABLE inspiration_fetch (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      inspiration_id INTEGER REFERENCES inspiration(id) ON DELETE SET NULL,
      at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('found', 'empty', 'blocked', 'failed')),
      note TEXT,
      next_at INTEGER NOT NULL                   -- the platform's next fetch not before this
    );
  CREATE INDEX inspiration_fetch_at ON inspiration_fetch(platform, at);
  CREATE TABLE inspiration_file (
      id INTEGER PRIMARY KEY,
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('item', 'preview')),
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      UNIQUE (inspiration_id, sha256)
    );
  CREATE INDEX inspiration_file_sha ON inspiration_file(sha256);
  CREATE TABLE inspiration_item_tag (
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES inspiration_tag(id),
      added_at INTEGER NOT NULL,
      PRIMARY KEY (inspiration_id, tag_id)
    );
  CREATE INDEX inspiration_item_tag_tag ON inspiration_item_tag(tag_id);
  CREATE TABLE inspiration_save (
      id INTEGER PRIMARY KEY,
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK (origin <> ''),
      native_id TEXT,
      link TEXT,
      caption TEXT NOT NULL DEFAULT '',
      saved_at INTEGER,
      UNIQUE (origin, native_id)
    );
  CREATE INDEX inspiration_save_item ON inspiration_save(inspiration_id);
  CREATE TABLE inspiration_tag (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  CREATE TABLE llm_session (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,                     -- the folder it ran in
      file TEXT NOT NULL,                        -- the session file, where its content stays
      version TEXT,                              -- the tool's version, as the session last wrote it
      model TEXT                                 -- the model most of its replies came from
    );
  CREATE TABLE llm_turn (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES llm_session(id),
      role TEXT NOT NULL CHECK (role IN ('prompt', 'reply')),
      reply_to INTEGER REFERENCES llm_turn(id),  -- a reply's prompt; empty for a reply to a notification
      model TEXT,                                -- the model that wrote the reply, or answered the prompt
      images INTEGER NOT NULL DEFAULT 0,         -- pictures in a prompt
      tool_calls INTEGER NOT NULL DEFAULT 0,     -- tools a reply used on its way
      line INTEGER NOT NULL CHECK (line >= 1),   -- its first line in the session file
      byte_offset INTEGER NOT NULL,              -- where its lines are in the file
      byte_length INTEGER NOT NULL
    );
  CREATE INDEX llm_turn_session ON llm_turn(session_id, byte_offset);
  CREATE TABLE source (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      connector TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('export', 'app-db', 'live')),
      label TEXT NOT NULL,                       -- the file or folder name
      content_sha256 TEXT,                       -- of an export file
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
      counts_json TEXT,
      error TEXT
    );
  `,
  // The agents' door (server/mcp/): each agent's key, kept as its hash alone, with what it may do; and every tool an
  // agent called, by whom and when, never what a content tool answered.
  `
  CREATE TABLE mcp_key (
      agent TEXT PRIMARY KEY CHECK (agent GLOB '[a-z0-9]*' AND agent NOT GLOB '*[^a-z0-9-]*' AND length(agent) <= 40),
      key_sha256 TEXT NOT NULL UNIQUE,           -- the key's SHA-256, hex; the key itself is printed once and kept nowhere
      grants_json TEXT NOT NULL CHECK (json_valid(grants_json) AND json_type(grants_json) = 'array'),  -- beyond facts: content, write, or either for one module (content:rituals)
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  CREATE TABLE mcp_call (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,                       -- when the call came, ms since the epoch
      agent TEXT NOT NULL,                       -- the key's agent (kept when its key is removed)
      tool TEXT NOT NULL,
      module TEXT NOT NULL,                      -- whose tool: core, rituals, exercise
      access TEXT NOT NULL CHECK (access IN ('facts', 'content', 'write')),
      ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
      error TEXT,                                -- why it failed, as the agent was told
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json))  -- a facts tool's arguments whole; another's with every text as its length
    );
  CREATE INDEX mcp_call_at ON mcp_call(at);
  CREATE INDEX mcp_call_agent_at ON mcp_call(agent, at);
  `,
  // The LLM warehouse (server/llm/): every session of every LLM tool on this Mac in the index, their measures, the
  // facts the tag rules read, the tags, and the warehouse's bookmarks. Never a word of content.
  `
  ALTER TABLE llm_session ADD COLUMN input_tokens INTEGER;      -- the tokens its replies were given, new and cached
  ALTER TABLE llm_session ADD COLUMN output_tokens INTEGER;     -- the tokens its replies wrote
  ALTER TABLE llm_session ADD COLUMN cache_read_tokens INTEGER; -- of input_tokens, read from the provider's cache
  ALTER TABLE llm_session ADD COLUMN cache_write_tokens INTEGER;-- of input_tokens, written to it
  ALTER TABLE llm_session ADD COLUMN cost_usd REAL;             -- what the tool says it cost, in US dollars
  ALTER TABLE llm_session ADD COLUMN images INTEGER;            -- pictures in its prompts
  ALTER TABLE llm_session ADD COLUMN tool_calls INTEGER;        -- tools its replies used
  ALTER TABLE llm_session ADD COLUMN facts TEXT CHECK (facts IS NULL OR (json_valid(facts) AND json_type(facts) = 'object'));
  ALTER TABLE llm_turn ADD COLUMN input_tokens INTEGER;
  ALTER TABLE llm_turn ADD COLUMN output_tokens INTEGER;
  ALTER TABLE llm_turn ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE llm_turn ADD COLUMN cache_write_tokens INTEGER;
  ALTER TABLE llm_turn ADD COLUMN facts TEXT CHECK (facts IS NULL OR (json_valid(facts) AND json_type(facts) = 'object'));
  CREATE TABLE llm_tag (
      id INTEGER PRIMARY KEY,
      target TEXT NOT NULL CHECK (target IN ('session', 'turn')),
      target_id INTEGER NOT NULL,                -- llm_session.id or llm_turn.id
      family TEXT NOT NULL,                      -- who, device, channel, tool, app, session, task, project
      value TEXT NOT NULL CHECK (value <> ''),
      rule TEXT NOT NULL,                        -- the rule that gave it (server/llm/rules.ts), or 'hand'
      guess INTEGER NOT NULL CHECK (guess IN (0, 1)),
      chosen INTEGER NOT NULL DEFAULT 0 CHECK (chosen IN (0, 1)),  -- the family's one value the views read
      note TEXT,                                 -- a hand tag: the captain's words for it
      at INTEGER NOT NULL,
      UNIQUE (target, target_id, family, value, rule)
    );
  CREATE INDEX llm_tag_target ON llm_tag(target, target_id, family);
  CREATE INDEX llm_tag_chosen ON llm_tag(family, value, target) WHERE chosen = 1;
  CREATE TABLE llm_file (
      path TEXT PRIMARY KEY,                     -- a session file the warehouse read, absolute
      origin TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      session TEXT,                              -- the session read from it (its native id), or NULL
      outcome TEXT NOT NULL,                     -- indexed, measured (a connector's session) or why it was left out
      read_at INTEGER NOT NULL
    );
  `,
  // The record of the tables' edits (server/edits/log.ts): every change the captain made to a row of a table, through
  // its owner, with what it was and became (a note's never, which is content and stays with its owner; people by the
  // owner's ids, named as the record is read, so nothing here names a person), and the owner's own receipt for it,
  // what its undo is given.
  `
  CREATE TABLE table_edit (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      surface TEXT NOT NULL CHECK (surface IN ('app', 'cli')),
      who TEXT,                                  -- who, as $LIFE_ARCHIVE_READER named them on the CLI; null from the page
      kind TEXT NOT NULL,                        -- the table: workouts, calls, hangouts, habits, ritual-days
      module TEXT NOT NULL,                      -- the table's owner, which made the edit
      origin TEXT NOT NULL,                      -- the row, as the calendar keys it
      native_id TEXT NOT NULL,
      row_kind TEXT NOT NULL,                    -- the row's kind in the calendar: workout, call, hangout, ritual_habit, ritual_day
      field TEXT NOT NULL,                       -- the field, as the table's edits name it
      before_json TEXT NOT NULL CHECK (json_valid(before_json)),  -- what it was (viewer/editWire.ts's EditValue); null for a note's words
      after_json TEXT NOT NULL CHECK (json_valid(after_json)),    -- what it became
      receipt TEXT NOT NULL CHECK (json_valid(receipt)),  -- the owner's record of it (friend map's changeset), for its undo
      undoes INTEGER REFERENCES table_edit(id),
      undone_by INTEGER REFERENCES table_edit(id)
    );
  CREATE INDEX table_edit_row ON table_edit(kind, module, origin, native_id);
  `,
  // A launch brief's turn kept the task its text named; a worker's task is now firstmate's own records' alone
  // (server/llm/rules.ts), so what was taken from the text goes, and the next retag takes the tags from the records.
  `
  UPDATE llm_turn SET facts = json_remove(facts, '$.task') WHERE facts IS NOT NULL AND json_type(facts, '$.task') IS NOT NULL;
  `,
  // A row of the captain's own added to a table, or deleted from it (a hangout, a call he logged), is an edit of the
  // record too: its action says which, its field is empty, and before and after are the row's fields by key (a note's
  // words never), null on the side where there was no row.
  `
  ALTER TABLE table_edit ADD COLUMN action TEXT NOT NULL DEFAULT 'edit' CHECK (action IN ('edit', 'add', 'delete'));
  `,
];

/** The schema version this code writes. */
export const CORE_SCHEMA_VERSION = MIGRATIONS.length;

/** Opens (creating if need be) the core's database at `file` and brings its schema up to date; it holds its days' zone as the archive did. */
export function openCore(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 10_000, enableForeignKeyConstraints: false });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const version = schemaVersion(db);
    if (version > MIGRATIONS.length) throw new Error(`the core's database is at schema version ${version}, newer than this code knows (${MIGRATIONS.length})`);
    for (let next = version; next < MIGRATIONS.length; next++) {
      transaction(db, () => {
        db.exec(MIGRATIONS[next]!);
        db.exec(`PRAGMA user_version = ${next + 1}`);
      });
    }
    db.exec("PRAGMA foreign_keys = ON");
    holdTimeZone(db);
    if (getMeta(db, READY_MARKS_KEY) === null) setMeta(db, READY_MARKS_KEY, "1");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The core's days (an event's day) are in one zone, kept from its first open; another refuses to open it, as the archive's did. */
function holdTimeZone(db: Db): void {
  const kept = getMeta(db, "time_zone");
  if (kept === null) return setMeta(db, "time_zone", TIME_ZONE);
  if (kept === TIME_ZONE) return;
  throw new Error(`the core's days are in ${kept}, but its settings say ${TIME_ZONE}: put "timeZone": "${kept}" back in settings.json, as nothing can move an archive to another zone yet`);
}
