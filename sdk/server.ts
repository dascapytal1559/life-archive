// The SDK a module's server half imports, and nothing else of the core's (sdk.test.ts holds every module to it): how a
// module declares itself (defineModule), the pieces a route is made of and the errors it answers (server/jsonApi.ts,
// server/errors.ts), the services the SDK names (server/modules/services.ts), the calendar's row and the tabs of
// events, and the helpers more than one module needs. The core finds a module by its place, modules/<id>/
// (server/modules/loader.ts), and a module finds the SDK by its place, this file at ../../sdk/server.ts;
// docs/modules.md says how a module is laid out, switched and tested. A module's page half imports sdk/viewer.ts, what
// both halves share (the addresses, the time and the words for a habit done) sdk/wire.ts, its connectors' processes
// sdk/connector.ts, its commands (npm scripts of their own) sdk/command.ts first, and its tests sdk/testing.ts besides.
//
// What a module may declare is what the first modules needed: health, a route, a service it offers, its made-up
// fixtures and its privacy lines; exercise, the first with a database of its own (which the core opens and keeps,
// server/modules/store.ts), connectors (which the core's host runs, handing each import's checked events to the
// module's `apply` in a transaction of its database, then pushing the calendar rows it returns), rows in the calendar
// with the two hooks the Events pages ask their owner through, and a table the Events page lists; the journal, jobs
// of its own outside the server (modules/journal/jobs/), which take what the core's jobs share (server/jobs.ts: the
// lock, the launchd agent and the launcher Full Disk Access is given to), the notifier (server/notifier/notifier.ts:
// FirstMate's inbox where one is configured, else this Mac's notifications) and the transcribers
// (server/voiceTools.ts); friend map, the AI service (server/ai.ts: Codex where a model is named, else none); and rituals, whose store is its own code's and written outside the server: its own work
// while the server runs (`work`), pushing its rows itself (`calendar.replace`), and what the NAS backup takes of its
// folder (`backup`); and rituals and exercise, the first with tools for agents at the archive's MCP door (`agents`,
// each tool made by defineTool; docs/agents.md).

import type { DatabaseSync } from "node:sqlite";
import type { Effect, Layer } from "effect";
import type { ImportCounts } from "../server/connectors/counts.ts";
import type { EventOwner } from "../server/calendar/owners.ts";
import type { CalendarRow, RowKey } from "../server/calendar/rows.ts";
import type { PushCounts } from "../server/calendar/sink.ts";
import type { ArchiveEvent, ConnectorManifest } from "../server/connectors/contract.ts";
import type { RouteError } from "../server/errors.ts";
import type { Route } from "../server/jsonApi.ts";
import type { Tab } from "../server/viewer/tab.ts";
import type { PluginOption } from "vite";
import type { ConnectorStatus, LiveState } from "../src/archive.ts";
import type { ContentLog } from "../server/archive/contentLog.ts";
import type { SyncRunner } from "../server/connectors/sync.ts";
import type { ExportFeed, JobFeed } from "../server/sources/sources.ts";
import type { ModuleAgents } from "../server/mcp/tool.ts";
import type { TableEditor } from "../server/edits/editor.ts";
import type { ModuleMove } from "../server/modules/moves.ts";

