// The archive's write API: applies a connector's validated events for one
// source (one import). Every write is an idempotent upsert keyed on platform
// ids, so importing the same source again changes nothing, and an overlapping
// newer export only adds what is new.
//
// One platform can reach the archive through more than one connector (Messenger
// through its phone export and through Facebook's "Download your information"),
// and each gives the same message a different id. So a message whose id the
// archive has not seen is first matched against messages a *different*
// connector brought in: the same platform, the same sender account (accounts
// are shared: a Messenger name is one account whichever connector saw it; two
// unknown "Facebook user" senders count as the same) and the same millisecond.
// A match is kept once: the new id is recorded as an alias of the message
// already there (message_alias), so importing either source again finds it,
// reactions add to it, and its attachments stay those the first source gave.
// Messages from the same connector are never matched this way, because a
// connector's own ids already tell its records apart (photos sent in one
// millisecond are separate records in the phone export).
//
// A call is one call whichever table holds it: a call record (a message of
// type "call") and a call in no chat (the call table, for an app's call with
// several people) with the same id on the same platform are the same call,
// which two copies of WhatsApp's history can disagree about (one names several
// people on it, the other one). So a call already kept in either is never
// added again in the other: the newer record can only give it a length it had
// none of.
//
// An account's name is the one its newest source gives, except that a
// stand-in (a placeholder such as "WhatsApp user", or only a number) never
// replaces a name a source found: live WhatsApp, which may know someone only
// by their number, leaves them the name the address book gave an import.
//
// The event index's events (a device, an LLM's sessions and turns) are the
// core's, written into its own database (coreWrite.ts), never here.
//
// The caller wraps a whole import in one transaction (see connectors/host.ts),
// so a failed import leaves the archive as it was.

import { type AccountEvent, type AppliedSource, type ArchiveEvent, type AttachmentEvent, calendarDayOf, type CallEvent, type ConversationEvent, type CoverageEvent, type Db, type EditEvent, emptyCounts, EventOrderError, homeRank, type ImportCounts, isNumberName, isPlaceholderName, localPathOf, type MessageEvent, nameKey, type ReactionEvent } from "../../../sdk/server.ts";

/**
 * What an import touched that the calendar (server/calendar/) is pushed afresh after its transaction commits: the
 * calendar days whose messages it added or changed, and whether a call (a record, a call in no chat, or a length) came
 * or changed.
 */
export interface Touched {
  days: string[];
  calls: boolean;
}

export class ImportSession {
  readonly counts = emptyCounts();
  private readonly db: Db;
  private readonly platform: string;
  private readonly sourceId: number;
  private readonly sourceKind: string;
  private readonly connector: string | null;
  /** When this source was read: when its import people were last seen. */
  private readonly seenAt: number;
  /** The data folder, which attachments' local paths are relative to (see mediaPaths.ts). */
  private readonly dataDir: string | undefined;
  private readonly accounts = new Map<string, number>();
  private readonly conversations = new Map<string, number>();
  private readonly messages = new Map<string, number>();
  private readonly seenMessages = new Set<string>();
  /** This source's ids for messages that belong to another connector's record (see the top of this file). */
  private readonly aliased = new Set<string>();
  /** The calendar days whose messages this import added or changed, and whether a call came or changed (see Touched). */
  private readonly touchedDays = new Set<string>();
  private touchedCalls = false;

  /**
   * `seenAt` is when the events were read, if not when the source started (a live source's batches).
   * `dataDir` is needed only for attachments kept in place (see mediaPaths.ts).
   */
  constructor(db: Db, platform: string, sourceId: number, sourceKind: string, { seenAt, dataDir }: { seenAt?: number; dataDir?: string } = {}) {
    this.db = db;
    this.platform = platform;
    this.sourceId = sourceId;
    this.sourceKind = sourceKind;
    const source = db.prepare("SELECT connector, started_at FROM source WHERE id = ?").get(sourceId) as
      { connector: string; started_at: number } | undefined;
    this.connector = source?.connector ?? null;
    this.seenAt = seenAt ?? source?.started_at ?? Date.now();
    this.dataDir = dataDir;
  }

