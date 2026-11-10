import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConnectorEvent, dayKey } from "../../../sdk/server.ts";
import { writeWhatsAppFixture } from "../fixtures/whatsapp.ts";
import { protobuf, svr, voipBubble, WC_ACCOUNT, WC_DICTIONARY, WC_GROUPS, WC_PEOPLE, WC_SELF, writeWeChatFixture } from "../fixtures/wechat.ts";
import { finderBackup, finderBackups } from "./iphoneBackup.ts";
import { chooseWeChatFiles, extractWeChat, WECHAT_DOMAIN } from "./wechat-ios/extract.ts";
import { readWeChat, SELF_KEY } from "./wechat-ios/read.ts";
import { appMessage, contactRemark, messageContent, roomMembers, splitSender, voipCall, zstdHeader } from "./wechat-ios/records.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-wechat-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const { ada, bruno, cleo, dana } = WC_PEOPLE;

/** An export's folder, where the captain keeps it: in the data folder the archive tests open (dir/data). */
const exportAt = (date: string) => join(dir, "data", "platform-exports", "wechat", date);

async function fixture(options: { later?: boolean } = {}): Promise<string> {
  const folder = exportAt(options.later ? "2026-10-02" : "2026-09-28");
  await writeWeChatFixture(folder, options);
  return folder;
}

async function dictionaryFile(): Promise<string> {
  const file = join(dir, "wechat.dict");
  await writeFile(file, WC_DICTIONARY);
  return file;
}

