// The viewer's tabs, its tables: one definition each, the core's (LLM) and the modules' (sdk/server.ts's `tabs`: friend
// map's Messages, Calls, Hangouts and People, the exercise module's Workouts, the rituals module's Rituals), in tabsWith. The Events page's Tables lists
// them all and opens each as it is kept; nothing merges one table's rows with another's (the Calendar is the one view
// across them, and it reads each table's own routes). A tab says what the page is told of it (its KindSpec: columns,
// filters, what the chart can count and split by, what the table sorts by) and answers the three questions the routes
// (http.ts) ask: a page of its rows, its volume over time, and each filter's values with how many rows have each. Most
// tabs are one SELECT over the calendar with a filter expression for each filter, and sourceTab (sourceTab.ts) answers
// for them (Calls, Hangouts, LLM, and a module's: exercise's Workouts, rituals' Rituals); Messages, at over a million rows, plans its own queries (messagesTab.ts), and so
// does People, whose rows are people and whose chart counts who was active (peopleTab.ts). Every bit of SQL comes from
// the tabs' constants; what a request brings is only ever a bound value.
//
// The queries run on the viewer's own connections (connection.ts), all read-only and query_only. Friend map's archive's
// (its sqlRead.ts's openForQuery), which Messages and People read, has the SQL runner's authorizer, so a tab that
// touched a message's text, a raw record, a note or a draft would fail rather than read it. The calendar's, which the tabs of
// events read, has none, because the calendar holds no content.

import type { Reads } from "./tab.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import type { FacetValue, Filters, RowDetail, RowsAnswer, VolumeAnswer } from "../../viewer/wire.ts";
import { LLM } from "./llmTab.ts";
import { AGENT_SESSIONS, LLM_TAGS, PROMPTS } from "./llmWarehouseTabs.ts";
import { MOST_ROWS, type Page, type Tab, type VolumeAsk } from "./tab.ts";

export { MOST_ROWS, readBegins, readGrain, type Page, type Tab, type VolumeAsk } from "./tab.ts";

/**
 * The order Events' Tables lists the tables in, by kind, as the captain has had them: friend map's chats, calls and
 * hangouts, the conversations with agents (the core's) and the LLM warehouse's prompts, sessions and tags beside them,
 * the people and their tags (friend map's), and the rest (exercise's workouts, rituals') after in the modules' order. A table this
 * does not name follows the named ones.
 */
export const TABLE_ORDER: readonly string[] = ["messages", "calls", "hangouts", "llm", "prompts", "agent-sessions", "llm-tags", "people", "tags"];

/** Every tab, in the order Events' Tables lists them: the core's and the modules' (`modules`, each saying whose it is), in TABLE_ORDER. */
export function tabsWith(modules: readonly Tab[] = []): readonly Tab[] {
  const rank = (tab: Tab) => (TABLE_ORDER.includes(tab.spec.kind) ? TABLE_ORDER.indexOf(tab.spec.kind) : TABLE_ORDER.length);
  return [LLM, PROMPTS, AGENT_SESSIONS, LLM_TAGS, ...modules].map((tab, at) => ({ tab, at })).sort((a, b) => rank(a.tab) - rank(b.tab) || a.at - b.at).map(({ tab }) => tab);
}

/** The tab of `kind` among `tabs`; NotFoundError for none. */
export function tabOf(tabs: readonly Tab[], kind: string): Tab {
  const tab = tabs.find((t) => t.spec.kind === kind);
  if (!tab) throw new NotFoundError(`the viewer has no ${JSON.stringify(kind)} tab; it has ${tabs.map((t) => t.spec.kind).join(", ")}`);
  return tab;
}

/** The keys of a tab's choice filters, which readFilters reads from the query string. */
export function choiceKeys(tab: Tab): string[] {
  return tab.spec.filters.filter((f) => f.kind === "choice").map((f) => f.key);
}

/** A page of a tab's rows under `filters`, sorted, with how many there are in all and the names of the people they name. */
export function rowsOf(reads: Reads, tab: Tab, filters: Filters, page: Page): RowsAnswer {
  const sortable = tab.spec.columns.filter((c) => c.sortable).map((c) => c.key);
  if (!sortable.includes(page.sort)) throw new InvalidInputError(`the ${tab.spec.kind} tab sorts by ${sortable.join(" or ")}, not ${JSON.stringify(page.sort)}`);
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) throw new InvalidInputError("offset is a whole number, 0 or more");
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MOST_ROWS) throw new InvalidInputError(`limit is a whole number from 1 to ${MOST_ROWS}`);
  return tab.rows(reads, filters, page);
}

/** The chart: `ask.measure` of the rows `filters` leave in each bucket (volume answers how), checked first. */
export function volumeOf(reads: Reads, tab: Tab, filters: Filters, ask: VolumeAsk): VolumeAnswer {
  const measures = tab.spec.measures.map((m) => m.key);
  if (!measures.includes(ask.measure)) throw new InvalidInputError(`the ${tab.spec.kind} tab's chart counts ${measures.join(" or ")}, not ${JSON.stringify(ask.measure)}`);
  if (ask.split !== null && !tab.spec.splits.includes(ask.split)) {
    throw new InvalidInputError(`the ${tab.spec.kind} tab's chart splits by ${tab.spec.splits.join(", ") || "nothing"}, not ${JSON.stringify(ask.split)}`);
  }
  return tab.volume(reads, filters, ask);
}

/** Each filter's values under every other filter, commonest first, with how many rows have each (see facets). */
export function facetsOf(reads: Reads, tab: Tab, filters: Filters): Record<string, FacetValue[]> {
  return tab.facets(reads, filters);
}


/** One row of a tab, for its drawer (see detail). */
export function detailOf(reads: Reads, tab: Tab, id: string | null): RowDetail {
  if (id === null || id === "") throw new InvalidInputError("id is the row's id");
  return tab.detail(reads, id);
}
