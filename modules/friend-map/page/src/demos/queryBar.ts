// What the Query bar (QueryBar.tsx) holds and how it changes, apart from the
// page so it can be tested: one box, where you say who to show in
// words, and the query the view shows (the last one that ran), which is never
// shown itself. Enter in the box has the model write a query from the words
// (Generate) and runs it straight away: it either shows those people, the line
// under the box saying how many and what the model could not put in the query,
// or nothing changes and the line says why. × goes back to everyone. The query that ran, and the
// words it came from, are remembered per browser, the map's and the Table's
// apart. A query that does not run, or that the map refuses because it would
// show more than its limit after Hide, is `failed` (the box and Hide turn red)
// until the words, or Hide, change, or a query runs.

import type { QueryResult } from "../archive.ts";
import { keptAs } from "../demoMode.ts";
import type { HideChoices } from "./hideChoices.ts";
import { locale } from "../time.ts";

/** Which view a Query bar is on: the map views (Orbits and the rest), the one left since the Table folded into Events'. */
export type ViewScope = "map";

/**
 * In place of Generate where there is no model (the static demo, src/demo/examples.ts): what you might say in
 * the box, and the query it becomes. Picking one runs it.
 */
export interface TranscriptExample {
  transcript: string;
  query: string;
}

/** A query to show, with the words it was written from ("" when there are none) and what the model left out of it. */
export interface Filter {
  query: string;
  said: string;
  note: string;
}

export interface QueryBarState {
  /** The box. */
  transcript: string;
  /** The query the view shows: the last one that ran ("" for everyone), with its words and note. */
  applied: Filter;
  /** Generate, or the query it wrote, is waiting on the server. */
  generating: boolean;
  /** The line under the box: how many match, what the model left out, or what went wrong; `from` what. */
  status: { kind: "info" | "error"; text: string; from: "run" | "generate" | "clear" } | null;
  /**
   * The query that last failed to show, the line saying why: it did not run, or
   * the map refused it as too many. Null once the words, or Hide, change, or a query runs.
   */
  failed: Filter | null;
}

/**
 * Why a query ran: Generate (or an example), × (back to everyone), Hide
 * changing (the query counted again under it), or the view running its query
 * again because people changed.
 */
export type RunReason = "generate" | "clear" | "hide" | "again";

export type QueryBarAction =
  | { type: "transcript"; transcript: string }
  /** Escape in the box: back to the words of the query that ran. */
  | { type: "revert" }
  /**
   * A query ran: it is what the view shows now, `count` people after Hide. Run `again` (because people
   * changed), it only refreshes a line the last run wrote; run because Hide
   * changed, it leaves the line as it was, counted under Hide as it was then.
   */
  | { type: "ran"; filter: Filter; count: number; why: RunReason }
  /** A query does not run (one run again that no longer does, too). */
  | { type: "failed"; filter: Filter; error: string }
  /** A query runs but would show `count` people after Hide, over the view's `limit`, so the view keeps what it shows. */
  | { type: "refused"; filter: Filter; count: number; limit: number }
  /** Hide changed: a failure clears, and the bar runs the query again under the new Hide. */
  | { type: "hide" }
  | { type: "generating" }
  | { type: "generateFailed"; error: string };

/** Everyone: no query. */
export const EVERYONE: Filter = { query: "", said: "", note: "" };

export function initialQueryBar(applied: Filter | string): QueryBarState {
  const filter = typeof applied === "string" ? { ...EVERYONE, query: applied } : applied;
  return { transcript: filter.said, applied: filter, generating: false, status: null, failed: null };
}

/** What a refusal says: how many would show, and how to come under the limit (only the map has one; its Hide is at the end of its Query bar). */
export function tooMany(count: number, limit: number): string {
  return `${matchCount(count)}; ask for fewer or hide more in Hide: the limit is ${limit.toLocaleString(locale())}.`;
}

/** "1 person matches", "12 people match". */
export function matchCount(count: number): string {
  return `${count.toLocaleString(locale())} ${count === 1 ? "person matches" : "people match"}`;
}

/**
 * What the line says when a query ran: how many it shows after Hide ("12 people match."), with what the model left
 * out; × says when everyone shows.
 */
function ranLine(filter: Filter, count: number, why: RunReason): string | null {
  if (why === "clear") return "Cleared: everyone shows.";
  if (!filter.query) return null;
  return [`${matchCount(count)}.`, filter.note].filter(Boolean).join(" ");
}

