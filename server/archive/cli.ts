// npm run archive -- <command>: the archive from the terminal, for the captain and for agents. Run with no command for
// the list: the core's commands (importing, the connectors, the event index, the calendar, the backups and the
// migrations) and each module's (sdk/server.ts's `commands`: the inspirations', modules/inspirations/server/cli.ts;
// friend map's people, chats, calls and hangouts, modules/friend-map/server/commands.ts; the folder history's history),
// which this hands on with the options it parsed for them.
//
// Every command except `timeline`, `search` (friend map's) and `event-content` prints structure only (names, counts,
// dates), never content. Those print it: use them only when the captain asks for something from his chats or his
// conversations with agents. Each such read is kept in the trail of content reads (contentLog.ts; `content-log` shows
// it), with the reader an agent names in LIFE_ARCHIVE_READER (or FRIEND_MAP_READER, its old name) and the captain's
// words in --why. With --redacted they print every text as its length, and with --testing a module's command reads a
// testing folder made afresh (every module's made-up data) instead, so its answer's shape can be learned without
// reading content.
//
// Every command that changes what the captain decides is one changeset in a change log (changes.ts: friend map's of
// people, the inspirations module's of them), taken after a checked backup of every database (backups.ts), and says its
// number, so it can be shown and undone.

import "../onPinnedNode.ts";
import "../onDataFlag.ts";
import "../onSettings.ts";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import type { ConnectorStatus } from "../../src/archive.ts";
import { dayKey, isDay, timeOfDay, LOCALE, TIME_ZONE, zonePlace } from "../../src/time.ts";
import type { ImportCounts } from "../connectors/counts.ts";
import { isPlatform } from "../connectors/contract.ts";
import { archiveFolder, archiveUrl } from "../dataHome.ts";
import { CALENDAR_FILE, CALENDAR_SCHEMA_VERSION } from "../calendar/db.ts";
import { countsText } from "../calendar/sink.ts";
import { createBackup, pruneBackups } from "./backups.ts";
import { dryRunImport } from "./dryRun.ts";
import { type ContentReadRow, readerFromEnvironment, type ReadScope } from "./contentLog.ts";
import { when } from "./changesCli.ts";
import { EVENT_KINDS, type EventRow } from "./events.ts";
import { MCP_HELP, mcpCommand } from "../mcp/cli.ts";
import { McpKeys } from "../mcp/keys.ts";
import { latestLlmSession, readLlmContent } from "./llmContent.ts";
import { CORE_FILE, CORE_SCHEMA_VERSION, openCore } from "./coreDb.ts";
import { schemaVersion } from "./db.ts";
import { migrateFriendMap } from "./migrate.ts";
import { redactText } from "./redact.ts";
import { Archive, unmovedArchive } from "./index.ts";
import { loadModules, moduleCommand, moduleTabs, type Modules } from "../modules/loader.ts";
import { editsCommand, EDITS_HELP } from "../edits/cli.ts";
import { tableEditsOf } from "../edits/edits.ts";
import { tabsWith } from "../viewer/tabs.ts";
import { closeModuleStores, moduleDatabaseFile, openModuleStores, type ModuleStores } from "../modules/store.ts";
import { moveModuleData, pendingMoveLines, planModuleMoves, type PlannedMove } from "../modules/moves.ts";
import { settings, SettingsProblem } from "../settings.ts";

