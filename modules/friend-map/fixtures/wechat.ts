// A small, entirely made-up copy of WeChat's own files as the iPhone app keeps
// them and npm run extract-wechat takes them out of a backup (see
// connectors/wechat-ios/read.ts), for tests:
//
//   Documents/<md5 of the captain's wxid>/DB/WCDB_Contact.sqlite   Friend: contacts, groups and their members
//   Documents/<account>/DB/MM.sqlite                               one older chat's table, where old chats stay
//   Documents/<account>/DB/message_1.sqlite, message_2.sqlite      a Chat_<md5 of its id> table per chat, and a Hello_ table
//   Documents/<account>/<Img|Video|Audio|OpenData>/<md5 of a chat's id>/<MesLocalID>.<kind>
//
// Only the tables and columns the connector reads are made, with the real
// names. It has what the real backup has that matters: a contact named by the
// captain's remark, one by nickname with the WeChat ID they chose, a group
// member who is no contact, the captain among a group's members and as a
// group message's sender, a group whose members are listed only in its XML,
// an untitled group; texts both ways, a photo with its HD copy, one kept only
// as a thumbnail, a voice note, a video the backup lacks, a link, a reply, a
// file, a notice with no WeChat id, an id in two chats, ids past 2^53;
// messages compressed as WeChat compresses them (a zstd frame needing
// dictionary 5): one in a one-to-one chat, a photo from someone else in a
// group, a group system message; and an official account, File Transfer and
// a chat whose id is no contact's, all skipped.
//
// `later: true` makes a newer backup of the same phone: the same rows and two
// newer messages. The media bytes are placeholders, not images.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** Seconds since 1970, as WeChat stores CreateTime, for a wall-clock time with its offset. */
const at = (iso: string) => Date.parse(iso) / 1000;

/** A WeChat message id (MesSvrID): 64 bits, past what a JavaScript number holds exactly. */
export const svr = (n: number) => (7_000_000_000_000_000_000n + BigInt(n)).toString();

export const WC_SELF = "wxid_captain0001";
/** The account folder: the md5 of the captain's wxid. */
export const WC_ACCOUNT = md5(WC_SELF);

export const WC_PEOPLE = {
  /** Named by the captain's remark; has a nickname and a WeChat ID of her own too. */
  ada: { id: "wxid_ada0001", remark: "Ada Sample", nickname: "ada~", alias: "ada_sample" },
  /** An older id he chose himself; a nickname, no remark. Their chat is old, kept in MM.sqlite. */
  bruno: { id: "bruno_p", nickname: "Bruno Placeholder" },
  /** Writes in the footy group but is no contact of the captain's, nor in its member list. */
  cleo: { id: "wxid_cleo0003" },
  /** A contact known by nickname, in the untitled group, whose members are listed only in XML. */
  dana: { id: "wxid_dana0004", nickname: "Dana Lee" },
} as const;

export const WC_GROUPS = { footy: "20001@chatroom", untitled: "20002@chatroom" } as const;
const OFFICIAL = "gh_0123456789ab";
const GONE = "wxid_gone0009";

/**
 * A made-up zstd dictionary with id 5, as WeChat's is: trained with
 * `zstd --train --maxdict=1024 --dictID=5` on made-up samples shaped like
 * WeChat's message content. Frames made with it name dictionary 5 in their
 * header, and no frame of it can be read without it.
 */
