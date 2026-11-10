// A row of the calendar (db.ts's event table), as the pushers make it and the sink keeps it: one shape for every
// module. A moment is a card at a time (a call, a hangout, a workout, a habit done, an agent session, prompt or reply);
// a day summary is one row a day with counts (whom the captain messaged, how many messages, how a day's rituals went).
// Never content, and never a name: the people on it are the owning module's own ids, which its hook names at read
// time (owners.ts); its facts are the metadata its tab reads beyond its columns (a sport, a distance, a project folder),
// and a summary carries counts and rituals' own words for its habits, never anyone's.

import { SHAPES } from "./db.ts";

export type EventShape = (typeof SHAPES)[number];

/** The modules the core pushes for, by id: its own parts until each is a module of its own (exercise and rituals are, modules/exercise and modules/rituals, each pushing its own rows under its name). */
export const FRIEND_MAP = "friend-map";
/** The core itself: the conversations with agents fold into the life archive (the captain's call). */
export const CORE = "core";

/** A moment's metadata its tab reads, by key, beyond the row's own columns: plain values only. What a drawer adds, the owner reads from the module. */
export type Facts = Record<string, string | number | boolean | null>;

/** A day summary's counts, and for rituals which habits were done, not done or not yet (rituals' own words for them). */
export type Summary = Record<string, number | string[] | Record<string, string>>;

export interface CalendarRow {
  module: string;
  origin: string;
  nativeId: string;
  shape: EventShape;
  kind: string;
  subkind: string | null;
  at: number;
  atEnd: number | null;
  /** A moment: the local date of `at`; a day summary: its day (the calendar's own, from 06:00: src/calendarDay.ts). */
  day: string;
  self: boolean;
  direction: "in" | "out" | null;
  size: number | null;
  hasContent: boolean;
  /** The owning module's ids of the people on it, each once, in the order the module gives them. */
  people: number[];
  facts: Facts;
  summary: Summary | null;
}

/** The key a row is kept under: its module, origin and the source's own id. */
export interface RowKey {
  module: string;
  origin: string;
  nativeId: string;
}

export const keyOf = (row: RowKey): string => `${row.module}\u0000${row.origin}\u0000${row.nativeId}`;

/** A row with its facts in one order and its people each once, so two rows that say the same are the same text (the sink compares them so). */
export function canonical(row: CalendarRow): CalendarRow {
  return {
    module: row.module,
    origin: row.origin,
    nativeId: row.nativeId,
    shape: row.shape,
    kind: row.kind,
    subkind: row.subkind,
    at: row.at,
    atEnd: row.atEnd,
    day: row.day,
    self: row.self,
    direction: row.direction,
    size: row.size,
    hasContent: row.hasContent,
    people: [...new Set(row.people)],
    facts: sortedKeys(row.facts) as Facts,
    summary: row.summary === null ? null : (sortedKeys(row.summary) as Summary),
  };
}

/** An object's keys A to Z, its nested objects' too, so JSON of it reads the same however it was built. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedKeys(v)]));
}

/** The row as one line of JSON, canonical, for comparing two. */
export const rowText = (row: CalendarRow): string => JSON.stringify(canonical(row));
