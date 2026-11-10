// What a tab of the viewer is (tabs.ts lists them), and what tabs share: what a tab reads (Reads: the archive, the
// calendar, and the owners of the calendar's rows), the shapes of a page and a chart as asked, the chart's buckets and
// answer, the names of the people rows name, and the filters a drawer's links narrow to.

import type { DatabaseSync } from "node:sqlite";
import type { Owners } from "../calendar/owners.ts";
import { InvalidInputError } from "../errors.ts";
import { addDays, dayKey, dayStart, isClockTime, MIDNIGHT } from "../../src/time.ts";
import {
  GRAINS, NO_FILTERS, type Bucket, type DetailField, type FacetValue, type Filters, type Grain, type KindSpec, type PeopleCell, type Row, type RowDetail,
  type RowsAnswer, type Series, type SortDirection, type ViewLink, type VolumeAnswer,
} from "../../viewer/wire.ts";
import { bucketsFor, type BucketEdge } from "./buckets.ts";

/**
 * What the tabs read (connection.ts opens them): the archive, read-only and unable to read content (the Messages and
 * People tabs, and the owners' answers), the calendar (server/calendar/db.ts; the tabs of events), and the owners of
 * the calendar's rows (server/calendar/owners.ts), who name the people a row names and add to its drawer.
 */
export interface Reads {
  /** The core's own database (archive/coreDb.ts), read-only: the event index. */
  core: DatabaseSync;
  calendar: DatabaseSync;
  /** Each module's database its tables read, read-only (connection.ts), by module id: friend map's archive. */
  modules: ReadonlyMap<string, DatabaseSync>;
  owners: Owners;
}

/** A page of rows as asked: from `offset` (or, for a tab that pages by key, right after `after`), sorted. */
export interface Page {
  offset: number;
  limit: number;
  sort: string;
  direction: SortDirection;
  /** RowsAnswer.next of the page before, for a tab that pages by key; null to count from the top. */
  after: string | null;
}

/**
 * The chart as asked: by `grain` (null for the finest that fits), counting `measure`, split by the filter `split`, its
 * days beginning at `begins` (HH:MM; midnight when left out: the Events calendar's begin at 06:00).
 */
export interface VolumeAsk {
  grain: Grain | null;
  measure: string;
  split: string | null;
  begins?: string;
}

export interface Tab {
  spec: KindSpec;
  /**
   * What the tab's answers depend on, as a string that changes when they may, so the routes can keep answers until
   * it does (http.ts); none for a tab small enough to answer afresh every time.
   */
  version?: (reads: Reads) => string;
  rows: (reads: Reads, filters: Filters, page: Page) => RowsAnswer;
  volume: (reads: Reads, filters: Filters, ask: VolumeAsk) => VolumeAnswer;
  facets: (reads: Reads, filters: Filters) => Record<string, FacetValue[]>;
  /** The row keyed `id` (Row.id), for its drawer; NotFoundError for none. */
  detail: (reads: Reads, id: string) => RowDetail;
}

/** The most rows one page may ask for. */
export const MOST_ROWS = 500;

/** `grain` as asked (null for the viewer to pick); InvalidInputError for anything else. */
export function readGrain(text: string | null): Grain | null {
  if (text === null || text === "" || text === "auto") return null;
  if (!(GRAINS as readonly string[]).includes(text)) throw new InvalidInputError(`grain is auto, ${GRAINS.join(", ")}, not ${JSON.stringify(text)}`);
  return text as Grain;
}

/** When the chart's days begin as asked (`begins`, HH:MM; midnight when not asked); InvalidInputError for anything else. */
export function readBegins(text: string | null): string {
  if (text === null || text === "") return MIDNIGHT;
  if (!isClockTime(text)) throw new InvalidInputError(`begins is a time of day, HH:MM, not ${JSON.stringify(text)}`);
  return text;
}

/** The most values a facet lists: the commonest. */
export const MOST_FACET_VALUES = 300;

/**
 * The buckets a chart over [from, to) has (bucketsFor), its days beginning at `begins`, or null when there are none:
 * no rows and no range. The filters' range when they have one, else from the first row to the last (`extent`).
 */
