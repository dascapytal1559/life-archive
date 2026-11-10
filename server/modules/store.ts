// A module's database, which the core opens for it (sdk/server.ts's ModuleDatabase; docs/modules.md): one SQLite file in
// modules/<id>/ of the archive's folder, in WAL mode, its schema brought up to date by the module's own migrations with
// the runner the archive uses (user_version, one transaction a step), and a `meta` table of the core's beside them,
// which the module may read too (getMeta). Opened before the archive (server/serverLayer.ts's
// ModuleStores; the CLI and the testing data open them the same way), and closed after it.
//
// The one-time take-over: a module that declares `takeOver` was a part of the core once, whose rows the archive held
// (archive.sqlite, or the core's core.sqlite for the inspirations: its `takeOverFrom`); when its database is new
// (meta's `taken_over` unset) and that archive is beside it, the archive is attached to the module's connection as
// `archive`, read-only, the module copies its files (`takeOverFiles`), then what was its own in one transaction, and
// `taken_over` is set with the day, so it never happens twice. The archive is only read: what it held stays until a migration drops it, on its owner's
// word (`npm run archive -- migrate friend-map-module` for archive.sqlite's; docs/modules.md). With no archive yet (a
// new folder) there is nothing to take, and `taken_over` says so.
//
// A module whose database cannot be opened or migrated is broken, not an error: listed, said so and skipped, as one
// whose module.ts cannot be loaded is (loader.ts). So is every module with a database while the archive's folder is
// missing: only modules/<id>/ is made, under a folder that is there, as a folder made here would let a new archive
// stand in for the real one, moved or not yet in place (server/archive/index.ts's OpenArchive).

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModuleDatabase } from "../../sdk/server.ts";
import { getMeta, readOnlyAddress, setMeta, transaction } from "../archive/db.ts";
import { dayKey } from "../../src/time.ts";
import type { BrokenModule, LoadedModule, Modules } from "./loader.ts";

/** Where the modules keep their files in the archive's folder: modules/<id>/. */
export const MODULES_FOLDER = "modules";

/** The meta key that says the take-over has happened (its value the day, or "nothing" with no archive to take from). */
export const TAKEN_OVER = "taken_over";

/** The archive's database at the folder's root, as it was before friend map was a module: what a take-over copies from unless its module says otherwise. */
const ARCHIVE = "archive.sqlite";

/** A module loaded, with its database open when it declares one. */
export interface ModuleStore extends LoadedModule {
  readonly db: DatabaseSync | null;
  /** Whether this open took the module's rows over from the archive (a database new beside one): its rows are then pushed into the calendar whole (archive/index.ts). */
  readonly takenOver: boolean;
}

/** The modules with their stores: those on with their databases open, those switched off, and those broken (by their code or their database). */
export interface ModuleStores extends Modules {
  readonly on: readonly ModuleStore[];
}

/** A module's own folder in the archive's folder `folder`. */
export const moduleFolder = (folder: string, id: string): string => join(folder, MODULES_FOLDER, id);

/** The file a module's database is kept in. */
export const moduleDatabaseFile = (folder: string, id: string, database: ModuleDatabase): string => join(moduleFolder(folder, id), database.file);

/**
 * Opens (creating if need be) a module's database at `file` and brings its schema up to date; then, once, the take-over
 * from the archive at `archiveFile` when the module declares one: whether this open did it, so the caller pushes the
 * module's rows into the calendar whole.
 */
