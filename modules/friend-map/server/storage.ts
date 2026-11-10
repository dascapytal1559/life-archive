// What the data folder holds, and for whom: all of it, and per platform its
// messages (its share of archive.sqlite), its exports under platform-exports/
// (the zips as they came, and what they unpacked to), its live folder, the
// media its attachments point at, and the copies in archive/media/ that nothing
// points at any more (see repoint.ts). Sizes only: no file is opened, and the
// archive is only read.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { COPIES_FOLDER, type Db, EXPORTS_FOLDER, homeOf, LIVE_FOLDER } from "../../../sdk/server.ts";

export interface ExportStorage {
  /** The export's folder under platform-exports/<platform>/: its date, or "live". */
  folder: string;
  bytes: number;
  /** The zips at its top, kept as they came. */
  zipBytes: number;
  /** The files its attachments point at. */
  referencedFiles: number;
  referencedBytes: number;
}

export interface PlatformStorage {
  platform: string;
  messages: number;
  /** The platform's share of archive.sqlite: its messages' rows, text index, versions, aliases, reactions and attachments' rows. */
  messageBytes: number;
  exports: ExportStorage[];
  /** Distinct files its attachments point at, wherever they are, and those still on an old copy in archive/media/. */
  mediaFiles: number;
  mediaBytes: number;
  copiesReferencedFiles: number;
  copiesReferencedBytes: number;
  /** Copies in archive/media/<platform>/ nothing points at. */
  unreferencedCopyFiles: number;
  unreferencedCopyBytes: number;
}

export interface StorageReport {
  /** Everything under the data folder (a file linked twice counted once). */
  totalBytes: number;
  /** archive.sqlite with its write-ahead log. */
  archiveBytes: number;
  /** The part of archive.sqlite that is messages (shared out among the platforms), and the rest (people, changes, indexes of no one platform). */
  messageTablesBytes: number;
  /** Each folder and file at the top of the data folder. */
  top: Array<{ name: string; bytes: number }>;
  platforms: PlatformStorage[];
}

/** The tables whose rows belong to one platform's messages, shared among the platforms by the size of their messages' records. */
const MESSAGE_TABLES = new Set(["message", "message_fts", "message_fts_data", "message_fts_idx", "message_fts_docsize", "message_fts_config", "message_version", "message_alias", "message_chars", "reaction", "attachment"]);

/** friend map's archive in the archive's folder `dataDir`. */
export const archivePath = (dataDir: string): string => join(dataDir, "modules", "friend-map", "archive.sqlite");

