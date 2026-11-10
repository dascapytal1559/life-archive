// Location on the page (PersonFields.tsx, the Table): locations as the
// archive writes them, and whether a person matches a search by theirs. Pure
// functions, no DOM. The server keeps them (person.location, see
// server/archive/locations.ts) and checks what is left.

import type { PersonLocation } from "./archive.ts";
import { holds } from "./names.ts";

/** A location as the archive writes it: trimmed and single-spaced, the case as typed. */
export function writtenLocation(draft: string): string {
  return draft.trim().replace(/\s+/g, " ");
}

/** Locations that differ only in case are one. */
export function sameLocation(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether a person's location holds the search's `words`. */
export function locationMatches(person: PersonLocation, words: string): boolean {
  return holds(person.location, words);
}
