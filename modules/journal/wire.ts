// What the Journal page and the journal module's server half say to each other (server/http.ts), all under the
// module's own address: the days the vault's Journals/ holds (metadata: names and sizes), and, only as the captain
// opens one, a day (its Journals/<day>.md and what its raw/<day>/ records say of each source), a raw file of it (a
// transcript, the cleaner's edits) and a file of its assets/<day>/ (a recording, played and sought a range at a time,
// or a picture the day shows). Each of those is kept in the trail of content reads before it is answered.
//
//   GET JOURNAL_API/days                        -> JournalDays
//   GET JOURNAL_API/days/:day                   -> JournalDay                       (logged: journal-day)
//   GET JOURNAL_API/days/:day/raw/:file         -> JournalRawFile                   (logged: journal-raw)
//   GET JOURNAL_API/days/:day/assets/:path...   -> the file's bytes, HTTP Range     (logged: journal-asset)

import { moduleApi } from "../../sdk/wire.ts";

/** The journal module's routes. */
export const JOURNAL_API = moduleApi("journal");

/** The folder of the vault the journals are in, and so the folder every route reads inside. */
export const JOURNALS_FOLDER = "Journals";

/** A day's name: its date, YYYY-MM-DD, as Obsidian's daily notes name the day's file. */
export const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

/** What kind of source a raw record is, by its name: a Voice Memos recording, a call (Grok Bot's), or anything else. */
export type SourceKind = "memo" | "call" | "other";

/** One day in the list: what its names and sizes say, never a word of it. */
export interface JournalDayRow {
  /** YYYY-MM-DD. */
  day: string;
  /** The size of Journals/<day>.md in bytes, or null when the day has sources but no journal written yet. */
  bytes: number | null;
  /** Its sources, counted by their records' names in raw/<day>/ (`*.source.json`). */
  memos: number;
  calls: number;
  others: number;
  /** Whether raw/<day>/ holds a cleaner's edit list (`*-edits.md`). */
  edits: boolean;
}

/** GET JOURNAL_API/days. */
export interface JournalDays {
  /** The vault's name, as Obsidian knows it (its folder's): what "Open in Obsidian" opens. */
  vault: string;
  /** Every day, the latest first. */
  days: JournalDayRow[];
}

/** A transcript of a source, by its file in raw/<day>/. */
export interface SourceTranscript {
  /** Who wrote it, in words: OpenSuperWhisper, Nemotron, the call's own transcript. */
  engine: string;
  file: string;
}

/** One source of a day: a recording, a call or another record in raw/<day>/, as its journal-source-v1 record says. */
export interface JournalSource {
  /** Its source_id, or the record's name without `.source.json` when it has none. */
  id: string;
  kind: SourceKind;
  /** When it began, an ISO instant with its offset, or null when the record does not say. */
  at: string | null;
  /** The label the app keeps for it (a Voice Memos title), or null. */
  label: string | null;
  /** How long it is, in seconds, when the record says. */
  seconds: number | null;
  /** Its transcripts, the one the journal was cleaned from first. */
  transcripts: SourceTranscript[];
  /** Its recording, by its path under assets/<day>/ ("voice-memos/…m4a"), or null when it has none kept. */
  audio: string | null;
  /** The cleaner's edit list for it, by its file in raw/<day>/, or null. */
  edits: string | null;
  /** Whether the day's journal cites it (`<!-- sources: … -->`); null when the journal cites no source at all, so nothing can be said. */
  cited: boolean | null;
}

/** GET JOURNAL_API/days/:day. */
export interface JournalDay {
  day: string;
  vault: string;
  /** Journals/<day>.md, as it is on disk, or null when no journal is written for the day yet. */
  markdown: string | null;
  /** When it was last changed, an ISO instant, or null with no journal. */
  modifiedAt: string | null;
  sources: JournalSource[];
  /** The edit lists in raw/<day>/ no source claims, by file. */
  edits: string[];
  /** The recordings in assets/<day>/ no source claims, by their path under it. */
  recordings: string[];
}

/** GET JOURNAL_API/days/:day/raw/:file: a text file of raw/<day>/, as it is. */
export interface JournalRawFile {
  day: string;
  file: string;
  text: string;
}

/** Whether `name` is one step of a path the routes take: a name alone (not empty, not hidden, no `.` or `..`). */
export const isPlainName = (name: string): boolean => name.length > 0 && name.length <= 255 && !name.startsWith(".") && !/[/\\\0]/.test(name);

export const daysPath = (): string => `${JOURNAL_API}/days`;
export const dayPath = (day: string): string => `${JOURNAL_API}/days/${day}`;
export const rawPath = (day: string, file: string): string => `${JOURNAL_API}/days/${day}/raw/${encodeURIComponent(file)}`;
export const assetPath = (day: string, path: string): string => `${JOURNAL_API}/days/${day}/assets/${path.split("/").map(encodeURIComponent).join("/")}`;

/** The day's file in Obsidian, which edits it: obsidian://open with the vault's name and the file's path in it, no extension. */
export function obsidianUrl(vault: string, day: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(`${JOURNALS_FOLDER}/${day}`)}`;
}