export { Clock, Context, Effect, Layer, Option } from "effect";
export { ForbiddenError, InvalidInputError, NotFoundError, UnavailableError } from "../server/errors.ts";
export { answering, fromOwnPage, readJson, sendJson, serve, type ApiHandler, type Route } from "../server/jsonApi.ts";
export { archiveFolder, envSetting, jobNode, jobPath, REPO } from "../server/dataHome.ts";
export { admittedHosts } from "../server/allowedHosts.ts";
export { CORE_FILE } from "../server/archive/coreDb.ts";
export { moduleSettingsOf as moduleSettings, settings, settingsPath, SettingsProblem, type Settings } from "../server/settings.ts";
export { buildLauncher, installLaunchAgent, launchdPlist, localTime, LOG_FOLDER, removeLaunchAgent, takeLock } from "../server/jobs.ts";
export { Notifier, notifierLayer, notify } from "../server/notifier/notifier.ts";
export { type Ai, AiService, type Question } from "../server/ai.ts";
export { liveVoiceTools, TranscribeFailed, VoiceTools, type Transcript } from "../server/voiceTools.ts";
export { getMeta, overwriting, transaction } from "../server/archive/db.ts";
export { emptyCounts, type ImportCounts } from "../server/connectors/counts.ts";
export { EXPORTS_FOLDER } from "../server/archive/mediaPaths.ts";
export { Exercise, RitualHabits, RitualWorkouts, RunsByHand, type HabitDay, type HabitStatus, type LoggedWorkout, type Peak, type Run } from "../server/modules/services.ts";
export { CROWD_SELF } from "../server/fixtures/madeUpNames.ts";
export { atomicWrite, isMissingFile, writeOnce } from "../server/files.ts";
export { parseRange, sendRanged } from "../server/byteRanges.ts";
export { hashedPath, keepByHash } from "../server/connectors/media.ts";
export { movedPath, type ModuleMove } from "../server/modules/moves.ts";
export { run, spawnScoped } from "../server/childProcess.ts";
export { runMain, runPromise } from "../server/effectRuntime.ts";
export { ZipFile, zipBytes, type ZipInput } from "../server/connectors/zip.ts";
export { acceptLanguage, addDays, dayKey, dayStart, isoAt, LOCALE, TIME_ZONE, timeOfDay, wallClock } from "../src/time.ts";
export { decodeEntities } from "../server/html.ts";
export { dateText, timeText } from "../viewer/format.ts";
export { dayOf, only } from "../server/viewer/tab.ts";
export { sourceTab, type SourceRow } from "../server/viewer/sourceTab.ts";
export { countsText, type PushCounts } from "../server/calendar/sink.ts";
export type { EventOwner, OwnerDetail } from "../server/calendar/owners.ts";
export type { CalendarRow } from "../server/calendar/rows.ts";
export type { ArchiveEvent, SportFamily, StreamInfo, WorkoutEvent, WorkoutStream } from "../server/connectors/contract.ts";
export { defineTool, ToolRefused, type AgentTool, type ModuleAgents, type ToolCall } from "../server/mcp/tool.ts";
export { Schema } from "effect";

/** The SDK's major: a module written for another is refused with a plain message, as friend-map's handshake refuses a contract's. */
export const SDK_VERSION = 1;

/** What every module is given as the core loads it. */
export interface ModuleContext {
  /** The archive's folder (server/dataHome.ts): a module keeps its files in there, in a folder of its own (modules/<id>/). */
  readonly folder: string;
}

/** What a module with a database of its own (ModuleDefinition's `database`) is given besides: that database, open. */
export interface ModuleStore extends ModuleContext {
  /** Its database, open, its schema up to date (server/modules/store.ts); the core closes it as the server stops. */
  readonly db: DatabaseSync;
}

/**
 * The core's calendar as a module reaches it, for the rows pushed in its name (server/calendar/sink.ts; docs/events.md's "The
 * calendar"): what its imports bring is pushed for it, from what `apply` answers (ModuleConnectors); a module whose
 * store is written outside the server pushes its rows itself (`replace`: rituals, whose store ritualctl writes). While
 * the archive, and the calendar with it, could not be opened, it throws the archive's error.
 */
export interface ModuleCalendar {
  /** Adds or brings up to date these rows of the module's, leaving its others as they are. What it did. */
  push(rows: readonly CalendarRow[]): PushCounts;
  /**
   * Makes the module's rows these and no others, in one transaction: each added, brought up to date or left as it is,
   * and the rest forgotten; with `scope`, only the rest of those kinds (and those days) are forgotten (friend map's
   * calls, or a day's summaries). What it did.
   */
  replace(rows: readonly CalendarRow[], scope?: { readonly kinds?: readonly string[]; readonly days?: readonly string[] }): PushCounts;
  /** Takes rows out for good, in one transaction, their bytes overwritten and the WAL checkpointed: a delete leaves nothing behind. */
  forget(keys: readonly Pick<RowKey, "origin" | "nativeId">[]): void;
}

/** The connectors' host as a module reaches it (server/connectors/host.ts): what each connector is doing, and the live ones that can send. */
export interface ModuleHost {
  /** Every connector, the core's and the modules', on or off, with its last run and, for a live one, how it is doing. */
  statuses(): Promise<ConnectorStatus[]>;
  /** The live connectors that can send, each with its platform and how it is doing. */
  sendingPlatforms(): Array<{ platform: string; connector: string; state: LiveState }>;
  /** Every connector's manifest, the core's and the modules'. */
  manifests(): ConnectorManifest[];
  /** The live connector that sends on `platform` while it runs, or null. */
  sender(platform: string): ConnectorSender | null;
}