  apply(event: ArchiveEvent): void {
    switch (event.kind) {
      case "account": return this.account(event);
      case "conversation": return this.conversation(event);
      case "message": return this.message(event);
      case "reaction": return this.reaction(event);
      case "attachment": return this.attachment(event);
      case "edit": return this.edit(event);
      case "call": return this.call(event);
      case "device":
      case "llm-session":
      case "llm-turn":
        // The conversations with agents are the core's (archive/coreWrite.ts): its connectors' imports go to its own database.
        throw new EventOrderError(`a ${event.kind} event is the core's event index's, and no connector of the archive's chats writes one`);
      case "workout":
        // The workouts are the exercise module's (modules/exercise): its connectors' imports go to its own database.
        throw new EventOrderError("a workout event is the exercise module's, and no connector of the archive's writes one");
      case "coverage": return this.coverage(event);
      case "tally":
        this.counts.tallies[event.name] = (this.counts.tallies[event.name] ?? 0) + event.count;
        return;
      case "progress":
        return;
    }
  }

  /** What this import touched, for the calendar's push after its transaction commits (server/calendar/push.ts). */
  touched(): Touched {
    return { days: [...this.touchedDays].sort(), calls: this.touchedCalls };
  }

  /** A message added or changed at `sentAt`: its calendar day's summaries are pushed afresh; a call record, the calls. */
  private touch(sentAt: number, type: string): void {
    this.touchedDays.add(calendarDayOf(sentAt));
    if (type === "call") this.touchedCalls = true;
  }

