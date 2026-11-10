// A small, entirely made-up copy of the Messages app's own database in the
// layouts the iPhone and the Mac keep it (see connectors/imessage-db/read.ts),
// for tests:
//
//   iPhone backup   Library/SMS/sms.db, with attachments at Library/SMS/Attachments/...
//   Mac             chat.db, with attachments at Attachments/... (and none of the files)
//
// Only the tables and columns the connector reads are made, with the real
// names. It has what the real database has that matters: one number with an
// iMessage handle and an SMS handle, each with a chat of its own; a person
// reached by email; a business that texts from a name; a number not in the
// address book; a group with a name, a group everyone else has left, and a
// chat with two people that is not marked as a group; the captain's own
// email as a chat; a chat with nobody in it; text in `text` and text only in
// attributedBody; tapbacks (one taken back, one with any emoji, one on a
// message not in the database); an edit and a message taken back; a link with
// its preview's data file; a contact card, an audio message, a sticker, a
// photo on disk and a video that is not; a message whose attachment row is
// gone; a reply; group events; a group
// message whose sender's handle is gone; a date in old iOS's seconds; and a
// message in no chat. Names and numbers come from writeAddressBookFixture.
//
// `copy: "mac"` is the Mac's copy of the same account: other row ids, the
// same guids, only some of the messages plus two newer ones, and no files.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Nanoseconds since 2001-01-01, as the Messages app stores dates since iOS 11. */
const ns = (iso: string) => (BigInt(Date.parse(iso)) - 978_307_200_000n) * 1_000_000n;
/** Seconds since 2001-01-01, as older iOS stored them. */
const seconds = (iso: string) => BigInt(Date.parse(iso) / 1000 - 978_307_200);

export const IM_PEOPLE = {
  ada: "+61491571266",
  adaEmail: "ada@example.com",
  bruno: "+61491571491",
  cleo: "+61491571804",
  unsaved: "+61491574118",
  business: "Telstra",
  dana: "dana@example.org",
  /** The captain's own email, on his address book card. */
  self: "riley@example.com",
} as const;

export const IM_GROUP = { id: "chat100200300", title: "Climbing crew" };
export const IM_LEFT_GROUP = { id: "chat100200999" };
export const IM_UNMARKED_GROUP = { id: "chat100200555" };

const HANDLES: Array<[number, string, string]> = [
  [1, IM_PEOPLE.ada, "iMessage"],
  [2, IM_PEOPLE.ada, "SMS"],
  [3, IM_PEOPLE.adaEmail, "iMessage"],
  [4, IM_PEOPLE.bruno, "iMessage"],
  [5, IM_PEOPLE.unsaved, "SMS"],
  [6, IM_PEOPLE.business, "SMS"],
  [7, IM_PEOPLE.dana, "iMessage"],
  [8, IM_PEOPLE.self, "iMessage"],
  [9, IM_PEOPLE.cleo, "iMessage"],
];

interface FixtureChat {
  rowid: number;
  guid: string;
  identifier: string;
  style: number | null;
  title?: string;
  handles: number[];
}

const CHATS: FixtureChat[] = [
  { rowid: 1, guid: `any;-;${IM_PEOPLE.ada}`, identifier: IM_PEOPLE.ada, style: 45, handles: [1] },
  { rowid: 2, guid: `SMS;-;${IM_PEOPLE.ada}`, identifier: IM_PEOPLE.ada, style: 45, handles: [2] },
  { rowid: 3, guid: `iMessage;-;${IM_PEOPLE.adaEmail}`, identifier: IM_PEOPLE.adaEmail, style: 45, handles: [3] },
  { rowid: 4, guid: `any;-;${IM_PEOPLE.bruno}`, identifier: IM_PEOPLE.bruno, style: 45, handles: [4] },
  { rowid: 5, guid: `SMS;-;${IM_PEOPLE.unsaved}`, identifier: IM_PEOPLE.unsaved, style: 45, handles: [5] },
  { rowid: 6, guid: `SMS;-;${IM_PEOPLE.business}`, identifier: IM_PEOPLE.business, style: 45, handles: [6] },
  { rowid: 7, guid: `any;+;${IM_GROUP.id}`, identifier: IM_GROUP.id, style: 43, title: IM_GROUP.title, handles: [1, 4, 9] },
  { rowid: 8, guid: `any;+;${IM_LEFT_GROUP.id}`, identifier: IM_LEFT_GROUP.id, style: 43, handles: [9] },
  { rowid: 9, guid: `any;-;${IM_PEOPLE.dana}`, identifier: IM_PEOPLE.dana, style: 45, handles: [7] },
  { rowid: 10, guid: `any;-;${IM_PEOPLE.self}`, identifier: IM_PEOPLE.self, style: 45, handles: [8] },
  { rowid: 11, guid: "any;-;+61491576398", identifier: "+61491576398", style: 45, handles: [] },
  { rowid: 12, guid: `any;+;${IM_UNMARKED_GROUP.id}`, identifier: IM_UNMARKED_GROUP.id, style: null, handles: [4, 5] },
];

