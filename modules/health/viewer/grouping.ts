// How the Health page groups its results: by status (Out, Mildly out, At the edge, In range and the rest, the
// default) or by category (the catalogue's body systems, in its order, as the answer lists them in `systems`). Either
// way a group keeps the server's order within it (status, then margin, then name), so a category lists its worst
// first. The choice is kept in the address's query (?group=category; status is the page with none), beside the tab in
// its path, so a reload or a link keeps both. Each category has its own colour (viewer.css's --cat-<key>), on its
// chip and its heading; a category the catalogue does not list (Other) has none.

import type { HealthAnswer, HealthTest } from "../wire.ts";
import { shownStatus, SHOWN_ORDER, STATUS_WORDS, type Shown } from "./format.ts";

export type GroupBy = "status" | "category";

export const GROUP_BYS: readonly { key: GroupBy; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "category", label: "Category" },
];

/** The query parameter that names the grouping. */
export const GROUP_PARAM = "group";

/**
 * One section of the page: its heading, and what colours it: a status (by status) or a category's key (by category;
 * null for one the catalogue does not list).
 */
export interface HealthGroup {
  key: string;
  title: string;
  status: Shown | null;
  category: string | null;
  tests: HealthTest[];
}

/** The grouping the query `search` names; status for none or one it does not know. */
export function groupByOf(search: string): GroupBy {
  return new URLSearchParams(search).get(GROUP_PARAM) === "category" ? "category" : "status";
}

/** `search` with the grouping set: status, the default, leaves the parameter out. */
export function groupBySearch(search: string, by: GroupBy): string {
  const params = new URLSearchParams(search);
  if (by === "status") params.delete(GROUP_PARAM);
  else params.set(GROUP_PARAM, by);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Each category's colour key by its name, from the answer's `systems`. */
export function categoryKeys(systems: HealthAnswer["systems"]): Map<string, string> {
  return new Map(systems.map((s) => [s.name, s.key]));
}

/**
 * `tests` (in the server's order) in sections: by status in SHOWN_ORDER, or by category in the order of `systems`, a
 * category it does not name after them in the order it first appears. Empty sections are left out.
 */
export function groupTests(tests: readonly HealthTest[], by: GroupBy, systems: HealthAnswer["systems"]): HealthGroup[] {
  if (by === "status") {
    return SHOWN_ORDER.map((status) => ({
      key: status,
      title: STATUS_WORDS[status],
      status,
      category: null,
      tests: tests.filter((t) => shownStatus(t.status) === status),
    })).filter((group) => group.tests.length > 0);
  }
  const keys = categoryKeys(systems);
  const order = [...new Set([...systems.map((s) => s.name), ...tests.map((t) => t.system)])];
  return order
    .map((name) => ({ key: name, title: name, status: null, category: keys.get(name) ?? null, tests: tests.filter((t) => t.system === name) }))
    .filter((group) => group.tests.length > 0);
}

// By category, each section folds by its heading. Which are folded is kept on this device only (localStorage, under
// COLLAPSED_KEY, as a JSON list of category names), not in the address; every section starts open.

/** The localStorage key that holds the folded categories. */
export const COLLAPSED_KEY = "life-archive.health.collapsed";

/** The folded categories `stored` names: none for nothing stored or anything that is not a list of names. */
export function collapsedOf(stored: string | null): Set<string> {
  try {
    const list: unknown = JSON.parse(stored ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

/** `collapsed` with `key` folded if it was open, open if it was folded. */
export function toggled(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** What a folded section says of its worst: how many are out ("2 out") or else mildly out; nothing if neither. */
export function foldedHint(tests: readonly HealthTest[]): { status: "out" | "mild"; text: string } | null {
  for (const status of ["out", "mild"] as const) {
    const n = tests.filter((t) => shownStatus(t.status) === status).length;
    if (n > 0) return { status, text: `${n} ${STATUS_WORDS[status].toLowerCase()}` };
  }
  return null;
}
