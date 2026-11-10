// The archive's content read path: the only code that reads message text or
// finds attachment files. It serves timelines, a chat's day (the Calendar
// view), search and attachment bytes, and is mounted under
// /api/archive/content/ (see http.ts) so a stricter access policy can be put
// on it alone. Its callers, the content routes and the CLI's timeline and
// search, keep every read in the trail (contentLog.ts).
//
// Attachment files are located here by id and streamed by http.ts; nothing on
// the server decodes or inspects them.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { addDays, type CallAnswer, type DayMessagesPage, dayStart, type Db, mediaTypeOf, resolveLocalPath, type SearchHit, type TimelineMessage, type TimelinePage } from "../../../sdk/server.ts";
import { messengerLike } from "../connectors/metaDyi.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** A timeline page may be much bigger than a search, so a whole history loads in a few requests. */
const MAX_PAGE = 5000;

interface MessageRow {
  id: number;
  platform: string;
  conversation_id: number;
  conversation_type: "direct" | "group";
  conversation_marketplace: number;
  conversation_title: string | null;
  sent_at: number;
  is_from_self: number;
  sender_name: string | null;
  type: string;
  text: string | null;
  unsent: number;
  call_seconds: number | null;
  call_length_given: number;
  call_note: string | null;
  call_answer: CallAnswer | null;
  snippet?: string;
}

const SELECT_MESSAGE = `
  SELECT m.id, m.platform, m.conversation_id, c.type AS conversation_type, c.title AS conversation_title,
         c.is_marketplace AS conversation_marketplace,
         m.sent_at, max(m.is_from_self, coalesce(sp.is_self, 0)) AS is_from_self, a.display_name AS sender_name,
         m.type, m.text, m.unsent, coalesce(m.call_seconds, cl.seconds) AS call_seconds,
         m.call_seconds IS NULL AND cl.seconds IS NOT NULL AS call_length_given, cn.note AS call_note,
         nullif(ca.answered, '') AS call_answer
  FROM message m
  JOIN conversation c ON c.id = m.conversation_id
  LEFT JOIN call_length cl ON cl.message_id = m.id
  LEFT JOIN call_note cn ON cn.message_id = m.id
  LEFT JOIN call_answered ca ON ca.message_id = m.id
  LEFT JOIN import_person a ON a.id = m.sender_account_id
  LEFT JOIN person sp ON sp.id = a.person_id`;

/** Messages involving some accounts (SQL for their ids): their direct conversations (both directions) and what they said in groups. */
const messagesOf = (accounts: string) => `(
  m.sender_account_id IN (${accounts})
  OR m.conversation_id IN (
    SELECT cm.conversation_id FROM conversation_member cm JOIN conversation c2 ON c2.id = cm.conversation_id
    WHERE c2.type = 'direct' AND cm.account_id IN (${accounts})))`;
/** A person's messages, through every account of theirs. */
const PERSON_MESSAGES = messagesOf("SELECT id FROM import_person WHERE person_id = :person");
/** One account's messages alone ("open" beside it in the person panel), to see who it really is. */
const ACCOUNT_MESSAGES = messagesOf(":account");

/**
 * Which page of a chat: the newest `limit` messages (50 by default, up to 5000), or those just older than `before`
 * (the last page's nextBefore), or with `after` (a page's nextAfter, or a moment as `<ms>:0`) the `limit` just newer
 * than it, which say where the next newer page starts (nextAfter) and never where an older one does. With `count`,
 * the page also says how many messages there are in all.
 */
export interface PageOptions {
  before?: string;
  after?: string;
  limit?: number;
  count?: boolean;
}

/** An attachment's file on disk, ready to be served. */
export interface AttachmentFile {
  path: string;
  size: number;
  mime: string;
  /** The chat it was sent in, for the trail of content reads. */
  conversation: number;
}

export class ArchiveContent {
  private readonly db: Db;
  private readonly dataDir: string;

  /** `dataDir` is the data folder, which attachments' local paths are relative to (see mediaPaths.ts). */
  constructor(db: Db, dataDir: string) {
    this.db = db;
    this.dataDir = resolve(dataDir);
  }