export function chartBuckets(filters: Filters, extent: { first: number | null; last: number | null }, grain: Grain | null, begins = MIDNIGHT): { grain: Grain; edges: BucketEdge[] } | null {
  const from = filters.from ?? extent.first;
  const to = filters.to ?? (extent.last === null ? null : extent.last + 1);
  if (from === null || to === null || to <= from) return null;
  return bucketsFor(from, to, grain, begins);
}

/** The buckets as one JSON array of [start, end) pairs, for a query to join json_each to. */
export function edgesJson(edges: readonly BucketEdge[]): string {
  return JSON.stringify(edges.map((edge) => [edge.start, edge.end]));
}

/**
 * The chart's answer: for whole bars, `values` (by bucket index); split, `parts` (by bucket index, each the value of
 * each part's key), named by `label` and in `order` (the split filter's values as the tab orders them; any other after
 * them, the biggest first). No buckets: an empty chart by `grain` or month.
 */
export function volumeAnswer(
  ask: VolumeAsk,
  chosen: { grain: Grain; edges: BucketEdge[] } | null,
  values: (i: number) => number | Map<string, number>,
  label: (key: string) => string = (key) => key,
  order: readonly string[] = [],
): VolumeAnswer {
  if (chosen === null) return { grain: ask.grain ?? "month", measure: ask.measure, split: ask.split, series: [], buckets: [], end: 0, total: 0 };
  const raw = chosen.edges.map((_, i) => values(i));
  let series: Series[] = [];
  if (ask.split !== null) {
    const sums = new Map<string, number>();
    for (const parts of raw) for (const [key, value] of parts as Map<string, number>) sums.set(key, (sums.get(key) ?? 0) + value);
    const others = [...sums].filter(([value]) => !order.includes(value)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
    const known = order.filter((value) => sums.has(value));
    series = [...known, ...others].map((value) => ({ value, label: label(value), slot: known.includes(value) ? order.indexOf(value) : order.length + others.indexOf(value) }));
  }
  const buckets: Bucket[] = chosen.edges.map((edge, i) => {
    const got = raw[i];
    if (typeof got === "number") return { start: edge.start, day: edge.day, value: got };
    const parts = series.map((s) => got.get(s.value) ?? 0);
    return { start: edge.start, day: edge.day, value: parts.reduce((sum, part) => sum + part, 0), parts };
  });
  return {
    grain: chosen.grain,
    measure: ask.measure,
    split: ask.split,
    series,
    buckets,
    end: chosen.edges.at(-1)!.end,
    total: buckets.reduce((sum, bucket) => sum + bucket.value, 0),
  };
}

/** Filters that narrow to `narrow` alone. */
export function only(narrow: Partial<Filters>): Filters {
  return { ...NO_FILTERS, ...narrow };
}

/** The local day holding `ms`, as a time range. */
export function dayOf(ms: number): { from: number; to: number } {
  const day = dayKey(ms);
  return { from: dayStart(day), to: dayStart(addDays(day, 1)) };
}

/** "Calls with Ada Sample": `noun` of tab `kind` with each of the first few people the row's `person_ids` names. */
export function withEach(raw: Record<string, unknown>, names: Record<number, string>, noun: string, kind: string): ViewLink[] {
  return (JSON.parse(String(raw.person_ids)) as number[]).slice(0, MOST_WITH).map((person) => ({ label: `${noun} with ${names[person] ?? `Person ${person}`}`, kind, filters: only({ person }) }));
}

/** The most people a drawer offers a view with each of. */
const MOST_WITH = 4;

export function isPeople(cell: unknown): cell is PeopleCell {
  return typeof cell === "object" && cell !== null && "ids" in cell;
}

/** Everyone the rows' people cells name (and the fields', for a drawer). */
export function peopleOf(rows: readonly Row[], fields: readonly DetailField[] = []): number[] {
  const cells = [...rows.flatMap((row) => Object.values(row.cells)), ...fields.map((field) => field.value)];
  return [...new Set(cells.flatMap((cell) => (isPeople(cell) ? cell.ids : [])))];
}

/** The names of the people `ids`, by id; a person without one is called by their number. */
export function namesOf(db: DatabaseSync, ids: number[]): Record<number, string> {
  if (ids.length === 0) return {};
  const rows = db.prepare("SELECT id, name FROM person WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Array<{ id: number; name: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.name?.trim() || `Person ${row.id}`]));
}
