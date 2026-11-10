// friend map's part of an import's dry run (the core's server/archive/dryRun.ts; `npm run archive -- import
// <connector> <source> --dry-run`): the copy, in memory, of what the archive keeps of the platform's records that the
// connector's events are applied to, so the counts are those the import would make, and the calls the import would add.
// The archive itself is only read: attached read-only (SQLite may make its -wal and -shm beside it, empty, as for any
// reader). The copy holds no content: a message's text and its original record are left out (no import looks at either
// to match a record). It copies what the connector host checks before an import, too (the phone export's chat keys,
// see messengerPhoneChats.ts: its members, messages and coverage), but for the original records its check of photos'
// ids needs, so a dry run is not refused for those. What it leaves out besides: reactions, so a dry run counts each of
// those as new.

import { callDuration, dayKey, readOnlyAddress, timeOfDay } from "../../../sdk/server.ts";
import { openArchive, SCHEMA_VERSION, schemaVersionOf, type Db } from "./db.ts";

/** Each table copied, and which of its rows: the platform's own, or those of a platform's rows in another table. */
const COPIED: Array<{ table: string; rows: string }> = [
  { table: "source", rows: "1" },
  { table: "import_person", rows: "platform = $platform" },
  { table: "conversation", rows: "platform = $platform" },
  { table: "conversation_member", rows: "conversation_id IN (SELECT id FROM real.conversation WHERE platform = $platform)" },
  { table: "message", rows: "platform = $platform" },
  { table: "message_alias", rows: "platform = $platform" },
  { table: "attachment", rows: "message_id IN (SELECT id FROM real.message WHERE platform = $platform)" },
  { table: "call", rows: "platform = $platform" },
  { table: "coverage_span", rows: "platform = $platform" },
];

/** Columns left out of the copy, each with what stands in for it. */
const LEFT_OUT: Record<string, Record<string, string>> = { message: { text: "NULL", raw_json: "'{}'" } };

/** A call the import would add: a call record, in a chat, or a call in no chat (`chat` null). */
export interface NewCall {
  at: number;
  seconds: number | null;
  outgoing: boolean;
  /** The chat's title, or for a one-to-one chat with no title its person's name, as the archive or the import has it. */
  chat: string | null;
}

/**
 * A copy in memory of what the archive in `file` keeps of `platform`'s records (none of its content), for a dry run
 * to apply an import to; the archive must be at this code's schema.
 */
export function dryRunCopy(file: string, folder: string, platform: string): Db {
  const version = schemaVersionOf(file);
  if (version !== SCHEMA_VERSION) {
    throw new Error(`the archive is at schema ${version} and this code at ${SCHEMA_VERSION}; bring it up to date first (npm run archive -- migrate)`);
  }
  const db = openArchive(":memory:", { dataDir: folder });
  copyPlatform(db, file, platform);
  return db;
}

/** What a dry run's import `sourceId` into the copy `db` would add of calls, in lines. */
export function dryRunLines(db: Db, sourceId: number): string[] {
  const calls = newCalls(db, sourceId);
  return [
    ...(calls.length > 0 ? [`It would add ${calls.length} ${calls.length === 1 ? "call" : "calls"}:`] : []),
    ...calls.map((call) => {
      const length = call.seconds === null ? "of no known length" : callDuration(call.seconds);
      return `  ${dayKey(call.at)} ${timeOfDay(call.at)}  ${call.outgoing ? "outgoing" : "incoming"}, ${length}, ${call.chat === null ? "in no chat" : `with ${call.chat}`}`;
    }),
  ];
}

/** The calls the import added, oldest first. */
function newCalls(db: Db, sourceId: number): NewCall[] {
  const records = db
    .prepare(
      `SELECT m.sent_at AS at, m.call_seconds AS seconds, m.is_from_self AS outgoing,
         coalesce(c.title, (SELECT min(a.display_name) FROM conversation_member cm JOIN import_person a ON a.id = cm.account_id
           WHERE cm.conversation_id = c.id AND a.is_self = 0)) AS chat
       FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.first_source_id = ? AND m.type = 'call'`,
    )
    .all(sourceId) as Array<{ at: number; seconds: number | null; outgoing: number; chat: string | null }>;
  const inNoChat = db
    .prepare("SELECT DISTINCT platform_call_id, at, duration_seconds AS seconds, direction FROM call WHERE first_source_id = ?")
    .all(sourceId) as Array<{ at: number; seconds: number | null; direction: string }>;
  return [
    ...records.map((r) => ({ at: r.at, seconds: r.seconds, outgoing: r.outgoing === 1, chat: r.chat })),
    ...inNoChat.map((c) => ({ at: c.at, seconds: c.seconds, outgoing: c.direction === "outgoing", chat: null })),
  ].sort((a, b) => a.at - b.at);
}

/** Copies the archive's records of `platform` into `db` (see the top of this file). */
function copyPlatform(db: Db, archiveFile: string, platform: string): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("ATTACH DATABASE ? AS real").run(readOnlyAddress(archiveFile));
  try {
    db.exec("BEGIN");
    for (const { table, rows } of COPIED) {
      const columns = (db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      const values = columns.map((column) => LEFT_OUT[table]?.[column] ?? column);
      const copy = db.prepare(`INSERT INTO main.${table} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM real.${table} WHERE ${rows}`);
      if (rows.includes("$platform")) copy.run({ platform });
      else copy.run();
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("DETACH DATABASE real");
  }
}
