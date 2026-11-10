// One sync of this Mac's calls and Messages into the archive (docs/data.md's "This Mac's calls and Messages, every 15
// minutes"), run every 15 minutes by the launchd agent local.life-archive-mac-imports (`npm run mac-imports`), the
// runbook's address book, `call-history` and `imessage-db` sections in turn, for what is new only:
//
// 0. One run at a time (the lock in the archive's folder's mac-imports/, beside the run's state): a run that finds the
//    last one still going leaves it. The first run of a day tells firstmate what came in on the days before, once.
// 1. Checks this process may read the three databases (calls, Messages, Contacts), and tells firstmate what to grant
//    when it may not (nothing else is done then; once a day).
// 2. Asks each database for its newest row's id: none higher than at its last import, and the run is done, having
//    copied, imported and noted nothing.
// 3. For a source with something new: copies it into its folder for the day (platform-exports/calls/<day>/,
//    platform-exports/imessage/<day>/ with the Messages attachments since a day or two before import-status's "covers
//    to"); a later run that day brings the same folder up to date, so a day keeps one copy of each. Each copy is made
//    under a hidden name and moved in when whole. The address book is the day's copy of the Mac's Contacts, made by
//    the day's first import.
// 4. Takes one backup before the imports (the run's earlier ones that day go), imports each with the address book,
//    then runs check-data.
// 5. Tells firstmate at once when a step failed or check-data names problems (once a day each); what came in waits
//    for the next day's note. After a failure the next run waits an hour.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { ArchiveCommands, dayKey, Notifier, parseBackupName, sameBackup, takeLock, timeOfDay } from "../../../../sdk/server.ts";
import { IPHONE_BOOK, MAC_BOOK } from "../../connectors/addressBook.ts";
import { canRead, copyContacts, copyDatabase, copyFilesSince, macSources, newestRow } from "./copy.ts";

export const NOTE_HEAD = "[life-archive mac-imports, automated]";
export const LAUNCHD_LABEL = "local.life-archive-mac-imports";
/** Set by the launcher (launcher.c) to its own path: the program Full Disk Access is given to. */
export const LAUNCHER_ENV = "LIFE_ARCHIVE_MAC_IMPORTS_LAUNCHER";
/** The run's lock and state, in the archive's folder. */
export const STATE_FOLDER = "mac-imports";
/** The backup taken before a run's imports; a later run's that day replaces it, so a day keeps one. */
export const BACKUP_LABEL = "before-import-mac-imports";
/** How far before import-status's "covers to" the attachments are taken from (the runbook: a day or two is harmless). */
const ATTACHMENTS_BEFORE_MS = 2 * 86_400_000;
/** After a run whose copy, backup or import failed, the next waits this long: each try copies and backs up again. */
export const RETRY_AFTER_MS = 60 * 60_000;

/** The two sources, in the runbook's order, and the table whose newest row says whether either has anything new. */
export const SOURCES = [
  { id: "calls", label: "Phone calls", noun: "Calls", connector: "call-history", folder: "calls", database: "CallHistory.storedata", table: "ZCALLRECORD", key: "Z_PK", counts: /^Calls: (\d+) new/m },
  { id: "messages", label: "Messages", noun: "Messages", connector: "imessage-db", folder: "imessage", database: "chat.db", table: "message", key: "ROWID", counts: /^Messages: (\d+) new/m },
] as const;
type Source = (typeof SOURCES)[number];
type SourceId = Source["id"];

export interface RunOptions {
  dataDir: string;
  /** The home folder whose Library holds the sources: this Mac's user's, or a made-up one in tests. */
  home: string;
  now: number;
  dryRun?: boolean;
  /** The program that needs Full Disk Access, when the launcher started this run. */
  launcher?: string;
  log?: (line: string) => void;
}

export interface SourceResult {
  source: SourceId;
  /** Its export folder, from the archive's folder; null when nothing was copied. */
  folder: string | null;
  ok: boolean;
  /** "nothing new", what the import brought ("Calls: 3 new"), or the step that failed. */
  detail: string;
  /** How many the import brought. */
  added: number;
  /** Attachments taken with Messages. */
  attachments?: number;
}

