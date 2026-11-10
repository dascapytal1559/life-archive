// The upgrade to ready pages (src/pages.ts), once per archive: an archive made before them had every page on, so an
// upgrade must switch nothing off. Its settings.json, when it says nothing of `pages`, is given `"pages": "all"`;
// a fresh install keeps the default, "ready". settings.ts runs this before it first reads the settings.
//
// What tells the two apart is the core's database (coreDb.ts): the code that knows the ready marks marks it
// (READY_MARKS_KEY in its meta) the first time it opens it. An archive is older when its core.sqlite lacks the mark,
// or when it has no core.sqlite but the archive.sqlite of the layout before the core had one of its own.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CORE_FILE, READY_MARKS_KEY } from "./archive/coreDb.ts";
import { isMissingFile } from "./files.ts";

/** The archive's database at the folder's root before the core had its own (archive/migrate.ts moves it). */
const OLD_ARCHIVE = "archive.sqlite";

/** Whether the archive kept at `folder` was made before the ready marks. */
export function madeBeforeReadyMarks(folder: string): boolean {
  const core = join(folder, CORE_FILE);
  if (!existsSync(core)) return existsSync(join(folder, OLD_ARCHIVE));
  const db = new DatabaseSync(core, { readOnly: true, timeout: 10_000 });
  try {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").get() !== undefined;
    return !hasMeta || db.prepare("SELECT 1 FROM meta WHERE key = ?").get(READY_MARKS_KEY) === undefined;
  } finally {
    db.close();
  }
}

/**
 * Gives `file` (the settings.json of the archive kept at `folder`) `"pages": "all"` when it says nothing of `pages` and
 * the archive was made before the ready marks; true when it did. A file that is not a JSON object is left for
 * loadSettings to refuse.
 */
export function upgradeToReadyPages(folder: string, file: string): boolean {
  let text = "{}"; // none yet: an older archive gets one with this key alone
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) return false;
  }
  let written: unknown;
  try {
    written = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof written !== "object" || written === null || Array.isArray(written) || "pages" in written) return false;
  if (!madeBeforeReadyMarks(folder)) return false;
  writeFileSync(file, `${JSON.stringify({ ...written, pages: "all" }, null, 2)}\n`);
  console.error(`${file}: "pages": "all" written, as this archive was made before ready pages and had every page on; remove it to offer only the ready ones (docs/settings.md)`);
  return true;
}
