import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeAttributedBody, IM_GROUP, IM_LEFT_GROUP, IM_PEOPLE, IM_UNMARKED_GROUP, writeMessagesFixture } from "../fixtures/imessage.ts";
import { writeAddressBookFixture, writeWhatsAppFixture } from "../fixtures/whatsapp.ts";
import { AddressBook, readIphoneContacts } from "./addressBook.ts";
import type { ConnectorEvent } from "../../../sdk/server.ts";
import { appleTime, readMessagesDb, SELF_KEY } from "./imessage-db/read.ts";
import { attributedBodyText } from "./imessage-db/typedstream.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-imessage-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The iPhone backup's layout (or the Mac's), with the iPhone's address book in the folder, elsewhere, or not at all. */
async function fixture(
  { copy = "iphone", addressBook = "beside" }: { copy?: "iphone" | "mac"; addressBook?: "beside" | "elsewhere" | "none" } = {},
): Promise<{ folder: string; database: string; contacts: string }> {
  // Where the captain keeps it, in the data folder the archive tests open (dir/data); the Mac's copy is the later one.
  const folder = join(dir, "data", "platform-exports", "imessage", copy === "iphone" ? "2026-09-28" : "2026-10-01");
  const database = await writeMessagesFixture(folder, { copy });
  const contacts = join(addressBook === "elsewhere" ? dir : folder, "AddressBook.sqlitedb");
  if (addressBook !== "none") writeAddressBookFixture(contacts);
  return { folder, database, contacts };
}