export interface RunResult {
  ok: boolean;
  /** Why the run did nothing at all: the last one still going, or waiting after a failure. */
  skipped?: string;
  /** Whether a source could not be read, for want of Full Disk Access. */
  noAccess: string[];
  sources: SourceResult[];
  checkData: { ok: boolean; problems: number } | null;
  /** The address book the imports named people from, from the archive's folder, and whether it is the day's copy of the Mac's Contacts. */
  contacts: { folder: string; copied: boolean } | null;
}

/** What came in on a day, until firstmate's note for it. */
interface Arrived {
  calls: number;
  messages: number;
  attachments: number;
  /** Runs that imported. */
  syncs: number;
  /** The most problems check-data named after one of them. */
  problems: number;
}

/** What runs remember (mac-imports/state.json in the archive's folder). */
interface State {
  /** Each source's newest row's id when it was last imported. */
  seen: Partial<Record<SourceId, number>>;
  /** Each source's (and the address book's) folder for a day, from the archive's folder, which later runs that day bring up to date. */
  copies: Partial<Record<SourceId | "contacts", { day: string; folder: string }>>;
  arrived: Record<string, Arrived>;
  /** When the last run whose copy, backup or import failed ran. */
  failedAt?: number;
  /** The day a failed run last raised a macOS notification: one a day. */
  alerted?: string;
  /** When each connector last synced well (found nothing new, or imported): read by the Sources tab. */
  checked?: Record<string, number>;
}

const stateFile = (dataDir: string) => join(dataDir, STATE_FOLDER, "state.json");

async function readState(dataDir: string): Promise<State> {
  const empty: State = { seen: {}, copies: {}, arrived: {} };
  try {
    return { ...empty, ...(JSON.parse(await readFile(stateFile(dataDir), "utf8")) as Partial<State>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
}

async function saveState(dataDir: string, state: State): Promise<void> {
  const file = stateFile(dataDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.new`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${file}.new`, file);
}

/** Whether a failed run should raise a macOS notification: the first that day does, and is remembered. */
export async function firstAlertToday(dataDir: string, now: number): Promise<boolean> {
  const state = await readState(dataDir);
  if (state.alerted === dayKey(now)) return false;
  await saveState(dataDir, { ...state, alerted: dayKey(now) });
  return true;
}

export const macImportsRun = Effect.fn("macImportsRun")(function* (options: RunOptions) {
  const log = options.log ?? (() => {});
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lock = options.dryRun ? "dry run" : yield* takeLock(join(options.dataDir, STATE_FOLDER));
      if (!lock) {
        log("the last run is still going: leaving it to that one");
        return ran({ ok: true, skipped: "the last run is still going", noAccess: [], sources: [], checkData: null, contacts: null });
      }
      return yield* sync(options);
    }),
  );
});

