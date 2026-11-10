// Which modules are installed (docs/modules.md): each folder modules/<id>/ in the checkout whose package.json says
// "lifeArchive": true; the folder's name is the module's id. Only what is on disk, nothing imported, so the settings
// (settings.ts, which takes a key naming an installed module as that module's own) can ask before any module loads;
// loader.ts loads them.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../dataHome.ts";

/** Where the modules are, from the repository's root. */
export const MODULES_DIR = "modules";

/** A module found in the checkout: its id (its folder's name) and its folder. */
export interface InstalledModule {
  readonly id: string;
  readonly folder: string;
}

/** A module whose package.json was read, and whether it is ready for anyone (src/pages.ts). */
export interface FoundModule extends InstalledModule {
  /** Its package.json's `lifeArchiveReady`: false for a page this repository ships unfinished; a private module, which says nothing, is ready. */
  readonly ready: boolean;
}

/** A module that could not be loaded, and why. */
export interface BrokenModule extends InstalledModule {
  readonly problem: string;
  /** The paths outside MODULES_API it would answer (its `mounts` and its page's path), when it loaded but its database could not open: answered 503 with the problem. */
  readonly paths?: readonly string[];
}

/** The folder `id` under `dir`: a module, one broken as its package.json cannot be read, or null if that says it is none. */
function moduleAt(dir: string, id: string): FoundModule | BrokenModule | null {
  const folder = join(dir, id);
  const file = join(folder, "package.json");
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { lifeArchive?: unknown; lifeArchiveReady?: unknown } | null;
    return manifest?.lifeArchive === true ? { id, folder, ready: manifest.lifeArchiveReady !== false } : null;
  } catch (error) {
    return { id, folder, problem: `${file} could not be read: ${(error as Error).message}` };
  }
}

/**
 * Set in the environment (to anything), the modules git does not track in the checkout are not installed at all: for a
 * build anyone may see (the demo's, tools/demo/build.ts), whose made-up folder, server and pages would otherwise carry
 * a private module's code, name and database. It fails closed: where git cannot say, it throws.
 */
export const TRACKED_MODULES_ONLY = "LIFE_ARCHIVE_TRACKED_MODULES_ONLY";

/** The ids of the modules git tracks in the checkout at `root` (a private module is gitignored: docs/modules.md). */
export function trackedModules(root = REPO): Set<string> {
  const files = execFileSync("git", ["ls-files", "--", ":(glob)modules/*/package.json"], { cwd: root, encoding: "utf8" });
  return new Set(files.split("\n").filter(Boolean).map((file) => file.split("/")[1]!));
}

/**
 * The modules installed under `root`'s modules/, by id: each folder whose package.json says "lifeArchive": true, or
 * cannot be read; those git tracks alone when the environment `env` sets TRACKED_MODULES_ONLY.
 */
export function installedModules(root = REPO, env: NodeJS.ProcessEnv = process.env): Array<FoundModule | BrokenModule> {
  const dir = join(root, MODULES_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const tracked = env[TRACKED_MODULES_ONLY] ? trackedModules(root) : null;
  return entries.sort().flatMap((id) => (tracked && !tracked.has(id) ? [] : (moduleAt(dir, id) ?? [])));
}
