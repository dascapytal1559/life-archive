// The archive's nightly backup on the NAS (npm run nas-backup; docs/data.md's "The NAS copy"), made at 06:00 by the
// launchd agent local.life-archive-nas-backup. Files only: no message is read.
//
// It is a restic repository, encrypted on this Mac before anything leaves it: REPOSITORY_PATH in the NAS user's home,
// reached over sftp. Its password is in this Mac's login Keychain (KEYCHAIN_SERVICE) and nowhere else on it; restic
// reads it with RESTIC_PASSWORD_COMMAND, so it is never in a file, an argument or the log. Without it the backup can
// never be read.
//
// Each night is one snapshot whose root is the archive's folder as it was then: core.sqlite and calendar.sqlite
// (checked copies) at the top, platform-exports/ and the rest beside it, less ARCHIVE_EXCLUDES; modules/ as a mirror
// (nasMirror.ts) holding each module's database (the one the core opens, friend map's archive among them, and the ones
// a module keeps itself, as rituals keeps its store: sdk/server.ts's `backup`) as a checked copy at its own path
// (/modules/friend-map/archive.sqlite), so a restore puts every file back where it lives; each folder in OTHER_FOLDERS
// (friend-map's) beside them, its database a checked copy at the top. One snapshot, one retention, for all of it. An
// archive's folder from before friend map was a module (archive.sqlite at its root) is refused until it has moved.
// restic stores each file's chunks once, so a night costs what changed. After each night `restic forget --prune`
// keeps the newest snapshot of each of the last KEEP_DAILY days. Older history is Time Machine's.
//
// The same night makes a second snapshot, tagged TRANSCRIPTS_TAG, of TRANSCRIPT_FOLDERS alone: every LLM transcript
// (transcripts/, taken just before by transcripts.ts) and the archive's copies of the agents' conversations (llm/).
// It is never forgotten: the forget above is restricted to SNAPSHOT_TAG, so every night's transcripts stay on the NAS
// for good, whatever later happens to the Mac's copy. Its files are the archive snapshot's too, so restic stores
// their chunks once and the second snapshot costs only its own small trees.
//
// A database is never sent as the live file: checkedCopy (backups.ts) makes a consistent copy with VACUUM INTO in
// data/backups/nas/ and checks it, and restic runs from that folder with the archive's entries named relative to it
// (../../platform-exports), since restic drops a relative path's leading ../ and so puts each at the snapshot's root
// beside the copies; the copies are deleted after. Another folder's database copy cannot go inside that folder in the
// snapshot: restic renames a second target landing on a name already taken (/Projects-1/rituals/data/ritual.sqlite3), so it
// goes at the top under its own name. The outcome of each run is kept in data/backups/nas-backup.json, which
// `npm run archive -- storage` reads.
//
// Written in Effect (docs/effect.md): a run, its check and the repository's making are Effects, which nas-backup.ts
// runs. The staging folder's lock is held in the run's scope, each ssh, security and restic run is a child process
// held in a scope (../childProcess.ts), and the hosts are tried in turn, a failure caught to try the next.
// Interrupting a run (a signal to nas-backup.ts) stops the restic it waits on, deletes the database copy and lets the
// lock go.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, matchesGlob, relative } from "node:path";
import { Data, Effect, type Scope } from "effect";
import { run, RunFailed } from "../childProcess.ts";
import { checkedCopy, integrityCheck, moduleDatabases } from "./backups.ts";
import { mirrorFolder } from "./nasMirror.ts";
import { CALENDAR_FILE } from "../calendar/db.ts";
import { CORE_FILE } from "./coreDb.ts";
import { loadModules, moduleBackups } from "../modules/loader.ts";
import { MODULES_FOLDER } from "../modules/store.ts";
import { jobPath } from "../dataHome.ts";
import { expandHome } from "../connectors/lines.ts";
import { settings } from "../settings.ts";

/** The restic repository, in the NAS user's home: the settings' nasBackup.repository; none, there is no NAS backup. */
export const REPOSITORY_PATH = settings().nasBackup.repository;
/** The ssh hosts (~/.ssh/config) tried in order: the settings' nasBackup.hosts. */
export const NAS_HOSTS = settings().nasBackup.hosts;
export const KEEP_DAILY = 7;
/** How much of the repository's data `verify` reads back and decrypts (restic check --read-data-subset). */
export const CHECK_SUBSET = "5%";
/** The launchd agent that runs it each night (npm run nas-backup -- install). */
export const LAUNCHD_LABEL = "local.life-archive-nas-backup";
/** The restic it was written and tested with; each run logs the one it used. */
export const RESTIC_VERSION = "0.19.1";
/** The tag on every snapshot of the archive's folder: restic finds a night's parent and applies the retention within it. */
export const SNAPSHOT_TAG = "life-archive";
/** The tag on every snapshot of the LLM transcripts: never forgotten. */
export const TRANSCRIPTS_TAG = "llm-transcripts";
/**
 * What the transcripts' snapshot takes, relative to the archive's folder, each at the snapshot's root as in the
 * archive's: transcripts/ (transcripts.ts's TRANSCRIPTS_FOLDER: every LLM tool's transcripts on this Mac) and llm/
 * (the archive's copies of the conversations it indexes, Grok Bot's chats among them). Both only ever grow.
 */
export const TRANSCRIPT_FOLDERS = ["transcripts", "llm"];

/** The repository's password in the login Keychain: a generic password, this service and account. */
export const KEYCHAIN_SERVICE = "life-archive-backup";
export const KEYCHAIN_ACCOUNT = "life-archive";

