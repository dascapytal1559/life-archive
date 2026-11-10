// The SDK a module's tests import of the core beyond the rest of the SDK (sdk.test.ts holds a module's other files
// off it): a life archive on a folder of the test's own with the module loaded as the server loads it, so a test
// drives the real paths (the host's imports of the module's connectors, the calendar's pushes, the rebuild and the
// drift check, the module's context with its database, the calendar and the live connectors), the viewer's reads over
// it, and what only a test asks of the core (a connector's events checked, a made-up zip, the Events tabs' no filters).
// Never the real archive: a test names a temporary folder, and vitest's settings keep every path off the real one.

import { join } from "node:path";
import type { AnyModuleDefinition } from "./server.ts";
import { Archive } from "../server/archive/index.ts";
import { CORE_FILE } from "../server/archive/coreDb.ts";
import { CALENDAR_FILE } from "../server/calendar/db.ts";
import { closeReads, openReads } from "../server/viewer/connection.ts";
import { moduleEvents, moduleOwners, moduleReads, moduleTabs, type ReadyModule } from "../server/modules/loader.ts";
import { tableEditsOf, type TableEdits } from "../server/edits/edits.ts";
import { tabsWith } from "../server/viewer/tabs.ts";
import { moduleDatabaseFile, openModuleDatabase, type ModuleStores } from "../server/modules/store.ts";
import type { Reads } from "../server/viewer/tab.ts";

/** The archive's clock set by a test (src/time.ts), for one that checks a day or a time under another zone or locale. */
export { setClock } from "../src/time.ts";
export { validateEvent, type ConnectorEvent } from "../server/connectors/contract.ts";
export { writeZip } from "../server/connectors/zip.ts";
export { NO_FILTERS } from "../viewer/wire.ts";
export { openModuleDatabase } from "../server/modules/store.ts";
/** The LLM warehouse's tag rules, run over a test's core (with nothing known of T3 or firstmate), so its LLM tags table has rows. */
export { retag as retagLlm } from "../server/llm/tags.ts";
export { EMPTY_CONTEXT as NO_LLM_CONTEXT } from "../server/llm/context.ts";
/** What the console's page is told as it opens, set by a test of a module's page half (what its `viewerSettings` told it, read through sdk/viewer.ts's moduleSettings). */
export { pageSettings, setPageSettings } from "../viewer/pageSettings.ts";
/** The console's addresses for the Events page (its Calendar) and its Tables, to hold a module's page that links to them to the same addresses. */
export { CALENDAR_PATH, EVENTS_PATH } from "../viewer/console/eventsPaths.ts";

/** A life archive a test opened with a module loaded (testingLifeArchive). */
export interface TestingLifeArchive {
  /** The archive, with its host (the module's connectors among its), its calendar and its live connectors. */
  readonly archive: Archive;
  /** The module as the server has it: what it is given (its database, the calendar, the live connectors). */
  readonly module: ReadyModule;
  /** The viewer's reads over the archive and the calendar, the module's owner among them; closed with the rest. */
  reads(): Reads;
  /** The tables' edits over the archive, as the server makes them (server/edits/): the module's editors, the record, the trail. */
  edits(): TableEdits;
  /** Closes the reads, the archive and the module's database. */
  close(): void;
}

/**
 * Opens a life archive in `dataDir` (a folder of the test's own) with `definition` loaded as the server loads a module:
 * its database opened at modules/<id>/ of the folder (its take-over from the folder's archive, when there is one), its
 * connectors registered with the host, its rows in the calendar's rebuild, and its context built. The folder's archive
 * is made when there is none.
 */
export async function testingLifeArchive(dataDir: string, definition: AnyModuleDefinition): Promise<TestingLifeArchive> {
  const folder = join(dataDir, "modules", definition.id);
  const opened = definition.database ? openModuleDatabase(moduleDatabaseFile(dataDir, definition.id, definition.database), definition.database, { archiveFile: join(dataDir, "archive.sqlite") }) : null;
  const db = opened?.db ?? null;
  const stores: ModuleStores = { on: [{ id: definition.id, folder, definition, db, takenOver: opened?.takenOver ?? false }], off: [], broken: [] };
  let archive: Archive;
  try {
    archive = await Archive.open(dataDir, { stores });
  } catch (error) {
    db?.close();
    throw error;
  }
  const module = archive.modules[0]!;
  let reads: Reads | null = null;
  let edits: TableEdits | null = null;
  return {
    archive,
    module,
    reads: () => (reads ??= openReads(join(dataDir, CORE_FILE), join(dataDir, CALENDAR_FILE), moduleOwners(moduleEvents(archive.modules)), moduleReads({ on: archive.modules, off: [], broken: [] }, dataDir))),
    edits: () => (edits ??= tableEditsOf(archive, tabsWith(moduleTabs({ on: archive.modules, off: [], broken: [] })))),
    close: () => {
      if (reads) closeReads(reads);
      archive.close();
      db?.close();
    },
  };
}

