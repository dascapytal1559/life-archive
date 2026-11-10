// The archive's modules/ folder as the NAS snapshot takes it (nasBackup.ts): a mirror in the staging folder, built
// afresh each night, of hard links to every file of the live folder, less what is left out (each module's databases,
// which go into the mirror as checked copies at their own paths instead, and the folders a module says to leave out).
//
// Why a mirror: restic puts a target at its path less the leading ../, and renames a second target landing on a name
// another took (/modules-1), which a restore would not put back. A database's checked copy cannot be made in the live
// folder, so the copies and the folder they belong in have to be one folder for restic: this one. A snapshot then
// holds each module's database at its own path (/modules/friend-map/archive.sqlite, /modules/rituals/data/ritual.sqlite3),
// so a restore puts every file back where it lives.
//
// A hard link costs nothing and holds the same bytes; a file on another volume (none is, today) is copied instead. A
// symbolic link is made again as a link, never followed, as restic keeps one. Deleting the mirror deletes the links,
// never what they point at.

import { copyFile, link, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { join, matchesGlob } from "node:path";

/**
 * Builds the mirror of `from` at `to` (which must not be there yet): its folders made, each file hard-linked, each
 * symbolic link made again; whatever an absolute pattern of `excludes` matches is left out, a folder with all it holds.
 * How many files it holds.
 */
export async function mirrorFolder(from: string, to: string, excludes: readonly string[]): Promise<number> {
  const left = (path: string) => excludes.some((pattern) => matchesGlob(path, pattern));
  let files = 0;
  const walk = async (dir: string, into: string): Promise<void> => {
    await mkdir(into, { recursive: true });
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (left(path)) continue;
      const target = join(into, entry.name);
      if (entry.isDirectory()) await walk(path, target);
      else if (entry.isSymbolicLink()) await symlink(await readlink(path), target);
      else if (entry.isFile()) {
        await link(path, target).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EXDEV") throw error;
          await copyFile(path, target);
        });
        files++;
      }
    }
  };
  if ((await lstat(from)).isDirectory()) await walk(from, to);
  return files;
}
