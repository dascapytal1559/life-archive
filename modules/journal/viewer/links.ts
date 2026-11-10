// What a link or picture in a day's Markdown may reach, worked out from its target alone (JournalSection.tsx puts these
// together with the day open): the web, mail and Obsidian's open, a picture of the day's assets/, a raw file of the day.
// A target that is not a well-formed address, or that steps out of where it points, reaches nothing.

import { assetPath, isPlainName } from "../wire.ts";

/** A link opened outside the page: the web, mail, or a note opened in Obsidian (never another of Obsidian's actions, which write to the vault). */
const OUTSIDE = /^(https?:|mailto:|obsidian:\/\/open\?)/i;

export const opensOutside = (href: string): boolean => OUTSIDE.test(href);

const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** The address to show a picture at, for one under assets/<day>/ (each step a name alone), or null. */
export function noteAsset(src: string): string | null {
  const match = /^(?:\.\/)?assets\/(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(src);
  const path = match ? decoded(match[2]!) : null;
  return path !== null && path.split("/").every(isPlainName) ? assetPath(match![1]!, path) : null;
}

/** The name of the file of raw/<day>/ a link is to, or null for any other target. */
export function rawFileOf(target: string, day: string): string | null {
  const file = new RegExp(`^(?:\\./)?raw/${day}/([^/]+)$`).exec(target)?.[1];
  return file === undefined ? null : decoded(file);
}
