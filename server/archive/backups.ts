// Backups of the archive, taken before a data change (npm run archive -- backup <label>):
// data/backups/<YYYY-MM-DD>T<HHMMSS>-<label>.sqlite, named in local time: the core's database (core.sqlite), and each
// module's (modules/<id>/<name>.sqlite in the archive's folder: friend map's archive.sqlite among them) with it, under the same stamp and label plus its file's name:
// <YYYY-MM-DD>T<HHMMSS>-<label>.<name>.sqlite. They are one backup, which the prune keeps or deletes whole.
//
// They are cleaned by one rule, applied after every backup and once when the
// server starts: anything older than 48 hours goes, and of the rest only the
// newest of each local day and every before-import one stay (an import
// session takes one before each import, and each is a restore point). The prune
// touches only files in the backups folder whose names match that pattern, so
// nothing else is ever deleted.

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TIME_ZONE } from "../../src/time.ts";
import { MODULES_FOLDER } from "../modules/store.ts";
import { CORE_FILE } from "./coreDb.ts";

/** How long a backup is kept at most. */
export const BACKUP_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** A label that starts with this marks a backup taken before an import, which the prune keeps for 48 hours. */
export const BEFORE_IMPORT_PREFIX = "before-import-";

const NAME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.[\w.-]+)?\.sqlite$/;

const partsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function localParts(ms: number): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const parts = Object.fromEntries(partsFormat.formatToParts(ms).map((p) => [p.type, p.value]));
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

/** A label as it goes in a file name: lower case words joined by hyphens. */
export function slugLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

/** The file name of a backup taken at `at` (local time) with this label. */
export function backupName(at: number, label: string): string {
  const slug = slugLabel(label);
  if (!slug) throw new Error("give the backup a label, e.g. backup before-tag-cleanup");
  const p = localParts(at);
  return `${p.year}-${p.month}-${p.day}T${p.hour}${p.minute}${p.second}-${slug}.sqlite`;
}

/** When a backup was taken, from its name (the archive's copy's, or a module's), its local day and its label; null for any other name. */
export function parseBackupName(name: string): { at: number; day: string; label: string } | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  // The name is local wall-clock time: take it as UTC, then step back by
  // the archive's offset at that instant (checked twice, for the days the clocks change).
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(wall)) return null;
  const offset = (ms: number) => {
    const p = localParts(ms);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let at = wall - offset(wall);
  at = wall - offset(at);
  return { at, day: match.slice(1, 4).join("-"), label: match[7] };
}

/** Whether two parsed names are copies of the one backup. */
export const sameBackup = (a: { at: number; label: string }, b: { at: number; label: string }): boolean => a.at === b.at && a.label === b.label;

/**
 * Which of these file names the prune deletes: every backup older than 48
 * hours, and every one that is neither the newest of its local day nor
 * labelled before-import-. `keep`
 * (the backup just written) is never deleted, and names that are not backups
 * are left alone.
 */
export function backupsToDelete(names: string[], now: number, keep?: string): string[] {
  const backups = names.flatMap((name) => {
    const parsed = parseBackupName(name);
    return parsed ? [{ name, ...parsed }] : [];
  });
  const recent = backups.filter((b) => now - b.at <= BACKUP_MAX_AGE_MS);
  const newestOfDay = new Map<string, { at: number; label: string }>();
  for (const b of recent) {
    const newest = newestOfDay.get(b.day);
    if (!newest || b.at > newest.at || (b.at === newest.at && b.label > newest.label)) newestOfDay.set(b.day, b);
  }
  const kept = new Set(recent.filter((b) => sameBackup(newestOfDay.get(b.day)!, b) || b.label.startsWith(BEFORE_IMPORT_PREFIX)).map((b) => b.name));
  const written = keep === undefined ? null : parseBackupName(keep);
  return backups
    .filter((b) => !(written && sameBackup(written, b)) && !kept.has(b.name))
    .map((b) => b.name)
    .sort();
}

/** Deletes what the rule says goes from `dir` (a missing folder has nothing), and returns their names. */
export async function pruneBackups(dir: string, options: { now?: number; keep?: string; dryRun?: boolean } = {}): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const doomed = backupsToDelete(names, options.now ?? Date.now(), options.keep);
  if (!options.dryRun) for (const name of doomed) await rm(join(dir, name), { force: true });
  return doomed;
}

/** `pragma integrity_check` on a database file: "ok", or what is wrong. */
export function integrityCheck(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    return rows.map((row) => row.integrity_check).join("\n");
  } finally {
    db.close();
  }
}

export interface Backup {
  file: string;
  bytes: number;
  /** The copies of the modules' databases beside it. */
  modules: string[];
  /** The older backups the prune deleted after it. */
  pruned: string[];
}

/**
 * Copies the archive with VACUUM INTO (a consistent copy, even while the server
 * writes) to `file`, through `<file>.partial`, and checks the copy: one that
 * fails is removed and this throws. The NAS copy (nasBackup.ts) takes its copy
 * this way too.
 */
export async function checkedCopy(archiveFile: string, file: string, check: (file: string) => string = integrityCheck): Promise<number> {
  if (!existsSync(archiveFile)) throw new Error(`no archive at ${archiveFile}`);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  // Written under a name the prune ignores, and renamed once it has passed the check.
  const partial = `${file}.partial`;
  await rm(partial, { force: true });
  await mkdir(dirname(file), { recursive: true });
  const source = new DatabaseSync(archiveFile, { readOnly: true, timeout: 10_000 });
  try {
    source.prepare("VACUUM INTO ?").run(partial);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    source.close();
  }
  const result = check(partial);
  if (result !== "ok") {
    await rm(partial, { force: true });
    throw new Error(`the copy failed its integrity check, so it was removed:\n${result}`);
  }
  await rename(partial, file);
  return (await stat(file)).size;
}

/** Each module's database in the archive's folder `dataDir` (modules/<id>/<name>.sqlite), by module, named by its file. */
export async function moduleDatabases(dataDir: string): Promise<Array<{ file: string; name: string }>> {
  const modules = await readdir(join(dataDir, MODULES_FOLDER), { withFileTypes: true }).catch(() => []);
  const found: Array<{ file: string; name: string }> = [];
  for (const module of modules.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = await readdir(join(dataDir, MODULES_FOLDER, module.name)).catch(() => [] as string[]);
    for (const name of files.filter((f) => f.endsWith(".sqlite")).sort()) found.push({ file: join(dataDir, MODULES_FOLDER, module.name, name), name });
  }
  return found;
}

/**
 * A checked copy (checkedCopy) of the core's database in the archive's folder `dataDir` into `dir`, named for now and
 * the label, and of each module's database beside it (friend map's archive among them), then the prune.
 */
export async function createBackup(
  dataDir: string,
  dir: string,
  label: string,
  options: { now?: number; check?: (file: string) => string } = {},
): Promise<Backup> {
  const now = options.now ?? Date.now();
  const name = backupName(now, label);
  const file = join(dir, name);
  const bytes = await checkedCopy(join(dataDir, CORE_FILE), file, options.check);
  const modules: string[] = [];
  for (const database of await moduleDatabases(dataDir)) {
    const copy = file.replace(/\.sqlite$/, `.${database.name}`);
    await checkedCopy(database.file, copy, options.check);
    modules.push(copy);
  }
  const pruned = await pruneBackups(dir, { now, keep: name });
  return { file, bytes, modules, pruned };
}
