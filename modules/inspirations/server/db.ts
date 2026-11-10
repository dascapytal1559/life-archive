// The inspirations module's own database, inspirations.sqlite in modules/inspirations/ of the archive's folder, which
// the core opens for it (sdk/server.ts's ModuleDatabase; server/modules/store.ts runs the migrations and the take-over):
//
//   inspiration, inspiration_save, inspiration_file, inspiration_tag, inspiration_item_tag, inspiration_ai_tag,
//   inspiration_fetch    the captain's inspirations (store.ts): each thing he keeps, every save of it, its kept files
//                        (files.ts), his tags and the AI's, and the paced platforms' fetches, as the core's database
//                        held them until 8 November 2026, column for column
//   changeset, change_row     their change log (the core's changes.ts, given their tables: changeLog.ts), so every edit
//                        of his can be undone
//   meta                 the core's (taken_over)
//
// The take-over (takeOver): the inspirations were the core's, in core.sqlite. When this database is new beside it,
// everything of theirs there is copied in, in one transaction, ids kept, so an item's address and
// an Undo of an edit made before go on meaning what they did:
//
//   1. each table above, row for row (the core's changeset tables logged the inspirations alone, so all of them come)
//   2. each kept file, from where the core kept it (platform-exports/inspirations/live/, named from the archive's
//      folder) into the module's files/ by its hash (files.ts), staged in the module's .incoming/ and checked against
//      its row's sha256 before it is renamed into place, before the transaction begins (copyKeptFiles), so a slow copy
//      holds no lock; in the transaction, the path of each row whose file is in files/ is made the new one. A file
//      missing at its old place, or whose bytes are not its sha256, is said, its row kept as it was, old path and all
//      (check-data names it)
//   3. checked before it commits: every table holds exactly the rows the core's does, ids and every column the same
//      (a file's path aside); anything else throws, the transaction is undone, and the module is broken, saying why,
//      until the next open tries again
//
// It never deletes: the core's tables and files stay where they were (they may hold the only copy of something), until
// the captain says they may go. A file already in files/ (a take-over tried before) is not copied again, so trying
// again is safe.

import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CHANGE_LOG_TABLES, CORE_FILE, type ModuleDatabase } from "../../../sdk/server.ts";
import { inspirationsFolder, keptPath } from "./files.ts";
import { INSPIRATION_STORE_TABLES } from "./store.ts";

/** The database's file, in modules/inspirations/ of the archive's folder. */
export const INSPIRATIONS_DB = "inspirations.sqlite";