/**
 * What a snapshot leaves out of the archive's folder, relative to it (core.sqlite, calendar.sqlite and each module's
 * database, modules/<id>/*.sqlite, go in as checked copies, a module's in the mirror of modules/; what a module keeps
 * itself, moduleKept, is left out the same way; archive.sqlite is the root one from before friend map was a module,
 * which archiveUnready refuses). The vault (the settings' vault.folder) is the owner's notes, kept elsewhere and linked from here, so the
 * NAS does not keep it.
 */
export const ARCHIVE_EXCLUDES = ["archive.sqlite*", `${CALENDAR_FILE}*`, `${CORE_FILE}*`, `${MODULES_FOLDER}/*/*.sqlite*`, "backups", "archive/.spool", settings().vault.folder];

export interface Folder {
  folder: string;
  /** Left out, relative to the folder; restic's patterns (* and ** work). */
  exclude: string[];
  /**
   * A SQLite database in it, relative to it, sent as a checked copy at the snapshot's top under its own name (which
   * no other may take), never as the live file: the file and its -journal, -wal and -shm are left out of the folder.
   */
  database?: string;
}

/**
 * Folders backed up beside the archive's: the settings' nasBackup.folders, { "folder": "~/Notes", "exclude": [] }. Each
 * appears in a snapshot under its path from the folder it shares with the archive's (~/Notes as /Notes).
 */
export const OTHER_FOLDERS: Folder[] = settings().nasBackup.folders.map(({ folder, exclude, database }) => ({ folder: expandHome(folder), exclude: [...exclude], ...(database ? { database } : {}) }));

/** Where the database copy is made, and restic runs from: a folder the backups' prune never looks into, and the snapshot leaves out. */
export const STAGING = join("backups", "nas");
/** The outcome of the last runs, in the archive's folder. */
export const STATUS_FILE = join("backups", "nas-backup.json");

/** What stops a NAS backup, in plain words: no archive, no password, no repository, another run, too little room. */
export class NasBackupError extends Data.TaggedError("NasBackupError")<{ readonly message: string }> {}

/** Where the repository is, as restic is told it. */
export interface Repository {
  /** How the user is told where it went, e.g. "nas". */
  readonly name: string;
  /** restic's -r, e.g. sftp:nas:life-archive-backup/restic. */
  readonly url: string;
  /** restic's -o options. */
  readonly options: string[];
  /** Bytes free where it is. */
  freeBytes(): Effect.Effect<number, RunFailed | NasBackupError>;
}

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"];

/** The repository on the NAS, over sftp as an ssh host of ~/.ssh/config. */
export class NasRepository implements Repository {
  readonly name: string;
  readonly url: string;
  readonly options: string[];
  constructor(host: string) {
    this.name = host;
    this.url = `sftp:${host}:${REPOSITORY_PATH}`;
    this.options = ["-o", `sftp.command=ssh ${SSH_OPTIONS.join(" ")} ${host} -s sftp`];
  }

  freeBytes(): Effect.Effect<number, RunFailed | NasBackupError> {
    return run("ssh", [...SSH_OPTIONS, this.name, "df -P -k ."]).pipe(
      Effect.flatMap(({ stdout }) => {
        // POSIX df: the fourth column of the last line is the 1024-byte blocks available.
        const blocks = Number(stdout.trim().split("\n").at(-1)?.split(/\s+/)[3]);
        return Number.isFinite(blocks) ? Effect.succeed(blocks * 1024) : Effect.fail(new NasBackupError({ message: `could not read the NAS's free space from df: ${stdout.trim()}` }));
      }),
    );
  }
}

/** A repository in a folder on this Mac (for the tests). */
export class FolderRepository implements Repository {
  readonly options: string[] = [];
  readonly name: string;
  readonly url: string;
  constructor(folder: string) {
    this.name = this.url = folder;
  }

  freeBytes(): Effect.Effect<number, NasBackupError> {
    return files(async () => {
      const stats = await statfs(dirname(this.url));
      return stats.bavail * stats.bsize;
    });
  }
}

/** The first of the hosts that answers over ssh, as the repository there: each tried in turn, the next only if it does not. */
export const reachNas = (hosts: readonly string[] = NAS_HOSTS): Effect.Effect<NasRepository, NasBackupError> =>
  Effect.suspend(() => {
    if (!REPOSITORY_PATH) return Effect.fail(new NasBackupError({ message: "there is no NAS backup: settings.json names no nasBackup.repository" }));
    const failures: string[] = [];
    const reach = (host: string) =>
      run("ssh", [...SSH_OPTIONS, "-o", "ConnectTimeout=10", host, "true"]).pipe(
        Effect.as(new NasRepository(host)),
        Effect.tapError((error) => Effect.sync(() => failures.push(`${host}: ${error.message}`))),
      );
    const none = Effect.suspend(() => Effect.fail(new NasBackupError({ message: `the NAS did not answer over ssh (${failures.join("; ")})` })));
    return hosts.reduceRight<Effect.Effect<NasRepository, NasBackupError>>((rest, host) => reach(host).pipe(Effect.catch(() => rest)), none);
  });

/** Where the repository's password is kept, and the command restic reads it with. */
export interface PasswordStore {
  /** RESTIC_PASSWORD_COMMAND: prints the password. */
  readonly command: string;
  has(): Effect.Effect<boolean, RunFailed>;
  store(password: string): Effect.Effect<void, RunFailed | NasBackupError>;
}

/** The password as a generic password in a keychain: the login keychain, or a keychain file (for the tests). */
export class KeychainPasswordStore implements PasswordStore {
  readonly command: string;
  private readonly keychain: string[];
  constructor(keychainFile?: string) {
    this.keychain = keychainFile ? [keychainFile] : [];
    this.command = ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", ...this.keychain].join(" ");
  }

