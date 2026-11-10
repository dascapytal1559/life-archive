// The reading side of the Query bar's SQL (sqlQuery.ts starts it): the archive
// opened read-only, with a few views that make common questions short, and one
// SELECT run over it for the person ids it returns. It runs as a process of its
// own, so a query that runs too long is stopped by ending the process, and
// whatever a query asks, the server's own connection is never touched.
//
// Run as a script, it reads {file, sql, maxRows} as JSON on stdin and writes
// {ids} or {error} as JSON on stdout.
//
// Nothing a query says can change the archive; each of these alone stops it:
//   - the database is opened read-only, with extensions off;
//   - PRAGMA query_only is on once the views below are made (in the temporary
//     schema, so the archive's own schema stays as it is);
//   - an authorizer lets a statement only read: SELECT, reading columns, calling
//     functions (but load_extension) and recursive WITH; no ATTACH, PRAGMA,
//     writes, transactions or schema changes;
//   - SQLite's defensive mode is on;
//   - only one statement runs, and it must start with SELECT or WITH: anything
//     after the first but comments is refused.
// Nor can a query read content (CONTENT_COLUMNS: message text, original records,
// the full-text index, catch-ups' and calls' notes, drafts), so it cannot filter on it or
// confirm a guess at it: the authorizer refuses any statement that would.
// SQLite's memory is capped too (HEAP_LIMIT), so a runaway sort fails rather
// than eat the Mac's memory.
//
// The views are below, VIEWS making them and SQL_VIEWS saying what each row and
// column is (docs/queries.md's "SQL queries" has examples; Generate's model is
// told them, queryWriter.ts). The counts are those the app shows
// (import_person_stats, see stats.ts). Times are milliseconds since the epoch;
// a day is a local date written 2025-01-31, so day >= '2025' or
// last_day < '2024-06' compare as dates do. Two functions: day(ms), that date,
// and days_ago(ms), whole local days from then to today.

import "../../../sdk/command.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dayKey, daysBetween, isSqlQuery, LOCALE, MESSAGE_TYPES, zonePlace } from "../../../sdk/server.ts";
import { PERSON_CALLS } from "./calls.ts";

/** The most memory SQLite may use for one query. */
const HEAP_LIMIT = 1024 * 1024 * 1024;

/** The captain's own accounts, for the views. */
const SELF_ACCOUNTS = `SELECT ip.id FROM import_person ip JOIN person p ON p.id = ip.person_id WHERE ip.is_self = 1 OR p.is_self = 1`;

/** Each account's counts (stats.ts), summed per person, or per person and platform. */
const COUNTS = `count(*) AS accounts,
    coalesce(sum(s.direct_count), 0) + coalesce(sum(s.group_count), 0) AS messages,
    coalesce(sum(s.direct_count), 0) AS direct_messages,
    coalesce(sum(s.they_direct), 0) AS direct_from_them,
    coalesce(sum(s.you_direct), 0) AS direct_from_me,
    coalesce(sum(s.group_count), 0) AS group_messages,
    coalesce(sum(s.marketplace_count), 0) AS marketplace_messages,
    max(s.last_message_at) AS last_message_at`;