/** A live connector a send is handed to (server/connectors/sync.ts's SyncRunner). */
export type ConnectorSender = Pick<SyncRunner, "command" | "state" | "describe" | "entry">;

/** What the running archive lends a module's routes, services and hooks. */
export interface ModuleLive {
  readonly calendar: ModuleCalendar;
  /** The connectors' host. Throws the archive's error while the archive is not open. */
  readonly host: ModuleHost;
  /** The trail of content reads (server/archive/contentLog.ts), the core's: every read of the module's content goes in it. */
  readonly contentLog: Pick<ContentLog, "record">;
  /**
   * Runs `work` with the live sync of every connector of `platforms` stopped, and starts again each that was running,
   * with its settings as they are then (server/connectors/host.ts): so no pass under way writes while `work` changes
   * what that sync keeps. Throws the archive's error while the archive is not open.
   */
  readonly pausingLive: <T>(platforms: readonly string[], work: () => Promise<T>) => Promise<T>;
}

/** A module's database, which the core opens and keeps (server/modules/store.ts). */
export interface ModuleDatabase {
  /** Its file's name, kept in modules/<id>/ of the archive's folder ("exercise.sqlite"). */
  readonly file: string;
  /** Each moves the schema one version forward, run in order with the archive's runner; never edit one that has shipped, add one. A `meta` table is the core's, there before them. */
  readonly migrations: readonly string[];
  /**
   * For a database whose schema its own runner brings up (friend map's archive, with migrations of its own since
   * before it was a module): opens the file at `file` in the archive's folder `folder` and brings it up to date, in
   * place of `migrations`, which it leaves empty. A database it will not open (one not yet where it belongs) it throws
   * for, and the module is broken.
   */
  readonly open?: (file: string, folder: string) => DatabaseSync;
  /** For one that opens itself (`open`): the schema version its open brings it to, so `migrate` knows it is behind. */
  readonly version?: number;
  /**
   * The read-only connection the viewer's tables read the database on (sdk/server.ts's `tabs`, Reads' `modules`):
   * by default read-only and query_only; friend map's also unable to read content, as its SQL runner is.
   */
  readonly reads?: (file: string) => DatabaseSync;
  /**
   * For a dry run of an import of `platform` (server/archive/dryRun.ts): the copy in memory of the database at `file`
   * the import is applied to, in place of a copy of every row (friend map's: only the platform's records, none of
   * their content).
   */
  readonly dryRun?: (file: string, folder: string, platform: string) => DatabaseSync;
  /**
   * What `npm run archive -- migrate` says of the database once it is up to date, after the schema's own line: what
   * its migrations made of the rows (friend map's: what became of Met and Lives), each a line.
   */
  readonly migrated?: (db: DatabaseSync) => string[];
  /**
   * Once, when the database is new and there is an archive beside it: the rows the core's archive held for the module
   * before it was one, copied in, the archive (`takeOverFrom`) attached to `db` as `archive` for the call and only read
   * (the module's old tables stay there until a migration drops them, on the owner's word), and given the archive's
   * folder (for files the module copies into its own). In one transaction; a throw undoes it, the module is broken
   * with why, and the next open tries again; once it is done, `meta`'s `taken_over` says the day.
   */
  readonly takeOver?: (db: DatabaseSync, folder: string) => void;
  /**
   * Before `takeOver`'s transaction, with the archive attached as for it: the files it will find in the module's folder,
   * copied there, so a slow copy holds no lock on the database. Run again on each try, so it must leave what is already
   * copied as it is.
   */
  readonly takeOverFiles?: (db: DatabaseSync, folder: string) => void;
  /**
   * The database in the archive's folder `takeOver` copies from: archive.sqlite (the archive's, before friend map was a
   * module; the default) or CORE_FILE (the core's, which held the inspirations).
   */
  readonly takeOverFrom?: string;
}