/** Each moves the schema one version forward; never edit one that has shipped, add one. */
const MIGRATIONS: readonly string[] = [
  // The tables as the core's database had them (server/archive/coreDb.ts's first migration), and the change log's.
  `
  CREATE TABLE inspiration (
      id INTEGER PRIMARY KEY,
      link TEXT UNIQUE,                          -- canonical; NULL for a kept file with no link
      platform TEXT NOT NULL CHECK (platform <> ''),
      form TEXT NOT NULL CHECK (form IN ('post', 'reel', 'video', 'short', 'tweet', 'article', 'image', 'other')),
      title TEXT,
      author TEXT,
      description TEXT,
      image_url TEXT,
      caption TEXT NOT NULL DEFAULT '',          -- his words for it, written as a note is
      hidden_at INTEGER,                         -- hidden from the page, as the tag archive hides a person
      created_at INTEGER NOT NULL,
      edited_at INTEGER,                         -- when he last changed its caption, tags or hidden
      preview_state TEXT NOT NULL DEFAULT 'pending' CHECK (preview_state IN ('pending', 'done', 'none', 'failed')),
      ai_state TEXT NOT NULL DEFAULT 'pending' CHECK (ai_state IN ('pending', 'done', 'failed')),
      ai_model TEXT,
      ai_at INTEGER,
      ai_error TEXT,
      ai_tries INTEGER NOT NULL DEFAULT 0,
      ai_retry_at INTEGER NOT NULL DEFAULT 0,    -- not asked again before this, after a failed try
      preview_tries INTEGER NOT NULL DEFAULT 0,
      preview_retry_at INTEGER NOT NULL DEFAULT 0,
      preview_note TEXT,                         -- what a paced preview's last try said
      probe_requested_at INTEGER,                -- old items only: when firstmate was told his words ask for a probe (nothing sets it any more)
      probe_result TEXT,                         -- old items only: the probe's result's link
      probe_result_at INTEGER
    );
  CREATE INDEX inspiration_created ON inspiration(created_at);
  CREATE INDEX inspiration_queue ON inspiration(preview_state, ai_state);
  CREATE TABLE inspiration_ai_tag (
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rank INTEGER NOT NULL,
      PRIMARY KEY (inspiration_id, name)
    );
  CREATE INDEX inspiration_ai_tag_name ON inspiration_ai_tag(name);
  CREATE TABLE inspiration_fetch (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      inspiration_id INTEGER REFERENCES inspiration(id) ON DELETE SET NULL,
      at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('found', 'empty', 'blocked', 'failed')),
      note TEXT,
      next_at INTEGER NOT NULL                   -- the platform's next fetch not before this
    );
  CREATE INDEX inspiration_fetch_at ON inspiration_fetch(platform, at);
  CREATE TABLE inspiration_file (
      id INTEGER PRIMARY KEY,
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('item', 'preview')),
      path TEXT NOT NULL,                        -- from the module's folder: files/<ab>/<sha256>.<ext> (files.ts)
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      UNIQUE (inspiration_id, sha256)
    );
  CREATE INDEX inspiration_file_sha ON inspiration_file(sha256);
  CREATE TABLE inspiration_item_tag (
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES inspiration_tag(id),
      added_at INTEGER NOT NULL,
      PRIMARY KEY (inspiration_id, tag_id)
    );
  CREATE INDEX inspiration_item_tag_tag ON inspiration_item_tag(tag_id);
  CREATE TABLE inspiration_save (
      id INTEGER PRIMARY KEY,
      inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK (origin <> ''),
      native_id TEXT,
      link TEXT,
      caption TEXT NOT NULL DEFAULT '',
      saved_at INTEGER,
      UNIQUE (origin, native_id)
    );
  CREATE INDEX inspiration_save_item ON inspiration_save(inspiration_id);
  CREATE TABLE inspiration_tag (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  ${CHANGE_LOG_TABLES}
  `,
];

/** The tables the take-over copies, in the order it fills them (references first). */
const TAKEN = [...INSPIRATION_STORE_TABLES, "changeset", "change_row"] as const;

/** What a take-over did, for its line in the log. */
export interface TakenOver {
  readonly rows: ReadonlyArray<{ readonly table: string; readonly rows: number }>;
  readonly files: number;
  /** The kept files not copied, by their old path, and why. */
  readonly missing: ReadonlyArray<{ readonly path: string; readonly why: string }>;
}

/** The columns of `table` in the schema `schema` (main, or the attached archive). */
function columnsOf(db: DatabaseSync, schema: string, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as { name: string }[]).map((c) => c.name);
}

/** The sha256 of the file at `path`, hex. */
const hashOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Copies the core's inspirations into `db` (the core's database attached as `archive`; see the top), their files from
 * the archive's folder `folder` into the module's: what it copied. Throws, so the caller's transaction is undone, when
 * anything is not as it was.
 */