const VIEWS = `
  CREATE TEMP VIEW person_names AS
  SELECT p.id AS person_id, p.name, 1 AS position, 1 AS is_display
  FROM person p WHERE p.is_self = 0
  UNION ALL
  SELECT p.id, a.value, a.key + 2, 0
  FROM person p, json_each(p.aliases_json) a WHERE p.is_self = 0;

  CREATE TEMP VIEW person_platform AS
  SELECT ip.person_id, ip.platform, ${COUNTS}, day(max(s.last_message_at)) AS last_day
  FROM import_person ip JOIN person p ON p.id = ip.person_id AND p.is_self = 0
  LEFT JOIN import_person_stats s ON s.import_person_id = ip.id
  GROUP BY ip.person_id, ip.platform;

  CREATE TEMP VIEW people AS
  SELECT *, archived_by IS NOT NULL AS archived FROM (
    SELECT p.id AS person_id, p.name, p.aliases_json AS aliases, p.note,
      (SELECT group_concat(t.name, ',' ORDER BY t.sort_order) FROM person_tag pt JOIN tag t ON t.id = pt.tag_id
       WHERE pt.person_id = p.id) AS tags,
      -- As archiving.ts's archiveReason: the captain's "archive" tag, else the rules' unless kept or edited.
      CASE
        WHEN EXISTS (SELECT 1 FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.person_id = p.id AND t.name = 'archive') THEN 'you'
        WHEN p.edited_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.person_id = p.id AND t.name = 'keep')
          THEN p.archive_rule
      END AS archived_by,
      -- As People.untouched: never changed by hand, linked by hand, or said to be someone else.
      p.edited_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM import_person ip WHERE ip.person_id = p.id AND ip.link_source = 'captain')
        AND NOT EXISTS (SELECT 1 FROM merge_proposal mp WHERE mp.status = 'rejected' AND 'person:' || p.id IN (mp.left_key, mp.right_key))
        AS untouched,
      p.edited_at, p.should_reach_out,
      p.location,
      a.platforms, coalesce(a.platform_count, 0) AS platform_count,
      coalesce(a.accounts, 0) AS accounts, coalesce(a.messages, 0) AS messages, coalesce(a.direct_messages, 0) AS direct_messages,
      coalesce(a.direct_from_them, 0) AS direct_from_them, coalesce(a.direct_from_me, 0) AS direct_from_me,
      coalesce(a.group_messages, 0) AS group_messages, coalesce(a.marketplace_messages, 0) AS marketplace_messages,
      a.last_message_at, day(a.last_message_at) AS last_day
    FROM person p
    LEFT JOIN (
      SELECT ip.person_id, group_concat(DISTINCT ip.platform ORDER BY ip.platform) AS platforms, count(DISTINCT ip.platform) AS platform_count,
        ${COUNTS}
      FROM import_person ip LEFT JOIN import_person_stats s ON s.import_person_id = ip.id
      WHERE ip.person_id IS NOT NULL GROUP BY ip.person_id
    ) a ON a.person_id = p.id
    WHERE p.is_self = 0 AND (a.person_id IS NOT NULL OR p.edited_at IS NOT NULL)
  );

  CREATE TEMP VIEW person_group AS
  WITH grp AS (SELECT id, platform, title FROM conversation WHERE type = 'group' AND is_marketplace = 0 AND dropped_at IS NULL),
  seen AS (
    SELECT cm.conversation_id, cm.account_id, 1 AS listed, 0 AS sent FROM conversation_member cm JOIN grp ON grp.id = cm.conversation_id
    WHERE cm.removed_at IS NULL
    UNION ALL
    SELECT m.conversation_id, m.sender_account_id, 0, 1 FROM message m JOIN grp ON grp.id = m.conversation_id
    WHERE m.sender_account_id IS NOT NULL AND m.type != 'system'
  )
  SELECT ip.person_id, grp.id AS conversation_id, grp.platform, grp.title, max(seen.listed) AS listed, sum(seen.sent) AS sent
  FROM seen JOIN grp ON grp.id = seen.conversation_id
  JOIN import_person ip ON ip.id = seen.account_id AND ip.is_self = 0
  JOIN person p ON p.id = ip.person_id AND p.is_self = 0
  GROUP BY ip.person_id, grp.id;

  CREATE TEMP VIEW direct_message AS
  SELECT m.id AS message_id, ip.person_id, c.platform, c.id AS conversation_id,
    (m.is_from_self = 1 OR m.sender_account_id IN (${SELF_ACCOUNTS})) AS from_me,
    m.sent_at, day(m.sent_at) AS day, m.type
  FROM conversation c
  JOIN conversation_member cm ON cm.conversation_id = c.id
  JOIN import_person ip ON ip.id = cm.account_id AND ip.is_self = 0
  JOIN person p ON p.id = ip.person_id AND p.is_self = 0
  JOIN message m ON m.conversation_id = c.id AND m.type != 'system'
  WHERE c.type = 'direct' AND c.is_marketplace = 0 AND c.dropped_at IS NULL;

  CREATE TEMP VIEW person_catch_up AS
  SELECT cp.person_id, c.id AS catch_up_id, c.day, c.time, c.trip_last_day AS last_day, c.trip_end_time AS end_time, c.hours,
    (SELECT count(*) FROM catch_up_person everyone WHERE everyone.catch_up_id = c.id) AS people, c.others
  FROM catch_up_person cp JOIN catch_up c ON c.id = cp.catch_up_id
  JOIN person p ON p.id = cp.person_id AND p.is_self = 0;

  CREATE TEMP VIEW person_call AS
  SELECT person_id, call_id, message_id, manual_call_id, account_id, platform, at, day(at) AS day, direction, answered, duration_seconds, service,
    call_group, people, others
  FROM (${PERSON_CALLS});
`;

