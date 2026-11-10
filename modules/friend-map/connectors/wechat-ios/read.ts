// Reads WeChat's own databases as the iPhone app keeps them, from the folder
// npm run extract-wechat takes out of an iPhone backup (see extract.ts), at the
// app's own paths:
//
//   Documents/<account>/DB/WCDB_Contact.sqlite   Friend: every contact, group and group member the app
//                                                knows, by userName (a wxid, an older id its owner chose,
//                                                or <id>@chatroom), with its names (dbContactRemark) and a
//                                                group's members (dbContactChatRoom); see records.ts
//   Documents/<account>/DB/message_<n>.sqlite    (and MM.sqlite) a table per chat, Chat_<md5 of its
//                                                userName>, a row per message: MesLocalID, MesSvrID (WeChat's
//                                                id for it), CreateTime (seconds), Des (0 when the captain
//                                                sent it), Type, Message (see records.ts)
//   Documents/<account>/<Img|Video|Audio|OpenData>/<md5 of the chat's userName>/<MesLocalID>.<kind>
//
// <account> is the md5 of the captain's own wxid, so he is the id among the
// contacts, group members and senders whose md5 it is (or the selfWxid
// setting), keyed `me`. Everything else is keyed on WeChat's own ids, so
// importing the same folder again, or a newer backup's, adds only what is new:
// - an account is its userName, named by the captain's remark for it, else its
//   nickname, else shown as its id (a group member who is no contact of his);
//   its handle is the WeChat ID its owner chose;
// - a chat is its userName: the other person's, or the group's <id>@chatroom;
// - a message is its MesSvrID, with its chat added when the same id is in more
//   than one chat, or a hash of its chat, time, type, direction and content
//   when it has none (0).
// Who sent a message: the captain when Des is 0; else the other person in a
// one-to-one chat, and in a group the id its content starts with. System
// messages (Type 10000, 10002, 64) have no sender. WeChat has no reactions or
// edits; a message taken back is replaced by a system message. A call record
// says how long the call was connected, or that it never connected (length 0),
// in the words the app shows for it (see records.ts, voipCall).
// Media are found by the message's MesLocalID in its chat's folder and kept
// where they are (which must be under data/platform-exports/): a photo's full
// size, else its thumbnail (all the phone keeps of a photo never opened), a
// video, a voice note (silk, .aud) or a file. Stickers are not in the backup.
//
// WeChat compresses some messages' content with a dictionary only the app
// holds (see records.ts). Unless the `dictionary` setting names it, such a
// message is kept without its content when its sender is known without it
// (the captain's, and every message in a one-to-one chat), and skipped when
// not (a group message from someone else, whose sender is inside); both are
// counted. WeChat's own chats (File Transfer, its notices) and official
// accounts (gh_...) are skipped and counted.
//
// The databases are copied to a temporary folder and read there, so the
// folder is never written to.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type AccountEvent, type AttachmentType, type Connector, type HistoryOptions, isNumberName, keepInPlace, mediaTypeOf, type MessageType } from "../../../../sdk/connector.ts";
import { columnsOf, isFile, openCopy, plain, type Row } from "../appDb.ts";
import { manifest } from "./manifest.ts";
import { appMessage, contactRemark, messageContent, roomMembers, splitSender, voipCall } from "./records.ts";

/** The captain's own account key. */
export const SELF_KEY = "me";

/** An account folder's name: the md5 of its owner's wxid. */
const ACCOUNT_FOLDER = /^[0-9a-f]{32}$/;
const CHAT_TABLE = /^Chat_([0-9a-f]{32})$/;

const TYPE_TEXT = 1;
const TYPE_APP = 49;
const TYPE_NOTICE = 10000;
const TYPE_CALL = 50;
type Media = "image" | "video" | "audio";
const TYPES: Record<number, { type: MessageType; media?: Media }> = {
  [TYPE_TEXT]: { type: "text" },
  3: { type: "media", media: "image" },
  34: { type: "media", media: "audio" },
  42: { type: "contact" },
  43: { type: "media", media: "video" },
  47: { type: "sticker" },
  48: { type: "location" },
  [TYPE_APP]: { type: "other" },
  [TYPE_CALL]: { type: "call" },
  62: { type: "media", media: "video" },
  64: { type: "system" },
  [TYPE_NOTICE]: { type: "system" },
  10002: { type: "system" },
};
/** An app message's own type: a link of some kind, or a reply (57), which is text. A file is told by its file. */
const APP_TYPES: Record<number, MessageType> = { 3: "link", 4: "link", 5: "link", 33: "link", 36: "link", 57: "text" };
const APP_REPLY = 57;

