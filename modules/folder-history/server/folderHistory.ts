// The folder history: a private git history of folders the archive does not own (a shared Google Drive folder, say),
// since Drive keeps only about 100 versions or 30 days of each file and never says what changed across files at once.
//
// Each folder named in data/connectors/folder-history.json ({"folders": [{"name": "shared-notes", "path": "~/..."}]}) has
// its history in data/history/<name>/, inside the archive's folder, so the NAS's nightly snapshot keeps it with
// everything else (the core's server/archive/nasBackup.ts). The history is a bare git repository with no remote, ever: one that has a
// remote is refused, and nothing here pushes. The folder is its work tree, named on each git command and never in
// the repository's settings, so no git command run there by hand can write into the folder.
//
// Never writes into the folder: it only lists it (folderFiles) and git reads it (`git add`). A record:
//   1. lists the folder's files, leaving out hidden ones (a name starting with ".": Drive's .tmp.drivedownload, the
//      Finder's .DS_Store, a nested .git) and Drive's and Office's temporary ones (SKIPPED);
//   2. stages exactly those files, in place of what the last commit had: added, changed and deleted, the folder's own
//      .gitignore files never consulted (`add -f`, literal pathspecs);
//   3. commits, when anything changed, with a message listing each file changed (`added`, `changed`, `deleted`).
// It notices Drive's conflict copies (`todo (1).md` beside `todo.md`) and says them; it keeps them in the history as
// it keeps any file, and never touches them.
//
// Runs in the archive's server for as long as it runs, as the module's work (../module.ts), in Effect (docs/effect.md),
// with the same settling of a folder's changes as the agents' conversations' sync (the SDK's `settled`): a record when
// it starts and every hour, for anything missed, and one about 3 s after a change in the folder settles (macOS's file
// events, fs.watch), or at most 30 s after the first while they keep changing; one at a time, a record begun finished
// before it stops. `npm run archive -- history` says how each folder's history is doing (folderReport), and
// `npm run archive -- history <name>` shows a history's recent commits (file names only) and the conflict copies
// (commands.ts).

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Queue, Schedule, Stream } from "effect";
import { expandHome, isMissingFile, run, RunFailed, settled, type FolderChange } from "../../../sdk/server.ts";

/** The settings, in the archive's folder. */
export const SETTINGS_FILE = join("connectors", "folder-history.json");
/** Where the histories are, in the archive's folder: one repository each, by name. */
export const HISTORY_FOLDER = "history";

/** A folder to keep the history of: its name (its repository's) and where it is, as written (`~/` for the home folder). */
export interface HistoryFolder {
  name: string;
  path: string;
}

export interface FolderHistorySettings {
  folders: HistoryFolder[];
  /** How long the folder must be quiet before a record (3 s); for tests, the settings can say otherwise. */
  settleMs: number;
  /** The longest a record waits while changes keep coming (30 s). */
  maxWaitMs: number;
  /** How often it records anyway, for any change missed (an hour). */
  rescanMs: number;
}

/** The settings cannot be read, or a history cannot be kept as it is: what, in plain words. */
export class FolderHistoryError extends Data.TaggedError("FolderHistoryError")<{ readonly message: string }> {}

/** A history has a remote, which it never may: it is refused until the remote is removed. */
export class HistoryHasRemote extends Data.TaggedError("HistoryHasRemote")<{ readonly message: string }> {}

/** The folder is not there (Drive not running or signed out, a shortcut gone): nothing is recorded, not even as deleted. */
export class FolderMissing extends Data.TaggedError("FolderMissing")<{ readonly message: string }> {}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The settings from the archive's folder: no folders when there is no settings file. */
export const readSettings = (dataDir: string): Effect.Effect<FolderHistorySettings, FolderHistoryError> =>
  Effect.tryPromise({
    try: async () => {
      let text: string;
      try {
        text = await readFile(join(dataDir, SETTINGS_FILE), "utf8");
      } catch (error) {
        if (isMissingFile(error)) text = "{}";
        else throw error;
      }
      return parseSettings(JSON.parse(text) as unknown);
    },
    catch: (error) => new FolderHistoryError({ message: `data/${SETTINGS_FILE}: ${(error as Error).message}` }),
  });