/** The counts in people and person_platform, and what each is. */
const COUNT_COLUMNS = {
  accounts: "how many accounts",
  messages: "direct_messages + group_messages",
  direct_messages: "messages in one-to-one chats, both ways",
  direct_from_them: "of those, how many they sent the captain (none on Discord, whose data package holds only his)",
  direct_from_me: "of those, how many the captain sent them (a Discord data package holds only his)",
  group_messages: "messages they sent in group chats",
  marketplace_messages: "Marketplace messages, both ways",
  last_message_at: "the last message with or from them (ms), or null",
  last_day: "its day",
};

/** What each view's row is and each column means, in VIEWS' column order: for Generate's model, and checked against VIEWS by a test. */
export const SQL_VIEWS: Record<string, { row: string; columns: Record<string, string> }> = {
  people: {
    row: "a person the views list: anyone with an account, or whom the captain has edited; never the captain",
    columns: {
      person_id: "their id",
      name: "the captain's name for them, which labels them everywhere (the first of person_names)",
      aliases: "their other names, a JSON array, in his order (the rest of person_names)",
      note: "the captain's note on them",
      tags: "the captain's tags, comma-separated, in his order (to test one, see person_tag)",
      archived_by: "'you' when the captain archived them (the archive tag), else the archive rule's name; null when not archived",
      untouched: "1 when the captain never changed, linked or told them apart by hand",
      edited_at: "when the captain last changed them by hand (ms), or null",
      should_reach_out: "1 when the captain marked them to reach out to",
      location: "where they are, as far as the captain last knew ('Brisbane'), or null; compared without case, so location = 'brisbane' finds them",
      platforms: "their accounts' platforms, comma-separated, A to Z, so platforms = 'discord' is only on Discord",
      platform_count: "how many platforms",
      ...COUNT_COLUMNS,
      archived: "1 when archived, by the captain or by the rules (as the Table shows it)",
    },
  },
  person_names: {
    row: "a name the captain knows a person by: every person has one or more, in his order (the person panel's chips); never the captain. To find someone by any of their names, search here (name LIKE '%sam%')",
    columns: {
      person_id: "their id",
      name: "the name",
      position: "its place in his order, 1 first",
      is_display: "1 for the first, their name, which labels them everywhere; 0 for the rest (their aliases)",
    },
  },
  person_platform: {
    row: "a person and a platform they have an account on",
    columns: { person_id: "their id", platform: "the platform", ...COUNT_COLUMNS },
  },
  person_group: {
    row: "a person and a group chat they are in, listed as a member or having written there (dropped and Marketplace groups aside)",
    columns: {
      person_id: "their id",
      conversation_id: "the group chat (conversation.id)",
      platform: "its platform",
      title: "its title, or null",
      listed: "1 when listed as a member",
      sent: "how many messages they sent there",
    },
  },
  direct_message: {
    row: "a message in a one-to-one chat (system messages, Marketplace and dropped chats aside)",
    columns: {
      message_id: "the message (message.id)",
      person_id: "the person on the other side",
      platform: "its platform",
      conversation_id: "the chat (conversation.id)",
      from_me: "1 when the captain sent it",
      sent_at: "when (ms)",
      day: "its day",
      type: `${MESSAGE_TYPES.filter((type) => type !== "system").join(", ")}`,
    },
  },
  person_catch_up: {
    row: "a person and a catch-up they were at (the page calls one a hangout): time the captain spent with them in person, which he records (a call is a call, in person_call)",
    columns: {
      person_id: "their id",
      catch_up_id: "the catch-up (catch_up.id)",
      day: "its date; a trip's first",
      time: `when it started on that date in ${zonePlace()}, such as '19:30'; NULL when the captain did not say`,
      last_day: "a trip's last date (a trip away together over several days, in person); NULL for one on a single date",
      end_time: "when a trip ended on its last date, such as '14:00'; NULL for one on a single date",
      hours: "how many hours it lasted, such as 1 or 2.5; a trip's time together in all, its private hours each day left out",
      people: "how many people he named were at it, the captain aside",
      others: "how many more were there that he did not name (a crowd); 0 for none",
    },
  },
  person_call: {
    row: "a call with a person: from the phone's call history (phone and FaceTime calls), another app's call with several people made in no chat (a WhatsApp three-way call: one row for each person on it named), another app's call record in a one-to-one chat (Messenger, Instagram, WhatsApp, WeChat, Signal, Telegram; that record is also a message in direct_message, of type 'call'), or one the captain logged himself (Add event's Call)",
    columns: {
      person_id: "their id",
      call_id: "a call in no chat (call.id): the phone's call history's, or an app's with several people; else null",
      message_id: "another app's call record (message.id); else null",
      manual_call_id: "a call the captain logged (manual_call.id); else null",
      account_id: "the account it was with or on (import_person.id); null for a call he logged on no account",
      platform: "'phone' for the phone's call history (phone and FaceTime), else the app: 'messenger', 'instagram', 'whatsapp', 'wechat', 'signal' or 'telegram'; for one logged, its account's platform ('imessage' for FaceTime; 'discord' too), or on no account the app he said: 'phone', 'facetime', 'whatsapp', 'messenger', 'instagram', 'signal', 'telegram', 'wechat', 'discord' or 'other'",
      at: "when it started (ms)",
      day: "its day",
      direction: "'incoming' when they called, 'outgoing' when the captain did; null for one logged",
      answered: "1 when it was connected (an outgoing call answered by voicemail too); 0 for a missed or unanswered call; null when the app does not say how long a call in a chat was (WeChat, Signal's answered calls, Messenger's phone-app export, a WhatsApp call answered on another device) and the captain gave it no length; for an imported call, as the captain said when he set it (answered 1, missed 0, unknown null; the call_answered table), over what its source says",
      duration_seconds: "how long it was connected, in seconds; 0 when not answered; the captain's own length when its app says none and he gave one; else null (a call in no chat answered on another device: answered 1 and no length)",
      service: "a call in no chat's: the phone's 'phone', 'facetime-audio' or 'facetime-video', an app's 'voice' or 'video'; null for another app's in a chat and one logged",
      call_group: "for a call with several people, its group, which each one's row of it shares: for one he logged, the first logged call's id; for an app's in no chat, minus its first row's call_id; else null",
      people: "how many people were on it, the captain aside: 1, or for a call with several, how many, its unnamed others among them (the closeness score counts each named one their share of its time)",
      others: "of those, how many were not named: on an app's call in no chat, people the archive knows no account of; on one he logged, those he did not name; else 0",
    },
  },
};