/** Where a message's media are, by its type: a folder and the kinds of file, best first, with the MIME type to give them. */
const MEDIA: Record<Media, { folder: string; kinds: string[]; mime?: string; attachment: AttachmentType }> = {
  image: { folder: "Img", kinds: [".pic_hd", ".pic", ".pic_thum"], mime: "image/jpeg", attachment: "image" },
  video: { folder: "Video", kinds: [".mp4"], mime: "video/mp4", attachment: "video" },
  audio: { folder: "Audio", kinds: [".aud"], attachment: "audio" },
};
const FILES_FOLDER = "OpenData";
const THUMBNAIL = ".pic_thum";

/** WeChat's own chats, not people's: File Transfer (the captain to himself) and its notices. */
const OWN_CHATS = new Set([
  "filehelper", "weixin", "notification_messages", "newsapp", "fmessage", "medianote", "floatbottle", "qqmail",
  "tmessage", "qmessage", "qqsync", "brandsessionholder", "notifymessage", "voipnotifymessage", "officialaccounts",
]);

/** Where an account's name came from, each with the tally that counts it. */
const NAME_SOURCES = {
  remark: "accounts named by the captain's remark",
  nickname: "accounts named by their WeChat nickname",
  id: "accounts shown by their id (group members who are no contact)",
} as const;

export const wechatIos: Connector = { manifest, history: readWeChat };

