// Reads Messenger's end-to-end-encrypted chat export: the zip the Messenger
// phone app makes from "Download your message storage data", unpacked (see
// "Media" below), or the zip itself when it holds no media.
//
//   <Thread Name>_<n>.json      one per chat: {participants, threadName, messages[]}
//   media/<folder>/<file>       photos, videos, voice notes, GIFs
//
// Each message is {senderName, timestamp (ms), type: text|media|link|placeholder,
// text, isUnsent, media: [{uri}], reactions: [{actor, reaction}]}. A call is
// kept as an empty "link" (no text, no media) and nothing more, so it is read
// as a call record whose length is not known (isCall).
//
// The export has no message ids and no participant ids, only display names, so:
// - accounts are keyed by display name, except labels such as "Facebook user"
//   that stand for different deleted accounts: those get one account per chat;
// - a chat is keyed by its sorted participant names (plus its name for a
//   group; plus its name and first timestamp when a placeholder label is
//   among them, or a fixed stand-in when it has no messages), where its name
//   is its threadName without the number the export gives its file (see
//   chatName), so the same chat in a later export is the same chat;
// - a message's id is a hash of its chat, sender, time, type, text and media
//   count, and, for photos sent together, its place among them (see
//   syntheticIds), so a later export of the same period gives the same ids and
//   exact duplicate records collapse into one.
// Media are found by file name anywhere under media/ (the uri's folder does not
// match the zip's), kept where they are in the export unpacked under
// data/platform-exports/messenger/<export date>/ (a zip holding them is refused
// until it is unpacked there), hashed, and recorded as missing when the export
// does not have them.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type Connector, type HistoryOptions, isPlaceholderName, keepInPlace, mediaTypeOf, type MessageType, unpackFirst } from "../../../../sdk/connector.ts";
import { ExportParts, type ExportFile } from "../metaDyiParts.ts";
import { manifest } from "./manifest.ts";

interface ExportThread {
  participants: string[];
  /** Its name: its threadName without the export's number for its file (see chatName). */
  name: string;
  messages: ExportMessage[];
}

export interface ExportMessage {
  senderName: string;
  timestamp: number;
  type: string;
  text?: string;
  isUnsent?: boolean;
  media?: Array<{ uri?: string }>;
  reactions?: Array<{ actor?: string; reaction?: string }>;
}

const TYPES: Record<string, MessageType> = { text: "text", media: "media", link: "link", placeholder: "text" };
const SEPARATOR = "\u001f";
const FIELD = "\u001e";
/** What a key made by a chat's name starts with (see chatKey). The keys made before it, with the export's number in, never do. */
const BY_NAME = "by-name";
/** A chat with a placeholder and no messages has no first time; this stands in for it. */
const NO_MESSAGES = "no messages";

export const messengerExport: Connector = { manifest, history: readMessengerExport };