/** The authorizer's action codes (sqlite3_set_authorizer), by number, for saying what was refused. */
const ACTIONS = [
  "", "CREATE INDEX", "CREATE TABLE", "CREATE TEMP INDEX", "CREATE TEMP TABLE", "CREATE TEMP TRIGGER", "CREATE TEMP VIEW",
  "CREATE TRIGGER", "CREATE VIEW", "DELETE", "DROP INDEX", "DROP TABLE", "DROP TEMP INDEX", "DROP TEMP TABLE", "DROP TEMP TRIGGER",
  "DROP TEMP VIEW", "DROP TRIGGER", "DROP VIEW", "INSERT", "PRAGMA", "READ", "SELECT", "a transaction", "UPDATE", "ATTACH",
  "DETACH", "ALTER TABLE", "REINDEX", "ANALYZE", "CREATE VIRTUAL TABLE", "DROP VIRTUAL TABLE", "FUNCTION", "SAVEPOINT", "RECURSIVE",
];
const READING = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);

/**
 * Content (AGENTS.md's tier 2), which no query may read, so none can filter on it or confirm a guess at it: by table,
 * its content columns, or "all" for a table that is content throughout (the full-text index's shadow tables, named
 * message_fts_*, with it). It is read only through content.ts, which logs every read.
 */