  has(): Effect.Effect<boolean, RunFailed> {
    // Without -w it prints the item's attributes, never the password; 44 is security's "not found".
    return run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, ...this.keychain]).pipe(
      Effect.as(true),
      Effect.catchIf((error) => error.code === 44, () => Effect.succeed(false)),
    );
  }

  store(password: string): Effect.Effect<void, RunFailed | NasBackupError> {
    return Effect.gen({ self: this }, function* () {
      if (!/^[\w-]+$/.test(password)) return yield* new NasBackupError({ message: "the password must be letters, digits, _ and -" });
      // Given on security's standard input (its -i), so it is never a process's argument.
      yield* run("/usr/bin/security", ["-i"], { input: `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${password} ${this.keychain.join(" ")}\n` });
      if (!(yield* this.has())) return yield* new NasBackupError({ message: "the Keychain did not keep the password" });
    });
  }
}

/** A new password: 32 random bytes, as 43 letters, digits, _ and -. */
export function newPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** The restic program: on the PATH, else where Homebrew puts it. */
export function findRestic(path = process.env.PATH ?? ""): string {
  const dirs = [...path.split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin"];
  const found = dirs.map((dir) => join(dir, "restic")).find((file) => existsSync(file));
  if (!found) throw new Error("restic is not installed, and the NAS backup needs it: brew install restic");
  return found;
}

/** Runs restic on one repository, the password read by its command. */
export class Restic {
  readonly bin: string;
  readonly repository: Repository;
  readonly passwords: PasswordStore;
  /** Global flags for every command (the tests' --no-cache). */
  readonly flags: string[];
  constructor(bin: string, repository: Repository, passwords: PasswordStore, flags: string[] = []) {
    this.bin = bin;
    this.repository = repository;
    this.passwords = passwords;
    this.flags = flags;
  }

  /** restic's output; a run interrupted is stopped (SIGTERM, then SIGKILL after 5 s), as restic expects. */
  run(args: string[], options: { cwd?: string } = {}): Effect.Effect<string, RunFailed> {
    const env: NodeJS.ProcessEnv = { ...process.env, RESTIC_PASSWORD_COMMAND: this.passwords.command };
    // Only this repository and this password: none named by the environment.
    for (const name of ["RESTIC_PASSWORD", "RESTIC_PASSWORD_FILE", "RESTIC_REPOSITORY", "RESTIC_REPOSITORY_FILE"]) delete env[name];
    return run(this.bin, ["-r", this.repository.url, ...this.repository.options, ...this.flags, ...args], { cwd: options.cwd, env }).pipe(Effect.map(({ stdout }) => stdout));
  }

  version(): Effect.Effect<string, RunFailed> {
    return run(this.bin, ["version"]).pipe(Effect.map(({ stdout }) => stdout.trim().split(" ")[1] ?? "?"));
  }

  /** Whether the repository is there; it fails when it is but the password does not open it. */
  exists(): Effect.Effect<boolean, RunFailed> {
    return this.run(["cat", "config"]).pipe(
      Effect.as(true),
      // restic's "the repository does not exist".
      Effect.catchIf((error) => error.code === 10, () => Effect.succeed(false)),
    );
  }

  /** The snapshots with a tag (the archive's folder's unless named), oldest first. */
  snapshots(tag = SNAPSHOT_TAG): Effect.Effect<Snapshot[], RunFailed> {
    return this.run(["snapshots", "--json", "--tag", tag]).pipe(
      Effect.map((out) => ((JSON.parse(out) as Snapshot[] | null) ?? []).sort((a, b) => a.time.localeCompare(b.time))),
    );
  }

  /** Removes the locks of runs that are gone (restic's unlock leaves a live run's alone). */
  unlockStale(): Effect.Effect<void, RunFailed> {
    return Effect.asVoid(this.run(["unlock", "-q"]));
  }
}

export interface Snapshot {
  id: string;
  short_id: string;
  /** When it was made, with this Mac's offset. */
  time: string;
}

/**
 * Puts a new password in the store unless it holds one already, then makes the repository with it; a repository
 * already there is only opened, to show the password is its.
 */
export const initRepository = Effect.fnUntraced(function* ({ restic, log = () => {} }: { restic: Restic; log?: (line: string) => void }): Effect.fn.Return<
  { newPassword: boolean; created: boolean },
  RunFailed | NasBackupError
> {
  const fresh = !(yield* restic.passwords.has());
  if (fresh) {
    yield* restic.passwords.store(newPassword());
    log(`made a new password and put it in the Keychain (service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT}); keep a copy of it in your password manager`);
  } else log(`the Keychain already holds the password (service ${KEYCHAIN_SERVICE}); using it`);
  if (yield* restic.exists()) {
    log(`${restic.repository.url} is already a repository, and the password opens it`);
    return { newPassword: fresh, created: false };
  }
  yield* restic.run(["init", "-q"]);
  log(`made the encrypted repository ${restic.repository.url}`);
  return { newPassword: fresh, created: true };
});

export interface NasStatus {
  /** The last run that finished, ISO time. */
  lastSuccessAt?: string;
  lastSuccessHost?: string;
  /** The snapshots there after it, as their times, oldest first. */
  snapshots?: string[];
  /** The transcripts' snapshots there after it, all ever made: how many, and the first's and the newest's times. */
  transcripts?: { count: number; first: string; last: string };
  /** The NAS's free bytes, as the last run found them. */
  freeBytes?: number;
  /** The restic it used. */
  resticVersion?: string;
  /** The last run that failed, and why; cleared by the next that finishes. */
  lastFailureAt?: string;
  lastFailure?: string;
}

export async function readNasStatus(dataDir: string): Promise<NasStatus | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, STATUS_FILE), "utf8")) as NasStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeNasStatus(dataDir: string, status: NasStatus): Promise<void> {
  const file = join(dataDir, STATUS_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.partial`, `${JSON.stringify(status, null, 2)}\n`);
  await rename(`${file}.partial`, file);
}

/** Records a failed run in the status file, keeping the last success. */
export async function recordNasFailure(dataDir: string, error: Error, now = Date.now()): Promise<void> {
  const status = (await readNasStatus(dataDir).catch(() => null)) ?? {};
  await writeNasStatus(dataDir, { ...status, lastFailureAt: new Date(now).toISOString(), lastFailure: error.message });
}

/** The storage report's line on the NAS backup: when the last was made, and a failure since; two days without one is said. */
export function nasLine(status: NasStatus | null, now: number): string {
  if (!status?.lastSuccessAt) return `NAS backup: none made yet${status?.lastFailure ? `; the last try failed ${status.lastFailureAt}: ${status.lastFailure}` : ""} (npm run nas-backup)`;
  const at = Date.parse(status.lastSuccessAt);
  const hours = (now - at) / 3_600_000;
  const age = hours < 1 ? "under an hour ago" : hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago, overdue`;
  const failed = status.lastFailureAt && Date.parse(status.lastFailureAt) > at ? `; failed since, ${status.lastFailureAt}: ${status.lastFailure}` : "";
  const count = status.snapshots?.length ?? 0;
  const day = (time?: string) => time?.slice(0, 10) ?? "?";
  const kept = status.transcripts;
  const transcripts = kept ? `${kept.count} of the transcripts, never forgotten (${day(kept.first)} to ${day(kept.last)})` : "none yet of the transcripts";
  return `NAS backup: last made ${status.lastSuccessAt} (${age}) on ${status.lastSuccessHost}, ${count} ${count === 1 ? "snapshot" : "snapshots"} there (${day(status.snapshots?.[0])} to ${day(status.snapshots?.at(-1))}) and ${transcripts}, ${status.freeBytes === undefined ? "?" : gigabytes(status.freeBytes)} free${failed}`;
}

/** A database sent as its checked copy: the live file, and the name of the copy, in the staging folder and at the snapshot's top. */
export interface DatabaseCopy {
  file: string;
  name: string;
}

/**
 * What the installed modules keep themselves in their folders of the archive's folder (sdk/server.ts's `backup`: rituals'
 * store, modules/rituals/data/ritual.sqlite3): each database there sent as a checked copy at the snapshot's root by its
 * name (one not there yet, in a folder the module has not written, is not), its live file and journal left out, and the
 * folders the module says to leave out (its own backups). A module that did not load stops the run: ARCHIVE_EXCLUDES'
 * modules/<id>/*.sqlite* leaves out only the databases the core opens, so a database a module keeps itself (rituals'
 * data/ritual.sqlite3) is left out and copied only by that module's declaration, and without it a snapshot would send
 * the live file and its journal, with no checked copy for verify to read back.
 */
async function moduleKept(dataDir: string, modulesRoot?: string): Promise<{ databases: DatabaseCopy[]; excludes: string[] }> {
  const modules = await loadModules({ root: modulesRoot, all: true });
  if (modules.broken.length > 0) {
    throw new Error(`the NAS backup cannot tell what a broken module keeps in its folder: ${modules.broken.map((module) => `${module.id} (${module.problem})`).join("; ")}`);
  }
  const databases: DatabaseCopy[] = [];
  const excludes: string[] = [];
  for (const module of moduleBackups(modules)) {
    const folder = join(dataDir, MODULES_FOLDER, module.id);
    for (const database of module.databases) {
      const file = join(folder, database);
      if (existsSync(file)) databases.push({ file, name: `${MODULES_FOLDER}/${module.id}/${database}` });
      excludes.push(`${file}*`);
    }
    for (const exclude of module.exclude) excludes.push(join(folder, exclude));
  }
  return { databases, excludes };
}

/**
 * What restic is given, run from the staging folder: the archive's top-level entries and the other folders, each
 * relative to it, and the deeper exclusions as absolute patterns (restic matches a pattern starting with / against a
 * file's absolute path, but never leaves out a target it is given, so a top-level exclusion is applied here); the
 * archive's modules/ as the mirror (`modules`, nasMirror.ts) made from the live folder less `mirror.excludes`; and the
 * databases to send as checked copies: the core's first, then the calendar's, then each module's at its own path in
 * the mirror (modules/<id>/<name>.sqlite, and what a module keeps itself, moduleKept), then each other folder's at the
 * snapshot's root by its name; the caller makes the copies and names those outside the mirror as targets. The modules
 * are this checkout's, or those under `modulesRoot`.
 */
export async function backupTargets(
  archiveDir: string,
  folders: Folder[],
  modulesRoot?: string,
): Promise<{ targets: string[]; excludes: string[]; databases: DatabaseCopy[]; folders: { folder: string; path: string }[]; mirror: { from: string; excludes: string[] } | null }> {
  // restic makes a target absolute from the folder it runs in, symbolic links resolved (/var is /private/var), and
  // matches the exclusions against that: so every path here is resolved too, or an exclusion would leave out nothing.
  const dataDir = await realpath(archiveDir);
  const otherFolders = await Promise.all(
    folders.map(async (f) => ({ ...f, folder: await realpath(f.folder).catch(() => Promise.reject(new Error(`${f.folder}, which the NAS backup takes, is not there`))) })),
  );
  const staging = join(dataDir, STAGING);
  const [topLevel, deeper] = [ARCHIVE_EXCLUDES.filter((p) => !p.includes("/")), ARCHIVE_EXCLUDES.filter((p) => p.includes("/"))];
  const inFolder = await readdir(dataDir);
  const entries = inFolder.filter((entry) => !topLevel.some((pattern) => matchesGlob(entry, pattern))).sort();
  // modules/ goes as the mirror in the staging folder, so its databases' copies land in it at their own paths.
  const targets = [
    ...entries.map((entry) => (entry === MODULES_FOLDER ? MODULES_FOLDER : relative(staging, join(dataDir, entry)))),
    ...otherFolders.map((f) => relative(staging, f.folder)),
  ];
  const kept = await moduleKept(dataDir, modulesRoot);
  const databases = [
    ...(inFolder.includes(CORE_FILE) ? [{ file: join(dataDir, CORE_FILE), name: CORE_FILE }] : []),
    ...(inFolder.includes(CALENDAR_FILE) ? [{ file: join(dataDir, CALENDAR_FILE), name: CALENDAR_FILE }] : []),
    ...(await moduleDatabases(dataDir)).map(({ file }) => ({ file, name: relative(dataDir, file) })),
    ...kept.databases,
    ...otherFolders.flatMap((f) => (f.database ? [{ file: join(f.folder, f.database), name: basename(f.database) }] : [])),
  ];
  // restic puts a target at its relative path less the leading ../. Two that climb as far share what they land in (the
  // other folders' ../../../Projects/a and ../../../Projects/b, both in /Projects); one landing on a name that a target
  // of another climb took is renamed (archive.sqlite-1), which a restore would not put back: so that is refused, as is
  // one target twice. A module's database lands inside the mirror, so only those outside it are targets of their own.
  const climbs = new Map<string, number>();
  const seen = new Set<string>();
  for (const target of [...databases.map((d) => d.name).filter((name) => !inMirror(name)), ...targets]) {
    const name = snapshotPath(target).split("/")[1];
    const climb = target.split("/").filter((part) => part === "..").length;
    if (seen.has(target) || (climbs.get(name) ?? climb) !== climb) throw new Error(`${target} would be /${name} in the snapshot, which something else already is`);
    seen.add(target);
    climbs.set(name, climb);
  }
  const isModules = (pattern: string) => pattern.startsWith(`${MODULES_FOLDER}/`);
  const excludes = [
    ...deeper.filter((pattern) => !isModules(pattern)).map((pattern) => join(dataDir, pattern)),
    ...otherFolders.flatMap((f) => [...f.exclude, ...(f.database ? [`${f.database}*`] : [])].map((pattern) => join(f.folder, pattern))),
  ];
  const mirror = inFolder.includes(MODULES_FOLDER)
    ? { from: join(dataDir, MODULES_FOLDER), excludes: [...deeper.filter(isModules).map((pattern) => join(dataDir, pattern)), ...kept.excludes] }
    : null;
  return { targets, excludes, databases, folders: otherFolders.map((f) => ({ folder: f.folder, path: snapshotPath(relative(staging, f.folder)) })), mirror };
}

/** Whether a database's copy goes in the mirror of modules/ (by its name, its path in the snapshot). */
const inMirror = (name: string): boolean => name.startsWith(`${MODULES_FOLDER}/`);

/** Where restic puts a target named relative to the folder it runs in: at that path less its leading ../, from the snapshot's root. */
function snapshotPath(target: string): string {
  return `/${target.split("/").filter((part) => part !== "..").join("/")}`;
}

export interface NasBackupOptions {
  dataDir: string;
  restic: Restic;
  /** Says what it does, a line at a time. */
  log?: (line: string) => void;
  now?: number;
  /** Look only: what the snapshot would send and which snapshots would go. */
  dryRun?: boolean;
  /** Backed up beside the archive's folder: OTHER_FOLDERS, named by the caller so a test never takes the real ones. */
  otherFolders: Folder[];
}

export interface NasBackupResult {
  freeBytes: number;
  /** The snapshot made; none in a dry run. */
  snapshot?: string;
  /** Its database copies' size, together; none in a dry run. */
  databaseBytes?: number;
  /** Files new or changed since the last snapshot (or, in a dry run, that would be). */
  changed: number;
  /** Bytes the snapshot added to the repository, after deduplication and compression (or would). */
  added: number;
  /** The snapshots forget removed (or would), by short id. */
  forgotten: string[];
  /** The snapshots there after it, as their times, oldest first. */
  snapshots: string[];
  /** The transcripts' snapshot; null when the archive's folder holds none of TRANSCRIPT_FOLDERS. */
  transcripts: TranscriptsSnapshot | null;
}

export interface TranscriptsSnapshot {
  /** The snapshot made; none in a dry run. */
  snapshot?: string;
  changed: number;
  added: number;
  /** The transcripts' snapshots there after it (or now, in a dry run), oldest first: every one ever made. */
  kept: Snapshot[];
}

/**
 * Why the archive's folder `dataDir` cannot be backed up as it is, or null: it has no core.sqlite (a checkout with no
 * archive), or its archive.sqlite is still at its root, from before friend map was a module, which the snapshot's layout
 * would leave out (ARCHIVE_EXCLUDES): moved first, by `npm run archive -- migrate friend-map-module`.
 */
export function archiveUnready(dataDir: string): string | null {
  if (existsSync(join(dataDir, "archive.sqlite"))) {
    return `the archive in ${dataDir} is from before friend map was a module (archive.sqlite at its root): move it first, with the server stopped: npm run archive -- migrate friend-map-module`;
  }
  return existsSync(join(dataDir, CORE_FILE)) ? null : `there is no ${CORE_FILE} in ${dataDir}`;
}

/** One night's snapshot, the transcripts' snapshot, then the retention (see the top of this file). */
export const runNasBackup = ({ dataDir, restic, log = () => {}, now = Date.now(), dryRun = false, otherFolders }: NasBackupOptions): Effect.Effect<NasBackupResult, NasBackupError | RunFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const unready = archiveUnready(dataDir);
      if (unready) return yield* new NasBackupError({ message: unready });
      const staging = join(dataDir, STAGING);
      yield* holdLock(staging);
      const version = yield* restic.version();
      log(`restic ${version}`);
      const freeBytes = yield* restic.repository.freeBytes();
      log(`${restic.repository.name}: ${gigabytes(freeBytes)} free`);
      if (!(yield* restic.passwords.has())) return yield* new NasBackupError({ message: `the Keychain holds no password for the backup (service ${KEYCHAIN_SERVICE}): npm run nas-backup -- init` });
      // The first to open the repository, so the one that says there is none; a dry run only opens it.
      yield* (dryRun ? Effect.asVoid(restic.run(["cat", "config"])) : restic.unlockStale()).pipe(
        Effect.catchIf((error) => error.code === 10, () => Effect.fail(new NasBackupError({ message: `there is no repository at ${restic.repository.url}: npm run nas-backup -- init` }))),
      );

      const { targets, excludes, databases, folders, mirror } = yield* files(() => backupTargets(dataDir, otherFolders));
      for (const { folder, path } of folders) log(`${dryRun ? "would take" : "taking"} ${folder} as ${path}`);
      const copies = databases.map((database) => join(staging, database.name));
      const mirrored = join(staging, MODULES_FOLDER);
      const removeCopies = () => Promise.all([...copies.map((copy) => rm(copy, { force: true })), rm(mirrored, { recursive: true, force: true })]);
      // Deleted however the run ends: sent, failed or stopped.
      yield* Effect.addFinalizer(() => Effect.promise(removeCopies));
      yield* files(removeCopies);
      if (mirror) {
        const linked = yield* files(() => mirrorFolder(mirror.from, mirrored, mirror.excludes));
        log(`mirrored ${mirror.from} as /${MODULES_FOLDER} (${linked} ${linked === 1 ? "file" : "files"} linked)`);
      }
      // The archive's by its name, another by its file and where its copy lands.
      const said = databases.map(({ file, name }, i) => (i === 0 ? name : `${file} as /${name}`));
      let databaseBytes: number | undefined;
      if (dryRun) for (const database of said) log(`would add a checked copy of ${database}`);
      else {
        databaseBytes = 0;
        for (const [i, { file }] of databases.entries()) {
          const bytes = yield* files(() => checkedCopy(file, copies[i]));
          databaseBytes += bytes;
          log(`made a checked copy of ${said[i]} (${gigabytes(bytes)}, integrity ok)`);
        }
        if (databaseBytes > freeBytes) return yield* new NasBackupError({ message: `the NAS has ${gigabytes(freeBytes)} free, too little for the databases (${gigabytes(databaseBytes)})` });
      }
      const args = ["backup", "--json", "-q", "--tag", SNAPSHOT_TAG, "--group-by", "tags", "--time", resticTime(now), ...(dryRun ? ["--dry-run"] : databases.map((d) => d.name).filter((name) => !inMirror(name)))];
      const summary = backupSummary(yield* restic.run([...args, ...excludes.flatMap((pattern) => ["--exclude", pattern]), "--", ...targets], { cwd: staging }));
      yield* files(removeCopies);
      const changed = summary.files_new + summary.files_changed;
      log(`${dryRun ? "would back up" : "backed up"} ${changed} new or changed ${changed === 1 ? "file" : "files"}, ${gigabytes(summary.data_added_packed ?? summary.data_added)} added${dryRun ? "" : `: snapshot ${summary.snapshot_id?.slice(0, 8)}`}`);
      const transcripts = yield* snapshotTranscripts({ dataDir, restic, now, dryRun, log });

      // Only the archive's folder's snapshots: never one of the transcripts'.
      const forget = ["forget", "--json", "--tag", SNAPSHOT_TAG, "--group-by", "tags", "--keep-daily", String(KEEP_DAILY)];
      const { forgotten, kept } = forgetResult(yield* restic.run(dryRun ? [...forget, "--dry-run"] : forget));
      if (forgotten.length > 0) log(`${dryRun ? "would forget" : "forgot"} the older ${forgotten.length === 1 ? "snapshot" : "snapshots"} ${forgotten.join(", ")}`);
      // forget --prune, as two steps so forget's --json is the whole of its output.
      if (!dryRun && forgotten.length > 0) {
        yield* restic.run(["prune", "-q"]);
        log("pruned the data only they held");
      }
      const snapshots = kept.map((s) => s.time).sort();
      log(`${snapshots.length} ${snapshots.length === 1 ? "snapshot" : "snapshots"} on ${restic.repository.name}${snapshots.length > 0 ? `, ${snapshots[0].slice(0, 10)} to ${snapshots.at(-1)!.slice(0, 10)}` : ""}`);

      if (!dryRun) {
        yield* files(async () => {
          const status = (await readNasStatus(dataDir).catch(() => null)) ?? {};
          delete status.lastFailureAt;
          delete status.lastFailure;
          const kept = transcripts?.kept ?? [];
          await writeNasStatus(dataDir, {
            ...status,
            lastSuccessAt: new Date(now).toISOString(),
            lastSuccessHost: restic.repository.name,
            snapshots,
            transcripts: kept.length > 0 ? { count: kept.length, first: kept[0].time, last: kept.at(-1)!.time } : undefined,
            freeBytes,
            resticVersion: version,
          });
        });
      }
      return { freeBytes, snapshot: dryRun ? undefined : summary.snapshot_id?.slice(0, 8), databaseBytes, changed, added: summary.data_added_packed ?? summary.data_added, forgotten, snapshots, transcripts };
    }),
  );

