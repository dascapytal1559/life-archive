import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { callsOf } from "../server/calls.ts";
import {
  WA_CALLS, WA_COMMUNITY, WA_GROUP, WA_OLD_CALL_AT, WA_PEOPLE, writeAddressBookFixture, writeBridgeLidMap, writeWhatsAppFixture,
} from "../fixtures/whatsapp.ts";
import type { ConnectorEvent } from "../../../sdk/server.ts";
import { AddressBook, joinName, parseNumber, readIphoneContacts } from "./addressBook.ts";
import { readWhatsAppDb, SELF_KEY } from "./whatsapp-db/read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-whatsapp-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const jid = (phone: string) => `${phone}@s.whatsapp.net`;
const ADA = jid(WA_PEOPLE.ada.phone);
const BRUNO = jid(WA_PEOPLE.bruno.phone);
const CLEO = jid(WA_PEOPLE.cleo.phone);

/** An export's folder, where the captain keeps it: in the data folder the archive tests open (dir/data). */
const exportAt = (date: string) => join(dir, "data", "platform-exports", "whatsapp", date);

async function fixture(copy: "iphone" | "mac" = "iphone"): Promise<string> {
  // The Mac's copy was taken after the iPhone's.
  const folder = exportAt(copy === "iphone" ? "2026-09-28" : "2026-10-01");
  await writeWhatsAppFixture(folder, { copy });
  return folder;
}

/** The iPhone copy shaped like a real iPhone backup, with the iPhone's address book beside it, elsewhere, or not at all. */
async function backup(addressBook: "beside" | "elsewhere" | "none" = "beside"): Promise<{ folder: string; contacts: string }> {
  const folder = exportAt("2026-09-29");
  await writeWhatsAppFixture(folder, { backup: true });
  const contacts = join(addressBook === "elsewhere" ? dir : folder, "AddressBook.sqlitedb");
  if (addressBook !== "none") writeAddressBookFixture(contacts);
  return { folder, contacts };
}

const namesOf = (accounts: Array<{ key: string; displayName: string }>) =>
  Object.fromEntries(accounts.map(({ key, displayName }) => [key, displayName]));
const nameTallies = (tallies: Array<{ name: string; count: number }>) =>
  Object.fromEntries(tallies.filter((t) => t.name.startsWith("accounts ")).map((t) => [t.name, t.count]));

