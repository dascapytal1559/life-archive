// The files the inspirations keep (a photo or screenshot sent with a capture, a shared text kept as a file, a
// preview's picture), in the module's own folder of the archive's folder, each by its content's hash:
//
//   modules/inspirations/files/<first two hex digits>/<sha256>.<ext>
//
// and named in inspiration_file by its path from the module's folder (files/<ab>/<sha256>.<ext>). The bytes are only
// streamed through a hash, never decoded or looked at. Before the inspirations were a module they were kept in the
// platforms' exports (platform-exports/inspirations/live/), named from the archive's folder; the take-over (db.ts)
// copied them here and left those where they were.

import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { hashedPath, keepByHash } from "../../../sdk/server.ts";
import type { KeptFile } from "./store.ts";

/** The module's id: its folder's name in modules/ of the checkout and of the archive's folder. */
export const INSPIRATIONS = "inspirations";

/** The folder of the module's folder its files are kept in. */
export const FILES_FOLDER = "files";

/** The module's folder in the archive's folder `folder`: where its database and its files are. */
export const inspirationsFolder = (folder: string): string => join(folder, "modules", INSPIRATIONS);

/** Where a file of hash `sha256` is kept, from the module's folder, its extension `fileName`'s. */
export const keptPath = (sha256: string, fileName: string): string => join(FILES_FOLDER, hashedPath(sha256, fileName));

/** What a kept file's path looks like (check-data holds every one to it). */
export const KEPT_PATH = /^files\/[0-9a-f]{2}\/[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/;

/** Keeps `bytes` (a file named `fileName`, of type `mime`) by its hash in the module's folder `moduleFolder`. */
export async function keepFile(moduleFolder: string, bytes: Readable, fileName: string, mime: string): Promise<KeptFile> {
  // Written first into the module's .incoming/, beside files/ rather than in it, so files/ holds whole files alone.
  const kept = await keepByHash(join(moduleFolder, FILES_FOLDER), bytes, fileName, join(moduleFolder, ".incoming"));
  return { path: join(FILES_FOLDER, kept.path), mime, bytes: kept.size, sha256: kept.sha256 };
}

/**
 * Where the kept file `path` (from the module's folder `moduleFolder`) is on disk, once its links are followed; null
 * when that is not inside the module's files/ (a path that climbs out, or a link pointing elsewhere). Throws ENOENT
 * when it is not there.
 */
export async function keptFileAt(moduleFolder: string, path: string): Promise<string | null> {
  if (isAbsolute(path)) return null;
  const files = await realpath(join(moduleFolder, FILES_FOLDER));
  const found = await realpath(resolve(moduleFolder, path));
  const inside = relative(files, found);
  return inside !== "" && !isAbsolute(inside) && !inside.split(sep).includes("..") ? found : null;
}
