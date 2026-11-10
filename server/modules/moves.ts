// A module's files kept in the archive's folder outside its own modules/<id>/, from before each module kept its files
// there (health's health/, exercise's exercise.json): where each is read until it is moved, and the move itself.
//
// A module declares each (sdk/server.ts's `moves`: where it was, from the archive's folder, and where it goes, from
// modules/<id>/) and reads it through movedPath: at its new place once that is there, else at its old place while that
// is there, else at its new place (a new archive), a folder holding only what an operating system leaves in it
// (Finder's .DS_Store) counting as none. So an archive goes on unchanged until its owner moves its files, and a new one
// never makes the old places.
//
// The move is explicit, never done by the server: `npm run archive -- migrate module-data` says what it would move,
// and with --apply copies each old file or folder whole into data/backups-kept/<date>T<time>-before-module-data/ (kept,
// never pruned), checks the copy byte for byte, and only then renames it into the module's folder (one rename each,
// in the one archive's folder, so a file is never in two places nor in none). An old and a new place both there is
// refused, with nothing moved, until one is put aside by hand. Running it again moves what is left; once moved, nothing.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { backupName } from "../archive/backups.ts";

/** A file or folder a module kept outside its folder: `from`, from the archive's folder; `to`, from modules/<id>/ ("." for that folder itself). */
export interface ModuleMove {
  readonly from: string;
  readonly to: string;
}

/** The module's folder in the archive's folder. */
const moduleFolder = (folder: string, id: string) => join(folder, "modules", id);

/** A file an operating system leaves in a folder of its own accord (Finder's .DS_Store and ._ files, Windows' Thumbs.db and desktop.ini): no one's data. */
const isClutter = (name: string): boolean => name === ".DS_Store" || name.startsWith("._") || name === "Thumbs.db" || name === "desktop.ini";

/** Whether a file is there, or a folder with anything in it but clutter (a folder empty, or holding clutter alone, is as good as none). */
function present(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory() || readdirSync(path).some((name) => !isClutter(name));
  } catch {
    return false;
  }
}

/** Where the module reads a moved file or folder, as the top of this file says: its new place, else its old one while there, else the new one. */
export function movedPath(folder: string, id: string, move: ModuleMove): string {
  const now = join(moduleFolder(folder, id), move.to);
  if (present(now)) return now;
  const was = join(folder, move.from);
  return present(was) ? was : now;
}

/** One declared move, as the archive's folder has it now. */
export interface PlannedMove {
  readonly id: string;
  /** Both paths, absolute. */
  readonly from: string;
  readonly to: string;
  /** "move": still at its old place; "moved": at its new one; "none": at neither; "both": at both, refused. */
  readonly state: "move" | "moved" | "none" | "both";
}

/** Every move the modules declare, as the archive's folder has them. */
export function planModuleMoves(folder: string, modules: ReadonlyArray<{ readonly id: string; readonly moves?: readonly ModuleMove[] }>): PlannedMove[] {
  return modules.flatMap(({ id, moves = [] }) =>
    moves.map((move) => {
      const from = join(folder, move.from);
      const to = join(moduleFolder(folder, id), move.to);
      const [old, now] = [present(from), present(to)];
      return { id, from, to, state: old && now ? "both" : old ? "move" : now ? "moved" : "none" } as const;
    }));
}

/** What the server says as it starts of the files still at their old places: a line each, and how to move them. */
export function pendingMoveLines(folder: string, planned: readonly PlannedMove[]): string[] {
  return planned.flatMap(({ id, from, to, state }) => {
    if (state === "move") return [`${id} reads ${relative(folder, from)} at its old place: npm run archive -- migrate module-data moves it to ${relative(folder, to)}`];
    if (state === "both") return [`${id} has both ${relative(folder, from)} and ${relative(folder, to)}, and reads the second: put one aside (npm run archive -- migrate module-data says so too)`];
    return [];
  });
}

/** Every file under `path` (itself, when it is a file), by its path from `path`, with its bytes' hash (a link's, its target's name). */
async function fingerprint(path: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (at: string, name: string): Promise<void> => {
    const stat = await lstat(at);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(at)).sort()) await walk(join(at, entry), name ? `${name}/${entry}` : entry);
      if (name) found.set(`${name}/`, "folder");
    } else {
      const bytes = stat.isSymbolicLink() ? Buffer.from(`link:${await readlink(at)}`) : await readFile(at);
      found.set(name, createHash("sha256").update(bytes).digest("hex"));
    }
  };
  await walk(path, "");
  return found;
}

/** The moves done or to do, said a line each; with `apply`, made as the top of this file says. */
export async function moveModuleData(folder: string, planned: readonly PlannedMove[], { apply, now = Date.now() }: { apply: boolean; now?: number }): Promise<string[]> {
  const both = planned.filter((m) => m.state === "both");
  if (both.length > 0) {
    throw new Error(both.map(({ id, from, to }) => `${id}: both ${relative(folder, from)} and ${relative(folder, to)} are there, so nothing was moved; keep one (put the other aside, outside the archive's folder) and run this again`).join("\n"));
  }
  const lines = planned.flatMap(({ id, from, to, state }) => (state === "moved" ? [`${id}: ${relative(folder, to)} is in its place already.`] : []));
  const todo = planned.filter((m) => m.state === "move");
  if (todo.length === 0) return [...lines, "Nothing to move."];
  if (!apply) return [...lines, ...todo.map(({ id, from, to }) => `${id}: would move ${relative(folder, from)} to ${relative(folder, to)}.`), "A dry run: nothing was moved. Run it again with --apply to move them after a backup."];
  const backup = join(folder, "backups-kept", backupName(now, "before module data").replace(/\.sqlite$/, ""));
  if (existsSync(backup)) throw new Error(`${relative(folder, backup)} is there already; wait a second and run this again`);
  for (const { id, from, to } of todo) {
    const copy = join(backup, relative(folder, from));
    await mkdir(dirname(copy), { recursive: true });
    await cp(from, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    const [kept, copied] = [await fingerprint(from), await fingerprint(copy)];
    if (kept.size !== copied.size || [...kept].some(([name, hash]) => copied.get(name) !== hash)) {
      throw new Error(`${id}: the backup of ${relative(folder, from)} at ${relative(folder, copy)} is not the same, so it was not moved`);
    }
    await mkdir(dirname(to), { recursive: true });
    // A folder in the way that is empty, or holds clutter alone (an empty module folder), is no place taken.
    if (existsSync(to)) {
      for (const name of (await readdir(to)).filter(isClutter)) await rm(join(to, name), { force: true });
      await rmdir(to);
    }
    await rename(from, to);
    lines.push(`${id}: moved ${relative(folder, from)} to ${relative(folder, to)} (${kept.size} ${kept.size === 1 ? "entry" : "entries"}), after a checked copy in ${relative(folder, copy)}.`);
  }
  return lines;
}