/** One import, or one batch of a live sync, as the host applies it. */
export interface AppliedSource {
  /** Its row in the module's `source` table, which the host keeps. */
  readonly id: number;
  readonly platform: string;
  /** What kind of source it is: an export, an app's database, or a live connector's batch. */
  readonly kind: "export" | "app-db" | "live";
  /** When its events were read. */
  readonly seenAt: number;
  /** The archive's folder, which a copy's file is kept relative to when it is inside it. */
  readonly folder: string;
}

/** A module's connectors, which the core's host runs as it runs its own (server/connectors/host.ts). */
export interface ModuleConnectors {
  /** Each connector: its manifest, and the file the host runs in a process of its own (`main`, absolute; sdk/connector.ts). */
  readonly connectors: ReadonlyArray<{ readonly manifest: ConnectorManifest; readonly main: string }>;
  /**
   * Applies one import's (or one batch's) checked events to the module's database, inside the host's transaction of it:
   * the counts for the import's record, and the calendar rows of what it added or changed, which the core pushes once
   * the transaction has committed. The module's database holds the host's `source` and `connector_state` tables
   * (CONNECTOR_TABLES among its migrations).
   */
  readonly apply: (events: Iterable<ArchiveEvent>, db: DatabaseSync, source: AppliedSource) => { counts: ImportCounts; rows: readonly CalendarRow[]; afterCommit?: () => void };
  /** Why connector `connector`'s history import cannot run now (friend map's: a Messenger chat still under its old key), or null. */
  readonly before?: (connector: string, db: DatabaseSync) => string | null;
  /** After a history import of one of its connectors: what it does then (friend map's people rules), and the lines the import command says of it. */
  readonly afterImport?: (result: { connector: string; platform: string; sourceId: number }, settings: Record<string, unknown>, db: DatabaseSync) => Promise<readonly string[]>;
  /** What else a dry run's import `sourceId` into the copy `db` would do, in lines (friend map's: the calls it would add). */
  readonly dryRunSaid?: (db: DatabaseSync, sourceId: number) => readonly string[];
  /** As this process takes the live connectors on (the live bridges' lock), and as it stops them, given the module's database. */
  readonly live?: { readonly onOwn?: (db: DatabaseSync) => void; readonly stop?: (db: DatabaseSync) => Promise<void> };
  /** Settings every connector of the module runs with beyond its file's (the tombstones of what was deleted), read as it starts. */
  readonly settings?: (db: DatabaseSync) => Record<string, unknown>;
  /** What the module holds now that each connector first brought, for the Sources tab: how many of each kind of event. */
  readonly brought: (db: DatabaseSync) => ReadonlyArray<{ readonly connector: string; readonly kind: string; readonly count: number }>;
}

/**
 * The `source` and `connector_state` tables the host keeps a module's imports in (server/archive/db.ts has the archive's
 * own, the same): a module with connectors puts this among its migrations.
 */
export const CONNECTOR_TABLES = `
  CREATE TABLE source (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    connector TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('export', 'app-db', 'live')),
    label TEXT NOT NULL,
    content_sha256 TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
    counts_json TEXT,
    error TEXT
  );
  CREATE TABLE connector_state (
    connector TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'error')),
    last_run_at INTEGER,
    last_ok_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER,
    cursor_json TEXT
  );
`;

/**
 * A module's answers for the rows pushed in its name (server/calendar/owners.ts; docs/events.md's "The calendar"): the two hooks
 * the Events pages ask the owner of a row through, and every row it would push now, for the calendar's rebuild and the
 * drift check (`npm run archive -- calendar check`).
 */
export interface ModuleEvents extends EventOwner {
  /** Every calendar row the module's store holds now, as they are pushed. */
  rows(): CalendarRow[];
}

/** A module's lines of the privacy policy (server/privacy/policy.ts), written into docs/privacy.md with the core's. */
export interface ModulePrivacy {
  /** What of its data is content (the content layer's list): what was said and shown, and every copy that holds it. */
  readonly content?: readonly string[];
  /** What holds its content to the rule (the content layer's guards). */
  readonly contentGuards?: readonly string[];
  /** What of its data is metadata (the metadata layer's list), which external models read freely. */
  readonly metadata?: readonly string[];
}

