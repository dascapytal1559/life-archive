// Fields the captain writes in his own words, checked and cleaned one way wherever they are written: a tag, a note, and
// two notes made one. A person's (friend map's personFields.ts) and an inspiration's (the inspirations module's store.ts) alike.

import { ARCHIVE_TAG, SYSTEM_ARCHIVE_TAG, writtenTag } from "../../src/archive.ts";
import { LOCALE } from "../../src/time.ts";
import { InvalidInputError } from "../errors.ts";

/**
 * A tag, as writtenTag writes it: lowercase, with any run of spaces a dash
 * ("Tokyo era" is "tokyo-era"). Throws InvalidInputError for anything that isn't a short
 * word or hyphenated phrase, and for "system-archive", the old name for the rules' archive (now "archive", one archive).
 */
export function normalizeTag(tag: unknown): string {
  if (typeof tag !== "string") throw new InvalidInputError("a tag is not text");
  const clean = writtenTag(tag);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}&'_-]{0,39}$/u.test(clean)) {
    throw new InvalidInputError(`"${tag}" is not a tag (letters, digits and dashes, up to 40)`);
  }
  if (clean === SYSTEM_ARCHIVE_TAG) throw new InvalidInputError(`"${SYSTEM_ARCHIVE_TAG}" is not a tag: everyone archived, by you or the archive rules, is "${ARCHIVE_TAG}"`);
  return clean;
}

/** The longest note or draft kept. */
const TEXT_MAX = 10_000;

/** A note: free text of any lines, with Windows line ends made plain and space trimmed at either end; empty is no note. */
export function normalizeNote(note: unknown): string {
  return freeText(note, "a note");
}

/** Free text of any lines, its line ends plain and its ends trimmed, up to TEXT_MAX characters. */
export function freeText(text: unknown, what: string): string {
  if (typeof text !== "string") throw new InvalidInputError(`${what} is text`);
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (clean.length > TEXT_MAX) throw new InvalidInputError(`${what} is at most ${TEXT_MAX.toLocaleString(LOCALE)} characters`);
  return clean;
}

/**
 * Two people's notes as one, for a merge: both kept, in order, a blank line
 * between them, without repeating one the other already holds.
 */
export function combineNotes(kept: string, other: string): string {
  if (!other || kept.includes(other)) return kept;
  if (!kept || other.includes(kept)) return other;
  return `${kept}\n\n${other}`;
}