/**
 * The night's snapshot of the TRANSCRIPT_FOLDERS the archive's folder has, tagged TRANSCRIPTS_TAG, which no forget
 * names. restic runs from the archive's folder with them named relative to it, so each is at the snapshot's root, as
 * in the archive's. Stamped a second before the archive's, so `latest` without a tag is still the archive's folder.
 */
export const snapshotTranscripts = ({ dataDir, restic, now, dryRun, log }: { dataDir: string; restic: Restic; now: number; dryRun: boolean; log: (line: string) => void }): Effect.Effect<TranscriptsSnapshot | null, RunFailed> =>
  Effect.gen(function* () {
    const folders = TRANSCRIPT_FOLDERS.filter((folder) => existsSync(join(dataDir, folder)));
    const named = TRANSCRIPT_FOLDERS.map((folder) => `${folder}/`).join(" and ");
    if (folders.length === 0) {
      log(`the archive's folder has no ${named}: no snapshot of the transcripts`);
      return null;
    }
    const args = ["backup", "--json", "-q", "--tag", TRANSCRIPTS_TAG, "--group-by", "tags", "--time", resticTime(now - 1000), ...(dryRun ? ["--dry-run"] : [])];
    const summary = backupSummary(yield* restic.run([...args, "--", ...folders], { cwd: dataDir }));
    const changed = summary.files_new + summary.files_changed;
    const added = summary.data_added_packed ?? summary.data_added;
    const snapshot = dryRun ? undefined : summary.snapshot_id?.slice(0, 8);
    log(`${dryRun ? "would back up" : "backed up"} ${changed} new or changed ${changed === 1 ? "file" : "files"} of the transcripts (${folders.map((f) => `${f}/`).join(", ")}), ${gigabytes(added)} added${snapshot ? `: snapshot ${snapshot}, tagged ${TRANSCRIPTS_TAG}` : ""}`);
    const kept = yield* restic.snapshots(TRANSCRIPTS_TAG);
    log(`${kept.length} ${kept.length === 1 ? "snapshot" : "snapshots"} of the transcripts on ${restic.repository.name}, never forgotten${kept.length > 0 ? `, ${kept[0].time.slice(0, 10)} to ${kept.at(-1)!.time.slice(0, 10)}` : ""}`);
    return { snapshot, changed, added, kept };
  });