export const WC_DICTIONARY = Buffer.from(
  "N6Qw7AUAAAAcEOBrdP////+Dh68uZ0gppZRSMjxSExEREREhAaMIAAAAACfCPgAABMBAAYAVCwIxHAgAPwAAAAAAAEMFAAAAAAAAAABAMKhBAgCwMw0AAAAA" +
    "FOmqiq0HAAAAAAAAAAAAAAAAAAEAAAAEAAAACAAAAHRoPSI0OTU4IiBtZDU9IjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxNDc0IiAvPjwvbXNnPnd4" +
    "aWRfc2FtcGxlMDAwMToKPG1zZz48aW1nIGFlc2tleT0iMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMjkiIGxlbmd0aD0iMTA3MyIgbWQ1PSIwMDAw" +
    "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDMxOSIgLz48L21zZz53eGlkX3NhbXBsZTAwMDA6Cjxtc2c+PGltZyBhZXNrZXk9IjAwMDAwMDAwMDAwMDAwMDAw" +
    "MDAwMDAwMDAwMDAwMTMzIiBsZW5ndGg9IjQ5MjEiIG1kNT0iMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE0NjMiIC8+PC9tc2c+TWFkZS11cCB3b3Jk" +
    "cyBudW1iZXIgNjAgZm9yIGEgdGVzdCBkaWN0aW9uYXJ5LCBub3RoaW5nIG1vcmUud3hpZF9zYW1wbGUwMDAyOgo8bXNnPjxpbWcgYWVza2V5PSIwMDAwMDAw" +
    "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE5MSIgbGVuZ3RoPSI3MDY3IiBtZDU9IjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAyMTAxIiAvPjwvbXNnPnd4" +
    "aWRfc2FtcGxlMDAwMzoKPG1zZz48aW1nIGFlc2tleT0iMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxNTAiIGxlbmd0aD0iNTU1MCIgbWQ1PSIwMDAw" +
    "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTY1MCIgLz48L21zZz53eGlkX3NhbXBsZTAwMDY6Cjxtc2c+PGltZyBhZXNrZXk9IjAwMDAwMDAwMDAwMDAwMDAw" +
    "MDAwMDAwMDAwMDAwMDQxIiBsZW5ndGg9IjE1MTciIG1kNT0iMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA0NTEiIC8+PC9tc2c+d3hpZF9zYW1wbGUw" +
    "MDA1Ogo8bXNnPjxpbWcgYWVza2V5PSIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE2NiIgbGVuZ3RoPSI2MTQyIiBtZDU9IjAwMDAwMDAwMDAwMDAw" +
    "MDAwMDAwMDAwMDAwMDAxODI2IiAvPjwvbXNnPnd4aWRfcw==",
  "base64",
);

/** Message content as WeChat compresses it: a zstd frame made with dictionary 5. */
const compressed = (content: string) => zstdCompressSync(Buffer.from(content), { dictionary: WC_DICTIONARY });

/**
 * A call record's content (Type 50), shaped as WeChat writes it: the words the app shows for the call in <msg>, beside
 * made-up ids and times.
 */
export const voipBubble = (words: string) =>
  `<voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[${words}]]></msg><room_type>1</room_type><red_dot>false</red_dot>` +
  "<roomid>100000001</roomid><roomkey>0</roomkey><inviteid>1700000000</inviteid><msg_type>100</msg_type><timestamp>1700000000000</timestamp>" +
  "<identity><![CDATA[1234567890]]></identity><duration>0</duration><business>1</business></VoIPBubbleMsg></voipmsg>";