  /**
   * An attachment's file, or null if there is no such attachment, the source
   * lacked the file, or it is not on disk. Only files inside data/archive/media/
   * or data/platform-exports/ are ever returned, whatever the stored path says (and
   * wherever a symlink points).
   */
  async attachmentFile(id: number): Promise<AttachmentFile | null> {
    const row = this.db
      .prepare("SELECT a.mime, a.local_path, m.conversation_id FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = ?")
      .get(id) as { mime: string | null; local_path: string | null; conversation_id: number } | undefined;
    if (!row?.local_path) return null;
    try {
      const path = await resolveLocalPath(this.dataDir, row.local_path);
      if (!path) return null;
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { path, size: info.size, mime: row.mime ?? mediaTypeOf(path).mime ?? "application/octet-stream", conversation: row.conversation_id };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * A person's messages across platforms, newest first, a page at a time (PageOptions): their one-to-one chats,
   * with what they said in group chats only when `groups` is set, and
   * Marketplace chats only when `marketplace` is; with `account`, only that one
   * account's. With `count`, the page also says how many messages there are in
   * all. Null if there is no such person, or the account is not theirs.
   */
  timeline(
    personId: number,
    options: PageOptions & { platform?: string; groups?: boolean; marketplace?: boolean; account?: number } = {},
  ): TimelinePage | null {
    if (!this.personExists(personId)) return null;
    const { account } = options;
    if (account !== undefined && !this.accountOf(account, personId)) return null;
    const where = [
      account === undefined ? PERSON_MESSAGES : ACCOUNT_MESSAGES,
      ...(options.groups ? [] : ["c.type = 'direct'"]),
      ...(options.marketplace ? [] : ["c.is_marketplace = 0"]),
    ].join(" AND ");
    return this.page(where, account === undefined ? { person: personId } : { account }, options);
  }

  private personExists(id: number): boolean {
    return this.db.prepare("SELECT 1 FROM person WHERE id = ?").get(id) !== undefined;
  }

  private accountOf(accountId: number, personId: number): boolean {
    return this.db.prepare("SELECT 1 FROM import_person WHERE id = ? AND person_id = ?").get(accountId, personId) !== undefined;
  }

  /** One conversation's messages, newest first, a page at a time (PageOptions). */
  conversation(conversationId: number, options: PageOptions = {}): TimelinePage {
    return this.page("m.conversation_id = :conversation", { conversation: conversationId }, options);
  }

  /**
   * One chat's messages on one local day (YYYY-MM-DD), oldest first, `limit` at a time from `after` (the last
   * page's nextAfter): the Calendar view's day, so system messages are left out, as it counts them.
   */
  conversationDay(conversationId: number, day: string, options: { after?: string; limit?: number } = {}): DayMessagesPage {
    return this.between("m.conversation_id = :conversation AND m.type != 'system'", { conversation: conversationId }, dayStart(day), dayStart(addDays(day, 1)), options);
  }

  /**
   * One chat's messages in [start, stop) (ms), oldest first, `limit` at a time from `after`: every one, system
   * messages too, as the Events calendar counts a day (its day of a group chat, dayChats.ts).
   */
  conversationBetween(conversationId: number, start: number, stop: number, options: { after?: string; limit?: number } = {}): DayMessagesPage {
    return this.between("m.conversation_id = :conversation", { conversation: conversationId }, start, stop, options);
  }

  /**
   * A person's messages in [start, stop) (ms), oldest first, `limit` at a time from `after`: everything in their
   * one-to-one chats and what they said anywhere else, Marketplace and system messages too, as the Events calendar
   * counts whom the captain messaged (calendarRows.ts's messageDayRows), so the list holds as many as the day says.
   */
  personBetween(personId: number, start: number, stop: number, options: { after?: string; limit?: number } = {}): DayMessagesPage {
    return this.between(PERSON_MESSAGES, { person: personId }, start, stop, options);
  }

  /** The messages `where` picks (its parameters `params`) in [start, stop), oldest first, a page from `after`. */
  private between(where: string, params: Record<string, number>, start: number, stop: number, options: { after?: string; limit?: number }): DayMessagesPage {
    const limit = clampLimit(options.limit, MAX_PAGE);
    Object.assign(params, { start, stop, limit: limit + 1 });
    const filters = [where, "m.sent_at >= :start", "m.sent_at < :stop"];
    const cursor = parseCursor(options.after);
    if (cursor) {
      Object.assign(params, { afterAt: cursor.sentAt, afterId: cursor.id });
      filters.push("(m.sent_at > :afterAt OR (m.sent_at = :afterAt AND m.id > :afterId))");
    }
    const rows = this.db
      .prepare(`${SELECT_MESSAGE} WHERE ${filters.join(" AND ")} ORDER BY m.sent_at, m.id LIMIT :limit`)
      .all(params) as unknown as MessageRow[];
    const messages = this.withDetails(rows.slice(0, limit));
    const last = messages.at(-1);
    return { messages, nextAfter: rows.length > limit && last ? `${last.sentAt}:${last.id}` : null };
  }

  /** Full-text search over message text, newest first. Every word must match; the last may be a prefix. */
  search(query: string, options: { personId?: number; platform?: string; limit?: number } = {}): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const params: Record<string, string | number> = { match, limit: clampLimit(options.limit) };
    const filters: string[] = [];
    if (options.personId !== undefined) {
      if (!this.personExists(options.personId)) return [];
      params.person = options.personId;
      filters.push(PERSON_MESSAGES);
    }
    if (options.platform) {
      params.platform = options.platform;
      filters.push("m.platform = :platform");
    }
    const rows = this.db
      .prepare(
        `${SELECT_MESSAGE.replace("m.unsent", "m.unsent, snippet(message_fts, 0, '[', ']', '…', 12) AS snippet")}
         JOIN message_fts ON message_fts.rowid = m.id
         WHERE message_fts MATCH :match ${filters.map((f) => `AND ${f}`).join(" ")}
         ORDER BY m.sent_at DESC, m.id DESC LIMIT :limit`,
      )
      .all(params) as unknown as MessageRow[];
    return this.withDetails(rows).map((message, i) => ({ ...message, snippet: rows[i].snippet ?? "" }));
  }

  private page(where: string, params: Record<string, number>, options: PageOptions & { platform?: string }): TimelinePage {
    const limit = clampLimit(options.limit, MAX_PAGE);
    const all: Record<string, string | number> = { ...params };
    const filters = [where];
    if (options.platform) {
      all.platform = options.platform;
      filters.push("m.platform = :platform");
    }
    const total = options.count
      ? (this.db
        .prepare(`SELECT count(*) AS n FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE ${filters.join(" AND ")}`)
        .get(all) as { n: number }).n
      : undefined;
    all.limit = limit + 1;
    const after = parseCursor(options.after);
    const before = after ? null : parseCursor(options.before);
    if (before) {
      Object.assign(all, { beforeAt: before.sentAt, beforeId: before.id });
      filters.push("(m.sent_at < :beforeAt OR (m.sent_at = :beforeAt AND m.id < :beforeId))");
    }
    if (after) {
      Object.assign(all, { afterAt: after.sentAt, afterId: after.id });
      filters.push("(m.sent_at > :afterAt OR (m.sent_at = :afterAt AND m.id > :afterId))");
    }
    // After a cursor, the oldest `limit` past it, turned round so the page reads newest first like any other.
    const order = after ? "m.sent_at, m.id" : "m.sent_at DESC, m.id DESC";
    const rows = this.db
      .prepare(`${SELECT_MESSAGE} WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT :limit`)
      .all(all) as unknown as MessageRow[];
    const more = rows.length > limit;
    const kept = rows.slice(0, limit);
    const messages = this.withDetails(after ? kept.reverse() : kept);
    const counted = total === undefined ? {} : { total };
    if (after) {
      const newest = messages[0];
      return { messages, nextBefore: null, nextAfter: more && newest ? `${newest.sentAt}:${newest.id}` : null, ...counted };
    }
    const last = messages.at(-1);
    return { messages, nextBefore: more && last ? `${last.sentAt}:${last.id}` : null, ...counted };
  }

  private withDetails(rows: MessageRow[]): TimelineMessage[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const attachments = this.db
      .prepare(`SELECT id, message_id, type, filename, mime, size, local_path FROM attachment WHERE message_id IN (${placeholders}) ORDER BY ordinal`)
      .all(...ids) as { id: number; message_id: number; type: string; filename: string | null; mime: string | null; size: number | null; local_path: string | null }[];
    const reactions = this.db
      .prepare(
        `SELECT r.message_id, r.emoji, a.display_name AS actor FROM reaction r JOIN import_person a ON a.id = r.actor_account_id
         WHERE r.message_id IN (${placeholders})`,
      )
      .all(...ids) as { message_id: number; emoji: string; actor: string }[];
    const attachmentsOf = groupBy(attachments, (a) => a.message_id);
    const reactionsOf = groupBy(reactions, (r) => r.message_id);
    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      conversation: {
        id: row.conversation_id,
        type: row.conversation_type,
        title: row.conversation_title,
        marketplace: row.conversation_marketplace === 1,
      },
      sentAt: row.sent_at,
      fromSelf: row.is_from_self === 1,
      sender: row.sender_name,
      type: row.type,
      text: row.text,
      unsent: row.unsent === 1,
      callSeconds: row.call_seconds,
      callLengthGiven: row.call_length_given === 1,
      callNote: row.call_note ?? "",
      callAnswer: row.call_answer,
      attachments: (attachmentsOf.get(row.id) ?? [])
        .map((a) => ({
          id: a.id, type: a.type, mime: a.mime, size: a.size, missing: a.local_path === null,
          like: a.type === "sticker" ? messengerLike(a.filename) : null,
        })),
      reactions: (reactionsOf.get(row.id) ?? []).map(({ emoji, actor }) => ({ emoji, actor })),
    }));
  }
}

function clampLimit(limit: number | undefined, max = MAX_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function groupBy<T>(items: readonly T[], key: (item: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function parseCursor(before: string | undefined): { sentAt: number; id: number } | null {
  const match = before ? /^(-?\d+):(\d+)$/.exec(before) : null;
  return match ? { sentAt: Number(match[1]), id: Number(match[2]) } : null;
}

/** Words as quoted FTS5 terms (so punctuation can't break the query), the last one a prefix. */
function ftsQuery(query: string): string {
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((word, i) => `"${word}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}