interface BackupSummary {
  files_new: number;
  files_changed: number;
  data_added: number;
  data_added_packed?: number;
  snapshot_id?: string;
}

/** The summary in restic backup's --json output: its last line of that type. */
export function backupSummary(output: string): BackupSummary {
  const line = output.split("\n").findLast((l) => l.includes('"message_type":"summary"'));
  if (!line) throw new Error(`restic backup gave no summary: ${output.slice(-500)}`);
  return JSON.parse(line) as BackupSummary;
}

/** What restic forget --json removed (or would), by short id, and kept. */
export function forgetResult(output: string): { forgotten: string[]; kept: Snapshot[] } {
  const groups = JSON.parse(output.trim() || "[]") as { keep?: Snapshot[] | null; remove?: Snapshot[] | null }[] | null;
  return {
    forgotten: (groups ?? []).flatMap((group) => (group.remove ?? []).map((s) => s.short_id)),
    kept: (groups ?? []).flatMap((group) => group.keep ?? []),
  };
}

/** An instant as restic's --time takes it: this Mac's local wall time, YYYY-MM-DD HH:MM:SS. */
function resticTime(at: number): string {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

export interface NasVerifyResult {
  /** The newest snapshot, by short id; none when there is none. */
  snapshot: string | null;
  /** Its databases (core.sqlite, calendar.sqlite, each module's by its path, then the other folders'), restored, by name: integrity_check's answer, or "missing". */
  integrity: Record<string, string>;
  /** The other folders it should hold and does not, by their path in it. */
  missing: string[];
  /** The newest of the transcripts' snapshots, by short id (none when there is none), and the TRANSCRIPT_FOLDERS the archive's folder has that it does not hold. */
  transcripts: { snapshot: string | null; missing: string[] };
}

/**
 * Whether a verify found the newest snapshots whole: there is one of the archive's folder, each database is ok and no
 * folder is missing, and there is one of the transcripts holding each of their folders.
 */
export function verifiedWhole(result: NasVerifyResult): boolean {
  return (
    result.snapshot !== null &&
    Object.values(result.integrity).every((answer) => answer === "ok") &&
    result.missing.length === 0 &&
    result.transcripts.snapshot !== null &&
    result.transcripts.missing.length === 0
  );
}

/**
 * restic check, reading back and decrypting CHECK_SUBSET of the data (it fails on any error), then the newest
 * snapshot's databases (core.sqlite, calendar.sqlite, each module's at its path, the ones a module keeps itself, rituals' store, and each other folder's) restored into
 * data/backups/nas/verify/, checked with
 * integrity_check, and deleted, and each other folder looked for in it; then the newest of the transcripts'
 * snapshots looked for, and each of TRANSCRIPT_FOLDERS the archive's folder has looked for in it.
 */
export const verifyNasBackup = ({ dataDir, restic, otherFolders, log = () => {} }: { dataDir: string; restic: Restic; otherFolders: Folder[]; log?: (line: string) => void }): Effect.Effect<NasVerifyResult, NasBackupError | RunFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const staging = join(dataDir, STAGING);
      yield* holdLock(staging);
      const target = join(staging, "verify");
      // Deleted however the check ends.
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(target, { recursive: true, force: true })));
      yield* restic.unlockStale();
      yield* restic.run(["check", "-q", "--read-data-subset", CHECK_SUBSET]);
      log(`restic check: no errors, ${CHECK_SUBSET} of the data read back and decrypted`);
      const transcripts = yield* verifyTranscripts({ dataDir, restic, log });
      const newest = (yield* restic.snapshots()).at(-1);
      if (!newest) {
        log(`no snapshot of the archive's folder on ${restic.repository.name}`);
        return { snapshot: null, integrity: {}, missing: [], transcripts };
      }
      const { databases, folders } = yield* files(() => backupTargets(dataDir, otherFolders));
      yield* files(() => rm(target, { recursive: true, force: true }));
      yield* restic.run(["restore", "-q", newest.id, ...databases.flatMap((d) => ["--include", `/${d.name}`]), "--target", target]);
      const integrity: Record<string, string> = {};
      for (const { name } of databases) {
        const file = join(target, name);
        integrity[name] = existsSync(file) ? yield* files(async () => integrityCheck(file)) : "missing";
        log(`snapshot ${newest.short_id} of ${newest.time}: its ${name}, restored: ${integrity[name] === "missing" ? "NOT in it" : `integrity ${integrity[name] === "ok" ? "ok" : `NOT ok:\n${integrity[name]}`}`}`);
      }
      const missing: string[] = [];
      for (const { path } of folders) {
        const there = yield* holds(restic, newest, path);
        if (!there) missing.push(path);
        log(`snapshot ${newest.short_id}: ${path} ${there ? "is in it" : "is NOT in it"}`);
      }
      return { snapshot: newest.short_id, integrity, missing, transcripts };
    }),
  );