export const CONTENT_COLUMNS: Record<string, readonly string[] | "all"> = {
  message: ["text", "raw_json"],
  message_version: "all",
  message_fts: "all",
  call: ["raw_json"],
  catch_up: ["note"],
  manual_call: ["note"],
  call_note: ["note"],
  draft: ["text"],
  // A changeset's rows before and after hold catch-ups' and calls' notes and drafts.
  change_row: ["before_json", "after_json"],
};

/** Whether reading `column` of `table` reads content (CONTENT_COLUMNS). */
export function isContent(table: string, column: string): boolean {
  const closed = CONTENT_COLUMNS[table.startsWith("message_fts_") ? "message_fts" : table];
  return closed === "all" || (closed?.includes(column) ?? false);
}

/** Only whitespace and comments: what may follow the one statement. */
const NOTHING_MORE = /^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$))*$/;

/** A query that does not run, or returns what is not person ids, in words for the line under the Query bar's box. */
export class SqlError extends Error {}

/**
 * A read-only connection to the archive in `file`, with the views and functions, that only reads (see the top). The
 * memory cap is SQLite's, for the whole process, so `heapLimit: false` leaves it off in a process that keeps the
 * archive open for writing too (the viewer's connection, server/viewer/), whose queries are its own, not anyone's SQL.
 */
export function openForQuery(file: string, { heapLimit = true }: { heapLimit?: boolean } = {}): DatabaseSync & { refused: () => string | null } {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  db.enableDefensive(true);
  withViews(db);
  if (heapLimit) db.exec(`PRAGMA hard_heap_limit = ${HEAP_LIMIT}`);
  db.exec("PRAGMA query_only = ON");
  let refused: string | null = null;
  db.setAuthorizer((action, name, detail) => {
    if (action === constants.SQLITE_READ && isContent(name ?? "", detail ?? "")) {
      refused = `a query cannot read content: ${CONTENT_COLUMNS[name!] === undefined || CONTENT_COLUMNS[name!] === "all" ? name : `${name}.${detail}`}`;
      return constants.SQLITE_DENY;
    }
    const allowed = READING.has(action) && !(action === constants.SQLITE_FUNCTION && /^load_extension$/i.test(detail ?? ""));
    if (!allowed) {
      const what = action === constants.SQLITE_PRAGMA ? `PRAGMA ${name}` : action === constants.SQLITE_FUNCTION ? detail : ACTIONS[action] || `action ${action}`;
      refused = `a query only reads: ${what} is not allowed`;
    }
    return allowed ? constants.SQLITE_OK : constants.SQLITE_DENY;
  });
  return Object.assign(db, {
    refused: () => {
      const last = refused;
      refused = null;
      return last;
    },
  });
}

/**
 * The views and their functions (day, days_ago), on the connection `db`: openForQuery's, and the static demo's in its
 * page (../demo.ts), whose made-up archive its tables read as the viewer's connection does.
 */