const sync = Effect.fn("sync")(function* (options: RunOptions) {
  const archive = yield* ArchiveCommands;
  const notifier = yield* Notifier;
  const log = options.log ?? (() => {});
  const day = dayKey(options.now);
  const paths = macSources(options.home);
  const state = yield* Effect.promise(() => readState(options.dataDir));
  const save = Effect.promise(() => saveState(options.dataDir, state));

  // 0. What came in on the days before today, said once.
  if (!options.dryRun) yield* dailyNote(state, day, log).pipe(Effect.andThen(save));

  // 1. All readable, or nothing is done. A Mac with no Contacts store has none to copy.
  const noAccess: string[] = [];
  for (const file of [paths.calls, paths.messages]) {
    yield* canRead(file).pipe(Effect.catchTag("NoAccess", () => Effect.sync(() => void noAccess.push(file))));
  }
  const contactsStore = join(paths.contacts, MAC_BOOK);
  const hasContacts = yield* canRead(contactsStore).pipe(
    Effect.as(true),
    Effect.catchTag("NoAccess", () => Effect.sync(() => noAccess.push(contactsStore) > 0)),
    Effect.catchTag("NoSource", () => Effect.succeed(false)),
  );
  if (noAccess.length > 0) {
    log(`no Full Disk Access: may not read ${noAccess.join(" or ")}`);
    if (!options.dryRun) yield* notifier.note(`mac-imports-no-access-${day}`, noAccessNote(noAccess, options.launcher));
    return ran({ ok: false, noAccess, sources: [], checkData: null, contacts: null });
  }

  // After a failure, an hour before trying again.
  if (!options.dryRun && state.failedAt !== undefined && options.now - state.failedAt < RETRY_AFTER_MS) {
    const skipped = `the last try failed at ${timeOfDay(state.failedAt)}: the next is after ${timeOfDay(state.failedAt + RETRY_AFTER_MS)}`;
    log(skipped);
    return ran({ ok: true, skipped, noAccess, sources: [], checkData: null, contacts: null });
  }

  // 2. What is new: each database's newest row against the one it had at its last import.
  const sources: SourceResult[] = [];
  const fresh: Source[] = [];
  for (const source of SOURCES) {
    const newest = yield* newestRow(paths[source.id], source.table, source.key);
    const seen = state.seen[source.id];
    if (seen !== undefined && newest <= seen) sources.push({ source: source.id, folder: null, ok: true, detail: "nothing new", added: 0 });
    else fresh.push(source);
  }
  if (fresh.length === 0) {
    if (!options.dryRun) {
      state.checked = { ...state.checked, ...Object.fromEntries(SOURCES.map((source) => [source.connector, options.now])) };
      yield* save;
    }
    return ran({ ok: true, noAccess, sources, checkData: null, contacts: null });
  }

  const coversTo = yield* archive.coversTo;
  const messagesSince = coversTo["imessage-db"];
  const since = typeof messagesSince === "number" ? messagesSince - ATTACHMENTS_BEFORE_MS : null;
  if (options.dryRun) {
    for (const source of fresh) {
      const bytes = (yield* Effect.promise(() => stat(paths[source.id]))).size;
      const would = source.id === "messages"
        ? `would copy chat.db (${megabytes(bytes)}) and the attachments ${since === null ? "of every day" : `since ${dayKey(since)}`}`
        : `would copy CallHistory.storedata (${megabytes(bytes)})`;
      sources.push({ source: source.id, folder: null, ok: true, detail: `dry run: something new: ${would}, back up, and import`, added: 0 });
    }
    return ran({ ok: true, noAccess, sources: order(sources), checkData: null, contacts: null });
  }

  // 3. The address book, then the copies.
  const book = yield* addressBook(state, hasContacts, { ...options, day });
  const copies: Array<{ source: Source; copy: Copy }> = [];
  for (const source of fresh) {
    const copied = yield* copySource(source, state, { ...options, day, since }).pipe(
      Effect.catchTag("StepFailed", (failed) => Effect.sync(() => void sources.push(failure(source, failed)))),
    );
    if (copied) copies.push({ source, copy: copied });
  }

  // 4. One backup, then the imports.
  if (copies.length > 0) {
    const backedUp = yield* archive.archive(["backup", BACKUP_LABEL]).pipe(
      Effect.flatMap((printed) => Effect.promise(() => keepOneBackup(options.dataDir, printed, log))),
      Effect.as(true),
      Effect.catch((error: { message: string }) => Effect.sync(() => (log(`the backup: ${error.message}`), false))),
    );
    for (const { source, copy } of copies) {
      if (!backedUp) {
        sources.push({ source: source.id, folder: copy.relative, ok: false, detail: "the backup", added: 0 });
        continue;
      }
      const contacts = book ? ["--contacts", join(options.dataDir, book.folder)] : [];
      const imported = yield* archive.archive(["import", source.connector, copy.folder, ...contacts]).pipe(
        Effect.map((printed) => {
          const added = Number(printed.match(source.counts)?.[1] ?? 0);
          state.seen[source.id] = copy.newest;
          return { source: source.id, folder: copy.relative, ok: true, detail: `${source.noun}: ${added} new${copy.extra}`, added, attachments: copy.attachments } satisfies SourceResult;
        }),
        Effect.catch((error: { message: string }) => Effect.sync(() => {
          log(`${source.connector}: the import: ${error.message}`);
          return { source: source.id, folder: copy.relative, ok: false, detail: "the import", added: 0 } satisfies SourceResult;
        })),
      );
      sources.push(imported);
    }
  }
  for (const s of sources) if (s.folder) log(`${SOURCES.find((source) => source.id === s.source)!.connector}: ${s.ok ? s.detail : `failed at ${s.detail}`} (${s.folder})`);

  const imported = sources.some((s) => s.ok && s.folder);
  const checkData = imported ? yield* archive.checkData : null;
  if (checkData) log(`check-data: ${checkData.ok ? "fine" : `${checkData.problems} to fix`}`);
  const result = ran({ ok: sources.every((s) => s.ok), noAccess, sources: order(sources), checkData, contacts: book });

  // 5. What came in waits for tomorrow's note; a failure, or problems check-data names, are said now (once a day).
  if (imported) {
    const today = (state.arrived[day] ??= { calls: 0, messages: 0, attachments: 0, syncs: 0, problems: 0 });
    for (const s of result.sources) {
      if (s.source === "calls") today.calls += s.added;
      else today.messages += s.added;
      today.attachments += s.attachments ?? 0;
    }
    today.syncs += 1;
    today.problems = Math.max(today.problems, checkData?.problems ?? 0);
  }
  for (const s of result.sources) if (s.ok) state.checked = { ...state.checked, [SOURCES.find((source) => source.id === s.source)!.connector]: options.now };
  if (result.ok) delete state.failedAt;
  else state.failedAt = options.now;
  yield* save;
  const say = (id: string, text: string) => notifier.note(id, text).pipe(Effect.catch((error) => Effect.sync(() => log(`firstmate's inbox: ${error.message}`))));
  if (!result.ok) yield* say(`mac-imports-failed-${day}`, runNote(result));
  else if (checkData && !checkData.ok) yield* say(`mac-imports-check-data-${day}`, runNote(result));
  return result;
});

