// An iPhone backup as Finder or libimobiledevice's idevicebackup2 writes it,
// unencrypted. Manifest.db lists every file it holds (table Files: fileID,
// domain, relativePath, flags, where flags 1 is a file), and keeps each file at
// <first two hex digits of fileID>/<fileID>, fileID being the SHA-1 of
// "<domain>-<relativePath>". Status.plist says when it was taken, and its
// SnapshotState whether the backup finished.
//
// Finder keeps each device's backup in ~/Library/Application Support/MobileSync/Backup/<device id>/,
// and a later backup brings that one up to date in place (finderBackup finds it).
//
// The backup is a folder on this Mac, or one on another machine reached by ssh
// ("nas:/share/.../<device id>"), such as a NAS, which has no
// SQLite of its own: Manifest.db is copied to a temporary folder here and read
// there, and the files chosen come over in one tar stream. The backup itself is
// only read, never written to.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";
import { isFile } from "./appDb.ts";

export interface BackupFile {
  fileID: string;
  /** The file's path in its domain, e.g. Documents/<md5>/DB/MM.sqlite. */
  relativePath: string;
}

const FLAG_FILE = 1;

export class IphoneBackup {
  /** When the backup was taken (Status.plist's Date), in milliseconds. */
  readonly takenAt: number;
  private readonly where: Location;
  private readonly manifest: DatabaseSync;

  private constructor(where: Location, manifest: DatabaseSync, takenAt: number) {
    this.where = where;
    this.manifest = manifest;
    this.takenAt = takenAt;
  }

  /** Opens the backup at `location` (a folder, or host:folder over ssh), copying what it reads into `work`. */
  static async open(location: string, work: string): Promise<IphoneBackup> {
    const where = parseLocation(location);
    const status = join(work, "Status.plist");
    if (!(await fetch(where, "Status.plist", status))) throw new Error(`${location} has no Status.plist; is it an iPhone backup's folder?`);
    const date = await plistValue(status, "Date");
    const takenAt = Date.parse(date);
    if (!Number.isFinite(takenAt)) throw new Error(`${location}'s Status.plist gives no date it was taken`);
    const state = await plistValue(status, "SnapshotState").catch(() => null);
    if (state !== null && state !== "finished") throw new Error(`${location} is a backup that has not finished (${state}): let it finish, or take it again`);
    const copy = join(work, "Manifest.db");
    if (!(await fetch(where, "Manifest.db", copy))) throw new Error(`${location} has no Manifest.db; is it an iPhone backup's folder?`);
    await fetch(where, "Manifest.db-wal", `${copy}-wal`);
    const manifest = new DatabaseSync(copy);
    try {
      const columns = manifest.prepare("PRAGMA table_info(Files)").all().map((row) => String(row.name));
      if (!["fileID", "domain", "relativePath", "flags"].every((column) => columns.includes(column))) {
        throw new Error("it has no Files table with fileID, domain, relativePath and flags");
      }
    } catch (error) {
      manifest.close();
      // An encrypted backup's Manifest.db is encrypted too, so SQLite finds no database in it.
      throw new Error(`${location}'s Manifest.db cannot be read (${(error as Error).message}); an encrypted backup cannot be read`);
    }
    return new IphoneBackup(where, manifest, takenAt);
  }

  /** The files (not folders or links) the backup holds of one app's domain, such as AppDomain-com.tencent.xin. */
  files(domain: string): BackupFile[] {
    return this.manifest
      .prepare("SELECT fileID, relativePath FROM Files WHERE domain = ? AND flags = ? ORDER BY relativePath")
      .all(domain, FLAG_FILE)
      .map((row) => ({ fileID: String(row.fileID), relativePath: String(row.relativePath) }));
  }

