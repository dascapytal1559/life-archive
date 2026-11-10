// Reads the Messages app's own database: the iPhone's sms.db (taken out of a
// local iPhone backup, with its Library/SMS/Attachments/ folder) or the Mac's
// ~/Library/Messages/chat.db (with its Attachments/ folder), which share one
// schema and one set of ids, so iMessage, SMS and RCS all come in as one
// platform, "imessage".
//
//   handle                   one row per phone number or email on a service (the same number
//                            can have a row for iMessage and one for SMS)
//   chat                     one row per chat; style 43 is a group, 45 one-to-one
//   chat_handle_join         who is in each chat (the captain is never listed)
//   message                  guid, date, is_from_me, handle_id (the sender, or the other person
//                            in a one-to-one chat), service, text or attributedBody, tapbacks
//                            (associated_message_type), date_edited, date_retracted
//   chat_message_join        which chat each message is in
//   attachment               filename (~/Library/SMS/Attachments/... or ~/Library/Messages/Attachments/...),
//   message_attachment_join  mime_type, transfer_name, is_sticker
//   AddressBook.sqlitedb     the iPhone's own address book (see ../addressBook.ts), optional:
//                            in the folder; or the address book the `contacts` setting names,
//                            the iPhone's or the Mac's Contacts
//
// Everything is keyed on the database's own ids, never on row ids, which
// differ between the iPhone's copy and the Mac's, so importing the same copy
// again, or the other device's overlapping copy, adds only what is new:
// - an account is its handle: a phone number in E.164 (`+61491571266`), an
//   email in lowercase, or the sender name or short code a business texts
//   from; the captain's own account is `me`, and any number or email on his
//   own address book card, or in the `selfHandles` setting, is him;
// - a one-to-one chat is the other person's account key, so their iMessage
//   and SMS chats are one conversation; a group is its chat_identifier;
// - a message is its guid.
// A chat is a group when the Messages app says so (style 43) or when it has
// more than one other person, whichever way it was stored.
// An account is named by the captain's address book (by number or email),
// unless that name is only a number, or else shown as its handle, numbers matched as whatsapp-db matches them.
// Tallies count which named each.
// Dates are nanoseconds since 2001-01-01 (seconds on old iOS). Tapbacks
// (associated_message_type 2000 to 2007) become reactions on the message they
// point at, less those taken back later (3000 to 3007); they are not messages.
// Group events (item_type other than 0) are system messages without a sender.
// A message taken back ("unsent") is kept as unsent, without text. Text is the
// `text` column, or else the string inside `attributedBody` (typedstream.ts),
// less the placeholder characters that mark where attachments sit.
//
// The database is copied to a temporary folder and read there, so the source
// is never written to. Attachments are kept where they are in the folder
// (which must be under data/platform-exports/), hashed, and recorded as
// missing when the folder does not have them. Link
// previews' data files (.pluginPayloadAttachment) are left out: the message is
// a link, and the file is only how the preview was drawn.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type AccountEvent, type AttachmentType, type Connector, type HistoryOptions, isNumberName, isPhone, keepInPlace, mediaTypeOf, type MessageType, normalizeHandle } from "../../../../sdk/connector.ts";
import { importAddressBook, IPHONE_BOOK } from "../addressBook.ts";
import { columnsOf, isFile, openCopy, plain, type Row } from "../appDb.ts";
import { manifest } from "./manifest.ts";
import { attributedBodyText } from "./typedstream.ts";

/** The captain's own account key. */
export const SELF_KEY = "me";

/** Apple counts time from 2001-01-01; this is that moment in milliseconds since 1970. */
const APPLE_EPOCH_MS = 978_307_200_000;
/** Dates above this are nanoseconds (iOS 11 and later), below it seconds. */
const NANOSECOND_DATES = 100_000_000_000n;

