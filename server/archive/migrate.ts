// The friend map step's one-time move (`npm run archive -- migrate friend-map-module [--apply]`; docs/modules.md,
// "Friend map"), run with the server stopped. Until friend map was a module, archive.sqlite at the archive folder's
// root held everything; now it is friend map's database, at modules/friend-map/archive.sqlite, and what the core keeps
// is core.sqlite (coreDb.ts). The move, copy first and drop after, never re-importing:
//
//   1. refuse while the server answers, while friend map's archive is already in place, while core.sqlite holds
//      anything, while the archive's schema is not the one friend map's code had when it moved (MOVE_VERSION), and
//      while the archive still holds the exercise or the rituals module's old rows that their module does not
//      (legacy.ts's checks, as their own drops had them)
//   2. a checked backup of the archive (backups.ts's checkedCopy), and of the calendar when its trail is to be copied
//   3. the core's database built as core.sqlite.partial (CORE_PARTIAL), the core's tables copied in from the archive
//      attached read-only, ids kept, in one transaction (CORE_TABLES: the event index's sessions, prompts and replies
//      with their devices, the inspirations, the core connectors' runs and cursors, and the changesets that changed
//      inspirations alone), every count checked, and marked complete (MOVE_MARK) in that same transaction
//   4. the trail of content reads the archive still held, into the calendar's, ids kept, unless the calendar has it
//      already (it took it once when it was new, archive/index.ts's copyTrail before this move)
//   5. the archive's WAL checkpointed, refused unless the whole log went in and no other process holds the file, and
//      the file moved, a rename on the same volume: instant whatever its size
//   6. in its new place, what it holds that is no longer its own dropped, overwritten for good (db.ts's overwriting):
//      the core's tables, the trail, the inspirations' changesets, and the exercise and rituals modules' old rows
//   7. core.sqlite.partial renamed core.sqlite, last: until then the server refuses the folder (index.ts's unmovedArchive)
//
// It resumes: until step 5 the archive at the root is untouched (a run again starts over, the partial core rebuilt),
// and after it a run again finds the move unfinished (core.sqlite.partial still there, or friend map's archive still
// holding the core's event table) and finishes steps 3 to 7 from the moved archive, each of which does nothing when it
// is done. A move interrupted by the code before this one (core.sqlite already full, the archive moved, step 6 not
// done) is finished the same way.
//
// The dry run says each table and how many rows it would copy, and changes nothing. Undo: stop the server, delete
// core.sqlite and modules/friend-map/archive.sqlite, copy the backup to archive.sqlite, and start the old code.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveUrl } from "../dataHome.ts";
import { CALENDAR_FILE, getCalendarMeta, openCalendar, setCalendarMeta } from "../calendar/db.ts";
import { MODULES_FOLDER } from "../modules/store.ts";
import { backupName, checkedCopy } from "./backups.ts";
import { CORE_FILE, CORE_PARTIAL, CORE_TABLES, OLD_INSPIRATION_LOGGED, openCore } from "./coreDb.ts";
import { getMeta, overwriting, readOnlyAddress, schemaVersion, setMeta, transaction, type Db } from "./db.ts";
import { EVENT_KINDS } from "./events.ts";
import { dropExerciseLegacy, dropRitualsLegacy, exerciseDatabaseFile, exerciseLegacy, exerciseUnheld, ritualsLegacy, ritualsUnheld } from "./legacy.ts";

/** The core's own connectors, whose runs and cursors are the core's. */
const CORE_CONNECTORS = ["llm-sessions", "grok-bot"];

/** The inspirations' tables a changeset can change: a changeset that changed these alone is the core's (for the inspirations module to take over after). */
const INSPIRATION_CHANGES = OLD_INSPIRATION_LOGGED;

/** The exercise and rituals modules' old tables, which nothing reads now (legacy.ts drops their rows). */
const LEGACY_TABLES = ["workout", "deleted_workout", "ritual_checkin", "ritual_habit", "ritual_day", "ritual_workouts"];

/**
 * The archive's schema version the move was written for: friend map's code's SCHEMA_VERSION when it moved (the code
 * before it had the same migrations). A behind archive would leave friend map's later migrations of the core's tables
 * to run on a database that no longer has them; friend map's migrations after this one run on the moved archive.
 */
export const MOVE_VERSION = 65;

/** The core's meta key that says its database was filled by this move, every count checked: a partial core with it is whole. */
const MOVE_MARK = "friend_map_move";

/** Where friend map's archive goes, in the archive's folder. */
export const friendMapArchive = (dataDir: string): string => join(dataDir, MODULES_FOLDER, "friend-map", "archive.sqlite");

