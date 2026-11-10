// What a table is showing, kept in its address so a reload, the back button or a link opens the same view: the
// table (a tab the server knows), its filters, the table's order, the chart's measure and grain, and the row open in
// the drawer. Also the chart's own arithmetic: which bucket a point is over, and the time range a drag across buckets
// covers.

import { filterParams, GRAINS, NO_FILTERS, readFilters, type Bucket, type Filters, type Grain, type KindSpec, type SortDirection } from "./wire.ts";

export interface ViewState {
  kind: string;
  filters: Filters;
  sort: string;
  direction: SortDirection;
  measure: string;
  /** null: the viewer picks the finest that fits. */
  grain: Grain | null;
  /** The filter the chart's bars are split by, or null for whole bars. */
  split: string | null;
  /** The row open in the drawer (its Row.id), or null. */
  open: string | null;
}

/** The view of table `spec` that the query `search` says; what it cannot read is left at the table's default. */
export function viewOf(spec: KindSpec, search: string): ViewState {
  const params = new URLSearchParams(search);
  let filters = NO_FILTERS;
  try {
    filters = readFilters(params, spec.filters.filter((f) => f.kind === "choice").map((f) => f.key));
  } catch {
    // An address the page did not write: no filters.
  }
  if (!spec.search) filters = { ...filters, search: null };
  const sort = params.get("sort");
  const grain = params.get("grain");
  const measure = params.get("measure");
  const split = params.get("split");
  return {
    kind: spec.kind,
    filters,
    sort: spec.columns.some((c) => c.key === sort && c.sortable) ? sort! : spec.sort,
    direction: params.get("dir") === "asc" || params.get("dir") === "desc" ? (params.get("dir") as SortDirection) : (spec.direction ?? "desc"),
    measure: spec.measures.some((m) => m.key === measure) ? measure! : spec.measures[0].key,
    grain: (GRAINS as readonly string[]).includes(grain ?? "") ? (grain as Grain) : null,
    split: spec.splits.includes(split ?? "") ? split : null,
    open: params.get("open") || null,
  };
}

/**
 * The query of `view` (with its leading "?", or "" for none) after `before` (what names the table, say), leaving out
 * what is the default of `spec`, its table.
 */
export function viewQuery(view: ViewState, spec: KindSpec, before: Record<string, string> = {}): string {
  const params = filterParams(view.filters, new URLSearchParams(before));
  if (view.sort !== spec.sort) params.set("sort", view.sort);
  if (view.direction !== (spec.direction ?? "desc")) params.set("dir", view.direction);
  if (view.measure !== spec.measures[0].key) params.set("measure", view.measure);
  if (view.grain !== null) params.set("grain", view.grain);
  if (view.split !== null) params.set("split", view.split);
  if (view.open !== null) params.set("open", view.open);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The view of table `spec` with no filters, ordered and charted as it is at first. */
export function freshView(spec: KindSpec): ViewState {
  return { kind: spec.kind, filters: NO_FILTERS, sort: spec.sort, direction: spec.direction ?? "desc", measure: spec.measures[0].key, grain: null, split: null, open: null };
}

/** Whether any filter narrows the view. */
export function isFiltered(filters: Filters): boolean {
  return (
    filters.from !== null || filters.to !== null || filters.person !== null || filters.search !== null ||
    Object.values(filters.choices).some((values) => values.length > 0)
  );
}

/** The bucket a point `x` pixels across a chart `width` wide with `count` buckets is over, kept within them. */
export function bucketAt(x: number, width: number, count: number): number {
  if (count === 0 || width <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** The time range from the start of bucket `a` to the end of bucket `b` (either way round); the last ends at `end`. */
export function rangeOf(buckets: readonly Bucket[], end: number, a: number, b: number): { from: number; to: number } {
  const first = Math.min(a, b);
  const last = Math.max(a, b);
  return { from: buckets[first].start, to: last + 1 < buckets.length ? buckets[last + 1].start : end };
}