  /**
   * An import person: made the first time a source reports it, and brought up
   * to date (name, how it was named, handle, whether it is the captain) each
   * time one does. Which person it is, is left to the rules (people.ts).
   */
  private account(event: AccountEvent): void {
    const existing = this.db
      .prepare("SELECT id, display_name, name_source, handle, key_kind, is_self FROM import_person WHERE platform = ? AND key = ?")
      .get(this.platform, event.key) as
      | { id: number; display_name: string; name_source: string | null; handle: string | null; key_kind: string; is_self: number }
      | undefined;
    const handle = event.handle ?? existing?.handle ?? null;
    const isSelf = event.isSelf ? 1 : (existing?.is_self ?? 0);
    const keep = existing && isStandIn(event.displayName, event.nameSource ?? null) && !isStandIn(existing.display_name, existing.name_source);
    const displayName = keep ? existing.display_name : event.displayName;
    const nameSource = keep ? existing.name_source : (event.nameSource ?? null);
    if (!existing) {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO import_person (platform, key, key_kind, display_name, name_source, handle, is_self, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(this.platform, event.key, event.keyKind, displayName, nameSource, handle, isSelf, this.seenAt, this.seenAt);
      this.accounts.set(event.key, Number(lastInsertRowid));
      this.counts.accounts.added++;
      return;
    }
    this.accounts.set(event.key, existing.id);
    this.db.prepare("UPDATE import_person SET last_seen_at = max(coalesce(last_seen_at, 0), ?) WHERE id = ?").run(this.seenAt, existing.id);
    if (event.fallback) return;
    if (existing.display_name !== displayName || existing.name_source !== nameSource || existing.handle !== handle
      || existing.is_self !== isSelf || existing.key_kind !== event.keyKind) {
      this.db
        .prepare("UPDATE import_person SET display_name = ?, name_source = ?, handle = ?, is_self = ?, key_kind = ? WHERE id = ?")
        .run(displayName, nameSource, handle, isSelf, event.keyKind, existing.id);
      this.counts.accounts.updated++;
    }
  }

  private conversation(event: ConversationEvent): void {
    const title = event.title ?? null;
    const marketplace = event.marketplace ? 1 : 0;
    const selfOnly = event.selfOnly ? 1 : 0;
    const existing = this.db
      .prepare("SELECT id, type, title, is_marketplace, is_self_only FROM conversation WHERE platform = ? AND platform_conversation_id = ?")
      .get(this.platform, event.id) as { id: number; type: string; title: string | null; is_marketplace: number; is_self_only: number } | undefined;
    let id: number;
    if (!existing) {
      id = Number(
        this.db
          .prepare("INSERT INTO conversation (platform, platform_conversation_id, type, title, is_marketplace, is_self_only) VALUES (?, ?, ?, ?, ?, ?)")
          .run(this.platform, event.id, event.type, title, marketplace, selfOnly).lastInsertRowid,
      );
      this.counts.conversations.added++;
    } else {
      id = existing.id;
      if (!event.fallback && (existing.type !== event.type || existing.title !== title || existing.is_marketplace !== marketplace || existing.is_self_only !== selfOnly)) {
        this.db
          .prepare("UPDATE conversation SET type = ?, title = ?, is_marketplace = ?, is_self_only = ? WHERE id = ?")
          .run(event.type, title, marketplace, selfOnly, id);
        this.counts.conversations.updated++;
      }
    }
    this.conversations.set(event.id, id);
    const addMember = this.db.prepare("INSERT OR IGNORE INTO conversation_member (conversation_id, account_id) VALUES (?, ?)");
    for (const member of event.members) addMember.run(id, this.accountId(member));
  }

  private message(event: MessageEvent): void {
    if (this.seenMessages.has(event.id)) {
      this.counts.messages.duplicates++;
      return;
    }
    this.seenMessages.add(event.id);
    const conversationId = this.conversationId(event.conversation);
    const senderId = event.sender === null ? null : this.accountId(event.sender);
    const unsent = event.unsent ? 1 : 0;
    // A retracted message keeps no text, here or in its original record.
    const text = unsent ? null : (event.text ?? null);
    const raw = JSON.stringify(unsent ? withoutText(event.raw) : event.raw);
    const callSeconds = event.callSeconds ?? null;
    const existing = this.db
      .prepare("SELECT id, type, text, unsent, edited_at, call_seconds FROM message WHERE platform = ? AND platform_message_id = ?")
      .get(this.platform, event.id) as { id: number; type: string; text: string | null; unsent: number; edited_at: number | null; call_seconds: number | null } | undefined;

    if (!existing && event.type === "call" && this.keptAsCallInNoChat(event)) return;
    if (!existing) {
      const known = this.aliasOf(event.id);
      const twin = known ?? this.twinOf(event.sentAt, senderId);
      if (twin !== null) {
        if (known === null) {
          this.db
            .prepare("INSERT INTO message_alias (platform, platform_message_id, message_id, source_id) VALUES (?, ?, ?, ?)")
            .run(this.platform, event.id, twin, this.sourceId);
          this.counts.messages.matched++;
        } else {
          this.counts.messages.unchanged++;
        }
        this.messages.set(event.id, twin);
        this.aliased.add(event.id);
        return;
      }
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, sender_account_id, is_from_self,
             sent_at, type, text, reply_to_platform_id, unsent, edited_at, call_seconds, first_source_id, last_source_id, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.platform, conversationId, event.id, event.idKind, senderId, event.isFromSelf ? 1 : 0, event.sentAt,
          event.type, text, event.replyTo ?? null, unsent, event.editedAt ?? null, callSeconds, this.sourceId, this.sourceId, raw,
        );
      this.messages.set(event.id, Number(lastInsertRowid));
      this.touch(event.sentAt, event.type);
      this.counts.messages.added++;
      if (unsent) this.counts.messages.unsentAdded++;
      return;
    }

    this.messages.set(event.id, existing.id);
    // A lesser record (see MessageEvent.fallback) only gives a call record the length it lacked.
    if (event.fallback) {
      if (existing.type === "call" && existing.call_seconds === null && callSeconds !== null) {
        this.db.prepare("UPDATE message SET call_seconds = ?, last_source_id = ? WHERE id = ?").run(callSeconds, this.sourceId, existing.id);
        this.touchedCalls = true;
        this.counts.messages.updated++;
      } else {
        this.counts.messages.unchanged++;
      }
      return;
    }
    if (existing.unsent) {
      // Once retracted, always retracted: an older source cannot bring the text back.
      this.counts.messages.unchanged++;
      return;
    }
    if (unsent) {
      this.db.prepare("DELETE FROM message_version WHERE message_id = ?").run(existing.id);
      this.db
        .prepare("UPDATE message SET unsent = 1, text = NULL, raw_json = ?, last_source_id = ? WHERE id = ?")
        .run(raw, this.sourceId, existing.id);
      this.touch(event.sentAt, existing.type);
      this.counts.messages.updated++;
      return;
    }
    // A record of the message from before its latest edit (a live source's walk sees the original) changes nothing.
    if (existing.edited_at !== null && (event.editedAt ?? -Infinity) < existing.edited_at) {
      this.counts.messages.unchanged++;
      return;
    }
    const editedAt = event.editedAt ?? existing.edited_at;
    // A message an older import could not tell the kind of (as WhatsApp's call records once were) takes the kind a
    // newer one gives it, and its reading of who sent it; a kind once known is never lost to a source that cannot tell.
    const type = existing.type === "other" ? event.type : existing.type;
    if (existing.text === text && existing.edited_at === editedAt && existing.call_seconds === callSeconds && existing.type === type) {
      this.counts.messages.unchanged++;
      return;
    }
    if (existing.text !== text) {
      this.db
        .prepare("INSERT INTO message_version (message_id, text, replaced_at, source_id) VALUES (?, ?, ?, ?)")
        .run(existing.id, existing.text, Date.now(), this.sourceId);
    }
    this.db
      .prepare(
        `UPDATE message SET type = ?, sender_account_id = CASE WHEN type = ? THEN sender_account_id ELSE ? END,
           is_from_self = CASE WHEN type = ? THEN is_from_self ELSE ? END, text = ?, edited_at = ?, call_seconds = ?, raw_json = ?,
           last_source_id = ? WHERE id = ?`,
      )
      .run(type, type, senderId, type, event.isFromSelf ? 1 : 0, text, editedAt, callSeconds, raw, this.sourceId, existing.id);
    this.touch(event.sentAt, type);
    this.counts.messages.updated++;
  }

