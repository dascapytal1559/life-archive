// messenger-export's reader as it was before it keyed chats by name (see
// server/archive/messengerPhoneChats.ts), kept as it was for the repair's
// tests: they import with it, as the captain's archive was, then repair it,
// then import with the reader as it is now. It keyed a group, and a chat with
// a placeholder ("Facebook user"), by its threadName with the export's number
// in it, and an empty chat with a placeholder by the export's newest message.
// Never change it, but to follow a change to what it imports from.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type HistoryOptions, isPlaceholderName, keepInPlace, mediaTypeOf, type MessageType, unpackFirst } from "../../../sdk/server.ts";
import { ExportParts, type ExportFile } from "../connectors/metaDyiParts.ts";

interface ExportThread {
  participants: string[];
  threadName: string;
  messages: ExportMessage[];
}

interface ExportMessage {
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

export async function readMessengerExportBefore({ sources, config, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("this export is a single zip; name just that one file, or the folder it is unpacked in");
  const parts = await ExportParts.open(sources);
  const files = [...parts.files.values()];
  const tallies = new Map<string, number>();
  const tally = (name: string) => tallies.set(name, (tallies.get(name) ?? 0) + 1);
  try {
    const threadEntries = files.filter((e) => e.name.endsWith(".json") && !e.name.startsWith("media/"));
    const mediaByName = new Map<string, ExportFile[]>();
    for (const entry of files) {
      if (!entry.name.startsWith("media/")) continue;
      const name = posix.basename(entry.name);
      mediaByName.set(name, [...(mediaByName.get(name) ?? []), entry]);
    }

    const threads: ExportThread[] = [];
    for (const entry of threadEntries) {
      const thread = parseThread(await parts.read(entry));
      if (thread) threads.push(thread);
      else tally("chat files that could not be read");
    }
    const self = selfName(threads, config);
    const exportedUpTo = Math.max(0, ...threads.flatMap((t) => t.messages.map((m) => m.timestamp)));

    const announced = new Set<string>();
    const conversationKeys = new Set<string>();
    let done = 0;
    for (const thread of threads) {
      const firstAt = Math.min(...thread.messages.map((m) => m.timestamp), exportedUpTo);
      const hasPlaceholder = thread.participants.some(isPlaceholderName);
      const names = [...new Set(thread.participants)].sort();
      const type = names.length > 2 ? "group" : "direct";
      const baseKey = [
        names.join(SEPARATOR),
        ...(type === "group" || hasPlaceholder ? [thread.threadName] : []),
        ...(hasPlaceholder ? [String(firstAt)] : []),
      ].join("\u001e");
      // Chats with an unknown account and no messages can match exactly; they are told apart by order in
      // the export. (Two chats between the same named people are one conversation.)
      let conversationKey = baseKey;
      for (let n = 2; hasPlaceholder && conversationKeys.has(conversationKey); n++) conversationKey = `${baseKey}\u001e${n}`;
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
        title: type === "group" ? thread.threadName : (names.find((n) => n !== self) ?? thread.threadName),
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

      if (thread.messages.length > 0) {
        await emit({ kind: "coverage", conversation: conversationId, from: firstAt, to: exportedUpTo });
      }
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
 * how long it was, nor whether it was answered.
 */
function isCall(message: Pick<ExportMessage, "type" | "text" | "media" | "isUnsent">): boolean {
  return message.type === "link" && !message.text && !(Array.isArray(message.media) && message.media.length > 0) && message.isUnsent !== true;
}

function parseThread(bytes: Buffer): ExportThread | null {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const thread = data as Partial<ExportThread>;
  if (!Array.isArray(thread.participants) || !Array.isArray(thread.messages)) return null;
  if (!thread.participants.every((p) => typeof p === "string")) return null;
  const messages = thread.messages.filter(
    (m): m is ExportMessage =>
      typeof m === "object" && m !== null && typeof m.senderName === "string" && Number.isSafeInteger(m.timestamp) &&
      typeof m.type === "string",
  );
  return { participants: thread.participants, threadName: String(thread.threadName ?? ""), messages };
}

/**
 * A message's id: a hash of its chat, sender, time, type, text and media count.
 * Records that share all of those (several photos sent in one millisecond, each
 * its own record) also hash their media file names, so they stay apart while
 * exact duplicate records collapse into one. Other ids never depend on media
 * file names, which may not be stable between exports.
 */
function syntheticIds(conversationKey: string, messages: ExportMessage[]): Map<ExportMessage, string> {
  const base = (m: ExportMessage) =>
    ["messenger", conversationKey, m.senderName, m.timestamp, m.type, m.text ?? "", m.media?.length ?? 0].join(SEPARATOR);
  const mediaNames = (m: ExportMessage) => (m.media ?? []).map((item) => (typeof item?.uri === "string" ? posix.basename(item.uri) : ""));
  const byBase = new Map<string, ExportMessage[]>();
  for (const message of messages) byBase.set(base(message), [...(byBase.get(base(message)) ?? []), message]);
  const ids = new Map<ExportMessage, string>();
  for (const [key, group] of byBase) {
    const distinctMedia = new Set(group.map((m) => JSON.stringify(mediaNames(m)))).size > 1;
    for (const message of group) {
      ids.set(message, sha256(distinctMedia ? [key, ...mediaNames(message)].join(SEPARATOR) : key));
    }
  }
  return ids;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