export function takeOverInspirations(db: DatabaseSync, folder: string): TakenOver {
  const rows: Array<{ table: string; rows: number }> = [];
  for (const table of TAKEN) {
    const had = columnsOf(db, "archive", table);
    // A core without the table (none should be: its first migration made them all) has nothing of it to give.
    if (had.length === 0) continue;
    const own = columnsOf(db, "main", table);
    const missing = had.filter((column) => !own.includes(column));
    if (missing.length > 0) throw new Error(`the core's ${table} has columns this module does not know (${missing.join(", ")}), so nothing was taken over`);
    const columns = had.join(", ");
    db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM archive.${table}`);
    rows.push({ table, rows: (db.prepare(`SELECT count(*) AS n FROM archive.${table}`).get() as { n: number }).n });
  }
  const moduleFolder = inspirationsFolder(folder);
  const files = db.prepare("SELECT id, path, sha256 FROM main.inspiration_file ORDER BY id").all() as { id: number; path: string; sha256: string }[];
  const setPath = db.prepare("UPDATE main.inspiration_file SET path = ? WHERE id = ?");
  const kept = new Set<string>();
  const missing: Array<{ path: string; why: string }> = [];
  for (const file of files) {
    const to = keptPath(file.sha256, file.path);
    if (existsSync(join(moduleFolder, to))) {
      setPath.run(to, file.id);
      kept.add(to);
    } else {
      missing.push({ path: file.path, why: existsSync(join(folder, file.path)) ? "its bytes are not its sha256" : "it was not in the archive's folder" });
    }
  }
  check(db);
  return { rows, files: kept.size, missing };
}

/**
 * Copies each kept file of the core's inspirations (the core's database attached to `db` as `archive`) from the
 * archive's folder `folder` into the module's files/ by its hash, unless it is there already: staged in the module's
 * .incoming/, so files/ holds whole files alone, and renamed into place only when its bytes are its row's sha256. A
 * file missing at its old place, or whose bytes are not its sha256, is left for takeOverInspirations to say.
 */
export function copyKeptFiles(db: DatabaseSync, folder: string): void {
  if (columnsOf(db, "archive", "inspiration_file").length === 0) return;
  const moduleFolder = inspirationsFolder(folder);
  const incoming = join(moduleFolder, ".incoming");
  for (const file of db.prepare("SELECT DISTINCT path, sha256 FROM archive.inspiration_file").all() as { path: string; sha256: string }[]) {
    const from = join(folder, file.path);
    const to = join(moduleFolder, keptPath(file.sha256, file.path));
    if (existsSync(to) || !existsSync(from) || hashOf(from) !== file.sha256) continue;
    mkdirSync(incoming, { recursive: true });
    const staged = join(incoming, randomUUID());
    try {
      copyFileSync(from, staged);
      if (hashOf(staged) !== file.sha256) throw new Error(`the copy of ${from} is not the same bytes, so nothing was taken over`);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(staged, to);
    } finally {
      rmSync(staged, { force: true });
    }
  }
}

/** Every copied table holds exactly the core's rows, every column the same but a kept file's path; throws for the first that does not. */
function check(db: DatabaseSync): void {
  for (const table of TAKEN) {
    const had = columnsOf(db, "archive", table);
    if (had.length === 0) continue;
    const columns = had.filter((column) => !(table === "inspiration_file" && column === "path")).join(", ");
    const count = (schema: string) => (db.prepare(`SELECT count(*) AS n FROM ${schema}.${table}`).get() as { n: number }).n;
    const differ = (a: string, b: string) => (db.prepare(`SELECT count(*) AS n FROM (SELECT ${columns} FROM ${a}.${table} EXCEPT SELECT ${columns} FROM ${b}.${table})`).get() as { n: number }).n;
    const [core, own] = [count("archive"), count("main")];
    if (core !== own) throw new Error(`the module's ${table} has ${own} rows after the copy, the core's ${core}, so nothing was taken over`);
    const lost = differ("archive", "main") + differ("main", "archive");
    if (lost > 0) throw new Error(`${lost} rows of ${table} differ between the core's and the module's after the copy, so nothing was taken over`);
  }
}

/**
 * The take-over as the core runs it (sdk/server.ts's takeOver), saying what it did when it took anything (a new
 * archive's core has nothing to give), on stderr, so a command's own answer (`inspiration add --json`) is left whole.
 */
function takeOver(db: DatabaseSync, folder: string): void {
  const done = takeOverInspirations(db, folder);
  const taken = done.rows.filter((r) => r.rows > 0);
  if (taken.length === 0 && done.files === 0 && done.missing.length === 0) return;
  const said = taken.map((r) => `${r.rows} ${r.table}`).join(", ") || "no rows";
  console.error(`[inspirations] took over from ${CORE_FILE}: ${said}, and ${done.files} kept ${done.files === 1 ? "file" : "files"} copied into modules/inspirations/files/ (the core's copies left where they were)`);
  for (const { path, why } of done.missing) console.error(`[inspirations] ${path} was not copied, as ${why}; its row is kept with that old path (npm run check-data names it)`);
}

/** The database as the module declares it (module.ts). */
export const INSPIRATIONS_DATABASE: ModuleDatabase = { file: INSPIRATIONS_DB, migrations: MIGRATIONS, takeOver, takeOverFiles: copyKeptFiles, takeOverFrom: CORE_FILE };