/** A run's result, as RunResult. */
const ran = (result: RunResult): RunResult => result;

/** Sources in SOURCES' order. */
const order = (sources: SourceResult[]) => SOURCES.flatMap((source) => sources.filter((s) => s.source === source.id));

/** A step of one source's sync failed: which, and its export folder once it had one. */
class StepFailed extends Data.TaggedError("StepFailed")<{ readonly step: string; readonly folder: string | null; readonly message: string }> {}

const failure = (source: Source, failed: StepFailed): SourceResult => ({ source: source.id, folder: failed.folder, ok: false, detail: failed.step, added: 0 });

/** firstmate's note on what came in on each day before `today` not yet said, once; those days are then forgotten. */
const dailyNote = Effect.fn("dailyNote")(function* (state: State, today: string, log: (line: string) => void) {
  const days = Object.keys(state.arrived).filter((day) => day < today).sort();
  if (days.length === 0) return;
  const said = days.filter((day) => state.arrived[day].calls + state.arrived[day].messages > 0);
  if (said.length > 0) {
    const notifier = yield* Notifier;
    const sent = yield* notifier.note(`mac-imports-daily-${today}`, arrivedNote(said.map((day) => [day, state.arrived[day]]))).pipe(
      Effect.as(true),
      Effect.catch((error) => Effect.sync(() => (log(`firstmate's inbox: ${error.message}`), false))),
    );
    if (!sent) return;
  }
  for (const day of days) delete state.arrived[day];
});

export function arrivedNote(days: Array<[string, Arrived]>): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = days.map(([day, a]) => {
    const what = [a.calls > 0 && plural(a.calls, "call", "calls"), a.messages > 0 && plural(a.messages, "message", "messages")].filter(Boolean).join(" and ");
    const attachments = a.attachments > 0 ? ` (${plural(a.attachments, "attachment", "attachments")})` : "";
    const check = a.problems > 0 ? `check-data named ${plural(a.problems, "problem", "problems")} (noted then)` : "check-data found nothing wrong";
    return `${day}: ${what}${attachments}, in ${plural(a.syncs, "sync", "syncs")}; ${check}.`;
  });
  return `${NOTE_HEAD} what this Mac's calls and Messages brought into the archive: ${parts.join(" ")}`;
}

/** The day's copy of the Mac's Contacts (made now when the day has none), else the newest address book before. */
const addressBook = Effect.fn("addressBook")(function* (state: State, hasContacts: boolean, options: RunOptions & { day: string }) {
  const log = options.log ?? (() => {});
  const mine = state.copies.contacts;
  if (mine?.day === options.day && existsSync(join(options.dataDir, mine.folder, MAC_BOOK))) return { folder: mine.folder, copied: true };
  if (!hasContacts) log("there are no Contacts on this Mac to copy");
  const copied = hasContacts ? yield* copyAddressBook(options) : null;
  if (copied) {
    state.copies.contacts = { day: options.day, folder: copied };
    return { folder: copied, copied: true };
  }
  const older = yield* Effect.promise(() => newestAddressBook(options.dataDir));
  if (!older) log("there is no address book in platform-exports/addressbook/: people are named by their numbers");
  return older ? { folder: older.slice(options.dataDir.length + 1), copied: false } : null;
});

