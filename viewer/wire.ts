// What the viewer's page and its server say to each other (/life-archive/api/..., server/viewer/http.ts): each
// kind of event the viewer has a tab for, a page of its rows, its volume over time and the values its filters can
// take. One filter object drives the rows, the chart and the facets alike, written into the query string by
// filterParams and read back by the server with readFilters; a row's drawer asks for that row alone (RowDetail).
// Metadata only: no row carries a message's text, a note or any other content (docs/console.md's "The viewer"), but for the
// conversations a drawer opens when asked (CONTENT_API), each read kept in the trail of content reads.

import type { TimelineMessage } from "../src/archive.ts";
import type { EditField, OwnRows } from "./editWire.ts";
import { SITE } from "./mount.ts";

/** How the viewer's routes start, under the viewer's own path: /life-archive, below its site in a mounted demo (mount.ts). */
export const VIEWER_BASE = `${SITE}/life-archive`;
export const API_BASE = `${VIEWER_BASE}/api`;

/** Where the page asks what it is told as it opens. */
export const SETTINGS_API = `${API_BASE}/settings`;

/** What the page is told of its archive as it opens (server/viewer/pageSettings.ts). */
export interface PageSettings {
  timeZone: string;
  locale: string;
  /** Each installed module's switch (server/modules/loader.ts): true for one on, false for one switched off or broken; a module the server did not name is off. */
  modules: Readonly<Record<string, boolean>>;
  /** What each module on tells its page, by its id (sdk/server.ts's `viewerSettings`; sdk/viewer.ts's moduleSettings): none for a module that tells it nothing. */
  moduleSettings: Readonly<Record<string, unknown>>;
}

/** Where the modules' routes answer: MODULES_API/<id> and under it (server/modules/loader.ts). */
export const MODULES_API = `${API_BASE}/m`;

/** The module `id`'s routes: where its page asks. */
export const moduleApi = (id: string): string => `${MODULES_API}/${id}`;
/** The conversation a drawer opens (server/viewer/content.ts): the only routes of the viewer's that read content. */
export const CONTENT_API = `${API_BASE}/content`;

/** A bucket of the chart: a local day, a week from Monday, a calendar month or a year. */
export const GRAINS = ["day", "week", "month", "year"] as const;
export type Grain = (typeof GRAINS)[number];

/**
 * How a column's cells are written: the page draws each kind its own way (viewer/format.ts). A `count` is a whole
 * number (none or 0 is a dash); a `link` is a value that narrows the view to the rows with it (a message's chat).
 */
export type ColumnKind = "time" | "people" | "text" | "duration" | "count" | "link";

export interface ColumnSpec {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Its width on a wide screen, in pixels. */
  width: number;
  /** Right-aligned, as numbers are. */
  numeric?: boolean;
  /** The table can be sorted by it. */
  sortable?: boolean;
}

/**
 * A filter: one or more of a few values (`choice`, such as the app), or one person (`person`). Every tab can also be
 * narrowed to a time range (Filters' from and to), which the chart sets.
 */
export interface FilterSpec {
  key: string;
  label: string;
  kind: "choice" | "person";
  /** Its menu has a search box, with these words in it: for a long list (people, chats). */
  find?: string;
}

/** What the chart can count in each bucket: how many rows, or a sum (minutes on calls, say). */
export interface MeasureSpec {
  key: string;
  label: string;
  /** How a value of it is written: a count of rows, minutes (shown as hours and minutes), or characters of text. */
  unit: "count" | "minutes" | "characters";
}

