import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../../testing/archive.ts";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unpackExport } from "../../server/platformExports.ts";
import { type ConnectorEvent, transaction, writeZip } from "../../../../sdk/server.ts";
import { ImportSession } from "../../server/write.ts";
import {
  ATTACHMENTS, CHANNELS, DISCORD_ADA, DISCORD_BRUNO, DISCORD_CLEO, DISCORD_CROWD, DISCORD_DEV, DISCORD_ESME, DISCORD_SAMPLE,
  DISCORD_SELF, GUILD, MESSAGES, PHOTO, discordAt, discordPackageFiles, writeDiscordPackageFolder, writeDiscordPackageZip,
} from "../../fixtures/discord-package.ts";
import { readDiscordPackage, snowflakeTime } from "./read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-discord-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(source: string, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readDiscordPackage({ sources: [source], config, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, mediaDir };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** An export's folder, where the captain keeps it: in the data folder the archive tests open (dir/data). */
const exportAt = (date: string) => join(dir, "data", "platform-exports", "discord", date);

/** The package's zip in its export folder, unpacked there as the captain keeps it, since it holds a photo. */
async function packageAt(folder: string, options: Parameters<typeof writeDiscordPackageZip>[1] = {}): Promise<string> {
  await mkdir(folder, { recursive: true });
  await writeDiscordPackageZip(join(folder, "package.zip"), options);
  await unpackExport(folder);
  return folder;
}