async function read(source: string, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  await readWeChat({ sources: [source], config, mediaDir: join(dir, "media"), emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  const message = (id: string) => of("message").find((m) => m.id === id);
  const attachmentOf = (id: string) => of("attachment").find((a) => a.message === id);
  const tallies = Object.fromEntries(of("tally").map((t) => [t.name, t.count]));
  /** A conversation as last announced: a group is announced again when a sender its member list lacks wrote in it. */
  const conversation = (id: string) => of("conversation").filter((c) => c.id === id).at(-1);
  return { events, of, message, attachmentOf, tallies, conversation };
}

const COMPRESSED_KEPT = "messages compressed with WeChat's dictionary 5, kept without their content";
const COMPRESSED_SKIPPED = "group messages from others skipped: compressed with WeChat's dictionary 5, which names their sender";

describe("wechat-ios records", () => {
  it("reads a contact's names and a group's members from their protobuf fields", () => {
    expect(contactRemark(protobuf({ 1: "ada~", 2: "ada_sample", 3: "Ada Sample", 4: "adasample" }))).toEqual({
      nickname: "ada~", alias: "ada_sample", remark: "Ada Sample",
    });
    expect(contactRemark(null)).toEqual({ nickname: "", alias: "", remark: "" });
    expect(contactRemark(new Uint8Array([0xff, 0xff]))).toEqual({ nickname: "", alias: "", remark: "" });
    // Members in the ";" list, in the XML, or both, once each.
    const both = protobuf({ 1: "wxid_a;wxid_b;", 6: '<RoomData><Member UserName="wxid_b"></Member><Member UserName="wxid_c&amp;"></Member></RoomData>' });
    expect(roomMembers(both)).toEqual(["wxid_a", "wxid_b", "wxid_c&"]);
    expect(roomMembers(null)).toEqual([]);
  });

  it("reads which dictionary a zstd frame needs, and its content's size, from its header", () => {
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    // Single segment, a one-byte dictionary id and a one-byte size, as most compressed records in the real backup have.
    expect(zstdHeader(new Uint8Array([...magic, 0x21, 0x05, 0x59, 0x95]))).toEqual({ dictionaryId: 5, contentSize: 0x59 });
    // A two-byte size counts from 256.
    expect(zstdHeader(new Uint8Array([...magic, 0x61, 0x05, 0x10, 0x00]))).toEqual({ dictionaryId: 5, contentSize: 0x10 + 256 });
    // With a window descriptor before it, a two-byte id and no size.
    expect(zstdHeader(new Uint8Array([...magic, 0x02, 0x58, 0x34, 0x12, 0x00]))).toEqual({ dictionaryId: 0x1234, contentSize: null });
    expect(zstdHeader(new Uint8Array([...magic, 0x20, 0x11, 0x65, 0x00]))).toEqual({ dictionaryId: null, contentSize: 0x11 });
    expect(zstdHeader(new Uint8Array([...magic, 0xa1, 0x05, 0x01]))).toBeNull();
    expect(zstdHeader(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
    const frame = zstdCompressSync(Buffer.from("text"), { dictionary: WC_DICTIONARY });
    expect(zstdHeader(frame)).toEqual({ dictionaryId: 5, contentSize: 4 });
  });

  it("reads a message's content: text, bytes, or a zstd frame when it has what the frame needs", () => {
    expect(messageContent("plain", null)).toEqual({ kind: "text", text: "plain", decompressed: false });
    expect(messageContent(null, null)).toEqual({ kind: "text", text: "", decompressed: false });
    expect(messageContent(Buffer.from("bytes"), null)).toEqual({ kind: "text", text: "bytes", decompressed: false });
    const frame = zstdCompressSync(Buffer.from("compressed words"), { dictionary: WC_DICTIONARY });
    expect(messageContent(frame, null)).toEqual({ kind: "compressed", dictionaryId: 5 });
    expect(messageContent(frame, WC_DICTIONARY)).toEqual({ kind: "text", text: "compressed words", decompressed: true });
    // A frame made with no dictionary needs none.
    expect(messageContent(zstdCompressSync(Buffer.from("no dictionary")), null)).toEqual({ kind: "text", text: "no dictionary", decompressed: true });
    // A frame cut short is counted as compressed, never read as what little it holds, nor thrown.
    expect(messageContent(frame.subarray(0, frame.length - 3), WC_DICTIONARY)).toEqual({ kind: "compressed", dictionaryId: 5 });
    expect(messageContent(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x21, 0x05, 1, 2]), WC_DICTIONARY)).toEqual({ kind: "compressed", dictionaryId: 5 });
  });

  it("splits a group message's sender from its content only when it starts with one", () => {
    expect(splitSender("wxid_ada0001:\nhello:\nthere")).toEqual({ sender: "wxid_ada0001", body: "hello:\nthere" });
    expect(splitSender("bruno_p:\n<msg/>")).toEqual({ sender: "bruno_p", body: "<msg/>" });
    expect(splitSender("note: not a sender")).toBeNull();
    expect(splitSender("two words:\nno")).toBeNull();
  });

  it("reads an app message's own type, title and link, and the id of the message a reply answers", () => {
    expect(appMessage("<msg><appmsg><title>A &amp; B</title><url><![CDATA[https://example.com/?a=1&b=2]]></url><type>5</type></appmsg></msg>")).toEqual({
      subtype: 5, title: "A & B", url: "https://example.com/?a=1&b=2", replyTo: "",
    });
    const reply = appMessage(`<msg><appmsg><title>Yes</title><type>57</type><refermsg><type>1</type><svrid>${svr(1)}</svrid><title>quoted</title><url>q</url></refermsg></appmsg></msg>`);
    expect(reply).toEqual({ subtype: 57, title: "Yes", url: "", replyTo: svr(1) });
    expect(appMessage("<msg><appmsg></appmsg></msg>")).toEqual({ subtype: null, title: "", url: "", replyTo: "" });
  });

  it("reads a call's outcome and how long it was connected from the words the app shows for it, in Chinese and English", () => {
    expect(voipCall(voipBubble("通话时长 00:31"))).toEqual({ outcome: "answered", seconds: 31 });
    expect(voipCall(voipBubble("通话时长 12:05"))).toEqual({ outcome: "answered", seconds: 725 });
    expect(voipCall(voipBubble("通话时长 01:02:03"))).toEqual({ outcome: "answered", seconds: 3723 });
    expect(voipCall(voipBubble("Duration 00:31"))).toEqual({ outcome: "answered", seconds: 31 });
    expect(voipCall(voipBubble("Call Duration 1:02:03"))).toEqual({ outcome: "answered", seconds: 3723 });
    for (const words of ["已取消", "对方已取消", "Canceled", "Caller canceled"]) expect(voipCall(voipBubble(words))).toEqual({ outcome: "cancelled", seconds: 0 });
    for (const words of ["已拒绝", "对方已拒绝", "Declined", "Call declined"]) expect(voipCall(voipBubble(words))).toEqual({ outcome: "declined", seconds: 0 });
    for (const words of ["对方无应答", "未接听", "忙线未接听", "连接失败", "No answer", "Missed call", "Busy", "Call failed"]) {
      expect(voipCall(voipBubble(words))).toEqual({ outcome: "missed", seconds: 0 });
    }
    // Only <msg>'s words count: the ids, times and <duration> beside them never read as a length.
    expect(voipCall(voipBubble(""))).toBeNull();
    expect(voipCall(voipBubble("Something new"))).toBeNull();
    expect(voipCall("not a call record")).toBeNull();
  });
});

describe("wechat-ios", () => {
  it("finds the captain by the md5 of his wxid, which names the account's folder, and keys him me everywhere", async () => {
    const folder = await fixture();
    const { of, message, conversation } = await read(folder);
    expect(of("account").filter((a) => a.isSelf)).toEqual([{ kind: "account", key: SELF_KEY, keyKind: "id", displayName: "Me", nameSource: "settings", isSelf: true }]);
    expect(of("account").map((a) => a.key)).not.toContain(WC_SELF);
    expect(conversation(WC_GROUPS.footy)!.members).toContain(SELF_KEY);
    // A group message that starts with his own id (sent from another of his devices) is his.
    expect(message(svr(2006))).toMatchObject({ sender: SELF_KEY, isFromSelf: true, text: "Sent from my other device" });
    // The selfName setting names him.
    expect((await read(folder, { selfName: "Rowan" })).of("account").find((a) => a.isSelf)!.displayName).toBe("Rowan");
  });

  it("names accounts by the captain's remark, then their nickname, then their id, with the WeChat ID they chose as handle", async () => {
    const { of, tallies } = await read(await fixture());
    const accounts = Object.fromEntries(of("account").map((a) => [a.key, a]));
    expect(accounts[ada.id]).toMatchObject({ displayName: "Ada Sample", nameSource: "remark", handle: "ada_sample", keyKind: "id" });
    expect(accounts[bruno.id]).toMatchObject({ displayName: "Bruno Placeholder", nameSource: "nickname" });
    expect(accounts[bruno.id].handle).toBeUndefined();
    expect(accounts[dana.id]).toMatchObject({ displayName: "Dana Lee", nameSource: "nickname" });
    expect(accounts[cleo.id]).toMatchObject({ displayName: cleo.id, nameSource: "id" });
    expect(accounts.wxid_quiet0006).toMatchObject({ displayName: "wxid_quiet0006", nameSource: "id" });
    expect(Object.keys(accounts).sort()).toEqual([SELF_KEY, ada.id, bruno.id, cleo.id, dana.id, "wxid_quiet0006"].sort());
    expect(tallies).toMatchObject({
      "accounts named by the captain's remark": 1,
      "accounts named by their WeChat nickname": 2,
      "accounts shown by their id (group members who are no contact)": 2,
    });
  });

  it("reads one-to-one chats and groups, with a group message's sender from the start of its content", async () => {
    const { of, message, conversation } = await read(await fixture());
    expect(conversation(ada.id)).toEqual({ kind: "conversation", id: ada.id, type: "direct", title: "Ada Sample", members: [SELF_KEY, ada.id].sort() });
    // An older chat kept in MM.sqlite.
    expect(conversation(bruno.id)).toMatchObject({ type: "direct", title: "Bruno Placeholder" });
    // Cleo wrote in the group without being in its member list, so it is announced again with her.
    const footy = of("conversation").filter((c) => c.id === WC_GROUPS.footy);
    expect(footy.map((c) => c.members.includes(cleo.id))).toEqual([false, true]);
    expect(conversation(WC_GROUPS.footy)).toMatchObject({ type: "group", title: "Footy", members: [SELF_KEY, ada.id, bruno.id, cleo.id].sort() });
    // Members listed only in the group's XML; no name of its own.
    expect(conversation(WC_GROUPS.untitled)).toMatchObject({ type: "group", title: "", members: [SELF_KEY, ada.id, dana.id, "wxid_quiet0006"].sort() });

    expect(message(svr(1001))).toMatchObject({ conversation: ada.id, sender: ada.id, isFromSelf: false, type: "text", text: "Are you coming on Saturday?" });
    expect(message(svr(1002))).toMatchObject({ sender: SELF_KEY, isFromSelf: true, text: "Yes!" });
    expect(message(svr(1001))!.sentAt).toBe(Date.parse("2026-09-01T10:00:00+10:00"));
    expect(message(svr(1101))).toMatchObject({ conversation: bruno.id, sender: bruno.id, text: "An old chat" });
    expect(message(`${svr(2001)}/${WC_GROUPS.footy}`)).toMatchObject({ conversation: WC_GROUPS.footy, sender: bruno.id, text: "Training at six" });
    expect(message(svr(2002))).toMatchObject({ sender: SELF_KEY, isFromSelf: true, text: "I'll be there" });
    expect(message(svr(2003))).toMatchObject({ sender: cleo.id, text: "Me too" });
    expect(message(svr(3001))).toMatchObject({ conversation: WC_GROUPS.untitled, sender: dana.id, text: "Morning" });
    // Notices have no sender: they never count as talking with anyone.
    const notices = of("message").filter((m) => m.type === "system");
    expect(notices.map((m) => m.sender)).toEqual([null, null, null]);
    expect(notices.find((m) => m.conversation === WC_GROUPS.footy && m.text)!.text).toBe("Bruno Placeholder invited Cleo to the group");
  });

  it("keys messages on WeChat's own ids, exactly, with the chat added to an id in two chats, and a hash for one with none", async () => {
    const { of, message } = await read(await fixture());
    expect(message("7000000000000001001")).toBeDefined();
    expect(message(svr(1001))!.idKind).toBe("platform");
    expect(message(`${svr(2001)}/${ada.id}`)).toMatchObject({ conversation: ada.id, text: "The same id as a message in the footy group" });
    expect(message(svr(2001))).toBeUndefined();
    const synthetic = of("message").filter((m) => m.idKind === "synthetic");
    expect(synthetic).toHaveLength(2);
    for (const m of synthetic) expect(m.id).toMatch(/^[0-9a-f]{64}$/);
    // The same folder gives the same ids.
    const again = await read(join(dir, "data", "platform-exports", "wechat", "2026-09-28"));
    expect(again.of("message").map((m) => m.id)).toEqual(of("message").map((m) => m.id));
  });

  it("reads a link's address, a reply's own words and what it answers, and a file", async () => {
    const { message, attachmentOf } = await read(await fixture());
    expect(message(svr(1008))).toMatchObject({ type: "link", text: "https://example.com/a?b=1&c=2" });
    expect(message(svr(1009))).toMatchObject({ type: "text", text: "Sounds good", replyTo: svr(1001), sender: SELF_KEY });
    expect(message(svr(1010))).toMatchObject({ type: "media", sender: ada.id });
    expect(attachmentOf(svr(1010))).toMatchObject({ type: "file", filename: "10.pdf", mime: "application/pdf" });
  });

  it("keeps media where they are: a photo's HD copy first, its thumbnail when that is all, a voice note, and a missing video", async () => {
    const folder = await fixture();
    const { message, attachmentOf, tallies } = await read(folder);
    const chat = join(folder, "Documents", WC_ACCOUNT);
    const photo = attachmentOf(svr(1003))!;
    expect(photo).toMatchObject({ type: "image", ordinal: 0, filename: "3.pic_hd", mime: "image/jpeg" });
    expect(photo.inPlace!.path).toBe(join(chat, "Img", md5(ada.id), "3.pic_hd"));
    const bytes = await readFile(photo.inPlace!.path);
    expect(photo.inPlace).toMatchObject({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(attachmentOf(svr(1004))).toMatchObject({ type: "image", filename: "4.pic_thum" });
    expect(message(svr(1005))).toMatchObject({ type: "media" });
    expect(attachmentOf(svr(1005))).toMatchObject({ type: "audio", filename: "5.aud" });
    expect(attachmentOf(svr(1005))!.mime).toBeUndefined();
    const video = attachmentOf(svr(1006))!;
    expect(video).toMatchObject({ type: "video" });
    expect(video.inPlace).toBeUndefined();
    expect(video.filename).toBeUndefined();
    expect(tallies["photos kept only as the thumbnail (the phone never kept the photo)"]).toBe(1);
    expect(tallies["media not in the backup"]).toBe(1);
  });

  it("keeps a compressed message whose sender is known without its content, skips a compressed group message from someone else, and counts both", async () => {
    const { of, message, tallies } = await read(await fixture());
    expect(message(svr(1007))).toMatchObject({ sender: ada.id, type: "text" });
    expect(message(svr(1007))!.text).toBeUndefined();
    expect(message(svr(2004))).toBeUndefined();
    expect(message(svr(2007))).toMatchObject({ sender: null, type: "system" });
    expect(tallies[COMPRESSED_KEPT]).toBe(2);
    expect(tallies[COMPRESSED_SKIPPED]).toBe(1);
    expect(of("message")).toHaveLength(22);
  });

  it("reads every compressed message when the dictionary setting names WeChat's dictionary", async () => {
    const folder = await fixture();
    const { of, message, attachmentOf, tallies } = await read(folder, { dictionary: await dictionaryFile() });
    expect(message(svr(1007))).toMatchObject({ sender: ada.id, text: "A long message WeChat compressed." });
    expect(message(svr(2004))).toMatchObject({ conversation: WC_GROUPS.footy, sender: ada.id, type: "media" });
    expect(attachmentOf(svr(2004))!.inPlace!.path).toBe(join(folder, "Documents", WC_ACCOUNT, "Img", md5(WC_GROUPS.footy), "4.pic"));
    expect(tallies["messages read from WeChat's compressed form"]).toBe(3);
    expect(tallies[COMPRESSED_KEPT]).toBeUndefined();
    expect(tallies[COMPRESSED_SKIPPED]).toBeUndefined();
    expect(of("message")).toHaveLength(23);
    await expect(read(folder, { dictionary: join(dir, "nowhere.dict") })).rejects.toThrow(/nowhere\.dict is not there/);
  });

  it("gives a call how long it was connected, 0 when it never connected, and no length when its words cannot be read or say neither", async () => {
    const folder = await fixture();
    const chats = new DatabaseSync(join(folder, "Documents", WC_ACCOUNT, "DB", "message_1.sqlite"));
    const insert = chats.prepare(`INSERT INTO Chat_${md5(ada.id)} (MesLocalID, MesSvrID, CreateTime, Des, Type, Message, WCDB_CT_Message) VALUES (?, ?, ?, ?, 50, ?, ?)`);
    const calls: Array<[number, 0 | 1, string | Uint8Array]> = [
      [9101, 0, voipBubble("通话时长 12:05")],
      [9102, 1, voipBubble("Duration 1:02:03")],
      [9103, 0, voipBubble("对方无应答")],
      [9104, 1, voipBubble("Canceled")],
      [9105, 1, zstdCompressSync(Buffer.from(voipBubble("通话时长 00:31")), { dictionary: WC_DICTIONARY })],
      [9106, 0, voipBubble("Something new")],
    ];
    for (const [n, des, content] of calls) insert.run(n, BigInt(svr(n)), Date.parse("2026-09-05T20:00:00+10:00") / 1000 + n, des, content, typeof content === "string" ? 0 : 2);
    chats.close();

    const { message, tallies } = await read(folder);
    const length = (n: number) => message(svr(n))!.callSeconds;
    expect(message(svr(9101))).toMatchObject({ type: "call", sender: SELF_KEY, callSeconds: 725 });
    expect([length(9102), length(9103), length(9104), length(9105), length(9106)]).toEqual([3723, 0, 0, undefined, undefined]);
    expect(tallies).toMatchObject({
      "calls answered": 2, "calls missed": 1, "calls cancelled": 1, "calls whose words say neither how long nor that they did not connect": 1,
      "calls compressed with WeChat's dictionary, their length unknown": 1,
    });
    // With the dictionary the compressed one is read too.
    expect((await read(folder, { dictionary: await dictionaryFile() })).message(svr(9105))!.callSeconds).toBe(31);
  });

  it("skips WeChat's own chats, official accounts and chats it cannot name, and counts them", async () => {
    const { of, tallies } = await read(await fixture());
    expect(tallies).toMatchObject({
      "messages with official accounts": 1,
      "messages in WeChat's own chats (File Transfer, its notices)": 1,
      "messages in chats whose WeChat id is not known": 1,
    });
    expect(of("conversation").map((c) => c.id)).not.toContain("filehelper");
    expect(of("account").map((a) => a.key).some((key) => key.startsWith("gh_"))).toBe(false);
  });

  it("covers each chat from its first message to the newest in the backup", async () => {
    const { of } = await read(await fixture());
    const newest = Date.parse("2026-09-03T09:01:00+10:00");
    expect(of("coverage").find((c) => c.conversation === bruno.id)).toEqual({ kind: "coverage", conversation: bruno.id, from: Date.parse("2015-03-01T12:00:00+11:00"), to: newest });
    expect(of("coverage").find((c) => c.conversation === undefined)).toEqual({ kind: "coverage", from: Date.parse("2015-03-01T12:00:00+11:00"), to: newest });
  });

  it("reads the folder extract-wechat fills, its Documents/ or the account's folder alike, and refuses one with no account", async () => {
    const folder = await fixture();
    const whole = (await read(folder)).of("message").length;
    expect((await read(join(folder, "Documents"))).of("message")).toHaveLength(whole);
    expect((await read(join(folder, "Documents", WC_ACCOUNT))).of("message")).toHaveLength(whole);
    await expect(read(dir)).rejects.toThrow(/no WeChat account/);
  });

  it("never writes into the folder it reads", async () => {
    const folder = await fixture();
    const before = (await readdir(folder, { recursive: true })).sort();
    await read(folder);
    expect((await readdir(folder, { recursive: true })).sort()).toEqual(before);
  });
});

describe("wechat-ios through the archive", () => {
  let archive: TestArchive;

  beforeEach(async () => {
    await mkdir(join(dir, "data", "friends"), { recursive: true });
    archive = await openTestArchive(join(dir, "data"));
    await archive.host.setEnabled("wechat-ios", true);
  });

  afterEach(() => archive.close());

  it("imports a backup, adds nothing on a second import, and only what is new from a newer backup", async () => {
    const folder = await fixture();
    const first = await archive.host.importHistory("wechat", folder);
    expect(first.connector).toBe("wechat-ios");
    expect(first.counts.messages).toEqual({ added: 22, updated: 0, unchanged: 0, duplicates: 0, unsentAdded: 0, matched: 0, edited: 0 });
    expect(first.counts.accounts).toEqual({ added: 6, updated: 0 });
    expect(first.counts.conversations).toEqual({ added: 4, updated: 0 });
    expect(first.counts.attachments).toEqual({ added: 5, updated: 0, stored: 4, missing: 1 });

    const again = await archive.host.importHistory("wechat-ios", folder);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: 22 });
    expect(again.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });

    const photo = () =>
      (archive.db
        .prepare("SELECT a.local_path AS path FROM attachment a JOIN message m ON m.id = a.message_id WHERE m.platform_message_id = ?")
        .get(svr(1003)) as { path: string }).path;
    expect(photo()).toBe(`platform-exports/wechat/2026-09-28/Documents/${WC_ACCOUNT}/Img/${md5(ada.id)}/3.pic_hd`);

    const later = await archive.host.importHistory("wechat-ios", await fixture({ later: true }));
    expect(later.counts.messages).toMatchObject({ added: 2, updated: 0, unchanged: 22 });
    expect(later.counts.accounts).toEqual({ added: 0, updated: 0 });
    // An attachment points at its file in the newest export holding it.
    expect(photo()).toBe(`platform-exports/wechat/2026-10-02/Documents/${WC_ACCOUNT}/Img/${md5(ada.id)}/3.pic_hd`);
  });

  it("fills in what was compressed when imported again with the dictionary", async () => {
    const folder = await fixture();
    await archive.host.importHistory("wechat-ios", folder);
    const decoded = await archive.host.importHistory("wechat-ios", folder, { settings: { dictionary: await dictionaryFile() } });
    // The group photo whose sender was compressed is new; the one-to-one message gains its text.
    expect(decoded.counts.messages).toMatchObject({ added: 1, updated: 1, unchanged: 21 });
    expect(decoded.counts.attachments).toMatchObject({ added: 1 });
  });

  it("counts no notice as talking, and joins a WeChat person with a WhatsApp person of the same name", async () => {
    await archive.host.importHistory("wechat-ios", await fixture());
    archive.people.runRules();
    const people = archive.structure.listPeople().people;
    const adaPerson = people.find((p) => p.name === "Ada Sample")!;
    // Her one-to-one messages, less the notice in her chat.
    expect(adaPerson).toMatchObject({ directMessageCount: 11 });

    const whatsapp = join(dir, "data", "platform-exports", "whatsapp", "2026-09-28");
    await writeWhatsAppFixture(whatsapp);
    await archive.host.setEnabled("whatsapp-db", true);
    await archive.host.importHistory("whatsapp-db", whatsapp);
    archive.people.runRules();
    const joined = archive.structure.listPeople().people.filter((p) => p.joined).map((p) => p.accounts.map((a) => `${a.platform}:${a.displayName}`).sort());
    expect(joined).toContainEqual(["wechat:Ada Sample", "whatsapp:Ada Sample"]);
  });
});

describe("extract-wechat", () => {
  const file = (relativePath: string) => ({ fileID: createHash("sha1").update(`${WECHAT_DOMAIN}-${relativePath}`).digest("hex"), relativePath });

  it("chooses each account's message databases and its chats' media, and leaves out what the app had not finished writing", () => {
    const account = md5("wxid_someone");
    const other = md5("wxid_signed_out");
    const chat = md5("wxid_friend");
    const chosen = chooseWeChatFiles([
      file(`Documents/${account}/DB/WCDB_Contact.sqlite`),
      file(`Documents/${account}/DB/MM.sqlite`),
      file(`Documents/${account}/DB/message_1.sqlite`),
      file(`Documents/${account}/DB/message_12.sqlite-wal`),
      file(`Documents/${account}/DB/WCDB_OpLog.sqlite`),
      file(`Documents/${account}/DB/MM.sqlite-first.material`),
      file(`Documents/${account}/Img/${chat}/3.pic`),
      file(`Documents/${account}/Img/${chat}/3.pic_thum`),
      file(`Documents/${account}/Img/${chat}/4.pic.tmp`),
      file(`Documents/${account}/Img/${chat}/5.pic.dftemp`),
      file(`Documents/${account}/Video/${chat}/6.mp4`),
      file(`Documents/${account}/Video/${chat}/7_temp.mp4`),
      file(`Documents/${account}/Audio/${chat}/8.aud`),
      file(`Documents/${account}/Audio/${chat}/9.aud_tmp`),
      file(`Documents/${account}/OpenData/${chat}/10.pdf`),
      file(`Documents/${account}/session/session.db`),
      file(`Documents/${account}/Img/loose.pic`),
      // A folder with media but no contacts database is no account.
      file(`Documents/${other}/Img/${chat}/1.pic`),
      file("Library/Preferences/com.tencent.xin.plist"),
    ]);
    expect(chosen.accounts).toEqual([account]);
    expect(chosen.counts).toEqual({ DB: 4, Img: 2, Video: 1, Audio: 1, OpenData: 1 });
    expect(chosen.unfinished).toBe(4);
    expect(chosen.files.map((f) => f.relativePath.split("/").at(-1))).toEqual([
      "WCDB_Contact.sqlite", "MM.sqlite", "message_1.sqlite", "message_12.sqlite-wal", "3.pic", "3.pic_thum", "6.mp4", "8.aud", "10.pdf",
    ]);
  });

  /** A made-up unencrypted iPhone backup holding the WeChat fixture, as Finder lays one out. */
  async function backup(takenAt: string): Promise<string> {
    const app = join(dir, "app");
    await writeWeChatFixture(app);
    const folder = join(dir, "backup");
    await mkdir(folder, { recursive: true });
    const manifest = new DatabaseSync(join(folder, "Manifest.db"));
    manifest.exec("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)");
    const add = manifest.prepare("INSERT INTO Files (fileID, domain, relativePath, flags) VALUES (?, ?, ?, ?)");
    for (const entry of await readdir(app, { withFileTypes: true, recursive: true })) {
      const relativePath = relative(app, join(entry.parentPath, entry.name));
      const { fileID } = file(relativePath);
      add.run(fileID, WECHAT_DOMAIN, relativePath, entry.isFile() ? 1 : 2);
      if (!entry.isFile()) continue;
      await mkdir(join(folder, fileID.slice(0, 2)), { recursive: true });
      await writeFile(join(folder, fileID.slice(0, 2), fileID), await readFile(join(app, relativePath)));
    }
    // Listed but not held, and another app's file.
    add.run(file(`Documents/${WC_ACCOUNT}/Audio/${md5(ada.id)}/99.aud`).fileID, WECHAT_DOMAIN, `Documents/${WC_ACCOUNT}/Audio/${md5(ada.id)}/99.aud`, 1);
    add.run("0".repeat(40), "AppDomain-com.example.other", "Documents/notes.sqlite", 1);
    manifest.close();
    await writeFile(
      join(folder, "Status.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
        `<plist version="1.0"><dict><key>Date</key><date>${takenAt}</date><key>SnapshotState</key><string>finished</string></dict></plist>\n`,
    );
    return folder;
  }

  it.skipIf(!existsSync("/usr/bin/plutil"))("copies WeChat's files out of a backup into platform-exports/wechat/<the day it was taken>/, which then imports", async () => {
    const exportsDir = join(dir, "data", "platform-exports");
    const result = await extractWeChat(await backup("2026-09-28T09:00:42Z"), exportsDir);
    // 09:00 UTC is 19:00 in Melbourne, the same day.
    expect(result.folder).toBe(join(exportsDir, "wechat", dayKey(Date.parse("2026-09-28T09:00:42Z"))));
    expect(result.folder.endsWith("2026-09-28")).toBe(true);
    expect(result).toMatchObject({ accounts: [WC_ACCOUNT], counts: { DB: 4, Img: 6, Audio: 2, Video: 1, OpenData: 2 }, missing: 1, unfinished: 0 });
    const app = join(dir, "app");
    expect(await readFile(join(result.folder, "Documents", WC_ACCOUNT, "Img", md5(ada.id), "3.pic_hd"))).toEqual(await readFile(join(app, "Documents", WC_ACCOUNT, "Img", md5(ada.id), "3.pic_hd")));
    expect(existsSync(`${result.folder}.partial`)).toBe(false);

    const { of } = await read(result.folder);
    expect(of("message")).toHaveLength(22);

    // A folder with that day's name is never written over.
    await expect(extractWeChat(join(dir, "backup"), exportsDir)).rejects.toThrow(/already there/);
    expect((await extractWeChat(join(dir, "backup"), exportsDir, { date: "2026-09-29" })).folder.endsWith("2026-09-29")).toBe(true);
  });

  it.skipIf(!existsSync("/usr/bin/plutil"))("refuses a folder that is no backup, and an encrypted backup", async () => {
    await expect(extractWeChat(dir, join(dir, "exports"))).rejects.toThrow(/no Status\.plist/);
    const folder = await backup("2026-09-28T09:00:42Z");
    // An encrypted backup's Manifest.db is encrypted too.
    await writeFile(join(folder, "Manifest.db"), Buffer.alloc(4096, 0x5a));
    await expect(extractWeChat(folder, join(dir, "exports"))).rejects.toThrow(/encrypted backup cannot be read/);
  });

  it.skipIf(!existsSync("/usr/bin/plutil"))("refuses a backup that has not finished", async () => {
    const folder = await backup("2026-09-28T09:00:42Z");
    const status = join(folder, "Status.plist");
    await writeFile(status, (await readFile(status, "utf8")).replace("<string>finished</string>", "<string>new</string>"));
    await expect(extractWeChat(folder, join(dir, "exports"))).rejects.toThrow(/a backup that has not finished \(new\)/);
  });

  it.skipIf(!existsSync("/usr/bin/plutil"))("finds the backup Finder took last, among a device's and an archived copy", async () => {
    const home = join(dir, "home");
    await expect(finderBackup(home)).rejects.toThrow(/there is no .*MobileSync\/Backup; when it is a link to another disk, is that disk connected\?/);
    const backups = finderBackups(home);
    // A folder Finder made for the phone before any backup, which holds nothing.
    await mkdir(join(backups, "00008101-000A1B2C3D4E5F60"), { recursive: true });
    await expect(finderBackup(home)).rejects.toThrow(/holds no backup; take one first/);
    for (const [name, takenAt] of [["00008101-000A1B2C3D4E5F61", "2026-10-20T09:00:00Z"], ["00008101-000A1B2C3D4E5F61-20260901-120000", "2026-09-01T02:00:00Z"]]) {
      await mkdir(join(backups, name), { recursive: true });
      await writeFile(join(backups, name, "Manifest.db"), "");
      await writeFile(join(backups, name, "Status.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Date</key><date>${takenAt}</date></dict></plist>\n`);
    }
    expect(await finderBackup(home)).toBe(join(backups, "00008101-000A1B2C3D4E5F61"));
  });
});
