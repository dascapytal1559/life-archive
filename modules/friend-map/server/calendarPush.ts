// When friend map pushes its rows into the core's calendar (calendarRows.ts's rows, through the calendar the core lends
// it, sdk/server.ts's ModuleCalendar):
//
//   afterChats    after a chat platform's import commits, what it touched (write.ts's Touched): every call again when
//                 one came or changed, and the day summaries of the days its messages fell on, those days' stale ones
//                 forgotten
//   afterPeople   after the people rules run: the calls and hangouts again when the people changed since the last time
//                 (the archive's people_version: a name may have made a caller known), and the day summaries whole only
//                 when who is whom changed (friendMapVersion, which a name, a tag or a note leaves alone), so a merge or
//                 a link reaches whom he messaged each day; both kept in this database's meta as they were last pushed,
//                 and nothing pushed when neither changed, which is most rules runs (one after every live batch)
//   afterEdit     after a changeset that touched a table these rows read (FRIEND_MAP_TABLES: a hangout added, a call
//                 given a length, a name, a merge, a dropped group): afterPeople, the calls and hangouts again whatever
//                 the versions say; nothing at the edit for one that touched none (a tag), though one that bumped
//                 people_version (a tag) has the next rules run read them again, changing nothing
//
// Everything again is the core's rebuild, from `rows` (calendarRows.ts's friendMapEvents). A push that fails is said
// in the log and stops nothing: calls and hangouts come back with their next push, which replaces them whole; a day's
// summaries only if a later import touches the day again, and otherwise stay lost until a rebuild.

import { getMeta, setMeta, type CalendarRow, type ModuleCalendar } from "../../../sdk/server.ts";
import { CALL, callRows, DAY_KINDS, FRIEND_MAP_TABLES, friendMapVersion, HANGOUT_KIND, hangoutRows, messageDayRows } from "./calendarRows.ts";
import type { Db } from "./db.ts";
import type { Touched } from "./write.ts";

/** What the archive keeps, in its meta, of what it last pushed. */
const PUSHED_FRIEND_MAP_VERSION = "calendar_friend_map_version";
const PUSHED_PEOPLE_VERSION = "calendar_people_version";

export class FriendMapPush {
  private readonly db: Db;
  private readonly calendar: ModuleCalendar;

  constructor(db: Db, calendar: ModuleCalendar) {
    this.db = db;
    this.calendar = calendar;
  }

  /** What a chat platform's import touched, pushed: every call when one changed, and the day summaries of its days. */
  afterChats(touched: Touched): void {
    safely("after an import", () => {
      if (touched.calls) this.calendar.replace(callRows(this.db), { kinds: [CALL] });
      if (touched.days.length > 0) this.calendar.replace(messageDayRows(this.db, touched.days), { kinds: DAY_KINDS, days: touched.days });
    });
  }

  /**
   * The rows again after the people rules ran or an edit was made: the calls and hangouts (with `force`, an edit's,
   * always; after the rules only when the people changed), and the day summaries whole only when who is whom changed
   * since they were last pushed.
   */
  afterPeople({ force = false }: { force?: boolean } = {}): void {
    safely("after the people rules", () => {
      const version = friendMapVersion(this.db);
      const people = getMeta(this.db, "people_version") ?? "0";
      const whoChanged = version !== getMeta(this.db, PUSHED_FRIEND_MAP_VERSION);
      if (!force && !whoChanged && people === getMeta(this.db, PUSHED_PEOPLE_VERSION)) return;
      this.calendar.replace(callRows(this.db), { kinds: [CALL] });
      this.calendar.replace(hangoutRows(this.db), { kinds: [HANGOUT_KIND] });
      setMeta(this.db, PUSHED_PEOPLE_VERSION, people);
      if (whoChanged) {
        this.calendar.replace(messageDayRows(this.db), { kinds: DAY_KINDS });
        setMeta(this.db, PUSHED_FRIEND_MAP_VERSION, version);
      }
    });
  }

  /** The rows again after a changeset that changed `tables`, when any of them is one they read. */
  afterEdit(tables: readonly string[]): void {
    if (tables.some((table) => FRIEND_MAP_TABLES.includes(table))) this.afterPeople({ force: true });
  }
}

/** Every row friend map would push now: its calls, its hangouts and its day summaries, for the core's rebuild and drift check. */
export const everyRow = (db: Db): CalendarRow[] => [...callRows(db), ...hangoutRows(db), ...messageDayRows(db)];

/** A push that fails is said, and stops nothing: a later push of the same rows or a rebuild repairs it. */
function safely(when: string, push: () => void): void {
  try {
    push();
  } catch (error) {
    console.error(`The calendar could not be pushed ${when}:`, (error as Error).message);
  }
}
