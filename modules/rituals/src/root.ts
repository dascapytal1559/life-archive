// Where the store is, and where the code is. HOME is the code: this folder, modules/rituals/ of a life archive
// checkout, with bin/, src/ and the ignored per-installation config/. ROOT is the store's root, under which data/
// (ritual.sqlite3, its backups, exports and the dashboard snapshots) and queue/ live: RITUAL_ROOT in the environment,
// else the absolute path on the first line of config/root beside the code (written once per installation: the life
// archive's modules/rituals/ in its data folder, where the module reads the store; README.md), else the code's
// own folder, as it was when rituals was a repository of its own (a copy of the sources in a temporary folder, as the
// tests make, keeps its store beside them).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const HOME = resolve(import.meta.dirname, "..");

/** The first line of config/root, as a path, or undefined when there is no such file. */
const configuredRoot = (): string | undefined => {
  let line: string | undefined;
  try {
    line = readFileSync(join(HOME, "config", "root"), "utf8").split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
  return line ? resolve(line) : undefined;
};

export const ROOT = process.env.RITUAL_ROOT ? resolve(process.env.RITUAL_ROOT) : (configuredRoot() ?? HOME);