interface FixtureAttachment {
  guid: string;
  path: string;
  mime: string;
  sticker?: boolean;
  /** Whether the file is on disk (in the iPhone copy). */
  present: boolean;
}

interface FixtureMessage {
  guid: string;
  chat: number | null;
  /** The handle row: the sender, or the other person in a one-to-one chat; 0 for none. */
  handle: number;
  fromMe?: boolean;
  date: string;
  /** Old iOS's seconds rather than nanoseconds. */
  inSeconds?: boolean;
  service?: string;
  text?: string;
  /** Text kept only in attributedBody, as newer iOS does. */
  body?: string;
  itemType?: number;
  groupTitle?: string;
  tapback?: { type: number; target: string; emoji?: string };
  balloon?: string;
  replyTo?: string;
  edited?: string;
  attachments?: FixtureAttachment[];
  /** Only in the Mac's copy. */
  macOnly?: boolean;
  /** In the Mac's copy too. */
  onMac?: boolean;
}

const OBJ = "￼";
const at = (path: string) => `Attachments/${path}`;

export const IM_MESSAGES: FixtureMessage[] = [
  { guid: "M001", chat: 1, handle: 1, date: "2025-10-04T21:30:00+10:00", service: "iMessage", text: "Are you free Saturday?", onMac: true },
  { guid: "M002", chat: 1, handle: 1, fromMe: true, date: "2025-10-04T21:31:00+10:00", service: "iMessage", body: "Yes! Where?", onMac: true },
  {
    guid: "M003", chat: 1, handle: 1, date: "2025-10-04T21:32:00+10:00", service: "iMessage", text: OBJ, onMac: true,
    attachments: [{ guid: "A003", path: at("0a/10/A003/IMG_0001.HEIC"), mime: "image/heic", present: true }],
  },
  {
    guid: "M004", chat: 1, handle: 1, fromMe: true, date: "2025-10-04T21:33:00+10:00", service: "iMessage", text: `${OBJ}Top out`,
    attachments: [{ guid: "A004", path: at("0b/11/A004/top-out.mov"), mime: "video/quicktime", present: false }],
  },
  { guid: "M005", chat: 1, handle: 1, date: "2025-10-04T21:34:00+10:00", service: "iMessage", tapback: { type: 2000, target: "p:0/M002" } },
  { guid: "M006", chat: 1, handle: 1, fromMe: true, date: "2025-10-04T21:35:00+10:00", service: "iMessage", tapback: { type: 2001, target: "p:0/M003" } },
  { guid: "M007", chat: 1, handle: 1, fromMe: true, date: "2025-10-04T21:36:00+10:00", service: "iMessage", tapback: { type: 3001, target: "p:0/M003" } },
  { guid: "M008", chat: 1, handle: 1, fromMe: true, date: "2025-10-04T21:37:00+10:00", service: "iMessage", body: "See you at 9", edited: "2025-10-04T21:38:00+10:00" },
  { guid: "M009", chat: 1, handle: 1, fromMe: true, date: "2025-10-04T21:39:00+10:00", service: "iMessage", edited: "2025-10-04T21:40:00+10:00" },
  {
    guid: "M010", chat: 1, handle: 1, date: "2025-10-05T08:00:00+10:00", service: "iMessage", text: "https://example.com/crag",
    balloon: "com.apple.messages.URLBalloonProvider",
    attachments: [{ guid: "A010", path: at("0c/12/A010/B1C2.pluginPayloadAttachment"), mime: "", present: true }],
  },
  {
    guid: "M011", chat: 1, handle: 1, date: "2025-10-05T08:01:00+10:00", service: "iMessage", text: OBJ,
    attachments: [{ guid: "A011", path: at("0d/13/A011/Cleo Example.vcf"), mime: "text/vcard", present: true }],
  },
  { guid: "M012", chat: 1, handle: 1, date: "2025-10-05T08:02:00+10:00", service: "iMessage", text: "Bring the rope", replyTo: "M001" },
  { guid: "M013", chat: 1, handle: 1, date: "2025-10-05T08:03:00+10:00", service: "iMessage", tapback: { type: 2006, target: "p:0/M012", emoji: "🔥" } },
  { guid: "M014", chat: 1, handle: 1, date: "2025-10-05T08:04:00+10:00", service: "iMessage", tapback: { type: 2000, target: "p:0/GONE" } },
  // Its attachment's row is gone; only the placeholder is left.
  { guid: "M015", chat: 1, handle: 1, date: "2025-10-05T08:05:00+10:00", service: "iMessage", text: OBJ },
  { guid: "M020", chat: 2, handle: 2, date: "2024-05-01T10:00:00+10:00", service: "SMS", text: "New number, it's Ada", onMac: true },
  { guid: "M021", chat: 2, handle: 2, fromMe: true, date: "2024-05-01T10:05:00+10:00", service: "SMS", text: "Saved!", onMac: true },
  { guid: "M030", chat: 3, handle: 3, date: "2025-01-02T09:00:00+10:00", service: "iMessage", text: "From my laptop" },
  { guid: "M040", chat: 4, handle: 4, date: "2025-11-01T12:00:00+10:00", service: "iMessage", text: "Lunch?", onMac: true },
  {
    guid: "M041", chat: 4, handle: 4, fromMe: true, date: "2025-11-01T12:01:00+10:00", service: "iMessage", text: OBJ,
    attachments: [{ guid: "A041", path: at("0e/14/A041/Audio Message.caf"), mime: "audio/x-caf", present: true }],
  },
  {
    guid: "M042", chat: 4, handle: 4, date: "2025-11-01T12:02:00+10:00", service: "iMessage", text: OBJ,
    attachments: [{ guid: "A042", path: at("0f/15/A042/sticker.png"), mime: "image/png", sticker: true, present: true }],
  },
  { guid: "M050", chat: 5, handle: 5, date: "2016-03-01T10:00:00+11:00", inSeconds: true, service: "SMS", text: "Is this Riley?" },
  { guid: "M060", chat: 6, handle: 6, date: "2025-12-01T10:00:00+11:00", service: "SMS", text: "Your bill is ready" },
  { guid: "M070", chat: 7, handle: 0, fromMe: true, date: "2026-01-10T10:00:00+11:00", service: "iMessage", itemType: 1 },
  { guid: "M071", chat: 7, handle: 9, date: "2026-01-10T10:01:00+11:00", service: "iMessage", text: "Hi all", onMac: true },
  { guid: "M072", chat: 7, handle: 0, fromMe: true, date: "2026-01-10T10:02:00+11:00", service: "iMessage", body: "Welcome Cleo", onMac: true },
  { guid: "M073", chat: 7, handle: 4, date: "2026-01-10T10:03:00+11:00", service: "iMessage", text: "Hey Cleo" },
  { guid: "M074", chat: 7, handle: 0, date: "2026-01-10T10:04:00+11:00", service: "iMessage", text: "Who is this?" },
  { guid: "M075", chat: 7, handle: 4, date: "2026-01-10T10:05:00+11:00", service: "iMessage", itemType: 2, groupTitle: IM_GROUP.title },
  { guid: "M080", chat: 8, handle: 9, date: "2026-02-01T10:00:00+11:00", service: "iMessage", text: "Just us now" },
  { guid: "M081", chat: 8, handle: 0, fromMe: true, date: "2026-02-01T10:01:00+11:00", service: "iMessage", text: "Ha" },
  { guid: "M090", chat: 9, handle: 7, date: "2026-03-01T10:00:00+11:00", service: "iMessage", text: "Hello from Dana" },
  { guid: "M100", chat: 10, handle: 8, fromMe: true, date: "2026-04-01T10:00:00+11:00", service: "iMessage", text: "Note to self" },
  { guid: "M120", chat: 12, handle: 4, date: "2026-05-01T10:00:00+10:00", service: "iMessage", text: "Three of us" },
  { guid: "M121", chat: 12, handle: 5, date: "2026-05-01T10:01:00+10:00", service: "SMS", text: "Hi" },
  { guid: "M999", chat: null, handle: 1, date: "2026-06-01T10:00:00+10:00", service: "iMessage", text: "Lost" },
  { guid: "M200", chat: 1, handle: 1, date: "2026-09-20T10:00:00+10:00", service: "iMessage", text: "Climbing Sunday?", macOnly: true },
  { guid: "M201", chat: 7, handle: 9, date: "2026-09-21T09:25:00+10:00", service: "iMessage", text: "Anyone?", macOnly: true },
];