/** Settings as written, checked: each folder a name (lower-case letters, digits and hyphens, once each) and a path. */
export function parseSettings(value: unknown): FolderHistorySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("must hold a JSON object");
  const { folders = [], settleMs = 3_000, maxWaitMs = 30_000, rescanMs = 60 * 60_000 } = value as Record<string, unknown>;
  if (!Array.isArray(folders)) throw new Error(`"folders" must be a list of {"name", "path"}`);
  const names = new Set<string>();
  for (const folder of folders as unknown[]) {
    const { name, path } = (folder ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`each folder needs a name of lower-case letters, digits and hyphens, not ${JSON.stringify(name)}`);
    if (typeof path !== "string" || path === "") throw new Error(`folder ${name} needs a path`);
    if (names.has(name)) throw new Error(`two folders are named ${name}`);
    names.add(name);
  }
  for (const [key, ms] of Object.entries({ settleMs, maxWaitMs, rescanMs })) {
    if (typeof ms !== "number" || !(ms > 0)) throw new Error(`"${key}" must be a number of milliseconds`);
  }
  return { folders: folders as HistoryFolder[], settleMs: settleMs as number, maxWaitMs: maxWaitMs as number, rescanMs: rescanMs as number };
}

/** A folder's history repository, in the archive's folder. */
export const historyDir = (dataDir: string, name: string) => join(dataDir, HISTORY_FOLDER, name);

/**
 * Whether a file or folder of this name is left out: hidden (Drive's .tmp.drivedownload and .tmp.driveupload, the
 * Finder's .DS_Store and Icon files, a nested .git), an Office owner file (~$report.docx) or a temporary file.
 */
export function skipped(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || name === "Icon\r" || name.endsWith(".tmp");
}

/** Whether any part of a path relative to the folder is left out. */
const skippedPath = (path: string) => path.split("/").some(skipped);

/** The folder's files (and links), as paths relative to it with "/" between parts, sorted; folders left out are not entered. */
export async function folderFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skipped(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`);
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
    }
  };
  await walk(folder, "");
  return found.sort();
}

/** A conflict copy Drive made (`todo (1).md`), and the file it is a copy of (`todo.md`), beside it. */
export interface ConflictCopy {
  copy: string;
  of: string;
}

/** Drive's numbered copies among `files` (paths relative to the folder): each `name (n).ext` beside a `name.ext`. */
export function conflictCopies(files: readonly string[]): ConflictCopy[] {
  const all = new Set(files);
  return files.flatMap((copy) => {
    const found = /^(.*?) \(\d+\)((?:\.[^./ ]+)?)$/.exec(copy);
    if (!found) return [];
    const of = found[1] + found[2];
    return all.has(of) ? [{ copy, of }] : [];
  });
}

/** How Drive's conflict copies are said: `todo (1).md (beside todo.md)`. */
export const conflictText = (copies: readonly ConflictCopy[]) => copies.map(({ copy, of }) => `${copy} (beside ${of})`).join(", ");

/** A file changed in a commit: added, changed or deleted. */
export interface FileChange {
  change: "added" | "changed" | "deleted";
  path: string;
}

const CHANGE_OF: Record<string, FileChange["change"]> = { A: "added", M: "changed", T: "changed", D: "deleted" };

/** The commit's message: a line counting the changes, then each file changed. */
export function commitMessage(changes: readonly FileChange[]): string {
  const counts = (["added", "changed", "deleted"] as const).flatMap((change) => {
    const n = changes.filter((c) => c.change === change).length;
    return n > 0 ? [`${n} ${change}`] : [];
  });
  return `${changes.length} ${changes.length === 1 ? "file" : "files"}: ${counts.join(", ")}\n\n${changes.map((c) => `${c.change} ${c.path}`).join("\n")}\n`;
}

/** Who the commits are by: this code, not a person (Drive does not say who changed a file). */
const AUTHOR = ["-c", "user.name=life-archive folder history", "-c", "user.email=folder-history@life-archive.invalid"];

/**
 * Git with nothing of this Mac's own git settings (no global or system config: no hooks, signing, fsmonitor or
 * excludes), on the repository and, given, the folder as its work tree, pathspecs taken literally.
 */
const git = (repo: string, args: string[], { folder, input }: { folder?: string; input?: string } = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT"].includes(key)) delete env[key];
  return run("git", [
    "--git-dir", repo, ...(folder ? ["--work-tree", folder] : []), "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.quotePath=false",
    ...args,
  ], { env, ...(input === undefined ? {} : { input }) }).pipe(Effect.map(({ stdout }) => stdout));
};

/** NUL-separated paths, as git's --pathspec-file-nul reads them. */
const nul = (paths: readonly string[]) => paths.map((path) => `${path}\0`).join("");

/** The remotes a repository has; it must have none. */
const refuseRemotes = (repo: string) =>
  Effect.gen(function* () {
    const remotes = (yield* git(repo, ["remote"])).split("\n").filter(Boolean);
    if (remotes.length > 0) {
      return yield* new HistoryHasRemote({
        message: `${repo} has a remote (${remotes.join(", ")}), and a folder's history is never to leave this Mac: remove it with git --git-dir ${repo} remote remove ${remotes[0]}`,
      });
    }
  });