  /**
   * A new text for a message already announced (in this source or before).
   * The text it replaces is kept in message_version; a retracted message
   * stays retracted, and an edit older than one already applied changes nothing.
   */
  private edit(event: EditEvent): void {
    const id = this.messageId(event.message);
    const existing = this.db.prepare("SELECT text, unsent, edited_at FROM message WHERE id = ?").get(id) as
      { text: string | null; unsent: number; edited_at: number | null };
    if (existing.unsent || existing.text === event.text || (existing.edited_at ?? -Infinity) > event.editedAt) {
      this.counts.messages.unchanged++;
      return;
    }
    this.db
      .prepare("INSERT INTO message_version (message_id, text, replaced_at, source_id) VALUES (?, ?, ?, ?)")
      .run(id, existing.text, Date.now(), this.sourceId);
    this.db
      .prepare("UPDATE message SET text = ?, edited_at = ?, last_source_id = ? WHERE id = ?")
      .run(event.text, event.editedAt, this.sourceId, id);
    this.counts.messages.edited++;
  }

  private aliasOf(id: string): number | null {
    const row = this.db
      .prepare("SELECT message_id FROM message_alias WHERE platform = ? AND platform_message_id = ?")
      .get(this.platform, id) as { message_id: number } | undefined;
    return row?.message_id ?? null;
  }

  /** The message another connector brought in that has this sender and millisecond, if there is one. */
  private twinOf(sentAt: number, senderId: number | null): number | null {
    const candidates = this.db
      .prepare(
        `SELECT m.id, m.sender_account_id AS sender, a.display_name AS name FROM message m
         JOIN source s ON s.id = m.first_source_id LEFT JOIN import_person a ON a.id = m.sender_account_id
         WHERE m.platform = ? AND m.sent_at = ? AND s.connector IS NOT ? ORDER BY m.id`,
      )
      .all(this.platform, sentAt, this.connector) as { id: number; sender: number | null; name: string | null }[];
    if (candidates.length === 0) return null;
    const exact = candidates.find((c) => c.sender === senderId);
    if (exact) return exact.id;
    // Each connector gives an unknown account a key of its own, so "Facebook user" is matched by its label.
    const name = senderId === null ? null
      : (this.db.prepare("SELECT display_name FROM import_person WHERE id = ?").get(senderId) as { display_name: string }).display_name;
    if (name === null || !isPlaceholderName(name)) return null;
    return candidates.find((c) => c.name !== null && isPlaceholderName(c.name) && nameKey(c.name) === nameKey(name))?.id ?? null;
  }

  private reaction(event: ReactionEvent): void {
    const { changes } = this.db
      .prepare("INSERT OR IGNORE INTO reaction (message_id, actor_account_id, emoji, added_at, source_id) VALUES (?, ?, ?, ?, ?)")
      .run(this.messageId(event.message), this.accountId(event.actor), event.emoji, event.addedAt ?? null, this.sourceId);
    this.counts.reactions.added += Number(changes);
  }

