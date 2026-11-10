// The viewer's reads over a friend map archive a test built by hand (openArchive and the module's writer, rather than
// through a whole life archive): the core's database beside it (openCore, its own when the test wrote agents' sessions
// in it), the calendar built from both (the core's rebuild, friend map's rows among it), and everything opened
// read-only as the server opens it, friend map's archive as its tables read it; `close` closes what it opened.

import { dirname, join } from "node:path";
import type { Db } from "../../../sdk/server.ts";
import { CALENDAR_FILE, CalendarPush, closeReads, CORE_FILE, EventIndex, openCalendar, openCore, openReads, type TestReads } from "../../../sdk/testing.ts";
import friendMapModule from "../module.ts";
import { everyRow } from "../server/calendarPush.ts";
import { friendMapOwner } from "../server/calendarRows.ts";

export type { TestReads };

/** The reads over the archive `db` (a file's), and the core's database beside it (`core`, or a new one). */
export function friendMapReads(db: Db, core?: Db): TestReads {
  const file = db.location()!;
  const folder = dirname(file);
  const coreDb = core ?? openCore(join(folder, CORE_FILE));
  const calendarDb = openCalendar(join(folder, CALENDAR_FILE));
  const calendar = new CalendarPush(coreDb, calendarDb, new EventIndex(coreDb), new Map([["friend-map", () => everyRow(db)]]));
  calendar.rebuild();
  const reads = openReads(join(folder, CORE_FILE), join(folder, CALENDAR_FILE), new Map([["friend-map", friendMapOwner(db)]]), new Map([["friend-map", { file, open: friendMapModule.database!.reads }]]));
  return {
    reads,
    calendar,
    close: () => {
      closeReads(reads);
      calendarDb.close();
      if (!core) coreDb.close();
    },
  };
}
