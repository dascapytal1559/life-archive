// Where attachment files are, as attachment.local_path records them: relative
// to the data folder, and always inside one of two folders there:
//
//   platform-exports/   every platform's exports, unpacked as they came, and its media with no export:
//     <platform>/<export date>/       an export (a zip kept beside what it unpacked to), whose files
//                                     are kept in place, never copied
//     <platform>/live/<xx>/<sha256>   copies of media with no export behind them (what a live
//                                     connector downloads), named by content hash (see connectors/media.ts)
//   archive/media/      the copies connectors made before platform-exports/ (see platformExports.ts);
//                       still served while anything points at them, never written to
//
// Nothing else under data/ (the archive itself, backups, settings) is ever
// an attachment's file, whatever a stored path or a symlink says.

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AttachmentEvent } from "../connectors/contract.ts";
import { LIVE_FOLDER } from "../connectors/media.ts";

/** The folder connectors copied media into before platform-exports/, relative to the data folder; read, never written. */
export const COPIES_FOLDER = "archive/media";
/** The folder of every platform's exports and live media, relative to the data folder. */
export const EXPORTS_FOLDER = "platform-exports";

/** The local_path an attachment event gives its file, or null when the source lacked it. Throws for a file kept in place outside data/platform-exports/. */
export function localPathOf(event: Pick<AttachmentEvent, "stored" | "inPlace">, dataDir: string | undefined): string | null {
  if (event.stored) return `${EXPORTS_FOLDER}/${event.stored.path}`;
  if (!event.inPlace) return null;
  if (!dataDir) throw new Error("a file kept in place needs the data folder to record where it is");
  const path = relative(resolve(dataDir), resolve(event.inPlace.path));
  if (!isInside(EXPORTS_FOLDER, path)) {
    throw new Error(`media kept in place must be inside ${resolve(dataDir, EXPORTS_FOLDER)}; unpack the export there (${event.inPlace.path} is not)`);
  }
  return path.split(sep).join("/");
}

/** Where a local_path's file lives: one export of a platform (its folder's name, a date or "live"), or an old copy in archive/media/. */
export type MediaHome =
  | { kind: "export"; platform: string; folder: string }
  | { kind: "copies"; platform: string };

/** The home a local_path is in, or null for a path in neither folder. */
export function homeOf(localPath: string): MediaHome | null {
  const parts = localPath.split("/");
  if (parts.includes("..")) return null;
  if (parts[0] === EXPORTS_FOLDER && parts.length >= 4) return { kind: "export", platform: parts[1], folder: parts[2] };
  const copies = COPIES_FOLDER.split("/");
  if (copies.every((part, i) => parts[i] === part) && parts.length > copies.length + 1) return { kind: "copies", platform: parts[copies.length] };
  return null;
}

/**
 * How current a file's home is, as a string that sorts: any export over the
 * live folder, and the live folder over an old copy in archive/media/; a later
 * export over an earlier one, since export folders are named by their date
 * (YYYY-MM-DD). When two imports give one attachment a file, the archive keeps
 * the one in the more current home (see write.ts), so it points at the newest
 * export holding the file, whatever order the exports were imported in.
 */
export function homeRank(localPath: string): string {
  const home = homeOf(localPath);
  if (!home || home.kind === "copies") return "0";
  return home.folder === LIVE_FOLDER ? "1" : `2${home.folder}`;
}

/**
 * The file a local_path names, resolved through any symlinks, or null when it
 * is not inside archive/media/ or platform-exports/ of the data folder. Throws ENOENT
 * when it is not there.
 */
export async function resolveLocalPath(dataDir: string, localPath: string): Promise<string | null> {
  const root = await realpath(resolve(dataDir));
  const path = await realpath(resolve(root, localPath));
  const inside = relative(root, path);
  return isInside(COPIES_FOLDER, inside) || isInside(EXPORTS_FOLDER, inside) ? path : null;
}

/** Whether a path relative to the data folder is strictly inside `folder` there. */
export function isInside(folder: string, path: string): boolean {
  if (isAbsolute(path)) return false;
  const parts = path.split(sep);
  const prefix = folder.split("/");
  return parts.length > prefix.length && prefix.every((part, i) => parts[i] === part) && !parts.includes("..");
}