/** The Contacts app's stores copied into platform-exports/addressbook/<day>/, from the archive's folder; null when the copy failed. */
const copyAddressBook = Effect.fn("copyAddressBook")(function* (options: RunOptions & { day: string }) {
  const log = options.log ?? (() => {});
  const parent = join(options.dataDir, "platform-exports", "addressbook");
  const folder = yield* Effect.promise(() => freeFolder(parent, options.day));
  const work = join(parent, `.copying-${basename(folder)}`);
  return yield* Effect.gen(function* () {
    yield* Effect.promise(() => rm(work, { recursive: true, force: true }).then(() => mkdir(work, { recursive: true })));
    const stores = yield* copyContacts(macSources(options.home).contacts, work);
    yield* Effect.promise(() => rename(work, folder));
    log(`contacts: ${stores} store${stores === 1 ? "" : "s"} of the Mac's Contacts copied (${folder.slice(options.dataDir.length + 1)})`);
    return folder.slice(options.dataDir.length + 1) as string | null;
  }).pipe(
    Effect.ensuring(Effect.promise(() => rm(work, { recursive: true, force: true }))),
    Effect.catch((error: { message: string }) => Effect.sync(() => {
      log(`contacts: the copy: ${error.message}`);
      return null;
    })),
  );
});

interface Copy {
  /** The day's folder, and the same from the archive's folder. */
  folder: string;
  relative: string;
  /** The copy's newest row's id. */
  newest: number;
  /** What the copy says of attachments (Messages'). */
  extra: string;
  attachments: number;
}

/** A source copied into its folder for the day: a new one, or the day's copy brought up to date. */
const copySource = Effect.fn("copySource")(function* (source: Source, state: State, options: RunOptions & { day: string; since: number | null }) {
  const log = options.log ?? (() => {});
  const paths = macSources(options.home);
  const parent = join(options.dataDir, "platform-exports", source.folder);
  const mine = state.copies[source.id];
  const folder = mine?.day === options.day && existsSync(join(options.dataDir, mine.folder, source.database))
    ? join(options.dataDir, mine.folder)
    : yield* Effect.promise(() => freeFolder(parent, options.day));
  const relative = folder.slice(options.dataDir.length + 1);
  const work = join(parent, `.copying-${basename(folder)}`);
  const copy = yield* Effect.gen(function* () {
    yield* Effect.promise(() => rm(work, { recursive: true, force: true }).then(() => mkdir(work, { recursive: true })));
    const database = join(work, source.database);
    yield* copyDatabase(paths[source.id], database);
    const newest = yield* newestRow(database, source.table, source.key);
    let extra = "";
    let attachments = 0;
    if (source.id === "messages") {
      const copied = yield* copyFilesSince(paths.attachments, join(work, "Attachments"), options.since);
      attachments = copied.files;
      extra = `, with ${copied.files} attachment${copied.files === 1 ? "" : "s"} (${megabytes(copied.bytes)}) since ${options.since === null ? "the start" : dayKey(options.since)}`;
    }
    yield* Effect.promise(() => settle(work, folder, source.database));
    return { folder, relative, newest, extra, attachments } satisfies Copy;
  }).pipe(
    Effect.ensuring(Effect.promise(() => rm(work, { recursive: true, force: true }))),
    Effect.catch((error: { message: string }) =>
      Effect.sync(() => log(`${source.connector}: the copy: ${error.message}`)).pipe(Effect.andThen(Effect.fail(new StepFailed({ step: "the copy", folder: null, message: error.message })))),
    ),
  );
  state.copies[source.id] = { day: options.day, folder: relative };
  return copy;
});

/**
 * `work`, made whole, becomes `folder`: renamed when there is none yet; else moved into it file by file, each in place
 * of the one before (the attachments earlier imports point at stay), and the database last, any journal of the old
 * one gone first.
 */
async function settle(work: string, folder: string, database: string): Promise<void> {
  if (!existsSync(folder)) return rename(work, folder);
  for (const entry of await readdir(work, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || (entry.parentPath === work && entry.name === database)) continue;
    const to = join(folder, join(entry.parentPath, entry.name).slice(work.length + 1));
    await mkdir(dirname(to), { recursive: true });
    await rename(join(entry.parentPath, entry.name), to);
  }
  for (const journal of ["-wal", "-shm", "-journal"]) await rm(join(folder, `${database}${journal}`), { force: true });
  await rename(join(work, database), join(folder, database));
}