/** The history's repository, made when it is not there: refused when it is something else, or has a remote. */
export const openHistory = (repo: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(repo).catch((error) => (isMissingFile(error) ? null : Promise.reject(error))),
      catch: (error) => new FolderHistoryError({ message: (error as Error).message }),
    });
    if (entries === null || entries.length === 0) {
      yield* Effect.tryPromise({ try: () => mkdir(repo, { recursive: true }), catch: (error) => new FolderHistoryError({ message: (error as Error).message }) });
      yield* git(repo, ["init", "--quiet", "--bare", "--initial-branch=main"]);
    } else {
      const bare = yield* git(repo, ["rev-parse", "--is-bare-repository"]).pipe(Effect.orElseSucceed(() => ""));
      if (bare.trim() !== "true") return yield* new FolderHistoryError({ message: `${repo} is there and is not a folder's history (a bare git repository); move it aside` });
    }
    yield* refuseRemotes(repo);
  });

/** Where the folder is now, the links on the way followed (Drive's shortcut to a shared folder is one). */
export const resolveFolder = (path: string): Effect.Effect<string, FolderMissing | FolderHistoryError> =>
  Effect.tryPromise({
    try: async () => {
      const real = await realpath(expandHome(path));
      if (!(await stat(real)).isDirectory()) throw Object.assign(new Error(`${path} is not a folder`), { code: "ENOTDIR" });
      return real;
    },
    catch: (error) =>
      ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
        ? new FolderMissing({ message: `${path} is not there` })
        : new FolderHistoryError({ message: (error as Error).message }),
  });

/** What a record did: the commit it made (or null when nothing changed), its files, and the conflict copies it saw. */
export interface Recorded {
  commit: string | null;
  changes: FileChange[];
  conflicts: ConflictCopy[];
}

/** How long an index.lock may stand before it is taken for one a stopped git left (a record takes seconds). */
const STALE_LOCK_MS = 10 * 60_000;

/** One record of the folder into its history (see the top of this file). */
export const record = (repo: string, path: string): Effect.Effect<Recorded, FolderMissing | FolderHistoryError | HistoryHasRemote | RunFailed> =>
  Effect.gen(function* () {
    yield* refuseRemotes(repo);
    const folder = yield* resolveFolder(path);
    const files = yield* Effect.tryPromise({ try: () => folderFiles(folder), catch: (error) => new FolderHistoryError({ message: `could not list ${path}: ${(error as Error).message}` }) });
    yield* Effect.tryPromise({ try: () => clearStaleLock(repo), catch: (error) => new FolderHistoryError({ message: (error as Error).message }) });
    const kept = (yield* git(repo, ["ls-files", "-z"], { folder })).split("\0").filter(Boolean);
    const here = new Set(files);
    const gone = kept.filter((file) => !here.has(file));
    if (gone.length > 0) yield* git(repo, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { folder, input: nul(gone) });
    if (files.length > 0) yield* git(repo, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { folder, input: nul(files) });
    const staged = (yield* git(repo, ["diff", "--cached", "--no-renames", "--name-status", "-z"], { folder })).split("\0").filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < staged.length; i += 2) changes.push({ change: CHANGE_OF[staged[i]] ?? "changed", path: staged[i + 1] });
    const conflicts = conflictCopies(files);
    if (changes.length === 0) return { commit: null, changes, conflicts };
    yield* git(repo, [...AUTHOR, "commit", "--quiet", "--no-verify", "--file=-"], { folder, input: commitMessage(changes) });
    const commit = (yield* git(repo, ["rev-parse", "HEAD"])).trim();
    return { commit, changes, conflicts };
  });