/** A module's made-up data, for `npm run testing-data` (server/fixtures/testing-data.ts) and the tests; never anyone's. */
export interface ModuleFixtures<S extends ModuleContext> {
  /** What it writes, in a few words, for the command's summary: "made-up health results, for the Health tab". */
  readonly what: string;
  /**
   * Writes it into the testing folder `dataDir`, and for a module with a database into that (`store.db`); with `crowd`
   * (`npm run testing-data -- --crowd` or `--long`), a made-up crowd for the map views where the module has one.
   */
  readonly write: (dataDir: string, store: S, options?: { readonly crowd?: "crowd" | "long" }) => Promise<void>;
}

/**
 * What a module's module.ts declares, as its default export, through defineModule. `S` is what it is given: the archive's
 * folder, and its database when it declares one. `Own` is the services its own Layer offers, which its routes may
 * yield; another module's service, or the core's, a route asks for optionally (Effect.serviceOption), so it lives
 * without it when that module is off.
 */
export interface ModuleDefinition<S extends ModuleContext = ModuleContext, Own = never> {
  /** Its slug, the name of its folder under modules/. */
  readonly id: string;
  /** The SDK major it was written for. */
  readonly sdk: typeof SDK_VERSION;
  /** Its own database, which the core opens for it. */
  readonly database?: ModuleDatabase;
  /** Its connectors, which the core's host runs, their imports applied to its database. */
  readonly connectors?: ModuleConnectors;
  /** What it answers at MODULES_API/<id> and under it: one route, an Effect program per request (server/jsonApi.ts). */
  readonly routes?: (context: S & ModuleLive) => Route<RouteError, Own>;
  /** The services it offers the core and the other modules, as a Layer: each a service the SDK names (RunsByHand, Exercise), and its own. */
  readonly services?: (context: S & ModuleLive) => Layer.Layer<Own>;
  /** Its answers for the rows pushed in its name into the calendar, and every row that would be pushed now. */
  readonly events?: (context: S & ModuleLive) => ModuleEvents;
  /**
   * Its own work while the server runs, in a fiber of the server's scope, interrupted as the server stops, with the
   * services its own Layer offers: rituals' watch on its store, which ritualctl writes outside the server, pushing its
   * rows into the calendar as it changes; Shopping's morning pulls, through its Shopping service.
   */
  readonly work?: (context: S & ModuleLive) => Effect.Effect<void, never, Own>;
  /** Its tables (server/viewer/sourceTab.ts over the calendar's rows, as the core's are), each listed in the Events page's Tables after the core's. */
  readonly tabs?: readonly Tab[];
  /**
   * Its answers for editing its tables' rows (server/edits/editor.ts; docs/modules.md's "Editing a table"): an editor for
   * each table of its that declares fields to edit (sourceTab's `edits`), which writes each edit through its own path,
   * keeps a change to an imported row as a correction beside it, and pushes the row into the calendar.
   */
  readonly edits?: (context: S & ModuleLive) => readonly TableEditor[];
  /**
   * What it offers agents at the archive's MCP door (server/mcp/; docs/agents.md): what it holds, in a sentence or two
   * for start_here, and its tools (defineTool), each named with the module's id first and needing facts, content or a
   * write; given what its routes are given, and run with the same services.
   */
  readonly agents?: (context: S & ModuleLive) => ModuleAgents<Own>;
  /**
   * What its page half is told as the console opens (GET /life-archive/api/settings, PageSettings' `moduleSettings`, read
   * there through sdk/viewer.ts's moduleSettings): plain JSON, asked once as the server starts, and only while it is on.
   * A private module's addresses and links, say, which its own settings hold and no file of the core's names.
   */
  readonly viewerSettings?: () => unknown;
  readonly fixtures?: ModuleFixtures<S>;
  readonly privacy?: ModulePrivacy;
  /**
   * What the NAS backup takes of the module's folder in the archive's folder beyond a database the core opens
   * (`database`, which it takes as a checked copy by itself; server/archive/nasBackup.ts): the SQLite databases the
   * module keeps itself, each sent as a checked copy at the snapshot's root by its file name, never as the live file,
   * and the folders left out (its own backups), each relative to modules/<id>/.
   */
  readonly backup?: { readonly databases: readonly string[]; readonly exclude?: readonly string[] };
  /**
   * Its files or folders kept in the archive's folder outside modules/<id>/ from before modules kept theirs there (health's
   * health/), each read through `movedPath` until `npm run archive -- migrate module-data` moves it, after a backup
   * (server/modules/moves.ts): where it was, from the archive's folder, and where it goes, from modules/<id>/.
   */
  readonly moves?: readonly ModuleMove[];
  /**
   * Paths outside MODULES_API its route answers too, as they come (friend map's contract at /api/archive and under its
   * page's path, and the conversations a Messages row's drawer opens; Shopping's page at /life-archive/api/shopping, its
   * address before it was a module): each request to one, or under it, goes to its route whole.
   */
  readonly mounts?: readonly string[];
  /**
   * A page of its own, which the console shows in a frame (friend map's: friend-map's page): its address (`path`, as
   * /friend-map, the page served under it and its routes under `path`/api, a mount), its root (an index.html in it), and
   * the Vite plugins it is served with, given the archive's folder. Served by the core in the server's process.
   */
  readonly page?: { readonly path: string; readonly root: string; readonly plugins?: (folder: string) => PluginOption[] };
  /**
   * Its commands, which `npm run archive -- <name>` hands on: each name it answers, the options they take (node:util's
   * parseArgs config, parsed with the core's own), what the command list says of them (lines among the structure
   * commands', and among the content commands'), and how it runs one, with the arguments after its name.
   */
  readonly commands?: {
    readonly names: readonly string[];
    readonly options?: Readonly<Record<string, { readonly type: "string" | "boolean"; readonly multiple?: boolean; readonly short?: string }>>;
    readonly help?: { readonly structure: string; readonly content?: string };
    readonly run: (command: string, args: readonly string[], values: Record<string, unknown>, context: S & ModuleLive & CommandLive) => Promise<void>;
  };
  /** The documents `npm run docs` writes from its code (tools/docs/docs.ts), each by its file from the repository's root. */
  readonly documents?: ReadonlyArray<{ readonly file: string; readonly text: () => string }>;
  /** What the Events page's Sources tab says of its connectors' scheduled jobs on this Mac (server/sources/sources.ts). */
  readonly sources?: { readonly jobs?: readonly JobFeed[]; readonly exports?: readonly ExportFeed[] };
  /** Problems in its data, each a line, for `npm run check-data` (given its database, read-only, and the archive's folder). */
  readonly checkData?: (db: DatabaseSync, folder: string) => readonly string[];
  /**
   * The words for one part of a content read's scope in the trail (`npm run archive -- content-log`), when the part is
   * its own (friend map's `person`: "person 2 Ada Sample"); null for one it does not know.
   */
  readonly describeScope?: (db: DatabaseSync, key: string, value: unknown) => string | null;
  /**
   * Its part of the static demo's build (docs/demo.md; tools/demo/record.ts): which of its routes' answers the demo
   * keeps, asked of the archive's server running over the made-up testing data. Its half in the page, what the demo
   * answers live, is its demo.ts (sdk/demo.ts).
   */
  readonly demo?: { readonly record: (recorder: DemoRecorder) => Promise<void> };
}

