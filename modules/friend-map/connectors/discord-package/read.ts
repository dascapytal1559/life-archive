// Reads Discord's data package (Settings > Data & Privacy > Request your data):
// the zip Discord emails a link to (package.zip), read in place and never
// extracted, or the folder it unzips to, or a folder holding just that zip.
// Only the Messages section is needed; Account adds names when it is there.
//
//   Messages/index.json                   each channel id to Discord's label for it:
//                                         "Direct Message with <username>", "<channel>, <server>",
//                                         a group DM's name, or null
//   Messages/c<channel id>/channel.json   {id, type, name?, guild?: {id, name}, recipients?: [user id]}
//   Messages/c<channel id>/messages.json  [{ID, Timestamp, Contents, Attachments}]
//   Account/user.json                     (only with the Account section) the captain's id,
//                                         username and global name, and his friends
//                                         ("relationships") with theirs and his nickname for each
//
// The package holds only the captain's own messages: nobody else's, in any
// channel. So every chat is marked selfOnly, and the archive rules never read
// the others' silence in it as one-sided (see archiving.ts). Discord leaves out
// messages he deleted.
//
// Everything is keyed on Discord's own ids, so the same package imported again,
// or a newer one that overlaps it, adds nothing twice:
// - an account is its user id (a snowflake); the captain's is the one in every
//   DM's and group DM's recipients (or Account/user.json's, or the selfId setting);
// - a chat is its channel id;
// - a message is its id, whose top bits are when it was sent, to the millisecond.
// A one-to-one DM is the captain and its other recipient; a group DM is its
// recipients; a server channel is only the captain, since the package names no
// one else in it, and is titled with Discord's label for it. Someone is named by
// the captain's nickname for them, else their global name (both only from
// Account/user.json), else their username (from Discord's label for a DM with
// them), which is their handle too and counts as a name, as an X or Signal
// username does; else by their id, which the archive rules treat as no name. Discord
// writes "Deleted User" in place of a deleted account's id: that is one account
// keyed by the name, as Messenger's "Facebook user" is, though it may stand for
// several, and Discord labels a DM with one "Unknown Participant".
// Attachments are links to Discord's servers: each is recorded as missing,
// unless a file of its name sits in the channel's folder, which is kept where
// it is (in the unpacked package, under data/platform-exports/).
// An older package's messages.csv is not read.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { type AccountEvent, type Connector, type HistoryOptions, keepInPlace, mediaTypeOf, type MessageType, unpackFirst, type ZipEntry, ZipFile } from "../../../../sdk/connector.ts";
import { manifest } from "./manifest.ts";

export const discordPackage: Connector = { manifest, history: readDiscordPackage };

/** Discord's own epoch: a snowflake's top 42 bits are milliseconds since it. */
const DISCORD_EPOCH = 1420070400000n;

/** Discord's channel types, as numbers (older packages) and names (newer ones); every other kind is a server's. */
const DM_TYPES = new Set<unknown>([1, "DM"]);
const GROUP_DM_TYPES = new Set<unknown>([3, "GROUP_DM"]);

const DM_LABEL = "Direct Message with ";
const UNKNOWN_PARTICIPANT = "Unknown Participant";
const isUserId = (id: string) => /^\d+$/.test(id);

type Kind = "direct" | "group-dm" | "server";

interface Channel {
  id: string;
  kind: Kind;
  /** Its recipients, the captain included: DMs and group DMs only. A user id, or "Deleted User". */
  recipients: string[];
  title?: string;
  /** Discord's label for it in index.json. */
  label: string | null;
  messages: Array<RawMessage & { sentAt: number }>;
}

interface RawMessage {
  ID: string;
  Timestamp?: unknown;
  Contents?: unknown;
  Attachments?: unknown;
}

interface Name {
  displayName: string;
  handle?: string;
  nameSource: string;
}

