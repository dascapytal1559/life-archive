// The fields the captain edits on a person (name, aliases, tags, note, should
// reach out, location, and drafts), checked and cleaned the same way wherever they come
// from: the page, the CLI, or the person files they were once kept in (legacyFiles.ts).

import { ARCHIVE_TAG, combineNotes, freeText, InvalidInputError, LOCALE, normalizeNote, normalizeTag, SYSTEM_ARCHIVE_TAG, writtenTag } from "../../../sdk/server.ts";

export { combineNotes, normalizeNote, normalizeTag };

/** A name: trimmed, single-spaced, not empty, up to 200 characters. */
export function normalizeName(name: unknown): string {
  if (typeof name !== "string") throw new InvalidInputError("a name is text");
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new InvalidInputError("a name can't be empty");
  if (clean.length > 200) throw new InvalidInputError("a name is at most 200 characters");
  return clean;
}

/** Other names someone goes by, after their name, in order: each a name, without repeats. */
export function normalizeAliases(aliases: unknown): string[] {
  if (!Array.isArray(aliases)) throw new InvalidInputError("aliases must be a list of names");
  const out: string[] = [];
  for (const alias of aliases) {
    const clean = normalizeName(alias);
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * Every name someone goes by, in order, as the person panel's chips show them: their name (the first, their label),
 * then their aliases. Each a name, without repeats, and at least one: nobody is left without a name.
 */
export function normalizeNames(names: unknown): string[] {
  if (!Array.isArray(names)) throw new InvalidInputError("names must be a list of names");
  const clean = normalizeAliases(names);
  if (clean.length === 0) throw new InvalidInputError("a person keeps at least one name");
  return clean;
}


/** A list of tags (see normalizeTag), without repeats. */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new InvalidInputError("tags must be a list");
  return [...new Set(tags.map(normalizeTag))];
}

/**
 * A location ("Brisbane", "Tokyo"): trimmed and single-spaced, as typed (the case is kept; locations that differ
 * only in case are one, see locations.ts), with a letter or digit, up to 60 characters.
 */
export function normalizeLocation(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("a location is text");
  const clean = value.trim().replace(/\s+/g, " ");
  if (!/[\p{L}\p{N}]/u.test(clean)) throw new InvalidInputError(`"${value}" is not a location (it needs a letter or digit)`);
  if (clean.length > 60) throw new InvalidInputError("a location is at most 60 characters");
  return clean;
}



/** A draft, a message the captain is writing to someone (drafts.ts): written as a note is; empty is none. */
export function normalizeDraft(text: unknown): string {
  return freeText(text, "a draft");
}


/** Whether the captain should reach out to them: true or false, nothing else. */
export function normalizeShouldReachOut(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InvalidInputError("should reach out is true or false");
  return value;
}