/** What a module's `demo.record` asks the server through, as the demo is built (tools/demo/record.ts). */
export interface DemoRecorder {
  /** The made-up folder the server runs over. */
  readonly folder: string;
  /**
   * Whether the build may fetch open data from the web into the made-up folder before asking (the exercise module's map
   * and terrain of the demo's area): false for a build that must not reach the network (the tests).
   */
  readonly network: boolean;
  /** The server's answer to a GET of `path` (with its query), kept for the demo as it answered it; its JSON. */
  json<T = unknown>(path: string): Promise<T>;
  /** A file the server answers at `path` (a map's tile), kept at its own path in the demo; false when it had none there. */
  file(path: string): Promise<boolean>;
}

/** What a module's command is lent besides (sdk/server.ts's `commands`). */
export interface CommandLive {
  /** A checked backup of every database before a change (server/archive/backups.ts): the name of the archive's copy. */
  readonly backup: (label: string) => Promise<string>;
}

/**
 * A module's declaration as the core holds it, whatever it was given and offers (server/modules/loader.ts). A module
 * that offers no services offers `never`, which `any` does not take in (a Layer's output is contravariant), so it is
 * named apart.
 */
export type AnyModuleDefinition = ModuleDefinition<any, any> | ModuleDefinition<any, never>;

