// Reads WhatsApp's own databases from a folder: the files the iPhone app keeps
// (taken out of a local iPhone backup) or the Mac app keeps, which share one
// Core Data schema and one set of message ids.
//
//   ChatStorage.sqlite     ZWACHATSESSION (chats), ZWAMESSAGE, ZWAGROUPMEMBER,
//                          ZWAMEDIAITEM, ZWAPROFILEPUSHNAME (names people set themselves)
//   CallHistory.sqlite     ZWACDCALLEVENT, ZWAAGGREGATECALLEVENT, ZWACDCALLEVENTPARTICIPANT:
//                          the Calls tab (optional; see "Calls" below)
//   ContactsV2.sqlite      ZWAADDRESSBOOKCONTACT: address book names by JID and LID (optional;
//                          an iPhone backup has none)
//   LID.sqlite             ZWAZACCOUNT, ZWAPHONENUMBERLIDPAIR: the phone number behind each LID (optional)
//   Message/Media/...      media files, at the paths ZWAMEDIAITEM.ZMEDIALOCALPATH names
//   AddressBook.sqlitedb   the iPhone's own address book (see ../addressBook.ts), optional: beside
//                          ChatStorage.sqlite; or the address book the `contacts` setting names, the
//                          iPhone's or the Mac's Contacts
//
// Everything is keyed on WhatsApp's own ids, never on Core Data row ids (Z_PK),
// which differ between copies, so importing the same copy again, or the other
// app's overlapping copy, adds only what is new:
// - an account is its phone JID (`61491571266@s.whatsapp.net`) when its phone
//   number is known, directly or through its LID, and its LID (`...@lid`)
//   otherwise; the captain's own account is `me`, found by the numbers in the
//   settings, on his own address book card, or on a group member row one of
//   his messages names;
// - a chat is its JID: the other person's account key, or the group's `@g.us` JID;
// - a message is its stanza id (ZSTANZAID), with the chat added when the same
//   stanza id is in more than one chat (a broadcast list's copies), and a hash
//   of its chat, time, type and sender when it has none (some system messages).
// An account is named, first to last: the captain's address book (the iPhone's,
// matched by number, then ContactsV2), its one-to-one chat's name, the push
// name its owner set, its name in a group's member list, its phone number.
// Names that are only a number, however typeset (isNumberName), and the base64 protobuf
// messages the iPhone app keeps in ZWAMESSAGE.ZPUSHNAME and ZWAGROUPMEMBER.ZFIRSTNAME
// (isEncodedName) are passed over. Tallies count which named each.
// Dates are seconds since 2001-01-01. Status updates and broadcast lists are
// skipped. Deleted messages are kept as unsent, without text. System messages
// have no sender, so they never count as talking with anyone.
//
// Calls. WhatsApp keeps each call twice over: in CallHistory.sqlite, the Calls
// tab (a call, ZWACDCALLEVENT: when it started, how long it was connected, its
// outcome, its call id, and for a group call the group and who started it;
// the Calls tab's row it is in, ZWAAGGREGATECALLEVENT: which way it went and
// whether it was video; and the others on it, ZWACDCALLEVENTPARTICIPANT), and,
// since late 2023, as a call record in the chat it was made in: a message of
// type 59 whose stanza id is the call's id, and whose media item's ZMETADATA
// holds WhatsApp's CallLogMessage (field 87, then 1: video, outcome, how long
// in seconds, who was on it). Each call is one call record (a message of type
// "call", as the other apps' are), keyed by the call id, so the two copies of a
// call, and the same call in a newer copy or the Mac app's, are one: the chat's
// when it has one, else one made from the Calls tab in the chat it was made in
// (the person's one-to-one chat, made when there is none, or the group's),
// which only stands in for the chat's (MessageEvent.fallback: the Calls tab's
// length can be a second longer than the chat's record says). Its
// length is how long it was connected, 0 for one never answered, and none for
// one answered on another of the captain's devices (only that device knows how
// long), which the captain can then give one. A call the Calls tab keeps with
// several people and no group (a three-way call) is a call in no chat (a call
// event, kept apart from messages, by its call id): with everyone on it whom
// this copy knows (anyone in one of its chats), and the rest counted as its
// unnamed others, with which way it went, voice or video, whether it was
// answered and how long. One with no one, or with no one the copy knows, is
// counted and left out. The iPhone's Calls tab holds only the calls the app
// still lists. The Calls tab dates an outgoing call about when it ended (when
// it started, plus its ringing and its length), so its start is taken as that
// date less its length (late only by the ringing); an incoming call's date is
// when it started.
//
// The Mac app's Calls tab cannot be trusted as to who was on a call: it lists
// one participant on nearly every call, and for about half of them it is not
// the person the call was with (a different number from the caller's and from
// the chat's). Its call records in the chats are right, and the Mac keeps the
// ones made on the phone too. So the `callsFrom: "chats"` setting, for a Mac
// copy, takes a call only the Calls tab has only where the copy bears out who
// it was with, and only in a chat the copy has: in a group, the group's (as
// always); an incoming one, with whoever called (its creator, which has matched
// the call's chat every time it could be checked), whatever its participant
// list says; an outgoing one, with its one participant only when that person's
// chat holds a call record within the hour of it (a call between two others of
// the same evening, say). The rest are counted and left out, and none is a call
// in no chat. (WhatsApp writes a call record in the chat of every call since
// late 2023, so those left out are old calls the fuller iPhone copy has.)
//
// The `only: "calls"` setting reads calls alone, for a copy whose messages and
// media another connector brings (the Mac app's, which the bridge keeps up to
// date): the call records and the calls the Calls tab adds, the chats they are
// in and the people on them, and nothing else; no message text is read, and no
// coverage is claimed. The chats and people are given only for the archive to
// add those it lacks (their events' `fallback`): the names and titles it has
// stay those the bridge and the fuller imports gave.
//
// A LID the copy has no phone number for (the Mac app's LID.sqlite has no
// pairs) is looked up in the WhatsApp bridge's database, when the `bridgeDb`
// setting names it (read-only, as the matrix-whatsapp connector reads it), so
// a call with someone known by their LID lands in their chat, not in a new one
// with an unnamed account.
//
// The databases are copied to a temporary folder and read there, so the
// source folder is never written to, not even by SQLite's own -shm file. The
// folder is in the media folder the host gives (the archive's own
// platform-exports/), since the copies hold every chat, and is removed after.
// Media are kept where they are in the folder (which must be under
// data/platform-exports/), hashed, and recorded as missing when the folder
// does not have them.
//
// Not read yet: reactions, quoted replies and edits, which WhatsApp keeps in
// binary fields.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type AccountEvent, type AttachmentType, type CallEvent, type Connector, expandHome, type HistoryOptions, isEncodedName, isNumberName, keepInPlace, mediaTypeOf, type MessageEvent, type MessageType } from "../../../../sdk/connector.ts";
import { columnsOf, isFile, openCopy, plain, type Row } from "../appDb.ts";
import { protobufInner, protobufMessage, protobufNumber, protobufText } from "../protobuf.ts";
import { importAddressBook, IPHONE_BOOK } from "../addressBook.ts";
import { BridgeDb } from "../matrix-bridge/bridgeDb.ts";
import { manifest } from "./manifest.ts";

