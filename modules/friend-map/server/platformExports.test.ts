import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRegistry, type ConnectorHost } from "../../../sdk/testing.ts";
import { chatHost } from "../testing/host.ts";
import { type Db, writeZip, zipBytes } from "../../../sdk/server.ts";
import { exportFolder, unpackedExport } from "../fixtures/exports.ts";
import { rec, threadFile } from "../fixtures/facebook-dyi.ts";
import { SELF } from "../fixtures/messenger.ts";
import { openArchive } from "./db.ts";
import { moveImports, planImportsMove, relabelSources, unpackExport } from "./platformExports.ts";
import { applyRepoint, planRepoint, unreferencedCopies } from "./repoint.ts";
import { storageReport } from "./storage.ts";
import { ImportSession } from "./write.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-platform-exports-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function put(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

describe("unpackExport", () => {
  it("unpacks every zip at the top of the folder there, a zip stored inside a part too, and keeps the zips", async () => {
    await writeZip(join(dir, "part-1.zip"), [
      { name: "a/1.json", data: "{}" },
      { name: "a/photos/1.jpg", data: "photo one" },
      { name: "shared.txt", data: "first" },
      { name: "facebook_1.zip", data: zipBytes([{ name: "b/2.jpg", data: "photo two" }]), stored: true },
    ]);
    await writeZip(join(dir, "part-2.zip"), [{ name: "shared.txt", data: "second!" }, { name: "c/3.jpg", data: "photo three" }]);
    const counts = await unpackExport(dir);
    expect(counts).toEqual({ zips: 3, written: 5, writtenBytes: 2 + 9 + 5 + 9 + 11, present: 0, differ: 1 });
    expect(await readFile(join(dir, "a/photos/1.jpg"), "utf8")).toBe("photo one");
    expect(await readFile(join(dir, "b/2.jpg"), "utf8")).toBe("photo two");
    // A file two parts carry is the first part's.
    expect(await readFile(join(dir, "shared.txt"), "utf8")).toBe("first");
    expect((await readdir(dir)).sort()).toEqual(["a", "b", "c", "part-1.zip", "part-2.zip", "shared.txt"]);

    // Again: nothing is written over, and nothing is missing.
    await writeFile(join(dir, "a/1.json"), "{} ");
    expect(await unpackExport(dir)).toMatchObject({ written: 0, present: 4, differ: 2 });
    expect(await readFile(join(dir, "a/1.json"), "utf8")).toBe("{} ");
  });

  it("refuses an entry that would land outside the folder, and leaves no half-written file", async () => {
    await writeZip(join(dir, "evil.zip"), [{ name: "../outside.txt", data: "x" }]);
    await expect(unpackExport(dir)).rejects.toThrow(/outside the export's folder/);
    expect(await stat(join(dirname(dir), "outside.txt")).catch(() => null)).toBeNull();
  });
});

describe("moving data/imports/ into data/platform-exports/", () => {
  it("moves each <platform>-<date> folder whole, or its entries into an export folder already there, and relabels the imports from it", async () => {
    const data = join(dir, "data");
    await put(join(data, "imports/whatsapp-iphone-2026-09-28/ChatStorage.sqlite"), "db");
    await put(join(data, "imports/whatsapp-iphone-2026-09-28/Message/Media/a.jpg"), "a");
    await put(join(data, "imports/iphone-addressbook-2026-09-28/AddressBook.sqlitedb"), "ab");
    await put(join(data, "imports/instagram-2026-10-05/instagram-2026-10-05.zip"), "zip");
    await put(join(data, "platform-exports/instagram/2026-10-05/your_instagram_activity/x.json"), "{}");
    await put(join(data, "imports/discord-2026-10-05/package.zip"), "zip");
    await put(join(data, "platform-exports/discord/2026-10-05/package.zip"), "already");
    await put(join(data, "imports/notes/readme.txt"), "?");
    await put(join(data, "imports/.DS_Store"), "");

    const plan = await planImportsMove(data);
    expect(plan.moves).toEqual([
      { from: "imports/discord-2026-10-05/package.zip", to: "platform-exports/discord/2026-10-05/package.zip", blocked: "platform-exports/discord/2026-10-05/package.zip exists" },
      { from: "imports/instagram-2026-10-05/instagram-2026-10-05.zip", to: "platform-exports/instagram/2026-10-05/instagram-2026-10-05.zip" },
      { from: "imports/iphone-addressbook-2026-09-28", to: "platform-exports/addressbook/2026-09-28" },
      { from: "imports/whatsapp-iphone-2026-09-28", to: "platform-exports/whatsapp/2026-09-28" },
    ]);
    expect(plan.unknown).toEqual(["notes"]);

    const db = openArchive(":memory:");
    const source = db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, ?, 'export', ?, 0, 'ok')");
    source.run("whatsapp", "whatsapp-db", "whatsapp-iphone-2026-09-28");
    source.run("instagram", "instagram-dyi", "2026-10-05");
    source.run("discord", "discord-package", "discord-2026-10-05");
    expect(await moveImports(data, plan)).toEqual({ moved: 3, blocked: 1 });
    expect(relabelSources(db, plan)).toBe(2);
    expect((db.prepare("SELECT label FROM source ORDER BY id").all() as Array<{ label: string }>).map((s) => s.label))
      .toEqual(["platform-exports/whatsapp/2026-09-28", "platform-exports/instagram/2026-10-05", "discord-2026-10-05"]);
    db.close();

    expect(await readFile(join(data, "platform-exports/whatsapp/2026-09-28/Message/Media/a.jpg"), "utf8")).toBe("a");
    expect(await readFile(join(data, "platform-exports/instagram/2026-10-05/instagram-2026-10-05.zip"), "utf8")).toBe("zip");
    // What could not move stays, and so does what has no date; the emptied folders go.
    expect((await readdir(join(data, "imports"))).sort()).toEqual([".DS_Store", "discord-2026-10-05", "notes"]);
    expect(await readFile(join(data, "imports/discord-2026-10-05/package.zip"), "utf8")).toBe("zip");
  });
});

