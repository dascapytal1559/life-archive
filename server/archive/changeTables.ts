// What the change log (changes.ts) logs: each logged table with its key and the columns kept, and the TEMP triggers that
// write a changed row into change_row while a changeset is being recorded (see the top of changes.ts), made on each
// connection for the logged tables its database has (the archive's people and chats; a part with a log of its own,
// a module's in its own database, gives its own tables: the inspirations', modules/inspirations/server/changeLog.ts).

import type { Db } from "./db.ts";

/** A logged row: its key's and kept columns' values. */
export type Row = Record<string, string | number | null>;

export interface TableSpec {
  key: readonly string[];
  columns: readonly string[];
  /** Columns an undo neither checks nor insists on: put back only when unchanged since. */
  loose: readonly string[];
  /** Only updates are logged (the table's rows are made and deleted by imports, never by an edit). */
  updateOnly?: boolean;
  /**
   * Never the captain's decision, nor the reason for a changeset: worked out again by the rules (proposals), or saved
   * outside any changeset (drafts). An undo puts its rows back where it can, and it never refuses one.
   */
  lenient?: boolean;
}

/** The tables a changeset logs, with each one's key and the columns kept. */
export const TABLES: Record<string, TableSpec> = {
  person: {
    key: ["id"],
    columns: ["name", "name_source", "aliases_json", "is_self", "edited_at", "created_at", "note", "address_book_note", "should_reach_out", "identicon_seed", "identicon_hue", "location"],
    loose: ["edited_at"],
  },
  tag: { key: ["id"], columns: ["name", "sort_order", "built_in", "created_at"], loose: [] },
  person_tag: { key: ["person_id", "tag_id"], columns: ["added_at"], loose: ["added_at"] },
  import_person: { key: ["id"], columns: ["person_id", "link_source", "linked_at"], loose: ["linked_at"], updateOnly: true },
  // A group chat dropped or brought back (People.dropGroup).
  conversation: { key: ["id"], columns: ["dropped_at"], loose: [], updateOnly: true },
  // Someone taken out of a group chat or put back (People.removeFromGroup).
  conversation_member: { key: ["conversation_id", "account_id"], columns: ["removed_at"], loose: [], updateOnly: true },
  // Someone unlinked from a group chat, or linked through it again (People.unlinkFromGroup).
  group_unlink: { key: ["person_id", "conversation_id"], columns: ["unlinked_at"], loose: ["unlinked_at"] },
  // A catch-up added, changed or deleted (People.addCatchUp), and who was at it.
  // Rows logged before migration 61 also say by_call (1 for one by call), which an undo never puts back (their summaries,
  // written when they were made, still say "by call").
  catch_up: { key: ["id"], columns: ["day", "time", "hours", "note", "others", "trip_last_day", "trip_end_time", "trip_private_from", "trip_private_to", "created_at"], loose: [] },
  catch_up_person: { key: ["catch_up_id", "person_id"], columns: [], loose: [] },
  // A call's length given or taken away (calls.ts, setCallLength).
  call_length: { key: ["message_id"], columns: ["seconds", "set_at"], loose: ["set_at"] },
  // A call the captain logged, changed or deleted (People.addCall): one row for each person on it.
  manual_call: { key: ["id"], columns: ["call_group", "person_id", "account_id", "at", "duration_seconds", "app", "note", "others", "created_at"], loose: [] },
  // A note given to an imported call, changed or taken away (calls.ts, setCallNote): a call record, or one in no chat.
  call_note: { key: ["id"], columns: ["message_id", "platform", "platform_call_id", "note", "set_at"], loose: ["set_at"] },
  // Whether an imported call was answered, as the captain says, set or set back (calls.ts, setCallAnswered).
  call_answered: { key: ["id"], columns: ["message_id", "platform", "platform_call_id", "answered", "set_at"], loose: ["set_at"] },
  // A draft moved by a merge or deleted with its person.
  draft: { key: ["id"], columns: ["person_id", "text", "created_at", "updated_at"], loose: ["updated_at"], lenient: true },
  merge_proposal: {
    key: ["id"],
    columns: ["left_key", "right_key", "rule", "tier", "evidence_json", "status", "created_at", "decided_at"],
    loose: [],
    lenient: true,
  },
};

/**
 * The change log's own two tables, for a module's database that keeps one (sdk/server.ts: the exercise module's, over
 * its corrections): the same as the archive's and the core's (coreDb.ts's first migration).
 */
export const CHANGE_LOG_TABLES = `
  CREATE TABLE changeset (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'app')),
    action TEXT NOT NULL,                      -- what was done, in a few words
    description TEXT,                          -- the captain's words, when an agent passed them
    backup TEXT,                               -- the backup taken just before (the CLI's), by file name
    summary_json TEXT NOT NULL,                -- what it changed, for showing
    undoes INTEGER,                            -- the changeset this one undid
    undone_by INTEGER                          -- the changeset that undid this one
  );
  CREATE INDEX changeset_at ON changeset(at);
  CREATE TABLE change_row (
    id INTEGER PRIMARY KEY,
    changeset_id INTEGER NOT NULL REFERENCES changeset(id) ON DELETE CASCADE,
    tbl TEXT NOT NULL,                         -- the logged table
    row_key TEXT NOT NULL,                     -- the row's key, as a JSON array
    before_json TEXT,                          -- the row before; NULL when the changeset added it
    after_json TEXT                            -- the row after; NULL when the changeset deleted it
  );
  CREATE INDEX change_row_changeset ON change_row(changeset_id);
`;

/**
 * The TEMP triggers that log rows while a changeset is recorded (see the top of this file), made once per connection;
 * the logged tables it has, of `specs` (TABLES, and a module's own: sdk/server.ts's Changes over its database).
 */
export function installTriggers(db: Db, specs: Readonly<Record<string, TableSpec>> = TABLES): ReadonlySet<string> {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS change_context (changeset_id INTEGER NOT NULL)");
  const has = new Set((db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name).filter((name) => name in specs));
  for (const [table, spec] of Object.entries(specs).filter(([table]) => has.has(table))) {
    const columns = [...spec.key, ...spec.columns];
    const row = (which: "OLD" | "NEW") => `json_object(${columns.map((c) => `'${c}', ${which}.${c}`).join(", ")})`;
    const key = (which: "OLD" | "NEW") => `json_array(${spec.key.map((c) => `${which}.${c}`).join(", ")})`;
    const log = (rowKey: string, before: string, after: string, when = "") =>
      `INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json)
       SELECT changeset_id, '${table}', ${rowKey}, ${before}, ${after} FROM temp.change_context${when ? ` WHERE ${when}` : ""};`;
    const bodies: Record<string, string> = {
      // An update that changes the key is the old row deleted and the new one added.
      UPDATE: `${log(key("OLD"), row("OLD"), `CASE WHEN ${key("OLD")} = ${key("NEW")} THEN ${row("NEW")} END`)}
        ${log(key("NEW"), "NULL", row("NEW"), `${key("OLD")} <> ${key("NEW")}`)}`,
    };
    if (!spec.updateOnly) {
      bodies.INSERT = log(key("NEW"), "NULL", row("NEW"));
      bodies.DELETE = log(key("OLD"), row("OLD"), "NULL");
    }
    for (const [event, body] of Object.entries(bodies)) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS change_log_${table}_${event.toLowerCase()} AFTER ${event} ON main.${table}
        WHEN EXISTS (SELECT 1 FROM temp.change_context) BEGIN ${body} END`);
    }
  }
  return has;
}