/** A tab: one table (a kind of event, or People), as /life-archive/api/kinds lists it. */
export interface KindSpec {
  kind: string;
  label: string;
  /** One row and many, as the header counts them: ["call", "calls"]. */
  noun: [string, string];
  columns: ColumnSpec[];
  filters: FilterSpec[];
  measures: MeasureSpec[];
  /** The column the table is sorted by at first, newest first. */
  sort: string;
  /** Which way it is sorted at first, when not newest first (the tags, in their order: "asc"). */
  direction?: SortDirection;
  /** The choice filters the chart can split its bars by, each value a part of the bar. */
  splits: string[];
  /** The words in its search box, for a tab whose rows can be searched by name (Filters' search); none without one. */
  search?: string;
  /** The module whose table it is (its id: "exercise"); none for the core's. */
  module?: string;
  /**
   * The fields its owner lets be edited (viewer/editWire.ts): the same wherever the table is drawn, a drawer opened
   * from the Calendar's or the table's own; none for a table that is only read.
   */
  edits?: EditField[];
  /**
   * For a table whose rows are partly the captain's own records (hangouts, calls he logged): what Add asks, and which
   * rows can be deleted (viewer/editWire.ts's OwnRows); none for a table whose rows only come from imports.
   */
  own?: OwnRows;
}

export interface KindsAnswer {
  kinds: KindSpec[];
}

/** The people a row names: their ids (names in RowsAnswer.people), and how many more were there unnamed. */
export interface PeopleCell {
  ids: number[];
  others: number;
}

/** A value of the filter `filter` (a chat, say), named `label`: picking it narrows the view to the rows with it. */
export interface LinkCell {
  filter: string;
  value: string;
  label: string;
}

/** A cell: a value, the people a row names (or, in a people column, words for who it is: "You"), or a link. */
export type Cell = string | number | null | PeopleCell | LinkCell;

export interface Row {
  /** Stable for the life of the row (a call's own key), for React and the open row. */
  id: string;
  cells: Record<string, Cell>;
  /** When it was, ms, for a row of an event (a hangout's when may be its date alone), so the Calendar can place it and a link to it open its day in its table. */
  at?: number;
  /** The columns the captain has corrected (server/edits/), which the table marks "edited". */
  edited?: string[];
}

/**
 * Narrows a tab: a time range [from, to) in ms since the epoch, the values chosen of each choice filter, one person,
 * and words a row's name holds (a tab with a search box: People).
 */
export interface Filters {
  from: number | null;
  to: number | null;
  choices: Record<string, string[]>;
  person: number | null;
  search: string | null;
}

export const NO_FILTERS: Filters = { from: null, to: null, choices: {}, person: null, search: null };

/** The longest search the server reads. */
export const MOST_SEARCH = 100;

export type SortDirection = "asc" | "desc";

export interface RowsAnswer {
  /** How many rows the filters leave, all pages together. */
  total: number;
  offset: number;
  rows: Row[];
  /** The name of everyone the page's rows name. */
  people: Record<number, string>;
  /**
   * Where the next page begins, for a tab that pages by its rows' order rather than by counting (Messages): passed
   * back as `after` with the next offset, it is found at once however deep. Null for a tab that counts, or the last page.
   */
  next: string | null;
}

export interface Bucket {
  /** When it begins, ms; it ends where the next begins (the last at VolumeAnswer.end). */
  start: number;
  /** Its local date, YYYY-MM-DD, the day it begins. */
  day: string;
  value: number;
  /** Split, each part's value, in VolumeAnswer.series' order (adding up to value). */
  parts?: number[];
}

/** A part of the chart's split bars: a value of the filter it is split by. */
export interface Series {
  value: string;
  label: string;
  /**
   * Its place among the filter's values as the tab orders them, whichever are shown, so a value keeps its colour
   * whatever the filters leave (the page colours the first eight and folds the rest into Other).
   */
  slot: number;
}

export interface VolumeAnswer {
  grain: Grain;
  measure: string;
  /** The filter the bars are split by, or null for whole bars. */
  split: string | null;
  /** Split, its parts, in the tab's order of the filter's values; empty for whole bars. */
  series: Series[];
  buckets: Bucket[];
  /** Where the last bucket ends, ms. */
  end: number;
  /**
   * Every bucket's value added up; or, for a measure whose buckets do not add up (People's active people: someone
   * active every week is one person, not fifty), how many over the whole chart.
   */
  total: number;
  /** For such a measure, split: each part's own total over the whole chart, in `series`' order. */
  seriesTotals?: number[];
}

export interface FacetValue {
  value: string;
  label: string;
  /** How many rows have it, under every other filter. */
  count: number;
}

export interface FacetsAnswer {
  facets: Record<string, FacetValue[]>;
}

