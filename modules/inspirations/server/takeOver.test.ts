// The take-over (db.ts): the inspirations as the core kept them until they were a module (their tables and change log
// in core.sqlite, their kept files in platform-exports/inspirations/live/), copied once into the module's database and
// folder as it is first opened: every row with its id, the change history undoable, every file byte for byte, the
// core's copy left as it was, once only, undone whole when anything is not as it was. Every item is made up.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Changes, getMeta, hashedPath, type ModuleDatabase } from "../../../sdk/server.ts";
import { CORE_FILE, openCore, openModuleDatabase } from "../../../sdk/testing.ts";
import { openTestInspirations } from "../testing/open.ts";
import { INSPIRATION_LOG_TABLES, inspirationsDescriber } from "./changeLog.ts";
import { INSPIRATIONS_DATABASE, INSPIRATIONS_DB } from "./db.ts";
import { Inspirations, type KeptFile } from "./store.ts";

const NOW = Date.parse("2026-10-18T09:00:00+11:00");
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-inspirations-takeover-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

/** A made-up file kept as the core kept them, by its hash in platform-exports/inspirations/live/, named from the archive's folder. */
async function oldFile(bytes: string, name: string): Promise<KeptFile> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join("platform-exports", "inspirations", "live", hashedPath(sha256, name));
  await mkdir(join(dataDir, path, ".."), { recursive: true });
  await writeFile(join(dataDir, path), bytes);
  return { path, mime: "image/png", bytes: Buffer.byteLength(bytes), sha256 };
}

/** The core as the inspirations left it: items, saves, a kept photo and a preview, his tags and the AI's, two changesets of his edits. */
async function oldCore(): Promise<{ photo: KeptFile; preview: KeptFile }> {
  const core = openCore(join(dataDir, CORE_FILE));
  const photo = await oldFile("made-up photo bytes", "photo.png");
  const preview = await oldFile("made-up preview bytes", "picture.png");
  try {
    const store = new Inspirations(core);
    store.capture({ link: "https://blog.example.com/terrazzo", caption: "for the bathroom floor", tags: ["interior-design"], origin: "grok-bot", savedAt: NOW, now: NOW });
    store.capture({ files: [photo], caption: "tiles", origin: "share-sheet", savedAt: NOW, now: NOW });
    const { id } = store.capture({ link: "https://www.instagram.com/p/MadeUp0001/", origin: "instagram-saves-import", nativeId: "MadeUp0001", savedAt: NOW, now: NOW });
    store.keepPreviewFile(id, preview, NOW);
    // The same picture kept for two items, as Instagram's previews of one post saved twice are.
    const again = store.capture({ link: "https://www.instagram.com/p/MadeUp0002/", origin: "instagram-saves-import", nativeId: "MadeUp0002", savedAt: NOW, now: NOW });
    store.keepPreviewFile(again.id, preview, NOW);
    store.setAiTags(1, ["terrazzo", "craft"], "made-up-model", NOW);
    const changes = new Changes(core, { tables: INSPIRATION_LOG_TABLES, describe: inspirationsDescriber(core) });
    changes.record({ surface: "cli", action: "inspiration tag #2" }, () => store.tag(2, ["bathroom"], NOW));
    changes.record({ surface: "app", action: "inspiration caption #1" }, () => store.setCaption(1, "for the floor, and the stairs", NOW));
  } finally {
    core.close();
  }
  return { photo, preview };
}

