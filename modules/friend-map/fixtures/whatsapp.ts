// A small, entirely made-up copy of WhatsApp's own databases in the layout the
// iPhone and Mac apps keep (see connectors/whatsapp-db/read.ts), for tests:
//
//   ChatStorage.sqlite   chats, messages, group members, media items, push names
//   ContactsV2.sqlite    the address book as WhatsApp sees it
//   LID.sqlite           which phone number each LID (WhatsApp's newer account id) belongs to
//   Message/Media/...    the media files, at the paths the media items name
//
// and, from writeAddressBookFixture, the iPhone's own AddressBook.sqlitedb.
//
// Only the tables and columns the connector reads are made, with the real
// names. It has what the real databases have that matters: a person known by
// their phone JID in one place and by their LID in another (resolved through
// LID.sqlite, the chat list or ContactsV2), a number that is not in the address
// book, a one-to-one chat keyed by LID, a LID with only a push name and one with
// nothing, people named only by their chat, a push name on a message, a group's
// member list or nothing at all, the captain listed among a group's members, a
// community's announcements group, every message type the
// connector maps, a deleted message, system messages (one without a stanza
// id), media on disk and missing, a broadcast list (skipped) whose message
// has copies with the same stanza id in two chats, status updates (skipped),
// and a message in no chat.
//
// `copy: "mac"` makes the other copy of the same account: different Core Data
// row ids, Bruno's chat keyed by his LID, only this year's messages plus two
// newer ones, and no media files. The media bytes are placeholders, not images.
// `calls: true` adds WhatsApp's calls: call records in the chats (type 59, each
// with WhatsApp's CallLogMessage in its media item's ZMETADATA, as the iPhone
// keeps it), and CallHistory.sqlite, the Calls tab, holding some of the same
// calls and some no chat records (WA_CALLS says which).
// `backup: true` shapes the iPhone copy like the real iPhone backup the
// connector first met: no ContactsV2.sqlite, and the captain's own group
// messages name no member row, so only his address book card says which
// member row is his.
// `macApp: true` (with `copy: "mac"` and `calls: true`) shapes the Mac copy
// like the real Mac app's: its LID.sqlite holds no LID's number, and its
// Calls tab (WA_MAC_HISTORY_CALLS) lists one participant on nearly every call,
// often not the person the call was with, and lacks the oldest calls; it also
// has a call the iPhone copy does not, only in its Calls tab, with Ada by her
// LID (WA_CALLS.macEvening). writeBridgeLidMap writes the bridge's database
// that knows those LIDs' numbers.
// In either copy's Calls tab an outgoing call is dated when it ended (its
// start plus its length), as WhatsApp dates them; a fixture's `date` is when
// it started.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Seconds since 2001-01-01, as Core Data stores dates, for a wall-clock time with its offset. */
const at = (iso: string) => Date.parse(iso) / 1000 - 978_307_200;

const phoneJid = (digits: string) => `${digits}@s.whatsapp.net`;

export const WA_PEOPLE = {
  ada: { phone: "61491571266", lid: "100000000000001@lid", name: "Ada Sample" },
  bruno: { phone: "61491571491", lid: "100000000000002@lid", name: "Bruno Placeholder" },
  cleo: { phone: "61491571804", name: "Cleo Example" },
  /** Not in the address book: WhatsApp shows their chat by number, and has the push name they set. */
  unsaved: { phone: "61491574118", pushName: "Sunny" },
  /** A one-to-one chat keyed by LID, named only by that chat; their messages carry a push name too. */
  dana: { phone: "61491572549", lid: "100000000000004@lid", chatName: "Dana Lee", pushName: "D" },
  /** A group member by LID, named only by the group's member list. */
  fern: { phone: "61491572665", lid: "100000000000005@lid", firstName: "Fern" },
  /** A member of the community's announcements group with no name anywhere. */
  hal: { phone: "61491572983" },
  /** A group member named only by the push name on their message. */
  ivy: { phone: "61491573087", pushName: "Ivy" },
  /** Known only by LID and push name. */
  gus: { lid: "100000000000007@lid", pushName: "Gus Unlisted" },
  /** Known only by LID. */
  stranger: { lid: "100000000000008@lid" },
  /** The captain, listed among the group's members. */
  self: { phone: "61491570737" },
} as const;

export const WA_GROUP = { jid: "120363000000000001@g.us", title: "Climbing crew" };
export const WA_COMMUNITY = { jid: "120363000000000002@g.us", title: "Climbing club" };

type Chat = "ada" | "bruno" | "unsaved" | "dana" | "group" | "community" | "broadcast" | "status" | null;
type Member = "self" | "ada" | "cleo" | "gus" | "stranger" | "fern" | "ivy" | "hal";

interface FixtureMessage {
  stanza: string | null;
  chat: Chat;
  fromMe?: boolean;
  /** The group member who sent it, for group messages not from the captain. */
  member?: Member;
  /** The sender's push name, which WhatsApp keeps on each message. */
  pushName?: string;
  date: string;
  type: number;
  text?: string;
  media?: { path?: string; title?: string; vcardName?: string; latitude?: number; longitude?: number; file?: string; metadata?: Uint8Array };
  /** Only in the Mac copy: newer than the iPhone copy. */
  macOnly?: boolean;
}

const ADA_MEDIA = "Media/61491571266@s.whatsapp.net";