export async function readWeChat({ sources, config, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("name one folder: the one npm run extract-wechat filled");
  const folders = await accountFolders(sources[0]);
  if (folders.length === 0) {
    throw new Error(`there is no WeChat account in ${sources[0]}: no folder <md5 of a wxid>/DB/ holding WCDB_Contact.sqlite, under Documents/ or there`);
  }
  const named = typeof config.dictionary === "string" && config.dictionary !== "" ? resolve(config.dictionary) : null;
  if (named && !(await isFile(named))) throw new Error(`the dictionary ${named} is not there`);
  const dictionary = named ? await readFile(named) : null;
  const selfName = typeof config.selfName === "string" && config.selfName ? config.selfName : "Me";
  const configuredSelf = typeof config.selfWxid === "string" ? config.selfWxid.trim() : "";

  const tallies = new Map<string, number>();
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  const announced = new Set<string>();
  const firstAt = new Map<string, number>();
  let lastAt = -Infinity;
  const work = await mkdtemp(join(tmpdir(), "friend-map-wechat-"));
  const opened: DatabaseSync[] = [];
  try {
    for (const folder of folders) {
      // Each account's databases are copied into a folder of their own: two accounts' have the same names.
      const copies = join(work, basename(folder));
      await mkdir(copies);
      const open = async (path: string) => {
        const db = await openCopy(path, copies);
        if (db) opened.push(db);
        return db;
      };
      const db = join(folder, "DB");
      const contactsDb = await open(join(db, "WCDB_Contact.sqlite"));
      if (!contactsDb || !["userName", "dbContactRemark"].every((c) => columnsOf(contactsDb, "Friend").includes(c))) {
        throw new Error(`${join(db, "WCDB_Contact.sqlite")} has no Friend table with userName and dbContactRemark; its schema is not one this connector knows`);
      }
      const messageDbs: DatabaseSync[] = [];
      for (const name of await messageDatabases(db)) {
        const database = await open(join(db, name));
        if (database) messageDbs.push(database);
      }

      // Contacts, groups and their members, by userName.
      const contacts = new Map<string, ReturnType<typeof contactRemark>>();
      const rooms = new Map<string, string[]>();
      const hasRooms = columnsOf(contactsDb, "Friend").includes("dbContactChatRoom");
      for (const row of contactsDb.prepare(`SELECT userName, dbContactRemark${hasRooms ? ", dbContactChatRoom" : ""} FROM Friend`).iterate() as Iterable<Row>) {
        const id = str(row.userName);
        if (!id) continue;
        contacts.set(id, contactRemark(row.dbContactRemark));
        if (id.endsWith("@chatroom") && hasRooms) rooms.set(id, roomMembers(row.dbContactChatRoom));
      }

      // The captain: the id whose md5 names this account's folder.
      const owner = basename(folder);
      const md5s = new Map<string, string>();
      const md5Of = (id: string) => {
        let hash = md5s.get(id);
        if (hash === undefined) md5s.set(id, (hash = md5(id)));
        return hash;
      };
      const isSelf = (id: string) => id === configuredSelf || md5Of(id) === owner;
      const known = new Set([...contacts.keys(), ...[...rooms.values()].flat(), ...(configuredSelf ? [configuredSelf] : [])]);
      if (![...known].some(isSelf)) tally("accounts whose own wxid was not found (the selfWxid setting names it)");
      const keyOf = (id: string) => (isSelf(id) ? SELF_KEY : id);

      const nameOf = (key: string): { displayName: string; source: keyof typeof NAME_SOURCES } => {
        const contact = contacts.get(key);
        if (contact && isName(contact.remark)) return { displayName: contact.remark, source: "remark" };
        if (contact && isName(contact.nickname)) return { displayName: contact.nickname, source: "nickname" };
        return { displayName: key, source: "id" };
      };
      const accountFor = (key: string): AccountEvent => {
        if (key === SELF_KEY) return { kind: "account", key, keyKind: "id", displayName: selfName, nameSource: "settings", isSelf: true };
        const { displayName, source } = nameOf(key);
        const alias = contacts.get(key)?.alias;
        return { kind: "account", key, keyKind: "id", displayName, nameSource: source, ...(alias ? { handle: alias } : {}) };
      };
      const announce = async (key: string) => {
        if (announced.has(key)) return;
        announced.add(key);
        if (key !== SELF_KEY) tally(NAME_SOURCES[nameOf(key).source]);
        await emit(accountFor(key));
      };
      await announce(SELF_KEY);

      // Each chat table by the userName whose md5 names it; a message id in more than one chat is told apart by its chat.
      const userOfMd5 = new Map([...known].map((id) => [md5Of(id), id]));
      interface Chat { db: DatabaseSync; table: string; md5: string; user: string | null; count: number }
      const chats: Chat[] = [];
      const chatsOfId = new Map<string, string>();
      const sharedIds = new Set<string>();
      for (const db of messageDbs) {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => String(row.name));
        for (const table of tables) {
          const hash = table.match(CHAT_TABLE)?.[1];
          if (!hash) continue;
          const user = userOfMd5.get(hash) ?? null;
          const { count } = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
          chats.push({ db, table, md5: hash, user, count });
          if (!user) continue;
          for (const { id } of db.prepare(`SELECT CAST(MesSvrID AS TEXT) AS id FROM ${table} WHERE MesSvrID != 0`).iterate() as Iterable<{ id: string }>) {
            const seen = chatsOfId.get(id);
            if (seen === undefined) chatsOfId.set(id, user);
            else if (seen !== user) sharedIds.add(id);
          }
        }
      }
      chatsOfId.clear();
      const total = chats.reduce((sum, chat) => sum + chat.count, 0);
      let done = 0;

      for (const chat of chats) {
        if (!chat.user) {
          tally("messages in chats whose WeChat id is not known", chat.count);
          done += chat.count;
          continue;
        }
        if (OWN_CHATS.has(chat.user) || chat.user.startsWith("gh_")) {
          tally(chat.user.startsWith("gh_") ? "messages with official accounts" : "messages in WeChat's own chats (File Transfer, its notices)", chat.count);
          done += chat.count;
          continue;
        }
        const conversation = chat.user;
        const group = conversation.endsWith("@chatroom");
        const partner = group ? null : keyOf(conversation);
        const members = new Set([SELF_KEY, ...(group ? (rooms.get(conversation) ?? []).map(keyOf) : [partner!])]);
        const contact = contacts.get(conversation);
        const title = group ? [contact?.remark, contact?.nickname].find(isName) ?? "" : accountFor(partner!).displayName;
        const announceChat = async () => {
          const list = [...members].sort();
          for (const key of list) await announce(key);
          await emit({ kind: "conversation", id: conversation, type: group ? "group" : "direct", title, members: list });
        };
        await announceChat();
        let grew = false;
        const media = new MediaIndex(folder, chat.md5);

        const rows = chat.db.prepare(`SELECT *, CAST(MesSvrID AS TEXT) AS svrId FROM ${chat.table} ORDER BY CreateTime, MesLocalID`);
        rows.setReadBigInts(true);
        for (const row of rows.iterate() as Iterable<Row>) {
          if (++done % 1000 === 0) await emit({ kind: "progress", done, total, note: "messages" });
          const createdAt = Number(row.CreateTime ?? 0);
          if (!(createdAt > 0)) {
            tally("messages without a date");
            continue;
          }
          const sentAt = createdAt * 1000;
          const wcType = Number(row.Type);
          const kind = TYPES[wcType];
          if (!kind) tally(`messages of an unknown type (${wcType})`);
          const system = kind?.type === "system";
          const fromMe = Number(row.Des) === 0;
          const content = messageContent(row.Message, dictionary);
          let body = content.kind === "text" ? content.text : null;
          if (content.kind === "text" && content.decompressed) tally("messages read from WeChat's compressed form");

          let sender: string | null = null;
          if (system) sender = null;
          else if (fromMe) sender = SELF_KEY;
          else if (!group) sender = partner;
          else if (body === null) {
            tally(`group messages from others skipped: compressed with WeChat's dictionary ${dictionaryName(content)}, which names their sender`);
            continue;
          } else {
            const split = splitSender(body);
            if (!split) {
              tally("group messages from others that name no sender");
              continue;
            }
            sender = keyOf(split.sender);
            body = split.body;
            if (!members.has(sender)) {
              members.add(sender);
              grew = true;
              await announce(sender);
            }
          }
          if (body === null) tally(`messages compressed with WeChat's dictionary ${dictionaryName(content)}, kept without their content`);

          let type: MessageType = kind?.type ?? "other";
          let text = "";
          let replyTo = "";
          let callSeconds: number | undefined;
          if (body !== null) {
            if (wcType === TYPE_TEXT || wcType === TYPE_NOTICE) text = body;
            else if (wcType === TYPE_APP) {
              const app = appMessage(body);
              type = (app.subtype !== null ? APP_TYPES[app.subtype] : undefined) ?? "other";
              if (app.subtype === APP_REPLY) {
                text = app.title;
                replyTo = app.replyTo && sharedIds.has(app.replyTo) ? `${app.replyTo}/${conversation}` : app.replyTo;
              } else if (type === "link") text = app.url || app.title;
            } else if (wcType === TYPE_CALL) {
              const call = voipCall(body);
              callSeconds = call?.seconds;
              tally(call ? `calls ${call.outcome}` : "calls whose words say neither how long nor that they did not connect");
            }
          }
          if (wcType === TYPE_CALL && body === null) tally("calls compressed with WeChat's dictionary, their length unknown");
          // An app message with a file of its own is a file, whether its content could be read or not.
          const localId = String(row.MesLocalID);
          const file = wcType === TYPE_APP ? await media.file(localId) : null;
          if (file) type = "media";

          const svrId = str(row.svrId);
          const platformId = svrId && svrId !== "0";
          if (!platformId) tally("messages without a WeChat id");
          const id = platformId
            ? sharedIds.has(svrId) ? `${svrId}/${conversation}` : svrId
            : sha256(["wechat", conversation, createdAt, wcType, fromMe ? 1 : 0, contentKey(row.Message)].join("\u001f"));
          await emit({
            kind: "message",
            id,
            idKind: platformId ? "platform" : "synthetic",
            conversation,
            sender,
            isFromSelf: fromMe || sender === SELF_KEY,
            sentAt,
            type,
            ...(text ? { text } : {}),
            ...(replyTo ? { replyTo } : {}),
            ...(callSeconds !== undefined ? { callSeconds } : {}),
            raw: { table: chat.table, ...plain(row, ["Message", "svrId"]), MesSvrID: svrId, ...(body !== null && content.kind === "text" ? { Message: content.text } : {}) },
          });
          if (!firstAt.has(conversation)) firstAt.set(conversation, sentAt);
          lastAt = Math.max(lastAt, sentAt);

          // Its file: a photo, video or voice note by its type, or the file an app message carries.
          if (!kind?.media && !file) continue;
          const found = kind?.media ? await media.best(kind.media, localId) : file;
          if (found?.endsWith(THUMBNAIL)) tally("photos kept only as the thumbnail (the phone never kept the photo)");
          const inPlace = found ? await keepInPlace(found) : undefined;
          if (!inPlace) tally("media not in the backup");
          const name = found ? basename(found) : "";
          const spec = kind?.media ? MEDIA[kind.media] : null;
          const byName = mediaTypeOf(name);
          const mime = spec ? spec.mime : byName.mime;
          await emit({
            kind: "attachment",
            message: id,
            ordinal: 0,
            type: spec ? spec.attachment : byName.type,
            ...(name ? { filename: name } : {}),
            ...(mime ? { mime } : {}),
            ...(inPlace ? { inPlace } : {}),
          });
        }
        if (grew) await announceChat();
      }
      await emit({ kind: "progress", done, total, note: "messages" });
    }

    // The backup covers each chat from its first message to the newest message in it.
    for (const [conversation, from] of firstAt) await emit({ kind: "coverage", conversation, from, to: lastAt });
    if (firstAt.size > 0) await emit({ kind: "coverage", from: Math.min(...firstAt.values()), to: lastAt });
    for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
  } finally {
    for (const db of opened) db.close();
    await rm(work, { recursive: true, force: true });
  }
}

