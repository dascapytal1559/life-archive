// The viewer's own connections, read-only, for its routes (http.ts; tab.ts's Reads):
//
//   core      the core's database (archive/coreDb.ts), read-only and query_only: the event index's sessions, for
//             the core's owner's answers (server/calendar/owners.ts)
//   calendar  the calendar (server/calendar/db.ts), read-only and query_only, for the tabs of events (calls, hangouts,
//             LLM, workouts, rituals) and the calendar's day summaries; it holds no content
//   modules   each module's database the viewer's tables read (sdk/server.ts's ModuleDatabase `reads`: friend map's
//             archive for its Messages and People tables, as its SQL runner opens it, unable to read content), by id
//
// Each has one function more for the tabs' queries:
//   wall_clock(day, time)  the instant the archive's clocks read `time` (HH:MM, or NULL for midnight) on `day`
//                          (YYYY-MM-DD), in ms: when a hangout began, which the archive keeps as a date and a time
//
// They are the viewer's alone, so the Query bar's SQL and Generate's model are told of no function they do not have.

import { join } from "node:path";
import { CORE_FILE } from "../archive/coreDb.ts";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, type Scope } from "effect";
import type { Archive } from "../archive/index.ts";
import { CALENDAR_FILE } from "../calendar/db.ts";
import { coreOwners, type Owners } from "../calendar/owners.ts";
import { isDay, wallClock } from "../../src/time.ts";
import type { Reads } from "./tab.ts";

/** The function the tabs' queries use beyond SQLite's own, on both connections. */
function withFunctions(db: DatabaseSync): void {
  db.function("wall_clock", { deterministic: true }, (day, time) => {
    if (typeof day !== "string" || !isDay(day)) return null;
    return wallClock(day, typeof time === "string" && /^\d{2}:\d{2}$/.test(time) ? time : "00:00");
  });
}

/** `db` with the functions the tabs' queries use (wall_clock): a module's read-only connection (sdk/server.ts's viewerReads). */
export function viewerReads(db: DatabaseSync): DatabaseSync {
  withFunctions(db);
  return db;
}

/** The calendar (or the core's database), read-only: neither holds content, so no authorizer; nothing of the viewer's writes them. */
export function openCalendarReads(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  db.exec("PRAGMA query_only = ON");
  withFunctions(db);
  return db;
}

/** How the viewer opens a module's database for its tables: its file, and its own opener (ModuleDatabase's `reads`) when it has one. */
export interface ModuleReads {
  readonly file: string;
  readonly open?: (file: string) => DatabaseSync;
}

/**
 * The viewer's reads over the core's database at `coreFile`, the calendar at `calendarFile` and each module's database
 * its tables read (`databases`, by id), and the owners of the calendar's rows: the core's over the core's connection,
 * and `owners`', the hooks the loaded modules declare (server/modules/loader.ts's moduleOwners), a module's own
 * answering for its id.
 */
export function openReads(coreFile: string, calendarFile: string, owners: Owners = new Map(), databases: ReadonlyMap<string, ModuleReads> = new Map()): Reads {
  const opened: DatabaseSync[] = [];
  try {
    const core = openCalendarReads(coreFile);
    opened.push(core);
    const calendar = openCalendarReads(calendarFile);
    opened.push(calendar);
    const modules = new Map<string, DatabaseSync>();
    for (const [id, { file, open }] of databases) {
      const db = open ? open(file) : openCalendarReads(file);
      opened.push(db);
      modules.set(id, viewerReads(db));
    }
    return { core, calendar, modules, owners: new Map([...coreOwners(core), ...owners]) };
  } catch (error) {
    for (const db of opened) db.close();
    throw error;
  }
}

export function closeReads(reads: Reads): void {
  reads.calendar.close();
  reads.core.close();
  for (const db of reads.modules.values()) db.close();
}

/**
 * The server's viewer connections (server/serverLayer.ts): opened at the first request once the archive is (so its
 * schema is up to date and its calendar built), kept open, and closed as the server stops, before the archive.
 */
export class ViewerDb extends Context.Service<ViewerDb, { readonly reads: () => Reads | Error }>()("life-archive/ViewerDb") {
  /** The reads over the core's database, the calendar and the modules' databases in `dataDir`, with the modules' owners, for as long as the scope lasts; the archive's error while it is not open. */
  static readonly open = (archive: Archive | Error, dataDir: string, owners: Owners = new Map(), databases: ReadonlyMap<string, ModuleReads> = new Map()): Effect.Effect<ViewerDb["Service"], never, Scope.Scope> =>
    Effect.suspend(() => {
      let reads: Reads | null = null;
      return Effect.acquireRelease(
        Effect.sync(() => ({
          reads: (): Reads | Error => {
            if (archive instanceof Error) return archive;
            try {
              return (reads ??= openReads(join(dataDir, CORE_FILE), join(dataDir, CALENDAR_FILE), owners, databases));
            } catch (error) {
              return error instanceof Error ? error : new Error(String(error));
            }
          },
        })),
        () => Effect.sync(() => reads && closeReads(reads)),
      );
    });
}
