// Reads Meta's "Download your information" export of messages, in JSON, as
// Facebook and Instagram both write it: one download, often split into several
// zip parts (see metaDyiParts.ts). Each connector (facebook-dyi, instagram-dyi) names
// what differs in a MetaDyiFlavour; the rest is read the same way.
//
//   your_<facebook|instagram>_activity/messages/<folder>/<chat>_<thread id>/message_<n>.json
//   your_<facebook|instagram>_activity/messages/<folder>/<chat>_<thread id>/{photos,videos,audio,gifs,files}/<file>
//   your_facebook_activity/messages/stickers_used/<file>
//
// <folder> is one of the flavour's folders: Facebook's inbox, e2ee_cutover (a
// chat's history from before it moved to end-to-end encryption),
// archived_threads, filtered_threads and message_requests; Instagram's inbox
// and message_requests. A long chat is split over message_1.json,
// message_2.json, ..., possibly in different parts. Each file is
// {participants: [{name}], title, thread_path, joinable_mode (a group's invite
// link), messages: [...]}, and each message is {sender_name, timestamp_ms,
// content, photos|videos|audio_files|gifs|files: [{uri}], sticker: {uri},
// share: {link}, reactions: [{actor, reaction, timestamp (seconds)}],
// is_unsent, call_duration}.
//
// Meta writes every string as its UTF-8 bytes, each escaped as if it were
// a Latin-1 character ("JosÃ©" for "José"), so every string is
// decoded back (see fixText).
//
// Like Messenger's phone export, it gives no message ids and names only, so:
// - accounts are keyed by display name, the same keys the messenger-export
//   connector uses, so a person is one account whichever export named them;
//   a placeholder ("Facebook user", "Instagram User", a deleted account) is a
//   different account in each chat;
// - a chat is keyed by its thread id (the number ending its folder name),
//   which stays put when the chat is renamed or moves between folders;
// - a message's id is a hash of its connector, chat, sender and millisecond,
//   with its text and media only when that is not enough to tell records apart
//   (see syntheticIds), so a later export gives the same ids, and a message
//   later unsent or edited updates the one already imported.
// Messages that the phone export brought in too are matched by the archive
// (see archive/write.ts), not here.
//
// A Facebook Marketplace chat (about something for sale) is marked as one: it
// has at most two people and is titled "<first name> · <item>", a title no
// other chat has. The export has no other marker for it, and Instagram has no
// Marketplace.
//
// Media are kept in place: the export is unpacked under data/platform-exports/
// (data/platform-exports/<platform>/<export date>/, its zips kept beside what
// they unpacked to) and each attachment points at its file there, hashed but
// never copied. Media no part has are recorded as missing.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type AttachmentType, type HistoryOptions, isPlaceholderName, keepInPlace, mediaTypeOf, type MessageType, type Platform, unpackFirst } from "../../../sdk/connector.ts";
import { ExportParts, type ExportFile } from "./metaDyiParts.ts";

/** What one Meta download differs in from another. */
export interface MetaDyiFlavour {
  /** The connector's id: the first part of its message ids, and where its settings are. */
  connector: string;
  platform: Platform;
  /** The folder the export's files are under, which older Facebook exports leave out of media paths. */
  activityFolder: string;
  /** The message folders read; any other is skipped. */
  folders: string[];
  /** Whether a chat can be a Marketplace one (Facebook's). */
  marketplace: boolean;
}

interface DyiThread {
  participants?: Array<{ name?: unknown }>;
  title?: unknown;
  thread_path?: unknown;
  joinable_mode?: unknown;
  messages: DyiMessage[];
}

interface DyiMedia {
  uri?: unknown;
}

interface DyiMessage {
  sender_name: string;
  timestamp_ms: number;
  content?: unknown;
  photos?: DyiMedia[];
  videos?: DyiMedia[];
  audio_files?: DyiMedia[];
  gifs?: DyiMedia[];
  files?: DyiMedia[];
  sticker?: DyiMedia;
  share?: { link?: unknown };
  reactions?: Array<{ actor?: unknown; reaction?: unknown; timestamp?: unknown }>;
  is_unsent?: unknown;
  call_duration?: unknown;
}

/** A chat: every file of it, found by the first pass. */
interface ThreadInfo {
  key: string;
  files: ExportFile[];
  participants: Set<string>;
  title: string;
  /** Whether any of its files has a group's invite link. */
  joinable: boolean;
}