/** Every row of `table` in the database at `file`, in order. */
function rows(file: string, table: string, columns = "*"): unknown[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1, 2`).all();
  } finally {
    db.close();
  }
}

const TABLES = ["inspiration", "inspiration_save", "inspiration_tag", "inspiration_item_tag", "inspiration_ai_tag", "inspiration_fetch", "changeset", "change_row"];

/**
 * The module's open in the archive's folder `dir` while the move the take-over waits for is not done: it fails, saying
 * why, so nothing (a share sheet's capture) can write into its database before the take-over; nothing is marked taken
 * over, and nothing is in it.
 */
function expectWaiting(dir: string): void {
  expect(() => openTestInspirations(dir)).toThrow(/has not made yet: it waits, writing nothing, until npm run archive -- migrate friend-map-module --apply has run/);
  const left = new DatabaseSync(join(dir, "modules", "inspirations", INSPIRATIONS_DB), { readOnly: true });
  try {
    expect(getMeta(left, "taken_over")).toBeNull();
    expect(left.prepare("SELECT count(*) AS n FROM inspiration").get()).toEqual({ n: 0 });
  } finally {
    left.close();
  }
}

describe("the take-over from the core", () => {
  it("copies every row with its id, the change log and the kept files, leaves the core's as they were, and happens once", async () => {
    const { photo, preview } = await oldCore();
    const core = join(dataDir, CORE_FILE);
    const before = Object.fromEntries([...TABLES, "inspiration_file"].map((table) => [table, rows(core, table)]));
    const opened = openTestInspirations(dataDir);
    try {
      expect(opened.takenOver).toBe(true);
      const own = join(opened.folder, INSPIRATIONS_DB);
      for (const table of TABLES) expect(rows(own, table), table).toEqual(before[table]);
      // A kept file's row is the same but for its path, now from the module's folder.
      expect(rows(own, "inspiration_file", "id, inspiration_id, role, mime, bytes, sha256, added_at"))
        .toEqual(rows(core, "inspiration_file", "id, inspiration_id, role, mime, bytes, sha256, added_at"));
      const paths = (rows(own, "inspiration_file", "id, path") as { path: string }[]).map((r) => r.path);
      expect(paths).toEqual([join("files", hashedPath(photo.sha256, "photo.png")), join("files", hashedPath(preview.sha256, "picture.png")), join("files", hashedPath(preview.sha256, "picture.png"))]);
      for (const [file, path] of [[photo, paths[0]!], [preview, paths[1]!]] as const) {
        expect(readFileSync(join(opened.folder, path))).toEqual(readFileSync(join(dataDir, file.path)));
      }
      expect(getMeta(opened.db, "taken_over")).toMatch(/^\d{4}-\d\d-\d\d$/);
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[inspirations\] took over from core\.sqlite: 4 inspiration, .*2 changeset, .*and 2 kept files copied/));
      // The core's copy is as it was, rows and files.
      for (const table of [...TABLES, "inspiration_file"]) expect(rows(core, table), table).toEqual(before[table]);
      expect(existsSync(join(dataDir, photo.path)) && existsSync(join(dataDir, preview.path))).toBe(true);
      // The module answers as the core did: its items, files served from its folder, and an Undo of an edit made before.
      const { store, changes } = opened.part;
      expect(store.get(1)).toMatchObject({ caption: "for the floor, and the stairs", tags: ["interior-design"], aiTags: ["terrazzo", "craft"] });
      expect(changes.list().map((c) => c.action)).toEqual(["inspiration caption #1", "inspiration tag #2"]);
      changes.undo(1, { surface: "cli" });
      expect(store.get(2)!.tags).toEqual([]);
    } finally {
      opened.close();
    }
    // Opened again: nothing taken over again, the undo above kept.
    const again = openTestInspirations(dataDir);
    try {
      expect(again.takenOver).toBe(false);
      expect(again.part.store.get(2)!.tags).toEqual([]);
      expect(rows(join(again.folder, INSPIRATIONS_DB), "inspiration")).toHaveLength(4);
    } finally {
      again.close();
    }
  });

  it("keeps the row of a file missing from its old place with its old path, saying so, as check-data would name it", async () => {
    const { photo } = await oldCore();
    await rm(join(dataDir, photo.path));
    const opened = openTestInspirations(dataDir);
    try {
      expect(opened.takenOver).toBe(true);
      expect(opened.part.store.file(1)).toMatchObject({ path: photo.path });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${photo.path} was not copied, as it was not in the archive's folder; its row is kept with that old path`));
    } finally {
      opened.close();
    }
  });

  it("files no copy of a file whose bytes are not its sha256, and stages every copy outside files/", async () => {
    const { photo, preview } = await oldCore();
    await writeFile(join(dataDir, photo.path), "made-up bytes changed since");
    const opened = openTestInspirations(dataDir);
    try {
      expect(opened.part.store.file(1)).toMatchObject({ path: photo.path });
      expect(existsSync(join(opened.folder, "files", hashedPath(photo.sha256, "photo.png")))).toBe(false);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${photo.path} was not copied, as its bytes are not its sha256`));
      const kept = join(opened.folder, "files", hashedPath(preview.sha256, "picture.png"));
      expect(readFileSync(kept)).toEqual(readFileSync(join(dataDir, preview.path)));
      expect(readdirSync(join(opened.folder, "files"), { recursive: true }).filter((name) => String(name).endsWith(".partial"))).toEqual([]);
      expect(readdirSync(join(opened.folder, ".incoming"))).toEqual([]);
    } finally {
      opened.close();
    }
  });

  it("copies the files before the transaction it copies the rows in, so a slow copy holds no lock", async () => {
    await oldCore();
    const inTransaction: boolean[] = [];
    const watched: ModuleDatabase = {
      ...INSPIRATIONS_DATABASE,
      takeOverFiles: (db, folder) => {
        inTransaction.push(db.isTransaction);
        INSPIRATIONS_DATABASE.takeOverFiles!(db, folder);
      },
      takeOver: (db, folder) => {
        inTransaction.push(db.isTransaction);
        INSPIRATIONS_DATABASE.takeOver!(db, folder);
      },
    };
    const { db, takenOver } = openModuleDatabase(join(dataDir, "modules", "inspirations", INSPIRATIONS_DB), watched, { archiveFile: join(dataDir, "archive.sqlite") });
    try {
      expect(takenOver).toBe(true);
      expect(inTransaction).toEqual([false, true]);
    } finally {
      db.close();
    }
  });

  it("undoes itself whole when the core holds what it does not know, the module broken until the next open tries again", async () => {
    await oldCore();
    const core = new DatabaseSync(join(dataDir, CORE_FILE));
    core.exec("ALTER TABLE inspiration ADD COLUMN made_up_later TEXT");
    core.close();
    expect(() => openTestInspirations(dataDir)).toThrow(/the core's inspiration has columns this module does not know \(made_up_later\), so nothing was taken over/);
    const left = new DatabaseSync(join(dataDir, "modules", "inspirations", INSPIRATIONS_DB), { readOnly: true });
    try {
      expect(left.prepare("SELECT count(*) AS n FROM inspiration").get()).toEqual({ n: 0 });
      expect(getMeta(left, "taken_over")).toBeNull();
    } finally {
      left.close();
    }
    // Put right, the next open takes it over.
    const fixed = new DatabaseSync(join(dataDir, CORE_FILE));
    fixed.exec("ALTER TABLE inspiration DROP COLUMN made_up_later");
    fixed.close();
    const opened = openTestInspirations(dataDir);
    try {
      expect(opened.takenOver).toBe(true);
      expect(opened.part.store.get(1)).not.toBeNull();
    } finally {
      opened.close();
    }
  });

  it("takes nothing from a new archive's folder, and waits for an archive not yet moved to make the core it takes from", async () => {
    const fresh = openTestInspirations(dataDir);
    try {
      expect(fresh.takenOver).toBe(false);
      expect(getMeta(fresh.db, "taken_over")).toBe("nothing");
    } finally {
      fresh.close();
    }
    const other = await mkdtemp(join(tmpdir(), "life-archive-inspirations-unmoved-"));
    try {
      await writeFile(join(other, "archive.sqlite"), "");
      expectWaiting(other);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("waits for a move whose core is still being built, even beside an empty core.sqlite", async () => {
    openCore(join(dataDir, CORE_FILE)).close();
    openCore(join(dataDir, `${CORE_FILE}.partial`)).close();
    expectWaiting(dataDir);
  });

  it("waits for a move stopped after the archive went into its module and before the core was put in place, then takes the core over once it is", async () => {
    await mkdir(join(dataDir, "modules", "friend-map"), { recursive: true });
    await writeFile(join(dataDir, "modules", "friend-map", "archive.sqlite"), "");
    const partial = join(dataDir, `${CORE_FILE}.partial`);
    const core = openCore(partial);
    try {
      new Inspirations(core).capture({ link: "https://blog.example.com/terrazzo", caption: "for the bathroom floor", origin: "grok-bot", savedAt: NOW, now: NOW });
    } finally {
      core.close();
    }
    expectWaiting(dataDir);
    await rename(partial, join(dataDir, CORE_FILE));
    const opened = openTestInspirations(dataDir);
    try {
      expect(opened.takenOver).toBe(true);
      expect(opened.part.store.get(1)).toMatchObject({ caption: "for the bathroom floor" });
    } finally {
      opened.close();
    }
  });
});