async function read(source: string, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readMessagesDb({ sources: [source], config, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  const tallies = Object.fromEntries(of("tally").map((t) => [t.name, t.count]));
  return { events, of, tallies, mediaDir };
}

const namesOf = (accounts: Array<{ key: string; displayName: string }>) =>
  Object.fromEntries(accounts.map(({ key, displayName }) => [key, displayName]));

describe("imessage-db", () => {
  it("keys accounts on their handles, names them from the address book by number or email, and knows the captain", async () => {
    const { of, tallies } = await read((await fixture()).folder);
    expect(Object.fromEntries(of("account").map(({ key, displayName, handle, isSelf }) => [key, { displayName, handle, isSelf }]))).toEqual({
      [SELF_KEY]: { displayName: "Me", handle: undefined, isSelf: true },
      // One account for her number, whether she wrote by iMessage or SMS.
      [IM_PEOPLE.ada]: { displayName: "Ada Sample", handle: IM_PEOPLE.ada, isSelf: undefined },
      // Her email is on her card too.
      [IM_PEOPLE.adaEmail]: { displayName: "Ada Sample", handle: IM_PEOPLE.adaEmail, isSelf: undefined },
      // Typed in national form in the address book.
      [IM_PEOPLE.bruno]: { displayName: "Bruno Placeholder", handle: IM_PEOPLE.bruno, isSelf: undefined },
      [IM_PEOPLE.cleo]: { displayName: "Cleo M. Example", handle: IM_PEOPLE.cleo, isSelf: undefined },
      [IM_PEOPLE.unsaved]: { displayName: IM_PEOPLE.unsaved, handle: IM_PEOPLE.unsaved, isSelf: undefined },
      [IM_PEOPLE.dana]: { displayName: IM_PEOPLE.dana, handle: IM_PEOPLE.dana, isSelf: undefined },
      [IM_PEOPLE.business]: { displayName: "Telstra", handle: undefined, isSelf: undefined },
      [`unknown@${IM_GROUP.id}`]: { displayName: "Unknown user", handle: undefined, isSelf: undefined },
    });
    expect(Object.fromEntries(Object.entries(tallies).filter(([name]) => name.startsWith("accounts ")))).toEqual({
      "accounts named from the address book": 4,
      "accounts shown by phone number": 1,
      "accounts shown by email": 1,
      "accounts shown by the name or short code they text from": 1,
    });

    expect(of("conversation").map((c) => [c.id, c.type, c.title, c.members])).toEqual([
      // Her iMessage chat and her SMS chat are one conversation.
      [IM_PEOPLE.ada, "direct", "Ada Sample", [IM_PEOPLE.ada, SELF_KEY]],
      [IM_PEOPLE.adaEmail, "direct", "Ada Sample", [IM_PEOPLE.adaEmail, SELF_KEY]],
      [IM_PEOPLE.bruno, "direct", "Bruno Placeholder", [IM_PEOPLE.bruno, SELF_KEY]],
      [IM_PEOPLE.unsaved, "direct", IM_PEOPLE.unsaved, [IM_PEOPLE.unsaved, SELF_KEY]],
      [IM_PEOPLE.business, "direct", "Telstra", [IM_PEOPLE.business, SELF_KEY]],
      [IM_GROUP.id, "group", IM_GROUP.title, [IM_PEOPLE.ada, IM_PEOPLE.bruno, IM_PEOPLE.cleo, SELF_KEY]],
      // Everyone else left, and it is still a group.
      [IM_LEFT_GROUP.id, "group", "", [IM_PEOPLE.cleo, SELF_KEY]],
      [IM_PEOPLE.dana, "direct", IM_PEOPLE.dana, [IM_PEOPLE.dana, SELF_KEY]],
      // The captain writing to his own email.
      [SELF_KEY, "direct", "Me", [SELF_KEY]],
      // Not marked as a group, but two people are in it.
      [IM_UNMARKED_GROUP.id, "group", "", [IM_PEOPLE.bruno, IM_PEOPLE.unsaved, SELF_KEY]],
    ]);
    expect(tallies["chats with nobody in them"]).toBe(1);
  });

  it("maps messages, reads text kept only in attributedBody, and turns tapbacks into reactions", async () => {
    const { of, tallies, mediaDir } = await read((await fixture()).folder);
    const messages = of("message");
    const byId = new Map(messages.map((m) => [m.id, m]));
    // Tapbacks are not messages, and the message in no chat is skipped.
    expect(messages).toHaveLength(30);
    expect(["M005", "M006", "M007", "M013", "M014", "M999"].filter((id) => byId.has(id))).toEqual([]);
    expect(tallies["messages in no chat"]).toBe(1);
    expect(tallies).toMatchObject({ "messages by iMessage": 25, "messages by SMS": 5 });

    expect(["M001", "M003", "M004", "M010", "M011", "M041", "M042", "M070", "M075"].map((id) => byId.get(id)!.type)).toEqual([
      "text", "media", "media", "link", "contact", "media", "sticker", "system", "system",
    ]);
    expect(byId.get("M001")).toMatchObject({ sender: IM_PEOPLE.ada, isFromSelf: false, sentAt: Date.parse("2025-10-04T21:30:00+10:00") });
    expect(byId.get("M002")).toMatchObject({ sender: SELF_KEY, isFromSelf: true, text: "Yes! Where?" });
    // An attachment's placeholder character is not text.
    expect(byId.get("M003")!.text).toBeUndefined();
    expect(byId.get("M004")!.text).toBe("Top out");
    expect(byId.get("M008")).toMatchObject({ text: "See you at 9", editedAt: Date.parse("2025-10-04T21:38:00+10:00") });
    expect(byId.get("M012")).toMatchObject({ replyTo: "M001" });
    // Only the placeholder of an attachment whose row is gone.
    expect([byId.get("M015")!.type, byId.get("M015")!.text]).toEqual(["other", undefined]);
    expect(tallies["messages whose attachments are no longer in the database"]).toBe(1);
    // Old iOS kept dates in seconds.
    expect(byId.get("M050")!.sentAt).toBe(Date.parse("2016-03-01T10:00:00+11:00"));

    const unsent = byId.get("M009")!;
    expect(unsent).toMatchObject({ unsent: true, type: "text" });
    expect(unsent.text).toBeUndefined();
    expect(Object.keys(unsent.raw as object)).not.toContain("text");

    // Group events have no sender; a group message whose sender's handle is gone has an unknown one.
    expect([byId.get("M070")!.sender, byId.get("M075")!.sender]).toEqual([null, null]);
    expect(byId.get("M074")).toMatchObject({ sender: `unknown@${IM_GROUP.id}`, conversation: IM_GROUP.id });
    expect(byId.get("M073")).toMatchObject({ sender: IM_PEOPLE.bruno, conversation: IM_GROUP.id });
    expect(byId.get("M020")).toMatchObject({ sender: IM_PEOPLE.ada, conversation: IM_PEOPLE.ada });
    expect(byId.get("M100")).toMatchObject({ sender: SELF_KEY, conversation: SELF_KEY });

    // Ada's heart stands; the captain's thumbs up was taken back; one points at a message not in the database.
    expect(of("reaction").map(({ message, actor, emoji }) => [message, actor, emoji])).toEqual([
      ["M002", IM_PEOPLE.ada, "❤️"],
      ["M012", IM_PEOPLE.ada, "🔥"],
    ]);
    expect(tallies).toMatchObject({
      "tapbacks kept as reactions": 2, "tapbacks taken back": 1, "tapbacks on messages not in the database": 1,
    });

    // The link's preview data file is left out; the video is not in the folder.
    const attachments = of("attachment");
    expect(attachments.map((a) => [a.message, a.type, a.filename, a.mime, a.inPlace !== undefined])).toEqual([
      ["M003", "image", "IMG_0001.HEIC", "image/heic", true],
      ["M004", "video", "top-out.mov", "video/quicktime", false],
      ["M011", "file", "Cleo Example.vcf", "text/vcard", true],
      ["M041", "audio", "Audio Message.caf", "audio/x-caf", true],
      ["M042", "sticker", "sticker.png", "image/png", true],
    ]);
    expect(tallies).toMatchObject({ "link preview data files, left out": 1, "attachments not in the folder": 1 });
    // Each file is pointed at where it lies in the backup, hashed, and nothing is copied.
    expect(attachments.every((a) => a.stored === undefined)).toBe(true);
    for (const { inPlace } of attachments) {
      if (!inPlace) continue;
      expect(inPlace.path).toMatch(/\/platform-exports\/imessage\/2026-09-28\/Library\/SMS\/Attachments\//);
      const bytes = await readFile(inPlace.path);
      expect([createHash("sha256").update(bytes).digest("hex"), bytes.length]).toEqual([inPlace.sha256, inPlace.size]);
    }
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);

    expect(of("coverage").filter((c) => c.conversation === undefined)).toEqual([
      { kind: "coverage", from: Date.parse("2016-03-01T10:00:00+11:00"), to: Date.parse("2026-05-01T10:01:00+10:00") },
    ]);
  });

  it("reads the Mac's chat.db under the same ids, from its folder or the file", async () => {
    const iphone = await read((await fixture()).folder);
    const { folder, database } = await fixture({ copy: "mac", addressBook: "none" });
    const mac = await read(folder);
    const ids = (events: typeof iphone) => new Set(events.of("message").map((m) => m.id));
    expect([...ids(mac)].filter((id) => !ids(iphone).has(id)).sort()).toEqual(["M200", "M201"]);
    // The Mac has none of the files.
    expect(mac.of("attachment").every((a) => a.inPlace === undefined)).toBe(true);
    expect(mac.of("attachment")).toHaveLength(1);
    expect((await read(database)).of("message")).toHaveLength(10);
  });

  it("reads the database from a copy and never writes into the source folder", async () => {
    const { folder, database } = await fixture();
    const before = await readdir(folder, { recursive: true });
    const original = await readFile(database);
    await read(folder);
    expect(await readdir(folder, { recursive: true })).toEqual(before);
    expect(await readFile(database)).toEqual(original);
  });

  it("reads the address book the contacts setting names, and without one shows handles and needs the captain's own", async () => {
    const { folder, contacts } = await fixture({ addressBook: "elsewhere" });
    const alone = await read(folder);
    expect(namesOf(alone.of("account"))[IM_PEOPLE.ada]).toBe(IM_PEOPLE.ada);
    expect(alone.tallies["no AddressBook.sqlitedb, so accounts are shown by their handles"]).toBe(1);
    // Without his card, his own email is someone else until the settings say it is his.
    expect(namesOf(alone.of("account"))[IM_PEOPLE.self]).toBe(IM_PEOPLE.self);
    const told = await read(folder, { selfHandles: ["Riley@Example.com"], selfName: "Riley" });
    expect(namesOf(told.of("account"))[IM_PEOPLE.self]).toBeUndefined();
    expect(told.of("account").find((a) => a.isSelf)).toMatchObject({ key: SELF_KEY, displayName: "Riley" });

    expect(namesOf((await read(folder, { contacts })).of("account"))[IM_PEOPLE.ada]).toBe("Ada Sample");
    await expect(read(folder, { contacts: join(dir, "nowhere.sqlitedb") })).rejects.toThrow(/nowhere\.sqlitedb is not there/);
  });

  it("says what is wrong with a folder or file that is not the Messages app's, naming no content", async () => {
    await expect(read(dir)).rejects.toThrow(/no sms\.db or chat\.db/);
    const db = new DatabaseSync(join(dir, "chat.db"));
    db.exec(`CREATE TABLE handle (ROWID INTEGER, id TEXT); CREATE TABLE chat (ROWID INTEGER, chat_identifier TEXT);
      CREATE TABLE chat_handle_join (chat_id, handle_id); CREATE TABLE chat_message_join (chat_id, message_id);
      CREATE TABLE message (ROWID INTEGER, text TEXT)`);
    db.close();
    await expect(read(dir)).rejects.toThrow(/message has no guid, date, is_from_me, handle_id/);
  });
});

describe("attributedBody", () => {
  it("reads the string inside, however long", () => {
    for (const text of ["", "Hi", "😂 ".repeat(40), "x".repeat(70_000)]) expect(attributedBodyText(encodeAttributedBody(text))).toBe(text);
  });

  it("returns null for anything else", () => {
    expect(attributedBodyText(Buffer.from("not a typedstream"))).toBeNull();
    const whole = Buffer.from(encodeAttributedBody("Hello there"));
    expect(attributedBodyText(whole.subarray(0, whole.indexOf("Hello") + 2))).toBeNull();
  });
});

describe("Apple dates", () => {
  it("reads nanoseconds and seconds since 2001, and nothing for none", () => {
    expect(appleTime(0n)).toBeNull();
    expect(appleTime(null)).toBeNull();
    expect(appleTime(1n)).toBe(Date.parse("2001-01-01T00:00:01Z"));
    expect(appleTime(812_270_580_115_053_952n)).toBe(978_307_200_000 + 812_270_580_115);
  });
});

describe("the iPhone address book's emails", () => {
  it("matches an email ignoring case, and knows the captain's", () => {
    const file = join(dir, "AddressBook.sqlitedb");
    writeAddressBookFixture(file);
    const db = new DatabaseSync(file);
    try {
      const book = new AddressBook(readIphoneContacts(db));
      expect(book.lookupEmail("ADA@example.com")).toEqual({ name: "Ada Sample", self: false });
      expect(book.lookupEmail("riley@example.com")).toMatchObject({ self: true });
      expect(book.lookupEmail("nobody@example.com")).toEqual({ name: undefined, self: false });
    } finally {
      db.close();
    }
  });
});

describe("imessage-db through the archive", () => {
  let dataDir: string;
  let archive: TestArchive;

  beforeEach(async () => {
    dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("imessage", true);
  });

  afterEach(() => archive.close());

  it("imports a backup, adds nothing on a second import, and only what is new from the Mac's copy", async () => {
    const { folder } = await fixture();
    const first = await archive.host.importHistory("imessage", folder);
    expect(first.connector).toBe("imessage-db");
    expect(first.counts.messages).toEqual({ added: 30, updated: 0, unchanged: 0, duplicates: 0, unsentAdded: 1, matched: 0, edited: 0 });
    expect(first.counts.accounts).toEqual({ added: 9, updated: 0 });
    expect(first.counts.conversations).toEqual({ added: 10, updated: 0 });
    expect(first.counts.reactions).toEqual({ added: 2 });
    expect(first.counts.attachments).toEqual({ added: 5, updated: 0, stored: 4, missing: 1 });

    const again = await archive.host.importHistory("imessage-db", folder);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: 30 });
    expect(again.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(again.counts.reactions).toEqual({ added: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });

    const mac = await archive.host.importHistory("imessage", (await fixture({ copy: "mac" })).folder);
    expect(mac.counts.messages).toMatchObject({ added: 2, updated: 0, unchanged: 8 });
    expect(mac.counts.accounts).toEqual({ added: 0, updated: 0 });
    // The Mac lacks the photo; the file in the iPhone's backup is kept.
    expect(mac.counts.attachments).toMatchObject({ added: 0, updated: 0, missing: 1 });
    const photo = archive.db
      .prepare("SELECT a.local_path AS path FROM attachment a JOIN message m ON m.id = a.message_id WHERE m.platform_message_id = 'M003'")
      .get() as { path: string | null };
    expect(photo.path).toMatch(/^platform-exports\/imessage\/2026-09-28\/Library\/SMS\/Attachments\//);
  });

  it("counts no group event as talking, and joins iMessage people with WhatsApp people of the same name", async () => {
    await archive.host.importHistory("imessage", (await fixture()).folder, {});
    archive.people.runRules();
    const people = archive.structure.listPeople().people;
    const bruno = people.find((p) => p.name === "Bruno Placeholder")!;
    // Three messages in his chat; one in the named group, one in the unmarked one; the rename is not talking.
    expect(bruno).toMatchObject({ directMessageCount: 3 });

    const whatsapp = join(dir, "data", "platform-exports", "whatsapp", "2026-09-28");
    await writeWhatsAppFixture(whatsapp);
    await archive.host.setEnabled("whatsapp-db", true);
    await archive.host.importHistory("whatsapp-db", whatsapp);
    archive.people.runRules();
    const joined = archive.structure.listPeople().people.filter((p) => p.joined).map((p) => p.accounts.map((a) => `${a.platform}:${a.displayName}`).sort());
    expect(joined).toContainEqual(["imessage:Bruno Placeholder", "whatsapp:Bruno Placeholder"]);
  });
});