export function openModuleDatabase(file: string, database: ModuleDatabase, { archiveFile, folder = archiveFile ? dirname(archiveFile) : dirname(file) }: { archiveFile?: string; folder?: string } = {}): { db: DatabaseSync; takenOver: boolean } {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  // A database whose schema its own runner brings up (friend map's archive): opened by it, and never taken over.
  if (database.open) return { db: database.open(file, folder), takenOver: false };
  const db = new DatabaseSync(file, { timeout: 10_000 });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > database.migrations.length) throw new Error(`${file} is at schema version ${version}, newer than this code knows (${database.migrations.length})`);
    for (let next = version; next < database.migrations.length; next++) {
      transaction(db, () => {
        db.exec(database.migrations[next]!);
        db.exec(`PRAGMA user_version = ${next + 1}`);
      });
    }
    if (database.takeOver && getMeta(db, TAKEN_OVER) === null) {
      const from = database.takeOverFrom && archiveFile ? join(dirname(archiveFile), database.takeOverFrom) : archiveFile;
      return { db, takenOver: takeOver(db, database, from, folder) };
    }
    return { db, takenOver: false };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The take-over, once: the database's `takeOverFiles`, then its `takeOver` in a transaction, run with the archive `from`
 * attached as `archive` (true), or nothing to take with no archive there (false). A source other than archive.sqlite
 * still being built beside it as `<source>.partial`, or missing while archive.sqlite is still at the folder's root, is
 * an archive not yet moved (`npm run archive -- migrate friend-map-module` makes the core's from it, last): nothing is
 * marked, and the open fails, so the module is broken, nothing written into its database before the take-over can
 * meet what it copies. Checked again inside the transaction, so two processes opening the new database at once copy it
 * once.
 */
function takeOver(db: DatabaseSync, database: ModuleDatabase, from: string | undefined, folder: string): boolean {
  const moving = from !== undefined && basename(from) !== ARCHIVE && (existsSync(`${from}.partial`) || (!existsSync(from) && existsSync(join(dirname(from), ARCHIVE))));
  if (moving) throw new Error(`it takes its rows over from ${basename(from!)}, which the archive's move into friend map's module has not made yet: it waits, writing nothing, until npm run archive -- migrate friend-map-module --apply has run`);
  if (!from || !existsSync(from)) {
    setMeta(db, TAKEN_OVER, "nothing");
    return false;
  }
  db.prepare("ATTACH DATABASE ? AS archive").run(readOnlyAddress(from));
  try {
    database.takeOverFiles?.(db, folder);
    return transaction(db, () => {
      if (getMeta(db, TAKEN_OVER) !== null) return false;
      database.takeOver!(db, folder);
      setMeta(db, TAKEN_OVER, dayKey(Date.now()));
      return true;
    });
  } finally {
    db.exec("DETACH DATABASE archive");
  }
}

/**
 * Opens the database of each loaded module that declares one, in the archive's folder `folder` (its take-over from
 * `folder`'s archive.sqlite): a module whose database cannot be opened is broken, as is each that has one while `folder`
 * is missing, which is never made here.
 */
export function openModuleStores(modules: Modules, folder: string): ModuleStores {
  const on: ModuleStore[] = [];
  const broken: BrokenModule[] = [...modules.broken];
  for (const module of modules.on) {
    const { database } = module.definition;
    if (!database) {
      on.push({ ...module, db: null, takenOver: false });
      continue;
    }
    if (!existsSync(folder)) {
      broken.push({ id: module.id, folder: module.folder, problem: `there is no archive's folder at ${folder}`, paths: modulePaths(module.definition) });
      continue;
    }
    const file = moduleDatabaseFile(folder, module.id, database);
    try {
      on.push({ ...module, ...openModuleDatabase(file, database, { archiveFile: join(folder, "archive.sqlite") }) });
    } catch (error) {
      broken.push({ id: module.id, folder: module.folder, problem: `its database ${file} could not be opened: ${(error as Error).message}`, paths: modulePaths(module.definition) });
    }
  }
  return { on, off: modules.off, broken: broken.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** The paths outside MODULES_API a loaded module answers: its route's `mounts` and its page's path. */
function modulePaths(definition: LoadedModule["definition"]): string[] {
  return [...(definition.routes ? (definition.mounts ?? []) : []), ...(definition.page ? [definition.page.path] : [])];
}

/** Closes every open database of `stores`. */
export function closeModuleStores(stores: ModuleStores): void {
  for (const store of stores.on) store.db?.close();
}

/** No modules at all: for an archive opened by code that loads none (most tests). */
export const NO_MODULES: ModuleStores = { on: [], off: [], broken: [] };