  private attachment(event: AttachmentEvent): void {
    const messageId = this.messageId(event.message);
    const stored = event.stored ?? event.inPlace;
    const localPath = localPathOf(event, this.dataDir);
    if (stored) this.counts.attachments.stored++;
    else this.counts.attachments.missing++;
    // A message matched to another connector's record keeps the attachments that source gave it.
    if (this.aliased.has(event.message)) return;
    const fields = [
      event.platformAttachmentId ?? null, event.type, event.filename ?? null, event.mime ?? null,
      stored?.size ?? null, stored?.sha256 ?? null, localPath,
    ];
    const existing = this.db
      .prepare(
        `SELECT id, platform_attachment_id, type, filename, mime, size, sha256, local_path
         FROM attachment WHERE message_id = ? AND ordinal = ?`,
      )
      .get(messageId, event.ordinal) as Record<string, unknown> | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO attachment (message_id, ordinal, platform_attachment_id, type, filename, mime, size, sha256, local_path, source_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(messageId, event.ordinal, ...fields, this.sourceId);
      this.counts.attachments.added++;
      return;
    }
    // A file the source lacked before and has now fills the gap; one it has lost since keeps the file already there,
    // and so does one from an earlier export than the file's (homeRank): the newest export holding a file wins.
    if (existing.local_path !== null && (localPath === null || homeRank(localPath) < homeRank(existing.local_path as string))) return;
    const current = [
      existing.platform_attachment_id, existing.type, existing.filename, existing.mime,
      existing.size, existing.sha256, existing.local_path,
    ];
    if (current.every((value, i) => value === fields[i])) return;
    this.db
      .prepare(
        `UPDATE attachment SET platform_attachment_id = ?, type = ?, filename = ?, mime = ?, size = ?, sha256 = ?,
           local_path = ?, source_id = ? WHERE id = ?`,
      )
      .run(...fields, this.sourceId, existing.id as number);
    this.counts.attachments.updated++;
  }

  /**
   * Whether a call record is for a call the archive keeps as a call in no chat (see the top of this file), in which
   * case it is that call: it gives the call its length if the call had none, and adds nothing.
   */
  private keptAsCallInNoChat(event: MessageEvent): boolean {
    const rows = this.db.prepare("SELECT duration_seconds FROM call WHERE platform = ? AND platform_call_id = ?").all(this.platform, event.id) as
      Array<{ duration_seconds: number | null }>;
    if (rows.length === 0) return false;
    if (event.callSeconds !== undefined && rows.every((row) => row.duration_seconds === null)) {
      this.db
        .prepare("UPDATE call SET duration_seconds = ?, answered = ?, last_source_id = ? WHERE platform = ? AND platform_call_id = ?")
        .run(event.callSeconds, event.callSeconds > 0 ? 1 : 0, this.sourceId, this.platform, event.id);
      this.touchedCalls = true;
      this.counts.calls.updated++;
    } else {
      this.counts.calls.unchanged++;
    }
    return true;
  }