export async function readDiscordPackage({ sources, config, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("a Discord data package is a single zip or folder; name just that one");
  const pack = await PackageFiles.open(sources[0]);
  const tallies = new Map<string, number>();
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  try {
    const labels = await readIndex(pack);
    const channels = await readChannels(pack, labels, tally);
    const account = await readAccount(pack);
    const self = findSelf(channels, account, config);
    const names = nameEveryone(channels, account, self, tally);

    const announced = new Set<string>();
    const announce = async (id: string) => {
      if (announced.has(id)) return;
      announced.add(id);
      const base: AccountEvent = { kind: "account", key: id, keyKind: isUserId(id) ? "id" : "name", displayName: id, nameSource: "none" };
      if (id === self) await emit({ ...base, ...(account.self ?? { displayName: "Me" }), isSelf: true });
      else await emit({ ...base, ...names.get(id) });
    };

    const times = channels.flatMap((c) => c.messages.map((m) => m.sentAt));
    const upTo = Math.max(...times, 0);
    let done = 0;
    for (const channel of channels) {
      const members = [...new Set([self, ...channel.recipients])].sort();
      for (const id of members) await announce(id);
      const partner = members.find((id) => id !== self);
      if (channel.kind === "direct" && !partner) tally("one-to-one DMs that do not say who they were with");
      if (channel.kind === "server") tally("server channels (the package names no one but the captain in them)");
      const title = channel.kind === "direct" ? (partner ? names.get(partner)?.displayName ?? partner : undefined) : channel.title;
      await emit({
        kind: "conversation",
        id: channel.id,
        type: channel.kind === "direct" ? "direct" : "group",
        ...(title ? { title } : {}),
        members,
        selfOnly: true,
      });

      for (const message of channel.messages) {
        const links = typeof message.Attachments === "string" ? message.Attachments.split(/\s+/).filter(Boolean) : [];
        const text = typeof message.Contents === "string" ? message.Contents : "";
        const type: MessageType = links.length > 0 ? "media" : /https?:\/\/\S/.test(text) ? "link" : text ? "text" : "other";
        if (type === "other") tally("messages with neither text nor an attachment (a call, a sticker, an embed or the like; the package says no more)");
        const { sentAt, ...raw } = message;
        await emit({
          kind: "message",
          id: message.ID,
          idKind: "platform",
          conversation: channel.id,
          sender: self,
          isFromSelf: true,
          sentAt,
          type,
          ...(text ? { text } : {}),
          raw,
        });

        for (const [ordinal, link] of links.entries()) {
          const { filename, attachmentId } = attachmentOf(link);
          const file = filename ? pack.fileFor(channel.id, filename, attachmentId) : undefined;
          const { type: attachmentType, mime } = mediaTypeOf(filename ?? "");
          if (file && pack.pathOf(file) === null) throw unpackFirst("discord-package", "discord", sources[0]);
          const inPlace = file ? await keepInPlace(pack.pathOf(file)!) : undefined;
          if (!file) tally("attachments not in the package (Discord gives only a link to its servers)");
          await emit({
            kind: "attachment",
            message: message.ID,
            ordinal,
            type: attachmentType,
            ...(filename ? { filename } : {}),
            ...(mime ? { mime } : {}),
            ...(attachmentId ? { platformAttachmentId: attachmentId } : {}),
            ...(inPlace ? { inPlace } : {}),
          });
        }
      }

      if (channel.messages.length > 0) {
        await emit({ kind: "coverage", conversation: channel.id, from: channel.messages[0].sentAt, to: upTo });
      }
      await emit({ kind: "progress", done: ++done, total: channels.length, note: "channels" });
    }

    if (times.length > 0) await emit({ kind: "coverage", from: Math.min(...times), to: upTo });
    for (const [name, count] of tallies) if (count > 0) await emit({ kind: "tally", name, count });
  } finally {
    await pack.close();
  }
}

/** The files of a package, by their path from the folder holding Messages/: in a zip, or in a folder. */
class PackageFiles {
  readonly names: string[];
  private readonly zip: ZipFile | null;
  private readonly entries: Map<string, ZipEntry>;
  private readonly folder: string | null;
  /** Where index.json is, from the top of the package: "Messages/" as Discord writes it (or "messages/"). */
  readonly messages: string;
  /** Each channel's folder (Messages/c<id>/, or Messages/<id>/ in older packages), by channel id. */
  readonly channelFolders = new Map<string, string>();

  private constructor(names: string[], zip: ZipFile | null, entries: Map<string, ZipEntry>, folder: string | null) {
    this.names = names;
    this.zip = zip;
    this.entries = entries;
    this.folder = folder;
    this.messages = names.find((n) => /^messages\/index\.json$/i.test(n))!.slice(0, -"index.json".length);
    for (const name of names) {
      const match = /^c?(\d+)\/[^/]+$/.exec(name.slice(this.messages.length));
      if (name.startsWith(this.messages) && match) this.channelFolders.set(match[1], posix.dirname(name) + "/");
    }
  }

  static async open(source: string): Promise<PackageFiles> {
    if (!(await stat(source)).isDirectory()) return PackageFiles.ofZip(source);
    const files = (await readdir(source, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join("/"));
    const root = rootOf(files);
    if (root !== null) return new PackageFiles(within(files, root), null, new Map(), join(source, root));
    const zips = (await readdir(source)).filter((name) => name.toLowerCase().endsWith(".zip") && !name.startsWith("."));
    if (zips.length === 1) return PackageFiles.ofZip(join(source, zips[0]));
    throw new Error(
      zips.length === 0
        ? `${source} is not a Discord data package: it has no Messages/index.json and no zip`
        : `${source} holds ${zips.length} zips; name the one to import`,
    );
  }

  private static async ofZip(path: string): Promise<PackageFiles> {
    const zip = await ZipFile.open(path);
    const root = rootOf(zip.entries.map((e) => e.name));
    if (root === null) {
      await zip.close();
      throw new Error(`${path} is not a Discord data package: it has no Messages/index.json`);
    }
    const entries = new Map(
      zip.entries.filter((e) => e.name.startsWith(root) && !e.name.endsWith("/")).map((e) => [e.name.slice(root.length), e]),
    );
    return new PackageFiles([...entries.keys()], zip, entries, null);
  }

  has(name: string): boolean {
    return this.folder !== null ? this.names.includes(name) : this.entries.has(name);
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

  /** A file of the attachment's name in its channel's folder, if the package has one: under a folder named by its id first. */
  fileFor(channelId: string, filename: string, attachmentId?: string): string | undefined {
    const folder = this.channelFolders.get(channelId);
    if (!folder || filename === "channel.json" || filename === "messages.json") return undefined;
    const files = this.names.filter((n) => n.startsWith(folder) && posix.basename(n) === filename);
    return files.find((n) => attachmentId && n.endsWith(`/${attachmentId}/${filename}`)) ?? files[0];
  }
}

/** Where Messages/index.json sits: "" for a package at the top, or the folder it is in. */
function rootOf(names: string[]): string | null {
  const index = names.filter((n) => /(^|\/)messages\/index\.json$/i.test(n)).sort((a, b) => a.length - b.length)[0];
  return index === undefined ? null : index.slice(0, -"Messages/index.json".length);
}

function within(names: string[], root: string): string[] {
  return names.filter((n) => n.startsWith(root)).map((n) => n.slice(root.length));
}

/** A JSON file of the package, refused naming the file, never quoting it, when it is not JSON. */
async function readJson(pack: PackageFiles, name: string, reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown): Promise<unknown> {
  try {
    return JSON.parse((await pack.read(name)).toString("utf8"), reviver as Parameters<typeof JSON.parse>[1]);
  } catch {
    throw new Error(`${name} is not a Discord data package file: it is not JSON`);
  }
}

async function readIndex(pack: PackageFiles): Promise<Map<string, string | null>> {
  const name = `${pack.messages}index.json`;
  const index = await readJson(pack, name);
  if (!isObject(index)) throw new Error(`${name} is not a Discord data package file: it does not map channel ids to labels`);
  return new Map(Object.entries(index).map(([id, label]) => [id, typeof label === "string" && label.trim() ? label.trim() : null]));
}

/**
 * Every channel with its messages, oldest first. Discord writes a message's ID
 * as a bare number too big for a double, so it is read as written, as text.
 */
async function readChannels(pack: PackageFiles, labels: Map<string, string | null>, tally: (name: string, count?: number) => void): Promise<Channel[]> {
  const channels: Channel[] = [];
  for (const [id, folder] of [...pack.channelFolders].sort(([a], [b]) => compareIds(a, b))) {
    if (!pack.has(`${folder}messages.json`)) {
      if (pack.has(`${folder}messages.csv`)) {
        throw new Error(`${folder}messages.csv is an older Discord data package's, which is not read; request a new package`);
      }
      tally("channels with no messages.json");
      continue;
    }
    const about = pack.has(`${folder}channel.json`) ? await readJson(pack, `${folder}channel.json`) : {};
    if (!isObject(about)) throw new Error(`${folder}channel.json is not a Discord data package file: it is not an object`);
    const records = await readJson(pack, `${folder}messages.json`, (key, value, context) =>
      key === "ID" && typeof value === "number" && context?.source ? context.source : value);
    if (!Array.isArray(records)) throw new Error(`${folder}messages.json is not a Discord data package file: it is not a list`);

    const recipients = Array.isArray(about.recipients)
      ? about.recipients.map((r) => (isObject(r) ? r.id : r)).filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim())
      : [];
    const kind: Kind = DM_TYPES.has(about.type) ? "direct" : GROUP_DM_TYPES.has(about.type) ? "group-dm" : "server";
    const label = labels.get(id) ?? null;
    const guild = isObject(about.guild) && typeof about.guild.name === "string" ? about.guild.name : "";
    const name = typeof about.name === "string" ? about.name.trim() : "";
    const title = kind === "group-dm" ? name || label || undefined : label ?? ([name, guild].filter(Boolean).join(", ") || undefined);

    const messages: Channel["messages"] = [];
    for (const record of records) {
      const messageId = isObject(record) && typeof record.ID === "string" && /^\d+$/.test(record.ID) ? record.ID : null;
      if (!messageId) {
        tally("messages that could not be read");
        continue;
      }
      messages.push({ ...(record as unknown as RawMessage), sentAt: snowflakeTime(messageId) });
    }
    messages.sort((a, b) => a.sentAt - b.sentAt || compareIds(a.ID, b.ID));
    channels.push({ id, kind, recipients: kind === "server" ? [] : recipients, ...(title ? { title } : {}), label, messages });
  }
  return channels;
}

/** When a message was sent, from its id: Discord's snowflakes start with milliseconds since 2015. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

interface Account {
  id: string | null;
  self: Name | null;
  /** The captain's friends, by user id: his nickname for each, their global name and username. */
  friends: Map<string, { nickname?: string; globalName?: string; username?: string }>;
}

/** Account/user.json, when the package has the Account section: the captain, and his friends' names. */
async function readAccount(pack: PackageFiles): Promise<Account> {
  const file = pack.names.find((n) => /^account\/user\.json$/i.test(n));
  const none: Account = { id: null, self: null, friends: new Map() };
  if (!file) return none;
  const user = await readJson(pack, file);
  if (!isObject(user)) return none;
  const id = typeof user.id === "string" && /^\d+$/.test(user.id) ? user.id : null;
  const friends: Account["friends"] = new Map();
  for (const relationship of Array.isArray(user.relationships) ? user.relationships : []) {
    if (!isObject(relationship)) continue;
    const friend = isObject(relationship.user) ? relationship.user : {};
    const friendId = text(friend.id) ?? text(relationship.id);
    if (!friendId) continue;
    friends.set(friendId, { nickname: text(relationship.nickname), globalName: text(friend.global_name), username: text(friend.username) });
  }
  const username = text(user.username);
  const globalName = text(user.global_name);
  const self: Name | null = globalName
    ? { displayName: globalName, nameSource: "export", ...(username ? { handle: username } : {}) }
    : username ? { displayName: username, nameSource: "export", handle: username } : null;
  return { id, self, friends };
}

/**
 * The captain's user id: Account/user.json's, else the selfId setting, else
 * the one recipient every DM and group DM has. A package with no DM at all
 * names no one else either, so he is then "me".
 */
function findSelf(channels: Channel[], account: Account, config: Record<string, unknown>): string {
  if (account.id) return account.id;
  if (typeof config.selfId === "string" && /^\d+$/.test(config.selfId)) return config.selfId;
  const private_ = channels.filter((c) => c.kind !== "server" && c.recipients.length > 0);
  if (private_.length === 0) return "me";
  const everywhere = private_.map((c) => new Set(c.recipients.filter(isUserId))).reduce((a, b) => new Set([...a].filter((id) => b.has(id))));
  if (everywhere.size === 1) return [...everywhere][0];
  throw new Error(
    "the package does not say which Discord account is the captain's (no one recipient is in every DM); " +
      "set selfId (his user id) in data/connectors/discord-package.json",
  );
}

/** A name for everyone but the captain with a user id: his nickname for them, their global name, or their username. */
function nameEveryone(channels: Channel[], account: Account, self: string, tally: (name: string, count?: number) => void): Map<string, Name> {
  const usernames = new Map<string, string>();
  for (const channel of channels) {
    if (channel.kind !== "direct" || !channel.label?.startsWith(DM_LABEL)) continue;
    const others = channel.recipients.filter((id) => id !== self);
    if (others.length !== 1) continue;
    const label = channel.label.slice(DM_LABEL.length).trim();
    if (label && label !== UNKNOWN_PARTICIPANT && isUserId(others[0])) usernames.set(others[0], label);
  }
  const names = new Map<string, Name>();
  const everyone = new Set(channels.flatMap((c) => c.recipients).filter((id) => id !== self && isUserId(id)));
  for (const id of everyone) {
    const friend = account.friends.get(id);
    const username = friend?.username ?? usernames.get(id);
    const handle = username ? { handle: username } : {};
    if (friend?.nickname) names.set(id, { displayName: friend.nickname, nameSource: "nickname", ...handle });
    else if (friend?.globalName) names.set(id, { displayName: friend.globalName, nameSource: "profile", ...handle });
    else if (username) names.set(id, { displayName: username, nameSource: "handle", handle: username });
  }
  const count = (source: string) => [...names.values()].filter((n) => n.nameSource === source).length;
  tally("people named by the captain's nickname for them (Account/user.json)", count("nickname"));
  tally("people named by their global name (Account/user.json)", count("profile"));
  tally("people known only by their username (Discord's label for a DM with them)", count("handle"));
  tally("chats with a deleted account (Discord writes \"Deleted User\" for its id)", channels.filter((c) => c.recipients.some((id) => !isUserId(id))).length);
  tally("people known only by their Discord id (in a group DM, never in a DM)", everyone.size - names.size);
  return names;
}

/** An attachment link's file name and Discord's id for it: https://cdn.discordapp.com/attachments/<channel>/<id>/<file>?... */
function attachmentOf(link: string): { filename?: string; attachmentId?: string } {
  let path: string[];
  try {
    path = new URL(link).pathname.split("/").filter(Boolean);
  } catch {
    return {};
  }
  const last = path.at(-1);
  let filename: string | undefined;
  try {
    filename = last ? decodeURIComponent(last) : undefined;
  } catch {
    filename = last;
  }
  const attachmentId = path.length >= 2 && /^\d+$/.test(path.at(-2)!) ? path.at(-2) : undefined;
  return { ...(filename ? { filename } : {}), ...(attachmentId ? { attachmentId } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
