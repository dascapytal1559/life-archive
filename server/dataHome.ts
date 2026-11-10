// Where the archive's folder is (archive.sqlite, its backups, the platforms' exports and media, the
// connectors' settings and the imports waiting to be moved), and the life archive's other settings.
//
// LIFE_ARCHIVE_DATA names the archive's folder, else it is ~/life-archive-data, outside every checkout
// (see defaultFolder for the two checkouts that are the exception). FRIEND_MAP_DATA, the name friend-map
// gave it while the archive was friend-map's (where it also named friend-map's own folder), is taken
// too, so a habit like FRIEND_MAP_DATA=/tmp/testing still runs on that folder and never on the real
// archive. Each is read from the environment, then from .env.local in this
// repository (gitignored, KEY=value lines; a relative path is from the repository, and ~/ is the home
// folder), so every entry point (the server, npm run archive, check-data, the connectors' scripts)
// finds it without anything exported. The first source naming either decides, LIFE_ARCHIVE_DATA first
// within it: FRIEND_MAP_DATA=/tmp/testing in the environment runs on that folder alone, whatever
// .env.local names.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The archive's folder in the home folder, when nothing names another. */
const DEFAULT_FOLDER = "life-archive-data";

/** The archive's folder (see the top of this file). */
export function archiveFolder({ root = REPO, env = process.env }: { root?: string; env?: NodeJS.ProcessEnv } = {}): string {
  for (const [values, base] of [[env, process.cwd()], [envFile(join(root, ".env.local")), root]] as const) {
    const named = values.LIFE_ARCHIVE_DATA || values.FRIEND_MAP_DATA;
    if (named) return resolve(base, expandTilde(named));
  }
  return defaultFolder(root);
}

/**
 * The archive folders that may be on this machine for the checkout at `root`: its own (archiveFolder), and in a linked
 * worktree, whose own is its empty data/, also the one of the checkout it was made from, which a worktree never opens
 * but whose names a build here (the demo's) must still be checked against and refuse.
 */
export function archivesOf({ root = REPO, env = process.env }: { root?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const own = archiveFolder({ root, env });
  if (!lstatSync(join(root, ".git"), { throwIfNoEntry: false })?.isFile()) return [own];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    return [...new Set([own, archiveFolder({ root: dirname(common), env })])];
  } catch {
    return [own];
  }
}

/**
 * The archive's folder when nothing names one: ~/life-archive-data, unless
 *   - the checkout still holds a real data/ folder, as one did before the folder moved out: it keeps it, so landing this
 *     code is safe before the move and a job never starts a second, empty archive. A link at data/ (the one the move
 *     leaves behind for stragglers) is not a folder, so nothing here goes through it;
 *   - the checkout is a linked git worktree (its .git is a file): an agent's or the pipeline's, whose code may be
 *     unlanded and whose every run would migrate the real archive, so it has its own empty data/ as it always had.
 */
function defaultFolder(root: string): string {
  const inCheckout = join(root, "data");
  const kept = lstatSync(inCheckout, { throwIfNoEntry: false })?.isDirectory();
  const worktree = lstatSync(join(root, ".git"), { throwIfNoEntry: false })?.isFile();
  return kept || worktree ? inCheckout : join(homedir(), DEFAULT_FOLDER);
}

/** A setting from the environment, else from .env.local in the repository at `root`; undefined when neither names it. */
export function envSetting(key: string, { root = REPO, env = process.env }: { root?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  return env[key] || envFile(join(root, ".env.local"))[key] || undefined;
}

/** A path setting: envSetting's, its ~/ read as the home folder. */
export function pathSetting(key: string, options: { root?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  const named = envSetting(key, options);
  return named === undefined ? undefined : expandTilde(named);
}

/** The Node a job's launchd agent runs, as its install writes it: LIFE_ARCHIVE_NODE, else the Node running this. */
export function jobNode(options: { root?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return pathSetting("LIFE_ARCHIVE_NODE", options) ?? process.execPath;
}

/** launchd's PATH for an agent running `node`: that Node's folder, then `first`, then where tools are on a Mac. */
export function jobPath(node: string, ...first: string[]): string {
  return [dirname(node), ...first, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

/** Where the archive's server answers (server/main.ts), as friend-map reaches it: LIFE_ARCHIVE_URL, from the environment or .env.local, else port 4650 on this Mac. */
export function archiveUrl(options: { root?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return envSetting("LIFE_ARCHIVE_URL", options) ?? "http://127.0.0.1:4650";
}

/**
 * The header friend-map sends the archive's server with the archive's folder it was given (encodeURIComponent'd), on
 * every request: the server answers 503 when it keeps another, so friend-map on a testing folder never meets the real
 * archive, whatever server LIFE_ARCHIVE_URL names (server/archive/server.ts).
 */
export const ARCHIVE_FOLDER_HEADER = "x-archive-folder";

/** Whether two paths are one folder, through any symbolic link; a path that does not exist is compared as written. */
export function sameFolder(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

function expandTilde(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

/**
 * Set to 1, .env.local is not read at all: the static demo's build runs the server over the made-up data so (tools/
 * demo/record.ts), so nothing of this machine's own (a key, a host) reaches an answer the demo keeps.
 */
export const NO_ENV_FILE = "LIFE_ARCHIVE_NO_ENV_FILE";

function envFile(path: string): Record<string, string> {
  if (process.env[NO_ENV_FILE] === "1") return {};
  try {
    return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
}