  /**
   * Copies `files` into the folder `into`, each to the path `pathOf` gives it there.
   * Returns the files the backup lists but does not hold.
   */
  async copyOut(files: BackupFile[], into: string, pathOf: (file: BackupFile) => string): Promise<BackupFile[]> {
    const missing: BackupFile[] = [];
    if (this.where.host === null) {
      for (const file of files) {
        const from = join(this.where.path, stored(file));
        if (!(await isFile(from))) {
          missing.push(file);
          continue;
        }
        const to = join(into, pathOf(file));
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      }
      return missing;
    }
    // Over ssh: one tar stream of every file into a folder beside `into`, then each moved to its place.
    const incoming = `${into}.incoming`;
    await rm(incoming, { recursive: true, force: true });
    await mkdir(incoming, { recursive: true });
    try {
      const remote = spawn("ssh", ["-o", "BatchMode=yes", this.where.host, `tar -cf - -C ${quote(this.where.path)} --null -T -`], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const local = spawn("tar", ["-xf", "-", "-C", incoming], { stdio: ["pipe", "ignore", "pipe"] });
      remote.stdout.pipe(local.stdin);
      remote.stdin.end(files.map((file) => `${stored(file)}\0`).join(""));
      const remoteErrors = collect(remote.stderr);
      const localErrors = collect(local.stderr);
      const [[remoteCode], [localCode]] = await Promise.all([once(remote, "close"), once(local, "close")]);
      for (const file of files) {
        if (!(await isFile(join(incoming, stored(file))))) {
          missing.push(file);
          continue;
        }
        const to = join(into, pathOf(file));
        await mkdir(dirname(to), { recursive: true });
        await rename(join(incoming, stored(file)), to);
      }
      // tar fails when a file it was asked for is not there; anything else is an error of its own.
      if (localCode !== 0) throw new Error(`tar here failed: ${localErrors()}`);
      if (remoteCode !== 0 && missing.length === 0) throw new Error(`ssh ${this.where.host} failed: ${remoteErrors()}`);
      return missing;
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }
  }

  close(): void {
    this.manifest.close();
  }
}

/** Where Finder keeps the backups of a home folder's user. */
export function finderBackups(home: string): string {
  return join(home, "Library", "Application Support", "MobileSync", "Backup");
}

/**
 * The backup Finder took last: of the folders in finderBackups(home) holding a Manifest.db (a device's, or an archived
 * copy of one), the one whose Status.plist is newest.
 */
export async function finderBackup(home: string): Promise<string> {
  const folder = finderBackups(home);
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === "ENOENT"
      ? `there is no ${folder}; when it is a link to another disk, is that disk connected?`
      : `could not read ${folder} (${error.message}); the terminal needs Full Disk Access`);
  });
  let newest: { path: string; takenAt: number } | null = null;
  for (const name of names.filter((name) => !name.startsWith("."))) {
    const path = join(folder, name);
    if (!(await isFile(join(path, "Manifest.db"))) || !(await isFile(join(path, "Status.plist")))) continue;
    const takenAt = Date.parse(await plistValue(join(path, "Status.plist"), "Date").catch(() => ""));
    if (Number.isFinite(takenAt) && (!newest || takenAt > newest.takenAt)) newest = { path, takenAt };
  }
  if (!newest) throw new Error(`${folder} holds no backup; take one first (docs/import-runbook.md, "Taking the backup")`);
  return newest.path;
}

interface Location {
  /** The machine it is on, reached by ssh, or null for this Mac. */
  host: string | null;
  path: string;
}

/** "host:/path" is a folder on another machine; anything else is a folder here. */
function parseLocation(location: string): Location {
  const remote = location.match(/^([^/:]+):(.+)$/);
  return remote ? { host: remote[1], path: remote[2] } : { host: null, path: location };
}

/** Where the backup keeps a file: <xx>/<fileID>. */
function stored(file: BackupFile): string {
  return `${file.fileID.slice(0, 2)}/${file.fileID}`;
}

/** Copies a file at the top of the backup to `to`; false when the backup has none. */
async function fetch(where: Location, name: string, to: string): Promise<boolean> {
  if (where.host === null) {
    const from = join(where.path, name);
    if (!(await isFile(from))) return false;
    await copyFile(from, to);
    return true;
  }
  const file = quote(`${where.path}/${name}`);
  const ssh = spawn("ssh", ["-o", "BatchMode=yes", where.host, `[ -f ${file} ] || exit 3; cat ${file}`], { stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(to);
  ssh.stdout.pipe(out);
  const errors = collect(ssh.stderr);
  const [code] = await once(ssh, "close");
  await finished(out);
  if (code === 3) {
    await rm(to, { force: true });
    return false;
  }
  if (code !== 0) throw new Error(`ssh ${where.host} failed: ${errors()}`);
  return true;
}

/** One value of a property list, as text, read with macOS's plutil (which reads binary and XML lists alike). */
async function plistValue(file: string, key: string): Promise<string> {
  const plutil = spawn("plutil", ["-extract", key, "raw", "-o", "-", file], { stdio: ["ignore", "pipe", "pipe"] });
  const out = collect(plutil.stdout);
  const errors = collect(plutil.stderr);
  const [code] = await once(plutil, "close");
  if (code !== 0) throw new Error(`plutil could not read ${key} from ${file}: ${errors()}`);
  return out().trim();
}

function collect(stream: NodeJS.ReadableStream): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8").trim();
}

/** A word for a POSIX shell, in single quotes. */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
