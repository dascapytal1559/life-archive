import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../../testing/archive.ts";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportSession } from "../../server/write.ts";
import { type ConnectorEvent, transaction } from "../../../../sdk/server.ts";
import {
  SIGNAL_ADA, SIGNAL_BIG_GROUP, SIGNAL_BRUNO, SIGNAL_CLEO, SIGNAL_CROWD, SIGNAL_DEV, SIGNAL_ESME, SIGNAL_GIF, SIGNAL_PHOTO,
  SIGNAL_SAMPLE, SIGNAL_SMALL_GROUP, signalAt, signalExportFrames, writeSignalExport,
} from "../../fixtures/signal-export.ts";
import { readSignalExport, SELF_KEY } from "./read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-signal-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(source: string) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readSignalExport({ sources: [source], config: {}, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, mediaDir };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ADA = SIGNAL_ADA.aci.uuid;
const BRUNO = SIGNAL_BRUNO.aci.uuid;

describe("signal-export", () => {
  it("reads the captain, one-to-one and group chats, reactions and attachments", async () => {
    const folder = join(dir, "signal-export-2025-02-01-10-00-00");
    await writeSignalExport(folder);
    const { of, mediaDir } = await read(folder);

    const accounts = of("account");
    expect(accounts.filter((a) => a.isSelf)).toEqual([
      { kind: "account", key: SELF_KEY, keyKind: "id", displayName: "Sample Captain", handle: "sample.01", nameSource: "export", isSelf: true },
    ]);
    const byKey = new Map(accounts.map((a) => [a.key, a]));
    // Keyed on their ACI; named as Signal names them, with their number as their handle.
    expect(byKey.get(ADA)).toEqual({ kind: "account", key: ADA, keyKind: "id", displayName: SIGNAL_ADA.name, nameSource: "addressBook", handle: SIGNAL_ADA.phone });
    expect(byKey.get(BRUNO)).toMatchObject({ displayName: SIGNAL_BRUNO.name, nameSource: "profile", handle: SIGNAL_BRUNO.phone });
    expect(byKey.get(SIGNAL_CLEO.aci.uuid)).toMatchObject({ displayName: SIGNAL_CLEO.phone, nameSource: "phone", handle: SIGNAL_CLEO.phone });
    expect(byKey.get(SIGNAL_DEV.aci.uuid)).toMatchObject({ displayName: SIGNAL_DEV.name, nameSource: "nickname" });
    expect(byKey.get(SIGNAL_ESME.aci.uuid)).toMatchObject({ displayName: SIGNAL_ESME.name, nameSource: "profile" });
    // The captain's own id, in the group snapshots, is him, not someone else.
    expect(accounts).toHaveLength(1 + 5 + SIGNAL_CROWD.length);
    expect(accounts).toHaveLength(new Set(accounts.map((a) => a.key)).size);

    const conversations = of("conversation");
    expect(conversations.filter((c) => c.type === "direct")).toHaveLength(SIGNAL_SAMPLE.directChats);
    expect(conversations.filter((c) => c.type === "group")).toHaveLength(SIGNAL_SAMPLE.groupChats);
    const chat = new Map(conversations.map((c) => [c.id, c]));
    expect(chat.get(ADA)).toEqual({ kind: "conversation", id: ADA, type: "direct", title: SIGNAL_ADA.name, members: [ADA, SELF_KEY].sort() });
    expect(chat.get(SELF_KEY)).toEqual({ kind: "conversation", id: SELF_KEY, type: "direct", title: "Sample Captain", members: [SELF_KEY] });
    expect(chat.get(SIGNAL_SMALL_GROUP)).toMatchObject({
      type: "group", title: "Climbing crew", members: [SELF_KEY, ADA, SIGNAL_DEV.aci.uuid, SIGNAL_ESME.aci.uuid].sort(),
    });
    expect(chat.get(SIGNAL_BIG_GROUP)).toMatchObject({ type: "group", members: [SELF_KEY, ...SIGNAL_CROWD.map((c) => c.aci.uuid)].sort() });
    expect(chat.get(SIGNAL_BIG_GROUP)!.title).toBeUndefined();
    // The group's master key is never kept.
    expect(JSON.stringify(conversations)).not.toContain(Buffer.alloc(32, 7).toString("base64"));

    const messages = of("message");
    expect(messages).toHaveLength(SIGNAL_SAMPLE.messages);
    expect(messages.every((m) => m.idKind === "platform")).toBe(true);
    const message = new Map(messages.map((m) => [m.id, m]));
    const id = (conversation: string, author: string, at: number) => `${conversation}/${author}/${at}`;
    expect(message.get(id(ADA, ADA, signalAt(1)))).toMatchObject({ sender: ADA, isFromSelf: false, type: "text", text: "Hello on Signal", sentAt: signalAt(1) });
    // An edited message keeps its first sent time as its id, with its latest text.
    expect(message.get(id(ADA, SELF_KEY, signalAt(2)))).toMatchObject({ isFromSelf: true, text: "First", sentAt: signalAt(2), editedAt: signalAt(2, 3) });
    expect(message.get(id(ADA, SELF_KEY, signalAt(3)))).toMatchObject({ type: "media" });
    expect(message.get(id(ADA, SELF_KEY, signalAt(3)))!.text).toBeUndefined();
    // A quote replies to the message it names, by the same id.
    expect(message.get(id(ADA, ADA, signalAt(4)))).toMatchObject({ type: "link", text: "Look https://example.com/crag", replyTo: id(ADA, SELF_KEY, signalAt(2)) });
    expect(message.get(id(ADA, ADA, signalAt(4, 30)))).toMatchObject({ unsent: true });
    expect(message.get(`${ADA}/call/5551`)).toMatchObject({ type: "call", sender: SELF_KEY, isFromSelf: true, sentAt: signalAt(5) });
    // Signal's export does not say how long a call was, only whether it was answered: one that was not is 0 long.
    expect(message.get(`${ADA}/call/5551`)).not.toHaveProperty("callSeconds");
    expect(message.get(`${ADA}/call/5552`)).toMatchObject({ type: "call", sender: ADA, isFromSelf: false, sentAt: signalAt(5, 15), callSeconds: 0 });
    expect(message.get(id(BRUNO, BRUNO, signalAt(6)))).toMatchObject({ type: "sticker" });
    expect(message.get(id(SIGNAL_SMALL_GROUP, SIGNAL_ESME.aci.uuid, signalAt(8)))).toMatchObject({ type: "media" });
    expect(message.get(id(SELF_KEY, SELF_KEY, signalAt(10)))).toMatchObject({ text: "Remember the rope" });

    expect(of("reaction")).toEqual([
      { kind: "reaction", message: id(ADA, ADA, signalAt(1)), actor: SELF_KEY, emoji: "❤️", addedAt: signalAt(1, 1) },
      { kind: "reaction", message: id(BRUNO, BRUNO, signalAt(6)), actor: SELF_KEY, emoji: "😂", addedAt: signalAt(6, 2) },
    ]);

    const attachments = of("attachment");
    expect(attachments).toHaveLength(SIGNAL_SAMPLE.attachments);
    const [photo, voice] = attachments.filter((a) => a.message === id(ADA, SELF_KEY, signalAt(3)));
    expect(photo).toMatchObject({ ordinal: 0, type: "image", filename: "photo.jpg", mime: "image/jpeg" });
    // Kept where it is in the export's files/, and nothing is copied.
    expect(photo.inPlace).toMatchObject({ sha256: sha256(SIGNAL_PHOTO), size: SIGNAL_PHOTO.length });
    expect(photo.inPlace!.path.startsWith(`${folder}/files/`)).toBe(true);
    expect(await readFile(photo.inPlace!.path)).toEqual(SIGNAL_PHOTO);
    expect(voice).toEqual({ kind: "attachment", message: photo.message, ordinal: 1, type: "audio", mime: "audio/aac" });
    const gif = attachments.find((a) => a.message.startsWith(SIGNAL_SMALL_GROUP))!;
    expect(gif).toMatchObject({ type: "gif", mime: "video/mp4" });
    expect(await readFile(gif.inPlace!.path)).toEqual(SIGNAL_GIF);
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);

    const tallies = Object.fromEntries(of("tally").map((t) => [t.name, t.count]));
    expect(tallies).toEqual({
      "chat items in no chat the export lists": 1,
      "one-to-one chats with no messages (not imported)": 1,
      "chats that are not with a person or group, such as Signal's release notes": 1,
      "reactions without an emoji or by someone not in the export": 1,
      "messages edited on Signal (the export gives their latest text)": 1,
      "attachments not in the export": 1,
      "chat updates such as safety number, profile and timer changes (not kept as messages)": 1,
      "group changes (a group's members and name come from its snapshot; not kept as messages)": 1,
      "contacts in no chat (not imported)": 2,
    });
    // Coverage runs to the day the export was made.
    expect(of("coverage").at(-1)).toEqual({ kind: "coverage", from: signalAt(1), to: Date.UTC(2025, 1, 1) });
  });

  it("reads the same from main.jsonl and from a folder holding just the export", async () => {
    const folder = join(dir, "imports", "signal-export-2025-02-01-10-00-00");
    await writeSignalExport(folder);
    const summary = (events: ConnectorEvent[]) => events.filter((e) => e.kind !== "progress");
    const fromFolder = summary((await read(folder)).events);
    expect(summary((await read(join(folder, "main.jsonl"))).events)).toEqual(fromFolder);
    expect(summary((await read(join(dir, "imports"))).events)).toEqual(fromFolder);
  });

  it("refuses what is not a Signal export, saying why and never quoting it", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty);
    await expect(read(empty)).rejects.toThrow(/empty is not a Signal export: it has no main\.jsonl/);

    const two = join(dir, "two");
    await writeSignalExport(join(two, "a"));
    await writeSignalExport(join(two, "b"));
    await expect(read(two)).rejects.toThrow(/holds 2 Signal exports; name the one to import/);

    const other = join(dir, "other");
    await mkdir(other);
    await writeFile(join(other, "main.jsonl"), '{"secret": "private words"}\n');
    await expect(read(other)).rejects.toThrow(/is not a Signal export: its first line is not Signal's backup header/);

    const broken = join(dir, "broken");
    await mkdir(broken);
    const lines = signalExportFrames().map((f) => JSON.stringify(f));
    lines[3] = "private words";
    await writeFile(join(broken, "main.jsonl"), lines.join("\n"));
    const error = await read(broken).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/is not a Signal export: line 4 is not JSON/);
    expect((error as Error).message).not.toContain("private");

    await writeFile(join(dir, "notes.txt"), "private words");
    await expect(read(join(dir, "notes.txt"))).rejects.toThrow(/is not a Signal export: name its folder/);
  });
});