/** Something the drawer says of a row that the table has no column for, written as a column of `kind` is. */
export interface DetailField {
  label: string;
  kind: ColumnKind;
  value: Cell;
  /** Its key, for a field its table's owner lets be edited (KindSpec's `edits`: a workout's Ended). */
  key?: string;
}

/** Another tab, narrowed to what a row is about ("Their messages"): the drawer's way across. */
export interface ViewLink {
  label: string;
  kind: string;
  filters: Filters;
}

/**
 * One row, for its drawer (/life-archive/api/:kind/row?id=): the row as the table draws it, what else is known of it,
 * and the other tabs narrowed to it. Metadata only, as every answer is: never its text.
 */
export interface RowDetail {
  row: Row;
  more: DetailField[];
  /** The name of everyone the row and its fields name. */
  people: Record<number, string>;
  views: ViewLink[];
  /** Pages of the console beyond the tables the row opens (a person's panel in Friend Map). */
  places?: PlaceLink[];
  /** For a row with content behind it (a message, an LLM event), the id the content routes (CONTENT_API) take; the row's own when left out. */
  content?: number;
}

/** A page of the console a row opens: its aspect's slug (`place`: "friend-map") and what its address asks (?person=7). */
export interface PlaceLink {
  label: string;
  place: string;
  query: Record<string, string>;
}

/** Where the page asks for the calendar's day summaries (server/viewer/http.ts): CALENDAR_DAYS_API?from=&to=&person= */
export const CALENDAR_DAYS_API = `${API_BASE}/calendar/days`;

/**
 * How a day's rituals went, as rituals' day summary in the calendar says it: which of its items were done, not done and
 * not reported yet (the habits in rituals' own words, then each required check that applied that day by its id), and a
 * plank's held time.
 */
export interface RitualsDaySummary {
  done: string[];
  notDone: string[];
  notYet: string[];
  held: Record<string, string>;
}

/** One day of the calendar's summaries: how many messages, whom the captain messaged (the most first), how many messages he sent agents, and its rituals. */
export interface DaySummary {
  day: string;
  messages: number;
  messaged: Array<{ id: number; count: number }>;
  agentMessages: number;
  /** Null for a day rituals does not show (before it began, or to come). */
  rituals: RitualsDaySummary | null;
}

/**
 * The calendar's day summaries over [from, to), a day each (days with nothing left out), with the name of everyone
 * they name. With a person, each day's messages are those with them, and its messaged, agent messages and rituals
 * are left out (nobody is in them).
 */
export interface CalendarDaysAnswer {
  days: DaySummary[];
  people: Record<number, string>;
  /**
   * Of everyone on the days (whom he messaged, and everyone in the calls and hangouts), those friend map hides unless
   * asked (archived, or tagged with a tag its Hide starts on): the calendar's lists of people leave them out until its
   * switch shows them.
   */
  hidden: number[];
}

/** At most this many values may be chosen of one filter. */
export const MOST_CHOICES = 30;

/** The query string for `filters`, as the server reads it back (readFilters): from, to, person, q (the search) and each choice filter's values. */
export function filterParams(filters: Filters, params = new URLSearchParams()): URLSearchParams {
  if (filters.from !== null) params.set("from", String(filters.from));
  if (filters.to !== null) params.set("to", String(filters.to));
  if (filters.person !== null) params.set("person", String(filters.person));
  if (filters.search !== null) params.set("q", filters.search);
  for (const [key, values] of Object.entries(filters.choices).sort(([a], [b]) => a.localeCompare(b))) {
    for (const value of values) params.append(key, value);
  }
  return params;
}

/**
 * The filters in `params` (filterParams'), for a tab whose choice filters are `choiceKeys`; throws a message for the
 * 400 the server answers with anything it cannot read. Unknown parameters are left for the route (offset, sort).
 */