export function queryBarReducer(state: QueryBarState, action: QueryBarAction): QueryBarState {
  switch (action.type) {
    case "transcript":
      return { ...state, transcript: action.transcript, ...(state.failed ? { status: null, failed: null } : {}) };
    case "revert":
      return { ...state, transcript: state.applied.said, status: state.failed ? null : state.status, failed: null };
    case "ran": {
      const text = ranLine(action.filter, action.count, action.why);
      const line = text ? { kind: "info" as const, text, from: action.why === "clear" ? "clear" as const : "run" as const } : null;
      if (action.why === "again") {
        // Run again because people changed: it refreshes only a line about itself, never another query's failure.
        const mine = state.failed === null ? state.status?.from === "run" : state.failed.query === action.filter.query;
        return mine ? { ...state, status: line, failed: null } : state;
      }
      return {
        ...state,
        transcript: action.filter.said,
        applied: action.filter,
        generating: false,
        // Hide changing keeps the line counted under Hide as it was, unless it said why a query failed.
        status: action.why === "hide" && state.failed === null ? state.status : line,
        failed: null,
      };
    }
    case "failed":
      return { ...state, generating: false, status: { kind: "error", text: action.error, from: "run" }, failed: action.filter };
    case "refused":
      return { ...state, generating: false, status: { kind: "error", text: tooMany(action.count, action.limit), from: "run" }, failed: action.filter };
    case "hide":
      return state.failed === null ? state : { ...state, status: null, failed: null };
    case "generating":
      return { ...state, generating: true, status: null };
    case "generateFailed":
      return { ...state, generating: false, status: { kind: "error", text: action.error, from: "generate" } };
  }
}

/**
 * What a query's answer does: it ran, showing those of its ids Hide lets through; or, under a view's
 * `limit` (the map's; the Table has none), when Hide would show more than the
 * limit, it is refused, and the view keeps what it shows.
 */
export function answered(filter: Filter, result: QueryResult, limit: number | undefined, why: RunReason): QueryBarAction {
  return limit !== undefined && result.shown > limit
    ? { type: "refused", filter, count: result.shown, limit }
    : { type: "ran", filter, count: result.shown, why };
}

/**
 * What the view shows from the Query bar: the ids the query that ran matches (null with none, everyone; undefined until
 * it has run), the Hide they were counted under, and `requery`, how many times you have re-queried: a run you asked
 * for (Generate or an example, ×, or Hide changing) that showed. A run again because people or messages changed is none,
 * and nor is a query refused or failing, as the view keeps what it shows. The Spider web replays its scan for each (Orbits.tsx).
 */
export interface Shown {
  only: ReadonlySet<number> | null | undefined;
  hide: HideChoices;
  requery: number;
}

/** Whether two sets of ids hold the same ids. */
function sameIds(a: ReadonlySet<number> | null | undefined, b: ReadonlySet<number>): boolean {
  return !!a && a.size === b.size && [...b].every((id) => a.has(id));
}

/**
 * What the view shows once a query run for `why` shows `matched` under `hide`: the same people again keep the same set,
 * so the map is not built again for nothing, and run again under the same Hide, nothing changes at all; every run
 * you asked for is a requery, the same people or not.
 */
export function nextShown(last: Shown, matched: ReadonlySet<number> | null, hide: HideChoices, why: RunReason): Shown {
  const keep = matched !== null && sameIds(last.only, matched);
  if (keep && hide === last.hide && why === "again") return last;
  return { only: keep ? last.only : matched, hide, requery: why === "again" ? last.requery : last.requery + 1 };
}

/** Whether the box's go button can be pressed: only with words in it, and not while Generate is waiting. */
export function canGo(state: QueryBarState): boolean {
  return state.transcript.trim() !== "" && !state.generating;
}

/**
 * What a key does in the box: "go" presses its go button (Enter, when the
 * button can be pressed; Shift and Enter is a new line), "revert" is Esc putting
 * back the words of the query that ran, "none" swallows an Enter the button
 * can't take, and null leaves the key to the box.
 */
export function keyAction(state: QueryBarState, key: { key: string; shiftKey: boolean }): "go" | "revert" | "none" | null {
  if (key.key === "Enter" && !key.shiftKey) return canGo(state) ? "go" : "none";
  if (key.key === "Escape" && state.transcript.trim() !== state.applied.said.trim()) return "revert";
  return null;
}

/** Where each view's query, and the words it came from, are remembered: apart in demo mode, so it never shows the user's words. */
export const QUERY_KEYS: Record<ViewScope, { query: string; said: string }> = {
  map: { query: keptAs("friend-map.query"), said: keptAs("friend-map.query.said") },
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** The query that last ran here, with its words, or everyone when there is none or it can't be read. */
export function loadQuery(keys: { query: string; said: string }, storage: () => Storage | undefined = browserStorage): Filter {
  try {
    const query = storage()?.getItem(keys.query) ?? "";
    // Words kept for another query (an older page wrote only the query) are not its words.
    const said = query ? storage()?.getItem(keys.said) ?? "" : "";
    return { query, said, note: "" };
  } catch {
    return EVERYONE;
  }
}

export function saveQuery(keys: { query: string; said: string }, filter: Filter, storage: () => Storage | undefined = browserStorage): void {
  try {
    storage()?.setItem(keys.query, filter.query);
    storage()?.setItem(keys.said, filter.said);
  } catch {
    // Not kept: it lasts until the page is reloaded.
  }
}
