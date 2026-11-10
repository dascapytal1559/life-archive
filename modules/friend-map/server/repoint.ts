// Re-points attachments from the copies connectors used to make in
// data/archive/media/ to their homes under data/platform-exports/ (see
// mediaPaths.ts): the same file in an export, or, for media with no export
// behind them (what a live connector downloaded), a copy in the platform's
// live folder.
//
//   planRepoint    reads the archive and the files, writes nothing: for every attachment still on a copy,
//                  the file in the newest export of its platform with the same size and SHA-256 (its copy
//                  checked against the same), else a live home when a live connector brought it, else why
//                  it cannot be matched
//   applyRepoint   makes the live copies (clones where the disk can, each checked), logs every change to
//                  data/archive/repoint-<time>.jsonl, then points the attachments at their homes in one
//                  transaction, each only if it still points where the plan found it
//   unreferencedCopies   which copies in archive/media/ nothing points at any more, per platform
//
// Nothing here deletes a copy or an export: what is left in archive/media/ is
// for the captain to delete, or not. Files are hashed, never opened as media.

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { COPIES_FOLDER, type Db, EXPORTS_FOLDER, homeOf, LIVE_FOLDER, type StoredMedia, transaction } from "../../../sdk/server.ts";

export interface RepointChange {
  attachment: number;
  platform: string;
  /** Relative to the data folder: the copy in archive/media/ it points at now. */
  from: string;
  /** Relative to the data folder: its home under platform-exports/. */
  to: string;
  kind: "export" | "live";
  sha256: string;
  size: number;
}

export interface PlatformRepoint {
  platform: string;
  /** Attachments of the platform, and how many of them the source lacked (no file). */
  attachments: number;
  missing: number;
  /** Already pointing under platform-exports/. */
  home: number;
  /** To re-point to a file in an export, and to a copy in the live folder. */
  toExport: number;
  toLive: number;
  /** Left on a copy in archive/media/, by why. */
  unmatched: Record<string, number>;
  /** The distinct files and bytes of each kind of change. */
  toExportFiles: number;
  toExportBytes: number;
  toLiveFiles: number;
  toLiveBytes: number;
  /** The copies the changes leave, checked against the record: same size and SHA-256, or not, or not there. */
  copiesChecked: number;
  copiesDiffer: number;
  copiesMissing: number;
  /** The export folders searched, newest first. */
  exports: string[];
}

export interface RepointPlan {
  platforms: PlatformRepoint[];
  changes: RepointChange[];
}

interface Row {
  id: number;
  platform: string;
  sha256: string | null;
  size: number | null;
  local_path: string | null;
  source_kind: string;
}

type Progress = (note: string) => void;

/** What re-pointing would do: reads the archive and the files under data/, writes nothing. */
export async function planRepoint(db: Db, dataDir: string, onProgress: Progress = () => {}): Promise<RepointPlan> {
  const rows = db.prepare(
    `SELECT a.id, m.platform, a.sha256, a.size, a.local_path, s.kind AS source_kind
     FROM attachment a JOIN message m ON m.id = a.message_id JOIN source s ON s.id = a.source_id ORDER BY a.id`,
  ).all() as unknown as Row[];
  const byPlatform = new Map<string, Row[]>();
  for (const row of rows) byPlatform.set(row.platform, [...(byPlatform.get(row.platform) ?? []), row]);

  const plan: RepointPlan = { platforms: [], changes: [] };
  const hashes = new HashCache(onProgress);
  for (const [platform, list] of [...byPlatform].sort(([a], [b]) => a.localeCompare(b))) {
    const report: PlatformRepoint = {
      platform, attachments: list.length, missing: 0, home: 0, toExport: 0, toLive: 0, unmatched: {},
      toExportFiles: 0, toExportBytes: 0, toLiveFiles: 0, toLiveBytes: 0, copiesChecked: 0, copiesDiffer: 0, copiesMissing: 0, exports: [],
    };
    plan.platforms.push(report);
    const unmatched = (why: string) => (report.unmatched[why] = (report.unmatched[why] ?? 0) + 1);
    const onCopies: Row[] = [];
    for (const row of list) {
      if (row.local_path === null) report.missing++;
      else if (homeOf(row.local_path)?.kind === "export") report.home++;
      else if (homeOf(row.local_path)?.kind === "copies") onCopies.push(row);
      else unmatched("a path in neither archive/media/ nor platform-exports/");
    }
    if (onCopies.length === 0) continue;

    // Every file of the platform's exports whose size an attachment has, hashed, the newest export first.
    report.exports = await exportFolders(dataDir, platform);
    const wanted = new Set(onCopies.map((row) => row.size));
    const found = new Map<string, string>();
    for (const folder of report.exports) {
      const files = await filesUnder(join(dataDir, EXPORTS_FOLDER, platform, folder));
      const sized = files.filter((file) => wanted.has(file.size));
      onProgress(`${platform}/${folder}: hashing ${sized.length} of its ${files.length} files whose size an attachment has`);
      for (const { path, size } of sized) {
        const sha256 = await hashes.of(path);
        const key = `${sha256}:${size}`;
        if (!found.has(key)) found.set(key, `${EXPORTS_FOLDER}/${platform}/${folder}/${path.slice(join(dataDir, EXPORTS_FOLDER, platform, folder).length + 1).split("\\").join("/")}`);
      }
    }

    const counted = { export: new Set<string>(), live: new Set<string>() };
    for (const row of onCopies) {
      if (row.sha256 === null || row.size === null) {
        unmatched("no checksum recorded");
        continue;
      }
      const copy = join(dataDir, row.local_path!);
      const inExport = found.get(`${row.sha256}:${row.size}`);
      const kind = inExport ? "export" : row.source_kind === "live" ? "live" : null;
      if (!kind) {
        unmatched(report.exports.length === 0 ? `no export of ${platform} under platform-exports/` : "not in any export (same size and SHA-256)");
        continue;
      }
      // The copy is checked too: a live home is made from it, and an export's file replaces it.
      const there = await stat(copy).catch(() => null);
      if (!there) report.copiesMissing++;
      else if (there.size !== row.size || (await hashes.of(copy)) !== row.sha256) report.copiesDiffer++;
      else report.copiesChecked++;
      if (kind === "live" && (!there || there.size !== row.size || (await hashes.of(copy)) !== row.sha256)) {
        unmatched("a live copy whose file is gone or differs from the record");
        continue;
      }
      const to = inExport ?? `${EXPORTS_FOLDER}/${platform}/${LIVE_FOLDER}/${row.sha256.slice(0, 2)}/${row.sha256}${extname(row.local_path!).toLowerCase()}`;
      plan.changes.push({ attachment: row.id, platform, from: row.local_path!, to, kind, sha256: row.sha256, size: row.size });
      if (kind === "export") report.toExport++;
      else report.toLive++;
      if (!counted[kind].has(to)) {
        counted[kind].add(to);
        if (kind === "export") {
          report.toExportFiles++;
          report.toExportBytes += row.size;
        } else {
          report.toLiveFiles++;
          report.toLiveBytes += row.size;
        }
      }
    }
  }
  return plan;
}

