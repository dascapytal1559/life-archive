import { createHash } from "node:crypto";
import { openTestArchive, type TestArchive } from "../../testing/archive.ts";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConnectorEvent, transaction } from "../../../../sdk/server.ts";
import { ImportSession } from "../../server/write.ts";
import { IG, IG_SAMPLE, writeInstagramExport, writeInstagramZip } from "../../fixtures/instagram-dyi.ts";
import { SELF } from "../../fixtures/messenger.ts";
import { readInstagramDyi } from "./read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-instagram-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(source: string, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readInstagramDyi({ sources: [source], config, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, mediaDir };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("instagram-dyi", () => {
  it("reads the unpacked export's inbox and message requests, keeping media where they are", async () => {
    const folder = join(dir, "2026-10-05");
    await writeInstagramExport(folder);
    const { of, mediaDir } = await read(folder);

    const conversations = of("conversation");
    expect(conversations).toHaveLength(IG_SAMPLE.chats);
    const byId = Object.fromEntries(conversations.map((c) => [c.id.slice(-1), c]));
    // Names are decoded from Meta's escaping.
    expect(byId[2]).toMatchObject({ type: "direct", title: IG.cleo, members: [IG.cleo, SELF] });
    expect(byId[3]).toMatchObject({ type: "direct", title: IG.username });
    // Two people in a chat with an invite link are a group, as are the others with one.
    expect(byId[5]).toMatchObject({ type: "group", title: "Climbing", members: [IG.crew[0], SELF] });
    expect(byId[6]).toMatchObject({ type: "group", title: "Crew" });
    expect(byId[7]).toMatchObject({ type: "group", title: "Giveaway" });
    // Message requests are chats like any other.
    expect(byId[8]).toMatchObject({ type: "direct", title: IG.stranger });
    // Instagram has no Marketplace.
    expect(conversations.some((c) => c.marketplace)).toBe(false);

    const accounts = of("account");
    expect(accounts.filter((a) => a.isSelf).map((a) => a.key)).toEqual([SELF]);
    expect(accounts.find((a) => a.displayName === "Instagram User")!.key).toMatch(/^Instagram User #[0-9a-f]{8}$/);

    const messages = of("message");
    expect(messages).toHaveLength(IG_SAMPLE.messages);
    expect(new Set(messages.map((m) => m.id)).size).toBe(IG_SAMPLE.messages);
    expect(messages.find((m) => m.text === "Saw your story 🎉")).toMatchObject({ sender: IG.ada, isFromSelf: false, type: "text" });
    expect(messages.filter((m) => m.type === "link")).toHaveLength(1);
    expect(messages.filter((m) => m.type === "call").map((m) => m.callSeconds)).toEqual([60]);
    expect(messages.filter((m) => m.unsent)).toHaveLength(1);
    expect(of("reaction")).toEqual([expect.objectContaining({ actor: SELF, emoji: "❤" })]);

    const attachments = of("attachment");
    expect(attachments.map((a) => [a.filename, a.type, a.mime, a.inPlace !== undefined]).sort()).toEqual([
      ["1001.jpg", "image", "image/jpeg", true],
      ["1002.aac", "audio", "audio/aac", true],
      ["2001.mp4", "video", "video/mp4", true],
      ["2002.jpg", "image", "image/jpeg", false],
      ["2003.jpg", "image", "image/jpeg", false],
    ]);
    // Each file is pointed at where it lies, hashed, and nothing is copied.
    expect(attachments.every((a) => a.stored === undefined)).toBe(true);
    for (const { inPlace } of attachments) {
      if (!inPlace) continue;
      expect(inPlace.path.startsWith(`${folder}/your_instagram_activity/messages/inbox/`)).toBe(true);
      const bytes = await readFile(inPlace.path);
      expect([inPlace.sha256, inPlace.size]).toEqual([sha256(bytes), bytes.length]);
    }
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);

    expect(Object.fromEntries(of("tally").map((t) => [t.name, t.count]))).toEqual({
      "media not in the export": 1,
      "media only linked, not in the export": 1,
    });
  });

  it("gives the same ids when the export is read again", async () => {
    const folder = join(dir, "2026-10-05");
    await writeInstagramExport(folder);
    const first = (await read(folder)).of("message").map((m) => m.id);
    expect((await read(folder)).of("message").map((m) => m.id)).toEqual(first);
  });

  it("refuses the zip, since its media would have nowhere to stay", async () => {
    const zip = join(dir, "instagram.zip");
    await writeInstagramZip(zip);
    await expect(read(zip)).rejects.toThrow(/holds them in a zip: put the export in data\/platform-exports\/instagram\/<export date>\/, unpack it there/);
  });
});

