// The Inspirations page's own tabs: Platforms (how many platforms the items come from, and each one's count), Recent
// (everything, newest first, or one platform's), By tag, Search, Untagged, Tags (his vocabulary) and Changes (its
// changesets, with Undo), each a view under the console's Inspirations aspect (InspirationsSection.tsx),
// Platforms the aspect's address itself; what a tab is narrowed to (tags, the kind of tags, words, a platform, Hidden),
// the page of its list and the item open are in the address's query, so a reload, the back button or a link opens the
// same view. Recent was the aspect's own address until Platforms came (October 2026): an address there that asks for
// what only Recent reads (a page, an item open, Hidden, a platform) is an old link to Recent, and goes there.

import { inspirationParams, readInspirationFilter, type InspirationFilter } from "../wire.ts";

export interface InspirationsTab {
  /** Its step in the address; "" for the first. */
  key: "" | "recent" | "by-tag" | "search" | "untagged" | "tags" | "changes";
  label: string;
}

export const INSPIRATIONS_TABS: readonly InspirationsTab[] = [
  { key: "", label: "Platforms" },
  { key: "recent", label: "Recent" },
  { key: "by-tag", label: "By tag" },
  { key: "search", label: "Search" },
  { key: "untagged", label: "Untagged" },
  { key: "tags", label: "Tags" },
  { key: "changes", label: "Changes" },
];

/** What a tab's list is narrowed to, from the address's query: each tab reads only what it offers. */
export function tabFilter(tab: InspirationsTab, search: string): InspirationFilter {
  const asked = readInspirationFilter(new URLSearchParams(search));
  const base = { tags: [], tagKind: "manual" as const, q: "", untagged: false, platform: "", hidden: asked.hidden };
  switch (tab.key) {
    case "":
      return { ...base, hidden: false };
    case "recent":
      return { ...base, platform: asked.platform };
    case "by-tag":
      return { ...base, tags: asked.tags, tagKind: asked.tagKind };
    case "search":
      return { ...base, q: asked.q };
    case "untagged":
      return { ...base, untagged: true };
    default:
      return base;
  }
}

/** How many items a page of a list shows: a whole number of rows at two, three, four or six across. */
export const PAGE_SIZE = 48;

/**
 * The address of `tab`, which is at `path`, narrowed to `filter`, at page `page` of its list (1, the first, says
 * nothing), with the item `item` open (or none).
 */
export function inspirationsAddress(path: string, tab: InspirationsTab, filter: InspirationFilter, item: number | null, page = 1): string {
  const params = inspirationParams(filter);
  if (tab.key === "untagged") params.delete("untagged");
  if (page > 1) params.set("page", String(page));
  if (item !== null) params.set("item", String(item));
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

/** What only Recent reads of an address's query: the list's page, the item open, Hidden and a platform. */
const RECENT_ONLY = ["page", "item", "hidden", "platform"];

/** Whether an address at the aspect's own (Platforms, Recent's until October 2026) is an old link to Recent: it asks for what only Recent reads. */
export const asksForRecent = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return RECENT_ONLY.some((key) => params.has(key));
};

/** The item the address has open, or null. */
export function openItemOf(search: string): number | null {
  const value = new URLSearchParams(search).get("item");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/** The page of the list the address shows, 1 the first. */
export function pageOf(search: string): number {
  const value = new URLSearchParams(search).get("page");
  return value !== null && /^\d+$/.test(value) && Number(value) >= 1 ? Number(value) : 1;
}

/** How many pages `total` items fill (one, for none). */
export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));

/**
 * The pages to offer by number around `current` of `count`: the first, the last, and two either side of it, with null
 * where pages are left out (1 … 4 5 6 7 8 … 12).
 */
export function pageNumbers(current: number, count: number): Array<number | null> {
  const shown = [...new Set([1, count, ...[-2, -1, 0, 1, 2].map((step) => current + step)])].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  for (const [i, n] of shown.entries()) {
    if (i > 0 && n - shown[i - 1] === 2) out.push(n - 1);
    else if (i > 0 && n - shown[i - 1] > 2) out.push(null);
    out.push(n);
  }
  return out;
}