  /**
   * A call, keyed on the source's own id for it: a newer copy of the history adds only new calls, and brings a
   * changed one up to date (its original record with it; a record that differs only in the copy's own row numbers
   * changes nothing). A call the archive keeps as a call record (a message with its id) is that call, and only gives
   * it a length it had none of (see the top of this file). A call with several people is one row for each account it
   * names, sharing its id, and keeps the people its first source named, with its unnamed others: a copy's list of who
   * was on a call can be wrong (the Mac app's Calls tab often is), so a newer record brings only its time, length,
   * way and service up to date. A call with one person keeps its row's number when the account it is with changes.
   */
  private call(event: CallEvent): void {
    const record = this.callRecordOf(event.id);
    if (record) {
      if (record.call_seconds === null && event.durationSeconds !== undefined) {
        this.db.prepare("UPDATE message SET call_seconds = ?, last_source_id = ? WHERE id = ?").run(event.durationSeconds, this.sourceId, record.id);
        this.touchedCalls = true;
        this.counts.calls.updated++;
      } else {
        this.counts.calls.unchanged++;
      }
      return;
    }
    const accounts = [event.with, ...(event.alsoWith ?? [])].map((key) => this.accountId(key));
    const raw = JSON.stringify(event.raw);
    const rows = this.db
      .prepare(
        `SELECT id, import_person_id, at, duration_seconds, direction, answered, service, others, first_source_id FROM call
         WHERE platform = ? AND platform_call_id = ? ORDER BY id`,
      )
      .all(this.platform, event.id) as Array<Record<string, number | string | null>>;
    const insert = this.db.prepare(
      `INSERT INTO call (platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service, others,
         raw_json, first_source_id, last_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const about = [event.at, event.durationSeconds ?? null, event.direction, event.answered ? 1 : 0, event.service];
    if (rows.length === 0) {
      for (const account of accounts) insert.run(this.platform, event.id, account, ...about, event.others ?? 0, raw, this.sourceId, this.sourceId);
      this.touchedCalls = true;
      this.counts.calls.added++;
      return;
    }
    const update = this.db.prepare(
      `UPDATE call SET import_person_id = ?, at = ?, duration_seconds = ?, direction = ?, answered = ?, service = ?, others = ?, raw_json = ?,
         last_source_id = ? WHERE id = ?`,
    );
    const same = (row: Record<string, number | string | null>) =>
      [row.at, row.duration_seconds, row.direction, row.answered, row.service].every((value, i) => value === about[i]);
    if (rows.length === 1 && accounts.length === 1) {
      // With one person: its row, whoever it is with now.
      const [row] = rows;
      if (row.import_person_id === accounts[0] && same(row) && row.others === (event.others ?? 0)) {
        this.counts.calls.unchanged++;
        return;
      }
      update.run(accounts[0], ...about, event.others ?? 0, raw, this.sourceId, row.id);
      this.touchedCalls = true;
      this.counts.calls.updated++;
      return;
    }
    // With several: the people on it stay as they are.
    if (rows.every(same)) {
      this.counts.calls.unchanged++;
      return;
    }
    for (const row of rows) update.run(row.import_person_id, ...about, row.others, raw, this.sourceId, row.id);
    this.touchedCalls = true;
    this.counts.calls.updated++;
  }

  /** The call record (a message, by its id or an alias of it) a call's id names, if the archive keeps one. */
  private callRecordOf(id: string): { id: number; call_seconds: number | null } | null {
    const byId = this.db.prepare("SELECT id, call_seconds FROM message WHERE platform = ? AND platform_message_id = ?").get(this.platform, id) as
      { id: number; call_seconds: number | null } | undefined;
    if (byId) return byId;
    const alias = this.aliasOf(id);
    return alias === null ? null : (this.db.prepare("SELECT id, call_seconds FROM message WHERE id = ?").get(alias) as { id: number; call_seconds: number | null });
  }

  private coverage(event: CoverageEvent): void {
    const conversationId = event.conversation === undefined ? null : this.conversationId(event.conversation);
    this.db
      .prepare("INSERT INTO coverage_span (platform, conversation_id, source_id, from_ms, to_ms, kind) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.platform, conversationId, this.sourceId, event.from, event.to, this.sourceKind);
    this.counts.coverageSpans++;
  }

  private accountId(key: string): number {
    return this.lookup(this.accounts, key, "SELECT id FROM import_person WHERE platform = ? AND key = ?", "an account");
  }

  private conversationId(key: string): number {
    return this.lookup(
      this.conversations, key,
      "SELECT id FROM conversation WHERE platform = ? AND platform_conversation_id = ?", "a conversation",
    );
  }

  private messageId(key: string): number {
    return this.lookup(this.messages, key, "SELECT id FROM message WHERE platform = ? AND platform_message_id = ?", "a message");
  }

  private lookup(cache: Map<string, number>, key: string, sql: string, what: string): number {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(sql).get(this.platform, key) as { id: number } | undefined;
    // The key can be a display name, so the error names only what kind of thing is missing.
    if (!row) throw new EventOrderError(`an event refers to ${what} that no earlier event announced`);
    cache.set(key, row.id);
    return row.id;
  }
}

function withoutText(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const { text: _text, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/** A name that only stands in for one: a placeholder, or only a number (see the top of this file). */
function isStandIn(name: string, source: string | null): boolean {
  return source === "none" || source === "number" || isPlaceholderName(name) || isNumberName(name);
}

/**
 * Friend map's connectors' imports (sdk/server.ts's ModuleConnectors' `apply`): one import's (or one live batch's)
 * checked events applied to the archive `db` through ImportSession, inside the host's transaction of it; what it
 * touched handed to `after` once that has committed (friendMap.ts's afterApply: the calendar's push, and after a live
 * batch the rules).
 */
export function applyChats(
  events: Iterable<ArchiveEvent>,
  db: Db,
  source: AppliedSource,
  after: (touched: Touched, counts: ImportCounts, live: boolean) => void,
): { counts: ImportCounts; rows: never[]; afterCommit: () => void } {
  const session = new ImportSession(db, source.platform, source.id, source.kind, { seenAt: source.seenAt, dataDir: source.folder });
  for (const event of events) session.apply(event);
  const touched = session.touched();
  return { counts: session.counts, rows: [], afterCommit: () => after(touched, session.counts, source.kind === "live") };
}