const STYLE_GROUP = 43;
/** Tapbacks: 2000 + kind adds one, 3000 + kind takes it back. Kind 6 is any emoji, 7 a sticker. */
const TAPBACK_ADD = 2000;
const TAPBACK_REMOVE = 3000;
const TAPBACK_EMOJI: Record<number, string> = { 0: "❤️", 1: "👍", 2: "👎", 3: "😂", 4: "‼️", 5: "❓" };
const TAPBACK_ANY_EMOJI = 6;
const TAPBACK_STICKER = 7;
const LINK_BALLOON = "com.apple.messages.URLBalloonProvider";
const LINK_PREVIEW_DATA = ".pluginPayloadAttachment";
/** U+FFFC marks where an attachment sits in a message's text. */
const ATTACHMENT_PLACEHOLDER = "\uFFFC";
/** Fields that hold what someone wrote, left out of an unsent message's original record. */
const TEXT_FIELDS = ["text", "subject", "group_title"];
const UNKNOWN_NAME = "Unknown user";
/** Where the database sits, first match wins, when a folder is named: an iPhone backup's layout, then the Mac's. */
const DATABASES = [join("Library", "SMS", "sms.db"), "sms.db", "chat.db", join("Library", "Messages", "chat.db")];

/** Where an account's name came from, best first, each with the tally that counts it. */
const NAME_SOURCES = {
  addressBook: "accounts named from the address book",
  phone: "accounts shown by phone number",
  email: "accounts shown by email",
  handle: "accounts shown by the name or short code they text from",
} as const;

export const imessageDb: Connector = { manifest, history: readMessagesDb };

interface Chat {
  conversation: string;
  type: "direct" | "group";
  /** The other person, in a one-to-one chat. */
  partner?: string;
}

interface Tapback {
  target: string;
  actor: string;
  emoji: string;
  at: number | null;
}