export function withViews(db: DatabaseSync): DatabaseSync {
  const days = new Map<number, string>();
  // A local day changes only on a quarter hour (every zone's offset is a multiple of 15 minutes), so each is worked out once.
  db.function("day", { deterministic: true }, (ms) => {
    if (typeof ms !== "number" && typeof ms !== "bigint") return null;
    const quarter = Math.floor(Number(ms) / 900_000);
    let day = days.get(quarter);
    if (day === undefined) days.set(quarter, (day = dayKey(Number(ms))));
    return day;
  });
  db.function("days_ago", (ms) => (typeof ms === "number" || typeof ms === "bigint" ? daysBetween(Number(ms), Date.now()) : null));
  db.exec(VIEWS);
  return db;
}

/**
 * The person ids one SELECT returns, from its column person_id, else id: each once, in the order first returned,
 * nulls skipped. Throws SqlError for anything but one statement that only reads, more than `maxRows` rows, no such
 * column, a value that is not a whole number, or ids that are no person's.
 */
export function readPersonIds(db: ReturnType<typeof openForQuery>, sql: string, maxRows: number): number[] {
  db.refused();
  // SQLite's error, or what the authorizer refused, when preparing or (a PRAGMA's table function) running.
  const failed = (error: unknown) => {
    if (error instanceof SqlError) return error;
    const refused = db.refused();
    return new SqlError(refused ?? (error as Error).message);
  };
  if (!isSqlQuery(sql)) throw new SqlError("a query is one SELECT, or WITH ... SELECT, that only reads");
  let statement;
  try {
    statement = db.prepare(sql);
  } catch (error) {
    throw failed(error);
  }
  const first = statement.sourceSQL;
  if (!sql.startsWith(first) || !NOTHING_MORE.test(sql.slice(first.length))) {
    throw new SqlError("one statement only: take out what follows the first ;");
  }
  const columns = statement.columns().map((column) => column.name);
  const column = columns.includes("person_id") ? columns.indexOf("person_id") : columns.indexOf("id");
  if (column < 0) throw new SqlError(`return the people as a column named person_id (or id); this query returns ${columns.join(", ")}`);
  statement.setReturnArrays(true);
  const ids = new Set<number>();
  let rows = 0;
  try {
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      if (++rows > maxRows) throw new SqlError(`the query returns more than ${maxRows.toLocaleString(LOCALE)} rows: return each person once (SELECT DISTINCT, or GROUP BY person_id)`);
      const value = row[column];
      if (value === null) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new SqlError(`${columns[column]} must be a person's id, a whole number, not ${JSON.stringify(typeof value === "bigint" ? String(value) : value)}`);
      }
      ids.add(value);
    }
  } catch (error) {
    throw failed(error);
  }
  const list = [...ids];
  const stray = db.prepare("SELECT value FROM json_each(?) WHERE value NOT IN (SELECT id FROM person)").all(JSON.stringify(list)) as { value: number }[];
  if (stray.length > 0) {
    const some = stray.slice(0, 3).map((row) => row.value).join(", ");
    throw new SqlError(`${stray.length === 1 ? "1 id the query returns is" : `${stray.length} ids the query returns are`} no person's (${some}${stray.length > 3 ? ", …" : ""}): return person ids, such as people.person_id or import_person.person_id`);
  }
  return list;
}

/** What the script is asked on stdin. */
export interface SqlRequest {
  file: string;
  sql: string;
  maxRows: number;
}

/** What the script answers on stdout. */
export type SqlAnswer = { ids: number[] } | { error: string };

function main(): void {
  let answer: SqlAnswer;
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as SqlRequest;
    const db = openForQuery(request.file);
    try {
      answer = { ids: readPersonIds(db, request.sql, request.maxRows) };
    } finally {
      db.close();
    }
  } catch (error) {
    answer = { error: (error as Error).message };
  }
  // Not process.exit: on macOS a pipe is written asynchronously, so the process ends once the answer is out.
  process.stdout.write(JSON.stringify(answer));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
