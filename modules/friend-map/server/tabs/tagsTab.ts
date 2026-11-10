// The viewer's Tags tab: every tag in the captain's tag table (../tags.ts), in his order, with how many people have it,
// whether it is built in and when it was made. Friend Map's tag manager, as a table (the plan's "Tags as a table"):
// a tag is renamed for everyone (onto a tag that exists, the two merge) and moved in the order by its Order, both in
// its cell or its drawer; Add tag makes one nobody has yet; a tag is deleted from everyone who has it. The built-in
// ones ("archive", "keep" and the rest) only move. All of it through the tag table's own writes (../peopleEdits.ts),
// each one changeset, undone from the record or Friend Map's Changes. Its rows are not in the calendar.

import type { DatabaseSync } from "node:sqlite";
import { archiveOf } from "./reads.ts";
import {
  chartBuckets, type FacetValue, type Filters, type KindSpec, LOCALE, nameKey, NotFoundError, only, type Page, type Row, type RowDetail, type RowsAnswer, type Tab,
  type VolumeAnswer, volumeAnswer, type VolumeAsk,
} from "../../../../sdk/server.ts";

/** A tag's kind in the record of edits (its row's key: server/edits/editor.ts's EditRow). */
export const TAG_ROW = "tag";

const SPEC: KindSpec = {
  kind: "tags",
  label: "Tags",
  noun: ["tag", "tags"],
  columns: [
    { key: "order", label: "Order", kind: "count", width: 80, numeric: true, sortable: true },
    { key: "name", label: "Tag", kind: "text", width: 220, sortable: true },
    { key: "people", label: "People", kind: "count", width: 90, numeric: true, sortable: true },
    { key: "builtIn", label: "Built in", kind: "text", width: 110 },
    { key: "made", label: "Made", kind: "time", width: 175, sortable: true },
  ],
  filters: [],
  measures: [{ key: "made", label: "Tags made", unit: "count" }],
  sort: "order",
  direction: "asc",
  splits: [],
  search: "Find a tag",
  edits: [
    { key: "name", label: "Tag", input: "text" },
    { key: "order", label: "Order", input: "number", min: 1 },
  ],
  own: { add: [{ key: "name", label: "Tag", input: "text" }], deletes: "any tag but the built-in ones" },
};

interface TagRow {
  id: number;
  name: string;
  /** Its place in the order, from 1. */
  order: number;
  people: number;
  builtIn: boolean;
  made: number;
}

/** Every tag, in his order, numbered from 1. */
function tagsOf(db: DatabaseSync): TagRow[] {
  return (db
    .prepare(`SELECT t.id, t.name, t.built_in, t.created_at, (SELECT count(*) FROM person_tag pt WHERE pt.tag_id = t.id) AS people
      FROM tag t ORDER BY t.sort_order, t.name`)
    .all() as Array<{ id: number; name: string; built_in: number; created_at: number; people: number }>)
    .map((tag, i) => ({ id: tag.id, name: tag.name, order: i + 1, people: tag.people, builtIn: tag.built_in === 1, made: tag.created_at }));
}

/** The tags the filters leave: those made in their range, holding the search. */
function filtered(db: DatabaseSync, filters: Filters): TagRow[] {
  const needle = filters.search === null ? null : nameKey(filters.search);
  return tagsOf(db).filter((tag) =>
    (filters.from === null || tag.made >= filters.from) && (filters.to === null || tag.made < filters.to) && (needle === null || nameKey(tag.name).includes(needle)));
}

const collator = new Intl.Collator(LOCALE, { sensitivity: "base", numeric: true });

const SORTS: Record<string, (a: TagRow, b: TagRow) => number> = {
  order: (a, b) => a.order - b.order,
  name: (a, b) => collator.compare(a.name, b.name),
  people: (a, b) => a.people - b.people || a.order - b.order,
  made: (a, b) => a.made - b.made || a.order - b.order,
};

const rowOf = (tag: TagRow): Row => ({
  id: String(tag.id),
  cells: { order: tag.order, name: tag.name, people: tag.people, builtIn: tag.builtIn ? "Built in" : null, made: tag.made },
});

function rows(db: DatabaseSync, filters: Filters, page: Page): RowsAnswer {
  const sign = page.direction === "asc" ? 1 : -1;
  const sorted = filtered(db, filters).sort((a, b) => sign * (SORTS[page.sort] ?? SORTS.order)(a, b));
  return { total: sorted.length, offset: page.offset, rows: sorted.slice(page.offset, page.offset + page.limit).map(rowOf), people: {}, next: null };
}

/** How many tags the filters leave were made in each bucket. */
function volume(db: DatabaseSync, filters: Filters, ask: VolumeAsk): VolumeAnswer {
  const tags = filtered(db, filters);
  const made = tags.map((tag) => tag.made);
  const chosen = chartBuckets(filters, { first: made.length ? Math.min(...made) : null, last: made.length ? Math.max(...made) : null }, ask.grain, ask.begins);
  return volumeAnswer(ask, chosen, (i) => made.filter((at) => at >= chosen!.edges[i].start && at < chosen!.edges[i].end).length);
}

function detail(db: DatabaseSync, id: string): RowDetail {
  const tag = /^\d+$/.test(id) ? tagsOf(db).find((t) => t.id === Number(id)) : undefined;
  if (!tag) throw new NotFoundError(`no tag ${JSON.stringify(id)} in the Tags tab`);
  return {
    row: rowOf(tag),
    more: [],
    people: {},
    views: [{ label: "People with it", kind: "people", filters: only({ choices: { tag: [tag.name] } }) }],
  };
}

/** The Tags tab reads the archive alone, as People does: tags are friend map's, and none is in the calendar. */
export const TAGS: Tab = {
  spec: SPEC,
  version: (reads) => {
    const row = archiveOf(reads).prepare("SELECT (SELECT value FROM meta WHERE key = 'people_version') AS people, (SELECT count(*) FROM person_tag) AS tagged").get() as Record<string, unknown>;
    return `${row.people}.${row.tagged}`;
  },
  rows: (reads, filters, page) => rows(archiveOf(reads), filters, page),
  volume: (reads, filters, ask) => volume(archiveOf(reads), filters, ask),
  facets: (): Record<string, FacetValue[]> => ({}),
  detail: (reads, id) => detail(archiveOf(reads), id),
};