/** The newest of the transcripts' snapshots, and which of TRANSCRIPT_FOLDERS the archive's folder has it lacks. */
const verifyTranscripts = ({ dataDir, restic, log }: { dataDir: string; restic: Restic; log: (line: string) => void }): Effect.Effect<NasVerifyResult["transcripts"], RunFailed> =>
  Effect.gen(function* () {
    const kept = yield* restic.snapshots(TRANSCRIPTS_TAG);
    const newest = kept.at(-1);
    if (!newest) {
      log(`NO snapshot of the transcripts (tagged ${TRANSCRIPTS_TAG}) on ${restic.repository.name}`);
      return { snapshot: null, missing: [] };
    }
    log(`the transcripts: ${kept.length} ${kept.length === 1 ? "snapshot" : "snapshots"}, never forgotten, the newest ${newest.short_id} of ${newest.time}`);
    const missing: string[] = [];
    for (const folder of TRANSCRIPT_FOLDERS.filter((f) => existsSync(join(dataDir, f)))) {
      const path = `/${folder}`;
      const there = yield* holds(restic, newest, path);
      if (!there) missing.push(path);
      log(`snapshot ${newest.short_id}: ${path} ${there ? "is in it" : "is NOT in it"}`);
    }
    return { snapshot: newest.short_id, missing };
  });