/** The captain's own account key. */
export const SELF_KEY = "me";

/** Core Data counts seconds from 2001-01-01; this is that moment in seconds since 1970. */
const CORE_DATA_EPOCH = 978_307_200;

const SESSION_DIRECT = 0;
const SKIPPED_SESSIONS: Record<number, string> = { 2: "messages in broadcast lists", 3: "status updates" };

const TYPE_CONTACT = 4;
const TYPE_DELETED = 14;
export const TYPE_CALL = 59;
const TYPES: Record<number, { type: MessageType; attachment?: AttachmentType }> = {
  0: { type: "text" },
  1: { type: "media", attachment: "image" },
  2: { type: "media", attachment: "video" },
  3: { type: "media", attachment: "audio" },
  [TYPE_CONTACT]: { type: "contact" },
  5: { type: "location" },
  6: { type: "system" },
  7: { type: "link" },
  8: { type: "media", attachment: "file" },
  10: { type: "system" },
  11: { type: "media", attachment: "gif" },
  [TYPE_DELETED]: { type: "text" },
  15: { type: "sticker", attachment: "sticker" },
  [TYPE_CALL]: { type: "call" },
};
/** Types whose caption is kept on the media item (ZTITLE) rather than the message; a contact card's name is its ZVCARDNAME. */
const CAPTIONED = new Set([1, 2, 11]);
/** Fields that hold what someone wrote, left out of a deleted message's original record. */
const TEXT_FIELDS = ["ZTEXT", "ZTITLE", "ZVCARDNAME", "ZVCARDSTRING"];
const UNKNOWN_NAME = "WhatsApp user";
const CALL_HISTORY = "CallHistory.sqlite";
/** How near a call record in the same chat must be to bear out an outgoing call only the Calls tab has (`callsFrom: "chats"`). */
const BORNE_OUT_WITHIN_MS = 60 * 60_000;

/** Where an account's name came from, best first, each with the tally that counts it. */
const NAME_SOURCES = {
  addressBook: "accounts named from the address book",
  chat: "accounts named by their one-to-one chat",
  pushName: "accounts named by their WhatsApp push name",
  member: "accounts named by a group's member list",
  number: "accounts shown by phone number",
  none: "accounts with no name or number",
} as const;

export const whatsappDb: Connector = { manifest, history: readWhatsAppDb };

