// Small file helpers shared by the server and, through the SDK, the modules.
//
// Both writers make a file whole or not at all, as rituals' own writer does (modules/rituals/src/files.ts): the
// contents go to a hidden temporary file beside it, synced to disk, which is then renamed or linked into place, and the
// folder is synced too, so the new name survives a crash as well as the new bytes. The temporary file is hidden (a dot
// first) so a folder something else watches (the vault, which Obsidian and iCloud Drive read) never shows it.

import { randomBytes } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface WriteOptions {
  /** The file's mode when it is made (the umask still applies): 0o666 unless said. */
  mode?: number;
}

/** The hidden temporary file beside `path` its contents are written to first. */
function temporaryFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
}

/** Writes `contents` to a new file at `temporary`, synced to disk. */
async function writeSynced(temporary: string, contents: string | Uint8Array, mode: number): Promise<void> {
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Syncs a folder, so a name just made or changed in it is on disk. */
export async function syncFolder(folder: string): Promise<void> {
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes a file whole, in place of any there: the file is the old one or the new one, never part of either. */
export async function atomicWrite(path: string, contents: string | Uint8Array, { mode = 0o666 }: WriteOptions = {}): Promise<void> {
  const temporary = temporaryFor(path);
  try {
    await writeSynced(temporary, contents, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncFolder(dirname(path));
}

/**
 * Writes a file once, never over one already there: whole, as atomicWrite writes, then linked into place (which fails
 * when the name is taken). Says whether it wrote it; one already there is left as it is.
 */
export async function writeOnce(path: string, contents: string | Uint8Array, { mode = 0o666 }: WriteOptions = {}): Promise<boolean> {
  const temporary = temporaryFor(path);
  try {
    await writeSynced(temporary, contents, mode);
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  await syncFolder(dirname(path));
  return true;
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