export async function readMessengerExport({ sources, config, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("this export is a single zip; name just that one file, or the folder it is unpacked in");
  const parts = await ExportParts.open(sources);
  const files = [...parts.files.values()];
  const tallies = new Map<string, number>();
  const tally = (name: string) => tallies.set(name, (tallies.get(name) ?? 0) + 1);
  try {
    const mediaByName = new Map<string, ExportFile[]>();
    for (const entry of files) {
      if (!entry.name.startsWith("media/")) continue;
      const name = posix.basename(entry.name);
      mediaByName.set(name, [...(mediaByName.get(name) ?? []), entry]);
    }

    const threads: ExportThread[] = [];
    for (const entry of threadFiles(parts)) {
      const thread = parseThread(await parts.read(entry), posix.basename(entry.name, ".json"));
      if (thread) threads.push(thread);
      else tally("chat files that could not be read");
    }
    const self = selfName(threads, config);
    let exportedUpTo = 0;
    for (const thread of threads) for (const message of thread.messages) exportedUpTo = Math.max(exportedUpTo, message.timestamp);

    const announced = new Set<string>();
    const conversationKeys = new Set<string>();
    let done = 0;
    for (const thread of threads) {
      const firstAt = thread.messages.length === 0 ? null : thread.messages.reduce((min, m) => Math.min(min, m.timestamp), Infinity);
      const names = [...new Set(thread.participants)].sort();
      const type = names.length > 2 ? "group" : "direct";
      const baseKey = chatKey(names, thread.name, firstAt);
      // Chats keyed by their name can match exactly (chats with an unknown account and no messages, or two groups of
      // the same people and name); they are told apart by order in the export. (Two chats between the same named
      // people are one conversation.)
      let conversationKey = baseKey;
      for (let n = 2; isKeyedByName(baseKey) && conversationKeys.has(conversationKey); n++) conversationKey = numberedKey(baseKey, n);
      conversationKeys.add(conversationKey);
      const conversationId = sha256(conversationKey);
      const messageIds = syntheticIds(conversationKey, thread.messages);
      // A placeholder label is a different unknown account in each chat.
      const keyOf = (name: string) => (isPlaceholderName(name) ? `${name} #${conversationId.slice(0, 8)}` : name);
      const announce = async (name: string) => {
        const key = keyOf(name);
        if (announced.has(key)) return key;
        announced.add(key);
        await emit({ kind: "account", key, keyKind: "name", displayName: name, nameSource: "export", ...(name === self ? { isSelf: true } : {}) });
        return key;
      };

      const members = [];
      for (const name of names) members.push(await announce(name));
      await emit({
        kind: "conversation",
        id: conversationId,
        type,
        title: type === "group" ? thread.name : (names.find((n) => n !== self) ?? thread.name),
        members,
      });

      for (const message of thread.messages) {
        const sender = await announce(message.senderName);
        const media = Array.isArray(message.media) ? message.media : [];
        const text = typeof message.text === "string" ? message.text : "";
        const id = messageIds.get(message)!;
        const unsent = message.isUnsent === true || message.type === "placeholder";
        const mapped = isCall(message) ? "call" : TYPES[message.type];
        if (!mapped) tally(`messages of an unknown type (${message.type})`);
        await emit({
          kind: "message",
          id,
          idKind: "synthetic",
          conversation: conversationId,
          sender,
          isFromSelf: message.senderName === self,
          sentAt: message.timestamp,
          type: mapped ?? "other",
          ...(text && !unsent ? { text } : {}),
          ...(unsent ? { unsent: true } : {}),
          raw: message,
        });

        for (const [ordinal, item] of media.entries()) {
          const fileName = typeof item?.uri === "string" ? posix.basename(item.uri) : "";
          const { type: attachmentType, mime } = mediaTypeOf(fileName);
          const candidates = fileName ? (mediaByName.get(fileName) ?? []) : [];
          // Prefer the file in the folder the uri names; otherwise the only (or first) file of that name.
          const folder = typeof item?.uri === "string" ? posix.basename(posix.dirname(item.uri)) : "";
          const entry = candidates.find((c) => posix.basename(posix.dirname(c.name)) === folder) ?? candidates[0];
          if (candidates.length > 1) tally("media file names found in more than one folder");
          if (entry && parts.pathOf(entry) === null) throw unpackFirst("messenger-export", "messenger", sources[0]);
          const inPlace = entry ? await keepInPlace(parts.pathOf(entry)!) : undefined;
          if (!entry) tally("media not in the export");
          await emit({
            kind: "attachment",
            message: id,
            ordinal,
            type: attachmentType,
            ...(fileName ? { filename: fileName } : {}),
            ...(mime ? { mime } : {}),
            ...(inPlace ? { inPlace } : {}),
          });
        }

        for (const reaction of Array.isArray(message.reactions) ? message.reactions : []) {
          if (typeof reaction?.actor !== "string" || typeof reaction.reaction !== "string" || !reaction.reaction) {
            tally("reactions without an actor or emoji");
            continue;
          }
          await emit({ kind: "reaction", message: id, actor: await announce(reaction.actor), emoji: reaction.reaction });
        }
      }

      if (firstAt !== null) await emit({ kind: "coverage", conversation: conversationId, from: firstAt, to: exportedUpTo });
      await emit({ kind: "progress", done: ++done, total: threads.length, note: "chats" });
    }

    const allTimes = threads.flatMap((t) => t.messages.map((m) => m.timestamp));
    if (allTimes.length > 0) await emit({ kind: "coverage", from: Math.min(...allTimes), to: exportedUpTo });
    for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
  } finally {
    await parts.close();
  }
}

/**
 * Whether an item is a call: the export keeps each call as a "link" with no text and no media, and says nothing of
 * how long it was, nor whether it was answered. (Migration 34 in server/archive/db.ts reads those imported before so.)
 */
export function isCall(message: Pick<ExportMessage, "type" | "text" | "media" | "isUnsent">): boolean {
  return message.type === "link" && !message.text && !(Array.isArray(message.media) && message.media.length > 0) && message.isUnsent !== true;
}

/**
 * A chat's name: the phone app names each chat's file `<name>_<n>.json`, `<n>` its place in that export, and writes the
 * same `<name>_<n>` as its threadName, so the number moves from one export to the next as chats come and go. A
 * threadName that is its file's own name loses that one `_<n>`; any other is kept whole, and a chat whose name itself
 * ends in digits keeps them (its file is `<name>_<n>.json`).
 */
export function chatName(threadName: string, fileStem: string): string {
  const numbered = /^(.+)_\d+$/.exec(threadName);
  return numbered && threadName === fileStem ? numbered[1] : threadName;
}

/**
 * A chat's key, before any order number: its sorted participant names (`names`, each once), and, for a group or a
 * chat with a placeholder ("Facebook user", a different deleted account in each chat), "by-name", its name (see
 * chatName) and, for a chat with a placeholder, its first message's time (or a stand-in when it has none, so an
 * empty chat's key does not move with the export's newest message).
 */
export function chatKey(names: string[], name: string, firstAt: number | null): string {
  const hasPlaceholder = names.some(isPlaceholderName);
  if (names.length <= 2 && !hasPlaceholder) return names.join(SEPARATOR);
  return [BY_NAME, names.join(SEPARATOR), name, ...(hasPlaceholder ? [firstAt === null ? NO_MESSAGES : String(firstAt)] : [])].join(FIELD);
}

/** Whether a chat key (with or without its order number) is one made by the chat's name, which an order number may follow. */
export function isKeyedByName(key: string): boolean {
  return key.startsWith(`${BY_NAME}${FIELD}`);
}

/** A chat key with its order number in the export, for the second and later chats with the same key (1 is the key itself). */
export function numberedKey(key: string, n: number): string {
  return n === 1 ? key : `${key}${FIELD}${n}`;
}

/**
 * Every record in an export's chats (its folder, or its zip), as this reader reads them. For the repair of the chats
 * it doubled (archive/messengerPhoneChats.ts), which needs the text an unsent message's stored record no longer has.
 */
export async function exportMessages(source: string): Promise<ExportMessage[]> {
  const parts = await ExportParts.open([source]);
  try {
    const messages: ExportMessage[] = [];
    for (const entry of threadFiles(parts)) messages.push(...(parseThread(await parts.read(entry), "")?.messages ?? []));
    return messages;
  } finally {
    await parts.close();
  }
}

/** The export's chat files: its JSON files outside media/. */
function threadFiles(parts: ExportParts): ExportFile[] {
  return [...parts.files.values()].filter((e) => e.name.endsWith(".json") && !e.name.startsWith("media/"));
}

function parseThread(bytes: Buffer, fileStem: string): ExportThread | null {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const thread = data as Partial<ExportThread> & { threadName?: unknown };
  if (!Array.isArray(thread.participants) || !Array.isArray(thread.messages)) return null;
  if (!thread.participants.every((p) => typeof p === "string")) return null;
  const messages = thread.messages.filter(
    (m): m is ExportMessage =>
      typeof m === "object" && m !== null && typeof m.senderName === "string" && Number.isSafeInteger(m.timestamp) &&
      typeof m.type === "string",
  );
  return { participants: thread.participants, name: chatName(String(thread.threadName ?? ""), fileStem), messages };
}

/**
 * A message's id: a hash of its chat, sender, time, type, text and media count.
 * Records that share all of those (several photos sent in one millisecond, each
 * its own record) also hash their place among them (see burstOrder), so they
 * stay apart while exact duplicate records collapse into one. No id depends on
 * media file names: each export names the files anew. (Until 2026-10-15 those
 * records hashed their file names, so each export brought them in again;
 * archive/messengerPhoneChats.ts repairs the ids made so.)
 */
function syntheticIds(conversationKey: string, messages: ExportMessage[]): Map<ExportMessage, string> {
  const byBase = new Map<string, ExportMessage[]>();
  for (const message of messages) {
    const base = idBase(conversationKey, message);
    byBase.set(base, [...(byBase.get(base) ?? []), message]);
  }
  const ids = new Map<ExportMessage, string>();
  for (const group of byBase.values()) {
    const order = burstOrder(group);
    group.forEach((message, i) => ids.set(message, messageId(conversationKey, message, order[i])));
  }
  return ids;
}

/**
 * Each record's place (from 1) among records that share all their id is made of but their media (see idBase), in the
 * export's order: records with the same media file names are one record, with one place. All null when they are all
 * one record. Each export names the files anew, but keeps such records in the same order.
 */
export function burstOrder(records: ExportMessage[]): Array<number | null> {
  const places = new Map<string, number>();
  for (const record of records) {
    const names = JSON.stringify(mediaNames(record));
    if (!places.has(names)) places.set(names, places.size + 1);
  }
  return records.map((record) => (places.size > 1 ? places.get(JSON.stringify(mediaNames(record)))! : null));
}

/**
 * A message's id in the chat with this key (see syntheticIds): `order` its place among the records that share all but
 * their media (burstOrder), null when there are none such. Its record may lack its text if it was unsent and had none.
 */
export function messageId(conversationKey: string, message: ExportMessage, order: number | null): string {
  const base = idBase(conversationKey, message);
  return sha256(order === null ? base : `${base}${FIELD}${order}`);
}

/** What a message's id is made of, but for its place among records alike in all of it (see syntheticIds). */
export function idBase(conversationKey: string, m: ExportMessage): string {
  return ["messenger", conversationKey, m.senderName, m.timestamp, m.type, m.text ?? "", m.media?.length ?? 0].join(SEPARATOR);
}

/** A record's media file names, in order. */
export function mediaNames(m: ExportMessage): string[] {
  return (m.media ?? []).map((item) => (typeof item?.uri === "string" ? posix.basename(item.uri) : ""));
}

/** The captain's own name: set in the connector's settings, or the one name in every chat. */
function selfName(threads: ExportThread[], config: Record<string, unknown>): string {
  if (typeof config.selfName === "string" && config.selfName) return config.selfName;
  const [first, ...rest] = threads;
  const candidates = [...new Set(first?.participants ?? [])].filter(
    (name) => !isPlaceholderName(name) && rest.every((thread) => thread.participants.includes(name)),
  );
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `cannot tell which participant is you (${candidates.length} names are in every chat); ` +
      `set "selfName" in data/connectors/messenger-export.json`,
  );
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