/** A module's declaration: `export default defineModule({...})` in its module.ts; with `database`, it is given its database too. */
export function defineModule<Own = never>(definition: ModuleDefinition<ModuleStore, Own> & { readonly database: ModuleDatabase }): ModuleDefinition<ModuleStore, Own>;
export function defineModule<Own = never>(definition: ModuleDefinition<ModuleContext, Own> & { readonly database?: undefined }): ModuleDefinition<ModuleContext, Own>;
export function defineModule(definition: AnyModuleDefinition): AnyModuleDefinition {
  return definition;
}

// What the inspirations module uses of the core's, as it was the core's own before it was a module: the change log's
// words for a change of its own (its command, and how a tag and a note are written, are friend map's below too).
export { quoted, type ChangeDescriber, type LoggedChange } from "../server/archive/changes.ts";

// What the friend map module uses of the core's, as it was the core's own before it was a module.
export { parseBackupName, sameBackup } from "../server/archive/backups.ts";
export { Changes, KEEP_DAYS, UndoConflictError } from "../server/archive/changes.ts";
export { CHANGE_LOG_TABLES, type TableSpec } from "../server/archive/changeTables.ts";
export { type Added, type Applied, type EditFailure, type EditMeta, type EditRow, type OwnTableRows, type TableEditor, type Undone, undoneInLog } from "../server/edits/editor.ts";
export { instantOf, NOTE_MOST, wallParts, wallText } from "../server/edits/values.ts";
export { EDITS_API, type EditChoice, type EditDone, type EditField, type EditOption, type OptionsAnswer, type EditsAnswer, type EditState, type EditValue, type FieldState, type LocksAnswer, type OwnRows, type RowValues } from "../viewer/editWire.ts";
export { type ReadScope } from "../server/archive/contentLog.ts";
export { type Db, bumpMeta, schemaVersion, setMeta } from "../server/archive/db.ts";
export { EventOrderError } from "../server/archive/events.ts";
export { COPIES_FOLDER, homeOf, homeRank, localPathOf, resolveLocalPath } from "../server/archive/mediaPaths.ts";
export { isEncodedName, isNumberName, isPhone, isPlaceholderName, joinsByName, nameKey, normalizeHandle, plainText, sameName } from "../server/archive/names.ts";
export { FRIEND_MAP } from "../server/calendar/rows.ts";
export { RunFailed } from "../server/childProcess.ts";
export { type AccountEvent, type AttachmentEvent, type CallEvent, type CommandOutcome, type ConnectorCommand, type ConnectorEvent, type ConversationEvent, type CoverageEvent, type EditEvent, type HistoryOptions, MESSAGE_TYPES, type MessageEvent, type MessageType, type ObtainStep, type ReactionEvent, type StoredMedia, isPlatform } from "../server/connectors/contract.ts";
export { type ConnectorHost, ImportFailedError, type ImportResult, loadRegistry } from "../server/connectors/host.ts";
export { expandHome, jsonLines } from "../server/connectors/lines.ts";
export { settled, type Change as FolderChange } from "../server/connectors/conversations.ts";
export { LIVE_FOLDER, MediaLedger, keepInPlace, mediaTypeOf, unpackFirst } from "../server/connectors/media.ts";
export { NotConnectedError } from "../server/connectors/sync.ts";
export { type ZipEntry, writeZip } from "../server/connectors/zip.ts";
export { runBackground } from "../server/effectRuntime.ts";
export { Fiber } from "effect";
export { readBody } from "../server/jsonApi.ts";
export { ARCHIVE_FOLDER_HEADER, sameFolder } from "../server/dataHome.ts";
export { moduleApi } from "../viewer/wire.ts";
export { viewerReads } from "../server/viewer/connection.ts";
export type { ConnectorManifest } from "../server/connectors/contract.ts";
export { type RouteError } from "../server/errors.ts";
export { CROWD_FIRST, CROWD_LAST } from "../server/fixtures/madeUpNames.ts";
export { ArchiveCommands, archiveCommandsLayer } from "../server/jobs.ts";
export { type BucketEdge } from "../server/viewer/buckets.ts";
export { Memo } from "../server/viewer/memo.ts";
export { MOST_FACET_VALUES, type Page, type Reads, type Tab, type VolumeAsk, chartBuckets, edgesJson, namesOf, peopleOf, volumeAnswer, withEach } from "../server/viewer/tab.ts";
export { ARCHIVE_TAG, type AccountSummary, type ArchiveReason, type ArchiveRule, type ArchivedUntouched, BUILT_IN_TAGS, CAPABILITIES, CONTRACT_VERSION, type CalendarCall, type CalendarChat, type CalendarDay, type CalendarDayChat, type CalendarMonth, type CalendarPerson, type CalendarTagged, type CallAnswer, type CallAnsweredSaved, type CallCounts, type CallDay, type CallLengthSaved, type CallNoteSaved, type CallPersonInput, type CallRef, type Capability, type CatchUp, type CatchUpInput, type CatchUpSaved, type ChangesetInfo, type ClosenessSettings, type ConnectorStatus, type Contract, type CoverageReport, type DayMessagesPage, type Draft, FORMER_FIELDS, type GeneratedQuery, type GroupChat, type GroupMember, type GroupMembership, type GroupPerson, type GroupUnlink, type GroupUnlinkSaved, KEEP_TAG, LIVE_TOGETHER_TAG, type LinkSource, type ListedCall, type LiveState, type LocationInfo, type LoggedCall, MANUAL_CALL_APPS, type ManualCallApp, type ManualCallInput, type ManualCallSaved, type MapFacts, type MapFactsPerson, type MergeProposal, type MessageApps, type MessageCounts, type PeopleListing, type PersonActivity, type PersonAdded, type PersonCall, type PersonGroup, type PersonRelationship, type PersonSaved, type PersonSummary, type QueryResult, type RelationshipsReport, SYSTEM_ARCHIVE_TAG, type ScoreReport, type ScoredCatchUp, type SearchHit, type SendResult, type SendTarget, type TableRow, type TagInfo, type TagsChanged, type TagsSaved, type TimelineMessage, type TimelinePage, type Trip, countsByPlatform, isSqlQuery, platformsOf, tagsWithRule, writtenTag } from "../src/archive.ts";
export { calendarDayOf, calendarDayStart } from "../src/calendarDay.ts";
export { CALL_LENGTH_MOST_MINUTES, CALL_PLATFORMS, callPlatformName, callTotals, carriesCalls } from "../src/calls.ts";
export { DAYS_MOST, HOURS_MOST, OTHERS_MOST, PRIVATE_FROM, PRIVATE_TO, catchUpDayCount, catchUpHoursOn, isOnDay, tripHours } from "../src/catchUps.ts";
export { HANGOUT } from "../src/eventWords.ts";
export { NAMED_BY } from "../src/groupName.ts";
export { identiconSeedOf, isIdenticonHue, isIdenticonSeed } from "../src/identicon.ts";
export { daysBetween, isDay, isMonth, monthDays, monthKey, monthRange, zonePlace } from "../src/time.ts";
export { CONTENT_API, CONVERSATION_PAGE, type Cell, type ChatPage, type DayChat, type DayChatPage, type DayChatsAnswer,type DetailField, type FacetValue, type FacetsAnswer, type Filters, type Grain, type KindSpec, type KindsAnswer, type LinkCell, type Row, type RowDetail, type RowsAnswer, type ViewLink, type VolumeAnswer } from "../viewer/wire.ts";
export { callDuration, callLabel, defaultCallAccount, parseCallLength } from "../src/calls.ts";
export { catchUpTitle, othersLabel, timeLabel } from "../src/catchUps.ts";
export { relativeDay } from "../src/time.ts";
export { ARCHIVE_REASONS } from "../src/archive.ts";
export { readerFromEnvironment, type ContentReadRow } from "../server/archive/contentLog.ts";
export { changesCommand, changesetLine, printChangeset, when } from "../server/archive/changesCli.ts";
export { archiveUrl } from "../server/dataHome.ts";
export { nasLine, readNasStatus } from "../server/archive/nasBackup.ts";
export { readCaptureStatus, transcriptsLine } from "../server/archive/transcripts.ts";
export { readOnlyAddress } from "../server/archive/db.ts";
export { redactText } from "../server/archive/redact.ts";
export { combineNotes, freeText, normalizeNote, normalizeTag } from "../server/archive/textFields.ts";
export type { ExportFeed, JobFeed } from "../server/sources/sources.ts";
export { PLATFORMS } from "../server/connectors/contract.ts";