/** The account folders in what was named: itself, or those in it or in its Documents/. */
async function accountFolders(source: string): Promise<string[]> {
  const isAccount = async (path: string) => ACCOUNT_FOLDER.test(basename(path)) && (await isFile(join(path, "DB", "WCDB_Contact.sqlite")));
  if (await isAccount(source)) return [source];
  for (const base of [source, join(source, "Documents")]) {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const found: string[] = [];
    for (const entry of entries) if (entry.isDirectory() && (await isAccount(join(base, entry.name)))) found.push(join(base, entry.name));
    if (found.length > 0) return found.sort();
  }
  return [];
}

/** The databases in an account's DB/ folder that hold chats: MM.sqlite and message_<n>.sqlite, in order. */
async function messageDatabases(db: string): Promise<string[]> {
  const names = (await readdir(db)).filter((name) => /^message_\d+\.sqlite$/.test(name));
  names.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return ["MM.sqlite", ...names];
}

/** A chat's media in an account's folder, by MesLocalID, each media folder listed once when first asked of. */
class MediaIndex {
  private readonly folders = new Map<string, Map<string, string[]>>();
  private readonly account: string;
  private readonly chat: string;

  constructor(account: string, chat: string) {
    this.account = account;
    this.chat = chat;
  }

  /** The best file of a photo, video or voice note, or null when the folder has none. */
  async best(media: Media, localId: string): Promise<string | null> {
    const { folder, kinds } = MEDIA[media];
    const names = (await this.list(folder)).get(localId) ?? [];
    const name = kinds.map((kind) => `${localId}${kind}`).find((candidate) => names.includes(candidate));
    return name ? join(this.account, folder, this.chat, name) : null;
  }

