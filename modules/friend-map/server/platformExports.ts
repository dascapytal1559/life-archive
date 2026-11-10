// data/platform-exports/: every platform's exports, as they came, and its
// media with no export behind them (see mediaPaths.ts for how attachments
// point into it):
//
//   platform-exports/<platform>/<export date>/   one export: its zips, kept, beside what they unpack to
//   platform-exports/<platform>/live/            media a live connector downloaded, by content hash
//
// Exports used to wait in data/imports/<platform>-<date>/ (the platform's
// name, perhaps with the device it came from: whatsapp-iphone-2026-09-28);
// `planImportsMove` says where each goes, and `moveImports` moves them, one
// rename each, so nothing is copied. `unpackExport` unpacks an export's zips
// where they lie, since an export's media are kept in place and must be files.
// Nothing here deletes anything.

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { type Db, EXPORTS_FOLDER, type ZipEntry, ZipFile } from "../../../sdk/server.ts";

/** The folder exports used to wait in, relative to the data folder. */
export const IMPORTS_FOLDER = "imports";

/**
 * The platform an imports folder's name stands for, where it is not the
 * platform itself: the device an export came from is not kept in the new
 * layout, and the iPhone's address book (read by whatsapp-db and imessage-db
 * for names) is kept as "addressbook".
 */
const PLATFORM_OF: Record<string, string> = {
  "whatsapp-iphone": "whatsapp",
  "whatsapp-mac": "whatsapp",
  "imessage-iphone": "imessage",
  "imessage-mac": "imessage",
  "signal-desktop": "signal",
  "iphone-addressbook": "addressbook",
  facebook: "messenger",
  twitter: "x",
};

export interface ExportMove {
  /** Relative to the data folder: imports/<name>-<date>, or an entry in it. */
  from: string;
  /** Relative to the data folder: platform-exports/<platform>/<date>, or an entry in it. */
  to: string;
  /** Why it cannot move, when it cannot: something is already there. */
  blocked?: string;
}

export interface ImportsPlan {
  moves: ExportMove[];
  /** Folders in imports/ whose names give no date, left where they are. */
  unknown: string[];
}

/**
 * Where everything in data/imports/ goes: each <name>-<YYYY-MM-DD> folder
 * becomes platform-exports/<platform>/<date>/, or, when that folder exists
 * already (an export unpacked there before its zip moved), its entries go into
 * it one at a time, so an entry already there blocks only itself. Hidden files
 * at the top of imports/ (Finder's .DS_Store) stay.
 */
export async function planImportsMove(dataDir: string): Promise<ImportsPlan> {
  const imports = join(dataDir, IMPORTS_FOLDER);
  const plan: ImportsPlan = { moves: [], unknown: [] };
  const folders = (await readdir(imports, { withFileTypes: true }).catch(() => [])).filter((e) => !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    const match = /^(.+)-(\d{4}-\d{2}-\d{2})$/.exec(folder.name);
    if (!folder.isDirectory() || !match) {
      plan.unknown.push(folder.name);
      continue;
    }
    const platform = PLATFORM_OF[match[1]] ?? match[1];
    const destination = `${EXPORTS_FOLDER}/${platform}/${match[2]}`;
    if (!(await stat(join(dataDir, destination)).catch(() => null))) {
      plan.moves.push({ from: `${IMPORTS_FOLDER}/${folder.name}`, to: destination });
      continue;
    }
    for (const entry of (await readdir(join(imports, folder.name))).sort()) {
      const from = `${IMPORTS_FOLDER}/${folder.name}/${entry}`;
      const to = `${EXPORTS_FOLDER}/${platform}/${match[2]}/${entry}`;
      const there = await stat(join(dataDir, to)).catch(() => null);
      plan.moves.push({ from, to, ...(there ? { blocked: `${to} exists` } : {}) });
    }
  }
  return plan;
}

/** Makes the plan's moves that are not blocked, each one rename; an imports/<name>-<date>/ folder emptied by them goes, as rmdir would. */
export async function moveImports(dataDir: string, plan: ImportsPlan): Promise<{ moved: number; blocked: number }> {
  let moved = 0;
  for (const move of plan.moves) {
    if (move.blocked) continue;
    await mkdir(dirname(join(dataDir, move.to)), { recursive: true });
    // rename never replaces a folder, and the plan checked that nothing is there.
    if (await stat(join(dataDir, move.to)).catch(() => null)) throw new Error(`${move.to} appeared since the plan; nothing more moved`);
    await rename(join(dataDir, move.from), join(dataDir, move.to));
    moved++;
  }
  // rmdir removes only an empty folder: one whose every entry moved.
  for (const folder of new Set(plan.moves.map((m) => dirname(m.from)).filter((f) => f !== IMPORTS_FOLDER))) {
    await rmdir(join(dataDir, folder)).catch(() => undefined);
  }
  return { moved, blocked: plan.moves.filter((m) => m.blocked).length };
}