// What friend map's tests (and any module's that serves routes) use of the core's to serve them.
export { aiAnswering, NO_AI, viewerHandler } from "../server/fixtures/routes.ts";
export { AiService, type Ai } from "../server/ai.ts";
export { serve, type ApiHandler } from "../server/jsonApi.ts";
export { fakeNotifier } from "../server/fixtures/notifier.ts";
export { Context } from "effect";
export { ConnectorHost, loadRegistry, type ImportResult } from "../server/connectors/host.ts";
export { openCore } from "../server/archive/coreDb.ts";
export { loadModules, moduleConnectors } from "../server/modules/loader.ts";
export { dryRunImport } from "../server/archive/dryRun.ts";
export { facetsOf, rowsOf, tabOf, tabsWith, volumeOf } from "../server/viewer/tabs.ts";
export type { TableEdits } from "../server/edits/edits.ts";
export { editsHandler } from "../server/fixtures/routes.ts";
export { CalendarPush } from "../server/calendar/push.ts";
export { calendarDays } from "../server/viewer/calendarDays.ts";
export { CALENDAR_FILE } from "../server/calendar/db.ts";
export { coreLedger } from "../server/archive/coreWrite.ts";
export { EVENTS_DAY_BEGINS } from "../src/calendarDay.ts";
export { PROJECT, writeLlmSessionsFixture } from "../server/fixtures/llm-sessions.ts";
export { CORE, rowText } from "../server/calendar/rows.ts";
export { closeReads, openReads } from "../server/viewer/connection.ts";
export { CORE_FILE } from "../server/archive/coreDb.ts";
export { EventIndex } from "../server/archive/events.ts";
export { openCalendar } from "../server/calendar/db.ts";
export { testReads, type TestReads } from "../server/fixtures/reads.ts";
export { archiveServer } from "../server/archive/server.ts";
export { moduleTabs, type Modules } from "../server/modules/loader.ts";
export type { CalendarDaysAnswer } from "../viewer/wire.ts";
export type { LlmTurnEvent } from "../server/connectors/contract.ts";
export { contentHandler } from "../server/fixtures/routes.ts";
export { CONTENT_API, CONVERSATION_PAGE } from "../viewer/wire.ts";
export { SESSIONS, TEXTS } from "../server/fixtures/llm-sessions.ts";
export type { SessionPage } from "../viewer/wire.ts";
export { ConnectorDisabledError, backoffDelay, ImportFailedError } from "../server/connectors/host.ts";
export { MANIFESTS as CORE_MANIFESTS } from "../server/connectors/manifests.ts";
export { createSourcesApi } from "../server/sources/http.ts";
export { cadenceOfPlist, overdueAfterMs, runFacts, runStamp, sourceRows, type HostConnector, type RunFacts, type SourceInputs } from "../server/sources/sources.ts";
export type { SourceRow, SourcesAnswer } from "../viewer/sourcesWire.ts";
export type { Archive } from "../server/archive/index.ts";
export { Changes } from "../server/archive/changes.ts";
export { migrateFriendMap, MOVE_VERSION } from "../server/archive/migrate.ts";
export { unmovedArchive } from "../server/archive/index.ts";
export { RITUAL_KINDS, dropExerciseLegacy, dropRitualsLegacy, exerciseDatabaseFile, exerciseLegacy, exerciseUnheld, ritualsLegacy, ritualsStoreFile, ritualsUnheld } from "../server/archive/legacy.ts";
export { closeModuleStores, openModuleStores } from "../server/modules/store.ts";
export { CodexService, NOT_INSTALLED, NOT_SIGNED_IN, type CodexServiceOptions } from "../server/codex.ts";