async function clearStaleLock(repo: string): Promise<void> {
  const lock = join(repo, "index.lock");
  const found = await stat(lock).catch(() => null);
  if (found && Date.now() - found.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
}

/** How a record's commit is said in the log. */
const recordedText = ({ changes }: Recorded) => commitMessage(changes).split("\n")[0];

/**
 * Keeps one folder's history (see the top of this file) until it is interrupted, saying what it does through `log`.
 * A history that cannot be kept (a remote, something else in its place) is said and left; a record that fails (the
 * folder gone, git failing) is said, and the next change or the hourly record tries again.
 */
export const keepFolder = (dataDir: string, folder: HistoryFolder, settings: Omit<FolderHistorySettings, "folders">, log: (line: string) => void) =>
  Effect.scoped(
    Effect.gen(function* () {
      const repo = historyDir(dataDir, folder.name);
      const say = (line: string) => Effect.sync(() => log(`${folder.name}: ${line}`));
      const opened = yield* openHistory(repo).pipe(Effect.as(true), Effect.catch((error) => say(`not kept: ${error.message}`).pipe(Effect.as(false))));
      if (!opened) return;

      const changes = yield* Queue.unbounded<FolderChange>();
      /** The folder watched, where it was when the watcher was made, so one that moves (a shortcut changed) is watched again. */
      let watching: { at: string; watcher: FSWatcher } | null = null;
      const unwatch = () => {
        watching?.watcher.close();
        watching = null;
      };
      yield* Effect.addFinalizer(() => Effect.sync(unwatch));
      const watchAt = (at: string) =>
        Effect.sync(() => {
          if (watching?.at === at) return;
          unwatch();
          try {
            const watcher = watch(at, { recursive: true }, (_event, name) => {
              const file = name === null ? null : String(name);
              if (file === null || !skippedPath(file)) Queue.offerUnsafe(changes, { folder: at, name: file });
            });
            watcher.on("error", () => {
              if (watching?.watcher === watcher) unwatch();
            });
            watching = { at, watcher };
          } catch {
            // Not there just now: the next hourly record looks again.
          }
        });

      let saidState = "";
      let saidConflicts = "";
      const recordNow = Effect.gen(function* () {
        // Watched before the record, so a change made while it records is not missed until the hourly one.
        yield* watchAt(yield* resolveFolder(folder.path));
        const done = yield* record(repo, folder.path);
        if (done.commit) yield* say(`recorded ${recordedText(done)} (${done.commit.slice(0, 7)})`);
        const conflicts = done.conflicts.length === 0 ? "" : `${done.conflicts.length} Drive conflict ${done.conflicts.length === 1 ? "copy" : "copies"}: ${conflictText(done.conflicts)}`;
        if (conflicts !== saidConflicts) yield* say(conflicts || "no Drive conflict copies now");
        saidConflicts = conflicts;
        saidState = "";
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.message !== saidState) yield* say(`not recorded: ${error.message}`);
            saidState = error.message;
          }),
        ),
        Effect.uninterruptible,
      );

      yield* say(`keeping ${folder.path} in ${repo}`);
      // A record now and every rescanMs, and one each time the folder's changes settle: one at a time, in turn.
      const hourly = Stream.fromSchedule(Schedule.fixed(settings.rescanMs)).pipe(Stream.prepend([0]));
      yield* Stream.merge(hourly, settled(changes, settings)).pipe(Stream.runForEach(() => recordNow));
    }),
  );

/** Keeps every folder's history named in the archive's settings, each on its own, until interrupted. */
export const keepHistories = (dataDir: string, log: (line: string) => void): Effect.Effect<void> =>
  Effect.gen(function* () {
    const settings = yield* readSettings(dataDir);
    yield* Effect.forEach(settings.folders, (folder) => keepFolder(dataDir, folder, settings, log), { concurrency: "unbounded", discard: true });
  }).pipe(Effect.catch((error) => Effect.sync(() => log(`not kept: ${error.message}`))));

/** A commit in a history: when, its hash, and its files. */
export interface HistoryCommit {
  commit: string;
  at: number;
  changes: FileChange[];
}