/** After a run's backup: the run's earlier ones that day go, so a day keeps one. */
async function keepOneBackup(dataDir: string, printed: string, log: (line: string) => void): Promise<void> {
  const made = printed.match(/^Backed up to (.+?) \(/m)?.[1];
  const taken = made ? parseBackupName(basename(made)) : null;
  if (!made || !taken) return;
  const folder = dirname(made);
  const earlier = (await readdir(folder).catch(() => [] as string[])).filter((name) => {
    const backup = parseBackupName(name);
    return backup?.label === BACKUP_LABEL && backup.day === taken.day && !sameBackup(backup, taken);
  });
  for (const name of earlier) await rm(join(folder, name), { force: true });
  log(`backup: ${basename(made)}${earlier.length > 0 ? `, in place of ${earlier.join(", ")}` : ""}`);
}

/** <parent>/<day>, or <day>-2 and on when that is another export's. */
async function freeFolder(parent: string, day: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(parent, n === 1 ? day : `${day}-${n}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** The newest address book in platform-exports/addressbook/<day>/, the Mac's Contacts or the iPhone's, as the runbook picks it. */
export async function newestAddressBook(dataDir: string): Promise<string | null> {
  const folder = join(dataDir, "platform-exports", "addressbook");
  const days = (await readdir(folder).catch(() => [] as string[])).filter((name) => !name.startsWith(".")).sort().reverse();
  return days.map((name) => join(folder, name)).find((day) => existsSync(join(day, MAC_BOOK)) || existsSync(join(day, IPHONE_BOOK))) ?? null;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;

/** What to grant, and where. */
export function grantSteps(launcher: string): string {
  return `System Settings > Privacy & Security > Full Disk Access; click +, press Cmd-Shift-G, paste ${launcher}, choose Open, and check its switch is on. ` +
    `It runs again within 15 minutes (\`launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL}\` runs it now).`;
}

export function noAccessNote(files: string[], launcher: string | undefined): string {
  const what = files.map((file) => file.split("/").at(-1)).join(" and ");
  return `${NOTE_HEAD} the sync of this Mac's calls and Messages did nothing today: macOS has not given it Full Disk Access, so it may not read ${what}. ` +
    (launcher
      ? `Granting it is the captain's, once, to this one program (not to node): ${grantSteps(launcher)}`
      : `It ran outside its launchd agent, so the terminal it ran in needs Full Disk Access; the agent needs it for its own program (\`npm run mac-imports -- install\` names it).`);
}

/** firstmate's note on a run that failed, or whose check-data named problems. */
export function runNote(result: RunResult): string {
  const parts = result.sources.filter((s) => s.folder || !s.ok).map((s) => {
    const label = SOURCES.find((source) => source.id === s.source)!.label;
    // The count names what it counts: "Calls: 3 new".
    if (s.ok) return `${s.detail}, from ${s.folder} (a backup was taken first).`;
    return s.folder
      ? `${label}: ${s.detail} failed; its copy is in ${s.folder} in the archive's folder: run the import by hand as docs/import-runbook.md says, from the backup step.`
      : `${label}: ${s.detail} failed, so nothing was imported.`;
  });
  const check = result.checkData === null ? "" : result.checkData.ok ? " check-data found nothing wrong." : ` check-data names ${result.checkData.problems} problem${result.checkData.problems === 1 ? "" : "s"}: run \`npm run check-data\` and fix each.`;
  // Said only when the names did not come from the day's copy of the Mac's Contacts.
  const names = result.contacts?.copied ? ""
    : result.contacts ? ` The Mac's Contacts could not be copied, so names came from ${result.contacts.folder}.`
    : " There was no address book, so people new to the archive are named by their numbers.";
  const retry = result.ok ? "" : ` The next try is in an hour, and firstmate hears of another failure tomorrow at the soonest.`;
  return `${NOTE_HEAD} this Mac's calls and Messages: ${parts.join(" ")}${names}${check}${result.ok ? "" : " The log (~/Library/Logs/LifeArchive/mac-imports.log) has why."}${retry}`;
}