/** Whether a snapshot holds a path, from its root. */
const holds = (restic: Restic, snapshot: Snapshot, path: string): Effect.Effect<boolean, RunFailed> =>
  restic.run(["ls", "--json", snapshot.id, path]).pipe(
    Effect.map((listed) => listed.split("\n").some((line) => line.includes('"struct_type":"node"') && (JSON.parse(line) as { path?: string }).path === path)),
  );

/**
 * Holds `dir`/.lock for as long as the scope lasts (data/backups/nas/.lock while a run uses the staging folder, the
 * transcripts' own while they are taken: transcripts.ts); a lock left by a process that is gone is taken over.
 */
export const holdLock = (dir: string, what = "NAS backup"): Effect.Effect<void, NasBackupError, Scope.Scope> =>
  Effect.acquireRelease(
    files(async () => {
      await mkdir(dir, { recursive: true });
      const file = join(dir, ".lock");
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const handle = await open(file, "wx");
          await handle.writeFile(String(process.pid));
          await handle.close();
          return file;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const pid = Number(await readFile(file, "utf8").catch(() => ""));
          if (pid && alive(pid)) throw new Error(`another ${what} is running (process ${pid})`);
          await rm(file, { force: true });
        }
      }
      throw new Error(`could not take ${file}`);
    }),
    (file) => Effect.promise(() => rm(file, { force: true })),
  ).pipe(Effect.asVoid);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** File work on this Mac, a failure a NasBackupError saying what went wrong. */