export const WA_MESSAGES: FixtureMessage[] = [
  { stanza: "3A00000000000000A001", chat: "ada", date: "2025-10-04T21:30:00+10:00", type: 0, text: "Are you around this weekend?" },
  { stanza: "3A00000000000000A002", chat: "ada", fromMe: true, date: "2025-10-04T21:45:00+10:00", type: 0, text: "Yes! Climbing on Sunday?" },
  {
    stanza: "3A00000000000000A003", chat: "ada", date: "2025-10-05T18:02:00+11:00", type: 1,
    media: { path: `${ADA_MEDIA}/a/1/crag-view.jpg`, title: "The crag", file: "placeholder bytes: not an image (1)" },
  },
  // The media item names a file the copy does not have.
  { stanza: "3A00000000000000A004", chat: "ada", fromMe: true, date: "2025-10-05T18:10:00+11:00", type: 2, media: { path: `${ADA_MEDIA}/b/2/top-out.mp4` } },
  {
    stanza: "3A00000000000000A005", chat: "ada", date: "2025-10-05T18:20:00+11:00", type: 3,
    media: { path: `${ADA_MEDIA}/c/3/voice.opus`, file: "placeholder bytes: not audio (2)" },
  },
  {
    stanza: "3A00000000000000A006", chat: "ada", fromMe: true, date: "2025-10-06T08:00:00+11:00", type: 8,
    media: { path: `${ADA_MEDIA}/d/4/route-guide.pdf`, title: "route-guide.pdf", file: "placeholder bytes: not a pdf (3)" },
  },
  // Deleted by its sender: WhatsApp keeps the row, without its text.
  { stanza: "3A00000000000000A007", chat: "ada", date: "2025-10-06T08:05:00+11:00", type: 14 },
  // "Security code changed": a system message, and one of those without a stanza id.
  { stanza: null, chat: "ada", date: "2025-12-01T10:00:00+11:00", type: 10 },
  { stanza: "3A00000000000000A009", chat: "ada", date: "2026-09-20T19:30:00+10:00", type: 0, text: "Dinner at mine next week?" },
  { stanza: "3A00000000000000A010", chat: "ada", fromMe: true, date: "2026-09-21T09:00:00+10:00", type: 5, media: { latitude: -37.81, longitude: 144.96 } },
  { stanza: "3A00000000000000A011", chat: "ada", date: "2026-09-21T09:05:00+10:00", type: 4, text: "Bruno Placeholder", media: { vcardName: "Bruno Placeholder" } },
  { stanza: "3A00000000000000A012", chat: "ada", fromMe: true, date: "2026-09-21T09:10:00+10:00", type: 7, text: "https://example.com/route-guide" },
  {
    stanza: "3A00000000000000A013", chat: "ada", date: "2026-09-21T09:15:00+10:00", type: 15,
    media: { path: `${ADA_MEDIA}/e/5/sticker.webp`, file: "placeholder bytes: not a sticker (4)" },
  },
  // WhatsApp's GIFs are short videos.
  {
    stanza: "3A00000000000000A014", chat: "ada", fromMe: true, date: "2026-09-21T09:20:00+10:00", type: 11,
    media: { path: `${ADA_MEDIA}/f/6/wave.mp4`, file: "placeholder bytes: not a gif (5)" },
  },
  { stanza: "3A00000000000000A015", chat: "ada", date: "2026-09-21T09:25:00+10:00", type: 99 },

  { stanza: "3A00000000000000B001", chat: "bruno", date: "2026-03-02T12:00:00+11:00", type: 0, text: "Long time! Coffee soon?" },
  { stanza: "3A00000000000000B002", chat: "bruno", fromMe: true, date: "2026-03-02T12:21:00+11:00", type: 0, text: "Yes, Thursday?" },
  { stanza: "3A00000000000000B003", chat: "bruno", date: "2026-09-26T08:00:00+10:00", type: 0, text: "Thursday again?", macOnly: true },

  { stanza: "3A00000000000000C001", chat: "unsaved", date: "2024-05-01T10:00:00+10:00", type: 0, text: "Hi, is this still available?" },
  { stanza: "3A00000000000000C002", chat: "unsaved", fromMe: true, date: "2024-05-01T10:30:00+10:00", type: 0, text: "Sorry, it's gone." },

  // "You created group": a system message the captain's own action caused.
  { stanza: "3A00000000000000G000", chat: "group", fromMe: true, date: "2026-07-31T20:00:00+10:00", type: 6 },
  { stanza: "3A00000000000000G001", chat: "group", member: "gus", date: "2026-08-01T09:00:00+10:00", type: 0, text: "Gym at 6 tonight?" },
  { stanza: "3A00000000000000G002", chat: "group", member: "cleo", date: "2026-08-01T09:05:00+10:00", type: 0, text: "I'm in." },
  { stanza: "3A00000000000000G003", chat: "group", member: "ada", date: "2026-08-01T09:06:00+10:00", type: 0, text: "Me too." },
  // The captain's own message names the captain's member row, which is how the connector knows that row is the captain.
  { stanza: "3A00000000000000G004", chat: "group", fromMe: true, member: "self", date: "2026-08-01T09:10:00+10:00", type: 0, text: "See you there." },
  { stanza: "3A00000000000000G005", chat: "group", member: "stranger", date: "2026-08-01T09:12:00+10:00", type: 0, text: "Who is this?" },
  { stanza: "3A00000000000000G006", chat: "group", member: "cleo", date: "2026-09-27T09:00:00+10:00", type: 0, text: "Same time next week?", macOnly: true },
  { stanza: "3A00000000000000G007", chat: "group", member: "fern", date: "2026-08-02T09:00:00+10:00", type: 0, text: "New here, hi!" },
  { stanza: "3A00000000000000G008", chat: "group", member: "ivy", pushName: "Ivy", date: "2026-08-02T09:30:00+10:00", type: 0, text: "Welcome!" },
  { stanza: "3A00000000000000M001", chat: "community", member: "hal", date: "2026-08-03T10:00:00+10:00", type: 0, text: "Club night moved to Friday." },
  { stanza: "3A00000000000000D001", chat: "dana", pushName: "D", date: "2026-08-04T10:00:00+10:00", type: 0, text: "Got your number from Ada" },

  // A broadcast list message, and its copies in the recipients' own chats, all with one stanza id.
  { stanza: "3A00000000000000X001", chat: "broadcast", fromMe: true, date: "2026-01-01T00:00:00+11:00", type: 0, text: "Happy new year!" },
  { stanza: "3A00000000000000X001", chat: "ada", fromMe: true, date: "2026-01-01T00:00:00+11:00", type: 0, text: "Happy new year!" },
  { stanza: "3A00000000000000X001", chat: "bruno", fromMe: true, date: "2026-01-01T00:00:00+11:00", type: 0, text: "Happy new year!" },
  { stanza: "3A00000000000000S001", chat: "status", date: "2026-02-01T12:00:00+11:00", type: 0, text: "At the beach" },
  { stanza: "3A00000000000000Z001", chat: null, date: "2026-02-02T12:00:00+11:00", type: 0, text: "Orphaned" },
];