describe("re-pointing attachments from archive/media/ to platform-exports/", () => {
  let data: string;
  let db: Db;
  const file = (name: string) => ({ data: `bytes of ${name}`, sha256: sha256(`bytes of ${name}`), size: `bytes of ${name}`.length });
  const [X, Y, Z, W, V] = ["x", "y", "z", "w", "v"].map(file);
  const copyPath = (platform: string, f: { sha256: string }, ext = ".jpg") => `archive/media/${platform}/${f.sha256.slice(0, 2)}/${f.sha256}${ext}`;

  /** An attachment as the older code wrote it: on a copy in archive/media/. */
  function attach(platform: string, kind: "app-db" | "live", message: string, f: { sha256: string; size: number } | null, path: string | null): number {
    const sourceId = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, ?, ?, 't', 0, 'ok')")
      .run(platform, `${platform}-${kind}`, kind).lastInsertRowid);
    const session = new ImportSession(db, platform, sourceId, kind, { dataDir: data });
    session.apply({ kind: "account", key: "A", keyKind: "name", displayName: "A" });
    session.apply({ kind: "conversation", id: "c", type: "direct", members: ["A"] });
    // Each its own time, so none is taken for another connector's record of the same message.
    session.apply({ kind: "message", id: message, idKind: "platform", conversation: "c", sender: "A", isFromSelf: false, sentAt: ++sent, type: "media", raw: {} });
    session.apply({ kind: "attachment", message, ordinal: 0, type: "image", ...(f ? { stored: { ...f, path: "unused/live/x.jpg" } } : {}) });
    const id = (db.prepare("SELECT max(id) AS id FROM attachment").get() as { id: number }).id;
    db.prepare("UPDATE attachment SET local_path = ? WHERE id = ?").run(path, id);
    return id;
  }

  let sent = 0;
  const pathOf = (id: number) => (db.prepare("SELECT local_path AS p FROM attachment WHERE id = ?").get(id) as { p: string | null }).p;

  beforeEach(async () => {
    data = join(dir, "data");
    db = openArchive(join(data, "archive.sqlite"));
    // The copies the older code made, one of them not what its record says.
    for (const [platform, f] of [["whatsapp", X], ["whatsapp", Y], ["whatsapp", Z], ["telegram", W], ["telegram", V]] as const) await put(join(data, copyPath(platform, f)), f.data);
    await put(join(data, copyPath("whatsapp", V)), "a copy gone wrong");
    await put(join(data, "archive/media/whatsapp/00/unused.jpg"), "a copy nothing points at");
    // Two exports of WhatsApp holding X (and V), the later one too; Y is in neither.
    await put(join(data, "platform-exports/whatsapp/2026-09-28/Message/Media/a/x.jpg"), X.data);
    await put(join(data, "platform-exports/whatsapp/2026-09-28/Message/Media/a/v.jpg"), V.data);
    await put(join(data, "platform-exports/whatsapp/2026-10-04/Message/Media/b/x.jpg"), X.data);
    await put(join(data, "platform-exports/whatsapp/2026-10-04/ChatStorage.sqlite"), "db");
    await put(join(data, "platform-exports/instagram/2026-10-05/inbox/a/1.jpg"), "photo");
    // What the Telegram bridge had downloaded.
    await put(join(data, "archive/media/.ledger/matrix-bridge.jsonl"), [
      JSON.stringify({ key: "mxc://w", stored: { sha256: W.sha256, size: W.size, path: copyPath("telegram", W).slice("archive/media/".length) } }),
      JSON.stringify({ key: "mxc://gone", stored: { sha256: "0".repeat(64), size: 1, path: "telegram/00/gone.jpg" } }),
    ].join("\n") + "\n");
  });

  afterEach(() => db.close());

  it("plans first, from size and SHA-256, then re-points each to the newest export holding it or a live home, deleting nothing", async () => {
    const ids = {
      x: attach("whatsapp", "app-db", "m1", X, copyPath("whatsapp", X)),
      xAgain: attach("whatsapp", "app-db", "m2", X, copyPath("whatsapp", X)),
      y: attach("whatsapp", "app-db", "m3", Y, copyPath("whatsapp", Y)),
      none: attach("whatsapp", "app-db", "m4", null, null),
      liveX: attach("whatsapp", "live", "m5", X, copyPath("whatsapp", X)),
      liveZ: attach("whatsapp", "live", "m6", Z, copyPath("whatsapp", Z)),
      wrongCopy: attach("whatsapp", "app-db", "m7", V, copyPath("whatsapp", V)),
      w: attach("telegram", "live", "t1", W, copyPath("telegram", W)),
      ig: attach("instagram", "app-db", "i1", { sha256: sha256("photo"), size: 5 }, "platform-exports/instagram/2026-10-05/inbox/a/1.jpg"),
    };
    const before = pathOf(ids.y);

    const plan = await planRepoint(db, data);
    const whatsapp = plan.platforms.find((p) => p.platform === "whatsapp")!;
    expect(whatsapp).toMatchObject({
      attachments: 7, missing: 1, home: 0, toExport: 4, toLive: 1, unmatched: { "not in any export (same size and SHA-256)": 1 },
      toExportFiles: 2, toLiveFiles: 1, copiesChecked: 4, copiesDiffer: 1, copiesMissing: 0, exports: ["2026-10-04", "2026-09-28"],
    });
    expect(plan.platforms.find((p) => p.platform === "telegram")).toMatchObject({ toLive: 1, toExport: 0, exports: [] });
    expect(plan.platforms.find((p) => p.platform === "instagram")).toMatchObject({ home: 1, toExport: 0, toLive: 0 });
    // The plan writes nothing.
    expect(pathOf(ids.x)).toBe(copyPath("whatsapp", X));
    expect(await stat(join(data, "platform-exports/telegram")).catch(() => null)).toBeNull();
    // Once re-pointed, the copies of X, Z and V would be pointed at by nothing; Y's still would.
    expect(await unreferencedCopies(db, data, plan)).toEqual([
      { platform: "telegram", files: 2, bytes: W.size + V.size, unreferencedFiles: 2, unreferencedBytes: W.size + V.size, stillReferenced: 0 },
      { platform: "whatsapp", files: 5, bytes: X.size + Y.size + Z.size + 17 + 24, unreferencedFiles: 4, unreferencedBytes: X.size + Z.size + 17 + 24, stillReferenced: 1 },
    ]);

    const result = await applyRepoint(db, data, plan);
    expect(result).toMatchObject({ repointed: 6, changedSince: 0, liveCopiesMade: 2, ledgerEntries: 1 });
    // The newest export holding the file, whoever brought it.
    expect(pathOf(ids.x)).toBe("platform-exports/whatsapp/2026-10-04/Message/Media/b/x.jpg");
    expect(pathOf(ids.xAgain)).toBe("platform-exports/whatsapp/2026-10-04/Message/Media/b/x.jpg");
    expect(pathOf(ids.liveX)).toBe("platform-exports/whatsapp/2026-10-04/Message/Media/b/x.jpg");
    // An export's file matching the record replaces a copy that does not.
    expect(pathOf(ids.wrongCopy)).toBe("platform-exports/whatsapp/2026-09-28/Message/Media/a/v.jpg");
    // No export behind it: a live home, the same bytes.
    expect(pathOf(ids.liveZ)).toBe(`platform-exports/whatsapp/live/${Z.sha256.slice(0, 2)}/${Z.sha256}.jpg`);
    expect(await readFile(join(data, pathOf(ids.liveZ)!), "utf8")).toBe(Z.data);
    expect(pathOf(ids.w)).toBe(`platform-exports/telegram/live/${W.sha256.slice(0, 2)}/${W.sha256}.jpg`);
    // What cannot be matched stays on its copy; what had no file still has none.
    expect(pathOf(ids.y)).toBe(before);
    expect(pathOf(ids.none)).toBeNull();
    expect(pathOf(ids.ig)).toBe("platform-exports/instagram/2026-10-05/inbox/a/1.jpg");

    // Every change is logged, and every copy is still there.
    const log = (await readFile(result.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { attachment: number; from: string; to: string });
    expect(log.map((c) => c.attachment).sort((a, b) => a - b)).toEqual([ids.x, ids.xAgain, ids.liveX, ids.liveZ, ids.wrongCopy, ids.w].sort((a, b) => a - b));
    for (const [platform, f] of [["whatsapp", X], ["whatsapp", Y], ["whatsapp", Z], ["telegram", W]] as const) {
      expect(await readFile(join(data, copyPath(platform, f)), "utf8")).toBe(f.data);
    }
    // The bridge's ledger names the live home, so a later read does not download it again; the old ledger stays.
    expect((await readFile(join(data, "platform-exports/.ledger/matrix-bridge.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)))
      .toEqual([{ key: "mxc://w", stored: { sha256: W.sha256, size: W.size, path: `telegram/live/${W.sha256.slice(0, 2)}/${W.sha256}.jpg` } }]);
    expect(await stat(join(data, "archive/media/.ledger/matrix-bridge.jsonl"))).toBeTruthy();
    expect((await unreferencedCopies(db, data)).find((c) => c.platform === "whatsapp")).toMatchObject({ unreferencedFiles: 4, stillReferenced: 1 });

    // Run again: nothing more to do, and the live copies are not made twice.
    const again = await planRepoint(db, data);
    expect(again.changes).toEqual([]);
    expect(again.platforms.find((p) => p.platform === "whatsapp")).toMatchObject({ home: 5, toExport: 0, toLive: 0 });
  });

  it("leaves an attachment that changed since the plan as it is", async () => {
    const id = attach("whatsapp", "app-db", "m1", X, copyPath("whatsapp", X));
    const plan = await planRepoint(db, data);
    db.prepare("UPDATE attachment SET local_path = 'platform-exports/whatsapp/2026-09-28/Message/Media/a/x.jpg' WHERE id = ?").run(id);
    expect(await applyRepoint(db, data, plan)).toMatchObject({ repointed: 0, changedSince: 1 });
    expect(pathOf(id)).toBe("platform-exports/whatsapp/2026-09-28/Message/Media/a/x.jpg");
  });

  it("reports storage: in all, and per platform its messages, exports, media pointed at and copies nothing points at", async () => {
    attach("whatsapp", "app-db", "m1", X, copyPath("whatsapp", X));
    attach("whatsapp", "app-db", "m3", Y, copyPath("whatsapp", Y));
    await applyRepoint(db, data, await planRepoint(db, data));
    await put(join(data, "platform-exports/whatsapp/2026-10-04/whatsapp.zip"), "zipped!");
    // The captain's Obsidian vault, a folder no archive code knows, linked from iCloud Drive: counted like the rest, as the folder it is.
    await put(join(dir, "iCloud/Vault/Journal/2026-10-16.md"), "made-up");
    await symlink(join(dir, "iCloud/Vault"), join(data, "Vault"));
    const report = await storageReport(db, data);
    expect(report.totalBytes).toBe(report.top.reduce((sum, t) => sum + t.bytes, 0));
    expect(report.top.map((t) => t.name)).toEqual(expect.arrayContaining(["archive/", "archive.sqlite", "platform-exports/"]));
    expect(report.top).toContainEqual({ name: "Vault/", bytes: 7 });
    const whatsapp = report.platforms.find((p) => p.platform === "whatsapp")!;
    expect(whatsapp).toMatchObject({
      messages: 2, mediaFiles: 2, mediaBytes: X.size + Y.size, copiesReferencedFiles: 1, copiesReferencedBytes: Y.size,
      unreferencedCopyFiles: 4, unreferencedCopyBytes: X.size + Z.size + 17 + 24,
    });
    expect(whatsapp.messageBytes).toBeGreaterThan(0);
    expect(whatsapp.exports).toEqual([
      { folder: "2026-10-04", bytes: X.size + 2 + 7, zipBytes: 7, referencedFiles: 1, referencedBytes: X.size },
      { folder: "2026-09-28", bytes: X.size + V.size, zipBytes: 0, referencedFiles: 0, referencedBytes: 0 },
    ]);
    expect(report.platforms.find((p) => p.platform === "instagram")).toMatchObject({ messages: 0, exports: [{ folder: "2026-10-05", bytes: 5 }] });
  });
});

describe("a second export of a platform (a continuation)", () => {
  let data: string;
  let db: Db;
  let host: ConnectorHost;
  const chat = "your_facebook_activity/messages/inbox/adasample_1";
  const day = (n: number) => Date.UTC(2026, 8, 20 + n, 10);
  const photo = (n: number) => ({ photos: [{ uri: `${chat}/photos/${n}.jpg` }] });

  /** A Facebook download of the chat with Ada: its messages, and its photos' bytes. */
  async function download(date: string, messages: ReturnType<typeof rec>[], photos: Record<number, string>): Promise<string> {
    const zip = join(dir, `${date}.zip`);
    await writeZip(zip, [
      { name: `${chat}/message_1.json`, data: threadFile(["Ada Sample", SELF], "Ada Sample", "inbox/adasample_1", messages) },
      ...Object.entries(photos).map(([n, bytes]) => ({ name: `${chat}/photos/${n}.jpg`, data: bytes })),
    ]);
    return unpackedExport(zip, exportFolder(data, "messenger", date));
  }

  beforeEach(async () => {
    data = join(dir, "data");
    db = openArchive(join(data, "archive.sqlite"));
    host = await chatHost(db, data);
    await host.setEnabled("facebook-dyi", true);
    await writeFile(join(data, "connectors", "facebook-dyi.json"), JSON.stringify({ enabled: true, selfName: SELF }));
  });

  afterEach(() => db.close());

  const attachments = () => db.prepare(
    `SELECT m.text, a.local_path AS path, a.sha256 FROM attachment a JOIN message m ON m.id = a.message_id ORDER BY m.sent_at`,
  ).all() as Array<{ text: string; path: string; sha256: string }>;
  const texts = () => (db.prepare("SELECT text FROM message ORDER BY sent_at").all() as Array<{ text: string }>).map((m) => m.text);

  async function exports() {
    // The first download, to the 25th; the continuation, from the 24th, with the overlap's photo in higher quality.
    const first = await download("2026-09-28", [rec("Ada Sample", day(1), "one", photo(1)), rec(SELF, day(4), "four", photo(4))], { 1: "photo 1", 4: "photo 4" });
    const later = await download("2026-10-06", [rec(SELF, day(4), "four", photo(4)), rec("Ada Sample", day(10), "ten", photo(10))], { 4: "photo 4, sharper", 10: "photo 10" });
    return { first, later };
  }

  it("adds the new messages, keeps the overlap once, and points media at the newest export holding each file", async () => {
    const { first, later } = await exports();
    expect((await host.importHistory("facebook-dyi", first)).counts.messages).toMatchObject({ added: 2 });
    const continued = await host.importHistory("facebook-dyi", later);
    expect(continued.counts.messages).toMatchObject({ added: 1, unchanged: 1 });
    expect(continued.counts.attachments).toMatchObject({ added: 1, updated: 1 });
    expect(texts()).toEqual(["one", "four", "ten"]);
    expect(attachments()).toEqual([
      { text: "one", path: `platform-exports/messenger/2026-09-28/${chat}/photos/1.jpg`, sha256: sha256("photo 1") },
      { text: "four", path: `platform-exports/messenger/2026-10-06/${chat}/photos/4.jpg`, sha256: sha256("photo 4, sharper") },
      { text: "ten", path: `platform-exports/messenger/2026-10-06/${chat}/photos/10.jpg`, sha256: sha256("photo 10") },
    ]);

    // The first download imported again changes nothing: the newer file stays.
    const again = await host.importHistory("facebook-dyi", first);
    expect(again.counts.messages).toMatchObject({ added: 0 });
    expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });
    expect(attachments()[1].path).toBe(`platform-exports/messenger/2026-10-06/${chat}/photos/4.jpg`);
  });

  it("comes to the same whichever export is imported first", async () => {
    const { first, later } = await exports();
    await host.importHistory("facebook-dyi", later);
    const older = await host.importHistory("facebook-dyi", first);
    expect(older.counts.messages).toMatchObject({ added: 1, unchanged: 1 });
    expect(texts()).toEqual(["one", "four", "ten"]);
    expect(attachments().map((a) => a.path)).toEqual([
      `platform-exports/messenger/2026-09-28/${chat}/photos/1.jpg`,
      `platform-exports/messenger/2026-10-06/${chat}/photos/4.jpg`,
      `platform-exports/messenger/2026-10-06/${chat}/photos/10.jpg`,
    ]);
  });
});