export interface RepointResult {
  repointed: number;
  /** Attachments that no longer pointed where the plan found them, left as they are. */
  changedSince: number;
  liveCopiesMade: number;
  log: string;
  /** Ledger entries carried to the live connectors' ledgers under platform-exports/.ledger/. */
  ledgerEntries: number;
}

/** Makes the plan: live copies first, then the log, then the attachments in one transaction. */
export async function applyRepoint(db: Db, dataDir: string, plan: RepointPlan, onProgress: Progress = () => {}): Promise<RepointResult> {
  let liveCopiesMade = 0;
  const made = new Set<string>();
  for (const change of plan.changes) {
    if (change.kind !== "live" || made.has(change.to)) continue;
    made.add(change.to);
    if (await makeLiveCopy(join(dataDir, change.from), join(dataDir, change.to), change)) liveCopiesMade++;
    if (made.size % 500 === 0) onProgress(`${made.size} live copies checked`);
  }

  // UTC, to the second: 20261005T060812Z.
  const stamp = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const log = join(dataDir, "archive", `repoint-${stamp}.jsonl`);
  await mkdir(dirname(log), { recursive: true });
  await writeFile(log, plan.changes.map((c) => JSON.stringify(c)).join("\n") + (plan.changes.length ? "\n" : ""), { flag: "wx" });

  const repointed = transaction(db, () => {
    const update = db.prepare("UPDATE attachment SET local_path = ? WHERE id = ? AND local_path = ?");
    let n = 0;
    for (const change of plan.changes) n += Number(update.run(change.to, change.attachment, change.from).changes);
    return n;
  });
  const ledgerEntries = await carryLedgers(dataDir, plan);
  return { repointed, changedSince: plan.changes.length - repointed, liveCopiesMade, log, ledgerEntries };
}