/** The messages each copy holds: of `messages`, the fixture's own, or its call records. */
export function messagesIn(copy: "iphone" | "mac", messages: FixtureMessage[] = WA_MESSAGES): FixtureMessage[] {
  return copy === "iphone"
    ? messages.filter((m) => !m.macOnly)
    : messages.filter((m) => m.macOnly || Date.parse(m.date) >= Date.parse("2026-01-01T00:00:00+11:00"));
}

// --- Calls (`calls: true`)

/** A protobuf message's bytes, written field by field: a number as a varint, bytes or text length-delimited. */
function protobuf(...fields: Array<[number, number | string | Uint8Array]>): Uint8Array {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    do {
      const low = n % 128;
      n = Math.floor(n / 128);
      out.push(n > 0 ? low | 0x80 : low);
    } while (n > 0);
    return out;
  };
  return new Uint8Array(fields.flatMap(([field, value]) => {
    if (typeof value === "number") return [...varint(field * 8), ...varint(value)];
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
  }));
}

/**
 * A call record's ZMETADATA as the iPhone keeps it: a hash (68), and in 87 WhatsApp's CallLogMessage (1: video, 2:
 * outcome, 3: seconds, 5: the others on it), beside fields of its own. A field left at its default is not written.
 */
function callMetadata(log: { video?: boolean; outcome?: number; seconds?: number; with?: string[] }): Uint8Array {
  const fields: Array<[number, number | string | Uint8Array]> = [];
  if (log.video) fields.push([1, 1]);
  if (log.outcome) fields.push([2, log.outcome]);
  if (log.seconds) fields.push([3, log.seconds]);
  for (const jid of log.with ?? []) fields.push([5, protobuf([1, jid], [2, log.outcome ?? 0])]);
  return protobuf([68, new Uint8Array(32).fill(7)], [87, protobuf([1, protobuf(...fields)], [2, 0], [3, 1], [4, 0])]);
}

/** WhatsApp's id for each made-up call: a chat's call record's stanza id, and the Calls tab's ZCALLIDSTRING. */
export const WA_CALLS = {
  /** Ada called, video, 41 minutes: in her chat and the Calls tab, which says when it started. */
  adaVideo: "CA110000000000000000000000000001",
  /** The captain called Ada, and she did not answer: in her chat and the Calls tab. */
  adaUnanswered: "CA110000000000000000000000000002",
  /** Bruno called, and the captain answered on another device: in his chat and the Calls tab. */
  brunoElsewhere: "CA110000000000000000000000000003",
  /** Cleo started a video call in the group, 27 minutes: in the group's chat only. */
  groupVideo: "CA110000000000000000000000000004",
  /** A call record in Ada's chat with no media item, which the Calls tab does not list either. */
  adaBare: "CA110000000000000000000000000005",
  /** A call record in Ada's chat whose media item keeps no CallLogMessage; the Calls tab says 10 minutes. */
  adaFromHistory: "CA110000000000000000000000000006",
  /** Cleo called, 5 minutes: only in the Calls tab, and she has no one-to-one chat. */
  cleo: "CA220000000000000000000000000001",
  /** The captain called Bruno (by his LID), unanswered: only in the Calls tab. */
  brunoUnanswered: "CA220000000000000000000000000002",
  /** Ada called with Bruno and Cleo on it, in no group, 6 minutes 40: a call in no chat with the three of them. */
  adHoc: "CA220000000000000000000000000004",
  /** Bruno called, video, with Ada and a number the copy has no chat with: with the two, and one unnamed other; answered on another device. */
  withStranger: "CA220000000000000000000000000009",
  /** The captain called two numbers the copy has no chat with, in no group: left out. */
  strangersOnly: "CA220000000000000000000000000010",
  /** The captain called, and the Calls tab says no one else: left out. */
  nobody: "CA220000000000000000000000000005",
  /** The captain started a call in the group, 15 minutes: only in the Calls tab. */
  groupFromHistory: "CA220000000000000000000000000006",
  /** A call in a group the copy has no chat for: left out. */
  unknownGroup: "CA220000000000000000000000000007",
  /** Dana called (by her LID), answered on another device: only in the Calls tab. */
  danaElsewhere: "CA220000000000000000000000000008",
  /** Only in the Mac copy's Calls tab: the captain called Ada (by her LID), 5 minutes, just after her video call. */
  macEvening: "CA330000000000000000000000000001",
} as const;