/** Writes the Messages app's database and attachments into `folder`, in the iPhone backup's layout or the Mac's. */
export async function writeMessagesFixture(folder: string, { copy = "iphone" }: { copy?: "iphone" | "mac" } = {}): Promise<string> {
  const mac = copy === "mac";
  const file = mac ? join(folder, "chat.db") : join(folder, "Library", "SMS", "sms.db");
  await mkdir(dirname(file), { recursive: true });
  // The Mac's row ids are its own.
  const offset = mac ? 500 : 0;
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL,
        uncanonicalized_id TEXT, person_centric_id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER,
        chat_identifier TEXT, service_name TEXT, display_name TEXT, group_id TEXT, last_read_message_timestamp INTEGER DEFAULT 0);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0,
        subject TEXT, attributedBody BLOB, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
        cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0,
        associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, message_summary_info BLOB,
        destination_caller_id TEXT, thread_originator_guid TEXT, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0,
        associated_message_emoji TEXT);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0,
        filename TEXT, uti TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0,
        hide_attachment INTEGER DEFAULT 0);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
    `);
    const insertHandle = db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)");
    for (const [rowid, id, service] of HANDLES) insertHandle.run(rowid + offset, id, service);
    const insertChat = db.prepare(
      "INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name, last_read_message_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const joinHandle = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
    for (const chat of CHATS) {
      insertChat.run(
        chat.rowid + offset, chat.guid, chat.style, chat.identifier, chat.guid.split(";")[0], chat.title ?? null, ns("2026-09-27T10:00:00+10:00"),
      );
      for (const handle of chat.handles) joinHandle.run(chat.rowid + offset, handle + offset);
    }
    const insertMessage = db.prepare(
      `INSERT INTO message (ROWID, guid, text, handle_id, attributedBody, service, date, is_from_me, cache_has_attachments, item_type,
         group_title, associated_message_guid, associated_message_type, associated_message_emoji, balloon_bundle_id,
         thread_originator_guid, date_edited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const joinChat = db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)");
    const insertAttachment = db.prepare(
      "INSERT INTO attachment (ROWID, guid, created_date, filename, mime_type, transfer_name, is_sticker) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const joinAttachment = db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)");
    let rowid = offset;
    let attachmentRowid = offset;
    for (const message of IM_MESSAGES) {
      if (mac ? !(message.onMac || message.macOnly) : message.macOnly) continue;
      rowid++;
      const date = message.inSeconds ? seconds(message.date) : ns(message.date);
      const handle = message.handle === 0 ? 0 : message.handle + offset;
      insertMessage.run(
        rowid, message.guid, message.text ?? null, handle, message.body === undefined ? null : encodeAttributedBody(message.body),
        message.service ?? null, date, message.fromMe ? 1 : 0, message.attachments ? 1 : 0, message.itemType ?? 0,
        message.groupTitle ?? null, message.tapback?.target ?? null, message.tapback?.type ?? 0, message.tapback?.emoji ?? null,
        message.balloon ?? null, message.replyTo ?? null, message.edited ? ns(message.edited) : 0,
      );
      if (message.chat !== null) joinChat.run(message.chat + offset, rowid, date);
      for (const attachment of message.attachments ?? []) {
        attachmentRowid++;
        const home = mac ? "~/Library/Messages" : "~/Library/SMS";
        insertAttachment.run(
          attachmentRowid, attachment.guid, date, `${home}/${attachment.path}`, attachment.mime || null,
          attachment.path.split("/").at(-1)!, attachment.sticker ? 1 : 0,
        );
        joinAttachment.run(rowid, attachmentRowid);
        if (!mac && attachment.present) {
          const onDisk = join(dirname(file), attachment.path);
          await mkdir(dirname(onDisk), { recursive: true });
          // Placeholder bytes, not real media.
          await writeFile(onDisk, `placeholder ${attachment.guid}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return file;
}

/** An attributedBody holding `text`, shaped like the typedstream archives the Messages app writes. */
export function encodeAttributedBody(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const u16 = (value: number) => Buffer.from([value & 0xff, value >> 8]);
  const length =
    body.length < 0x80 ? Buffer.from([body.length])
    : body.length <= 0xffff ? Buffer.concat([Buffer.from([0x81]), u16(body.length)])
    : Buffer.concat([Buffer.from([0x82]), Buffer.from(new Uint32Array([body.length]).buffer)]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped"), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from("NSAttributedString\0"), Buffer.from([0x84, 0x84, 0x08]), Buffer.from("NSObject\0"),
    Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 0x08]), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), length, body,
    Buffer.from([0x86, 0x84, 0x02]), Buffer.from("iI"), Buffer.from([0x01, 0x81]), u16(text.length),
    Buffer.from([0x92, 0x84, 0x84, 0x84, 0x0c]), Buffer.from("NSDictionary\0"), Buffer.from([0x94, 0x84, 0x01, 0x69, 0x01, 0x86, 0x86]),
  ]);
}