async function read(source: string, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readWhatsAppDb({ sources: [source], config, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, mediaDir };
}

describe("whatsapp-db", () => {
  it("keys accounts on phone JIDs, resolving LIDs through LID.sqlite, the chat list and ContactsV2, and names them", async () => {
    const { of } = await read(await fixture());
    const accounts = Object.fromEntries(of("account").map(({ key, displayName, handle, isSelf }) => [key, { displayName, handle, isSelf }]));
    expect(accounts).toEqual({
      [SELF_KEY]: { displayName: "Me", handle: undefined, isSelf: true },
      // ContactsV2's name over the chat's.
      [ADA]: { displayName: "Ada Sample", handle: "+61491571266", isSelf: undefined },
      [BRUNO]: { displayName: "Bruno Placeholder", handle: "+61491571491", isSelf: undefined },
      [jid(WA_PEOPLE.cleo.phone)]: { displayName: "Cleo Example", handle: "+61491571804", isSelf: undefined },
      // Not in the address book, and the chat's name is only their number: the name they gave themselves.
      [jid(WA_PEOPLE.unsaved.phone)]: { displayName: "Sunny", handle: "+61491574118", isSelf: undefined },
      // Their chat is keyed by LID, which LID.sqlite's pair table resolves; the chat's name over the push name.
      [jid(WA_PEOPLE.dana.phone)]: { displayName: "Dana Lee", handle: "+61491572549", isSelf: undefined },
      [jid(WA_PEOPLE.fern.phone)]: { displayName: "Fern", handle: "+61491572665", isSelf: undefined },
      [jid(WA_PEOPLE.hal.phone)]: { displayName: "+61491572983", handle: "+61491572983", isSelf: undefined },
      [jid(WA_PEOPLE.ivy.phone)]: { displayName: "Ivy", handle: "+61491573087", isSelf: undefined },
      [WA_PEOPLE.gus.lid]: { displayName: "Gus Unlisted", handle: undefined, isSelf: undefined },
      [WA_PEOPLE.stranger.lid]: { displayName: "WhatsApp user", handle: undefined, isSelf: undefined },
    });
    expect(of("account").every((a) => a.keyKind === "id")).toBe(true);

    const conversations = of("conversation");
    expect(conversations.map((c) => [c.id, c.type, c.title])).toEqual([
      [ADA, "direct", "Ada Sample"],
      [BRUNO, "direct", "Bruno Placeholder"],
      [jid(WA_PEOPLE.unsaved.phone), "direct", "Sunny"],
      [jid(WA_PEOPLE.dana.phone), "direct", "Dana Lee"],
      [WA_GROUP.jid, "group", WA_GROUP.title],
      // A community's announcements group is a group like any other.
      [WA_COMMUNITY.jid, "group", WA_COMMUNITY.title],
    ]);
    // Ada is a group member by LID; the captain's own member row is the captain.
    expect(conversations.find((c) => c.id === WA_GROUP.jid)!.members).toEqual(
      [ADA, jid(WA_PEOPLE.cleo.phone), jid(WA_PEOPLE.fern.phone), jid(WA_PEOPLE.ivy.phone), WA_PEOPLE.gus.lid, WA_PEOPLE.stranger.lid, SELF_KEY].sort(),
    );
    expect(nameTallies(of("tally"))).toEqual({
      "accounts named from the address book": 3,
      "accounts named by their one-to-one chat": 1,
      "accounts named by their WhatsApp push name": 3,
      "accounts named by a group's member list": 1,
      "accounts shown by phone number": 1,
      "accounts with no name or number": 1,
    });
  });

  it("passes over the base64 protobuf messages the iPhone app keeps in push name and member name columns", async () => {
    const folder = await fixture();
    const plainNames = await read(folder);
    // As in a real iPhone copy: every message's ZPUSHNAME an encoded message (a time in seconds, then
    // more fields), and member rows' ZFIRSTNAME one with a "+" in front. Fern, Hal and the stranger
    // were named by them; now Fern keeps her member-list name, Hal his number, the stranger none.
    const chats = new DatabaseSync(join(folder, "ChatStorage.sqlite"));
    chats.exec("UPDATE ZWAMESSAGE SET ZPUSHNAME = 'CKDw3MYGIAA=' WHERE ZISFROMME = 0 AND ZPUSHNAME IS NULL");
    chats.exec("UPDATE ZWAMESSAGE SET ZPUSHNAME = 'COmDxooG' WHERE ZSTANZAID = '3A00000000000000G007'");
    chats.prepare("UPDATE ZWAGROUPMEMBER SET ZFIRSTNAME = '+EAA=' WHERE ZMEMBERJID IN (?, ?, ?)")
      .run(WA_PEOPLE.stranger.lid, jid(WA_PEOPLE.hal.phone), jid(WA_PEOPLE.ivy.phone));
    chats.close();
    const encoded = await read(folder);
    expect(namesOf(encoded.of("account"))).toEqual(namesOf(plainNames.of("account")));
    expect(namesOf(encoded.of("account"))).toMatchObject({
      [jid(WA_PEOPLE.fern.phone)]: "Fern",
      [jid(WA_PEOPLE.hal.phone)]: "+61491572983",
      [WA_PEOPLE.stranger.lid]: "WhatsApp user",
    });
    expect(nameTallies(encoded.of("tally"))).toEqual(nameTallies(plainNames.of("tally")));
  });

  it("maps every message type, keeps deleted messages as unsent, and gives system messages no sender", async () => {
    const { of, mediaDir } = await read(await fixture());
    const messages = of("message");
    expect(messages).toHaveLength(31);
    const byId = new Map(messages.map((m) => [m.id, m]));
    const type = (stanza: string) => byId.get(`3A00000000000000${stanza}`)?.type;
    expect(["A001", "A003", "A004", "A005", "A006", "A010", "A011", "A012", "A013", "A014", "A015", "G000"].map(type)).toEqual([
      "text", "media", "media", "media", "media", "location", "contact", "link", "sticker", "media", "other", "system",
    ]);
    // An image's caption is on its media item.
    expect(byId.get("3A00000000000000A003")!.text).toBe("The crag");

    const unsent = messages.filter((m) => m.unsent);
    expect(unsent.map((m) => m.id)).toEqual(["3A00000000000000A007"]);
    expect(unsent[0].text).toBeUndefined();
    expect(JSON.stringify(unsent[0].raw)).not.toContain("ZTEXT");

    const system = messages.filter((m) => m.type === "system");
    expect(system).toHaveLength(2);
    expect(system.every((m) => m.sender === null)).toBe(true);
    expect(system.filter((m) => m.idKind === "synthetic")).toHaveLength(1);

    expect(byId.get("3A00000000000000G001")).toMatchObject({ sender: WA_PEOPLE.gus.lid, conversation: WA_GROUP.jid });
    expect(byId.get("3A00000000000000G003")).toMatchObject({ sender: ADA });
    expect(byId.get("3A00000000000000G004")).toMatchObject({ sender: SELF_KEY, isFromSelf: true });
    expect(byId.get("3A00000000000000A001")).toMatchObject({ sender: ADA, isFromSelf: false, sentAt: Date.parse("2025-10-04T21:30:00+10:00") });
    // The broadcast list is skipped; the copies in two chats share a stanza id and are told apart by chat.
    expect(messages.filter((m) => m.id.startsWith("3A00000000000000X001")).map((m) => m.id)).toEqual([
      `3A00000000000000X001/${ADA}`, `3A00000000000000X001/${BRUNO}`,
    ]);

    const attachments = of("attachment");
    expect(attachments.map((a) => [a.filename, a.type, a.mime, a.inPlace !== undefined])).toEqual([
      ["crag-view.jpg", "image", "image/jpeg", true],
      ["top-out.mp4", "video", "video/mp4", false],
      ["voice.opus", "audio", "audio/ogg", true],
      ["route-guide.pdf", "file", "application/pdf", true],
      ["sticker.webp", "sticker", "image/webp", true],
      ["wave.mp4", "gif", "video/mp4", true],
    ]);
    // Each file is pointed at where it lies in the folder, hashed, and nothing is copied.
    expect(attachments.every((a) => a.stored === undefined)).toBe(true);
    for (const { inPlace } of attachments) {
      if (!inPlace) continue;
      expect(inPlace.path.startsWith(`${exportAt("2026-09-28")}/Message/Media/`)).toBe(true);
      const bytes = await readFile(inPlace.path);
      expect([createHash("sha256").update(bytes).digest("hex"), bytes.length]).toEqual([inPlace.sha256, inPlace.size]);
    }
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);

    expect(Object.fromEntries(of("tally").filter((t) => !t.name.startsWith("accounts ")).map((t) => [t.name, t.count]))).toEqual({
      "no AddressBook.sqlitedb, so accounts are named by WhatsApp alone": 1,
      "CallHistory.sqlite not in the folder": 1,
      "media not in the folder": 1,
      "messages without a WhatsApp id": 1,
      "messages in broadcast lists": 1,
      "status updates": 1,
      "messages in no chat": 1,
      "messages of an unknown type (99)": 1,
    });
    const wide = of("coverage").filter((c) => c.conversation === undefined);
    expect(wide).toEqual([{ kind: "coverage", from: Date.parse("2024-05-01T10:00:00+10:00"), to: Date.parse("2026-09-21T09:25:00+10:00") }]);
  });

  it("reads the Mac copy's chats and messages under the same ids as the iPhone copy's", async () => {
    const iphone = await read(await fixture("iphone"));
    const mac = await read(await fixture("mac"));
    const ids = (events: typeof iphone) => new Set(events.of("message").map((m) => m.id));
    const macOnly = [...ids(mac)].filter((id) => !ids(iphone).has(id));
    expect(macOnly.sort()).toEqual(["3A00000000000000B003", "3A00000000000000G006"]);
    expect(mac.of("conversation").map((c) => c.id)).toEqual(iphone.of("conversation").map((c) => c.id));
  });

  it("reads the databases from a copy and never writes into the source folder", async () => {
    const folder = await fixture();
    const before = await readdir(folder, { recursive: true });
    const chatStorage = await readFile(join(folder, "ChatStorage.sqlite"));
    await read(folder);
    expect(await readdir(folder, { recursive: true })).toEqual(before);
    expect(await readFile(join(folder, "ChatStorage.sqlite"))).toEqual(chatStorage);
    // The file itself can be named instead of its folder.
    expect((await read(join(folder, "ChatStorage.sqlite"))).of("message")).toHaveLength(31);
  });

  it("takes the captain's own JIDs from its settings", async () => {
    const { of } = await read(await fixture(), { selfJids: ["+61 491 574 118"], selfName: "Riley" });
    expect(of("account").find((a) => a.key === jid(WA_PEOPLE.unsaved.phone))).toBeUndefined();
    expect(of("account").find((a) => a.isSelf)).toMatchObject({ key: SELF_KEY, displayName: "Riley" });
  });

  it("names people from the iPhone's address book beside a backup without ContactsV2, and knows the captain by his own card", async () => {
    const { folder } = await backup();
    const { of } = await read(folder);
    expect(namesOf(of("account"))).toEqual({
      [SELF_KEY]: "Me",
      // Typed with its country code; the second card with the number is passed over for the first.
      [ADA]: "Ada Sample",
      // Typed in national form, "0491 571 491".
      [BRUNO]: "Bruno Placeholder",
      // Typed with 00 in front, and with a middle name.
      [jid(WA_PEOPLE.cleo.phone)]: "Cleo M. Example",
      [jid(WA_PEOPLE.unsaved.phone)]: "Sunny",
      [jid(WA_PEOPLE.dana.phone)]: "Dana Lee",
      [jid(WA_PEOPLE.fern.phone)]: "Fern",
      [jid(WA_PEOPLE.hal.phone)]: "+61491572983",
      [jid(WA_PEOPLE.ivy.phone)]: "Ivy",
      [WA_PEOPLE.gus.lid]: "Gus Unlisted",
      [WA_PEOPLE.stranger.lid]: "WhatsApp user",
    });
    // No message names the captain's member row; his card's number does.
    expect(of("conversation").find((c) => c.id === WA_GROUP.jid)!.members).toContain(SELF_KEY);
    expect(of("message").find((m) => m.id === "3A00000000000000G004")).toMatchObject({ sender: SELF_KEY, isFromSelf: true });
    expect(nameTallies(of("tally"))).toEqual({
      "accounts named from the address book": 3,
      "accounts named by their one-to-one chat": 1,
      "accounts named by their WhatsApp push name": 3,
      "accounts named by a group's member list": 1,
      "accounts shown by phone number": 1,
      "accounts with no name or number": 1,
    });
    expect(of("tally").map((t) => t.name)).toContain("ContactsV2.sqlite not in the folder");
  });

  it("reads the address book the contacts setting names, and says when it is not there", async () => {
    const { folder, contacts } = await backup("elsewhere");
    expect(namesOf((await read(folder)).of("account"))[BRUNO]).toBe("Bruno Placeholder"); // the chat's name
    expect(namesOf((await read(folder)).of("account"))[jid(WA_PEOPLE.cleo.phone)]).toBe("Cleo Example"); // the member list's
    const { of } = await read(folder, { contacts });
    expect(namesOf(of("account"))[jid(WA_PEOPLE.cleo.phone)]).toBe("Cleo M. Example");
    expect(of("account").filter((a) => a.isSelf)).toHaveLength(1);
    await expect(read(folder, { contacts: join(dir, "nowhere.sqlitedb") })).rejects.toThrow(/nowhere\.sqlitedb is not there/);
  });

  it("without an address book, names people by WhatsApp alone and needs the captain's number from its settings", async () => {
    const { folder } = await backup("none");
    const alone = await read(folder);
    expect(namesOf(alone.of("account"))[ADA]).toBe("Ada");
    expect(alone.of("tally").map((t) => t.name)).toContain("no AddressBook.sqlitedb, so accounts are named by WhatsApp alone");
    // His member row is someone else until the settings say whose number it is.
    expect(namesOf(alone.of("account"))[jid(WA_PEOPLE.self.phone)]).toBe("+61491570737");
    const told = await read(folder, { selfJids: [WA_PEOPLE.self.phone] });
    expect(namesOf(told.of("account"))[jid(WA_PEOPLE.self.phone)]).toBeUndefined();
  });

  it("says what is wrong with a folder that is not WhatsApp's, naming no content", async () => {
    await expect(read(dir)).rejects.toThrow(/no ChatStorage\.sqlite/);
    const db = new DatabaseSync(join(dir, "ChatStorage.sqlite"));
    db.exec("CREATE TABLE ZWACHATSESSION (Z_PK INTEGER, ZSESSIONTYPE INTEGER, ZCONTACTJID TEXT); CREATE TABLE ZWAMESSAGE (Z_PK INTEGER, ZTEXT TEXT)");
    db.close();
    await expect(read(dir)).rejects.toThrow(/ZWAMESSAGE has no ZCHATSESSION, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZSTANZAID/);
  });
});

