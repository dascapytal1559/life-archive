// The life archive's core as one object, for an archive's folder:
//
//   core.sqlite               the core's own database (coreDb.ts): the event index of the conversations with agents,
//                             the core's connectors' runs and the live bridges' lock
//   calendar.sqlite           the calendar (server/calendar/db.ts): the core's index of what happened, which the core
//                             and the modules push into (server/calendar/push.ts) and the Events pages read, and the
//                             trail of content reads; built from them when new
//   platform-exports/         every platform's exports, whose media stay in place, and live media by content hash
//   connectors/<id>.json      each connector's on/off switch and settings
//   modules/<id>/             each module's own files, its database among them (server/modules/store.ts), which the
//                             caller opens before the archive and hands it (`stores`): the host runs the modules'
//                             connectors into them, and the calendar is rebuilt from them with the core's index
//                             (friend map's people, chats, calls and hangouts are modules/friend-map/archive.sqlite)
//
// The server keeps one open (OpenArchive, closed as the server stops).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, type Scope } from "effect";
import type { ModuleCalendar, ModuleLive } from "../../sdk/server.ts";
import { ConnectorHost, loadRegistry, type ImportResult, type LiveOptions } from "../connectors/host.ts";
import { CALENDAR_FILE, openCalendar, type CalendarDb } from "../calendar/db.ts";
import { CalendarPush } from "../calendar/push.ts";
import type { CalendarRow } from "../calendar/rows.ts";
import { EventSink } from "../calendar/sink.ts";
import { moduleConnectors, moduleEvents, moduleLedgers, moduleRows, readyModules, type ReadyModule } from "../modules/loader.ts";
import { NO_MODULES, type ModuleStores } from "../modules/store.ts";
import { CORE_FILE, CORE_PARTIAL, openCore } from "./coreDb.ts";
import { ContentLog } from "./contentLog.ts";
import type { Db } from "./db.ts";
import { EventIndex } from "./events.ts";

/** The live bridges' lock's timings (see connectors/liveLock.ts); for tests. */
type LiveTimings = Pick<LiveOptions, "checkEveryMs" | "heartbeatEveryMs" | "staleAfterMs">;

export class Archive {
  /** The core's own database (coreDb.ts), open beside the calendar and closed with it: the event index. */
  readonly coreDb: Db;
  /** The calendar's file (server/calendar/db.ts), open beside the core's database and closed with it. */
  readonly calendarDb: CalendarDb;
  /** The calendar's pushes and rebuild (server/calendar/push.ts): what the core and the modules push into it, and when. */
  readonly calendar: CalendarPush;
  /** The trail of content reads, which the content commands and routes write (contentLog.ts). */
  readonly contentLog: ContentLog;
  /** The life archive's event index: structure only (events.ts). */
  readonly events: EventIndex;
  readonly host: ConnectorHost;
  /** The modules loaded with the archive, each with what it is given (its store, the calendar, the live connectors). */
  readonly modules: readonly ReadyModule[];

  private constructor(coreDb: Db, calendarDb: CalendarDb, sink: EventSink, host: ConnectorHost, contentLog: ContentLog, modules: readonly ReadyModule[], rows: ReadonlyMap<string, () => CalendarRow[]>, off: ReadonlySet<string>) {
    this.coreDb = coreDb;
    this.calendarDb = calendarDb;
    this.events = new EventIndex(coreDb);
    this.calendar = new CalendarPush(coreDb, calendarDb, this.events, rows, off, sink);
    this.modules = modules;
    this.host = host;
    this.contentLog = contentLog;
  }

  /** A push to the calendar that fails (a bug, or a write held past its ten seconds) is said, and stops nothing: a later push of the same rows or a rebuild repairs it (calendar/push.ts says which). */
  pushCalendar(when: string, push: () => void): void {
    pushSafely(when, push);
  }

  /** Starts the sync connectors (see connectors/sync.ts) for the server, each module told as this process takes them on. */
  startLive(log?: (line: string) => void, lock: LiveTimings = {}): void {
    this.host.startLive({
      ...lock,
      log,
      // Only once this process runs the live bridges: a send still going out from another process is not unfinished (friend map's).
      onOwn: () => {
        for (const module of this.modules) if (module.db) module.definition.connectors?.live?.onOwn?.(module.db);
      },
    });
  }

  /** Stops the sync connectors, and what each module does after their batches (friend map's rules). */
  async stopLive(): Promise<void> {
    await Promise.all(this.modules.map((module) => (module.db ? module.definition.connectors?.live?.stop?.(module.db) : undefined)));
    await this.host.stopLive();
  }