export async function storageReport(db: Db, dataDir: string): Promise<StorageReport> {
  const sizes = new FolderSizes();
  const top: Array<{ name: string; bytes: number }> = [];
  for (const name of (await readdir(dataDir)).sort((a, b) => a.localeCompare(b))) {
    // A link is named as what it points at (the vault is a link into iCloud Drive).
    const folder = (await stat(join(dataDir, name)).catch(() => null))?.isDirectory();
    top.push({ name: folder ? `${name}/` : name, bytes: await sizes.of(join(dataDir, name)) });
  }
  const totalBytes = top.reduce((sum, t) => sum + t.bytes, 0);
  // The archive with its write-ahead log, in the module's folder.
  const archiveBytes = (await Promise.all(["", "-wal"].map((suffix) => stat(`${archivePath(dataDir)}${suffix}`).then((s) => s.size, () => 0)))).reduce((a, b) => a + b, 0);

  // Pages of each table and its indexes (dbstat), shared out by each platform's bytes of message records.
  const pages = db.prepare(
    `SELECT coalesce(m.tbl_name, d.name) AS tbl, sum(d.pgsize) AS bytes FROM dbstat d LEFT JOIN sqlite_schema m ON m.name = d.name GROUP BY tbl`,
  ).all() as Array<{ tbl: string; bytes: number }>;
  const messageTablesBytes = pages.filter((p) => MESSAGE_TABLES.has(p.tbl)).reduce((sum, p) => sum + p.bytes, 0);
  const weights = db.prepare(
    `SELECT platform, count(*) AS messages, sum(length(CAST(raw_json AS BLOB)) + coalesce(length(CAST(text AS BLOB)), 0)) AS weight FROM message GROUP BY platform`,
  ).all() as Array<{ platform: string; messages: number; weight: number }>;
  const allWeight = weights.reduce((sum, w) => sum + w.weight, 0) || 1;

  // The files the attachments point at, once each.
  const media = new Map<string, number>();
  for (const { path, size } of db.prepare("SELECT local_path AS path, max(coalesce(size, 0)) AS size FROM attachment WHERE local_path IS NOT NULL GROUP BY local_path").all() as Array<{ path: string; size: number }>) {
    media.set(path, size);
  }

  const platformNames = new Set<string>([
    ...weights.map((w) => w.platform),
    ...(await subfolders(join(dataDir, EXPORTS_FOLDER))),
    ...(await subfolders(join(dataDir, COPIES_FOLDER))),
  ]);
  const platforms: PlatformStorage[] = [];
  for (const platform of [...platformNames].sort()) {
    const weight = weights.find((w) => w.platform === platform);
    const report: PlatformStorage = {
      platform, messages: weight?.messages ?? 0, messageBytes: Math.round(messageTablesBytes * (weight?.weight ?? 0) / allWeight), exports: [],
      mediaFiles: 0, mediaBytes: 0, copiesReferencedFiles: 0, copiesReferencedBytes: 0, unreferencedCopyFiles: 0, unreferencedCopyBytes: 0,
    };
    platforms.push(report);
    for (const folder of await subfolders(join(dataDir, EXPORTS_FOLDER, platform))) {
      const root = join(dataDir, EXPORTS_FOLDER, platform, folder);
      const zips = (await readdir(root, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".zip"));
      let zipBytes = 0;
      for (const zip of zips) zipBytes += (await stat(join(root, zip.name))).size;
      report.exports.push({ folder, bytes: await sizes.of(root), zipBytes, referencedFiles: 0, referencedBytes: 0 });
    }
    // Live first, then the exports newest first, as the archive prefers them.
    report.exports.sort((a, b) => (a.folder === LIVE_FOLDER ? -1 : b.folder === LIVE_FOLDER ? 1 : b.folder.localeCompare(a.folder)));
  }
  const byName = new Map(platforms.map((p) => [p.platform, p]));
  const copiesReferenced = new Set<string>();
  for (const [path, size] of media) {
    const home = homeOf(path);
    const report = home && byName.get(home.platform);
    if (!home || !report) continue;
    report.mediaFiles++;
    report.mediaBytes += size;
    if (home.kind === "copies") {
      copiesReferenced.add(path);
      report.copiesReferencedFiles++;
      report.copiesReferencedBytes += size;
    } else {
      const folder = report.exports.find((e) => e.folder === home.folder);
      if (folder) {
        folder.referencedFiles++;
        folder.referencedBytes += size;
      }
    }
  }
  for (const report of platforms) {
    const root = join(dataDir, COPIES_FOLDER, report.platform);
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const path = join(entry.parentPath, entry.name);
      if (copiesReferenced.has(`${COPIES_FOLDER}/${report.platform}/${path.slice(root.length + 1).split("\\").join("/")}`)) continue;
      report.unreferencedCopyFiles++;
      report.unreferencedCopyBytes += (await stat(path)).size;
    }
  }
  return { totalBytes, archiveBytes, messageTablesBytes, top, platforms };
}

async function subfolders(folder: string): Promise<string[]> {
  return (await readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** Bytes under a path, each file counted once however many links it has (an APFS clone, which shares its blocks, is counted in full). */
class FolderSizes {
  private readonly seen = new Set<string>();

  async of(path: string): Promise<number> {
    const info = await stat(path).catch(() => null);
    if (!info) return 0;
    if (!info.isDirectory()) return this.count(info);
    let bytes = 0;
    for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      bytes += this.count(await stat(join(entry.parentPath, entry.name)));
    }
    return bytes;
  }

  private count(info: { dev: number; ino: number; size: number; nlink: number }): number {
    if (info.nlink <= 1) return info.size;
    const key = `${info.dev}:${info.ino}`;
    if (this.seen.has(key)) return 0;
    this.seen.add(key);
    return info.size;
  }
}