describe("instagram-dyi through the archive", () => {
  let dataDir: string;
  let archive: TestArchive;
  const exportFolder = () => join(dataDir, "platform-exports", "instagram", "2026-10-05");

  beforeEach(async () => {
    dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("instagram-dyi", true);
  });

  afterEach(() => archive.close());

  it("imports once, pointing at the media in the export, and the same export again adds nothing", async () => {
    await writeInstagramExport(exportFolder());
    const first = await archive.host.importHistory("instagram", exportFolder());
    expect(first).toMatchObject({ connector: "instagram-dyi", platform: "instagram" });
    expect(first.counts.messages).toMatchObject({ added: IG_SAMPLE.messages, duplicates: 0 });
    expect(first.counts.attachments).toMatchObject({ added: IG_SAMPLE.attachments, stored: IG_SAMPLE.kept, missing: 2 });
    const paths = (archive.db.prepare("SELECT local_path AS path FROM attachment WHERE local_path IS NOT NULL ORDER BY path").all() as { path: string }[])
      .map((row) => row.path);
    expect(paths).toEqual([
      "platform-exports/instagram/2026-10-05/your_instagram_activity/messages/inbox/adasample_17840000000000001/audio/1002.aac",
      "platform-exports/instagram/2026-10-05/your_instagram_activity/messages/inbox/adasample_17840000000000001/photos/1001.jpg",
      "platform-exports/instagram/2026-10-05/your_instagram_activity/messages/inbox/cleoexample_17840000000000002/videos/2001.mp4",
    ]);
    // Nothing is copied into the archive's media folder.
    expect(await readdir(join(dataDir, "archive", "media")).catch(() => [])).toEqual([]);
    // The file is served from the export.
    const photo = archive.db.prepare("SELECT id FROM attachment WHERE filename = '1001.jpg'").get() as { id: number };
    const file = await archive.content.attachmentFile(photo.id);
    expect(file).toMatchObject({ mime: "image/jpeg", path: await realpath(join(exportFolder(), "your_instagram_activity/messages/inbox/adasample_17840000000000001/photos/1001.jpg")) });

    const again = await archive.host.importHistory("instagram-dyi", exportFolder());
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: IG_SAMPLE.messages });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });
  });

  it("refuses an export unpacked outside data/platform-exports/, leaving the archive as it was", async () => {
    const outside = join(dir, "elsewhere");
    await writeInstagramExport(outside);
    await expect(archive.host.importHistory("instagram-dyi", outside)).rejects.toThrow(/must be inside .*platform-exports/);
    expect(archive.db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 0 });
  });

  it("joins people known elsewhere by name, and archives by the usual rules", async () => {
    // Ada from Messenger, by the same name.
    transaction(archive.db, () => {
      const source = Number(archive.db
        .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
        .run().lastInsertRowid);
      const session = new ImportSession(archive.db, "messenger", source, "export");
      session.apply({ kind: "account", key: SELF, keyKind: "name", displayName: SELF, isSelf: true });
      session.apply({ kind: "account", key: IG.ada, keyKind: "name", displayName: IG.ada });
      session.apply({ kind: "conversation", id: "ada", type: "direct", members: [SELF, IG.ada] });
      for (const [n, sender] of [IG.ada, SELF].entries()) {
        session.apply({ kind: "message", id: `ada-${n}`, idKind: "synthetic", conversation: "ada", sender, isFromSelf: sender === SELF, sentAt: 1_500_000_000_000 + n, type: "text", text: "hi", raw: {} });
      }
    });
    await writeInstagramExport(exportFolder());
    await archive.host.importHistory("instagram-dyi", exportFolder());
    archive.people.runRules();

    const personOf = (platform: string, name: string) =>
      (archive.db.prepare("SELECT person_id FROM import_person WHERE platform = ? AND display_name = ?").get(platform, name) as { person_id: number }).person_id;
    expect(personOf("instagram", IG.ada)).toBe(personOf("messenger", IG.ada));
    // The captain's Instagram account is the captain.
    expect(archive.db.prepare("SELECT is_self FROM import_person WHERE platform = 'instagram' AND key = ?").get(SELF)).toEqual({ is_self: 1 });

    const people = archive.structure.listPeople().people;
    const on = (name: string) => people.find((p) => p.id === personOf("instagram", name));
    expect(on(IG.ada)).toMatchObject({ archived: null });
    expect(on(IG.cleo)).toMatchObject({ archived: null });
    // A username is a name.
    expect(on(IG.username)).toMatchObject({ name: IG.username, archived: null });
    expect(on("Instagram User")).toMatchObject({ archived: "unknown" });
    // A small group the captain wrote in keeps its people, whether they wrote or not.
    expect(on(IG.crew[0])).toMatchObject({ archived: null });
    expect(on(IG.crew[1])).toMatchObject({ archived: null });
    // A big group he never wrote in keeps no one.
    expect(on(IG.crowd[0])).toMatchObject({ archived: "groups-wrote" });
    expect(on(IG.crowd[1])).toMatchObject({ archived: "groups-silent" });
    // A message request he never answered is one-sided; one he answered is a friend.
    expect(on(IG.stranger)).toMatchObject({ archived: "they-only" });
    expect(on(IG.answered)).toMatchObject({ archived: null });
  });
});