export interface UnpackCounts {
  zips: number;
  /** Files written. */
  written: number;
  writtenBytes: number;
  /** Files already there with the same size, left as they are (an earlier unpack, or a file repeated in several parts). */
  present: number;
  /** Files already there with a different size, left as they are (the first part's kept). */
  differ: number;
}

/**
 * Unpacks every zip at the top of an export's folder into that folder, where
 * the zips' files then lie as the export has them (a Meta download's parts
 * together make one tree). A zip stored at the top of a zip is more of the
 * export, as Meta's parts carry one, and is unpacked too. Each file is
 * written whole or not at all (through a hidden temporary file), checked
 * against the zip's checksum, and never written over: running it again
 * writes only what is missing. The zips stay.
 */
export async function unpackExport(folder: string, onProgress?: (done: number, total: number, name: string) => void): Promise<UnpackCounts> {
  const root = resolve(folder);
  const counts: UnpackCounts = { zips: 0, written: 0, writtenBytes: 0, present: 0, differ: 0 };
  const zips = (await readdir(root)).filter((name) => name.toLowerCase().endsWith(".zip") && !name.startsWith(".")).sort();
  for (const [i, name] of zips.entries()) {
    onProgress?.(i, zips.length, name);
    const zip = await ZipFile.open(join(root, name));
    try {
      await unpackZip(zip, root, name, counts);
    } finally {
      await zip.close();
    }
  }
  onProgress?.(zips.length, zips.length, "");
  return counts;
}

async function unpackZip(zip: ZipFile, root: string, label: string, counts: UnpackCounts): Promise<void> {
  counts.zips++;
  for (const entry of zip.entries) {
    if (entry.name.endsWith("/")) continue;
    const target = resolve(root, entry.name);
    const inside = relative(root, target);
    if (inside === "" || inside.startsWith("..") || inside.split(sep).includes("..")) {
      throw new Error(`${label} has an entry that would land outside the export's folder; nothing more unpacked`);
    }
    if (!entry.name.includes("/") && entry.name.toLowerCase().endsWith(".zip") && entry.method === 0 && entry.size > 0) {
      const nested = await zip.openNested(entry);
      try {
        await unpackZip(nested, root, `${entry.name} in ${label}`, counts);
      } finally {
        await nested.close();
      }
      continue;
    }
    const there = await stat(target).catch(() => null);
    if (there) {
      if (there.size === entry.size) counts.present++;
      else counts.differ++;
      continue;
    }
    await writeEntry(zip, entry, target, label);
    counts.written++;
    counts.writtenBytes += entry.size;
  }
}

/** Writes one entry to `target` through a temporary file beside it, checked against the zip's CRC-32 and size. */
async function writeEntry(zip: ZipFile, entry: ZipEntry, target: string, label: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.unpacking-${process.pid}-${Math.random().toString(16).slice(2)}`);
  let crc = 0;
  let size = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(await zip.stream(entry), check, createWriteStream(temporary, { flags: "wx" }));
    if (size !== entry.size || crc >>> 0 !== entry.crc32 >>> 0) throw new Error(`${entry.name} in ${label} does not match its checksum; nothing more unpacked`);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Points the archive's record of where each import came from (source.label)
 * at an export's new place: a source labelled with an imports folder's name
 * (as imports were labelled then), or with the date of the export folder of
 * its platform it was imported from, becomes that folder's path in the data
 * folder (platform-exports/<platform>/<date>), as imports are labelled now.
 * Returns how many sources changed.
 */
export function relabelSources(db: Db, plan: ImportsPlan): number {
  const relabel = db.prepare("UPDATE source SET label = ? WHERE label = ? AND platform = ?");
  let changed = 0;
  for (const to of new Set(plan.moves.filter((m) => !m.blocked).map((m) => m.to.split("/").slice(0, 3).join("/")))) {
    const [, platform, date] = to.split("/");
    const names = plan.moves.filter((m) => m.to.startsWith(`${to}`)).map((m) => m.from.split("/")[1]);
    for (const label of new Set([...names, date])) changed += Number(relabel.run(to, label, platform).changes);
  }
  return changed;
}
