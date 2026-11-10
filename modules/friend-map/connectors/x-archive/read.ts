// Reads X's "Download an archive of your data": the zip X emails a link to
// (twitter-<date>-<hash>.zip), read in place and never extracted, or the
// folder it unzips to, or a folder holding just that zip.
//
//   data/account.js                     the captain: accountId, username, accountDisplayName
//   data/direct-messages.js             one-to-one chats
//   data/direct-messages-group.js       group chats
//   data/direct_messages_media/<message id>-<file>        their media
//   data/direct_messages_group_media/<message id>-<file>
//   data/tweets.js                      the captain's tweets, read only for the
//                                       names and @handles of the people they mention
//   data/manifest.js                    when the archive was made
//
// Each data file is a script, `window.YTD.<name>.part<n> = [ ... ]`; a big
// archive splits one into <file>-part1.js, <file>-part2.js, and so on. A chat is
// {dmConversation: {conversationId, messages: [...]}}, each record one of
//   messageCreate           {id, senderId, recipientId (one-to-one only), text,
//                            createdAt, mediaUrls, urls, reactions, editHistory}
//   joinConversation, participantsJoin, participantsLeave   (groups) who is in it
//   conversationNameUpdate  (groups) its name
// Tweets, likes, followers and following are not read as messages or people.
// The end-to-end-encrypted XChat messages (message-event.js) cannot be read and
// are only counted.
//
// Everything is keyed on X's own ids, so the same archive imported again, or a
// newer one that overlaps it, adds nothing twice:
// - an account is its numeric user id; the captain's comes from account.js;
// - a chat is its conversationId ("<id>-<id>" for one-to-one, a number for a group);
// - a message is its id.
// The archive names nobody else: a DM partner is only an id. So an account is
// named from the captain's tweets that mention it (its display name, with its
// @handle), else by the @handle a tweet replied to (a name, as any username
// is), else by its id, which the archive rules treat as no name (see isUnnamed
// in archive/archiving.ts).
// Following and follower lists hold ids alone, so they name no one.
// Media are found by the message id their file names start with, kept where
// they are in the unpacked archive (under data/platform-exports/; a zip holding
// media is refused until it is unpacked), hashed, and recorded as missing when
// the archive lacks them.
// Groups are read whatever their size: the archive rules decide who in a big
// group stays on the map (SMALL_GROUP_MAX in archive/stats.ts).

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { type AccountEvent, type AttachmentType, type Connector, type HistoryOptions, keepInPlace, mediaTypeOf, type MessageType, unpackFirst, type ZipEntry, ZipFile } from "../../../../sdk/connector.ts";
import { manifest } from "./manifest.ts";

export const xArchive: Connector = { manifest, history: readXArchive };

/** X's reaction kinds, as the app shows them. */
const REACTIONS: Record<string, string> = {
  like: "❤️", funny: "😂", surprised: "😲", sad: "😢", excited: "🔥", agree: "👍", disagree: "👎",
};

const MEDIA_FOLDERS = ["data/direct_messages_media/", "data/direct_messages_group_media/"];

interface MessageCreate {
  id: string;
  senderId: string;
  recipientId?: string;
  text?: string;
  createdAt: string;
  mediaUrls?: unknown[];
  urls?: Array<{ url?: unknown; expanded?: unknown }>;
  reactions?: Array<{ senderId?: unknown; reactionKey?: unknown; emoji?: unknown; createdAt?: unknown }>;
  editHistory?: unknown[];
}

interface Chat {
  id: string;
  type: "direct" | "group";
  messages: Array<MessageCreate & { sentAt: number }>;
  /** Everyone the chat's records name, the captain included. */
  people: Set<string>;
  title?: string;
}

interface Name {
  displayName: string;
  handle?: string;
  nameSource: string;
}

