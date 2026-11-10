// A tab whose rows are one SELECT over the calendar (its source; server/calendar/db.ts's event table), or over the core's
// database for the LLM warehouse's tables (`over`), small enough to be filtered, counted and paged as a whole each time:
// Calls, Hangouts, LLM, Workouts and Rituals, and Prompts, Agent sessions and LLM tags. Each filter is a
// SQL expression over the source's columns, its values always bound as parameters; each measure an aggregate over a
// bucket's rows; each sortable column an expression to order by. The people a row names are the owning module's ids,
// named by its owner (server/calendar/owners.ts), and a row's drawer is its source row, drawn as the table draws it,
// with what the owner adds (what else it knows of the row, and the other tabs narrowed to it).

import type { SQLInputValue } from "node:sqlite";
import { ownerOf } from "../calendar/owners.ts";
import { NotFoundError } from "../errors.ts";
import { MIDNIGHT } from "../../src/time.ts";
import type { FacetValue, Filters, KindSpec, Row, RowDetail, RowsAnswer, VolumeAnswer } from "../../viewer/wire.ts";
import { chartBuckets, edgesJson, MOST_FACET_VALUES, peopleOf, volumeAnswer, type Page, type Reads, type Tab, type VolumeAsk } from "./tab.ts";

/** A day, ms: more than any day's beginning is from its midnight. */
const DAY_MS = 86_400_000;

/** A source row as SQLite gives it. */
export type SourceRow = Record<string, string | number | null>;

/** A filter of one or more values: `expr` (over the source's columns) is one of them. */
export interface ChoiceFilter {
  key: string;
  label: string;
  kind: "choice";
  expr: string;
  /** What a value is called on the page. */
  name: (value: string) => string;
  /** What a value is called, over the source's columns, for values whose name the calendar holds (a session's); its menu then uses it over `name`. */
  labelExpr?: string;
  /** Its values in the order a chart split by it stacks and colours them (others after, the biggest first). */
  order?: readonly string[];
}

/** A filter for one person: `ids` (over the source's columns) is a JSON array of the person ids a row names. */
export interface PersonFilter {
  key: string;
  label: string;
  kind: "person";
  ids: string;
  find?: string;
}

export interface Measure {
  key: string;
  label: string;
  unit: "count" | "minutes" | "characters";
  /** An aggregate over the bucket's rows, each as `r`: count(r.id), say. */
  expr: string;
}

export interface SourceTabDef extends Omit<KindSpec, "filters" | "measures"> {
  /** The module that owns its rows (server/calendar/owners.ts): it names the people they name, and adds to a row's drawer. */
  module: string;
  /**
   * One SELECT over the calendar's event table whose rows are the tab's: each with the row's `id`, `origin`,
   * `native_id` and `kind`, its time `at` (ms), and the columns `row` reads.
   */
  source: string;
  filters: Array<ChoiceFilter | PersonFilter>;
  measures: Measure[];
  /** What each sortable column sorts by, over the source's columns. */
  sorts: Record<string, string>;
  /** The row the page draws, from a row of the source. */
  row: (raw: SourceRow) => Row;
  /**
   * For rows kept as a date alone (their `at` that date's midnight): which they are (`when`, SQL over the source's
   * columns) and their date's column (`day`), so a chart whose days begin later than midnight (VolumeAsk's begins)
   * counts each on its own date, not on the day before.
   */
  undated?: { when: string; day: string };
  /**
   * The database its source is over: the calendar (the default), or the core's (the LLM warehouse's tables, whose rows
   * the calendar does not hold). Neither holds content.
   */
  over?: "calendar" | "core";
}

interface Where {
  sql: string;
  params: SQLInputValue[];
}