export function readFilters(params: URLSearchParams, choiceKeys: readonly string[]): Filters {
  const time = (key: string) => {
    const text = params.get(key);
    if (text === null) return null;
    const ms = Number(text);
    // A Date holds ±8.64e15 ms (some 270,000 years either way); past that a time has no date to bucket by.
    if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(ms) || Math.abs(ms) > 8.64e15) throw new Error(`${key} is a time in milliseconds, not ${JSON.stringify(text)}`);
    return ms;
  };
  const from = time("from");
  const to = time("to");
  if (from !== null && to !== null && to <= from) throw new Error("to must be after from");
  const personText = params.get("person");
  const person = personText === null ? null : Number(personText);
  if (person !== null && (!/^\d+$/.test(personText!) || !Number.isSafeInteger(person))) throw new Error(`person is a person's id, not ${JSON.stringify(personText)}`);
  const choices: Record<string, string[]> = {};
  for (const key of choiceKeys) {
    const values = [...new Set(params.getAll(key))];
    if (values.length > MOST_CHOICES) throw new Error(`at most ${MOST_CHOICES} values of ${key}`);
    if (values.length > 0) choices[key] = values;
  }
  const search = params.get("q")?.trim() || null;
  if (search !== null && search.length > MOST_SEARCH) throw new Error(`a search is at most ${MOST_SEARCH} characters`);
  return { from, to, choices, person, search };
}

/**
 * A page of the chat a message is in, oldest first (GET CONTENT_API/messages/:id/chat): around the message at first,
 * then older (`before=`) or newer (`after=`) pages, each read kept in the trail of content reads.
 */
export interface ChatPage {
  /** Its app by name (Messenger), and its title: a one-to-one chat's is its person's name. */
  conversation: { id: number; platform: string; app: string; type: "direct" | "group"; title: string | null };
  messages: TimelineMessage[];
  /** Passed as `before` for the page just older; null at the chat's first message, and on a newer page. */
  before: string | null;
  /** Passed as `after` for the page just newer; null at its last, and on an older page. */
  after: string | null;
  /** The message it was opened at, on the first page. */
  focus: number | null;
}

/**
 * A chat with messages on one of the Events calendar's days (from 06:00; GET CONTENT_API/messages/days/:day): how many,
 * when, and who; never a message.
 */
export interface DayChat {
  id: number;
  type: "direct" | "group";
  /** Its app by name (Messenger). */
  app: string;
  /** A group's own title; null for a one-to-one chat and an untitled group. */
  title: string | null;
  /** Everyone in it that day but the captain: a one-to-one chat's other person; whoever wrote in a group. */
  people: number[];
  messages: number;
  first: number;
  last: number;
}

/**
 * A calendar day's chats (GET CONTENT_API/messages/days/:day): every chat with messages that day, the most first,
 * adding up to the day's count, and the names of everyone they name.
 */
export interface DayChatsAnswer {
  day: string;
  chats: DayChat[];
  people: Record<number, string>;
}

/**
 * A page of one person's or one chat's messages on a calendar day, oldest first (GET CONTENT_API/messages/days/:day/
 * people/:id, or /chats/:id, ?after=), each read kept in the trail of content reads.
 */
export interface DayChatPage {
  messages: TimelineMessage[];
  /** Passed as `after` for the next page; null at the day's last message. */
  after: string | null;
}

/** A turn's words, or a tool call in a reply: its name and what it was given (cut at 2000 characters). */
export type TurnPart = { type: "text"; text: string } | { type: "tool"; name: string; input: string };

export interface SessionTurn {
  event: number;
  role: "prompt" | "reply";
  at: number;
  model: string | null;
  /** Pictures in a prompt, by count only. */
  images: number;
  parts: TurnPart[];
}

/**
 * A page of the LLM session an event is in, its turns in order (GET CONTENT_API/llm/:event/session?offset=): at its
 * start for a session, or around the turn for a prompt or reply, each read kept in the trail of content reads.
 */
export interface SessionPage {
  /** Its app by name (Claude Code) and its project's folder. */
  session: { event: number; project: string; app: string };
  /** How many turns the session has, of which `turns` are those from `offset`. */
  total: number;
  offset: number;
  turns: SessionTurn[];
  /** The turn it was opened at, on the first page. */
  focus: number | null;
}

/** How many messages or turns a conversation's page holds. */
export const CONVERSATION_PAGE = 40;