export async function readXArchive({ sources, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("an X archive is a single zip or folder; name just that one");
  const archive = await ArchiveFiles.open(sources[0]);
  const tallies = new Map<string, number>();
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  try {
    const self = await readSelf(archive);
    const chats = [
      ...(await readChats(archive, "direct-messages", "direct_messages", "direct", tally)),
      ...(await readChats(archive, "direct-messages-group", "direct_messages_group", "group", tally)),
    ];
    const madeAt = await archiveDate(archive);
    const times = chats.flatMap((c) => c.messages.map((m) => m.sentAt));
    const upTo = Math.max(madeAt ?? 0, ...times);

    const others = new Set(chats.flatMap((c) => [...c.people]).filter((id) => id !== self.id));
    const names = await namesFromTweets(archive, others);
    const announced = new Set<string>();
    const announce = async (id: string) => {
      if (announced.has(id)) return;
      announced.add(id);
      const account: AccountEvent = { kind: "account", key: id, keyKind: "id", displayName: id, nameSource: "none" };
      if (id === self.id) await emit({ ...account, ...self.name, isSelf: true });
      else await emit({ ...account, ...names.get(id) });
    };
    const named = [...others].filter((id) => names.has(id)).length;
    tally("people named from the captain's tweets or replies", named);
    tally("people known only by their X id", others.size - named);

    const mediaByMessage = new Map<string, string[]>();
    for (const name of archive.names) {
      const folder = MEDIA_FOLDERS.find((f) => name.startsWith(f));
      if (!folder || name.endsWith("/")) continue;
      const file = name.slice(folder.length);
      const messageId = file.split("-", 1)[0];
      mediaByMessage.set(messageId, [...(mediaByMessage.get(messageId) ?? []), name]);
    }

    let done = 0;
    for (const chat of chats) {
      chat.people.add(self.id);
      const members = [...chat.people].sort();
      for (const id of members) await announce(id);
      const partner = members.find((id) => id !== self.id);
      await emit({
        kind: "conversation",
        id: chat.id,
        type: chat.type,
        ...(chat.type === "group"
          ? (chat.title ? { title: chat.title } : {})
          : { title: partner ? (names.get(partner)?.displayName ?? partner) : self.name.displayName }),
        members,
      });

      for (const message of chat.messages) {
        const media = (message.mediaUrls ?? []).filter((url): url is string => typeof url === "string" && url !== "");
        const links = (message.urls ?? []).filter((u) => typeof u?.url === "string");
        // X writes a message's photo or video into its text as a t.co link to /messages/media/.
        const mediaLinks = links.filter((u) => typeof u.expanded === "string" && /\/messages\/media\//.test(u.expanded));
        let text = typeof message.text === "string" ? message.text : "";
        for (const link of mediaLinks) text = text.split(link.url as string).join("");
        if (mediaLinks.length > 0) text = text.trim();
        const type: MessageType = media.length > 0 ? "media" : links.length > mediaLinks.length ? "link" : "text";
        if ((message.editHistory ?? []).length > 0) tally("messages edited on X (the archive gives their last text)");
        const { sentAt: _sentAt, ...raw } = message;
        await emit({
          kind: "message",
          id: message.id,
          idKind: "platform",
          conversation: chat.id,
          sender: message.senderId,
          isFromSelf: message.senderId === self.id,
          sentAt: message.sentAt,
          type,
          ...(text ? { text } : {}),
          raw,
        });

        const files = mediaByMessage.get(message.id) ?? [];
        for (const [ordinal, url] of media.entries()) {
          const base = posix.basename(url.split("?")[0]);
          const file = files.find((f) => f.endsWith(`-${base}`)) ?? (media.length === files.length ? files[ordinal] : undefined);
          const fileName = file ? posix.basename(file) : base;
          const { type: guessed, mime } = mediaTypeOf(fileName);
          const attachmentType: AttachmentType = /\/dm_gif\//.test(url) ? "gif" : guessed;
          if (file && archive.pathOf(file) === null) throw unpackFirst("x-archive", "x", sources[0]);
          const inPlace = file ? await keepInPlace(archive.pathOf(file)!) : undefined;
          if (!file) tally("media not in the archive");
          await emit({
            kind: "attachment",
            message: message.id,
            ordinal,
            type: attachmentType,
            ...(fileName ? { filename: fileName } : {}),
            ...(mime ? { mime } : {}),
            ...(inPlace ? { inPlace } : {}),
          });
        }

        for (const reaction of message.reactions ?? []) {
          const emoji = typeof reaction?.emoji === "string" && reaction.emoji
            ? reaction.emoji
            : REACTIONS[typeof reaction?.reactionKey === "string" ? reaction.reactionKey : ""];
          if (typeof reaction?.senderId !== "string" || !reaction.senderId || !emoji) {
            tally("reactions without a sender or of a kind not known");
            continue;
          }
          await announce(reaction.senderId);
          const addedAt = typeof reaction.createdAt === "string" ? Date.parse(reaction.createdAt) : NaN;
          await emit({ kind: "reaction", message: message.id, actor: reaction.senderId, emoji, ...(Number.isSafeInteger(addedAt) ? { addedAt } : {}) });
        }
      }

      if (chat.messages.length > 0) {
        await emit({ kind: "coverage", conversation: chat.id, from: Math.min(...chat.messages.map((m) => m.sentAt)), to: upTo });
      }
      await emit({ kind: "progress", done: ++done, total: chats.length, note: "chats" });
    }

    if (times.length > 0) await emit({ kind: "coverage", from: Math.min(self.createdAt ?? Infinity, ...times), to: upTo });
    const encrypted = await countEncrypted(archive);
    if (encrypted > 0) tally("end-to-end-encrypted XChat messages (message-event.js), which cannot be read", encrypted);
    for (const [name, count] of tallies) if (count > 0) await emit({ kind: "tally", name, count });
  } finally {
    await archive.close();
  }
}

/** The files of an archive, by their path from the folder holding data/: in a zip, or in a folder. */
class ArchiveFiles {
  readonly names: string[];
  private readonly zip: ZipFile | null;
  private readonly entries: Map<string, ZipEntry>;
  private readonly folder: string | null;

  private constructor(names: string[], zip: ZipFile | null, entries: Map<string, ZipEntry>, folder: string | null) {
    this.names = names;
    this.zip = zip;
    this.entries = entries;
    this.folder = folder;
  }

  static async open(source: string): Promise<ArchiveFiles> {
    if (!(await stat(source)).isDirectory()) return ArchiveFiles.ofZip(source);
    const files = (await readdir(source, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join("/"));
    const root = rootOf(files);
    if (root !== null) return new ArchiveFiles(within(files, root), null, new Map(), join(source, root));
    const zips = (await readdir(source)).filter((name) => name.toLowerCase().endsWith(".zip") && !name.startsWith("."));
    if (zips.length === 1) return ArchiveFiles.ofZip(join(source, zips[0]));
    throw new Error(
      zips.length === 0
        ? `${source} is not an X archive: it has no data/account.js and no zip`
        : `${source} holds ${zips.length} zips; name the one to import`,
    );
  }

  private static async ofZip(path: string): Promise<ArchiveFiles> {
    const zip = await ZipFile.open(path);
    const root = rootOf(zip.entries.map((e) => e.name));
    if (root === null) {
      await zip.close();
      throw new Error(`${path} is not an X archive: it has no data/account.js`);
    }
    const entries = new Map(zip.entries.filter((e) => e.name.startsWith(root)).map((e) => [e.name.slice(root.length), e]));
    return new ArchiveFiles([...entries.keys()], zip, entries, null);
  }

  has(name: string): boolean {
    return this.entries.has(name) || (this.folder !== null && this.names.includes(name));
  }

  async read(name: string): Promise<Buffer> {
    if (this.zip) return this.zip.read(this.entries.get(name)!);
    return readFile(join(this.folder!, name));
  }

  async stream(name: string): Promise<Readable> {
    if (this.zip) return this.zip.stream(this.entries.get(name)!);
    return createReadStream(join(this.folder!, name));
  }

  /** The file's absolute path on disk, or null for one in a zip. */
  pathOf(name: string): string | null {
    return this.folder === null ? null : resolve(this.folder, name);
  }

  async close(): Promise<void> {
    await this.zip?.close();
  }

  /** The data file's parts, in order: data/<file>.js, then data/<file>-part1.js, -part2.js, ... */
  parts(file: string): string[] {
    const pattern = new RegExp(`^data/${file}(?:-part(\\d+))?\\.js$`);
    return this.names
      .map((name) => ({ name, match: pattern.exec(name) }))
      .filter((f) => f.match)
      .sort((a, b) => Number(a.match![1] ?? 0) - Number(b.match![1] ?? 0))
      .map((f) => f.name);
  }

  /** Every record of a data file's parts, each part checked to be the `window.YTD.<name>.part<n> = [...]` X writes. */
  async records(file: string, name: string): Promise<unknown[]> {
    const records: unknown[] = [];
    for (const part of this.parts(file)) records.push(...parseDataFile((await this.read(part)).toString("utf8"), part, name));
    return records;
  }
}

/** Where data/account.js sits: "" for an archive at the top, or the folder it is in. */
function rootOf(names: string[]): string | null {
  const account = names.filter((n) => n === "data/account.js" || n.endsWith("/data/account.js")).sort((a, b) => a.length - b.length)[0];
  return account === undefined ? null : account.slice(0, -"data/account.js".length);
}

function within(names: string[], root: string): string[] {
  return names.filter((n) => n.startsWith(root)).map((n) => n.slice(root.length));
}

/**
 * The records of one of X's data files, `window.YTD.<name>.part<n> = [ ... ]`.
 * Throws, naming the file, when it is not that; never quotes what is in it.
 */
export function parseDataFile(text: string, file: string, name: string): unknown[] {
  const head = /^﻿?\s*window\.YTD\.([A-Za-z0-9_]+)\.part\d+\s*=\s*/.exec(text);
  const shape = `window.YTD.${name}.part<n> = [...]`;
  if (!head) throw new Error(`${file} is not an X archive data file: it does not start with ${shape}`);
  if (head[1] !== name) throw new Error(`${file} holds X's ${head[1]} data, not ${name}`);
  let records: unknown;
  try {
    records = JSON.parse(text.slice(head[0].length).trim().replace(/;$/, ""));
  } catch {
    throw new Error(`${file} is not an X archive data file: what follows ${shape.split(" =")[0]} = is not JSON`);
  }
  if (!Array.isArray(records)) throw new Error(`${file} is not an X archive data file: ${shape.split(" =")[0]} is not a list`);
  return records;
}

async function readSelf(archive: ArchiveFiles): Promise<{ id: string; name: Name; createdAt: number | null }> {
  const [record] = await archive.records("account", "account");
  const account = (record as { account?: Record<string, unknown> } | undefined)?.account;
  if (typeof account?.accountId !== "string" || !account.accountId) throw new Error("data/account.js does not give the captain's accountId");
  const username = typeof account.username === "string" && account.username ? `@${account.username}` : undefined;
  const displayName = typeof account.accountDisplayName === "string" && account.accountDisplayName.trim() ? account.accountDisplayName.trim() : username;
  const createdAt = typeof account.createdAt === "string" ? Date.parse(account.createdAt) : NaN;
  return {
    id: account.accountId,
    name: displayName ? { displayName, ...(username ? { handle: username } : {}), nameSource: "export" } : { displayName: account.accountId, nameSource: "none" },
    createdAt: Number.isSafeInteger(createdAt) ? createdAt : null,
  };
}

async function readChats(
  archive: ArchiveFiles, file: string, name: string, type: Chat["type"], tally: (name: string, count?: number) => void,
): Promise<Chat[]> {
  const chats = new Map<string, Chat>();
  for (const record of await archive.records(file, name)) {
    const conversation = (record as { dmConversation?: { conversationId?: unknown; messages?: unknown } } | null)?.dmConversation;
    if (typeof conversation?.conversationId !== "string" || !conversation.conversationId || !Array.isArray(conversation.messages)) {
      tally("chats that could not be read");
      continue;
    }
    const id = conversation.conversationId;
    // A chat split over two parts of a big archive is one chat.
    const chat = chats.get(id) ?? { id, type, messages: [], people: new Set<string>() };
    chats.set(id, chat);
    if (type === "direct") for (const person of id.split("-")) if (/^\d+$/.test(person)) chat.people.add(person);
    let titledAt = -Infinity;
    for (const item of conversation.messages as Array<Record<string, Record<string, unknown> | undefined> | null>) {
      const create = item?.messageCreate;
      if (create) {
        const sentAt = typeof create.createdAt === "string" ? Date.parse(create.createdAt) : NaN;
        if (typeof create.id !== "string" || !create.id || typeof create.senderId !== "string" || !create.senderId || !Number.isSafeInteger(sentAt)) {
          tally("messages that could not be read");
          continue;
        }
        chat.messages.push({ ...(create as unknown as MessageCreate), sentAt });
        chat.people.add(create.senderId);
        if (typeof create.recipientId === "string" && create.recipientId) chat.people.add(create.recipientId);
        continue;
      }
      const event = item?.joinConversation ?? item?.participantsJoin ?? item?.participantsLeave ?? item?.conversationNameUpdate;
      if (!event) {
        tally("chat records of a kind not known");
        continue;
      }
      tally("group joins, leaves and renames (read for who is in a group and its name, not kept as messages)");
      for (const list of [event.participantsSnapshot, event.userIds]) {
        if (Array.isArray(list)) for (const person of list) if (typeof person === "string" && person) chat.people.add(person);
      }
      if (typeof event.initiatingUserId === "string" && event.initiatingUserId) chat.people.add(event.initiatingUserId);
      const at = typeof event.createdAt === "string" ? Date.parse(event.createdAt) : NaN;
      if (item?.conversationNameUpdate && typeof event.name === "string" && (Number.isNaN(at) ? titledAt === -Infinity : at >= titledAt)) {
        chat.title = event.name;
        titledAt = Number.isNaN(at) ? titledAt : at;
      }
    }
  }
  for (const chat of chats.values()) chat.messages.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
  return [...chats.values()];
}

/**
 * Names for these accounts from the captain's own tweets: the display name and
 * @handle of an account a tweet mentions, else the @handle of one it replies to.
 * Newer tweets come first in the archive, so the newest name wins.
 */
async function namesFromTweets(archive: ArchiveFiles, wanted: Set<string>): Promise<Map<string, Name>> {
  const names = new Map<string, Name>();
  const handles = new Map<string, string>();
  // Newer archives call the file tweets.js (YTD.tweets), older ones tweet.js (YTD.tweet).
  const tweets = [...(await archive.records("tweets", "tweets")), ...(await archive.records("tweet", "tweet"))];
  for (const record of tweets) {
    const tweet = (record as { tweet?: Record<string, unknown> } | null)?.tweet;
    if (!tweet) continue;
    const mentions = (tweet.entities as { user_mentions?: unknown } | undefined)?.user_mentions;
    for (const mention of Array.isArray(mentions) ? (mentions as Array<Record<string, unknown>>) : []) {
      const id = mention?.id_str;
      if (typeof id !== "string" || !wanted.has(id) || names.has(id)) continue;
      const handle = typeof mention.screen_name === "string" && mention.screen_name ? `@${mention.screen_name}` : undefined;
      const name = typeof mention.name === "string" ? mention.name.trim() : "";
      if (name) names.set(id, { displayName: name, ...(handle ? { handle } : {}), nameSource: "tweet" });
      else if (handle && !handles.has(id)) handles.set(id, handle);
    }
    const repliedTo = tweet.in_reply_to_user_id_str;
    const screenName = tweet.in_reply_to_screen_name;
    if (typeof repliedTo === "string" && wanted.has(repliedTo) && typeof screenName === "string" && screenName && !handles.has(repliedTo)) {
      handles.set(repliedTo, `@${screenName}`);
    }
  }
  for (const [id, handle] of handles) if (!names.has(id)) names.set(id, { displayName: handle, handle, nameSource: "handle" });
  return names;
}

/** When the archive was made, from data/manifest.js (`window.__THAR_CONFIG = {...}`), if it says. */
async function archiveDate(archive: ArchiveFiles): Promise<number | null> {
  if (!archive.has("data/manifest.js")) return null;
  const text = (await archive.read("data/manifest.js")).toString("utf8");
  try {
    const config = JSON.parse(text.slice(text.indexOf("=") + 1).trim().replace(/;$/, "")) as { archiveInfo?: { generationDate?: unknown } };
    const at = typeof config.archiveInfo?.generationDate === "string" ? Date.parse(config.archiveInfo.generationDate) : NaN;
    return Number.isSafeInteger(at) ? at : null;
  } catch {
    return null;
  }
}

/** How many XChat messages message-event.js holds: end-to-end encrypted, so counted and never read. */
async function countEncrypted(archive: ArchiveFiles): Promise<number> {
  let count = 0;
  for (const record of await archive.records("message-event", "message_event")) {
    if ((record as { messageEvent?: { detail?: { messageCreateEvent?: unknown } } } | null)?.messageEvent?.detail?.messageCreateEvent) count++;
  }
  return count;
}