/** Numbers no chat in the copy has, on calls with several people: numbers set aside for fiction. */
export const WA_STRANGERS = [phoneJid("61491570006"), phoneJid("61491570110")] as const;

/** The oldest call the Calls tab keeps, with no call id: Ada called, 2 minutes. */
export const WA_OLD_CALL_AT = "2023-06-01T10:00:00+10:00";

/** The call records in the chats. Each one's message time is when WhatsApp wrote it, which can be when the call ended. */
export const WA_CALL_MESSAGES: FixtureMessage[] = [
  { stanza: WA_CALLS.adaVideo, chat: "ada", date: "2026-09-22T20:41:00+10:00", type: 59, media: { metadata: callMetadata({ video: true, seconds: 2460 }) } },
  { stanza: WA_CALLS.adaUnanswered, chat: "ada", fromMe: true, date: "2026-09-23T08:00:00+10:00", type: 59, media: { metadata: callMetadata({ outcome: 1, with: [phoneJid(WA_PEOPLE.ada.phone)] }) } },
  { stanza: WA_CALLS.brunoElsewhere, chat: "bruno", date: "2026-03-03T19:00:00+11:00", type: 59, media: { metadata: callMetadata({ video: true, outcome: 4 }) } },
  { stanza: WA_CALLS.groupVideo, chat: "group", member: "cleo", date: "2026-08-05T20:27:00+10:00", type: 59, media: { metadata: callMetadata({ video: true, seconds: 1620 }) } },
  { stanza: WA_CALLS.adaBare, chat: "ada", date: "2025-11-01T10:00:00+11:00", type: 59 },
  { stanza: WA_CALLS.adaFromHistory, chat: "ada", fromMe: true, date: "2026-09-24T09:10:00+10:00", type: 59, media: {} },
];

interface HistoryCallFixture {
  id: string | null;
  date: string;
  /** Seconds connected, as a float, as the Calls tab keeps it. */
  duration: number;
  outcome: number;
  incoming: boolean;
  video?: boolean;
  creator?: string;
  group?: string;
  participants?: string[];
}

/** The Calls tab's calls (CallHistory.sqlite's own outcomes: 0 connected, 1 not answered, 5 answered on another device). */
export const WA_HISTORY_CALLS: HistoryCallFixture[] = [
  { id: null, date: WA_OLD_CALL_AT, duration: 120, outcome: 0, incoming: true, creator: phoneJid(WA_PEOPLE.ada.phone) },
  { id: WA_CALLS.brunoElsewhere, date: "2026-03-03T19:00:00+11:00", duration: 0, outcome: 5, incoming: true, video: true, creator: phoneJid(WA_PEOPLE.bruno.phone) },
  { id: WA_CALLS.cleo, date: "2026-09-10T18:00:00+10:00", duration: 300.6, outcome: 0, incoming: true, video: true, creator: phoneJid(WA_PEOPLE.cleo.phone) },
  { id: WA_CALLS.brunoUnanswered, date: "2026-09-11T12:00:00+10:00", duration: 0, outcome: 1, incoming: false, creator: phoneJid(WA_PEOPLE.self.phone), participants: [WA_PEOPLE.bruno.lid] },
  { id: WA_CALLS.adHoc, date: "2026-09-12T12:00:00+10:00", duration: 400, outcome: 0, incoming: true, creator: phoneJid(WA_PEOPLE.ada.phone), participants: [phoneJid(WA_PEOPLE.bruno.phone), phoneJid(WA_PEOPLE.cleo.phone)] },
  { id: WA_CALLS.withStranger, date: "2026-09-12T20:00:00+10:00", duration: 0, outcome: 5, incoming: true, video: true, creator: phoneJid(WA_PEOPLE.bruno.phone), participants: [WA_STRANGERS[0], phoneJid(WA_PEOPLE.ada.phone)] },
  { id: WA_CALLS.strangersOnly, date: "2026-09-12T21:00:00+10:00", duration: 90, outcome: 0, incoming: false, creator: phoneJid(WA_PEOPLE.self.phone), participants: [...WA_STRANGERS] },
  { id: WA_CALLS.nobody, date: "2026-09-13T12:00:00+10:00", duration: 0, outcome: 1, incoming: false, creator: phoneJid(WA_PEOPLE.self.phone) },
  { id: WA_CALLS.groupFromHistory, date: "2026-09-14T12:00:00+10:00", duration: 900, outcome: 0, incoming: false, group: WA_GROUP.jid, creator: phoneJid(WA_PEOPLE.self.phone) },
  { id: WA_CALLS.unknownGroup, date: "2026-09-15T12:00:00+10:00", duration: 60, outcome: 0, incoming: true, group: "120363000000000099@g.us", creator: phoneJid(WA_PEOPLE.ada.phone) },
  { id: WA_CALLS.danaElsewhere, date: "2026-09-16T12:00:00+10:00", duration: 0, outcome: 5, incoming: true, creator: WA_PEOPLE.dana.lid },
  { id: WA_CALLS.adaVideo, date: "2026-09-22T20:00:00+10:00", duration: 2460.4, outcome: 0, incoming: true, video: true, creator: phoneJid(WA_PEOPLE.ada.phone) },
  { id: WA_CALLS.adaUnanswered, date: "2026-09-23T08:00:00+10:00", duration: 0, outcome: 1, incoming: false, creator: phoneJid(WA_PEOPLE.self.phone), participants: [phoneJid(WA_PEOPLE.ada.phone)] },
  { id: WA_CALLS.adaFromHistory, date: "2026-09-24T09:00:00+10:00", duration: 600.2, outcome: 0, incoming: false, creator: phoneJid(WA_PEOPLE.self.phone), participants: [phoneJid(WA_PEOPLE.ada.phone)] },
];

