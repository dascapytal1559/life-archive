// npm run check-data over the inspirations (module.ts's checkData, store.ts's inspirationProblems), run as the captain
// runs it, on a made-up folder with friend map switched off, so these check the inspirations' alone.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CORE_FILE, openCore, openModuleDatabase } from "../../../sdk/testing.ts";
import { INSPIRATIONS_DATABASE, INSPIRATIONS_DB } from "./db.ts";
import { inspirationsFolder } from "./files.ts";
import { Inspirations } from "./store.ts";

const SCRIPT = fileURLToPath(new URL("../../../server/check-data.ts", import.meta.url));

let dataDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-check-"));
  openCore(join(dataDir, CORE_FILE)).close();
  const testing = JSON.parse(readFileSync(process.env.LIFE_ARCHIVE_SETTINGS!, "utf8")) as Record<string, unknown>;
  const settingsFile = join(dataDir, "settings.testing.json");
  await writeFile(settingsFile, JSON.stringify({ ...testing, modules: { "friend-map": false } }));
  env = { ...process.env, LIFE_ARCHIVE_SETTINGS: settingsFile };
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function checkData(): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, dataDir], { env });
    return { code: 0, stdout };
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string };
    return { code, stdout };
  }
}

it("checks the inspirations: canonical links, captions, saves, kept files in their folder, a preview's picture small, and both kinds of tags", async () => {
  const folder = inspirationsFolder(dataDir);
  const file = join(folder, INSPIRATIONS_DB);
  const { db } = openModuleDatabase(file, INSPIRATIONS_DATABASE);
  const store = new Inspirations(db);
  const now = Date.parse("2026-10-18T09:00:00+11:00");
  store.capture({ link: "https://youtu.be/AbCdEfGhIjK", caption: "a song for the drive", tags: ["music"], origin: "grok-bot", savedAt: now, now });
  const kept = "files/ab/" + "ab".repeat(32) + ".png";
  await mkdir(join(folder, "files/ab"), { recursive: true });
  await writeFile(join(folder, kept), "made-up bytes");
  const preview = "files/cd/" + "cd".repeat(32) + ".jpg";
  await mkdir(join(folder, "files/cd"), { recursive: true });
  await writeFile(join(folder, preview), "made-up bytes");
  store.capture({ files: [{ path: kept, mime: "image/png", bytes: 13, sha256: "ab".repeat(32) }], origin: "cli", savedAt: now, now });
  store.setAiTags(1, ["music", "road-trip"], "made-up-model", now);
  db.close();
  expect(await checkData()).toEqual({ code: 0, stdout: `Checked inspirations in ${dataDir}: all fine; switched off, so not checked: friend-map.\n` });

  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE inspiration SET link = 'https://youtu.be/AbCdEfGhIjK', caption = ' padded ' WHERE id = 1;
    INSERT INTO inspiration (link, platform, form, caption, created_at) VALUES (NULL, 'file', 'image', '', 0);
    INSERT INTO inspiration_save (inspiration_id, origin, saved_at) VALUES (3, 'Grok Bot', 0);
    UPDATE inspiration_file SET path = 'Desktop/photo.png';
    INSERT INTO inspiration_file (inspiration_id, role, path, mime, bytes, sha256, added_at) VALUES (1, 'preview', '${preview}', 'image/jpeg', 5000000, '${"cd".repeat(32)}', 0);
    INSERT INTO inspiration_file (inspiration_id, role, path, mime, bytes, sha256, added_at) VALUES (1, 'item', 'files/ef/${"ef".repeat(32)}.png', 'image/png', 10, '${"ef".repeat(32)}', 0);
    INSERT INTO inspiration_tag (name, sort_order, created_at) VALUES ('Road trip', 9, 0);
    INSERT INTO inspiration_ai_tag (inspiration_id, name, rank) VALUES (1, 'Two Words', 9);`);
  raw.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout.split("\n").filter((line) => line.startsWith("inspiration") || line.startsWith("AI tag"))).toEqual([
    "inspiration #1: its link is not in its canonical form (https://www.youtube.com/watch?v=AbCdEfGhIjK); a save of the same thing would make another item",
    "inspiration #1: its caption is not written the way the app writes notes",
    "inspiration #3: it has neither a link nor a kept file",
    "inspiration #3, save #3: \"Grok Bot\" is not an origin (lowercase letters, digits and dashes, up to 40, such as grok-bot)",
    "inspiration #2, file #1: it is not kept by content hash in modules/inspirations/files/ (Desktop/photo.png)",
    "inspiration #1, file #2: a preview's picture of 4883 KB, more than a small picture (400 KB)",
    `inspiration #1, file #3: modules/inspirations/files/ef/${"ef".repeat(32)}.png is not in the archive's folder`,
    "inspiration tag \"Road trip\": it is not written the way the app writes tags (road-trip)",
    "AI tag \"Two Words\": it is not written the way the app writes tags",
  ]);
});

it("says the inspirations were not checked when their database is not in the folder, and never that all is fine", async () => {
  const { code, stdout } = await checkData();
  expect(code).toBe(2);
  expect(stdout).toBe(
    `The inspirations module has no database at ${join(inspirationsFolder(dataDir), INSPIRATIONS_DB)}, so its data is not checked.\n` +
    `Checked nothing in ${dataDir}: nothing to fix in what was checked; not checked: inspirations; switched off, so not checked: friend-map.\n`,
  );
});