/** A protobuf message of string fields, as WeChat keeps a contact's names and a group's members. */
export function protobuf(fields: Record<number, string>): Buffer<ArrayBuffer> {
  const parts: Buffer[] = [];
  const varint = (n: number) => {
    const bytes: number[] = [];
    do {
      bytes.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
      n >>>= 7;
    } while (n > 0);
    return Buffer.from(bytes);
  };
  for (const [field, value] of Object.entries(fields)) {
    const bytes = Buffer.from(value);
    parts.push(varint((Number(field) << 3) | 2), varint(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

/** A row of a chat table. `content` is what Message holds: text, or a compressed frame. */
interface Row {
  localId: number;
  /** MesSvrID: "0" for none. */
  svrId: string;
  time: string;
  /** Des: 0 when the captain sent it. */
  des: 0 | 1;
  type: number;
  content: string | Uint8Array;
}

const appMessage = (type: number, inner: string) => `<msg><appmsg appid="" sdkver="0">${inner}<type>${type}</type></appmsg></msg>`;

function chats(later: boolean): Record<string, { db: string; rows: Row[] }> {
  const { ada, bruno, cleo, dana } = WC_PEOPLE;
  return {
    [ada.id]: {
      db: "message_1.sqlite",
      rows: [
        { localId: 1, svrId: svr(1001), time: "2026-09-01T10:00:00+10:00", des: 1, type: 1, content: "Are you coming on Saturday?" },
        { localId: 2, svrId: svr(1002), time: "2026-09-01T10:01:00+10:00", des: 0, type: 1, content: "Yes!" },
        { localId: 3, svrId: svr(1003), time: "2026-09-01T10:02:00+10:00", des: 1, type: 3, content: '<msg><img length="12" /></msg>' },
        { localId: 4, svrId: svr(1004), time: "2026-09-01T10:03:00+10:00", des: 0, type: 3, content: '<msg><img length="12" /></msg>' },
        { localId: 5, svrId: svr(1005), time: "2026-09-01T10:04:00+10:00", des: 1, type: 34, content: '<msg><voicemsg length="9" /></msg>' },
        { localId: 6, svrId: svr(1006), time: "2026-09-01T10:05:00+10:00", des: 0, type: 43, content: '<msg><videomsg length="9" /></msg>' },
        { localId: 7, svrId: svr(1007), time: "2026-09-01T10:06:00+10:00", des: 1, type: 1, content: compressed("A long message WeChat compressed.") },
        {
          localId: 8, svrId: svr(1008), time: "2026-09-01T10:07:00+10:00", des: 1, type: 49,
          content: appMessage(5, "<title>A page &amp; more</title><url><![CDATA[https://example.com/a?b=1&c=2]]></url>"),
        },
        {
          localId: 9, svrId: svr(1009), time: "2026-09-01T10:08:00+10:00", des: 0, type: 49,
          content: appMessage(57, `<title>Sounds good</title><refermsg><type>1</type><svrid>${svr(1001)}</svrid><title>quoted</title></refermsg>`),
        },
        { localId: 10, svrId: svr(1010), time: "2026-09-01T10:09:00+10:00", des: 1, type: 49, content: appMessage(6, "<title>plan.pdf</title>") },
        { localId: 11, svrId: "0", time: "2026-09-01T10:10:00+10:00", des: 1, type: 10000, content: "Ada Sample recalled a message" },
        { localId: 12, svrId: svr(2001), time: "2026-09-01T10:11:00+10:00", des: 1, type: 1, content: "The same id as a message in the footy group" },
        ...(later ? [{ localId: 13, svrId: svr(1013), time: "2026-10-01T09:00:00+10:00", des: 1 as const, type: 1, content: "Newer" }] : []),
      ],
    },
    [bruno.id]: {
      db: "MM.sqlite",
      rows: [
        { localId: 1, svrId: svr(1101), time: "2015-03-01T12:00:00+11:00", des: 1, type: 1, content: "An old chat" },
        { localId: 2, svrId: svr(1102), time: "2015-03-01T12:05:00+11:00", des: 0, type: 1, content: "Still here" },
      ],
    },
    [WC_GROUPS.footy]: {
      db: "message_2.sqlite",
      rows: [
        { localId: 1, svrId: svr(2001), time: "2026-09-02T18:00:00+10:00", des: 1, type: 1, content: `${bruno.id}:\nTraining at six` },
        { localId: 2, svrId: svr(2002), time: "2026-09-02T18:01:00+10:00", des: 0, type: 1, content: "I'll be there" },
        { localId: 3, svrId: svr(2003), time: "2026-09-02T18:02:00+10:00", des: 1, type: 1, content: `${cleo.id}:\nMe too` },
        { localId: 4, svrId: svr(2004), time: "2026-09-02T18:03:00+10:00", des: 1, type: 3, content: compressed(`${ada.id}:\n<msg><img length="12" /></msg>`) },
        { localId: 5, svrId: "0", time: "2026-09-02T18:04:00+10:00", des: 1, type: 10000, content: "Bruno Placeholder invited Cleo to the group" },
        { localId: 6, svrId: svr(2006), time: "2026-09-02T18:05:00+10:00", des: 1, type: 1, content: `${WC_SELF}:\nSent from my other device` },
        { localId: 7, svrId: svr(2007), time: "2026-09-02T18:06:00+10:00", des: 1, type: 10002, content: compressed('<sysmsg type="pat"></sysmsg>') },
        ...(later ? [{ localId: 8, svrId: svr(2008), time: "2026-10-01T19:00:00+10:00", des: 1 as const, type: 1, content: `${bruno.id}:\nSee you next week` }] : []),
      ],
    },
    [WC_GROUPS.untitled]: {
      db: "message_2.sqlite",
      rows: [
        { localId: 1, svrId: svr(3001), time: "2026-09-03T09:00:00+10:00", des: 1, type: 1, content: `${dana.id}:\nMorning` },
        { localId: 2, svrId: svr(3002), time: "2026-09-03T09:01:00+10:00", des: 0, type: 1, content: "Morning!" },
      ],
    },
    [OFFICIAL]: {
      db: "message_1.sqlite",
      rows: [{ localId: 1, svrId: svr(4001), time: "2026-09-04T08:00:00+10:00", des: 1, type: 49, content: appMessage(5, "<title>News</title>") }],
    },
    filehelper: {
      db: "message_1.sqlite",
      rows: [{ localId: 1, svrId: svr(5001), time: "2026-09-04T08:00:00+10:00", des: 0, type: 1, content: "A note to myself" }],
    },
    [GONE]: {
      db: "message_1.sqlite",
      rows: [{ localId: 1, svrId: svr(6001), time: "2016-01-01T08:00:00+11:00", des: 1, type: 1, content: "From someone no longer in contacts" }],
    },
  };
}

/** The media files on disk, by chat: <folder>/<file name>. */
const MEDIA: Record<string, string[]> = {
  [WC_PEOPLE.ada.id]: ["Img/3.pic", "Img/3.pic_hd", "Img/3.pic_thum", "Img/4.pic_thum", "Audio/5.aud", "Video/6.video_thum", "OpenData/10.pdf", "OpenData/10.pic_thum"],
  [WC_GROUPS.footy]: ["Img/4.pic", "Img/4.pic_thum"],
};

const CHAT_SCHEMA =
  "(CreateTime INTEGER DEFAULT 0, Des INTEGER, ImgStatus INTEGER DEFAULT 0, MesLocalID INTEGER PRIMARY KEY AUTOINCREMENT, Message TEXT, " +
  "MesSvrID INTEGER DEFAULT 0, Status INTEGER DEFAULT 0, TableVer INTEGER DEFAULT 1, Type INTEGER, WCDB_CT_Message INTEGER DEFAULT NULL)";

/** Writes the made-up WeChat files into `folder`, as extract-wechat lays them out. Returns the account folder. */
export async function writeWeChatFixture(folder: string, { later = false } = {}): Promise<string> {
  const account = join(folder, "Documents", WC_ACCOUNT);
  await mkdir(join(account, "DB"), { recursive: true });
  const { ada, bruno, dana } = WC_PEOPLE;

  const contacts = new DatabaseSync(join(account, "DB", "WCDB_Contact.sqlite"));
  contacts.exec(
    "CREATE TABLE Friend(userName text primary key on conflict replace, type integer default 0, dbContactRemark blob, dbContactChatRoom blob)",
  );
  const friend = contacts.prepare("INSERT INTO Friend (userName, type, dbContactRemark, dbContactChatRoom) VALUES (?, ?, ?, ?)");
  friend.run(ada.id, 3, protobuf({ 1: ada.nickname, 2: ada.alias, 3: ada.remark, 4: "adasample", 5: "AdaSample" }), null);
  friend.run(bruno.id, 3, protobuf({ 1: bruno.nickname, 2: "", 3: "" }), null);
  friend.run(dana.id, 3, protobuf({ 1: dana.nickname }), null);
  // A group member who is only in the untitled group's XML: listed, never wrote, no names.
  friend.run("wxid_quiet0006", 4, protobuf({ 1: "" }), null);
  friend.run(WC_GROUPS.footy, 2, protobuf({ 1: "Footy" }), protobuf({ 1: [WC_SELF, ada.id, bruno.id].join(";"), 2: bruno.id }));
  const xml = `<RoomData>${[WC_SELF, dana.id, ada.id, "wxid_quiet0006"].map((id) => `<Member UserName="${id}"><Flag>0</Flag></Member>`).join("")}</RoomData>`;
  friend.run(WC_GROUPS.untitled, 2, protobuf({ 1: "" }), protobuf({ 2: dana.id, 6: xml }));
  friend.run(OFFICIAL, 3, protobuf({ 1: "Daily News" }), null);
  friend.run("filehelper", 3, protobuf({ 1: "File Transfer" }), null);
  contacts.close();

  const databases = new Map<string, DatabaseSync>();
  const databaseFor = (name: string) => {
    if (!databases.has(name)) databases.set(name, new DatabaseSync(join(account, "DB", name)));
    return databases.get(name)!;
  };
  for (const name of ["MM.sqlite", "message_1.sqlite", "message_2.sqlite"]) databaseFor(name);
  databaseFor("message_1.sqlite").exec(`CREATE TABLE Hello_${md5("wxid_stranger")}(MesLocalID INTEGER PRIMARY KEY, Message TEXT, UsrName TEXT)`);
  for (const [chat, { db, rows }] of Object.entries(chats(later))) {
    const table = `Chat_${md5(chat)}`;
    const database = databaseFor(db);
    database.exec(`CREATE TABLE ${table}${CHAT_SCHEMA}`);
    const insert = database.prepare(
      `INSERT INTO ${table} (MesLocalID, MesSvrID, CreateTime, Des, Type, Message, WCDB_CT_Message) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const isCompressed = row.content instanceof Uint8Array;
      insert.run(row.localId, BigInt(row.svrId), at(row.time), row.des, row.type, row.content, isCompressed ? 2 : 0);
    }
  }
  for (const database of databases.values()) database.close();

  for (const [chat, files] of Object.entries(MEDIA)) {
    for (const file of files) {
      const [kind, name] = file.split("/");
      await mkdir(join(account, kind, md5(chat)), { recursive: true });
      await writeFile(join(account, kind, md5(chat), name), `placeholder bytes for ${file} in a made-up chat`);
    }
  }
  return account;
}