export async function readWhatsAppDb({ sources, config, mediaDir, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("name one folder (or its ChatStorage.sqlite)");
  const [source] = sources;
  const folder = (await isFile(source)) ? dirname(source) : source;
  const { callsOnly, callsFromChats, bridgeFile } = settingsOf(config);
  const tallies = new Map<string, number>();
  const tally = (name: string, by = 1) => tallies.set(name, (tallies.get(name) ?? 0) + by);
  await mkdir(mediaDir, { recursive: true });
  const work = await mkdtemp(join(mediaDir, ".whatsapp-db-"));
  const opened: DatabaseSync[] = [];
  let bridge: BridgeDb | null = null;
  const open = async (path: string) => {
    const db = await openCopy(path, work);
    if (db) opened.push(db);
    else tally(`${basename(path)} not in the folder`);
    return db;
  };
  try {
    const chats = await open(join(folder, "ChatStorage.sqlite"));
    if (!chats) throw new Error(`there is no ChatStorage.sqlite in ${folder}`);
    requireColumns(chats, "ZWACHATSESSION", ["Z_PK", "ZSESSIONTYPE", "ZCONTACTJID"]);
    requireColumns(chats, "ZWAMESSAGE", ["Z_PK", "ZCHATSESSION", "ZMESSAGEDATE", "ZISFROMME", "ZMESSAGETYPE", "ZSTANZAID"]);
    const contactRows = rows(await open(join(folder, "ContactsV2.sqlite")), "ZWAADDRESSBOOKCONTACT");
    const lidDb = await open(join(folder, "LID.sqlite"));
    const sessionRows = rows(chats, "ZWACHATSESSION");

    // The address book: the one the settings name (the iPhone's or the Mac's), which must be there, else the
    // iPhone's beside ChatStorage.sqlite.
    const addressBook = await importAddressBook(config.contacts, folder, work);
    if (!addressBook) tally(`no ${IPHONE_BOOK}, so accounts are named by WhatsApp alone`);

    // Which phone number each LID stands for: LID.sqlite's two tables, then the chat list, whose
    // one-to-one chats keyed by phone name the other person's LID, then ContactsV2.
    const phoneOfLid = new Map<string, string>();
    const pair = (lid: string, phone: string) => {
      if (lid.endsWith("@lid") && phone && !phoneOfLid.has(lid)) phoneOfLid.set(lid, phone);
    };
    for (const row of rows(lidDb, "ZWAZACCOUNT")) pair(lidOf(str(row.ZIDENTIFIER)), digits(str(row.ZPHONENUMBER)));
    for (const row of rows(lidDb, "ZWAPHONENUMBERLIDPAIR")) pair(lidOf(str(row.ZLID)), digits(str(row.ZPHONENUMBER)));
    for (const row of sessionRows) {
      if (row.ZSESSIONTYPE === SESSION_DIRECT) pair(lidOf(str(row.ZCONTACTIDENTIFIER)), phoneOfJid(str(row.ZCONTACTJID)));
    }
    for (const row of contactRows) pair(lidOf(str(row.ZLID)), phoneOfJid(str(row.ZWHATSAPPID)));
    // Then the bridge's database, for a LID none of those name.
    if (bridgeFile) bridge = new BridgeDb(bridgeFile);
    const fromBridge = (lid: string): string | undefined => {
      const phone = digits(bridge?.phoneOfLid(lid.split("@")[0]) ?? "");
      if (!phone) return undefined;
      pair(lid, phone);
      tally("LIDs the bridge's database gave the number of");
      return phone;
    };
    /** The account a JID names: its phone JID when the number is known, else its LID. */
    const canonical = (jid: string): string => {
      const bare = bareJid(jid);
      const phone = bare.endsWith("@lid") ? (phoneOfLid.get(bare) ?? fromBridge(bare)) : phoneOfJid(bare);
      return phone ? `${phone}@s.whatsapp.net` : bare;
    };

    // The captain's own JIDs: those in the settings, and any group member row a message from the captain names.
    const selfJids = new Set(
      (Array.isArray(config.selfJids) ? config.selfJids : [])
        .filter((jid): jid is string => typeof jid === "string" && jid !== "")
        .map((jid) => canonical(jid.includes("@") ? jid : `${digits(jid)}@s.whatsapp.net`)),
    );
    const members = new Map<number, Row>(rows(chats, "ZWAGROUPMEMBER").map((row) => [Number(row.Z_PK), row]));
    if (members.size > 0) {
      for (const { ZGROUPMEMBER } of chats
        .prepare("SELECT DISTINCT ZGROUPMEMBER FROM ZWAMESSAGE WHERE ZISFROMME = 1 AND ZGROUPMEMBER IS NOT NULL")
        .all()) {
        const jid = str(members.get(Number(ZGROUPMEMBER))?.ZMEMBERJID);
        if (jid) selfJids.add(canonical(jid));
      }
    }
    const keyOf = (jid: string) => {
      const key = canonical(jid);
      const phone = phoneOfJid(key);
      return selfJids.has(key) || (phone && addressBook?.lookup(phone).self) ? SELF_KEY : key;
    };

    // Names by where they came from; each map keeps the first name it is given.
    const names = { contactsV2: new Map<string, string>(), chat: new Map<string, string>(), pushName: new Map<string, string>(), member: new Map<string, string>() };
    const give = (map: Map<string, string>, key: string, ...candidates: string[]) => {
      const name = candidates.find(isName);
      if (name && !map.has(key)) map.set(key, name);
    };
    for (const row of contactRows) {
      const jid = str(row.ZWHATSAPPID) || str(row.ZLID);
      if (jid) give(names.contactsV2, keyOf(jid), str(row.ZFULLNAME), str(row.ZGIVENNAME));
    }
    for (const row of rows(chats, "ZWAPROFILEPUSHNAME")) {
      const jid = str(row.ZJID);
      if (jid) give(names.pushName, keyOf(jid), str(row.ZPUSHNAME));
    }
    const accountFor = (key: string): AccountEvent => {
      if (key === SELF_KEY) {
        const displayName = typeof config.selfName === "string" && config.selfName ? config.selfName : "Me";
        return { kind: "account", key, keyKind: "id", displayName, nameSource: "settings", isSelf: true };
      }
      const phone = phoneOfJid(key);
      const { displayName, source } = nameOf(key, phone);
      return { kind: "account", key, keyKind: "id", displayName, nameSource: source, ...(phone ? { handle: `+${phone}` } : {}) };
    };
    const nameOf = (key: string, phone: string): { displayName: string; source: keyof typeof NAME_SOURCES } => {
      const fromAddressBook = [phone ? addressBook?.lookup(phone).name : undefined, names.contactsV2.get(key)]
        .find(isName);
      if (fromAddressBook) return { displayName: fromAddressBook, source: "addressBook" };
      for (const source of ["chat", "pushName", "member"] as const) {
        const name = names[source].get(key);
        if (name) return { displayName: name, source };
      }
      return phone ? { displayName: `+${phone}`, source: "number" } : { displayName: UNKNOWN_NAME, source: "none" };
    };

    // Chats, several sessions of one chat (under its LID and its phone JID) joined into one conversation.
    interface Session { conversation: string; type: "direct" | "group"; partner?: string }
    const sessions = new Map<number, Session>();
    const skippedSessions = new Map<number, string>();
    const conversations = new Map<string, { type: "direct" | "group"; title?: string; members: Set<string> }>();
    for (const row of sessionRows) {
      const pk = Number(row.Z_PK);
      const type = row.ZSESSIONTYPE;
      const jid = str(row.ZCONTACTJID);
      if (typeof type === "number" && SKIPPED_SESSIONS[type]) skippedSessions.set(pk, SKIPPED_SESSIONS[type]);
      else if (!jid || jid.endsWith("@broadcast")) skippedSessions.set(pk, "messages in chats without a WhatsApp id");
      else if (type === SESSION_DIRECT) {
        const partner = keyOf(jid);
        give(names.chat, partner, str(row.ZPARTNERNAME));
        const conversation = canonical(jid);
        sessions.set(pk, { conversation, type: "direct", partner });
        const known = conversations.get(conversation) ?? { type: "direct", members: new Set([SELF_KEY]) };
        known.members.add(partner);
        conversations.set(conversation, known);
      } else if (bareJid(jid).endsWith("@g.us")) {
        // A group; also a community's announcements group, which WhatsApp gives a session type of its own.
        const conversation = bareJid(jid);
        sessions.set(pk, { conversation, type: "group" });
        const known = conversations.get(conversation) ?? { type: "group", members: new Set([SELF_KEY]) };
        known.title ??= str(row.ZPARTNERNAME) || undefined;
        conversations.set(conversation, known);
      } else skippedSessions.set(pk, "messages in chats of an unknown kind");
    }
    const memberKeys = new Map<number, string>();
    for (const [pk, row] of members) {
      const jid = str(row.ZMEMBERJID);
      const session = sessions.get(Number(row.ZCHATSESSION));
      if (!jid || session?.type !== "group") continue;
      const key = keyOf(jid);
      give(names.member, key, str(row.ZCONTACTNAME), str(row.ZFIRSTNAME));
      memberKeys.set(pk, key);
      conversations.get(session.conversation)!.members.add(key);
    }
    // The push name a message carries, newest first, for accounts the profile table has none for.
    if (columnsOf(chats, "ZWAMESSAGE").includes("ZPUSHNAME")) {
      for (const row of chats
        .prepare(
          `SELECT ZCHATSESSION, ZGROUPMEMBER, ZPUSHNAME FROM ZWAMESSAGE
           WHERE ZISFROMME = 0 AND ZPUSHNAME IS NOT NULL AND ZPUSHNAME != '' ORDER BY ZMESSAGEDATE DESC`,
        )
        .iterate() as Iterable<Row>) {
        const session = sessions.get(Number(row.ZCHATSESSION));
        const key = session?.type === "direct" ? session.partner : memberKeys.get(Number(row.ZGROUPMEMBER));
        if (key && key !== SELF_KEY) give(names.pushName, key, str(row.ZPUSHNAME));
      }
    }

    // The Calls tab's calls (when the folder has CallHistory.sqlite) that no chat records itself, each placed in the
    // chat it was made in: the group's, or the one-to-one chat with the one person on it, made when there is none.
    // Those a chat does record are read with its messages, with what the Calls tab says of them to hand.
    const callsInChats = new Set<string>();
    /** When each chat's call records were written, for bearing out an outgoing call only the Calls tab has. */
    const callRecordsIn = new Map<string, number[]>();
    /** Who started the calls in each group, its only members a calls-only read names (see below). */
    const callersIn = new Map<string, Set<string>>();
    const caller = (conversation: string, key: string | undefined) => {
      if (key) callersIn.set(conversation, (callersIn.get(conversation) ?? new Set()).add(key));
    };
    for (const row of chats
      .prepare(`SELECT ZSTANZAID, ZCHATSESSION, ZMESSAGEDATE, ZISFROMME, ZGROUPMEMBER FROM ZWAMESSAGE WHERE ZMESSAGETYPE = ${TYPE_CALL}`)
      .all() as Row[]) {
      const session = sessions.get(Number(row.ZCHATSESSION));
      if (!session) continue;
      if (session.type === "group") caller(session.conversation, row.ZISFROMME === 1 ? SELF_KEY : memberKeys.get(Number(row.ZGROUPMEMBER)));
      if (!str(row.ZSTANZAID)) continue;
      callsInChats.add(str(row.ZSTANZAID));
      if (typeof row.ZMESSAGEDATE === "number") {
        callRecordsIn.set(session.conversation, [...(callRecordsIn.get(session.conversation) ?? []), (row.ZMESSAGEDATE + CORE_DATA_EPOCH) * 1000]);
      }
    }
    const historyCalls = readCallHistory(await open(join(folder, CALL_HISTORY)), tally);
    const historyOf = new Map(historyCalls.filter((call) => call.callId).map((call) => [call.callId, call]));
    const callsOnlyInHistory: Array<{ call: HistoryCall; conversation: string; sender: string }> = [];
    /** Calls with several people and no group, each with everyone else on it, whoever started it first. */
    const callsInNoChat: Array<{ call: HistoryCall; others: string[] }> = [];
    /** With `callsFrom: "chats"`, the one person a call only the Calls tab has was with, where the copy bears it out (see the top). */
    const borneOut = (call: HistoryCall): string | null => {
      if (call.incoming) {
        const caller = call.creator ? keyOf(call.creator) : SELF_KEY;
        if (caller === SELF_KEY) tally("calls the copy does not say who they were with");
        else if (!conversations.has(caller)) tally("incoming calls only the Calls tab has, from someone the copy has no chat with, left out (callsFrom: chats)");
        else return caller;
        return null;
      }
      const others = new Set(call.participants.map(keyOf));
      others.delete(SELF_KEY);
      const [partner] = others;
      if (others.size !== 1) tally("outgoing calls only the Calls tab has, with no one or several people on them, left out (callsFrom: chats)");
      else if (!(callRecordsIn.get(partner) ?? []).some((at) => Math.abs(at - call.at) <= BORNE_OUT_WITHIN_MS)) {
        tally("outgoing calls only the Calls tab has, which no call record in the chat it names bears out, left out (callsFrom: chats)");
      } else return partner;
      return null;
    };
    for (const call of historyCalls) {
      if (call.callId && callsInChats.has(call.callId)) continue;
      if (call.group) {
        const conversation = bareJid(call.group);
        const sender = call.incoming ? (call.creator ? keyOf(call.creator) : null) : SELF_KEY;
        if (conversations.get(conversation)?.type !== "group") tally("calls in a group the copy has no chat for");
        else if (sender === null) tally("group calls the copy does not say who started");
        else {
          callsOnlyInHistory.push({ call, conversation, sender });
          caller(conversation, sender);
        }
        continue;
      }
      let partner: string | null;
      if (callsFromChats) partner = borneOut(call);
      else {
        const others = new Set([...(call.incoming && call.creator ? [keyOf(call.creator)] : []), ...call.participants.map(keyOf)]);
        others.delete(SELF_KEY);
        if (others.size === 0) tally("calls the copy does not say who they were with");
        if (others.size > 1) callsInNoChat.push({ call, others: [...others] });
        partner = others.size === 1 ? [...others][0] : null;
      }
      if (partner === null) continue;
      if (!conversations.has(partner)) conversations.set(partner, { type: "direct", members: new Set([SELF_KEY, partner]) });
      callsOnlyInHistory.push({ call, conversation: partner, sender: call.incoming ? partner : SELF_KEY });
    }
    // Calls alone: only the chats that hold a call, the call records in them and the people on the calls in no chat. A
    // group's members are only those who started its calls, whom the call records name; the archive knows the rest
    // from the source that brings its messages, and this copy may know them only by LIDs it cannot resolve.
    const withCalls = new Set([
      ...(chats.prepare(`SELECT DISTINCT ZCHATSESSION FROM ZWAMESSAGE WHERE ZMESSAGETYPE = ${TYPE_CALL}`).all() as Row[])
        .flatMap((row) => sessions.get(Number(row.ZCHATSESSION))?.conversation ?? []),
      ...callsOnlyInHistory.map(({ conversation }) => conversation),
    ]);

    const announced = new Set<string>();
    const announce = async (key: string) => {
      if (announced.has(key)) return key;
      announced.add(key);
      if (key !== SELF_KEY) tally(NAME_SOURCES[nameOf(key, phoneOfJid(key)).source]);
      await emit({ ...accountFor(key), ...(callsOnly ? { fallback: true } : {}) });
      return key;
    };
    await announce(SELF_KEY);
    for (const [id, { type, title, members: keys }] of conversations) {
      if (callsOnly && !withCalls.has(id)) continue;
      const memberList = [...(callsOnly && type === "group" ? new Set([SELF_KEY, ...(callersIn.get(id) ?? [])]) : keys)].sort();
      for (const key of memberList) await announce(key);
      const partner = memberList.find((key) => key !== SELF_KEY);
      await emit({
        kind: "conversation",
        id,
        type,
        title: type === "group" ? (title ?? "") : partner ? accountFor(partner).displayName : accountFor(SELF_KEY).displayName,
        members: memberList,
        ...(callsOnly ? { fallback: true } : {}),
      });
    }

    // A stanza id in more than one chat (the copies of a broadcast list message) is told apart by its chat.
    const chatsOfStanza = new Map<string, Set<string>>();
    for (const row of chats
      .prepare(
        `SELECT ZSTANZAID, ZCHATSESSION FROM ZWAMESSAGE WHERE ZSTANZAID IN (
           SELECT ZSTANZAID FROM ZWAMESSAGE WHERE ZSTANZAID IS NOT NULL AND ZSTANZAID != ''
           GROUP BY ZSTANZAID HAVING count(DISTINCT ZCHATSESSION) > 1)`,
      )
      .all() as Row[]) {
      const conversation = sessions.get(Number(row.ZCHATSESSION))?.conversation;
      const stanza = str(row.ZSTANZAID);
      if (conversation) chatsOfStanza.set(stanza, (chatsOfStanza.get(stanza) ?? new Set()).add(conversation));
    }
    const sharedStanzas = new Set([...chatsOfStanza].filter(([, conversations]) => conversations.size > 1).map(([stanza]) => stanza));
    const hasMediaItems = columnsOf(chats, "ZWAMEDIAITEM").length > 0;
    const mediaItem = hasMediaItems ? chats.prepare("SELECT * FROM ZWAMEDIAITEM WHERE Z_PK = ?") : null;
    const read = callsOnly ? `WHERE ZMESSAGETYPE = ${TYPE_CALL}` : "";
    const { total } = chats.prepare(`SELECT count(*) AS total FROM ZWAMESSAGE ${read}`).get() as { total: number };
    if (callsOnly) {
      const { all } = chats.prepare("SELECT count(*) AS \"all\" FROM ZWAMESSAGE").get() as { all: number };
      if (all > total) tally("messages left out, being no call (only: calls)", all - total);
    }
    const firstAt = new Map<string, number>();
    let lastAt = -Infinity;
    const covered = (conversation: string, at: number) => {
      firstAt.set(conversation, Math.min(firstAt.get(conversation) ?? at, at));
      lastAt = Math.max(lastAt, at);
    };
    let done = 0;

    for (const row of chats.prepare(`SELECT * FROM ZWAMESSAGE ${read} ORDER BY ZMESSAGEDATE, Z_PK`).iterate()) {
      if (++done % 1000 === 0) await emit({ kind: "progress", done, total, note: "messages" });
      const sessionPk = Number(row.ZCHATSESSION);
      const session = sessions.get(sessionPk);
      if (!session) {
        tally(skippedSessions.get(sessionPk) ?? "messages in no chat");
        continue;
      }
      if (typeof row.ZMESSAGEDATE !== "number") {
        tally("messages without a date");
        continue;
      }
      const sentAt = Math.round((row.ZMESSAGEDATE + CORE_DATA_EPOCH) * 1000);
      const waType = Number(row.ZMESSAGETYPE);
      const kind = TYPES[waType];
      if (!kind) tally(`messages of an unknown type (${waType})`);
      const system = kind?.type === "system";
      const fromMe = row.ZISFROMME === 1;
      const memberKey = memberKeys.get(Number(row.ZGROUPMEMBER));
      let sender: string | null = null;
      if (fromMe) sender = SELF_KEY;
      else if (session.type === "direct") sender = session.partner!;
      else if (memberKey) sender = memberKey;
      else if (!system) {
        // A group message whose member row is gone: an unknown account of that group.
        tally("group messages from an unknown member");
        sender = `unknown@${session.conversation}`;
        if (!announced.has(sender)) {
          announced.add(sender);
          await emit({ kind: "account", key: sender, keyKind: "id", displayName: UNKNOWN_NAME, ...(callsOnly ? { fallback: true } : {}) });
        }
      }
      if (system) sender = null;

      const media = mediaItem && row.ZMEDIAITEM !== null ? (mediaItem.get(row.ZMEDIAITEM) ?? null) : null;
      // A call record: how long the call was, from WhatsApp's record of it in the chat, else the Calls tab's.
      const callLog = waType === TYPE_CALL ? callLogOf(media?.ZMETADATA) : null;
      let callSeconds: number | undefined;
      if (waType === TYPE_CALL) {
        const history = historyOf.get(str(row.ZSTANZAID));
        callSeconds = callLog ? logSeconds(callLog) : history?.callSeconds;
        if (!callLog && !history) tally("call records that say nothing more of the call");
        else if (callSeconds === undefined) tally(UNKNOWN_LENGTH);
        // None yet: a three-way call WhatsApp recorded in a one-to-one chat would count whole for the chat's person.
        if (session.type === "direct" && (callLog?.participants.length ?? 0) > 1) tally("call records in a one-to-one chat with several people on them");
      }
      const unsent = waType === TYPE_DELETED;
      const text = unsent ? "" : str(row.ZTEXT) || (CAPTIONED.has(waType) ? str(media?.ZTITLE) : waType === TYPE_CONTACT ? str(media?.ZVCARDNAME) : "");
      const stanza = str(row.ZSTANZAID);
      let id = stanza;
      if (!stanza) {
        tally("messages without a WhatsApp id");
        id = sha256([
          "whatsapp", session.conversation, sentAt, waType, str(row.ZGROUPEVENTTYPE), fromMe ? 1 : 0, memberKey ?? "", str(row.ZTEXT),
        ].join("\u001f"));
      } else if (sharedStanzas.has(stanza)) {
        id = `${stanza}/${session.conversation}`;
      }

      await emit({
        kind: "message",
        id,
        idKind: stanza ? "platform" : "synthetic",
        conversation: session.conversation,
        sender,
        isFromSelf: fromMe,
        sentAt,
        type: kind?.type ?? "other",
        ...(text ? { text } : {}),
        ...(unsent ? { unsent: true } : {}),
        ...(callSeconds !== undefined ? { callSeconds } : {}),
        raw: {
          ...plain(row, unsent ? TEXT_FIELDS : []),
          ...(media && !unsent ? { ZMEDIAITEM: plain(media, []) } : {}),
          ...(callLog ? { callLog } : {}),
        },
      });
      covered(session.conversation, sentAt);

      if (kind?.attachment) {
        const localPath = str(media?.ZMEDIALOCALPATH);
        const fileName = localPath ? basename(localPath.replace(/\\/g, "/")) : "";
        const file = localPath ? await mediaFile(folder, localPath, tally) : null;
        const inPlace = file ? await keepInPlace(file) : undefined;
        if (!inPlace) tally("media not in the folder");
        const { mime } = mediaTypeOf(fileName);
        await emit({
          kind: "attachment",
          message: id,
          ordinal: 0,
          type: kind.attachment,
          ...(fileName ? { filename: fileName } : {}),
          ...(mime ? { mime } : {}),
          ...(inPlace ? { inPlace } : {}),
        });
      }
    }
    await emit({ kind: "progress", done, total, note: "messages" });

    // The calls only the Calls tab has, each a call record in its chat, keyed as a chat's own record of it would be.
    for (const { call, conversation, sender } of callsOnlyInHistory) {
      // Who started a group call may have left the group since.
      await announce(sender);
      const event: MessageEvent = {
        kind: "message",
        id: historyCallId(call),
        idKind: call.callId ? "platform" : "synthetic",
        conversation,
        sender,
        isFromSelf: sender === SELF_KEY,
        sentAt: call.at,
        type: "call",
        ...(call.callSeconds !== undefined ? { callSeconds: call.callSeconds } : {}),
        // The chat's own record of it, in a copy that has it, is the better one: its length can be a second shorter.
        fallback: true,
        raw: call.raw,
      };
      await emit(event);
      tally("calls only the Calls tab has (CallHistory.sqlite)");
      if (call.callSeconds === undefined) tally(UNKNOWN_LENGTH);
      covered(conversation, call.at);
    }

    // The calls with several people and no group: calls in no chat, with everyone on them in one of the copy's chats
    // (each announced with its chat), the rest counted unnamed; with no one in a chat here, left out.
    const known = new Set([...conversations.values()].flatMap(({ members: keys }) => [...keys]));
    for (const { call, others } of callsInNoChat) {
      const [first, ...rest] = others.filter((key) => known.has(key));
      if (!first) {
        tally("calls with several people and no group, with no one the copy has a chat with");
        continue;
      }
      // Reading calls alone, their chats may not have been announced.
      for (const key of [first, ...rest]) await announce(key);
      const event: CallEvent = {
        kind: "call",
        id: historyCallId(call),
        with: first,
        ...(rest.length > 0 ? { alsoWith: rest } : {}),
        ...(others.length > rest.length + 1 ? { others: others.length - rest.length - 1 } : {}),
        at: call.at,
        ...(call.callSeconds !== undefined ? { durationSeconds: call.callSeconds } : {}),
        direction: call.incoming ? "incoming" : "outgoing",
        answered: call.callSeconds === undefined ? call.outcome === HISTORY_OUTCOMES.answeredElsewhere : call.callSeconds > 0,
        service: call.video ? "video" : "voice",
        raw: call.raw,
      };
      await emit(event);
      tally("calls with several people and no group (calls in no chat)");
      if (others.length > rest.length + 1) tally("people on those calls the copy has no chat with (counted, unnamed)");
      if (call.callSeconds === undefined) tally(UNKNOWN_LENGTH);
    }

    // The copy covers each chat from its first message to the newest message in the copy; read for its calls alone, none.
    if (!callsOnly) {
      for (const [conversation, from] of firstAt) await emit({ kind: "coverage", conversation, from, to: lastAt });
      if (firstAt.size > 0) await emit({ kind: "coverage", from: Math.min(...firstAt.values()), to: lastAt });
    }
    for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
  } finally {
    for (const db of opened) db.close();
    bridge?.close();
    await rm(work, { recursive: true, force: true });
  }
}

/** The connector's own settings, beside `contacts`, `selfJids` and `selfName` (see the top). */
function settingsOf(config: Record<string, unknown>): { callsOnly: boolean; callsFromChats: boolean; bridgeFile: string | null } {
  const { only, callsFrom, bridgeDb } = config;
  if (only !== undefined && only !== "calls") throw new Error(`the only setting takes "calls", not ${JSON.stringify(only)}`);
  if (callsFrom !== undefined && callsFrom !== "chats" && callsFrom !== "both") {
    throw new Error(`the callsFrom setting takes "chats" or "both", not ${JSON.stringify(callsFrom)}`);
  }
  if (bridgeDb !== undefined && (typeof bridgeDb !== "string" || bridgeDb === "")) throw new Error("the bridgeDb setting names a file");
  return { callsOnly: only === "calls", callsFromChats: callsFrom === "chats", bridgeFile: bridgeDb ? resolve(expandHome(bridgeDb)) : null };
}

/**
 * WhatsApp's own record of a call (CallLogMessage, in WAWebProtobufsE2E.proto), as a call record in a chat keeps it:
 * field 87, then 1, of its media item's ZMETADATA. Outcomes: 0 connected, 1 missed, 2 failed, 3 rejected,
 * 4 answered on another device, 5 still going when it was written, 6 and 7 silenced.
 */
export interface CallLog {
  isVideo: boolean;
  outcome: number;
  durationSecs: number;
  /** 0 a call, 1 a scheduled one, 2 a voice chat. */
  callType: number;
  /** The others on it, as WhatsApp lists them (a JID and its own outcome each). */
  participants: Array<{ jid: string; outcome: number }>;
}

const LOG_OUTCOMES = { answeredElsewhere: 4, ongoing: 5 } as const;

/** The CallLogMessage in a call record's media item's ZMETADATA; null when it holds none. */
export function callLogOf(metadata: SQLOutputValue | undefined): CallLog | null {
  if (!(metadata instanceof Uint8Array)) return null;
  const log = protobufInner(protobufInner(protobufMessage(metadata), 87), 1);
  if (!log) return null;
  return {
    isVideo: protobufNumber(log, 1) === 1,
    outcome: protobufNumber(log, 2) ?? 0,
    durationSecs: protobufNumber(log, 3) ?? 0,
    callType: protobufNumber(log, 4) ?? 0,
    participants: (log.get(5) ?? []).flatMap((value) => {
      const participant = value instanceof Uint8Array ? protobufMessage(value) : null;
      return participant ? [{ jid: protobufText(participant, 1) ?? "", outcome: protobufNumber(participant, 2) ?? 0 }] : [];
    }),
  };
}

/**
 * How long a call was connected, as a call record keeps it (MessageEvent.callSeconds), by its CallLogMessage: its
 * length, 0 for one never connected, and undefined (not known) for one answered on another device or still going.
 */
function logSeconds(log: CallLog): number | undefined {
  if (log.durationSecs > 0) return log.durationSecs;
  return log.outcome === LOG_OUTCOMES.answeredElsewhere || log.outcome === LOG_OUTCOMES.ongoing ? undefined : 0;
}

/** The tally of calls whose length is not known. */
const UNKNOWN_LENGTH = "calls of no known length (answered on another device, say)";

/** A call in the Calls tab (CallHistory.sqlite). */
export interface HistoryCall {
  /** WhatsApp's id for the call, a chat's call record's stanza id; "" for the oldest, which have none. */
  callId: string;
  /** When it started, in milliseconds: an outgoing call's date less its length (see the top). */
  at: number;
  /** The Calls tab's own date for it, in milliseconds, which a call with no id is known by. */
  listedAt: number;
  incoming: boolean;
  /** How long it was connected, as logSeconds says it. */
  callSeconds: number | undefined;
  /** The JID of the group it was made in; "" for none. */
  group: string;
  /** Who started it, as kept ("" when not); for a one-to-one call, whoever called. */
  creator: string;
  /** The others on it, as kept: for a one-to-one call, whoever the captain called. */
  participants: string[];
  /** Its outcome, as kept (HISTORY_OUTCOMES). */
  outcome: number;
  /** A video call; else a voice one. */
  video: boolean;
  /** Its rows, without their binary fields. */
  raw: Record<string, unknown>;
}

/** A call's id: WhatsApp's own, else (the oldest calls have none) one made from what the Calls tab keeps of it. */
function historyCallId(call: HistoryCall): string {
  return call.callId || sha256(["whatsapp-call", call.listedAt, call.incoming ? 1 : 0, call.creator, ...[...call.participants].sort()].join("\u001f"));
}

/**
 * CallHistory.sqlite's outcomes (ZWACDCALLEVENT.ZOUTCOME), which are not CallLogMessage's: 0 connected, 1 missed or
 * not answered, 2 failed, 4 declined, 5 answered on another device. 3 has not been seen; a call of an outcome not
 * known, and one answered on another device, has no known length.
 */
const HISTORY_OUTCOMES = { connected: 0, notConnected: new Set([1, 2, 4]), answeredElsewhere: 5 } as const;

/** Every call in the Calls tab, oldest first; none when the folder has no CallHistory.sqlite, or one of a kind not known. */
function readCallHistory(db: DatabaseSync | null, tally: (name: string) => void): HistoryCall[] {
  if (!db) return [];
  const needed = { ZWACDCALLEVENT: ["Z_PK", "ZDATE", "ZDURATION", "ZOUTCOME", "ZCALLIDSTRING", "Z1CALLEVENTS"], ZWAAGGREGATECALLEVENT: ["Z_PK", "ZINCOMING"] };
  if (Object.entries(needed).some(([table, columns]) => !columns.every((column) => columnsOf(db, table).includes(column)))) {
    tally(`${CALL_HISTORY} of a kind this connector does not know, so not read`);
    return [];
  }
  const aggregates = new Map(rows(db, "ZWAAGGREGATECALLEVENT").map((row) => [Number(row.Z_PK), row]));
  const participants = new Map<number, Row[]>();
  for (const row of rows(db, "ZWACDCALLEVENTPARTICIPANT")) {
    const call = Number(row.Z1PARTICIPANTS);
    participants.set(call, [...(participants.get(call) ?? []), row]);
  }
  const calls: HistoryCall[] = [];
  for (const row of db.prepare("SELECT * FROM ZWACDCALLEVENT ORDER BY ZDATE, Z_PK").all() as Row[]) {
    if (typeof row.ZDATE !== "number") {
      tally("calls without a date");
      continue;
    }
    const aggregate = aggregates.get(Number(row.Z1CALLEVENTS));
    const others = participants.get(Number(row.Z_PK)) ?? [];
    const outcome = Number(row.ZOUTCOME);
    const duration = typeof row.ZDURATION === "number" ? row.ZDURATION : 0;
    let callSeconds: number | undefined;
    if (duration > 0) callSeconds = Math.round(duration);
    else if (outcome === HISTORY_OUTCOMES.connected || HISTORY_OUTCOMES.notConnected.has(outcome)) callSeconds = 0;
    const incoming = aggregate?.ZINCOMING === 1;
    const listedAt = Math.round((row.ZDATE + CORE_DATA_EPOCH) * 1000);
    calls.push({
      callId: str(row.ZCALLIDSTRING),
      at: incoming ? listedAt : listedAt - Math.round(duration * 1000),
      listedAt,
      incoming,
      callSeconds,
      group: str(row.ZGROUPJIDSTRING),
      creator: str(row.ZGROUPCALLCREATORUSERJIDSTRING),
      participants: others.map((other) => str(other.ZJIDSTRING)).filter(Boolean),
      outcome,
      video: aggregate?.ZVIDEO === 1,
      raw: { ...plain(row, []), ...(aggregate ? { aggregate: plain(aggregate, []) } : {}), participants: others.map((other) => plain(other, [])) },
    });
  }
  return calls;
}

/** Whether a name a table gives is one: not empty, not only a number, and not an encoded message. */
function isName(name: string | undefined): name is string {
  return !!name && !isNumberName(name) && !isEncodedName(name);
}

function requireColumns(db: DatabaseSync, table: string, needed: string[]): void {
  const columns = columnsOf(db, table);
  const missing = needed.filter((column) => !columns.includes(column));
  if (columns.length === 0) throw new Error(`ChatStorage.sqlite has no ${table} table; is it WhatsApp's database?`);
  if (missing.length > 0) throw new Error(`ChatStorage.sqlite's ${table} has no ${missing.join(", ")}; its schema is not one this connector knows`);
}

/** Every row of a table, or none when the database or table is missing. */
function rows(db: DatabaseSync | null, table: string): Row[] {
  if (!db || columnsOf(db, table).length === 0) return [];
  return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
}

/** The file a media item names, if the folder has it. Paths are relative to Message/; absolute ones are cut back to it. */
async function mediaFile(folder: string, localPath: string, tally: (name: string) => void): Promise<string | null> {
  const base = resolve(folder, "Message");
  let relative = localPath.replace(/\\/g, "/");
  const marker = relative.lastIndexOf("/Message/");
  if (relative.startsWith("/") && marker >= 0) relative = relative.slice(marker + "/Message/".length);
  relative = relative.replace(/^\/+/, "").replace(/^Message\//, "");
  const file = resolve(base, relative);
  if (!file.startsWith(base + sep)) {
    tally("media paths outside the Message folder");
    return null;
  }
  return (await isFile(file)) ? file : null;
}

function str(value: SQLOutputValue | undefined): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
}

/** A JID in lowercase without its device part: "61491571266:3@s.whatsapp.net" -> "61491571266@s.whatsapp.net". */
export function bareJid(jid: string): string {
  const [user, server] = jid.trim().toLowerCase().split("@");
  return server === undefined ? user : `${user.split(":")[0]}@${server}`;
}

/** A LID with its "@lid", however it was stored; "" for none. */
export function lidOf(identifier: string): string {
  if (!identifier) return "";
  return identifier.includes("@") ? bareJid(identifier) : `${digits(identifier)}@lid`;
}

/** The phone number (digits, with country code) in a phone JID; "" for any other JID. */
function phoneOfJid(jid: string): string {
  const bare = bareJid(jid);
  return bare.endsWith("@s.whatsapp.net") ? digits(bare.split("@")[0]) : "";
}

function digits(text: string): string {
  return text.replace(/\D/g, "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