  /**
   * Opens the core in the archive's folder `dataDir`: its database and the calendar. A calendar not yet built (a new
   * one: a testing folder, or the first start after it came) is built now, whole, and says so on stderr, which the
   * server's log takes. `stores` are the modules the caller loaded and opened (server/modules/store.ts; none unless
   * given): the host runs their connectors, the calendar is rebuilt from their rows with the core's, and each is
   * handed the calendar, the host and the trail (sdk/server.ts's ModuleLive).
   */
  static async open(dataDir: string, { stores = NO_MODULES }: { stores?: ModuleStores } = {}): Promise<Archive> {
    const unmoved = unmovedArchive(dataDir);
    if (unmoved) throw new Error(unmoved);
    const coreDb = openCore(join(dataDir, CORE_FILE));
    let calendarDb: CalendarDb | null = null;
    try {
      calendarDb = openCalendar(join(dataDir, CALENDAR_FILE));
      const sink = new EventSink(calendarDb);
      const contentLog = new ContentLog(calendarDb);
      let archive: Archive | null = null;
      const host = new ConnectorHost({
        db: coreDb, dataDir, registry: [...(await loadRegistry()), ...moduleConnectors(stores)],
        ledgers: moduleLedgers(stores, (module, rows) => pushSafely(`after ${module}'s import`, () => sink.push(module, rows))),
        afterApply: (events) => pushSafely("after an import", () => archive!.calendar.afterIndex(events)),
      });
      const lend = (id: string): ModuleLive => ({
        calendar: moduleCalendar(sink, id),
        pausingLive: (platforms, work) => host.pausingLive(platforms, work),
        host,
        contentLog,
      });
      const modules = readyModules(stores, dataDir, lend);
      const events = moduleEvents(modules);
      archive = new Archive(coreDb, calendarDb, sink, host, contentLog, modules, moduleRows(events), new Set([...stores.off, ...stores.broken].map((module) => module.id)));
      if (!archive.calendar.isBuilt()) {
        console.error("Building the calendar from the archive (a new calendar)…");
        archive.calendar.rebuild();
      }
      // The rows a module just took over from the archive are pushed whole, through the sink: what the core pushed for it before is replaced row for row.
      for (const store of stores.on) {
        const own = events.get(store.id);
        if (store.takenOver && own) pushSafely(`after ${store.id} took its rows over`, () => sink.replace(store.id, own.rows()));
      }
      return archive;
    } catch (error) {
      calendarDb?.close();
      coreDb.close();
      throw error;
    }
  }

  /**
   * Imports with a connector, then lets the connector's module do what it does after one (friend map's people rules,
   * and the notes filled from an address book): the result, and the lines the module says of it.
   */
  async importHistory(...args: Parameters<ConnectorHost["importHistory"]>): Promise<ImportResult & { said: readonly string[] }> {
    const result = await this.host.importHistory(...args);
    const owner = this.modules.find((module) => module.definition.connectors?.connectors.some((c) => c.manifest.id === result.connector));
    const said = (owner?.db && (await owner.definition.connectors?.afterImport?.(result, args[2]?.settings ?? {}, owner.db))) || [];
    return { ...result, said };
  }

  close(): void {
    for (const module of this.modules) if (module.db) void module.definition.connectors?.live?.stop?.(module.db);
    this.calendarDb.close();
    this.coreDb.close();
  }
}

/**
 * Why the archive's folder `dataDir` cannot be opened yet, or null: an archive.sqlite still at its root, from before
 * friend map was a module, is moved into modules/friend-map/ (and the core's tables out of it) once, by
 * `npm run archive -- migrate friend-map-module` with the server stopped (migrate.ts); until then nothing opens it,
 * so a new empty core never stands in beside it. Nor while a move that was interrupted left the core it built at
 * core.sqlite.partial (CORE_PARTIAL): running it again finishes it.
 */
export function unmovedArchive(dataDir: string): string | null {
  if (existsSync(join(dataDir, CORE_PARTIAL))) {
    return `the move of friend map's archive into its module was interrupted (the core's database is still at ${join(dataDir, CORE_PARTIAL)}): stop the server, then npm run archive -- migrate friend-map-module --apply finishes it`;
  }
  if (!existsSync(join(dataDir, "archive.sqlite"))) return null;
  return `the archive at ${join(dataDir, "archive.sqlite")} is from before friend map was a module: stop the server, then npm run archive -- migrate friend-map-module (a dry run; --apply to move it)`;
}

/** A push to the calendar that fails is said, and stops nothing: a later push of the same rows or a rebuild repairs it. */
function pushSafely(when: string, push: () => void): void {
  try {
    push();
  } catch (error) {
    console.error(`The calendar could not be pushed ${when}:`, (error as Error).message);
  }
}

/** The calendar as a module reaches it (sdk/server.ts's ModuleCalendar): the sink, its module id bound. */
export function moduleCalendar(sink: EventSink, module: string): ModuleCalendar {
  return {
    push: (rows) => sink.push(module, rows),
    replace: (rows, scope) => sink.replace(module, rows, scope),
    forget: (keys) => sink.forget(module, keys, { forGood: true }),
  };
}

/**
 * The archive the server keeps open (server/serverLayer.ts), or why it could not be opened: its routes then answer
 * 503 and the pages say so. Opened as the server starts, and closed as it stops, after everything that uses it.
 */
export class OpenArchive extends Context.Service<OpenArchive, { readonly archive: Archive | Error }>()("life-archive/OpenArchive") {
  /**
   * The archive in `dataDir` for as long as the scope lasts. A missing folder is never made: an archive started there
   * would stand in for the real one, moved or not yet in place.
   */
  static readonly open = (dataDir: string, options: { stores?: ModuleStores } = {}): Effect.Effect<OpenArchive["Service"], never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        try {
          if (!existsSync(dataDir)) throw new Error(`there is no archive's folder at ${dataDir}`);
          return { archive: await Archive.open(dataDir, options) };
        } catch (error) {
          return { archive: error instanceof Error ? error : new Error(String(error)) };
        }
      }),
      ({ archive }) =>
        Effect.sync(() => {
          if (!(archive instanceof Error)) archive.close();
        }),
    );
}