describe("whatsapp-db's calls", () => {
  const DANA = jid(WA_PEOPLE.dana.phone);

  it("reads each call once, from its chat's call record or else the Calls tab, with its length, way and chat", async () => {
    const folder = exportAt("2026-09-28");
    await writeWhatsAppFixture(folder, { calls: true });
    const { of } = await read(folder);
    const calls = of("message").filter((m) => m.type === "call");
    const byId = new Map(calls.map((m) => [m.id, m]));
    // Six call records in the chats, and five calls only the Calls tab has.
    expect(calls).toHaveLength(11);
    expect(of("message")).toHaveLength(31 + 11);

    // In a chat: its time, and how long WhatsApp's own record there says it was connected.
    expect(byId.get(WA_CALLS.adaVideo)).toMatchObject({
      conversation: ADA, sender: ADA, isFromSelf: false, sentAt: Date.parse("2026-09-22T20:41:00+10:00"), idKind: "platform", callSeconds: 2460,
    });
    expect(byId.get(WA_CALLS.adaVideo)!.raw).toMatchObject({ ZMESSAGETYPE: 59, callLog: { isVideo: true, outcome: 0, durationSecs: 2460 } });
    expect(byId.get(WA_CALLS.adaUnanswered)).toMatchObject({ sender: SELF_KEY, isFromSelf: true, callSeconds: 0 });
    expect(byId.get(WA_CALLS.groupVideo)).toMatchObject({ conversation: WA_GROUP.jid, sender: CLEO, callSeconds: 1620 });
    // Its record keeps no length, so the Calls tab's is taken; with neither, it has none.
    expect(byId.get(WA_CALLS.adaFromHistory)).toMatchObject({ sender: SELF_KEY, callSeconds: 600 });
    expect(byId.get(WA_CALLS.adaBare)!.callSeconds).toBeUndefined();
    // Answered on another device: only that device knows how long.
    expect(byId.get(WA_CALLS.brunoElsewhere)).toMatchObject({ conversation: BRUNO, sender: BRUNO });
    expect(byId.get(WA_CALLS.brunoElsewhere)!.callSeconds).toBeUndefined();

    // Only in the Calls tab: when it started, in the chat with the one person on it, keyed by the call id.
    expect(byId.get(WA_CALLS.cleo)).toMatchObject({
      conversation: CLEO, sender: CLEO, isFromSelf: false, sentAt: Date.parse("2026-09-10T18:00:00+10:00"), idKind: "platform", callSeconds: 301,
    });
    expect(byId.get(WA_CALLS.brunoUnanswered)).toMatchObject({ conversation: BRUNO, sender: SELF_KEY, isFromSelf: true, callSeconds: 0 });
    expect(byId.get(WA_CALLS.groupFromHistory)).toMatchObject({ conversation: WA_GROUP.jid, sender: SELF_KEY, callSeconds: 900 });
    expect(byId.get(WA_CALLS.danaElsewhere)).toMatchObject({ conversation: DANA, sender: DANA });
    expect(byId.get(WA_CALLS.danaElsewhere)!.callSeconds).toBeUndefined();
    // The oldest calls have no call id: theirs is made from what the Calls tab keeps of them.
    expect(calls.filter((m) => m.idKind === "synthetic")).toMatchObject([
      { conversation: ADA, sender: ADA, sentAt: Date.parse(WA_OLD_CALL_AT), callSeconds: 120 },
    ]);
    // With several people and no group: a call in no chat, not a message. With no one, or in a group with no chat here: left out.
    expect([WA_CALLS.adHoc, WA_CALLS.withStranger, WA_CALLS.nobody, WA_CALLS.unknownGroup].filter((id) => byId.has(id))).toEqual([]);
    // Everyone on it whom the copy has a chat with, whoever started it first; anyone else is counted, unnamed.
    expect(of("call")).toEqual([
      {
        kind: "call", id: WA_CALLS.adHoc, with: ADA, alsoWith: [BRUNO, CLEO], at: Date.parse("2026-09-12T12:00:00+10:00"), durationSeconds: 400,
        direction: "incoming", answered: true, service: "voice", raw: expect.objectContaining({ ZCALLIDSTRING: WA_CALLS.adHoc }),
      },
      {
        kind: "call", id: WA_CALLS.withStranger, with: BRUNO, alsoWith: [ADA], others: 1, at: Date.parse("2026-09-12T20:00:00+10:00"),
        direction: "incoming", answered: true, service: "video", raw: expect.objectContaining({ participants: [expect.anything(), expect.anything()] }),
      },
    ]);

    // Cleo had no one-to-one chat; her call makes one.
    expect(of("conversation").find((c) => c.id === CLEO)).toMatchObject({ type: "direct", title: "Cleo Example", members: [CLEO, SELF_KEY] });
    expect(Object.fromEntries(of("tally").filter((t) => /call/.test(t.name)).map((t) => [t.name, t.count]))).toEqual({
      "calls only the Calls tab has (CallHistory.sqlite)": 5,
      "calls of no known length (answered on another device, say)": 3,
      "call records that say nothing more of the call": 1,
      "calls with several people and no group (calls in no chat)": 2,
      "people on those calls the copy has no chat with (counted, unnamed)": 1,
      "calls with several people and no group, with no one the copy has a chat with": 1,
      "calls the copy does not say who they were with": 1,
      "calls in a group the copy has no chat for": 1,
    });
  });

  it("dates an outgoing call only the Calls tab has when it started, and still knows a call with no id by the Calls tab's own date", async () => {
    const folder = exportAt("2026-09-28");
    await writeWhatsAppFixture(folder, { calls: true });
    // The Calls tab dates the group call, outgoing, 15 minutes, when it ended.
    const group = (await read(folder)).of("message").find((m) => m.id === WA_CALLS.groupFromHistory)!;
    expect(group.sentAt).toBe(Date.parse("2026-09-14T12:00:00+10:00"));
    // The oldest call made outgoing: it started two minutes before its date, and its id is made from that date, as it
    // was before outgoing calls were dated when they started, so a copy imported then is not added again.
    const history = new DatabaseSync(join(folder, "CallHistory.sqlite"));
    const self = jid(WA_PEOPLE.self.phone);
    history.exec(`
      UPDATE ZWAAGGREGATECALLEVENT SET ZINCOMING = 0 WHERE Z_PK = (SELECT Z1CALLEVENTS FROM ZWACDCALLEVENT WHERE ZCALLIDSTRING IS NULL);
      UPDATE ZWACDCALLEVENT SET ZGROUPCALLCREATORUSERJIDSTRING = '${self}' WHERE ZCALLIDSTRING IS NULL;
      INSERT INTO ZWACDCALLEVENTPARTICIPANT (Z_ENT, Z_OPT, ZOUTCOME, Z1PARTICIPANTS, ZJIDSTRING)
        SELECT 3, 1, 0, Z_PK, '${ADA}' FROM ZWACDCALLEVENT WHERE ZCALLIDSTRING IS NULL;
    `);
    history.close();
    const old = (await read(folder)).of("message").find((m) => m.idKind === "synthetic" && m.type === "call")!;
    expect(old).toMatchObject({ conversation: ADA, sender: SELF_KEY, sentAt: Date.parse(WA_OLD_CALL_AT) - 120_000 });
    expect(old.id).toBe(createHash("sha256").update(["whatsapp-call", Date.parse(WA_OLD_CALL_AT), 0, self, ADA].join("\u001f")).digest("hex"));
  });

  it("reads a folder without the Calls tab, and says so", async () => {
    const folder = exportAt("2026-09-28");
    await writeWhatsAppFixture(folder, { calls: true });
    await rm(join(folder, "CallHistory.sqlite"));
    const { of } = await read(folder);
    expect(of("message").filter((m) => m.type === "call").map((m) => m.id).sort()).toEqual(
      [WA_CALLS.adaVideo, WA_CALLS.adaUnanswered, WA_CALLS.brunoElsewhere, WA_CALLS.groupVideo, WA_CALLS.adaBare, WA_CALLS.adaFromHistory].sort(),
    );
    expect(of("message").find((m) => m.id === WA_CALLS.adaFromHistory)!.callSeconds).toBeUndefined();
    expect(of("tally").map((t) => t.name)).toContain("CallHistory.sqlite not in the folder");
  });
});