/** The modules the settings leave on; a settings file that cannot be used stops the command in its own words, and a switch naming no installed module is said so on stderr and switches nothing. */
async function modulesOn(): Promise<Modules> {
  try {
    return await loadModules({ switches: settings().modules, pages: settings().pages });
  } catch (error) {
    if (!(error instanceof SettingsProblem)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

const modules = await modulesOn();
const commanding = modules.on.filter((m) => m.definition.commands);

const HELP = `Usage: npm run archive -- <command> [options]

Structure (names, counts and dates; never message text):
  import <connector> [source ...]       import an export from its folder, data/platform-exports/<platform>/<export date>/,
                                        unpacked there (exports unpack), since its media are kept where they are:
                                        e.g. import facebook-dyi ~/life-archive-data/platform-exports/messenger/2026-09-28/;
                                        a zip holding no media can be named itself
    --contacts <address book>           whatsapp-db and imessage-db: the address book to name people from (a copy
                                        of the Mac's Contacts, data/platform-exports/addressbook/<date>/, or an
                                        iPhone's AddressBook.sqlitedb), and to fill their notes from (as
                                        contact-notes does); call-history: to name the numbers called from
    --settings <json>                   settings for this import only, over the connector's own, e.g. for
                                        whatsapp-db '{"only": "calls", "callsFrom": "chats"}' (README's WhatsApp)
    --dry-run                           read the source and say what the import would add and change, and which
                                        calls it would add, without writing to the archive or a module's database
                                        (they are only read)
  connectors                            each connector, on or off, and its last run; for a live one
                                        (matrix-bridge), what it needs and how the server's copy is doing
  enable <connector> / disable <connector>
${commanding.map((m) => m.definition.commands!.help?.structure ?? "").filter(Boolean).join("\n")}
  events [--day <YYYY-MM-DD>] [--kind <kind>] [--json]
                                        the event index (the life archive's list of what happened): with no day, how
                                        many events of each kind each origin has, from the first day to the last; with
                                        --day, that ${zonePlace()} day's events in time order, each with its number, time,
                                        kind, size and detail, never its content. Kinds: ${EVENT_KINDS.join(", ")}
  calendar [--json]                     the calendar (calendar.sqlite, the core's index the Events pages read, which the
                                        archive's parts push into: server/calendar/): how many rows of each kind each
                                        module has, from the first day to the last, and when it was last built whole
  calendar check [--json]               what a rebuild would change: rows missing, differing or extra, module by
                                        module; none when the pushes have kept it right (exit 1 when any). The rebuild
                                        it points to holds the calendar for as long as it takes (below)
  calendar rebuild                      build it again, whole, from the archive: every module's rows made what they
                                        would be had every push been made (nothing of the archive changes). It holds
                                        the calendar for as long as it takes: the server's pushes and content reads
                                        wait up to ten seconds each, the server answering nothing meanwhile, then
                                        fail, and a day's summaries or an index event lost that way come back only
                                        with another rebuild (calendar check shows them). On a large archive, best
                                        run with the server stopped
${EDITS_HELP}
  migrate friend-map-module [--apply]   the one-time move of friend map's archive (archive.sqlite at the folder's
                                        root, from before friend map was a module) into modules/friend-map/, and of
                                        the core's own tables out of it into core.sqlite (the agents' sessions, the
                                        inspirations, the core's connectors' runs), the trail of content reads it still
                                        held into the calendar's, and the exercise and rituals modules' old rows
                                        dropped; with the server stopped. A dry run says what it would move and copy;
                                        --apply makes it, after a checked backup, checks every count, and says so
  migrate module-data [--apply]         move each module's files from where they were before modules kept theirs in
                                        modules/<id>/ (health's health/, exercise's exercise.json), which each module
                                        reads at the old place until then. A dry run says what it would move; --apply
                                        copies each into data/backups-kept/ first, checks the copy and only then
                                        moves it, in one rename (the modules read these files afresh each time, so
                                        the server may keep running)
  migrate                               bring every database's schema up to date after a checked backup
  backup <label>                        copy the core's database to data/backups/<date>T<time>-<label>.sqlite
                                        and check it, with a checked copy of each module's database beside it; then
                                        prune, each module's copy with the archive's: over 48 hours old goes,
                                        and of the rest only the newest of each (${zonePlace()}) day and every
                                        before-import-* stay
  backup --prune [--dry-run]            prune only; --dry-run lists what would go

${MCP_HELP}

Content (prints message text; only when the captain asks for something from his chats):
${commanding.map((m) => m.definition.commands!.help?.content ?? "").filter(Boolean).join("\n")}
  event-content <event>                 the text behind an event of the index (its number from events): an LLM prompt
                                        or reply, or every prompt and reply of a session, read from the archive's copy
                                        where the index says it is (--testing is for timeline and search only)
  event-content --latest <origin>[/<how>]   the session of an agent (claude-code, grok-bot) that went on latest, or
                                        of one way it was run (e.g. grok-bot/chat, grok-bot/call, claude-code/cli),
                                        to pick up where it is: "have a look at what Grok said"
    --last <n>                          only its last n prompts and replies
    --why <words>                       the captain's words for the job, kept with the read
    --json                              the answer as the app's content routes give it
    --redacted                          every text as its length ("[redacted: 12 characters]"), so its shape can
                                        be learned without reading it (a search is still a read: what matches is content)
    --testing                           the same command over the testing data (npm run testing-data's made-up chats and
                                        people, with photos, a video and a voice note), never the archive; not logged
  Every read but --testing is kept in the trail, with the reader named in $LIFE_ARCHIVE_READER (agents set it;
  $FRIEND_MAP_READER, its old name, too).
  content-log [--limit <n>]             the trail of content reads, the latest first: when, from the cli (and who)
                                        or the app, what, how many times, and why


Options:
  --data <dir>      the archive's folder (default: $LIFE_ARCHIVE_DATA, else $FRIEND_MAP_DATA, from the
                    environment or .env.local, else ~/life-archive-data; see server/dataHome.ts)`;

/** The options the core's own commands read. */
interface CoreValues {
  data?: string; limit?: string; day?: string; kind?: string; contacts?: string; settings?: string; prune?: boolean; "dry-run"?: boolean; why?: string;
  apply?: boolean; into?: string; json?: boolean; redacted?: boolean; latest?: string; last?: string; testing?: boolean; help?: boolean;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  // The core's options, then each module's for its commands (sdk/server.ts's `commands`), parsed together.
  options: {
    ...Object.assign({}, ...commanding.map((m) => m.definition.commands!.options ?? {})),
    data: { type: "string" },
    limit: { type: "string" },
    day: { type: "string" },
    kind: { type: "string" },
    contacts: { type: "string" },
    settings: { type: "string" },
    prune: { type: "boolean" },
    "dry-run": { type: "boolean" },
    why: { type: "string" },
    apply: { type: "boolean" },
    into: { type: "string" },
    json: { type: "boolean" },
    redacted: { type: "boolean" },
    latest: { type: "string" },
    last: { type: "string" },
    testing: { type: "boolean" },
    // Friend map's own options, which no core command reads, taken even with friend map off, as they always were.
    query: { type: "string" },
    note: { type: "string" },
    // mcp (server/mcp/cli.ts)
    grant: { type: "string", multiple: true },
    agent: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
}) as { values: Record<string, string | boolean | string[] | undefined> & CoreValues; positionals: string[] };
const [command, ...args] = positionals;
if (!command || values.help) {
  console.log(HELP);
  process.exit(command || values.help ? 0 : 1);
}

const dataDir = archiveFolder();
// Before the archive is opened, since opening it can bring its schema up to date.
if (command === "backup") {
  try {
    await backup(args.join(" "));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
  process.exit();
}

async function backup(label: string): Promise<void> {
  const dir = join(dataDir, "backups");
  if (values.prune || values["dry-run"]) {
    if (label) throw new Error("backup --prune takes no label; give one without --prune to take a backup");
    const doomed = await pruneBackups(dir, { dryRun: values["dry-run"] });
    for (const name of doomed) console.log(`${values["dry-run"] ? "Would delete" : "Deleted"} ${join(dir, name)}`);
    console.log(`${doomed.length} ${values["dry-run"] ? "would go" : "deleted"}.`);
    return;
  }
  if (!label) throw new Error("give the backup a label, e.g. backup before-tag-cleanup");
  const made = await createBackup(dataDir, dir, label);
  console.log(`Backed up to ${made.file} (${(made.bytes / 1024 / 1024).toFixed(1)} MB), integrity ok.`);
  for (const file of made.modules) console.log(`With ${file}, integrity ok.`);
  for (const name of made.pruned) console.log(`Deleted ${join(dir, name)}`);
}

if (command === "migrate") {
  try {
    if (args[0] === "friend-map-module") await migrateFriendMap(dataDir, { apply: values.apply ?? false });
    else if (args[0] === "module-data") {
      for (const line of await moveModuleData(dataDir, await installedMoves(), { apply: values.apply ?? false })) console.log(line);
    } else if (args[0] !== undefined) throw new Error("migrate takes nothing, friend-map-module [--apply] or module-data [--apply]");
    else {
      await migrateCommand();
      for (const line of pendingMoveLines(dataDir, await installedMoves())) console.log(line);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
  process.exit();
}

/**
 * `migrate`: every database's schema brought up to date, after a checked backup when one was behind (any other command
 * would do it too, without one): each that moved said, then what each module says its migrations made of its rows.
 */
async function migrateCommand(): Promise<void> {
  const unmoved = unmovedArchive(dataDir);
  if (unmoved) throw new Error(unmoved);
  const files = [
    { name: "core", file: join(dataDir, CORE_FILE), version: CORE_SCHEMA_VERSION },
    { name: "calendar", file: join(dataDir, CALENDAR_FILE), version: CALENDAR_SCHEMA_VERSION },
    ...modules.on.flatMap(({ id, definition: { database } }) =>
      (database ? [{ name: id, file: moduleDatabaseFile(dataDir, id, database), version: database.version ?? database.migrations.length }] : [])),
  ];
  const before = new Map(files.map(({ file }) => [file, versionOf(file)]));
  if (files.some(({ file, version }) => (before.get(file) ?? version) < version)) {
    // A folder with a module's database and no core yet has an empty core made first, so the backup holds every file.
    if (!existsSync(join(dataDir, CORE_FILE))) openCore(join(dataDir, CORE_FILE)).close();
    const made = await createBackup(dataDir, join(dataDir, "backups"), "before migrate");
    console.log(`Backed up to ${made.file}, integrity ok.`);
    for (const file of made.modules) console.log(`With ${file}, integrity ok.`);
  }
  const opened = openModuleStores(modules, dataDir);
  try {
    for (const broken of opened.broken) console.log(`The ${broken.id} module is broken, so its database is as it was: ${broken.problem}`);
    (await Archive.open(dataDir, { stores: opened })).close();
    const moved = files.flatMap(({ name, file }) => {
      const [from, to] = [before.get(file), versionOf(file)];
      return from === to ? [] : [`${name}: schema ${from ?? "none (a new database)"} -> ${to}.`];
    });
    console.log(moved.length ? moved.join("\n") : "Every database was at its code's schema already: nothing to do, so no backup.");
    for (const store of opened.on) if (store.db) for (const line of store.definition.database?.migrated?.(store.db) ?? []) console.log(line);
  } finally {
    closeModuleStores(opened);
  }
}

/** The moves every installed module declares (sdk/server.ts's `moves`), switched on or off: its files are its own either way. */
async function installedMoves(): Promise<PlannedMove[]> {
  const { on, broken } = await loadModules({ all: true });
  for (const module of broken) console.log(`The ${module.id} module is broken, so its files are where they were: ${module.problem}`);
  return planModuleMoves(dataDir, on.map((m) => ({ id: m.id, moves: m.definition.moves })));
}

/** The schema version of the database at `file`, read without opening it for writing; null when there is none. */
function versionOf(file: string): number | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return schemaVersion(db);
  } finally {
    db.close();
  }
}

if (command === "import" && values["dry-run"]) {
  try {
    await dryRun(args);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
  process.exit();
}

/** `import <connector> <source ...> --dry-run`: what the import would do (see dryRun.ts). */
async function dryRun([connector, ...sources]: string[]): Promise<void> {
  if (!connector) throw new Error("name a connector, e.g. import whatsapp-db <folder> --dry-run");
  const result = await dryRunImport(dataDir, connector, sources.map((source) => resolve(source)), { settings: importSettings() }, modules);
  console.log(`A dry run of ${result.source} with ${result.connector}; the archive was only read.`);
  printCounts(result.counts, { chats: isPlatform(result.platform) });
  for (const line of result.said) console.log(line);
}

/** An import's own settings: --settings, with --contacts over it. */
function importSettings(): Record<string, unknown> {
  let settings: Record<string, unknown> = {};
  if (values.settings !== undefined) {
    try {
      settings = JSON.parse(values.settings) as Record<string, unknown>;
    } catch {
      throw new Error(`--settings takes JSON, e.g. '{"only": "calls"}'`);
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error(`--settings takes a JSON object, e.g. '{"only": "calls"}'`);
  }
  return values.contacts ? { ...settings, contacts: resolve(values.contacts) } : settings;
}

// Only reads that show content's shape take the testing data (friend map's timeline and search).
if (values.testing && command !== "timeline" && command !== "search") {
  console.error("--testing is for timeline and search");
  process.exit(1);
}
// --testing runs on a testing folder made afresh with every module's made-up data, and never opens the real one. The
// modules the settings leave on are loaded with the archive, their databases open (server/modules/store.ts), so their
// connectors run, their rows are in the calendar's rebuild and their commands have what they are given.
const folder = values.testing ? await testingFolder() : dataDir;
const stores = openModuleStores(modules, folder);
for (const broken of stores.broken) console.error(`Module ${broken.id} is broken, and left out: ${broken.problem}`);
let archive: Archive;
try {
  archive = await Archive.open(folder, { stores });
} catch (error) {
  console.error((error as Error).message);
  closeModuleStores(stores);
  process.exit(1);
}
try {
  await run(command, args);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  archive.close();
  closeModuleStores(stores);
  if (values.testing) await rm(folder, { recursive: true, force: true });
}

/** A testing folder made afresh in a temporary folder, with every module's made-up data (npm run testing-data's, small). */
async function testingFolder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "life-archive-testing-"));
  const stores = openModuleStores(await loadModules({ all: true }), made);
  try {
    for (const module of stores.on) await module.definition.fixtures?.write(made, { folder: made, ...(module.db ? { db: module.db } : {}) });
  } finally {
    closeModuleStores(stores);
  }
  return made;
}

/** A checked backup before a change, named for it; returns its file name. */
async function backupBefore(action: string): Promise<string> {
  // Two changes in one second would share a name, so the second is numbered.
  for (let n = 1; ; n++) {
    try {
      return basename((await createBackup(folder, join(folder, "backups"), `before ${action}${n > 1 ? ` ${n}` : ""}`)).file);
    } catch (error) {
      if (n < 9 && /already exists/.test((error as Error).message)) continue;
      throw error;
    }
  }
}

async function run(command: string, args: string[]): Promise<void> {
  const { host } = archive;
  const id = (value: string | undefined, what: string) => {
    if (!value || !/^\d+$/.test(value)) throw new Error(`give a ${what} number`);
    return Number(value);
  };
  const handed = moduleCommand(archive.modules, command);
  if (handed) {
    const { commands } = handed.definition;
    return commands!.run(command, args, values, { ...handed.context, backup: backupBefore });
  }
  switch (command) {
    case "import": {
      if (!args[0]) throw new Error("name a connector, e.g. import messenger-export ~/life-archive-data/messages.zip");
      let lastShown = 0;
      const settings = importSettings();
      const result = await archive.importHistory(args[0], args.slice(1).map((source) => resolve(source)), {
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        onProgress: ({ done, total, note }) => {
          if (Date.now() - lastShown < 2000 && done !== total) return;
          lastShown = Date.now();
          process.stderr.write(`  ${done}${total ? ` of ${total}` : ""} ${note ?? ""}\n`);
        },
      });
      console.log(`Imported ${result.source} with ${result.connector}.`);
      if (result.previouslyImportedAt) console.log(`(The same file was imported before, on ${dayKey(result.previouslyImportedAt)}.)`);
      printCounts(result.counts, { chats: isPlatform(result.platform) });
      // What the connector's module says of it (friend map's: the notes filled from an address book, and the people).
      for (const line of result.said) console.log(line);
      return;
    }
    case "connectors": {
      // A live connector runs inside the server, so its state is the server's to tell.
      const running = await serverConnectors();
      for (const c of await host.statuses()) {
        console.log(`${c.id} (${c.platform ?? "?"}): ${c.status}${c.enabled ? "" : ", switched off"}`);
        if (c.companion) console.log(`  needs ${c.companion} running`);
        if (c.capabilities.sync) {
          const live = running?.find((r) => r.id === c.id)?.live;
          console.log(`  live: ${live ? `${live.state}${live.detail ? ` (${live.detail})` : ""}` : running ? "not run by the server" : `the server does not answer at ${serverUrl()}`}`);
        }
        if (c.lastOkAt) console.log(`  last good run ${dayKey(c.lastOkAt)}`);
        if (c.lastError) console.log(`  last error: ${c.lastError}`);
      }
      return;
    }
    case "enable":
    case "disable": {
      if (!args[0]) throw new Error(`name the connector to ${command}`);
      const connector = await host.setEnabled(args[0], command === "enable");
      console.log(`${connector} is ${command === "enable" ? "on" : "off"} (data/connectors/${connector}.json).`);
      return;
    }
    case "calendar": {
      const what = args[0];
      if (what !== undefined && what !== "check" && what !== "rebuild") throw new Error("calendar takes nothing, check or rebuild");
      if (what === "rebuild") {
        const counts = archive.calendar.rebuild();
        for (const [module, made] of Object.entries(counts)) console.log(`${module}: ${countsText(made)}`);
        console.log(`Calendar rebuilt from the archive: ${archive.calendar.sink.count()} rows.`);
        return;
      }
      if (what === "check") {
        const drift = archive.calendar.drift();
        if (values.json) console.log(JSON.stringify(drift, null, 2));
        else {
          for (const row of drift) console.log(`${row.module} ${row.kind} ${row.origin} ${row.nativeId}: ${row.change}`);
          console.log(drift.length === 0 ? "The calendar is what the archive would push: nothing to change." : `${drift.length} ${drift.length === 1 ? "row" : "rows"} a rebuild would change (npm run archive -- calendar rebuild).`);
        }
        if (drift.length > 0) process.exitCode = 1;
        return;
      }
      const summary = archive.calendar.sink.summary();
      if (values.json) console.log(JSON.stringify({ built: archive.calendar.builtAt(), summary }, null, 2));
      else {
        for (const row of summary) console.log(`${row.module} ${row.kind} (${row.shape}): ${row.count}, ${row.firstDay} to ${row.lastDay}`);
        const built = archive.calendar.builtAt();
        console.log(`${archive.calendar.sink.count()} rows; last built whole ${built === null ? "never" : `at ${built}`}.`);
      }
      return;
    }
    case "events": {
      if (values.day === undefined) {
        if (values.kind !== undefined) throw new Error("--kind goes with --day: events --day <YYYY-MM-DD> --kind <kind>");
        const summary = archive.events.summary();
        if (values.json) console.log(JSON.stringify(summary, null, 2));
        else {
          for (const row of summary) console.log(`${row.origin} ${row.kind}: ${row.count}, ${row.firstDay} to ${row.lastDay}`);
          console.log(summary.length === 0 ? "The event index is empty: import a source of it (npm run archive -- import llm-sessions)." : `${summary.reduce((n, row) => n + row.count, 0)} events.`);
        }
        return;
      }
      if (!isDay(values.day)) throw new Error("--day takes a date, YYYY-MM-DD");
      if (values.kind !== undefined && !(EVENT_KINDS as readonly string[]).includes(values.kind)) throw new Error(`--kind is one of ${EVENT_KINDS.join(", ")}`);
      const rows = archive.events.day(values.day, { kind: values.kind });
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else {
        for (const row of rows) console.log(eventLine(row));
        console.log(`${rows.length} ${rows.length === 1 ? "event" : "events"} on ${values.day} (${zonePlace()}).`);
      }
      return;
    }
    case "event-content": {
      const last = values.last === undefined ? undefined : id(values.last, "number of turns, --last");
      let event: number;
      if (values.latest !== undefined) {
        const [origin, how] = values.latest.split("/");
        const latest = latestLlmSession(archive.coreDb, origin, how);
        if (latest === null) throw new Error(`no session of ${values.latest} in the index (its origins: claude-code, grok-bot)`);
        event = latest;
      } else event = id(args[0], "event");
      const read = readLlmContent(archive.coreDb, folder, event);
      if (!read) throw new Error(`no event ${args[0]}`);
      contentRead("event-content", { event, kind: read.kind, latest: values.latest, last });
      const turns = last === undefined ? read.turns : read.turns.slice(-last);
      const shown = { ...read, turns: values.redacted ? turns.map((turn) => ({ ...turn, text: redactText(turn.text) })) : turns };
      if (values.json) console.log(JSON.stringify(shown, null, 2));
      else {
        console.log(`Session #${shown.session.event} in ${homeShort(shown.session.project)}:`);
        for (const turn of shown.turns) {
          const who = turn.role === "prompt" ? "me" : (turn.model ?? "the model");
          const pictures = turn.images > 0 ? ` [${turn.images} ${turn.images === 1 ? "picture" : "pictures"}]` : "";
          console.log(`\n#${turn.event}  ${when(turn.at)}  ${who}${pictures}:\n${turn.text}`);
        }
      }
      return;
    }
    case "mcp":
      return mcpCommand(new McpKeys(archive.coreDb), args, values as { grant?: string[]; agent?: string; last?: string }, Date.now());
    case "edits":
      return editsCommand(tableEditsOf(archive, tabsWith(moduleTabs({ on: archive.modules, off: [], broken: [] }))), args, values, readerFromEnvironment());
    case "content-log": {
      const reads = archive.contentLog.list({ limit: values.limit ? Number(values.limit) : 50 });
      for (const read of reads) console.log(contentReadLine(read));
      console.log(reads.length === 0 ? "No content has been read through timeline, search, event-content, the app's content routes or the viewer." : `${reads.length} shown, the latest first.`);
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${HELP}`);
  }
}

/** Keeps a content read in the trail, before it is printed; the testing data's are no read of content. */
function contentRead(what: string, scope: ReadScope): void {
  if (values.testing) return;
  archive.contentLog.record({ surface: "cli", reader: readerFromEnvironment(), what, scope: { ...scope, redacted: values.redacted }, why: values.why ?? null });
}

/** One row of the trail: when, how often until when, from where and by whom, what and why. */
function contentReadLine(read: ContentReadRow): string {
  const often = read.reads > 1 ? ` (${read.reads} times, to ${when(read.lastAt).slice(-5)})` : "";
  const who = read.surface === "cli" || read.surface === "mcp" ? `${read.surface} ${read.reader ?? "(unnamed)"}` : read.surface;
  const scope = Object.entries(read.scope).map(([key, value]) => {
    for (const module of archive.modules) {
      const words = module.db ? module.definition.describeScope?.(module.db, key, value) : null;
      if (words) return words;
    }
    if (key === "words") return JSON.stringify(value);
    return value === true ? key : `${key} ${value}`;
  });
  return `#${read.id}  ${when(read.at)}${often}  ${who}  ${read.what} ${scope.join(", ")}${read.why ? `: ${read.why}` : ""}`;
}

/**
 * One event of the index: "#42  09:14-09:52  llm_session cli  1.2 MB  in ~/Projects/firstmate, claude-opus-5-5, 12 prompts,
 * 30 replies" (its times local, its size, and its detail: never its content).
 */
function eventLine(event: EventRow): string {
  const time = `${timeOfDay(event.at)}${event.atEnd !== null && event.atEnd !== event.at ? `-${dayKey(event.atEnd) === event.day ? timeOfDay(event.atEnd) : when(event.atEnd)}` : ""}`;
  const size = event.size === null
    ? ""
    : event.kind === "llm_session"
      ? `${(event.size / 1024 / 1024).toFixed(1)} MB`
      : `${event.size.toLocaleString(LOCALE)} characters`;
  const llm = event.llm;
  const detail = llm === null ? [] : [
    event.kind === "llm_session" ? `in ${homeShort(llm.project)}` : `in session #${llm.session}`,
    llm.model,
    llm.prompts !== undefined ? `${llm.prompts} prompts, ${llm.replies} replies` : null,
    llm.images ? `${llm.images} ${llm.images === 1 ? "picture" : "pictures"}` : null,
    llm.toolCalls ? `${llm.toolCalls} tool calls` : null,
    llm.replyTo ? `answers #${llm.replyTo}` : null,
  ].filter(Boolean);
  return `#${event.id}  ${time}  ${event.kind}${event.subkind ? ` ${event.subkind}` : ""}  ${event.origin}  ${size}${detail.length > 0 ? `  ${detail.join(", ")}` : ""}`;
}

/** A path with the home folder as ~. */
function homeShort(path: string): string {
  return path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;
}

function serverUrl(): string {
  return archiveUrl().replace(/\/+$/, "");
}

/** The connectors as the running server reports them, if it answers. */
async function serverConnectors(): Promise<ConnectorStatus[] | null> {
  try {
    const response = await fetch(`${serverUrl()}/api/archive/connectors`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? ((await response.json()) as ConnectorStatus[]) : null;
  } catch {
    return null;
  }
}

/** What an import did: to chats and people for a chat platform's (`chats`), and to the event index for any. */
function printCounts(counts: ImportCounts, { chats }: { chats: boolean }): void {
  for (const [kind, n] of Object.entries(counts.events)) if (n) console.log(`Events, ${kind}: ${n.added} new, ${n.updated} changed, ${n.unchanged} already had.`);
  if (!chats) {
    for (const [name, count] of Object.entries(counts.tallies)) console.log(`  ${name}: ${count}`);
    return;
  }
  const m = counts.messages;
  console.log(`Messages: ${m.added} new (${m.added - m.unsentAdded} usable, ${m.unsentAdded} unsent), ${m.updated} changed, ${m.unchanged} already had, ${m.duplicates} duplicate records collapsed.`);
  if (m.matched > 0) console.log(`  ${m.matched} were already in the archive from another connector, and are kept once.`);
  if (m.edited > 0) console.log(`  ${m.edited} edited since (their earlier text is kept).`);
  console.log(`Accounts: ${counts.accounts.added} new, ${counts.accounts.updated} changed. Chats: ${counts.conversations.added} new, ${counts.conversations.updated} changed.`);
  if (counts.calls.added + counts.calls.updated + counts.calls.unchanged > 0) {
    console.log(`Calls: ${counts.calls.added} new, ${counts.calls.updated} changed, ${counts.calls.unchanged} already had.`);
  }
  console.log(`Reactions: ${counts.reactions.added} new. Attachments: ${counts.attachments.added} new, ${counts.attachments.updated} changed; this source had ${counts.attachments.stored} files and lacked ${counts.attachments.missing}.`);
  for (const [name, count] of Object.entries(counts.tallies)) console.log(`  ${name}: ${count}`);
}
