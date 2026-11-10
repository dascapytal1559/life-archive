// The event sink: how a module's rows get into the calendar (db.ts). A push is an idempotent upsert keyed on the
// module, the origin and the source's own id: a row already there and the same is left alone, one that differs takes
// the new values, one not there is added; so a module can push what it has again whenever it likes (after each
// import, after its people change, or whole, to rebuild) and the calendar settles to what it has. `forget` takes rows
// out (a workout the captain deleted); `replace` is a push and a forget of what the module no longer has, within the
// kinds it names, which the rebuild (push.ts) uses to make the calendar equal the modules.
//
// Each push is one transaction of the calendar's file: the module's own store commits first, then the push, so a
// crash between the two leaves the calendar behind at most, which a later push of the same rows or a rebuild repairs
// (push.ts says which).

import { overwriting, transaction } from "../archive/db.ts";
import type { CalendarDb } from "./db.ts";
import { canonical, keyOf, rowText, type CalendarRow, type RowKey } from "./rows.ts";

/** What a push did. */
export interface PushCounts {
  added: number;
  updated: number;
  unchanged: number;
  forgotten: number;
}

const noCounts = (): PushCounts => ({ added: 0, updated: 0, unchanged: 0, forgotten: 0 });

/** "3 added, 1 updated, 40 unchanged" */
export function countsText(counts: PushCounts): string {
  return [`${counts.added} added`, `${counts.updated} updated`, `${counts.unchanged} unchanged`, ...(counts.forgotten > 0 ? [`${counts.forgotten} forgotten`] : [])].join(", ");
}

/** How many rows of a kind one module has, and the first and last day. */
export interface CalendarSummary {
  module: string;
  kind: string;
  shape: string;
  count: number;
  firstDay: string;
  lastDay: string;
}

/** A row as the event table holds it. */
interface StoredRow {
  id: number;
  module: string;
  origin: string;
  native_id: string;
  shape: CalendarRow["shape"];
  kind: string;
  subkind: string | null;
  at: number;
  at_end: number | null;
  day: string;
  self: number;
  direction: CalendarRow["direction"];
  size: number | null;
  has_content: number;
  people: string;
  facts: string;
  summary: string | null;
}

const COLUMNS = "id, module, origin, native_id, shape, kind, subkind, at, at_end, day, self, direction, size, has_content, people, facts, summary";

/** A stored row as a CalendarRow (its id apart). */
export function rowOf(stored: Omit<StoredRow, "id">): CalendarRow {
  return canonical({
    module: stored.module,
    origin: stored.origin,
    nativeId: stored.native_id,
    shape: stored.shape,
    kind: stored.kind,
    subkind: stored.subkind,
    at: stored.at,
    atEnd: stored.at_end,
    day: stored.day,
    self: stored.self === 1,
    direction: stored.direction,
    size: stored.size,
    hasContent: stored.has_content === 1,
    people: JSON.parse(stored.people) as number[],
    facts: JSON.parse(stored.facts) as CalendarRow["facts"],
    summary: stored.summary === null ? null : (JSON.parse(stored.summary) as CalendarRow["summary"]),
  });
}

export class EventSink {
  private readonly db: CalendarDb;

  constructor(db: CalendarDb) {
    this.db = db;
  }