/** The core's event index's kinds, as SQL. */
const INDEX_KINDS = EVENT_KINDS.map((kind) => `'${kind}'`).join(", ");

/** Which rows of each copied table are the core's, in the archive attached as `archive`. */
const COPIED: ReadonlyArray<{ table: string; rows: string }> = [
  { table: "source", rows: `connector IN (${CORE_CONNECTORS.map((c) => `'${c}'`).join(", ")}) OR id IN (SELECT first_source_id FROM archive.event WHERE kind IN (${INDEX_KINDS}) UNION SELECT last_source_id FROM archive.event WHERE kind IN (${INDEX_KINDS}))` },
  { table: "connector_state", rows: `connector IN (${CORE_CONNECTORS.map((c) => `'${c}'`).join(", ")})` },
  ...CORE_TABLES.map((table) => ({ table, rows: table === "event" ? `kind IN (${INDEX_KINDS})` : "1" })),
  { table: "changeset", rows: `id IN (${inspirationChangesets()})` },
  { table: "change_row", rows: `changeset_id IN (${inspirationChangesets()})` },
];

/** The changesets of the archive that changed inspirations and nothing else, as SQL over `archive`. */
function inspirationChangesets(): string {
  const tables = INSPIRATION_CHANGES.map((t) => `'${t}'`).join(", ");
  return `SELECT changeset_id FROM archive.change_row GROUP BY changeset_id HAVING sum(tbl NOT IN (${tables})) = 0`;
}

/** What the move would do, or did: each table copied and how many of its rows, and whether the trail is copied too. */
export interface FriendMapMove {
  copied: Array<{ table: string; rows: number }>;
  trail: number | null;
  exercise: number;
  rituals: number;
}