export async function readMessagesDb({ sources, config, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("name one folder (or its sms.db or chat.db)");
  const [source] = sources;
  const tallies = new Map<string, number>();
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  const databasePath = await findDatabase(source);
  const folder = dirname(databasePath);
  const work = await mkdtemp(join(tmpdir(), "friend-map-imessage-"));
  const opened: DatabaseSync[] = [];
  try {
    const db = (await openCopy(databasePath, work))!;
    opened.push(db);
    requireColumns(db, "handle", ["ROWID", "id"]);
    requireColumns(db, "chat", ["ROWID", "chat_identifier"]);
    requireColumns(db, "chat_handle_join", ["chat_id", "handle_id"]);
    requireColumns(db, "chat_message_join", ["chat_id", "message_id"]);
    requireColumns(db, "message", ["ROWID", "guid", "date", "is_from_me", "handle_id"]);
    const messageColumns = new Set(columnsOf(db, "message"));
    const has = (column: string) => messageColumns.has(column);

    // The address book: the one the settings name (the iPhone's or the Mac's), which must be there, else the
    // iPhone's in the folder given.
    const addressBook = await importAddressBook(config.contacts, (await isFile(source)) ? dirname(source) : source, work);
    if (!addressBook) tally(`no ${IPHONE_BOOK}, so accounts are shown by their handles`);

    // Accounts, keyed on the handle itself.
    const selfHandles = new Set(
      (Array.isArray(config.selfHandles) ? config.selfHandles : [])
        .filter((handle): handle is string => typeof handle === "string" && handle !== "")
        .map(normalizeHandle),
    );
    const bookEntry = (key: string) =>
      !addressBook ? undefined
      : isPhone(key) ? addressBook.lookup(key.slice(1))
      : isEmail(key) ? addressBook.lookupEmail(key)
      : undefined;
    const keyOf = (handle: string): string => {
      const key = normalizeHandle(handle);
      return selfHandles.has(key) || bookEntry(key)?.self ? SELF_KEY : key;
    };
    const handleKeys = new Map<number, string>();
    for (const row of db.prepare("SELECT ROWID, id FROM handle").all() as Row[]) {
      const id = str(row.id);
      if (id) handleKeys.set(Number(row.ROWID), keyOf(id));
    }
    const nameOf = (key: string): { displayName: string; source: keyof typeof NAME_SOURCES } => {
      const name = bookEntry(key)?.name;
      if (name && !isNumberName(name)) return { displayName: name, source: "addressBook" };
      return { displayName: key, source: isPhone(key) ? "phone" : isEmail(key) ? "email" : "handle" };
    };
    const accountFor = (key: string): AccountEvent => {
      if (key === SELF_KEY) {
        const displayName = typeof config.selfName === "string" && config.selfName ? config.selfName : "Me";
        return { kind: "account", key, keyKind: "id", displayName, nameSource: "settings", isSelf: true };
      }
      const { displayName, source } = nameOf(key);
      return {
        kind: "account", key, keyKind: "id", displayName, nameSource: source,
        ...(isPhone(key) || isEmail(key) ? { handle: key } : {}),
      };
    };

    // Chats: who is in each (listed, and anyone who wrote in it), and so whether it is a group.
    // Only the columns read: others hold dates in nanoseconds, beyond what a JavaScript number holds exactly.
    const chatColumns = columnsOf(db, "chat");
    const chatRows = db
      .prepare(
        `SELECT ROWID, chat_identifier, ${["guid", "style", "display_name"].map((c) => (chatColumns.includes(c) ? c : `NULL AS ${c}`)).join(", ")}
         FROM chat ORDER BY ROWID`,
      )
      .all() as Row[];
    const people = new Map<number, Set<string>>(chatRows.map((row) => [Number(row.ROWID), new Set<string>()]));
    const addPerson = (chat: number, handle: number) => {
      const key = handleKeys.get(handle);
      if (key && key !== SELF_KEY) people.get(chat)?.add(key);
    };
    for (const row of db.prepare("SELECT chat_id, handle_id FROM chat_handle_join").all() as Row[]) {
      addPerson(Number(row.chat_id), Number(row.handle_id));
    }
    for (const row of db
      .prepare(
        `SELECT DISTINCT j.chat_id, m.handle_id FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
         WHERE m.is_from_me = 0 AND m.handle_id != 0`,
      )
      .all() as Row[]) {
      addPerson(Number(row.chat_id), Number(row.handle_id));
    }
    const chats = new Map<number, Chat>();
    const conversations = new Map<string, { type: "direct" | "group"; title?: string; members: Set<string> }>();
    for (const row of chatRows) {
      const rowid = Number(row.ROWID);
      const others = people.get(rowid)!;
      const identifier = str(row.chat_identifier) || str(row.guid);
      if (!identifier) {
        tally("chats without an id");
        continue;
      }
      if (row.style === STYLE_GROUP || others.size > 1) {
        chats.set(rowid, { conversation: identifier, type: "group" });
        const known = conversations.get(identifier) ?? { type: "group", members: new Set([SELF_KEY]) };
        known.title ||= str(row.display_name) || undefined;
        for (const key of others) known.members.add(key);
        conversations.set(identifier, known);
        continue;
      }
      // One-to-one: the other person, or the captain alone when he wrote to himself.
      const partner = [...others][0] ?? (keyOf(identifier) === SELF_KEY ? SELF_KEY : undefined);
      if (!partner) {
        tally("chats with nobody in them");
        continue;
      }
      chats.set(rowid, { conversation: partner, type: "direct", partner });
      const known = conversations.get(partner) ?? { type: "direct", members: new Set([SELF_KEY]) };
      known.members.add(partner);
      conversations.set(partner, known);
    }

    const announced = new Set<string>();
    const announce = async (key: string) => {
      if (announced.has(key)) return key;
      announced.add(key);
      if (key !== SELF_KEY) tally(NAME_SOURCES[nameOf(key).source]);
      await emit(accountFor(key));
      return key;
    };
    await announce(SELF_KEY);
    for (const [id, { type, title, members }] of conversations) {
      const memberList = [...members].sort();
      for (const key of memberList) await announce(key);
      const partner = memberList.find((key) => key !== SELF_KEY) ?? SELF_KEY;
      await emit({
        kind: "conversation",
        id,
        type,
        title: type === "group" ? (title ?? "") : accountFor(partner).displayName,
        members: memberList,
      });
    }

    const attachmentColumns = columnsOf(db, "attachment");
    const attachmentsOf =
      attachmentColumns.length > 0 && columnsOf(db, "message_attachment_join").length > 0
        ? db.prepare(
            `SELECT ${["guid", "filename", "mime_type", "transfer_name", "is_sticker"]
              .map((c) => (attachmentColumns.includes(c) ? `a.${c}` : `NULL AS ${c}`)).join(", ")}
             FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
             WHERE j.message_id = ? ORDER BY a.ROWID`,
          )
        : null;
    const { total } = db.prepare("SELECT count(*) AS total FROM message").get() as { total: number };
    const messages = db.prepare(
      `SELECT m.*, (SELECT min(j.chat_id) FROM chat_message_join j WHERE j.message_id = m.ROWID) AS chat_rowid
       FROM message m ORDER BY m.date, m.ROWID`,
    );
    // Dates in nanoseconds are beyond what a JavaScript number holds exactly.
    messages.setReadBigInts(true);
    const emitted = new Set<string>();
    const tapbacks: Array<Tapback & { add: boolean }> = [];
    const firstAt = new Map<string, number>();
    let lastAt = -Infinity;
    let done = 0;

    for (const row of messages.iterate() as Iterable<Row>) {
      if (++done % 1000 === 0) await emit({ kind: "progress", done, total, note: "messages" });
      const guid = str(row.guid);
      const chat = row.chat_rowid === null ? undefined : chats.get(Number(row.chat_rowid));
      if (!chat) {
        tally("messages in no chat");
        continue;
      }
      if (!guid) {
        tally("messages without an id");
        continue;
      }
      const sentAt = appleTime(row.date);
      if (sentAt === null) {
        tally("messages without a date");
        continue;
      }
      const fromMe = Number(row.is_from_me) === 1;
      const handleKey = handleKeys.get(Number(row.handle_id));
      const system = has("item_type") && Number(row.item_type) !== 0;
      let sender: string | null = null;
      if (fromMe) sender = SELF_KEY;
      else if (handleKey) sender = handleKey;
      else if (chat.type === "direct") sender = chat.partner!;
      else if (!system) {
        // A group message whose sender's handle is gone: an unknown account of that group.
        tally("group messages from an unknown sender");
        sender = `unknown@${chat.conversation}`;
        if (!announced.has(sender)) {
          announced.add(sender);
          await emit({ kind: "account", key: sender, keyKind: "id", displayName: UNKNOWN_NAME });
        }
      }
      if (system) sender = null;
      // Everyone who writes in a chat is among its members already; this only guards the order of events.
      if (sender) await announce(sender);

      // A tapback is a reaction on the message it points at, not a message.
      const associated = Number(row.associated_message_type ?? 0);
      if (associated >= TAPBACK_ADD && associated < TAPBACK_REMOVE + 1000) {
        const add = associated < TAPBACK_REMOVE;
        const kind = associated - (add ? TAPBACK_ADD : TAPBACK_REMOVE);
        const emoji = kind === TAPBACK_ANY_EMOJI ? str(row.associated_message_emoji) : TAPBACK_EMOJI[kind];
        const target = targetGuid(str(row.associated_message_guid));
        if (kind === TAPBACK_STICKER) tally("sticker tapbacks, left out");
        else if (!emoji) tally(`tapbacks of an unknown kind (${associated})`);
        else if (!target || !sender) tally("tapbacks without a message or sender");
        else tapbacks.push({ target, actor: sender, emoji, at: sentAt, add });
        continue;
      }
      if (associated !== 0) tally(`messages tied to another message (type ${associated})`);

      const files = attachmentsOf ? (attachmentsOf.all(row.ROWID) as Row[]) : [];
      const previews = files.filter((file) => str(file.transfer_name).endsWith(LINK_PREVIEW_DATA) || str(file.filename).endsWith(LINK_PREVIEW_DATA));
      if (previews.length > 0) tally("link preview data files, left out", previews.length);
      const attachments = files.filter((file) => !previews.includes(file));
      const body = row.attributedBody instanceof Uint8Array ? row.attributedBody : null;
      let written = str(row.text, false);
      if (!written && body) {
        const decoded = attributedBodyText(body);
        if (decoded === null) tally("texts that could not be read from attributedBody");
        written = decoded ?? "";
      }
      const pointsAtAttachments = written.includes(ATTACHMENT_PLACEHOLDER);
      written = written.replaceAll(ATTACHMENT_PLACEHOLDER, "").trim();
      if (pointsAtAttachments && files.length === 0) tally("messages whose attachments are no longer in the database");
      const retracted = has("date_retracted") && appleTime(row.date_retracted) !== null;
      const editedAt = has("date_edited") ? appleTime(row.date_edited) : null;
      // Taking a whole message back leaves it edited with nothing in it.
      const unsent = !system && (retracted || (editedAt !== null && !row.text && !body && files.length === 0));
      const service = str(row.service) || "unknown service";
      tally(`messages by ${service}`);

      await emit({
        kind: "message",
        id: guid,
        idKind: "platform",
        conversation: chat.conversation,
        sender,
        isFromSelf: fromMe || sender === SELF_KEY,
        sentAt,
        type: system ? "system" : unsent ? "text" : messageType(row, attachments, written),
        ...(written && !unsent ? { text: written } : {}),
        ...(unsent ? { unsent: true } : {}),
        ...(editedAt !== null && !unsent ? { editedAt } : {}),
        ...(str(row.thread_originator_guid) ? { replyTo: str(row.thread_originator_guid) } : {}),
        raw: compact(plain(row, unsent ? TEXT_FIELDS : [])),
      });
      emitted.add(guid);
      if (!firstAt.has(chat.conversation)) firstAt.set(chat.conversation, sentAt);
      lastAt = Math.max(lastAt, sentAt);

      if (unsent) continue;
      for (const [ordinal, file] of attachments.entries()) {
        const fileName = str(file.transfer_name) || basename(str(file.filename));
        const path = str(file.filename) ? await attachmentFile(folder, str(file.filename), tally) : null;
        const inPlace = path ? await keepInPlace(path) : undefined;
        if (!inPlace) tally("attachments not in the folder");
        const mime = str(file.mime_type) || mediaTypeOf(fileName).mime;
        await emit({
          kind: "attachment",
          message: guid,
          ordinal,
          type: attachmentType(file, fileName),
          ...(fileName ? { filename: fileName } : {}),
          ...(mime ? { mime } : {}),
          ...(str(file.guid) ? { platformAttachmentId: str(file.guid) } : {}),
          ...(inPlace ? { inPlace } : {}),
        });
      }
    }
    await emit({ kind: "progress", done, total, note: "messages" });

    // Tapbacks still standing: each taken back by a later one of its kind from the same person is left out.
    const standing = new Map<string, Tapback>();
    for (const { add, ...tapback } of tapbacks) {
      const key = [tapback.target, tapback.actor, tapback.emoji].join("\u001f");
      if (add) standing.set(key, tapback);
      else if (standing.delete(key)) tally("tapbacks taken back");
    }
    for (const { target, actor, emoji, at } of standing.values()) {
      if (!emitted.has(target)) {
        tally("tapbacks on messages not in the database");
        continue;
      }
      tally("tapbacks kept as reactions");
      await emit({ kind: "reaction", message: target, actor, emoji, ...(at !== null ? { addedAt: at } : {}) });
    }

    // The copy covers each chat from its first message to the newest message in the copy.
    for (const [conversation, from] of firstAt) await emit({ kind: "coverage", conversation, from, to: lastAt });
    if (firstAt.size > 0) await emit({ kind: "coverage", from: Math.min(...firstAt.values()), to: lastAt });
    for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
  } finally {
    for (const db of opened) db.close();
    await rm(work, { recursive: true, force: true });
  }
}

/** The database a source names: the file itself, or the first of DATABASES in the folder. */
async function findDatabase(source: string): Promise<string> {
  if (await isFile(source)) return source;
  for (const candidate of DATABASES) if (await isFile(join(source, candidate))) return join(source, candidate);
  throw new Error(`there is no sms.db or chat.db in ${source}`);
}

function requireColumns(db: DatabaseSync, table: string, needed: string[]): void {
  const columns = columnsOf(db, table);
  const missing = needed.filter((column) => !columns.includes(column));
  if (columns.length === 0) throw new Error(`the database has no ${table} table; is it the Messages app's sms.db or chat.db?`);
  if (missing.length > 0) throw new Error(`the database's ${table} has no ${missing.join(", ")}; its schema is not one this connector knows`);
}

/** Milliseconds since 1970 for an Apple date (nanoseconds or seconds since 2001), or null for none. */
export function appleTime(value: SQLOutputValue | undefined): number | null {
  if (value === null || value === undefined || value instanceof Uint8Array || typeof value === "string") return null;
  const big = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (big <= 0n) return null;
  const ms = big > NANOSECOND_DATES ? Number(big / 1_000_000n) : Number(big) * 1000;
  return ms + APPLE_EPOCH_MS;
}

/** The message a tapback points at: "p:0/<guid>" (a part of it), "bp:<guid>", or the bare guid. */
function targetGuid(associated: string): string {
  return associated.replace(/^p:\d+\//, "").replace(/^bp:/, "");
}

function messageType(row: Row, attachments: Row[], text: string): MessageType {
  const balloon = str(row.balloon_bundle_id);
  if (attachments.length > 0) {
    const mimes = attachments.map((file) => str(file.mime_type).toLowerCase());
    if (mimes.every((mime) => mime === "text/vcard" || mime === "text/x-vcard")) return "contact";
    if (mimes.every((mime) => mime === "text/x-vlocation")) return "location";
    return attachments.every((file) => Number(file.is_sticker) === 1) ? "sticker" : "media";
  }
  if (balloon === LINK_BALLOON) return "link";
  if (balloon) return "other";
  return text ? "text" : "other";
}

function attachmentType(file: Row, fileName: string): AttachmentType {
  if (Number(file.is_sticker) === 1) return "sticker";
  const mime = str(file.mime_type).toLowerCase();
  if (mime === "image/gif") return "gif";
  for (const type of ["image", "video", "audio"] as const) if (mime.startsWith(`${type}/`)) return type;
  return mime ? "file" : mediaTypeOf(fileName).type;
}

/**
 * The file an attachment names, if the folder has it. Paths are written from the device's home
 * (~/Library/SMS/Attachments/..., /var/mobile/Library/SMS/..., ~/Library/Messages/Attachments/...), and
 * are read from the database's own folder.
 */
async function attachmentFile(folder: string, filename: string, tally: (name: string) => void): Promise<string | null> {
  const relative = /(?:^|\/)Library\/(?:SMS|Messages)\/(.+)$/.exec(filename.replace(/\\/g, "/"))?.[1];
  const file = relative ? resolve(folder, relative) : null;
  if (!file || !file.startsWith(folder + sep)) {
    tally("attachment paths outside the Messages folder");
    return null;
  }
  return (await isFile(file)) ? file : null;
}

/** A record without its empty columns, which are most of the Messages app's many. */
function compact(record: Record<string, string | number | null>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== "")) as Record<string, string | number>;
}

function str(value: SQLOutputValue | undefined, trim = true): string {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
  return trim ? text.trim() : text;
}

function isEmail(key: string): boolean {
  return key.includes("@");
}