/** The tab `def` defines. */
export function sourceTab(def: SourceTabDef): Tab {
  const dbOf = (reads: Reads) => (def.over === "core" ? reads.core : reads.calendar);
  const spec: KindSpec = {
    kind: def.kind,
    label: def.label,
    noun: def.noun,
    columns: def.columns,
    filters: def.filters.map((f) => ({ key: f.key, label: f.label, kind: f.kind, ...(f.kind === "person" && f.find ? { find: f.find } : {}) })),
    measures: def.measures.map(({ key, label, unit }) => ({ key, label, unit })),
    sort: def.sort,
    splits: def.splits,
    ...(def.edits ? { edits: def.edits } : {}),
    ...(def.own ? { own: def.own } : {}),
  };

  /** The WHERE clause `filters` make over the source (the filter keyed `except` left out, for its own facet). */
  const whereOf = (filters: Filters, except?: string): Where => {
    const parts: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters.from !== null) {
      parts.push("at >= ?");
      params.push(filters.from);
    }
    if (filters.to !== null) {
      parts.push("at < ?");
      params.push(filters.to);
    }
    for (const filter of def.filters) {
      if (filter.key === except) continue;
      if (filter.kind === "choice") {
        const values = filters.choices[filter.key];
        if (!values?.length) continue;
        parts.push(`${filter.expr} IN (${values.map(() => "?").join(", ")})`);
        params.push(...values);
      } else if (filters.person !== null) {
        parts.push(`EXISTS (SELECT 1 FROM json_each(${filter.ids}) WHERE value = ?)`);
        params.push(filters.person);
      }
    }
    return { sql: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "", params };
  };

  /** The source's rows `where` leaves. */
  const filtered = (where: Where) => `SELECT * FROM (${def.source}) ${where.sql}`;

  const choice = (key: string) => def.filters.find((f): f is ChoiceFilter => f.kind === "choice" && f.key === key)!;

  /** The row the page draws of `raw`, with its time (the Calendar places it by it). */
  const rowOf = (raw: SourceRow): Row => ({ ...def.row(raw), at: Number(raw.at) });

  /** The names of the people `ids`, as the owning module gives them; one it does not name is called by their number. */
  const names = (reads: Reads, ids: number[]): Record<number, string> => {
    if (ids.length === 0) return {};
    const named = ownerOf(reads.owners, def.module).labelPeople(ids);
    return Object.fromEntries(ids.map((id) => [id, named[id] ?? `Person ${id}`]));
  };

  return {
    spec,

    rows(reads: Reads, filters: Filters, page: Page): RowsAnswer {
      const db = dbOf(reads);
      const where = whereOf(filters);
      const direction = page.direction === "asc" ? "ASC" : "DESC";
      const { total } = db.prepare(`SELECT count(*) AS total FROM (${filtered(where)})`).get(...where.params) as { total: number };
      const raws = db
        .prepare(`${filtered(where)} ORDER BY ${def.sorts[page.sort]} ${direction} NULLS LAST, id ${direction} LIMIT ? OFFSET ?`)
        .all(...where.params, page.limit, page.offset) as SourceRow[];
      const rows = raws.map(rowOf);
      return { total, offset: page.offset, rows, people: names(reads, peopleOf(rows)), next: null };
    },

    /**
     * The measure of the rows `filters` leave in each bucket, over the filters' time range, or from the first row to the
     * last; split, of each value of the split's filter. Counted in one statement: the buckets' edges joined to the rows.
     */
    volume(reads: Reads, filters: Filters, ask: VolumeAsk): VolumeAnswer {
      const db = dbOf(reads);
      const measure = def.measures.find((m) => m.key === ask.measure)!;
      const where = whereOf(filters);
      const extent = db.prepare(`SELECT min(at) AS first, max(at) AS last FROM (${filtered(where)})`).get(...where.params) as { first: number | null; last: number | null };
      const chosen = chartBuckets(filters, extent, ask.grain, ask.begins);
      if (chosen === null) return volumeAnswer(ask, null, () => 0);
      const split = ask.split === null ? null : choice(ask.split);
      // Days that begin later than midnight count a dated row at its date's beginning, read from a day earlier so the
      // first date's rows (at its midnight, before the range) are among them; the buckets keep each to its own.
      const begins = ask.begins ?? MIDNIGHT;
      const undated = begins !== MIDNIGHT ? def.undated : undefined;
      const read = undated && filters.from !== null ? whereOf({ ...filters, from: filters.from - DAY_MS }) : where;
      const at = undated ? `CASE WHEN ${undated.when} THEN wall_clock(${undated.day}, ?) ELSE at END` : "at";
      const rows = db
        // The rows worked out once (MATERIALIZED), not again for each bucket.
        .prepare(`WITH b AS (SELECT CAST(key AS INTEGER) AS i, value ->> 0 AS lo, value ->> 1 AS hi FROM json_each(?)),
          r AS MATERIALIZED (SELECT *, ${at} AS chart_at${split ? `, ${split.expr} AS split_value` : ""} FROM (${filtered(read)}))
          SELECT b.i AS i, ${split ? "CAST(r.split_value AS TEXT)" : "NULL"} AS k, ${measure.expr} AS value
          FROM b LEFT JOIN r ON r.chart_at >= b.lo AND r.chart_at < b.hi
          GROUP BY b.i, k ORDER BY b.i`)
        .all(edgesJson(chosen.edges), ...(undated ? [begins] : []), ...read.params) as Array<{ i: number; k: string | null; value: number | null }>;
      if (!split) {
        const values = new Map(rows.map((row) => [row.i, row.value ?? 0]));
        return volumeAnswer(ask, chosen, (i) => values.get(i) ?? 0);
      }
      const parts = chosen.edges.map(() => new Map<string, number>());
      for (const row of rows) if (row.k !== null) parts[row.i].set(row.k, row.value ?? 0);
      return volumeAnswer(ask, chosen, (i) => parts[i], split.name, split.order);
    },

    /**
     * Each filter's values under every other filter, commonest first, with how many rows have each; a value chosen is
     * listed even with none, so the page can show it chosen.
     */
    facets(reads: Reads, filters: Filters): Record<string, FacetValue[]> {
      const db = dbOf(reads);
      const facets: Record<string, FacetValue[]> = {};
      for (const filter of def.filters) {
        const where = whereOf(filters, filter.key);
        if (filter.kind === "choice") {
          const rows = db
            .prepare(`SELECT ${filter.expr} AS value, ${filter.labelExpr ? `min(${filter.labelExpr})` : "NULL"} AS label, count(*) AS count FROM (${filtered(where)})
              GROUP BY 1 ORDER BY count DESC, value LIMIT ${MOST_FACET_VALUES}`)
            .all(...where.params) as Array<{ value: string | number | null; label: string | null; count: number }>;
          const values = rows.map((row) => ({ value: String(row.value), label: row.label ?? filter.name(String(row.value)), count: row.count }));
          for (const chosen of filters.choices[filter.key] ?? []) {
            if (values.some((v) => v.value === chosen)) continue;
            const named = filter.labelExpr
              ? (db.prepare(`SELECT min(${filter.labelExpr}) AS label FROM (${def.source}) WHERE ${filter.expr} = ?`).get(chosen) as { label: string | null }).label
              : null;
            values.push({ value: chosen, label: named ?? filter.name(chosen), count: 0 });
          }
          facets[filter.key] = values;
        } else {
          const rows = db
            .prepare(`SELECT j.value AS value, count(*) AS count FROM (SELECT ${filter.ids} AS ids FROM (${filtered(where)})) s, json_each(s.ids) j
              GROUP BY j.value ORDER BY count DESC, j.value LIMIT ${MOST_FACET_VALUES}`)
            .all(...where.params) as Array<{ value: number; count: number }>;
          const ids = rows.map((row) => row.value);
          if (filters.person !== null && !ids.includes(filters.person)) {
            rows.push({ value: filters.person, count: 0 });
            ids.push(filters.person);
          }
          const named = names(reads, ids);
          facets[filter.key] = rows.map((row) => ({ value: String(row.value), label: named[row.value] ?? `Person ${row.value}`, count: row.count }));
        }
      }
      return facets;
    },

    detail(reads: Reads, id: string): RowDetail {
      const raw = dbOf(reads).prepare(`SELECT * FROM (${def.source}) WHERE id = ?`).get(id) as SourceRow | undefined;
      if (!raw) throw new NotFoundError(`no ${def.noun[0]} ${JSON.stringify(id)}`);
      const row = rowOf(raw);
      const added = ownerOf(reads.owners, def.module).detail(String(raw.kind), String(raw.origin), String(raw.native_id));
      const more = added?.more ?? [];
      return { row, more, people: names(reads, peopleOf([row], more)), views: added?.views ?? [], ...(added?.content === undefined ? {} : { content: added.content }) };
    },
  };
}