/** Clones (or copies) the copy to its live home through a temporary file, checked; false when the same file is there already. */
async function makeLiveCopy(from: string, to: string, change: RepointChange): Promise<boolean> {
  const there = await stat(to).catch(() => null);
  if (there && there.size === change.size && (await sha256File(to)) === change.sha256) return false;
  if (there) throw new Error(`${to} is there already and is not the same file; nothing re-pointed`);
  await mkdir(dirname(to), { recursive: true });
  const temporary = join(dirname(to), `.incoming-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    await copyFile(from, temporary, constants.COPYFILE_FICLONE);
    if ((await sha256File(temporary)) !== change.sha256) throw new Error(`the copy of ${from} does not match its record; nothing re-pointed`);
    await rename(temporary, to);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

/**
 * The live connectors' ledgers (archive/media/.ledger/<connector>.jsonl, what
 * each had downloaded) carried to platform-exports/.ledger/, for the entries
 * whose copy now has a live home, so a later read does not download them
 * again. The old ledgers stay.
 */
async function carryLedgers(dataDir: string, plan: RepointPlan): Promise<number> {
  const moved = new Map(plan.changes.filter((c) => c.kind === "live").map((c) => [c.from, c.to]));
  const oldDir = join(dataDir, COPIES_FOLDER, ".ledger");
  const newDir = join(dataDir, EXPORTS_FOLDER, ".ledger");
  let carried = 0;
  for (const name of (await readdir(oldDir).catch(() => [])).filter((n) => n.endsWith(".jsonl"))) {
    const known = new Set<string>();
    for (const line of (await readFile(join(newDir, name), "utf8").catch(() => "")).split("\n")) {
      try {
        known.add((JSON.parse(line) as { key: string }).key);
      } catch {
        // An empty or cut-short line.
      }
    }
    const lines: string[] = [];
    for (const line of (await readFile(join(oldDir, name), "utf8")).split("\n")) {
      let entry: { key: string; stored: StoredMedia };
      try {
        entry = JSON.parse(line) as { key: string; stored: StoredMedia };
      } catch {
        continue;
      }
      const to = moved.get(`${COPIES_FOLDER}/${entry.stored.path}`);
      if (!to || known.has(entry.key)) continue;
      known.add(entry.key);
      lines.push(JSON.stringify({ key: entry.key, stored: { ...entry.stored, path: to.slice(EXPORTS_FOLDER.length + 1) } }));
    }
    if (lines.length === 0) continue;
    await mkdir(newDir, { recursive: true });
    await appendFile(join(newDir, name), `${lines.join("\n")}\n`);
    carried += lines.length;
  }
  return carried;
}

export interface UnreferencedCopies {
  platform: string;
  /** Every copy in archive/media/<platform>/, and those nothing points at. */
  files: number;
  bytes: number;
  unreferencedFiles: number;
  unreferencedBytes: number;
  /** Attachments of the platform still pointing into archive/media/. */
  stillReferenced: number;
}

/** Per platform, the copies in archive/media/ that no attachment points at (as the archive is now, or as `plan` would leave it). */
export async function unreferencedCopies(db: Db, dataDir: string, plan?: RepointPlan): Promise<UnreferencedCopies[]> {
  const moved = new Map(plan?.changes.map((c) => [c.attachment, c.to]) ?? []);
  const referenced = new Set<string>();
  const still = new Map<string, number>();
  for (const { id, local_path } of db.prepare("SELECT id, local_path FROM attachment WHERE local_path IS NOT NULL").all() as Array<{ id: number; local_path: string }>) {
    const path = moved.get(id) ?? local_path;
    const home = homeOf(path);
    if (home?.kind !== "copies") continue;
    referenced.add(path);
    still.set(home.platform, (still.get(home.platform) ?? 0) + 1);
  }
  const result: UnreferencedCopies[] = [];
  const root = join(dataDir, COPIES_FOLDER);
  for (const platform of (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort()) {
    const report: UnreferencedCopies = { platform, files: 0, bytes: 0, unreferencedFiles: 0, unreferencedBytes: 0, stillReferenced: still.get(platform) ?? 0 };
    for (const file of await filesUnder(join(root, platform))) {
      report.files++;
      report.bytes += file.size;
      const path = `${COPIES_FOLDER}/${platform}/${file.path.slice(join(root, platform).length + 1).split("\\").join("/")}`;
      if (referenced.has(path)) continue;
      report.unreferencedFiles++;
      report.unreferencedBytes += file.size;
    }
    result.push(report);
  }
  return result;
}

/** A platform's export folders (its dated exports, not its live folder), newest first. */
export async function exportFolders(dataDir: string, platform: string): Promise<string[]> {
  return (await readdir(join(dataDir, EXPORTS_FOLDER, platform), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== LIVE_FOLDER)
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Every file under a folder, by path, passing over hidden files and folders. */
export async function filesUnder(folder: string): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
  const files: Array<{ path: string; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.slice(folder.length + 1).split(/[/\\]/).some((part) => part.startsWith("."))) continue;
    files.push({ path, size: (await stat(path)).size });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Each file hashed once, however often it is asked for. */
class HashCache {
  private readonly hashes = new Map<string, string>();
  private hashed = 0;
  private bytes = 0;
  private readonly onProgress: Progress;

  constructor(onProgress: Progress) {
    this.onProgress = onProgress;
  }

  async of(path: string): Promise<string> {
    const known = this.hashes.get(path);
    if (known) return known;
    const sha256 = await sha256File(path);
    this.hashes.set(path, sha256);
    this.hashed++;
    this.bytes += (await stat(path)).size;
    if (this.hashed % 2000 === 0) this.onProgress(`hashed ${this.hashed} files, ${(this.bytes / 1e9).toFixed(1)} GB`);
    return sha256;
  }
}