describe("whatsapp-db's calls from the Mac app", () => {
  const DANA = jid(WA_PEOPLE.dana.phone);

  /** The Mac app's copy, shaped like the real one, and the bridge's database that knows Ada's and Dana's LIDs. */
  async function macApp(): Promise<{ folder: string; bridgeDb: string }> {
    const folder = exportAt("mac");
    await writeWhatsAppFixture(folder, { copy: "mac", calls: true, macApp: true });
    const bridgeDb = join(dir, "mautrix-whatsapp.db");
    writeBridgeLidMap(bridgeDb);
    return { folder, bridgeDb };
  }
  const callTallies = (tallies: Array<{ name: string; count: number }>) =>
    Object.fromEntries(tallies.filter((t) => /call|LID/.test(t.name)).map((t) => [t.name, t.count]));

  it("by the Calls tab alone, would put calls with the wrong people and under LIDs the copy cannot resolve", async () => {
    const { folder } = await macApp();
    const { of } = await read(folder);
    const byId = new Map(of("message").map((m) => [m.id, m]));
    // Cleo's call, which the Mac lists with Ada on it, becomes a three-way call; the three-way call, which it lists
    // with only Ada, a call in her chat; and its own call with Ada, by her LID, lands in a chat with that LID.
    expect(of("call").find((c) => c.id === WA_CALLS.cleo)).toMatchObject({ with: CLEO, alsoWith: [ADA] });
    expect(byId.get(WA_CALLS.adHoc)).toMatchObject({ conversation: ADA });
    expect(byId.get(WA_CALLS.macEvening)).toMatchObject({ conversation: WA_PEOPLE.ada.lid });
    expect(byId.get(WA_CALLS.danaElsewhere)).toMatchObject({ conversation: WA_PEOPLE.dana.lid });
  });

  it("with callsFrom: chats, takes a call only the Calls tab has only where the copy bears out who it was with", async () => {
    const { folder, bridgeDb } = await macApp();
    const { of } = await read(folder, { callsFrom: "chats", bridgeDb });
    const calls = of("message").filter((m) => m.type === "call");
    const byId = new Map(calls.map((m) => [m.id, m]));
    expect([...byId.keys()].sort()).toEqual([
      // The chats' own call records...
      WA_CALLS.adaVideo, WA_CALLS.adaUnanswered, WA_CALLS.brunoElsewhere, WA_CALLS.groupVideo, WA_CALLS.adaFromHistory,
      // ...and those only the Calls tab has: incoming ones with whoever called, in their chat, and the outgoing one beside
      // Ada's video call. Cleo has no chat here, so her call is left out.
      WA_CALLS.adaBare, WA_CALLS.adHoc, WA_CALLS.withStranger, WA_CALLS.danaElsewhere, WA_CALLS.macEvening,
    ].sort());
    // Each of those only stands in for its chat's record, which this copy lacks.
    expect(calls.filter((m) => m.fallback).length).toBe(5);
    expect(byId.get(WA_CALLS.adHoc)).toMatchObject({ conversation: ADA, sender: ADA });
    expect(byId.get(WA_CALLS.withStranger)).toMatchObject({ conversation: BRUNO, sender: BRUNO });
    // The LIDs the copy cannot resolve, the bridge's database does.
    expect(byId.get(WA_CALLS.danaElsewhere)).toMatchObject({ conversation: DANA, sender: DANA });
    expect(byId.get(WA_CALLS.macEvening)).toMatchObject({
      conversation: ADA, sender: SELF_KEY, isFromSelf: true, sentAt: Date.parse("2026-09-22T20:45:00+10:00"), callSeconds: 300,
    });
    // Never a call in no chat; the outgoing call to Bruno, with no call record of his near it, is left out.
    expect(of("call")).toEqual([]);
    expect(callTallies(of("tally"))).toMatchObject({
      "outgoing calls only the Calls tab has, which no call record in the chat it names bears out, left out (callsFrom: chats)": 1,
      "incoming calls only the Calls tab has, from someone the copy has no chat with, left out (callsFrom: chats)": 1,
      "LIDs the bridge's database gave the number of": 2,
    });

    // Without the bridge's database, Ada's LID names no chat with a call record, so her call is left out too.
    const alone = await read(folder, { callsFrom: "chats" });
    expect(alone.of("message").map((m) => m.id)).not.toContain(WA_CALLS.macEvening);
  });

  it("reads calls alone with only: calls, and refuses settings it does not know", async () => {
    const { folder, bridgeDb } = await macApp();
    const { of } = await read(folder, { only: "calls", callsFrom: "chats", bridgeDb });
    expect(of("message").every((m) => m.type === "call")).toBe(true);
    expect(of("message")).toHaveLength(10);
    expect(of("attachment")).toEqual([]);
    expect(of("coverage")).toEqual([]);
    // Only the chats that hold a call, and the people in them, each only for the archive to add if it has none.
    expect(of("conversation").map((c) => c.id).sort()).toEqual([ADA, BRUNO, DANA, WA_GROUP.jid].sort());
    expect([...of("conversation"), ...of("account")].every((e) => e.fallback)).toBe(true);
    // A group's members are only those who started its calls.
    expect(of("conversation").find((c) => c.id === WA_GROUP.jid)!.members).toEqual([CLEO, SELF_KEY].sort());
    expect(of("tally").find((t) => t.name === "messages left out, being no call (only: calls)")?.count).toBe(26);
    await expect(read(folder, { only: "everything" })).rejects.toThrow(/only setting takes "calls"/);
    await expect(read(folder, { callsFrom: "tab" })).rejects.toThrow(/callsFrom setting takes "chats" or "both"/);
  });
});