/** The participant the Mac app lists, where it is not the one the iPhone copy lists. */
const MAC_PARTICIPANTS: Record<string, string[]> = {
  [WA_CALLS.adaVideo]: [phoneJid(WA_PEOPLE.cleo.phone)],
  [WA_CALLS.cleo]: [phoneJid(WA_PEOPLE.ada.phone)],
  [WA_CALLS.adHoc]: [phoneJid(WA_PEOPLE.ada.phone)],
  [WA_CALLS.withStranger]: [phoneJid(WA_PEOPLE.cleo.phone)],
  [WA_CALLS.brunoElsewhere]: [WA_PEOPLE.bruno.lid],
  [WA_CALLS.danaElsewhere]: [WA_PEOPLE.dana.lid],
};

/**
 * The Mac app's Calls tab: the calls of this year (it lacks the oldest), each with the one participant it lists,
 * which for an incoming call is often someone else than whoever called (Cleo on Ada's video call, Ada on Cleo's), and
 * for the three-way calls only the one who started it; Ada's call whose record in her chat says nothing more of it,
 * 61 seconds; and a call of its own, macEvening.
 */
export const WA_MAC_HISTORY_CALLS: HistoryCallFixture[] = [
  { id: WA_CALLS.adaBare, date: "2025-11-01T10:00:00+11:00", duration: 61, outcome: 0, incoming: true, creator: phoneJid(WA_PEOPLE.ada.phone), participants: [phoneJid(WA_PEOPLE.cleo.phone)] },
  ...WA_HISTORY_CALLS.filter((call) => Date.parse(call.date) >= Date.parse("2026-01-01T00:00:00+11:00") && !call.group
    && call.id !== WA_CALLS.strangersOnly && call.id !== WA_CALLS.nobody)
    .map((call): HistoryCallFixture => ({ ...call, participants: MAC_PARTICIPANTS[call.id!] ?? call.participants })),
  { id: WA_CALLS.macEvening, date: "2026-09-22T20:45:00+10:00", duration: 300, outcome: 0, incoming: false, creator: phoneJid(WA_PEOPLE.self.phone), participants: [WA_PEOPLE.ada.lid] },
];

/** Writes a WhatsApp bridge's database (mautrix-whatsapp.db) whose LID map knows Ada's and Dana's numbers, at `file`. */
export function writeBridgeLidMap(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE message (bridge_id TEXT, id TEXT, part_id TEXT, mxid TEXT, room_id TEXT);
      CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL);
      CREATE TABLE whatsmeow_device (jid TEXT PRIMARY KEY, lid TEXT, registration_id BIGINT NOT NULL);
    `);
    const pair = db.prepare("INSERT INTO whatsmeow_lid_map VALUES (?, ?)");
    for (const person of [WA_PEOPLE.ada, WA_PEOPLE.dana]) pair.run(person.lid.replace("@lid", ""), person.phone);
    db.prepare("INSERT INTO whatsmeow_device VALUES (?, ?, 1)").run(`${WA_PEOPLE.self.phone}:12@s.whatsapp.net`, "100000000000000:12@lid");
  } finally {
    db.close();
  }
}

/** Writes the Calls tab, CallHistory.sqlite, into `dir`, its Core Data row ids the copy's own. */
function writeCallHistory(dir: string, firstPk: number, calls: HistoryCallFixture[]): void {
  const db = new DatabaseSync(join(dir, "CallHistory.sqlite"));
  let pk = firstPk;
  try {
    db.exec(`
      CREATE TABLE ZWAAGGREGATECALLEVENT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINCOMING INTEGER, ZMISSED INTEGER,
        ZVIDEO INTEGER, ZFIRSTDATE TIMESTAMP, ZMISSEDREASON INTEGER, ZLINKTOKEN VARCHAR);
      CREATE TABLE ZWACDCALLEVENT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZBYTESRECEIVED INTEGER, ZBYTESSENT INTEGER,
        ZOUTCOME INTEGER, Z1CALLEVENTS INTEGER, Z_FOK_1CALLEVENTS INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZCALLIDSTRING VARCHAR,
        ZGROUPCALLCREATORUSERJIDSTRING VARCHAR, ZGROUPJIDSTRING VARCHAR);
      CREATE TABLE ZWACDCALLEVENTPARTICIPANT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOUTCOME INTEGER,
        Z1PARTICIPANTS INTEGER, Z_FOK_1PARTICIPANTS INTEGER, ZJIDSTRING VARCHAR);
    `);
    const aggregate = db.prepare("INSERT INTO ZWAAGGREGATECALLEVENT (Z_PK, Z_ENT, Z_OPT, ZINCOMING, ZMISSED, ZVIDEO, ZFIRSTDATE, ZMISSEDREASON) VALUES (?, 1, 1, ?, ?, ?, ?, 1)");
    const call = db.prepare(
      `INSERT INTO ZWACDCALLEVENT (Z_PK, Z_ENT, Z_OPT, ZBYTESRECEIVED, ZBYTESSENT, ZOUTCOME, Z1CALLEVENTS, ZDATE, ZDURATION, ZCALLIDSTRING,
         ZGROUPCALLCREATORUSERJIDSTRING, ZGROUPJIDSTRING) VALUES (?, 2, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const participant = db.prepare("INSERT INTO ZWACDCALLEVENTPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZOUTCOME, Z1PARTICIPANTS, ZJIDSTRING) VALUES (?, 3, 1, ?, ?, ?)");
    // Newest first, as the Calls tab lists them; the connector puts them in time order itself.
    for (const fixture of [...calls].reverse()) {
      const row = pk++;
      const callRow = pk++;
      const missed = fixture.incoming && fixture.duration === 0 && fixture.outcome !== 5 ? 1 : 0;
      // An outgoing call is dated when it ended.
      const date = at(fixture.date) + (fixture.incoming ? 0 : fixture.duration);
      aggregate.run(row, fixture.incoming ? 1 : 0, missed, fixture.video ? 1 : 0, date);
      call.run(callRow, fixture.outcome, row, date, fixture.duration, fixture.id, fixture.creator ?? null, fixture.group ?? null);
      for (const jid of fixture.participants ?? []) participant.run(pk++, fixture.outcome, callRow, jid);
    }
  } finally {
    db.close();
  }
}