  /** The file an app message carries (anything but its preview's thumbnail), or null. */
  async file(localId: string): Promise<string | null> {
    const name = ((await this.list(FILES_FOLDER)).get(localId) ?? []).find((candidate) => !candidate.endsWith(THUMBNAIL));
    return name ? join(this.account, FILES_FOLDER, this.chat, name) : null;
  }

  private async list(folder: string): Promise<Map<string, string[]>> {
    let byId = this.folders.get(folder);
    if (!byId) {
      byId = new Map();
      for (const name of await readdir(join(this.account, folder, this.chat)).catch(() => [] as string[])) {
        // "12.pic", "12.pic_thum", "12.mp4", "12.aud", "12.pdf": the MesLocalID, then the kind.
        const id = name.match(/^(\d+)\./)?.[1];
        if (id) byId.set(id, [...(byId.get(id) ?? []), name]);
      }
      this.folders.set(folder, byId);
    }
    return byId;
  }
}

/** How to name the dictionary a compressed message needs, by the id its frame gives. */
function dictionaryName(content: { kind: string; dictionaryId?: number | null }): string {
  return content.dictionaryId != null ? String(content.dictionaryId) : "(unnamed)";
}

/** Whether a name a table gives is one: not empty, and not only a number. */
function isName(name: string | undefined): name is string {
  return !!name && !isNumberName(name);
}

/** What a message's content is, for a message with no id of its own: its text, or a hash of its bytes. */
function contentKey(message: SQLOutputValue): string {
  return message instanceof Uint8Array ? createHash("sha256").update(message).digest("hex") : str(message);
}

function str(value: SQLOutputValue | undefined): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