const SEPARATOR = "\u001f";
/** What joins the seller's first name and the item in a Marketplace chat's title. */
const MARKETPLACE_SEPARATOR = " · ";

/** A message's media lists, in the order its attachments are numbered. */
const MEDIA_FIELDS: Array<[keyof DyiMessage, AttachmentType]> = [
  ["photos", "image"],
  ["videos", "video"],
  ["audio_files", "audio"],
  ["gifs", "gif"],
  ["files", "file"],
];

export async function readMetaDyi(flavour: MetaDyiFlavour, { sources, config, emit }: HistoryOptions): Promise<void> {
  /** A JSON file directly in a message folder or in a chat's folder there, not in its media folders. */
  const chatFile = new RegExp(`(?:^|/)messages/(?:${flavour.folders.join("|")})/(?:([^/]+)/)?([^/]+)\\.json$`);
  const parts = await ExportParts.open(sources);
  // Media still in a zip have nowhere to stay; the chats' JSON can be read from one.
  if ([...parts.files.values()].some((file) => parts.pathOf(file) === null && !file.name.endsWith(".json"))) {
    await parts.close();
    throw unpackFirst(flavour.connector, flavour.platform, sources.join(", "));
  }
  const tallies = new Map<string, number>(parts.skipped);
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  try {
    // First pass: which files make up each chat, who is in it, and how far the export reaches.
    const threads = new Map<string, ThreadInfo>();
    let exportedFrom = Infinity;
    let exportedUpTo = 0;
    for (const file of [...parts.files.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const match = chatFile.exec(file.name);
      if (!match) continue;
      const thread = parseThread(await parts.read(file));
      if (!thread) {
        tally("JSON files in a message folder that are not chats");
        continue;
      }
      const key = threadKey(thread, match[1] ?? match[2]);
      const info = threads.get(key) ?? { key, files: [], participants: new Set<string>(), title: "", joinable: false };
      threads.set(key, info);
      info.files.push(file);
      for (const p of thread.participants ?? []) if (typeof p?.name === "string") info.participants.add(p.name);
      if (!info.title && typeof thread.title === "string") info.title = thread.title;
      if (thread.joinable_mode && typeof thread.joinable_mode === "object") info.joinable = true;
      for (const message of thread.messages) {
        exportedFrom = Math.min(exportedFrom, message.timestamp_ms);
        exportedUpTo = Math.max(exportedUpTo, message.timestamp_ms);
      }
    }
    const self = selfName([...threads.values()], config, flavour.connector);

    const announced = new Set<string>();
    let done = 0;
    let kept = 0;
    for (const info of [...threads.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      // Second pass, a chat at a time: its files in order (message_1, message_2, ...), so memory holds one chat.
      const messages: DyiMessage[] = [];
      for (const file of info.files.sort((a, b) => fileNumber(a.name) - fileNumber(b.name))) {
        for (const message of parseThread(await parts.read(file))!.messages) messages.push(message);
      }
      const conversationId = info.key;
      const tag = sha256(conversationId).slice(0, 8);
      const keyOf = (name: string) => (isPlaceholderName(name) ? `${name} #${tag}` : name);
      const announce = async (name: string) => {
        const key = keyOf(name);
        if (announced.has(key)) return key;
        announced.add(key);
        await emit({ kind: "account", key, keyKind: "name", displayName: name, nameSource: "export", ...(name === self ? { isSelf: true } : {}) });
        return key;
      };

      const names = [...info.participants].sort();
      const other = names.find((name) => name !== self);
      const marketplace = flavour.marketplace && names.length <= 2 && info.title.includes(MARKETPLACE_SEPARATOR);
      // People who left a group are no longer participants, but they were in it.
      const everyone = new Set([...names, ...messages.map((m) => m.sender_name)]);
      // A group has more than two people, counting those who left, a name of its own or an invite link; a direct
      // chat is titled with the other person's name. (A group everyone but one has left lists just two participants.)
      const type = !marketplace && (everyone.size > 2 || info.joinable || (names.length === 2 && info.title !== "" && info.title !== other))
        ? "group"
        : "direct";
      const members = new Set<string>();
      for (const name of everyone) members.add(await announce(name));
      await emit({
        kind: "conversation",
        id: conversationId,
        type,
        title: type === "group" || marketplace ? info.title : (other ?? info.title),
        members: [...members].sort(),
        ...(marketplace ? { marketplace: true } : {}),
      });

      const ids = syntheticIds(flavour.connector, conversationId, messages);
      for (const message of messages) {
        const id = ids.get(message)!;
        const sender = await announce(message.sender_name);
        const unsent = message.is_unsent === true;
        const media = mediaOf(message);
        const content = typeof message.content === "string" ? message.content : "";
        const link = typeof message.share?.link === "string" ? message.share.link : "";
        const text = content || link;
        await emit({
          kind: "message",
          id,
          idKind: "synthetic",
          conversation: conversationId,
          sender,
          isFromSelf: message.sender_name === self,
          sentAt: message.timestamp_ms,
          type: messageType(message, media.length),
          ...(text && !unsent ? { text } : {}),
          ...(unsent ? { unsent: true } : {}),
          ...(callSeconds(message) !== undefined ? { callSeconds: callSeconds(message) } : {}),
          raw: message,
        });

        for (const [ordinal, { uri, type: listed }] of media.entries()) {
          const fileName = posix.basename(uri);
          const file = uri && !/^[a-z]+:\/\//i.test(uri) ? findFile(parts, uri, flavour.activityFolder) : undefined;
          if (!file) tally(uri && /^[a-z]+:\/\//i.test(uri) ? "media only linked, not in the export" : "media not in the export");
          const { type, mime } = attachmentType(listed, fileName);
          if (file && parts.pathOf(file) === null) throw unpackFirst(flavour.connector, flavour.platform, sources.join(", "));
          const inPlace = file ? await keepInPlace(parts.pathOf(file)!) : undefined;
          if (inPlace) kept++;
          await emit({
            kind: "attachment",
            message: id,
            ordinal,
            type,
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
          const at = typeof reaction.timestamp === "number" && Number.isSafeInteger(reaction.timestamp) && reaction.timestamp > 0
            ? (reaction.timestamp < 1e12 ? reaction.timestamp * 1000 : reaction.timestamp)
            : undefined;
          await emit({ kind: "reaction", message: id, actor: await announce(reaction.actor), emoji: reaction.reaction, ...(at ? { addedAt: at } : {}) });
        }
      }

      if (messages.length > 0) {
        const firstAt = messages.reduce((min, m) => Math.min(min, m.timestamp_ms), Infinity);
        await emit({ kind: "coverage", conversation: conversationId, from: firstAt, to: exportedUpTo });
      }
      await emit({ kind: "progress", done: ++done, total: threads.size, note: `chats (${kept} media files)` });
    }

    if (exportedUpTo > 0) await emit({ kind: "coverage", from: exportedFrom, to: exportedUpTo });
    for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
  } finally {
    await parts.close();
  }
}

/**
 * Undoes Meta's escaping: a string whose characters all fit in one byte
 * and together are valid UTF-8 is read as UTF-8. Plain ASCII, and anything
 * already decoded or not valid UTF-8, is left as it is.
 */
export function fixText(text: string): string {
  if (!/[\u0080-ÿ]/.test(text) || /[^\u0000-ÿ]/.test(text)) return text;
  try {
    return UTF8.decode(Buffer.from(text, "latin1"));
  } catch {
    return text;
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function parseThread(bytes: Buffer): DyiThread | null {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"), (_key, value: unknown) => (typeof value === "string" ? fixText(value) : value));
  } catch {
    return null;
  }
  const thread = data as Partial<DyiThread>;
  if (typeof thread !== "object" || thread === null || !Array.isArray(thread.messages)) return null;
  if (!Array.isArray(thread.participants)) return null;
  const messages = thread.messages.filter(
    (m): m is DyiMessage =>
      typeof m === "object" && m !== null && typeof m.sender_name === "string" && Number.isSafeInteger(m.timestamp_ms),
  );
  return { ...thread, messages } as DyiThread;
}

/**
 * Messenger's like, the thumbs-up its send button turns into, is a stock
 * sticker in three sizes (held longer, bigger), each always the same file in
 * stickers_used/: 72, 168 and 274 pixels square. Which one a sticker file is,
 * from its name, or null when it is some other sticker.
 */
export function messengerLike(fileName: string | null): "small" | "medium" | "large" | null {
  return LIKES[/^(\d+)\./.exec(fileName ?? "")?.[1] ?? ""] ?? null;
}

const LIKES: Record<string, "small" | "medium" | "large"> = {
  "369239263222822": "small",
  "369239343222814": "medium",
  "369239383222810": "large",
};

/** A chat's key: its thread id (the number ending its folder name), or the folder name if it has none. */
function threadKey(thread: DyiThread, fallback: string): string {
  const folder = typeof thread.thread_path === "string" && thread.thread_path ? posix.basename(thread.thread_path) : fallback;
  const id = /_(\d+)$/.exec(folder)?.[1];
  return id ? `thread:${id}` : `thread:${folder}`;
}

function fileNumber(name: string): number {
  return Number(/_(\d+)\.json$/.exec(name)?.[1] ?? 0);
}

/** A message's attachments in the order they are numbered: its media lists, then its sticker. */
function mediaOf(message: DyiMessage): Array<{ uri: string; type: AttachmentType }> {
  const items: Array<{ item: DyiMedia; type: AttachmentType }> = MEDIA_FIELDS.flatMap(([field, type]) =>
    (Array.isArray(message[field]) ? (message[field] as DyiMedia[]) : []).map((item) => ({ item, type })),
  );
  if (message.sticker && typeof message.sticker === "object") items.push({ item: message.sticker, type: "sticker" });
  return items.map(({ item, type }) => ({ uri: typeof item?.uri === "string" ? item.uri : "", type }));
}

/**
 * How long a call record says the call was connected, in whole seconds: Messenger and Instagram give every call
 * record (one-to-one or group, audio or video) its call_duration, 0 for one missed or not answered. Undefined when
 * the record has none.
 */
export function callSeconds(message: { call_duration?: unknown }): number | undefined {
  const duration = message.call_duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : undefined;
}

function messageType(message: DyiMessage, mediaCount: number): MessageType {
  if (message.call_duration !== undefined) return "call";
  if (message.sticker) return "sticker";
  if (mediaCount > 0) return "media";
  if (message.share) return "link";
  if (typeof message.content === "string" && message.content) return "text";
  return "other";
}

/** The attachment's type from the list it is in, and its MIME type from its extension. */
function attachmentType(listed: AttachmentType, fileName: string): { type: AttachmentType; mime?: string } {
  const byName = mediaTypeOf(fileName);
  // Voice messages are .mp4 files holding only sound.
  if (listed === "audio" && /\.mp4$/i.test(fileName)) return { type: "audio", mime: "audio/mp4" };
  if (listed === "image" && byName.type === "gif") return byName;
  return { type: listed, ...(byName.mime ? { mime: byName.mime } : {}) };
}

/** The export file a message's uri names; older exports leave out the activity folder (your_facebook_activity/). */
function findFile(parts: ExportParts, uri: string, activityFolder: string): ExportFile | undefined {
  const path = uri.replace(/^\.?\//, "");
  return parts.files.get(path) ?? parts.files.get(`${activityFolder}/${path}`);
}

/**
 * A message's id: a hash of its chat, sender and millisecond. Records that
 * share all three also hash their text, media file names and whether they
 * were unsent, so they stay apart while exact duplicate records collapse into
 * one. A lone record's id never depends on its text, so an edit or unsend in a
 * later export updates it rather than adding it again.
 */
function syntheticIds(connector: string, conversationId: string, messages: DyiMessage[]): Map<DyiMessage, string> {
  const base = (m: DyiMessage) => [connector, conversationId, m.sender_name, m.timestamp_ms].join(SEPARATOR);
  const detail = (m: DyiMessage) =>
    [typeof m.content === "string" ? m.content : "", m.is_unsent === true, ...mediaOf(m).map(({ uri }) => posix.basename(uri))].join(SEPARATOR);
  const byBase = new Map<string, DyiMessage[]>();
  for (const message of messages) byBase.set(base(message), [...(byBase.get(base(message)) ?? []), message]);
  const ids = new Map<DyiMessage, string>();
  for (const [key, group] of byBase) {
    for (const message of group) ids.set(message, sha256(group.length > 1 ? [key, detail(message)].join(SEPARATOR) : key));
  }
  return ids;
}

/** The captain's own name: set in the connector's settings, or the name in the most chats. */
function selfName(threads: ThreadInfo[], config: Record<string, unknown>, connector: string): string {
  if (typeof config.selfName === "string" && config.selfName) return config.selfName;
  const counts = new Map<string, number>();
  for (const thread of threads) {
    for (const name of thread.participants) if (!isPlaceholderName(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const [first, second] = [...counts.values()].sort((a, b) => b - a);
  const found = first !== undefined && first !== second && first * 2 > threads.length
    ? [...counts].find(([, count]) => count === first)![0]
    : null;
  if (found) return found;
  throw new Error(
    `cannot tell which participant is you (no one name is in most chats); set \"selfName\" in data/connectors/${connector}.json`,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