const files = <A>(work: () => Promise<A>): Effect.Effect<A, NasBackupError> =>
  Effect.tryPromise({ try: work, catch: (error) => new NasBackupError({ message: (error as Error).message }) });

/** The launchd agent's plist: the repository's nas-backup at 06:00 each day (launchd runs a missed time on waking), kept awake while it runs (caffeinate -i). */
export function plist({ node, repo, logFile }: { node: string; repo: string; logFile: string }): string {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const strings = (items: string[]) => items.map((item) => `<string>${escape(item)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The life archive's nightly encrypted backup on the NAS (${escape(repo)}, npm run nas-backup; docs/data.md's "The NAS copy"), at 06:00, or on waking when the Mac slept through it. Written by npm run nas-backup -- install. Run now: launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL} -->
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCHD_LABEL}</string>
<key>ProgramArguments</key><array>${strings(["/usr/bin/caffeinate", "-i", node, "--no-warnings", "server/nas-backup.ts"])}</array>
<key>WorkingDirectory</key><string>${escape(repo)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(jobPath(node))}</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
<key>RunAtLoad</key><false/>
<key>ProcessType</key><string>Standard</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${escape(logFile)}</string><key>StandardErrorPath</key><string>${escape(logFile)}</string>
</dict></plist>
`;
}

export function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
}