describe("discord-package", () => {
  it("reads the captain's own messages in DMs, group DMs and server channels from the unpacked package", async () => {
    const folder = await packageAt(exportAt("2026-10-05"));
    const { of, mediaDir } = await read(folder);

    // The captain is the one recipient of every DM and group DM.
    const accounts = of("account");
    expect(accounts.filter((a) => a.isSelf)).toEqual([
      { kind: "account", key: DISCORD_SELF.id, keyKind: "id", displayName: "Me", nameSource: "none", isSelf: true },
    ]);
    const byKey = new Map(accounts.map((a) => [a.key, a]));
    // Named by Discord's label for a DM with them: their username, which is their handle too.
    expect(byKey.get(DISCORD_ADA.id)).toEqual({ kind: "account", key: DISCORD_ADA.id, keyKind: "id", displayName: DISCORD_ADA.username, handle: DISCORD_ADA.username, nameSource: "handle" });
    // A deleted account, which Discord writes as "Deleted User", is keyed by that name, as Messenger's "Facebook user" is.
    expect(byKey.get(DISCORD_CLEO.id)).toEqual({ kind: "account", key: "Deleted User", keyKind: "name", displayName: "Deleted User", nameSource: "none" });
    // In a group DM only: known by their id.
    expect(byKey.get(DISCORD_ESME.id)).toEqual({ kind: "account", key: DISCORD_ESME.id, keyKind: "id", displayName: DISCORD_ESME.id, nameSource: "none" });
    expect(accounts).toHaveLength(new Set(accounts.map((a) => a.key)).size);
    expect(accounts).toHaveLength(1 + 5 + DISCORD_CROWD.length);

    const conversations = of("conversation");
    expect(conversations.filter((c) => c.type === "direct")).toHaveLength(DISCORD_SAMPLE.directChats);
    expect(conversations.filter((c) => c.type === "group")).toHaveLength(DISCORD_SAMPLE.groupChats);
    // Every chat holds only the captain's side.
    expect(conversations.every((c) => c.selfOnly === true)).toBe(true);
    const chat = new Map(conversations.map((c) => [c.id, c]));
    expect(chat.get(CHANNELS.ada)).toEqual({
      kind: "conversation", id: CHANNELS.ada, type: "direct", title: DISCORD_ADA.username, members: [DISCORD_SELF.id, DISCORD_ADA.id].sort(), selfOnly: true,
    });
    // A channel type written as a number, as older packages do, reads the same.
    expect(chat.get(CHANNELS.bruno)).toMatchObject({ type: "direct", members: [DISCORD_SELF.id, DISCORD_BRUNO.id].sort() });
    expect(chat.get(CHANNELS.smallGroup)).toMatchObject({ type: "group", title: "Climbing crew", members: [DISCORD_SELF.id, DISCORD_ADA.id, DISCORD_DEV.id, DISCORD_ESME.id].sort() });
    expect(chat.get(CHANNELS.bigGroup)).toMatchObject({ type: "group", members: [DISCORD_SELF.id, ...DISCORD_CROWD.map((c) => c.id)].sort() });
    expect(chat.get(CHANNELS.bigGroup)!.title).toBeUndefined();
    // A server channel names no one but the captain, and is titled as Discord labels it.
    expect(chat.get(CHANNELS.general)).toMatchObject({ type: "group", title: `general, ${GUILD.name}`, members: [DISCORD_SELF.id] });
    expect(chat.get(CHANNELS.unknownChannel)).toMatchObject({ type: "group", title: "Unknown channel, Other Server", members: [DISCORD_SELF.id] });

    const messages = of("message");
    expect(messages).toHaveLength(DISCORD_SAMPLE.messages);
    expect(messages.every((m) => m.idKind === "platform" && m.sender === DISCORD_SELF.id && m.isFromSelf)).toBe(true);
    const message = new Map(messages.map((m) => [m.id, m]));
    // Ids too big for a double are kept exactly, and give the time sent to the millisecond.
    expect(BigInt(MESSAGES.adaText)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(message.get(MESSAGES.adaText)).toMatchObject({ conversation: CHANNELS.ada, sentAt: discordAt(2), type: "text", text: "Climbing on Saturday?" });
    expect(message.get(MESSAGES.adaLink)).toMatchObject({ type: "link", text: "This crag https://example.com/crag" });
    expect(message.get(MESSAGES.adaPhoto)).toMatchObject({ type: "media" });
    expect(message.get(MESSAGES.adaPhoto)!.text).toBeUndefined();
    expect(message.get(MESSAGES.adaCall)).toMatchObject({ type: "other" });
    expect(message.get(MESSAGES.adaText)!.raw).toMatchObject({ ID: MESSAGES.adaText, Timestamp: "2025-01-02 10:00:00" });
    // Oldest first, though Discord writes them newest first.
    expect(messages.filter((m) => m.conversation === CHANNELS.ada).map((m) => m.id)).toEqual([MESSAGES.adaText, MESSAGES.adaLink, MESSAGES.adaPhoto, MESSAGES.adaCall]);

    const attachments = of("attachment");
    expect(attachments).toHaveLength(DISCORD_SAMPLE.attachments);
    const photo = attachments.find((a) => a.message === MESSAGES.adaPhoto)!;
    expect(photo).toMatchObject({ ordinal: 0, type: "image", filename: "photo.png", mime: "image/png", platformAttachmentId: ATTACHMENTS.photo.id });
    // Kept where it is in the unpacked package, and nothing is copied.
    expect(photo.inPlace).toEqual({ sha256: sha256(PHOTO), size: PHOTO.length, path: join(folder, `Messages/c${CHANNELS.ada}/${ATTACHMENTS.photo.id}/photo.png`) });
    expect(await readFile(photo.inPlace!.path)).toEqual(PHOTO);
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);
    expect(attachments.find((a) => a.message === MESSAGES.general2)).toEqual({
      kind: "attachment", message: MESSAGES.general2, ordinal: 0, type: "file", filename: ATTACHMENTS.lost.filename, mime: "application/pdf", platformAttachmentId: ATTACHMENTS.lost.id,
    });

    expect(of("reaction")).toEqual([]);
    const tallies = Object.fromEntries(of("tally").map((t) => [t.name, t.count]));
    expect(tallies).toEqual({
      "people known only by their username (Discord's label for a DM with them)": 2,
      "chats with a deleted account (Discord writes \"Deleted User\" for its id)": 1,
      "people known only by their Discord id (in a group DM, never in a DM)": 2 + DISCORD_CROWD.length,
      "server channels (the package names no one but the captain in them)": 2,
      "messages with neither text nor an attachment (a call, a sticker, an embed or the like; the package says no more)": 1,
      "attachments not in the package (Discord gives only a link to its servers)": 1,
    });
    expect(of("coverage").at(-1)).toEqual({ kind: "coverage", from: discordAt(2), to: discordAt(8) });
    expect(snowflakeTime(MESSAGES.general2)).toBe(discordAt(7, 1));
  });

  it("names people and the captain from the Account section when the package has it", async () => {
    const { of } = await read(await packageAt(exportAt("2026-10-05"), { account: true }));
    const byKey = new Map(of("account").map((a) => [a.key, a]));
    expect(byKey.get(DISCORD_SELF.id)).toMatchObject({ displayName: DISCORD_SELF.globalName, handle: DISCORD_SELF.username, nameSource: "export", isSelf: true });
    expect(byKey.get(DISCORD_ADA.id)).toMatchObject({ displayName: DISCORD_ADA.globalName, handle: DISCORD_ADA.username, nameSource: "profile" });
    expect(byKey.get(DISCORD_BRUNO.id)).toMatchObject({ displayName: DISCORD_BRUNO.nickname, handle: DISCORD_BRUNO.username, nameSource: "nickname" });
    expect(byKey.get(DISCORD_DEV.id)).toMatchObject({ displayName: DISCORD_DEV.globalName, nameSource: "profile" });
    expect(of("conversation").find((c) => c.id === CHANNELS.ada)).toMatchObject({ title: DISCORD_ADA.globalName });
  });

  it("reads the same from the unzipped folder and from a folder holding the zip and what it unpacked to; the zip itself, holding a photo, is refused", async () => {
    const holder = await packageAt(exportAt("2026-10-05"));
    const fromHolder = await read(holder);
    const summary = (events: ConnectorEvent[]) => events.filter((e) => e.kind !== "progress")
      .map((e) => (e.kind === "attachment" && e.inPlace ? { ...e, inPlace: { ...e.inPlace, path: "" } } : e));

    const unzipped = join(dir, "package");
    await writeDiscordPackageFolder(unzipped);
    expect(summary((await read(unzipped)).events)).toEqual(summary(fromHolder.events));

    await expect(read(join(holder, "package.zip"))).rejects.toThrow(/package\.zip holds them in a zip: put the export in data\/platform-exports\/discord\/<export date>\//);
  });

  it("refuses what is not a Discord data package, saying why and never quoting it", async () => {
    const other = join(dir, "other.zip");
    await writeZip(other, [{ name: "data/account.js", data: "private words" }]);
    await expect(read(other)).rejects.toThrow(/other\.zip is not a Discord data package: it has no Messages\/index\.json/);

    const broken = join(dir, "broken.zip");
    await writeZip(broken, discordPackageFiles().map((f) => (f.name === `Messages/c${CHANNELS.ada}/messages.json` ? { ...f, data: "private words" } : f)));
    const error = await read(broken).catch((e: Error) => e);
    expect((error as Error).message).toMatch(new RegExp(`Messages/c${CHANNELS.ada}/messages\\.json is not a Discord data package file: it is not JSON`));
    expect((error as Error).message).not.toContain("private");

    const older = join(dir, "older.zip");
    await writeZip(older, discordPackageFiles().map((f) =>
      f.name === `Messages/c${CHANNELS.ada}/messages.json` ? { name: `Messages/c${CHANNELS.ada}/messages.csv`, data: "ID,Timestamp,Contents,Attachments\n" } : f));
    await expect(read(older)).rejects.toThrow(/messages\.csv is an older Discord data package's, which is not read/);

    const empty = join(dir, "empty");
    await mkdir(empty);
    await expect(read(empty)).rejects.toThrow(/has no Messages\/index\.json and no zip/);
    await writeFile(join(empty, "a.zip"), "");
    await writeFile(join(empty, "b.zip"), "");
    await expect(read(empty)).rejects.toThrow(/holds 2 zips; name the one to import/);
  });

  it("asks for selfId when no one recipient is in every DM", async () => {
    const onlyAda = join(dir, "only-ada.zip");
    // Without the photo, so the zip can be read as it is.
    const keep = (name: string) => (!name.startsWith("Messages/c") || name.startsWith(`Messages/c${CHANNELS.ada}/`)) && !name.endsWith("/photo.png");
    await writeZip(onlyAda, discordPackageFiles().filter((f) => keep(f.name)));
    await expect(read(onlyAda)).rejects.toThrow(/set selfId \(his user id\) in data\/connectors\/discord-package\.json/);
    const { of } = await read(onlyAda, { selfId: DISCORD_SELF.id });
    expect(of("account").find((a) => a.isSelf)?.key).toBe(DISCORD_SELF.id);
  });
});

describe("discord-package through the archive", () => {
  let dataDir: string;
  let archive: TestArchive;

  beforeEach(async () => {
    dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("discord-package", true);
  });

  afterEach(() => archive.close());

  it("imports once: the same package again adds nothing, and a newer one only what is new", async () => {
    const zip = await packageAt(exportAt("2026-10-05"));
    const first = await archive.host.importHistory("discord", zip);
    expect(first).toMatchObject({ connector: "discord-package", platform: "discord" });
    expect(first.counts.messages).toMatchObject({ added: DISCORD_SAMPLE.messages, updated: 0, unchanged: 0, duplicates: 0 });
    expect(first.counts.conversations).toEqual({ added: DISCORD_SAMPLE.directChats + DISCORD_SAMPLE.groupChats, updated: 0 });
    expect(first.counts.attachments).toMatchObject({ added: DISCORD_SAMPLE.attachments, stored: 1, missing: 1 });
    expect(archive.db.prepare("SELECT count(*) AS n FROM conversation WHERE platform = 'discord' AND is_self_only = 1").get()).toEqual({ n: 7 });

    const again = await archive.host.importHistory("discord-package", zip);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: DISCORD_SAMPLE.messages });
    expect(again.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });

    const newer = await packageAt(exportAt("2026-11-05"), { newer: true });
    const later = await archive.host.importHistory("discord-package", newer);
    expect(later.counts.messages).toMatchObject({ added: 2, updated: 0, unchanged: DISCORD_SAMPLE.messages });
    expect(later.counts.conversations).toEqual({ added: 1, updated: 0 });
    expect(later.counts.accounts).toEqual({ added: 0, updated: 1 });
  });

  it("joins people known elsewhere, and never reads the others' silence as a one-sided chat", async () => {
    // Ada, from another platform's import, by the same name; and a one-sided chat there, which stays one-sided.
    transaction(archive.db, () => {
      const source = Number(archive.db
        .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('imessage', 'test', 'export', 'test', 0, 'ok')")
        .run().lastInsertRowid);
      const session = new ImportSession(archive.db, "imessage", source, "export");
      session.apply({ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true });
      for (const [key, name, senders] of [["+61491571266", DISCORD_ADA.globalName, ["+61491571266", "me"]], ["+61491574118", "Fay Unanswered", ["me"]]] as const) {
        session.apply({ kind: "account", key, keyKind: "id", displayName: name, handle: key });
        session.apply({ kind: "conversation", id: key, type: "direct", members: ["me", key] });
        for (const [n, sender] of senders.entries()) {
          session.apply({
            kind: "message", id: `${key}-${n}`, idKind: "platform", conversation: key, sender, isFromSelf: sender === "me",
            sentAt: discordAt(1, n), type: "text", text: "hi", raw: {},
          });
        }
      }
    });
    await archive.host.importHistory("discord-package", await packageAt(exportAt("2026-10-05"), { account: true }));
    archive.people.runRules();

    const personOf = (platform: string, key: string) =>
      (archive.db.prepare("SELECT person_id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as { person_id: number }).person_id;
    expect(personOf("discord", DISCORD_ADA.id)).toBe(personOf("imessage", "+61491571266"));

    const people = archive.structure.listPeople().people;
    const byKey = (key: string, platform = "discord") => people.find((p) => p.id === personOf(platform, key));
    // Only the captain wrote in a DM with Bruno, but the package could not hold Bruno's side: on the map.
    expect(byKey(DISCORD_BRUNO.id)).toMatchObject({ name: DISCORD_BRUNO.nickname, archived: null });
    // Where the source would hold their side, the captain alone writing is one-sided as ever.
    expect(byKey("+61491574118", "imessage")).toMatchObject({ archived: "you-only" });
    expect(byKey(DISCORD_ADA.id)).toMatchObject({ name: DISCORD_ADA.globalName, archived: null });
    expect(byKey(DISCORD_CLEO.id)).toMatchObject({ archived: "unknown" });
    // In the small group DM the captain wrote in, Dev is kept; Esme, known only by an id, has no name.
    expect(byKey(DISCORD_DEV.id)).toMatchObject({ name: DISCORD_DEV.globalName, archived: null });
    expect(byKey(DISCORD_ESME.id)).toMatchObject({ archived: "no-name" });
    // In the group DM of fourteen, more than SMALL_GROUP_MAX, they are not.
    expect(byKey(DISCORD_CROWD[0].id)).toMatchObject({ name: DISCORD_CROWD[0].globalName, archived: "groups-silent" });
  });

  it("counts a username as a name, as X and Signal do", async () => {
    await archive.host.importHistory("discord-package", await packageAt(exportAt("2026-10-05")));
    archive.people.runRules();
    const person = archive.db.prepare("SELECT person_id FROM import_person WHERE platform = 'discord' AND key = ?").get(DISCORD_ADA.id) as { person_id: number };
    expect(archive.structure.listPeople().people.find((p) => p.id === person.person_id)).toMatchObject({ name: DISCORD_ADA.username, archived: null });
  });
});
