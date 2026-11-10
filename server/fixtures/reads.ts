// The viewer's reads (server/viewer/tab.ts's Reads) over a core's database a test built by hand, with openCore and the
// core's writer rather than through Archive: the calendar beside it built from it (server/calendar/push.ts's rebuild),
// then both opened read-only as the server opens them (server/viewer/connection.ts); `close` closes the reads and the
// calendar. A module's tests read through sdk/testing.ts's testingLifeArchive instead, its database among the reads.

import { dirname, join } from "node:path";
import { EventIndex } from "../archive/events.ts";
import type { Db } from "../archive/db.ts";
import { CALENDAR_FILE, openCalendar, type CalendarDb } from "../calendar/db.ts";
import { CalendarPush } from "../calendar/push.ts";
import { closeReads, openReads } from "../viewer/connection.ts";
import type { Reads } from "../viewer/tab.ts";

export interface TestReads {
  reads: Reads;
  /** The calendar's pushes over the test's core, for a test that pushes by hand. */
  calendar: CalendarPush;
  close: () => void;
}

/** The reads over the core's database `core` keeps at `coreFile`, its calendar built beside it. */
export function testReads(core: Db, coreFile: string): TestReads {
  const calendarFile = join(dirname(coreFile), CALENDAR_FILE);
  const calendarDb: CalendarDb = openCalendar(calendarFile);
  const calendar = new CalendarPush(core, calendarDb, new EventIndex(core));
  calendar.rebuild();
  const reads = openReads(coreFile, calendarFile);
  return {
    reads,
    calendar,
    close: () => {
      closeReads(reads);
      calendarDb.close();
    },
  };
}