  /** Puts `module`'s rows in, each added, brought up to date, or left as it is; in one transaction. */
  push(module: string, rows: readonly CalendarRow[]): PushCounts {
    const counts = noCounts();
    if (rows.length === 0) return counts;
    const find = this.db.prepare(`SELECT ${COLUMNS} FROM event WHERE module = ? AND origin = ? AND native_id = ?`);
    const insert = this.db.prepare(
      `INSERT INTO event (module, origin, native_id, shape, kind, subkind, at, at_end, day, self, direction, size, has_content, people, facts, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE event SET shape = ?, kind = ?, subkind = ?, at = ?, at_end = ?, day = ?, self = ?, direction = ?, size = ?, has_content = ?, people = ?,
         facts = ?, summary = ? WHERE id = ?`,
    );
    transaction(this.db, () => {
      for (const given of rows) {
        if (given.module !== module) throw new Error(`a row of ${given.module} was pushed as ${module}'s`);
        const row = canonical(given);
        const values = [
          row.shape, row.kind, row.subkind, row.at, row.atEnd, row.day, row.self ? 1 : 0, row.direction, row.size, row.hasContent ? 1 : 0,
          JSON.stringify(row.people), JSON.stringify(row.facts), row.summary === null ? null : JSON.stringify(row.summary),
        ];
        const existing = find.get(module, row.origin, row.nativeId) as StoredRow | undefined;
        if (!existing) {
          insert.run(module, row.origin, row.nativeId, ...values);
          counts.added++;
        } else if (rowText(rowOf(existing)) === rowText(row)) {
          counts.unchanged++;
        } else {
          update.run(...values, existing.id);
          counts.updated++;
        }
      }
    });
    return counts;
  }

  /**
   * Takes `module`'s rows with these keys out; how many went. `forGood`, for a delete that must leave nothing behind
   * (a workout the captain deleted): their bytes overwritten and the WAL checkpointed (overwriting).
   */
  forget(module: string, keys: readonly Pick<RowKey, "origin" | "nativeId">[], { forGood = false }: { forGood?: boolean } = {}): number {
    if (keys.length === 0) return 0;
    const remove = this.db.prepare("DELETE FROM event WHERE module = ? AND origin = ? AND native_id = ?");
    const removeAll = () => transaction(this.db, () => keys.reduce((n, key) => n + Number(remove.run(module, key.origin, key.nativeId).changes), 0));
    return forGood ? overwriting(this.db, removeAll) : removeAll();
  }

  /**
   * Makes `module`'s rows of `kinds` (every kind of its, when none are named) these and no others: a push, then a forget of
   * what it had of those kinds that is not among them; with `days`, only the day summaries on those days are forgotten.
   */
  replace(module: string, rows: readonly CalendarRow[], { kinds, days }: { kinds?: readonly string[]; days?: readonly string[] } = {}): PushCounts {
    return transaction(this.db, () => {
      const counts = this.push(module, rows);
      const keep = new Set(rows.map(keyOf));
      const had = this.db
        .prepare(
          `SELECT origin, native_id FROM event WHERE module = ?${kinds ? " AND kind IN (SELECT value FROM json_each(?))" : ""}${days ? " AND shape = 'day' AND day IN (SELECT value FROM json_each(?))" : ""}`,
        )
        .all(module, ...(kinds ? [JSON.stringify(kinds)] : []), ...(days ? [JSON.stringify(days)] : [])) as Array<{ origin: string; native_id: string }>;
      const gone = had.filter((row) => !keep.has(keyOf({ module, origin: row.origin, nativeId: row.native_id }))).map((row) => ({ origin: row.origin, nativeId: row.native_id }));
      counts.forgotten = this.forget(module, gone);
      return counts;
    });
  }

  /** `module`'s rows, by origin and id. */
  rowsOf(module: string): CalendarRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM event WHERE module = ? ORDER BY origin, native_id`).all(module) as unknown as StoredRow[]).map(rowOf);
  }

  /** The modules the calendar holds rows of, A to Z. */
  modules(): string[] {
    return (this.db.prepare("SELECT DISTINCT module FROM event ORDER BY module").all() as Array<{ module: string }>).map((row) => row.module);
  }

  /** Each module's kinds, with how many rows and the first and last day. */
  summary(): CalendarSummary[] {
    return this.db
      .prepare("SELECT module, kind, shape, count(*) AS count, min(day) AS firstDay, max(day) AS lastDay FROM event GROUP BY module, kind, shape ORDER BY module, kind")
      .all() as unknown as CalendarSummary[];
  }

  /** How many rows there are in all. */
  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM event").get() as { n: number }).n;
  }
}