/** A history's last `last` commits, newest first, with the files each changed (never their content). */
export const recentCommits = (repo: string, last: number): Effect.Effect<HistoryCommit[], RunFailed> =>
  Effect.gen(function* () {
    const out = yield* git(repo, ["log", `--max-count=${last}`, "--no-renames", "--name-status", "-z", "--format=%x01%H %ct"]).pipe(
      // A history with no commit yet has no log.
      Effect.catch((error) => (/does not have any commits|bad default revision/.test(error.message) ? Effect.succeed("") : Effect.fail(error))),
    );
    return out.split("\x01").filter((part) => part.trim()).map((part) => {
      // "<hash> <seconds>", then each change's status and path, every field ended by a NUL (the first change's after a newline).
      const [head, ...rest] = part.split("\0");
      const [commit, seconds] = head.trim().split(" ");
      const fields = rest.map((field) => field.replace(/^\n/, "")).filter(Boolean);
      const changes: FileChange[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ change: CHANGE_OF[fields[i]] ?? "changed", path: fields[i + 1] });
      return { commit, at: Number(seconds) * 1000, changes };
    });
  });

/** How a folder's history is, for the CLI. */
export interface FolderReport {
  folder: HistoryFolder;
  repo: string;
  /** Where the folder is now, or why it cannot be read. */
  resolved: string | { missing: string };
  /** How many commits the history has, and the last. */
  commits: number;
  last: HistoryCommit | null;
  /** Files the folder has that the history's last commit does not have as they are now: what the next record would commit. */
  pending: FileChange[] | null;
  conflicts: ConflictCopy[];
  /** Why the history cannot be kept (a remote, something else in its place), if it cannot. */
  problem: string | null;
}

/** How a folder's history is: read only, of the folder and of the history (never written, nor the repository made). */
export const folderReport = (dataDir: string, folder: HistoryFolder): Effect.Effect<FolderReport> =>
  Effect.gen(function* () {
    const repo = historyDir(dataDir, folder.name);
    const hasRepo = yield* Effect.promise(() => stat(join(repo, "HEAD")).then(() => true, () => false));
    const problem = !hasRepo
      ? null
      : yield* refuseRemotes(repo).pipe(Effect.as(null), Effect.catch((error) => Effect.succeed(error.message)));
    const commits = hasRepo ? Number((yield* git(repo, ["rev-list", "--count", "HEAD"]).pipe(Effect.orElseSucceed(() => "0"))).trim()) : 0;
    const last = commits > 0 ? ((yield* recentCommits(repo, 1).pipe(Effect.orElseSucceed(() => [])))[0] ?? null) : null;
    const resolved = yield* resolveFolder(folder.path).pipe(Effect.catch((error) => Effect.succeed({ missing: error.message })));
    if (typeof resolved !== "string") return { folder, repo, resolved, commits, last, pending: null, conflicts: [], problem };
    const files = yield* Effect.tryPromise(() => folderFiles(resolved)).pipe(Effect.orElseSucceed(() => null));
    if (files === null) return { folder, repo, resolved: { missing: `${folder.path} cannot be read` }, commits, last, pending: null, conflicts: [], problem };
    const tree = commits > 0 ? yield* git(repo, ["ls-tree", "-r", "-z", "HEAD"]).pipe(Effect.orElseSucceed(() => "")) : "";
    const pending = yield* Effect.promise(() => pendingChanges(resolved, files, tree));
    return { folder, repo, resolved, commits, last, pending, conflicts: conflictCopies(files), problem };
  });

/** What differs between the folder's files and a commit's tree (`git ls-tree -r -z`), by each file's git blob id. */
async function pendingChanges(folder: string, files: readonly string[], tree: string): Promise<FileChange[]> {
  const committed = new Map<string, string>();
  for (const line of tree.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    committed.set(line.slice(tab + 1), line.slice(0, tab).split(" ")[2]);
  }
  const changes: FileChange[] = [];
  for (const file of files) {
    if (!committed.has(file)) changes.push({ change: "added", path: file });
    else if ((await blobId(join(folder, file)).catch(() => null)) !== committed.get(file)) changes.push({ change: "changed", path: file });
  }
  const here = new Set(files);
  for (const file of committed.keys()) if (!here.has(file)) changes.push({ change: "deleted", path: file });
  return changes;
}

/** The id git gives a file's content (a link's, its target's name), as `git hash-object` would, without git. */
async function blobId(path: string): Promise<string> {
  const content = (await lstat(path)).isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