describe("the iPhone address book", () => {
  it("reads a number however it was typed", () => {
    expect(parseNumber("+61 491 571 266")).toEqual({ digits: "61491571266", international: true });
    expect(parseNumber("0061 491-571-266")).toEqual({ digits: "61491571266", international: true });
    expect(parseNumber("(0400) 000 001")).toEqual({ digits: "400000001", international: false });
    expect(parseNumber("138-0000-0000")).toEqual({ digits: "13800000000", international: false });
    expect(parseNumber("1-555-MY-SAMPLE")).toBeNull();
    expect(parseNumber("000")).toBeNull();
    expect(parseNumber("+")).toBeNull();
  });

  it("matches a WhatsApp number exactly, or by national digits after a country code, and knows the captain's card", () => {
    const file = join(dir, "AddressBook.sqlitedb");
    writeAddressBookFixture(file);
    const db = new DatabaseSync(file);
    try {
      const book = new AddressBook(readIphoneContacts(db));
      // Two cards have Ada's number; the first one's name is kept.
      expect(book.lookup("61491571266")).toEqual({ name: "Ada Sample", self: false });
      expect(book.lookup("61491571491")).toEqual({ name: "Bruno Placeholder", self: false });
      expect(book.lookup("61491570737")).toMatchObject({ name: "Riley Captain", self: true });
      expect(book.lookup("61370100000")).toMatchObject({ name: "Plumbing Co" });
      expect(book.lookup("447700900008")).toMatchObject({ name: "Dana Example" });
      expect(book.lookup("12025550109")).toMatchObject({ name: "Li Li" });
      // The national digits must follow a country code of at most three digits.
      expect(book.lookup("9999400000002")).toEqual({ name: undefined, self: false });
    } finally {
      db.close();
    }
  });

  it("joins name parts without repeating one the name already ends with", () => {
    expect(joinName(["Dana Example", "", "Example"])).toBe("Dana Example");
    expect(joinName(["Dana", "Example", "example"])).toBe("Dana Example");
    expect(joinName(["Dana Mae Example", "", "Mae Example"])).toBe("Dana Mae Example");
    expect(joinName(["Li", "", "Li"])).toBe("Li Li");
    expect(joinName(["Cleo", "M.", "Example"])).toBe("Cleo M. Example");
    expect(joinName(["", "", ""])).toBe("");
  });

  it("says when a file is not an iPhone address book", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY, First TEXT)");
    expect(() => readIphoneContacts(db)).toThrow(/no ABPerson\.Last, ABPerson\.Organization, ABMultiValue\.record_id/);
    db.close();
  });
});

