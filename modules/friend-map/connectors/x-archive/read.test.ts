import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../../testing/archive.ts";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unpackExport } from "../../server/platformExports.ts";
import {
  GROUP_GIF, PHOTO, X_ADA, X_BRUNO, X_CLEO, X_CROWD, X_DEV, X_ESME, X_SAMPLE, X_SELF,
  writeXArchiveFolder, writeXArchiveZip, xArchiveFiles, ytd,
} from "../../fixtures/x-archive.ts";
import { type ConnectorEvent, writeZip } from "../../../../sdk/server.ts";
import { parseDataFile, readXArchive } from "./read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-x-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An export's folder, where the captain keeps it: in the data folder the archive tests open (dir/data). */
const exportAt = (date: string) => join(dir, "data", "platform-exports", "x", date);

/** The archive's zip in its export folder, unpacked there as the captain keeps it, since it holds media. */
async function archiveAt(folder: string, options?: { split?: boolean }): Promise<string> {
  await mkdir(folder, { recursive: true });
  await writeXArchiveZip(join(folder, "twitter-2025-02-01-abc.zip"), options);
  await unpackExport(folder);
  return folder;
}

async function read(source: string) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readXArchive({ sources: [source], config: {}, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, mediaDir };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("parseDataFile", () => {
  it("reads the records of window.YTD.<name>.part<n> = [...]", () => {
    expect(parseDataFile(ytd("direct_messages", [{ a: 1 }], 2), "data/direct-messages-part2.js", "direct_messages")).toEqual([{ a: 1 }]);
    expect(parseDataFile(`﻿window.YTD.account.part0 = [];\n`, "data/account.js", "account")).toEqual([]);
  });

  it("says clearly when a file is not what X writes, naming the file and never quoting it", () => {
    expect(() => parseDataFile('{"secret": 1}', "data/direct-messages.js", "direct_messages"))
      .toThrow(/data\/direct-messages\.js is not an X archive data file: it does not start with window\.YTD\.direct_messages\.part<n> = \[\.\.\.\]/);
    expect(() => parseDataFile("window.YTD.tweets.part0 = []", "data/direct-messages.js", "direct_messages")).toThrow(/holds X's tweets data, not direct_messages/);
    expect(() => parseDataFile("window.YTD.account.part0 = [secret", "data/account.js", "account")).toThrow(/is not JSON/);
    expect(() => parseDataFile('window.YTD.account.part0 = {"secret": 1}', "data/account.js", "account")).toThrow(/is not a list/);
    try {
      parseDataFile('window.YTD.account.part0 = {"secret": 1}', "data/account.js", "account");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });
});

describe("x-archive", () => {
  it("reads the captain, one-to-one and group chats, reactions and media from the zip", async () => {
    const folder = await archiveAt(exportAt("2025-02-01"));
    const { of, mediaDir } = await read(folder);

    const accounts = of("account");
    expect(accounts.filter((a) => a.isSelf)).toEqual([
      { kind: "account", key: X_SELF.id, keyKind: "id", displayName: X_SELF.name, handle: `@${X_SELF.username}`, nameSource: "export", isSelf: true },
    ]);
    const byKey = new Map(accounts.map((a) => [a.key, a]));
    // Named by a tweet that mentions them, by a reply's @handle, or by nothing: then their id stands in.
    expect(byKey.get(X_ADA.id)).toMatchObject({ displayName: X_ADA.name, handle: `@${X_ADA.username}`, nameSource: "tweet" });
    expect(byKey.get(X_BRUNO.id)).toMatchObject({ displayName: `@${X_BRUNO.username}`, handle: `@${X_BRUNO.username}`, nameSource: "handle" });
    expect(byKey.get(X_CLEO.id)).toEqual({ kind: "account", key: X_CLEO.id, keyKind: "id", displayName: X_CLEO.id, nameSource: "none" });
    // Followers, following and people only mentioned in tweets are not accounts.
    expect(byKey.has("777")).toBe(false);
    expect(byKey.has("999")).toBe(false);
    expect(accounts).toHaveLength(new Set(accounts.map((a) => a.key)).size);

    const conversations = of("conversation");
    expect(conversations.filter((c) => c.type === "direct")).toHaveLength(X_SAMPLE.directChats);
    expect(conversations.filter((c) => c.type === "group")).toHaveLength(X_SAMPLE.groupChats);
    const chat = new Map(conversations.map((c) => [c.id, c]));
    expect(chat.get(`${X_SELF.id}-${X_ADA.id}`)).toEqual({ kind: "conversation", id: `${X_SELF.id}-${X_ADA.id}`, type: "direct", title: X_ADA.name, members: [X_SELF.id, X_ADA.id].sort() });
    expect(chat.get(`${X_SELF.id}-${X_CLEO.id}`)).toMatchObject({ title: X_CLEO.id });
    // A group has everyone its joins, leaves and messages name, and its latest name.
    expect(chat.get("5001")).toMatchObject({ type: "group", title: "Climbing crew", members: [X_SELF.id, X_ADA.id, X_DEV.id, X_ESME.id].sort() });
    expect(chat.get("5002")).toMatchObject({ type: "group", members: [X_SELF.id, ...X_CROWD].sort() });
    expect(chat.get("5002")!.title).toBeUndefined();

    const messages = of("message");
    expect(messages).toHaveLength(X_SAMPLE.messages);
    expect(messages.every((m) => m.idKind === "platform")).toBe(true);
    const message = new Map(messages.map((m) => [m.id, m]));
    expect(message.get("9001")).toMatchObject({ conversation: `${X_SELF.id}-${X_ADA.id}`, sender: X_ADA.id, isFromSelf: false, type: "text", text: "Welcome to X!", sentAt: Date.UTC(2025, 0, 1, 10) });
    // The t.co link X puts in the text for a photo goes; a link to a page stays.
    expect(message.get("9006")).toMatchObject({ sender: X_SELF.id, isFromSelf: true, type: "media", text: "Here it is" });
    expect(message.get("9005")).toMatchObject({ type: "link", text: "Look https://t.co/crag" });
    expect(message.get("9303")).toMatchObject({ conversation: "5001", sender: X_ESME.id, type: "media" });
    expect(message.get("9303")!.text).toBeUndefined();
    // Each chat's messages come oldest first.
    expect(messages.filter((m) => m.conversation === "5001").map((m) => m.id)).toEqual(["9301", "9302", "9303"]);

    expect(of("reaction")).toEqual([
      { kind: "reaction", message: "9001", actor: X_SELF.id, emoji: "❤️", addedAt: Date.UTC(2025, 0, 1, 10, 1) },
      { kind: "reaction", message: "9303", actor: X_DEV.id, emoji: "😂", addedAt: Date.UTC(2025, 0, 7, 10, 1) },
    ]);

    const attachments = of("attachment");
    expect(attachments).toHaveLength(X_SAMPLE.attachments);
    const photo = attachments.find((a) => a.message === "9006")!;
    expect(photo).toMatchObject({ ordinal: 0, type: "image", filename: "9006-photo1.jpg", mime: "image/jpeg" });
    // Kept where it is in the unpacked archive, and nothing is copied.
    expect(photo.inPlace).toEqual({ sha256: sha256(PHOTO), size: PHOTO.length, path: join(folder, "data/direct_messages_media/9006-photo1.jpg") });
    expect(await readFile(photo.inPlace!.path)).toEqual(PHOTO);
    const gif = attachments.find((a) => a.message === "9303")!;
    expect(gif).toMatchObject({ type: "gif", filename: "9303-party.mp4", mime: "video/mp4" });
    expect(await readFile(gif.inPlace!.path)).toEqual(GROUP_GIF);
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);
    expect(attachments.find((a) => a.message === "9004")).toEqual({ kind: "attachment", message: "9004", ordinal: 0, type: "image", filename: "lost.jpg", mime: "image/jpeg" });

    const tallies = Object.fromEntries(of("tally").map((t) => [t.name, t.count]));
    expect(tallies).toEqual({
      "group joins, leaves and renames (read for who is in a group and its name, not kept as messages)": 5,
      "messages edited on X (the archive gives their last text)": 1,
      "reactions without a sender or of a kind not known": 1,
      "media not in the archive": 1,
      "people named from the captain's tweets or replies": 3 + X_CROWD.length,
      "people known only by their X id": 2,
      "end-to-end-encrypted XChat messages (message-event.js), which cannot be read": 1,
    });
    // Coverage runs to the day the archive was made, and for the platform from the account's first day.
    expect(of("coverage").at(-1)).toEqual({ kind: "coverage", from: Date.UTC(2025, 0, 1, 10), to: Date.UTC(2025, 1, 1) });
  });

  it("reads the same from the unzipped folder, from a folder holding the zip and what it unpacked to, and from a chat file in parts; the zip itself, holding media, is refused", async () => {
    const holder = await archiveAt(exportAt("2025-02-01"));
    const fromHolder = await read(holder);
    const summary = (events: ConnectorEvent[]) => events.filter((e) => e.kind !== "progress")
      .map((e) => (e.kind === "attachment" && e.inPlace ? { ...e, inPlace: { ...e.inPlace, path: "" } } : e));

    const unzipped = join(dir, "twitter-2025-02-01-abc");
    await writeXArchiveFolder(unzipped);
    expect(summary((await read(unzipped)).events)).toEqual(summary(fromHolder.events));

    await expect(read(join(holder, "twitter-2025-02-01-abc.zip"))).rejects.toThrow(/holds them in a zip: put the export in data\/platform-exports\/x\/<export date>\//);

    const parts = await read(await archiveAt(exportAt("2025-02-02"), { split: true }));
    expect(parts.of("message").map((m) => m.id).sort()).toEqual(fromHolder.of("message").map((m) => m.id).sort());
    expect(parts.of("conversation")).toHaveLength(X_SAMPLE.directChats + X_SAMPLE.groupChats);
  });

  it("refuses what is not an X archive, saying why", async () => {
    const other = join(dir, "other.zip");
    await writeZip(other, [{ name: "data/tweets.js", data: ytd("tweets", []) }]);
    await expect(read(other)).rejects.toThrow(/other\.zip is not an X archive: it has no data\/account\.js/);

    const broken = join(dir, "broken.zip");
    await writeZip(broken, xArchiveFiles().map((f) => (f.name === "data/direct-messages.js" ? { ...f, data: '{"conversation": "private"}' } : f)));
    await expect(read(broken)).rejects.toThrow(/data\/direct-messages\.js is not an X archive data file/);

    const empty = join(dir, "empty");
    await mkdir(empty);
    await expect(read(empty)).rejects.toThrow(/has no data\/account\.js and no zip/);
    await writeFile(join(empty, "a.zip"), "");
    await writeFile(join(empty, "b.zip"), "");
    await expect(read(empty)).rejects.toThrow(/holds 2 zips; name the one to import/);
  });
});

describe("x-archive through the archive", () => {
  let dataDir: string;
  let archive: TestArchive;

  beforeEach(async () => {
    dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("x-archive", true);
  });

  afterEach(() => archive.close());

  it("imports once: the same archive again adds nothing", async () => {
    const zip = await archiveAt(exportAt("2025-02-01"));
    const first = await archive.host.importHistory("x", zip);
    expect(first).toMatchObject({ connector: "x-archive", platform: "x" });
    expect(first.counts.messages).toMatchObject({ added: X_SAMPLE.messages, updated: 0, unchanged: 0, duplicates: 0 });
    expect(first.counts.conversations).toEqual({ added: X_SAMPLE.directChats + X_SAMPLE.groupChats, updated: 0 });
    expect(first.counts.reactions).toEqual({ added: X_SAMPLE.reactions });
    expect(first.counts.attachments).toMatchObject({ added: X_SAMPLE.attachments, stored: 2, missing: 1 });

    const again = await archive.host.importHistory("x-archive", zip);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: X_SAMPLE.messages });
    expect(again.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(again.counts.reactions).toEqual({ added: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });
  });

  it("leaves who stays on the map to the archive rules: no name, one-sided chats, and groups big and small", async () => {
    await archive.host.importHistory("x-archive", await archiveAt(exportAt("2025-02-01")));
    archive.people.runRules();
    const people = archive.structure.listPeople().people;
    const personOf = (key: string) =>
      (archive.db.prepare("SELECT person_id FROM import_person WHERE platform = 'x' AND key = ?").get(key) as { person_id: number }).person_id;
    const byKey = (key: string) => people.find((p) => p.id === personOf(key));

    // Ada wrote and was written to: on the map.
    expect(byKey(X_ADA.id)).toMatchObject({ name: X_ADA.name, archived: null });
    // Known only by their id: no name.
    expect(byKey(X_CLEO.id)).toMatchObject({ archived: "no-name" });
    // Known only by the @handle a reply gave, which is a name: archived only because they alone wrote.
    expect(byKey(X_BRUNO.id)).toMatchObject({ name: `@${X_BRUNO.username}`, archived: "they-only" });
    // In a group of five (the captain, Ada, Dev, Esme), Dev is kept though they never wrote, and Esme, who
    // wrote there and nowhere else. In the group of fourteen, more than SMALL_GROUP_MAX, they are not.
    expect(byKey(X_DEV.id)).toMatchObject({ name: X_DEV.name, archived: null });
    expect(byKey(X_ESME.id)).toMatchObject({ archived: "no-name" });
    expect(byKey(X_CROWD[0])).toMatchObject({ name: "Crowd Member 1", archived: "groups-wrote" });
    expect(byKey(X_CROWD[5])).toMatchObject({ name: "Crowd Member 6", archived: "groups-silent" });
  });
});