const CHAT_SCHEMA = `
  CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZSESSIONTYPE INTEGER, ZCONTACTJID VARCHAR,
    ZCONTACTIDENTIFIER VARCHAR, ZPARTNERNAME VARCHAR, ZLASTMESSAGEDATE TIMESTAMP, ZARCHIVED INTEGER, ZHIDDEN INTEGER, ZREMOVED INTEGER);
  CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZISACTIVE INTEGER, ZISADMIN INTEGER,
    ZCHATSESSION INTEGER, ZCONTACTNAME VARCHAR, ZFIRSTNAME VARCHAR, ZMEMBERJID VARCHAR);
  CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZISFROMME INTEGER, ZMESSAGESTATUS INTEGER,
    ZMESSAGETYPE INTEGER, ZGROUPEVENTTYPE INTEGER, ZFLAGS INTEGER, ZSORT INTEGER, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER,
    ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER, ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZFROMJID VARCHAR, ZTOJID VARCHAR,
    ZPUSHNAME VARCHAR, ZSTANZAID VARCHAR, ZTEXT VARCHAR);
  CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZMESSAGE INTEGER, ZFILESIZE INTEGER,
    ZMOVIEDURATION INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZMEDIALOCALPATH VARCHAR, ZMEDIAURL VARCHAR, ZTITLE VARCHAR,
    ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZMEDIAKEY BLOB, ZMETADATA BLOB);
  CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR);
`;