describe("whatsapp-db through the archive", () => {
  let dataDir: string;
  let archive: TestArchive;

  beforeEach(async () => {
    dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("whatsapp-db", true);
  });

  afterEach(() => archive.close());

  const attachmentPath = (stanza: string) =>
    (archive.db
      .prepare("SELECT a.local_path AS path FROM attachment a JOIN message m ON m.id = a.message_id WHERE m.platform_message_id = ?")
      .get(stanza) as { path: string | null }).path;

  it("imports a copy, adds nothing on a second import, and only what is new from the overlapping Mac copy", async () => {
    const iphone = await fixture("iphone");
    const first = await archive.host.importHistory("whatsapp-db", iphone);
    expect(first.connector).toBe("whatsapp-db");
    expect(first.counts.messages).toEqual({ added: 31, updated: 0, unchanged: 0, duplicates: 0, unsentAdded: 1, matched: 0, edited: 0 });
    expect(first.counts.accounts).toEqual({ added: 11, updated: 0 });
    expect(first.counts.conversations).toEqual({ added: 6, updated: 0 });
    expect(first.counts.attachments).toEqual({ added: 6, updated: 0, stored: 5, missing: 1 });

    const again = await archive.host.importHistory("whatsapp-db", iphone);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: 31 });
    expect(again.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });

    const mac = await archive.host.importHistory("whatsapp-db", await fixture("mac"));
    expect(mac.counts.messages).toMatchObject({ added: 2, updated: 0, unchanged: 21 });
    expect(mac.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(mac.counts.conversations).toEqual({ added: 0, updated: 0 });
    // The Mac copy lacks the media files; the files in the iPhone's copy are kept.
    expect(mac.counts.attachments).toMatchObject({ added: 0, updated: 0, missing: 2 });
    expect(attachmentPath("3A00000000000000A013")).toMatch(/^platform-exports\/whatsapp\/2026-09-28\/Message\/Media\//);
    expect((archive.db.prepare("SELECT count(*) AS n FROM message WHERE platform = 'whatsapp'").get() as { n: number }).n).toBe(33);
  });

  it("imports a backup with the address book the import names", async () => {
    const { folder, contacts } = await backup("elsewhere");
    const result = await archive.host.importHistory("whatsapp-db", folder, { settings: { contacts } });
    expect(result.counts.tallies["accounts named from the address book"]).toBe(3);
    const names = (archive.db.prepare("SELECT display_name AS name FROM import_person WHERE platform = 'whatsapp'").all() as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("Cleo M. Example");
    // The setting was for that import only.
    expect((await archive.host.readConfig("whatsapp-db")).config.contacts).toBeUndefined();
  });

  it("fills people's notes from the address book an import is given, and not without one", async () => {
    const { folder, contacts } = await backup("elsewhere");
    const plain = await archive.importHistory("whatsapp-db", folder);
    expect(plain.said.some((line) => line.startsWith("Address book:"))).toBe(false);
    const result = await archive.importHistory("whatsapp-db", folder, { settings: { contacts } });
    // Ada and Bruno have a chat; Dana's and Plumbing Co's cards match nobody here.
    expect(result.said).toContain("Address book: 9 contacts; 2 with a company, department or job title, 3 with a note, 4 with either; 2 of those matched to people (0 to more than one person).");
    expect(result.said).toContain("Notes: 2 people have one in the address book: 2 written, 0 already as it says, 0 kept because you changed them.");
    const noteOf = (name: string) => archive.structure.listPeople().people.find((p) => p.name === name)?.note;
    expect(noteOf("Ada Sample")).toBe("Company: Sample Labs\nJob title: Engineer\nMet at the climbing gym.\nVegetarian.");
    expect(noteOf("Bruno Placeholder")).toBe("Lent me a tent");
  });

  it("imports each call once, from either copy, as a call with the person on the other side, and makes calls of what an older import could not tell", async () => {
    const iphone = exportAt("2026-09-28");
    await writeWhatsAppFixture(iphone, { calls: true });
    const first = await archive.host.importHistory("whatsapp-db", iphone);
    expect(first.counts.messages).toMatchObject({ added: 31 + 11 });
    expect(first.counts.conversations).toEqual({ added: 7, updated: 0 });
    archive.people.runRules();
    const calls = (name: string) => {
      const person = archive.structure.listPeople().people.find((p) => p.name === name)!;
      return callsOf(archive.db, person.id).map((c) => [c.at, c.direction, c.answered, c.durationSeconds]);
    };
    // Newest first; a call of no known length is not among them until it is given one.
    const threeWay = [Date.parse("2026-09-12T12:00:00+10:00"), "incoming", true, 400];
    expect(calls("Ada Sample")).toEqual([
      [Date.parse("2026-09-24T09:10:00+10:00"), "outgoing", true, 600],
      [Date.parse("2026-09-23T08:00:00+10:00"), "outgoing", false, 0],
      [Date.parse("2026-09-22T20:41:00+10:00"), "incoming", true, 2460],
      threeWay,
      [Date.parse(WA_OLD_CALL_AT), "incoming", true, 120],
    ]);
    expect(calls("Cleo Example")).toEqual([threeWay, [Date.parse("2026-09-10T18:00:00+10:00"), "incoming", true, 301]]);
    expect(calls("Bruno Placeholder")).toEqual([threeWay, [Date.parse("2026-09-11T12:00:00+10:00"), "outgoing", false, 0]]);
    // The three-way call is a call in no chat with each of the three, each a third of it with the rest; the call with a
    // stranger on it, of no known length, is with Bruno and Ada and one unnamed other.
    expect(first.counts.calls).toEqual({ added: 2, updated: 0, unchanged: 0 });
    const ada = archive.structure.listPeople().people.find((p) => p.name === "Ada Sample")!;
    expect(callsOf(archive.db, ada.id).find((c) => c.at === threeWay[0])).toMatchObject({
      platform: "whatsapp", messageId: null, manual: false, service: "voice", people: 3, others: 0, group: expect.any(Number),
    });
    const rows = () => archive.db.prepare(
      `SELECT c.platform_call_id AS id, a.key, c.duration_seconds AS seconds, c.answered, c.service, c.others FROM call c
       JOIN import_person a ON a.id = c.import_person_id ORDER BY c.platform_call_id, a.key`,
    ).all();
    expect(rows()).toEqual([
      ...[ADA, BRUNO, jid(WA_PEOPLE.cleo.phone)].map((key) => ({ id: WA_CALLS.adHoc, key, seconds: 400, answered: 1, service: "voice", others: 0 })),
      ...[ADA, BRUNO].map((key) => ({ id: WA_CALLS.withStranger, key, seconds: null, answered: 1, service: "video", others: 1 })),
    ]);

    // Again, and the Mac app's copy, whose chats and Calls tab hold the same calls: nothing new but the Mac's two messages.
    expect((await archive.host.importHistory("whatsapp-db", iphone)).counts.messages).toMatchObject({ added: 0, updated: 0 });
    const mac = exportAt("2026-10-01");
    await writeWhatsAppFixture(mac, { copy: "mac", calls: true });
    const fromMac = await archive.host.importHistory("whatsapp-db", mac);
    expect(fromMac.counts.messages).toMatchObject({ added: 2, updated: 0 });
    expect(fromMac.counts.calls).toEqual({ added: 0, updated: 0, unchanged: 2 });
    expect(rows()).toHaveLength(5);
    const count = () => archive.db.prepare("SELECT type, count(*) AS n FROM message WHERE platform = 'whatsapp' AND type IN ('call', 'other') GROUP BY type ORDER BY type").all();
    expect(count()).toEqual([{ type: "call", n: 11 }, { type: "other", n: 1 }]);

    // An import from before calls were read kept the chats' call records as of another kind, with no length.
    archive.db.exec("UPDATE message SET type = 'other', call_seconds = NULL WHERE platform = 'whatsapp' AND json_extract(raw_json, '$.ZMESSAGETYPE') = 59");
    expect(count()).toEqual([{ type: "call", n: 5 }, { type: "other", n: 7 }]);
    expect((await archive.host.importHistory("whatsapp-db", iphone)).counts.messages).toMatchObject({ added: 0, updated: 6 });
    expect(count()).toEqual([{ type: "call", n: 11 }, { type: "other", n: 1 }]);
    archive.people.runRules();
    expect(calls("Ada Sample")).toHaveLength(5);
  });

  it("never adds a call again from the Mac app's copy, whichever table the iPhone's copy put it in", async () => {
    const iphone = exportAt("2026-09-28");
    await writeWhatsAppFixture(iphone, { calls: true });
    await archive.host.importHistory("whatsapp-db", iphone);
    const count = () => (archive.db.prepare("SELECT count(*) AS n FROM message WHERE platform = 'whatsapp' AND type = 'call'").get() as { n: number }).n;
    const callRows = () => archive.db.prepare("SELECT platform_call_id AS id, import_person_id AS person FROM call ORDER BY id, person").all();
    const [records, inNoChat] = [count(), callRows()];
    // By its Calls tab alone, as a Mac copy was read before: Cleo's call (a call record here) as a three-way call, and
    // the three-way call (a call in no chat here) as a call record in Ada's chat. Neither is added; only the Mac's own call is.
    const folder = exportAt("mac");
    await writeWhatsAppFixture(folder, { copy: "mac", calls: true, macApp: true });
    const mac = await archive.host.importHistory("whatsapp-db", folder);
    expect(mac.counts.calls).toMatchObject({ added: 0 });
    expect(count()).toBe(records + 1);
    expect(callRows()).toEqual(inNoChat);
    expect(archive.db.prepare("SELECT count(*) AS n FROM message WHERE platform_message_id IN (?, ?)").get(WA_CALLS.adHoc, WA_CALLS.macEvening)).toEqual({ n: 1 });
  });

  it("imports the Mac app's calls alone, adding only the calls the archive lacks, and nothing on a second run", async () => {
    const iphone = exportAt("2026-09-28");
    await writeWhatsAppFixture(iphone, { calls: true });
    await archive.host.importHistory("whatsapp-db", iphone);
    const folder = exportAt("mac");
    await writeWhatsAppFixture(folder, { copy: "mac", calls: true, macApp: true });
    const bridgeDb = join(dir, "mautrix-whatsapp.db");
    writeBridgeLidMap(bridgeDb);
    const settings = { only: "calls", callsFrom: "chats", bridgeDb };
    const first = await archive.host.importHistory("whatsapp-db", folder, { settings });
    // Its own call is added, and the call whose record said nothing more of it takes its length from the Mac's Calls tab.
    expect(first.counts.messages).toMatchObject({ added: 1, updated: 1, unchanged: 6 });
    const length = (id: string) => (archive.db.prepare("SELECT call_seconds AS s FROM message WHERE platform_message_id = ?").get(id) as { s: number | null }).s;
    expect(length(WA_CALLS.adaBare)).toBe(61);
    expect(first.counts.calls).toEqual({ added: 0, updated: 0, unchanged: 2 });
    // The chats and people the calls are with are the archive's already, and their names and titles stay as they are.
    expect(first.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(first.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(first.counts.coverageSpans).toBe(0);
    const again = await archive.host.importHistory("whatsapp-db", folder, { settings });
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0 });
    expect(again.counts.calls).toMatchObject({ added: 0, updated: 0 });
    archive.people.runRules();
    const ada = archive.structure.listPeople().people.find((p) => p.name === "Ada Sample")!;
    expect(callsOf(archive.db, ada.id).map((c) => [c.at, c.direction, c.durationSeconds])).toContainEqual(
      [Date.parse("2026-09-22T20:45:00+10:00"), "outgoing", 300],
    );
  });

  it("counts no system message as talking, and joins WhatsApp people with Messenger people of the same name", async () => {
    await archive.host.importHistory("whatsapp-db", await fixture());
    archive.people.runRules();
    const ada = archive.structure.listPeople().people.find((p) => p.name === "Ada Sample")!;
    // 16 messages in the chat, less the "security code changed" notice; one group message.
    expect(ada).toMatchObject({ directMessageCount: 15, groupMessageCount: 1 });
    const relationship = archive.structure.relationships().people.find((p) => p.id === ada.id)!;
    expect(relationship.totals).toEqual({ directFromMe: 7, directFromThem: 8, directFromMeSelfOnly: 0, groupFromMe: 1, groupFromThem: 1 });

    await archive.host.setEnabled("messenger-export", true);
    await archive.host.importHistory("messenger-export", await sampleMessengerExport(dataDir));
    archive.people.runRules();
    const joined = archive.structure.listPeople().people.filter((p) => p.joined).map((p) => p.accounts.map((a) => `${a.platform}:${a.displayName}`).sort());
    expect(joined).toContainEqual(["messenger:Ada Sample", "whatsapp:Ada Sample"]);
    expect(joined).toContainEqual(["messenger:Bruno Placeholder", "whatsapp:Bruno Placeholder"]);
    expect(archive.structure.coverage().platforms.find((p) => p.platform === "whatsapp")!.spans).toEqual([
      { from: Date.parse("2024-05-01T10:00:00+10:00"), to: Date.parse("2026-09-21T09:25:00+10:00"), kind: "app-db" },
    ]);
  });
});