describe("signal-export through the archive", () => {
  let dataDir: string;
  let archive: TestArchive;

  beforeEach(async () => {
    dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("signal-export", true);
  });

  afterEach(() => archive.close());

  it("imports once: the same export again adds nothing, and a newer one only what is new", async () => {
    const folder = join(dataDir, "platform-exports", "signal", "2025-02-01");
    await writeSignalExport(folder);
    const first = await archive.host.importHistory("signal", folder);
    expect(first).toMatchObject({ connector: "signal-export", platform: "signal" });
    expect(first.counts.messages).toMatchObject({ added: SIGNAL_SAMPLE.messages, updated: 0, unchanged: 0, duplicates: 0 });
    expect(first.counts.conversations).toEqual({ added: SIGNAL_SAMPLE.directChats + SIGNAL_SAMPLE.groupChats, updated: 0 });
    expect(first.counts.reactions).toEqual({ added: SIGNAL_SAMPLE.reactions });
    expect(first.counts.attachments).toMatchObject({ added: SIGNAL_SAMPLE.attachments, stored: 2, missing: 1 });

    const again = await archive.host.importHistory("signal-export", folder);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: SIGNAL_SAMPLE.messages });
    expect(again.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(again.counts.reactions).toEqual({ added: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });

    const newer = join(dataDir, "platform-exports", "signal", "2025-03-01");
    await writeSignalExport(newer, { newer: true });
    const later = await archive.host.importHistory("signal-export", newer);
    expect(later.counts.messages).toMatchObject({ added: 1, updated: 1, unchanged: SIGNAL_SAMPLE.messages - 1 });
    expect(later.counts.accounts).toEqual({ added: 0, updated: 0 });
    const edited = archive.db
      .prepare("SELECT text, edited_at FROM message WHERE platform = 'signal' AND platform_message_id = ?")
      .get(`${BRUNO}/${SELF_KEY}/${signalAt(6)}`);
    expect(edited).toEqual({ text: "See you at six", edited_at: signalAt(6, 5) });
  });

  it("joins people known elsewhere by the name and phone rules, and leaves who stays on the map to the archive rules", async () => {
    // Ada and Bruno, from another platform's import: Ada by the same name, Bruno only by the same number.
    transaction(archive.db, () => {
      const source = Number(archive.db
        .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('imessage', 'test', 'export', 'test', 0, 'ok')")
        .run().lastInsertRowid);
      const session = new ImportSession(archive.db, "imessage", source, "export");
      session.apply({ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true });
      for (const [key, name] of [[SIGNAL_ADA.phone, SIGNAL_ADA.name], [SIGNAL_BRUNO.phone, "Bruno P"]]) {
        session.apply({ kind: "account", key, keyKind: "id", displayName: name, handle: key });
        session.apply({ kind: "conversation", id: key, type: "direct", members: ["me", key] });
        for (const [n, sender] of [key, "me"].entries()) {
          session.apply({
            kind: "message", id: `${key}-${n}`, idKind: "platform", conversation: key, sender, isFromSelf: sender === "me",
            sentAt: signalAt(1, n), type: "text", text: "hi", raw: {},
          });
        }
      }
    });
    const folder = join(dataDir, "platform-exports", "signal", "2025-02-01");
    await writeSignalExport(folder);
    await archive.host.importHistory("signal-export", folder);
    archive.people.runRules();

    const personOf = (platform: string, key: string) =>
      (archive.db.prepare("SELECT person_id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as { person_id: number }).person_id;
    expect(personOf("signal", ADA)).toBe(personOf("imessage", SIGNAL_ADA.phone));
    expect(archive.structure.proposals().find((p) => p.evidence.some((e) => e.rule === "phone-match"))?.people.map((p) => p.name).sort()).toEqual(["Bruno P", SIGNAL_BRUNO.name]);

    const people = archive.structure.listPeople().people;
    const byKey = (key: string) => people.find((p) => p.id === personOf("signal", key));
    expect(byKey(ADA)).toMatchObject({ name: SIGNAL_ADA.name, archived: null });
    expect(byKey(BRUNO)).toMatchObject({ archived: null });
    // Known only by a number: no name.
    expect(byKey(SIGNAL_CLEO.aci.uuid)).toMatchObject({ archived: "no-name" });
    // In the small group, Dev is kept though they never wrote, and Esme, who wrote only there.
    expect(byKey(SIGNAL_DEV.aci.uuid)).toMatchObject({ name: SIGNAL_DEV.name, archived: null });
    expect(byKey(SIGNAL_ESME.aci.uuid)).toMatchObject({ name: SIGNAL_ESME.name, archived: null });
    // In the group of fourteen, more than SMALL_GROUP_MAX, they are not.
    expect(byKey(SIGNAL_CROWD[0].aci.uuid)).toMatchObject({ archived: "groups-wrote" });
    expect(byKey(SIGNAL_CROWD[5].aci.uuid)).toMatchObject({ archived: "groups-silent" });
  });
});
