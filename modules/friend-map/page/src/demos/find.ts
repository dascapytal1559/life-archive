// Finding a person by what they are called, for the Table's search box and
// the map's find box: by name, alias, note and location, whatever the map's
// names; while names are hidden (No name except…) by the name of someone
// picked alone, so it gives no other name away. Pure functions, no DOM.

import type { PersonLocation } from "../archive.ts";
import { locationMatches } from "../locations.ts";
import { goesBy, holds, type Names } from "../names.ts";

/** What finding needs of the name choice (useNames). */
export type FindNames = Pick<Names, "hidden" | "label">;

/** What a person is found by. */
export interface Findable extends PersonLocation {
  id: number;
  name: string;
  aliases: readonly string[];
  note: string;
}

/** The words to find, lower case. */
export function findWords(search: string): string {
  return search.trim().toLowerCase();
}

/** Whether `person` is found by `words` (from findWords, so not empty): while names are hidden, by their shown name alone. */
export function finds(person: Findable, words: string, names: FindNames): boolean {
  if (names.hidden) return holds(names.label(person).primary, words);
  return goesBy(person.name, person.aliases, words) || holds(person.note, words) || locationMatches(person, words);
}

/** How many people the find box lists at once. */
export const FOUND_LISTED = 8;

/**
 * Who Orbits' find box lists for `search`, out of everyone on the map: the
 * closest first (by `rankOf`, 1 the closest, 0 with no closeness yet), then
 * those with no closeness yet, most talked to (`total`) first; at most
 * `limit`, with how many more were found.
 */
export function findOnMap<P extends Findable & { total: number }>(
  people: readonly P[],
  search: string,
  names: FindNames,
  rankOf: (person: P) => number,
  limit = FOUND_LISTED,
): { found: P[]; more: number } {
  const words = findWords(search);
  if (!words) return { found: [], more: 0 };
  // No closeness yet sorts after everyone with some.
  const rank = (p: P) => rankOf(p) || Infinity;
  const found = people
    .filter((p) => finds(p, words, names))
    .sort((a, b) => rank(a) - rank(b) || b.total - a.total || a.id - b.id);
  return { found: found.slice(0, limit), more: Math.max(0, found.length - limit) };
}

/** What a key does in the find box. */
export type FindKey =
  | { do: "clear" }
  | { do: "open" }
  | { do: "move"; to: number }
  | { do: "pick"; index: number };

/**
 * What `key` does in the find box, with its list `listed` or not, `found`
 * people in it and the `active` one (an index into them): Escape clears it,
 * the arrow keys open the list or move through it (round from the last to
 * the first and back), and Enter picks the active one. Null for any other
 * key, or one with nothing to do, which is left to the box.
 */
export function findKey(key: string, list: { listed: boolean; found: number; active: number }): FindKey | null {
  const { listed, found, active } = list;
  if (key === "Escape") return { do: "clear" };
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!listed) return { do: "open" };
    if (found === 0) return null;
    return { do: "move", to: (active + (key === "ArrowDown" ? 1 : -1) + found) % found };
  }
  if (key === "Enter" && listed && active >= 0 && active < found) return { do: "pick", index: active };
  return null;
}
