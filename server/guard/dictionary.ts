// The private dictionary the commit check reads (scan.ts): every person's name and aliases (the captain's own apart),
// every account's display name, handle and id, every chat's title and id, the tags, the locations and the captain's
// notes for people, read from friend map's archive (modules/friend-map/archive.sqlite in the archive's folder,
// server/dataHome.ts; archive.sqlite at the folder's root until the friend map step's move). It is opened
// read-only and never asked for message text. It is read afresh each time the check runs, in well under a second, so
// it is never stale and never copied out of the archive.
//
// Beside it, the archive's folder keeps guard/allow.json: the terms reviewed as not private ("multi": a phrase that is
// also someone's name, say), which the check lets through, and the emails a commit may name as its author or
// committer besides GitHub's noreply ones ("authors"). And guard/private-terms.json: the captain's private terms
// ("terms": his machines' and servers' host names, profile names, tailnet names, home-directory paths, personal email
// addresses, and his family's and his own first names, which one word alone
// the names above never find), which the check stops in every repository, however cased and never shown; it is kept
// by hand, beside the archive and never anywhere else. Without the archive, as on a machine with none, there is no
// dictionary and only the checks that need none run (the private terms still are, where the file is).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Dictionary } from "./scan.ts";

/** A dictionary with nothing in it, its lists its own. */
export const emptyDictionary = (): Dictionary => ({
  person_names: [],
  self_names: [],
  account_names: [],
  account_ids: [],
  self_account_ids: [],
  group_titles: [],
  tags: [],
  locations: [],
  person_text: [],
});

/** The guard's own folder in the archive's folder: allow.json, and each policy's records (records.ts). */
export const guardFolder = (archiveDir: string) => join(archiveDir, "guard");

/** Friend map's archive, where the people's names are: in its module's folder, or at the folder's root until the friend map step's move. */
export const archiveFile = (archiveDir: string) => {
  const moved = join(archiveDir, "modules", "friend-map", "archive.sqlite");
  return existsSync(moved) ? moved : join(archiveDir, "archive.sqlite");
};

/** The archive's names, ids and notes for people, each once, read-only. */
export function readDictionary(file: string): Dictionary {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 10_000 });
  try {
    const d = emptyDictionary();
    const rows = (sql: string) => db.prepare(sql).all() as Record<string, string | number | null>[];
    for (const person of rows("SELECT name, aliases_json, is_self, note, address_book_note FROM person")) {
      const aliases = (JSON.parse(String(person.aliases_json ?? "[]")) as unknown[]).filter((alias): alias is string => typeof alias === "string");
      (person.is_self ? d.self_names : d.person_names).push(String(person.name), ...aliases);
      for (const note of [person.note, person.address_book_note]) if (typeof note === "string" && note.trim()) d.person_text.push(note);
    }
    for (const account of rows("SELECT platform, key, key_kind, display_name, handle, is_self FROM import_person")) {
      (account.is_self ? d.self_names : d.account_names).push(String(account.display_name));
      const ids = [account.handle, account.key_kind === "id" ? account.key : null].filter((id): id is string => typeof id === "string" && id !== "");
      (account.is_self ? d.self_account_ids : d.account_ids).push(...ids.map((id): [string, string] => [String(account.platform), id]));
    }
    for (const chat of rows("SELECT platform, platform_conversation_id, title FROM conversation")) {
      if (chat.title) d.group_titles.push(String(chat.title));
      d.account_ids.push([String(chat.platform), String(chat.platform_conversation_id)]);
    }
    d.tags = rows("SELECT name FROM tag").map((tag) => String(tag.name));
    d.locations = rows("SELECT DISTINCT location FROM person WHERE location IS NOT NULL AND location != ''").map((row) => String(row.location));
    for (const key of Object.keys(d) as (keyof Dictionary)[]) (d[key] as unknown[]) = once(d[key] as unknown[]);
    return d;
  } finally {
    db.close();
  }
}

function once<T>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = JSON.stringify(item);
    return !seen.has(key) && !!seen.add(key);
  });
}

export interface PrivateData {
  dictionary?: Dictionary;
  /** The reviewed terms: words and phrases that are not private. */
  allowed: string[];
  /** The captain's private terms (private-terms.json): none without the file. */
  terms: string[];
  /** One line on anything worth knowing: here, that there is no archive to read. */
  note?: string;
}

/**
 * The dictionary, the reviewed terms and the private terms, from the archive's folder; a dictionary or a
 * private-terms.json that cannot be read is thrown, never passed over.
 */
export function loadPrivateData(archiveDir: string): PrivateData {
  const allowed = readAllowed(archiveDir, "multi");
  const terms = readTerms(archiveDir);
  const file = archiveFile(archiveDir);
  if (!existsSync(file)) return { allowed, terms, note: `no private dictionary (no archive in ${archiveDir}), so only checked for phone numbers, emails, chat ids and host names` };
  return { dictionary: readDictionary(file), allowed, terms };
}

export const termsFile = (archiveDir: string) => join(guardFolder(archiveDir), "private-terms.json");

/** A private-terms.json that is there but cannot be read: a check without it would pass the terms. */
export class TermsUnreadable extends Error {}

/** private-terms.json's "terms": none without the file, and TermsUnreadable when it is there but holds no list of strings. */
export function readTerms(archiveDir: string): string[] {
  const file = termsFile(archiveDir);
  if (!existsSync(file)) return [];
  let terms: unknown;
  try {
    terms = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null)?.terms;
  } catch (error) {
    throw new TermsUnreadable((error as Error).message);
  }
  if (!Array.isArray(terms) || !terms.every((term) => typeof term === "string")) throw new TermsUnreadable(`it has no "terms" list of strings`);
  return terms;
}

export const allowFile = (archiveDir: string) => join(guardFolder(archiveDir), "allow.json");

/** One list from allow.json: "multi", the reviewed terms, or "authors", the emails a commit may name besides GitHub's noreply ones. */
export function readAllowed(archiveDir: string, key: "multi" | "authors"): string[] {
  let allow: Record<string, unknown> | undefined;
  try {
    allow = JSON.parse(readFileSync(allowFile(archiveDir), "utf8"));
  } catch {
    return [];
  }
  const list = allow?.[key];
  return Array.isArray(list) ? list.filter((term): term is string => typeof term === "string") : [];
}

/** How many of each the dictionary holds, as words ("21 person names, 2 self names, ..."), never what. */
export const counts = (dictionary: Dictionary) =>
  Object.entries(dictionary).map(([key, list]) => `${list.length} ${key.replace(/_/g, " ")}`).join(", ");
