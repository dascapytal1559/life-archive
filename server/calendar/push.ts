// When and what the core pushes into the calendar (sink.ts), and the rebuild that proves the pushes right:
//
//   afterIndex    after a core connector's import commits (connectors/host.ts, connectors/sync.ts): the index events
//                 it added or changed (archive/coreWrite.ts), pushed afresh (eventIndex.ts)
//   rebuild       everything again, from the stores: the core's index, and each module's through its `rows`
//                 (sdk/server.ts's ModuleEvents: friend map's calls, hangouts and day summaries, exercise's workouts,
//                 rituals' habits): what the calendar would hold had every push been made, made so (replace), and
//                 `built` kept in meta; the server does it once, when the calendar is new. One write transaction from
//                 before its read of the stores to its last write, so what another process pushes meanwhile waits and
//                 lands on top rather than being undone, if the rebuild ends within the ten seconds a write waits
//                 (openCalendar's timeout; the waiting process's one thread is held till then); past them the push
//                 fails, as below
//   drift         what a rebuild would add, change or forget: none when the pushes have kept the calendar right, which
//                 calendar.test.ts holds after imports, edits, merges and an undo, and `npm run archive -- calendar
//                 check` reads on the real one. A module switched off or broken (`off`) is left out of both: its rows
//                 stay as they were, out of sight without its tabs, until it is on again
//
// A module pushes its own rows as its store changes (friend map's after an import, the people rules or an edit:
// modules/friend-map/server/calendarPush.ts; rituals' as its store does), through the calendar the core lends it
// (sdk/server.ts's ModuleCalendar). A push that fails (a bug, or a write held past its ten seconds) is said in the log
// and never stops an import; an index event comes back only if a later import touches it again, and otherwise stays
// lost until a rebuild (`calendar check` shows it).

import { transaction, type Db } from "../archive/db.ts";
import type { EventIndex } from "../archive/events.ts";
import { getCalendarMeta, setCalendarMeta, type CalendarDb } from "./db.ts";
import { INDEX_MODULES, indexRows } from "./eventIndex.ts";
import { keyOf, rowText, type CalendarRow } from "./rows.ts";
import { EventSink, type PushCounts } from "./sink.ts";

/** What the calendar keeps of its pushers, in meta. */
const BUILT = "built";

/** A row a rebuild would add (missing from the calendar), change (differs) or forget (extra): the calendar's drift from the modules. */
export interface Drift {
  module: string;
  origin: string;
  nativeId: string;
  kind: string;
  change: "missing" | "differs" | "extra";
}

export class CalendarPush {
  readonly sink: EventSink;
  /** The core's database (archive/coreDb.ts), whose event index the index rows are read from. */
  private readonly core: Db;
  private readonly calendar: CalendarDb;
  private readonly index: EventIndex;
  /** What each module with a store of its own would push now, by module id (server/modules/loader.ts's moduleRows). */
  private readonly modules: ReadonlyMap<string, () => CalendarRow[]>;
  /**
   * The modules switched off (settings.json's `modules`) or broken (server/modules/loader.ts), whose store nothing can
   * ask: their rows stay in the calendar as they were, out of sight without their tabs, neither drift nor a rebuild's to
   * change, and their pushes go on from there when they are on again. A module the archive knows nothing of (its folder
   * gone) is drift, as any row is.
   */
  private readonly off: ReadonlySet<string>;

  /** `sink`: the one the modules push through too (the archive's), so every push is one sink's. */
  constructor(core: Db, calendar: CalendarDb, index: EventIndex, modules: ReadonlyMap<string, () => CalendarRow[]> = new Map(), off: ReadonlySet<string> = new Set(), sink = new EventSink(calendar)) {
    this.core = core;
    this.calendar = calendar;
    this.index = index;
    this.modules = modules;
    this.off = off;
    this.sink = sink;
  }

  /** Whether the calendar has been built from the stores: a new one has not, and the server builds it as it starts. */
  isBuilt(): boolean {
    return getCalendarMeta(this.calendar, BUILT) !== null;
  }

  /** When the calendar was last built whole, or null. */
  builtAt(): string | null {
    return getCalendarMeta(this.calendar, BUILT);
  }

  /** The index events a core connector's import added or changed, pushed. */
  afterIndex(events: readonly number[]): void {
    if (events.length === 0) return;
    for (const [module, rows] of byModule(indexRows(this.core, this.index, events))) this.sink.push(module, rows);
  }

  /** What the calendar would hold had every push been made: the core's index rows, and each module's from its store now. */
  expected(): Map<string, CalendarRow[]> {
    const rows = new Map<string, CalendarRow[]>();
    for (const module of INDEX_MODULES) rows.set(module, []);
    for (const [module, of] of byModule(indexRows(this.core, this.index))) rows.set(module, of);
    for (const [module, of] of this.modules) rows.set(module, of());
    return rows;
  }

  /** Everything again, from the stores: each module's rows made so, and `built` kept. What each push did, by module. */
  rebuild(): Record<string, PushCounts> {
    return transaction(this.calendar, () => {
      const counts: Record<string, PushCounts> = {};
      for (const [module, rows] of this.expected()) counts[module] = this.sink.replace(module, rows);
      setCalendarMeta(this.calendar, BUILT, new Date().toISOString());
      return counts;
    });
  }

  /** What a rebuild would change: none when the pushes have kept the calendar what the stores hold. A module switched off or broken is left out. */
  drift(): Drift[] {
    const drift: Drift[] = [];
    const expected = this.expected();
    for (const module of new Set([...expected.keys(), ...this.sink.modules()])) {
      if (this.off.has(module)) continue;
      const stored = new Map(this.sink.rowsOf(module).map((row) => [keyOf(row), row]));
      const wanted = new Map((expected.get(module) ?? []).map((row) => [keyOf(row), row]));
      for (const [key, row] of wanted) {
        const have = stored.get(key);
        if (!have) drift.push({ module, origin: row.origin, nativeId: row.nativeId, kind: row.kind, change: "missing" });
        else if (rowText(have) !== rowText(row)) drift.push({ module, origin: row.origin, nativeId: row.nativeId, kind: row.kind, change: "differs" });
      }
      for (const [key, row] of stored) if (!wanted.has(key)) drift.push({ module, origin: row.origin, nativeId: row.nativeId, kind: row.kind, change: "extra" });
    }
    return drift;
  }
}

/** Rows by their module, in the modules' first-seen order. */
function byModule(rows: readonly CalendarRow[]): Map<string, CalendarRow[]> {
  const grouped = new Map<string, CalendarRow[]>();
  for (const row of rows) {
    const rowsOf = grouped.get(row.module);
    if (rowsOf) rowsOf.push(row);
    else grouped.set(row.module, [row]);
  }
  return grouped;
}