/** Writes one copy of the made-up account into `dir`. */
export async function writeWhatsAppFixture(
  dir: string,
  { copy = "iphone", backup = false, calls = false, macApp = false }: { copy?: "iphone" | "mac"; backup?: boolean; calls?: boolean; macApp?: boolean } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const mac = copy === "mac";
  if (macApp && !(mac && calls)) throw new Error("macApp shapes the Mac copy's calls: give copy: \"mac\" and calls: true");
  // Core Data row ids are the copy's own; the two copies number rows differently.
  let pk = mac ? 500 : 1;
  const next = () => pk++;

  const chats = new DatabaseSync(join(dir, "ChatStorage.sqlite"));
  try {
    chats.exec("PRAGMA journal_mode = WAL");
    chats.exec(CHAT_SCHEMA);
    const session = chats.prepare(
      "INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, ZSESSIONTYPE, ZCONTACTJID, ZCONTACTIDENTIFIER, ZPARTNERNAME) VALUES (?, 5, ?, ?, ?, ?)",
    );
    const sessions: Record<Exclude<Chat, null>, number> = {
      ada: next(), bruno: next(), unsaved: next(), dana: next(), group: next(), community: next(), broadcast: next(), status: next(),
    };
    // WhatsApp's name for a chat is the captain's name for the person when it has one; Ada's here is its own, to tell them apart.
    session.run(sessions.ada, 0, phoneJid(WA_PEOPLE.ada.phone), null, "Ada");
    // A chat keyed by phone names the person's LID; the Mac copy keys Bruno's chat by his LID instead.
    session.run(sessions.bruno, 0, mac ? WA_PEOPLE.bruno.lid : phoneJid(WA_PEOPLE.bruno.phone), mac ? null : WA_PEOPLE.bruno.lid, WA_PEOPLE.bruno.name);
    // WhatsApp typesets a number: direction marks around it, no-break spaces and a non-breaking hyphen within.
    session.run(sessions.unsaved, 0, phoneJid(WA_PEOPLE.unsaved.phone), null, "\u202a+61\u00a0491\u00a0574\u2011118\u202c");
    session.run(sessions.dana, 0, WA_PEOPLE.dana.lid, WA_PEOPLE.dana.lid, WA_PEOPLE.dana.chatName);
    session.run(sessions.group, 1, WA_GROUP.jid, null, WA_GROUP.title);
    session.run(sessions.community, 4, WA_COMMUNITY.jid, null, WA_COMMUNITY.title);
    session.run(sessions.broadcast, 2, "1700000000@broadcast", null, "Neighbours");
    session.run(sessions.status, 3, "status@broadcast", null, null);

    const member = chats.prepare(
      "INSERT INTO ZWAGROUPMEMBER (Z_PK, Z_ENT, ZISACTIVE, ZCHATSESSION, ZCONTACTNAME, ZFIRSTNAME, ZMEMBERJID) VALUES (?, 6, 1, ?, ?, ?, ?)",
    );
    const members = Object.fromEntries(
      (["self", "ada", "cleo", "gus", "stranger", "fern", "ivy", "hal"] as const).map((name) => [name, next()]),
    ) as Record<Member, number>;
    member.run(members.self, sessions.group, null, null, phoneJid(WA_PEOPLE.self.phone));
    member.run(members.ada, sessions.group, WA_PEOPLE.ada.name, null, WA_PEOPLE.ada.lid);
    member.run(members.cleo, sessions.group, WA_PEOPLE.cleo.name, null, phoneJid(WA_PEOPLE.cleo.phone));
    member.run(members.gus, sessions.group, null, null, WA_PEOPLE.gus.lid);
    member.run(members.stranger, sessions.group, null, null, WA_PEOPLE.stranger.lid);
    member.run(members.fern, sessions.group, null, WA_PEOPLE.fern.firstName, WA_PEOPLE.fern.lid);
    member.run(members.ivy, sessions.group, null, null, phoneJid(WA_PEOPLE.ivy.phone));
    member.run(members.hal, sessions.community, "\u202a+61\u00a0491\u00a0572\u00a0983\u202c", null, phoneJid(WA_PEOPLE.hal.phone));

    const pushName = chats.prepare("INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, Z_ENT, ZJID, ZPUSHNAME) VALUES (?, 7, ?, ?)");
    pushName.run(next(), WA_PEOPLE.gus.lid, WA_PEOPLE.gus.pushName);
    pushName.run(next(), phoneJid(WA_PEOPLE.unsaved.phone), WA_PEOPLE.unsaved.pushName);

    const insertMessage = chats.prepare(
      `INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, ZISFROMME, ZMESSAGETYPE, ZCHATSESSION, ZGROUPMEMBER, ZMEDIAITEM, ZMESSAGEDATE,
         ZSENTDATE, ZFROMJID, ZTOJID, ZPUSHNAME, ZSTANZAID, ZTEXT) VALUES (?, 9, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMedia = chats.prepare(
      `INSERT INTO ZWAMEDIAITEM (Z_PK, Z_ENT, ZMESSAGE, ZFILESIZE, ZLATITUDE, ZLONGITUDE, ZMEDIALOCALPATH, ZTITLE, ZVCARDNAME, ZMEDIAKEY, ZMETADATA)
       VALUES (?, 8, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of [...messagesIn(copy), ...(calls ? messagesIn(copy, WA_CALL_MESSAGES) : [])]) {
      const id = next();
      const chat = message.chat === null ? null : sessions[message.chat];
      const chatJid = message.chat === null ? null : (chats.prepare("SELECT ZCONTACTJID FROM ZWACHATSESSION WHERE Z_PK = ?")
        .get(chat) as { ZCONTACTJID: string | null }).ZCONTACTJID;
      const mediaId = message.media ? next() : null;
      const date = at(message.date);
      // The backup's own group messages name no member row.
      const memberRow = message.member && !(backup && message.fromMe) ? members[message.member] : null;
      insertMessage.run(
        id, message.fromMe ? 1 : 0, message.type, chat, memberRow, mediaId, date, date,
        message.fromMe ? null : chatJid, message.fromMe ? chatJid : null, message.pushName ?? null, message.stanza, message.text ?? null,
      );
      if (message.media && mediaId !== null) {
        const { path, title, vcardName, latitude, longitude, file, metadata } = message.media;
        insertMedia.run(
          mediaId, id, file?.length ?? null, latitude ?? null, longitude ?? null, path ?? null, title ?? null, vcardName ?? null,
          new Uint8Array([1, 2, 3]), metadata ?? null,
        );
        if (path && file && !mac) {
          await mkdir(dirname(join(dir, "Message", path)), { recursive: true });
          await writeFile(join(dir, "Message", path), file);
        }
      }
    }
  } finally {
    chats.close();
  }

  if (!backup) writeContactsV2(dir);
  if (calls) writeCallHistory(dir, mac ? 900 : 300, macApp ? WA_MAC_HISTORY_CALLS : WA_HISTORY_CALLS);

  const lids = new DatabaseSync(join(dir, "LID.sqlite"));
  try {
    lids.exec("CREATE TABLE ZWAZACCOUNT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR, ZPHONENUMBER VARCHAR)");
    lids.exec("CREATE TABLE ZWAPHONENUMBERLIDPAIR (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZLID VARCHAR, ZPHONENUMBER VARCHAR)");
    // The Mac app's knows no LID's number.
    if (macApp) return;
    // Identifiers without their @lid, and a number with its +: the connector reads either form.
    const account = lids.prepare("INSERT INTO ZWAZACCOUNT (Z_ENT, ZIDENTIFIER, ZPHONENUMBER) VALUES (1, ?, ?)");
    account.run(WA_PEOPLE.ada.lid.replace("@lid", ""), `+${WA_PEOPLE.ada.phone}`);
    account.run(WA_PEOPLE.fern.lid, WA_PEOPLE.fern.phone);
    // A LID with no number known.
    account.run(WA_PEOPLE.gus.lid, null);
    lids.prepare("INSERT INTO ZWAPHONENUMBERLIDPAIR (Z_ENT, ZLID, ZPHONENUMBER) VALUES (2, ?, ?)").run(WA_PEOPLE.dana.lid, WA_PEOPLE.dana.phone);
  } finally {
    lids.close();
  }
}

function writeContactsV2(dir: string): void {
  const contacts = new DatabaseSync(join(dir, "ContactsV2.sqlite"));
  try {
    contacts.exec(`CREATE TABLE ZWAADDRESSBOOKCONTACT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFULLNAME VARCHAR,
      ZGIVENNAME VARCHAR, ZPHONENUMBER VARCHAR, ZWHATSAPPID VARCHAR, ZLID VARCHAR, ZIDENTIFIER VARCHAR)`);
    const contact = contacts.prepare(
      "INSERT INTO ZWAADDRESSBOOKCONTACT (Z_PK, Z_ENT, ZFULLNAME, ZGIVENNAME, ZPHONENUMBER, ZWHATSAPPID, ZLID) VALUES (?, 1, ?, ?, ?, ?, ?)",
    );
    contact.run(1, WA_PEOPLE.ada.name, "Ada", "+61 491 571 266", phoneJid(WA_PEOPLE.ada.phone), null);
    // Bruno's LID is not in LID.sqlite: the iPhone copy's chat list names it, the Mac copy's only this.
    contact.run(2, WA_PEOPLE.bruno.name, "Bruno", "0491 571 491", phoneJid(WA_PEOPLE.bruno.phone), WA_PEOPLE.bruno.lid);
    contact.run(3, WA_PEOPLE.cleo.name, "Cleo", "+61491571804", phoneJid(WA_PEOPLE.cleo.phone), null);
    // An address book entry without WhatsApp.
    contact.run(4, "Plumber", null, "+61 3 7010 0000", null, null);
  } finally {
    contacts.close();
  }
}

/**
 * Writes a made-up iPhone address book (AddressBook.sqlitedb) at `file`, with
 * numbers typed the ways real ones are: with a country code, in national form
 * with its trunk 0, with a 00 prefix, and with letters. The captain's own card
 * is his store's MeIdentifier.
 */
export function writeAddressBookFixture(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, First TEXT, Last TEXT, Middle TEXT, Organization TEXT,
        Department TEXT, Note TEXT, Kind INTEGER, JobTitle TEXT, Nickname TEXT, DisplayName TEXT);
      CREATE TABLE ABMultiValue (UID INTEGER PRIMARY KEY, record_id INTEGER, property INTEGER, identifier INTEGER, label INTEGER, value TEXT);
      CREATE TABLE ABMultiValueLabel (value);
      CREATE TABLE ABStore (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, MeIdentifier INTEGER);
    `);
    const person = db.prepare("INSERT INTO ABPerson (ROWID, First, Middle, Last, Organization, Kind) VALUES (?, ?, ?, ?, ?, ?)");
    const value = db.prepare("INSERT INTO ABMultiValue (record_id, property, value) VALUES (?, ?, ?)");
    const phone = (rowid: number, number: string) => value.run(rowid, 3, number);
    person.run(1, "Ada", null, "Sample", null, 0);
    phone(1, "+61 491 571 266");
    value.run(1, 4, "ada@example.com");
    person.run(2, "Bruno", null, "Placeholder", null, 0);
    phone(2, "0491 571 491");
    person.run(3, "Cleo", "M.", "Example", null, 0);
    phone(3, "0061 491-571-804");
    person.run(4, "Riley", null, "Captain", null, 0);
    phone(4, "+61491570737");
    value.run(4, 4, "riley@example.com");
    person.run(5, null, null, null, "Plumbing Co", 1);
    phone(5, "+61 3 7010 0000");
    person.run(6, null, null, null, "Apple", 1);
    phone(6, "1-555-MY-SAMPLE");
    // A second card with Ada's number, as a second account's copy of her; the first card's name is kept.
    person.run(7, "Ada", null, "S.", null, 0);
    phone(7, "+61 491571266");
    // A full name typed as the first name, the last name typed again; and a name that is one word twice.
    person.run(8, "Dana Example", null, "Example", null, 0);
    phone(8, "+44 7700 900008");
    person.run(9, "Li", null, "Li", null, 0);
    phone(9, "+1 202 555 0109");
    // A card whose name is only its number, as WhatsApp typesets one: passed over for any other name.
    person.run(10, "\u202a+61\u00a0491\u00a0574\u2011118\u202c", null, null, null, 0);
    phone(10, "+61 491 574 118");
    // What cards say beyond names (for people's notes): a company with a job title and a note of two lines, a
    // note alone, a department alone, a company's own card with a note, and the captain's own card.
    const about = db.prepare("UPDATE ABPerson SET Organization = ?, Department = ?, JobTitle = ?, Note = ? WHERE ROWID = ?");
    about.run("Sample Labs", null, "Engineer", "Met at the climbing gym.\nVegetarian.", 1);
    about.run(null, null, null, "  Lent me a tent  ", 2);
    about.run(null, "Research", null, null, 8);
    about.run("Plumbing Co", null, null, "Fixed the hot water", 5);
    about.run("Captain Pty Ltd", null, "Owner", "My own card", 4);
    db.prepare("INSERT INTO ABStore (ROWID, Name, MeIdentifier) VALUES (1, 'Local', 4)").run();
  } finally {
    db.close();
  }
}