/** Whether the archive's server answers, at LIFE_ARCHIVE_URL. */
async function serverAnswers(): Promise<boolean> {
  try {
    await fetch(`${archiveUrl().replace(/\/+$/, "")}/life-archive/api/settings`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The move of the archive in `dataDir` (see the top of this file): a dry run unless `apply`; what it would do, or did.
 * `after` hears each of steps 3 to 6 done (a test interrupts the move there).
 */
export async function migrateFriendMap(
  dataDir: string,
  { apply, log = console.log, serverRunning = serverAnswers, after = () => {} }: { apply: boolean; log?: (line: string) => void; serverRunning?: () => Promise<boolean>; after?: (step: number) => void },
): Promise<FriendMapMove | null> {
  const root = join(dataDir, "archive.sqlite");
  const target = friendMapArchive(dataDir);
  const coreFile = join(dataDir, CORE_FILE);
  if (!existsSync(root)) {
    const left = existsSync(target) ? unfinished(dataDir, target) : null;
    if (left === null) {
      log(existsSync(target) ? `Friend map's archive is at ${target} already: nothing to move.` : `There is no archive at ${root}: nothing to move.`);
      return null;
    }
    if (await serverRunning()) throw new Error(`the archive's server answers at ${archiveUrl()}: stop it first (launchctl bootout gui/$(id -u)/local.life-archive), then run this again`);
    if (!apply) {
      log(`The move into ${target} was interrupted (${left}): it would be finished. Nothing changed (a dry run); --apply finishes it.`);
      return null;
    }
    log(`The move into ${target} was interrupted (${left}): finishing it.`);
    return finish(dataDir, target, { log, backup: null, after });
  }
  if (existsSync(target)) throw new Error(`there is an archive at ${root} and another at ${target}: one of them is not the captain's; nothing was moved`);
  if (await serverRunning()) throw new Error(`the archive's server answers at ${archiveUrl()}: stop it first (launchctl bootout gui/$(id -u)/local.life-archive), then run this again`);
  const held = coreRows(coreFile);
  if (held > 0) throw new Error(`${coreFile} holds ${held} rows already: it is not the one this move makes; nothing was moved`);

  const archive = new DatabaseSync(root, { readOnly: true, timeout: 10_000 });
  let move: FriendMapMove;
  try {
    const version = schemaVersion(archive);
    if (version !== MOVE_VERSION) {
      throw new Error(`the archive at ${root} is at schema version ${version}, and the move takes one at ${MOVE_VERSION}: open it once with the code from before friend map was a module, which brings it up to date, then run this again; nothing was moved`);
    }
    move = legacyChecked(archive, dataDir);
    const calendarFile = join(dataDir, CALENDAR_FILE);
    move.trail = existsSync(calendarFile) && calendarHasTrail(calendarFile) ? null : (archive.prepare("SELECT count(*) AS n FROM content_read").get() as { n: number }).n;
    move.copied = copiedCounts(archive);
  } finally {
    archive.close();
  }
  for (const { table, rows } of move.copied) log(`${apply ? "Will copy" : "Would copy"} ${rows} ${table} rows into ${coreFile}.`);
  log(move.trail === null ? "The calendar holds the trail of content reads already." : `${apply ? "Will copy" : "Would copy"} ${move.trail} reads of the trail into the calendar.`);
  log(`${apply ? "Will drop" : "Would drop"} the exercise module's ${move.exercise} old rows and the rituals module's ${move.rituals}.`);
  if (!apply) {
    log(`Would move ${root} to ${target}. Nothing changed (a dry run); --apply makes it, after a checked backup.`);
    return move;
  }

  // 2. The backups, before anything is written. A backup reads the archive's log too (VACUUM INTO).
  const backups = join(dataDir, "backups");
  // A run again within the second of an interrupted one names its backup a second on, beside the one before.
  let at = Date.now();
  while (existsSync(join(backups, backupName(at, "before friend map module")))) at += 1000;
  const backup = join(backups, backupName(at, "before friend map module"));
  await checkedCopy(root, backup);
  log(`Backed up to ${backup}, integrity ok.`);
  if (move.trail !== null && existsSync(join(dataDir, CALENDAR_FILE))) {
    await checkedCopy(join(dataDir, CALENDAR_FILE), backup.replace(/\.sqlite$/, `.${CALENDAR_FILE}`));
    log(`With ${backup.replace(/\.sqlite$/, `.${CALENDAR_FILE}`)}, integrity ok.`);
  }
  return finish(dataDir, root, { log, backup, after });
}

/**
 * Steps 3 to 7 from the archive at `from`: the one at the root on a first run, or the moved one when a run before was
 * interrupted after step 5. Each step does nothing when it is done already; what it did.
 */
function finish(dataDir: string, from: string, { log, backup, after }: { log: (line: string) => void; backup: string | null; after: (step: number) => void }): FriendMapMove {
  const root = join(dataDir, "archive.sqlite");
  const target = friendMapArchive(dataDir);
  const coreFile = join(dataDir, CORE_FILE);
  const partial = join(dataDir, CORE_PARTIAL);
  const move: FriendMapMove = { copied: [], trail: null, exercise: 0, rituals: 0 };

  // 3. The core's tables into core.sqlite.partial, counted. From the root's archive always (a partial core left by an
  // interrupted run is rebuilt); from the moved one unless a whole core is there already: a partial one this move
  // marked, or (the code before this one made core.sqlite in place) a core.sqlite holding rows.
  const whole = from === target && (moveMarked(partial) || coreRows(coreFile) > 0);
  if (!whole) {
    if (from === target && !holdsTable(target, "event")) {
      throw new Error(`friend map's archive at ${target} holds none of the core's tables, and there is no whole core to put in place: restore the backup taken before the move (in ${join(dataDir, "backups")}) as archive.sqlite, then run this again`);
    }
    move.copied = buildCore(partial, from);
    log(`Copied ${move.copied.reduce((n, c) => n + c.rows, 0)} rows into ${partial}, every count checked.`);
  }

  after(3);

  // 4. The trail, when the calendar has it not.
  const calendarFile = join(dataDir, CALENDAR_FILE);
  if (!(existsSync(calendarFile) && calendarHasTrail(calendarFile)) && holdsTable(from, "content_read")) {
    const calendar = openCalendar(calendarFile);
    try {
      move.trail = copyTrail(calendar, from);
    } finally {
      calendar.close();
    }
    log(`Copied ${move.trail} reads of the trail into the calendar.`);
  }

  after(4);

  // 5. The move: a rename, the WAL checkpointed into the file before, refused while another process holds it.
  if (from === root) {
    moveArchive(root, target);
    log(`Moved ${root} to ${target}.`);
  }

  after(5);

  // 6. What it holds that is no longer its own, dropped for good.
  Object.assign(move, dropNotOwn(target, dataDir));

  after(6);

  // 7. The core in its place, last.
  if (existsSync(partial)) {
    const strays = coreRows(coreFile);
    if (strays > 0) throw new Error(`${coreFile} holds ${strays} rows, beside the core this move made at ${partial}: something wrote one meanwhile; the move is not finished`);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${coreFile}${suffix}`, { force: true });
    renameSync(partial, coreFile);
    log(`Put the core's database in its place, ${coreFile}.`);
  }
  log(backup
    ? `Dropped what the archive held of the core's and the other modules'; undo by restoring ${backup} as archive.sqlite (and deleting ${CORE_FILE} and ${target}).`
    : `Finished the move; the backup it took first, in ${join(dataDir, "backups")}, undoes it (restored as archive.sqlite, with ${CORE_FILE} and ${target} deleted).`);
  return move;
}

/** Why friend map's archive at `target` shows a move not finished, or null when it is finished. */
function unfinished(dataDir: string, target: string): string | null {
  if (existsSync(join(dataDir, CORE_PARTIAL))) return `the core's database is still at ${CORE_PARTIAL}`;
  if (holdsTable(target, "event")) return "friend map's archive still holds the core's tables";
  return null;
}

/** The exercise and rituals modules' old rows the archive `db` holds, refused unless their modules hold them all. */
function legacyChecked(db: Db, dataDir: string): FriendMapMove {
  const exercise = exerciseLegacy(db);
  const exerciseRows = exercise.workouts + exercise.deleted + exercise.sources + exercise.states;
  const unheldWorkouts = exerciseRows > 0 ? exerciseUnheld(db, exerciseDatabaseFile(dataDir)) : null;
  if (unheldWorkouts) throw new Error(`the archive holds the exercise module's old rows, which it cannot drop yet: ${unheldWorkouts}`);
  const rituals = ritualsLegacy(db);
  const ritualsRows = rituals.events + rituals.sources + rituals.states;
  const unheldRituals = ritualsRows > 0 ? ritualsUnheld(dataDir) : null;
  if (unheldRituals) throw new Error(`the archive holds the rituals module's old rows, which it cannot drop yet: ${unheldRituals}`);
  return { copied: [], trail: null, exercise: exerciseRows, rituals: ritualsRows };
}

/** The core's tables of the archive at `from` copied into a new core at `partial`, counted and marked whole; each table's count. */
function buildCore(partial: string, from: string): Array<{ table: string; rows: number }> {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true });
  const core = openCore(partial);
  let copied: Array<{ table: string; rows: number }> = [];
  try {
    core.exec("PRAGMA foreign_keys = OFF");
    core.prepare("ATTACH DATABASE ? AS archive").run(readOnlyAddress(from));
    try {
      transaction(core, () => {
        copied = COPIED.map(({ table, rows }) => ({ table, rows: (core.prepare(`SELECT count(*) AS n FROM archive.${table} WHERE ${rows}`).get() as { n: number }).n }));
        for (const { table, rows } of COPIED) {
          // The columns both have: the core's later ones (the LLM warehouse's measures) stay empty, as on any row it has not read.
          const names = (schema: string) => (core.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
          const theirs = new Set(names("archive"));
          const columns = names("main").filter((name) => theirs.has(name)).join(", ");
          core.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM archive.${table} WHERE ${rows}`);
        }
        const broken = core.prepare("PRAGMA main.foreign_key_check").all();
        if (broken.length > 0) throw new Error(`the copy left ${broken.length} broken references, e.g. ${JSON.stringify(broken[0])}`);
        for (const { table, rows } of copied) {
          const held = (core.prepare(`SELECT count(*) AS n FROM main.${table}`).get() as { n: number }).n;
          if (held !== rows) throw new Error(`${table}: ${held} rows copied of ${rows}`);
        }
        setMeta(core, MOVE_MARK, String(copied.reduce((n, c) => n + c.rows, 0)));
      });
    } finally {
      core.exec("DETACH DATABASE archive");
    }
    core.exec("PRAGMA foreign_keys = ON");
    checkpointed(core, partial);
  } catch (error) {
    core.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true });
    throw error;
  }
  core.close();
  // Its log went into the file, so the file alone is the whole core when it is renamed.
  if (holdsLog(partial)) throw new Error(`${partial}-wal is still there after the core closed: another process has it open; the move is not finished`);
  return copied;
}

/** The archive at `root` moved to `target`, refused unless its whole log is in the file and nothing else holds it. */
function moveArchive(root: string, target: string): void {
  const db = new DatabaseSync(root, { timeout: 10_000 });
  try {
    checkpointed(db, root);
  } finally {
    db.close();
  }
  // The last connection to close removes the log; one still there means another process has the archive open.
  if (holdsLog(root)) throw new Error(`${root}-wal is still there after the move closed it: another process has the archive open; stop it, then run this again`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(root, target);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${root}${suffix}`, { force: true });
}

/** The log of `db` (at `file`) checkpointed into it whole, or an error saying another process holds it. */
function checkpointed(db: Db, file: string): void {
  const { busy, log, checkpointed } = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
  if (busy !== 0 || log !== checkpointed) {
    throw new Error(`${file}'s log could not be checkpointed whole (busy ${busy}, ${checkpointed} of ${log} pages): another process has it open; stop it, then run this again`);
  }
}

/** Whether the database at `file` has a log beside it: the last connection to close removes it, so another process holds it open. */
const holdsLog = (file: string): boolean => existsSync(`${file}-wal`);

/**
 * Step 6 on friend map's archive at `target`: the core's tables, the trail, the inspirations' changesets and the
 * exercise and rituals modules' old rows dropped, nothing when they are gone already. The old rows are checked again
 * (their modules hold them all) before they go. How many old rows it dropped.
 */
function dropNotOwn(target: string, dataDir: string): Pick<FriendMapMove, "exercise" | "rituals"> {
  const moved = new DatabaseSync(target, { timeout: 10_000 });
  try {
    moved.exec("PRAGMA journal_mode = WAL");
    // The core's event table goes in the same transaction as the rest, so with it gone, so is all of it.
    if (!tableIn(moved, "event")) return { exercise: 0, rituals: 0 };
    const { exercise, rituals } = legacyChecked(moved, dataDir);
    if (exercise > 0) dropExerciseLegacy(moved);
    if (rituals > 0) dropRitualsLegacy(moved);
    overwriting(moved, () =>
      transaction(moved, () => {
        moved.exec(`DELETE FROM change_row WHERE changeset_id IN (${inspirationChangesets().replaceAll("archive.", "main.")})`);
        moved.exec("DELETE FROM changeset WHERE id NOT IN (SELECT changeset_id FROM change_row)");
        moved.exec(`DELETE FROM connector_state WHERE connector IN (${CORE_CONNECTORS.map((c) => `'${c}'`).join(", ")})`);
        // Sources the core's events named, which nothing of the archive's names now (its own messages name their own).
        moved.exec("CREATE TEMP TABLE core_source AS SELECT first_source_id AS id FROM event UNION SELECT last_source_id FROM event");
        for (const table of ["event", ...[...CORE_TABLES].filter((t) => t !== "event").reverse(), ...LEGACY_TABLES, "content_read"]) moved.exec(`DROP TABLE IF EXISTS ${table}`);
        moved.exec(`DELETE FROM source WHERE connector IN (${CORE_CONNECTORS.map((c) => `'${c}'`).join(", ")}) OR id IN (SELECT id FROM temp.core_source)`);
        moved.exec("DROP TABLE temp.core_source");
      }),
    );
    moved.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return { exercise, rituals };
  } finally {
    moved.close();
  }
}

/** How many of the core's rows the core's database at `file` holds; none when there is no file. */
function coreRows(file: string): number {
  if (!existsSync(file)) return 0;
  const core = new DatabaseSync(file, { readOnly: true });
  try {
    return CORE_TABLES.reduce((n, table) => n + (tableIn(core, table) ? (core.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n : 0), 0);
  } finally {
    core.close();
  }
}

/** Whether the core's database at `file` is one this move filled whole (MOVE_MARK). */
function moveMarked(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const core = new DatabaseSync(file, { readOnly: true });
    try {
      return tableIn(core, "meta") && getMeta(core, MOVE_MARK) !== null;
    } finally {
      core.close();
    }
  } catch {
    return false;
  }
}

/** Whether the database `db` has the table `name`. */
const tableIn = (db: Db, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Whether the database at `file` has the table `name`. */
function holdsTable(file: string, name: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return tableIn(db, name);
  } finally {
    db.close();
  }
}

/** How many rows of each copied table the archive `db` holds that are the core's. */
function copiedCounts(db: Db): Array<{ table: string; rows: number }> {
  return COPIED.map(({ table, rows }) => ({ table, rows: (db.prepare(`SELECT count(*) AS n FROM main.${table} WHERE ${rows.replaceAll("archive.", "main.")}`).get() as { n: number }).n }));
}

/** Whether the calendar at `file` took the trail once already. */
function calendarHasTrail(file: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return getCalendarMeta(db, "trail_copied") !== null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** The trail of content reads the archive at `file` holds, copied into the calendar's (ids kept), and the calendar told so; how many. */
function copyTrail(calendar: DatabaseSync, file: string): number {
  calendar.prepare("ATTACH DATABASE ? AS archive").run(readOnlyAddress(file));
  try {
    return transaction(calendar, () => {
      const copied = calendar.prepare(
        "INSERT OR IGNORE INTO main.content_read (id, at, last_at, reads, surface, reader, what, scope_json, why) SELECT id, at, last_at, reads, surface, reader, what, scope_json, why FROM archive.content_read",
      ).run().changes;
      setCalendarMeta(calendar, "trail_copied", String(copied));
      return Number(copied);
    });
  } finally {
    calendar.exec("DETACH DATABASE archive");
  }
}
