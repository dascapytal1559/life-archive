// The recordings Voice Memos syncs to this Mac (docs/features.md's "Voice journals, transcribed at 6 AM"): which are there,
// what Voice Memos says of each (its start, length and title, from CloudRecordings.db, read-only), whether one has
// finished arriving, and the journal day, times and names an entry of it takes. Nothing here opens a recording's sound
// or a transcript's words; a recording is known by its name, size, times and length.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect } from "effect";
import { dayKey, isMissingFile, isoAt, LOCALE, timeOfDay, TIME_ZONE, wallClock } from "../../../../sdk/server.ts";
import { DAY_STARTS_AT_HOUR, journalDay } from "../../src/day.ts";

/** Where Voice Memos keeps its recordings on this Mac, under a home folder. */
export function voiceMemosFolder(home: string): string {
  return join(home, "Library", "Group Containers", "group.com.apple.VoiceMemos.shared", "Recordings");
}

/** Voice Memos' index of its recordings, beside them. */
export const MEMO_INDEX = "CloudRecordings.db";
/** A recording's file: an .m4a, or the .qta newer iPhones record. */
const AUDIO = /\.(m4a|qta|caf|wav)$/i;
/** A recording's own name, the time on the phone when it began and its id: `20261102 014448-AAAA1111.m4a`. */
const NAMED = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})-([0-9A-F]+)\.\w+$/i;

/** macOS would not let this process list or read Voice Memos' folder: Full Disk Access is missing. */
export class NoAccess extends Data.TaggedError("NoAccess")<{ readonly folder: string; readonly message: string }> {}

export interface Recording {
  /** Its file name in the folder, as Voice Memos named it. */
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** When it appeared on this Mac (when iCloud synced it here). */
  birthtimeMs: number;
}

/** Each recording in the folder: audio files only, none hidden (a copy in progress), none Voice Memos' own. */
export const listRecordings = Effect.fn("listRecordings")(function* (folder: string) {
  const names = yield* Effect.tryPromise({
    try: () => readdir(folder),
    catch: (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return new NoAccess({ folder, message: `this process may not list ${folder}` });
      return new NoAccess({ folder, message: `cannot list ${folder}: ${(error as Error).message}` });
    },
  });
  const recordings: Recording[] = [];
  for (const name of names.filter((n) => !n.startsWith(".") && AUDIO.test(n)).sort()) {
    const path = join(folder, name);
    const info = yield* Effect.promise(() => stat(path).catch(() => null));
    if (!info?.isFile()) continue;
    recordings.push({ name, path, size: info.size, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs });
  }
  return recordings;
});

/** What Voice Memos says of one recording. */
export interface MemoFacts {
  /** When it began, in ms since the epoch. */
  startedAt: number;
  /** Its length in seconds, as Voice Memos has it. */
  seconds: number;
  /** Its title (Voice Memos names a recording for where it was made, "Example St", until it is renamed). */
  title: string | null;
  /** Its date as iCloud keeps it, 2026-11-01T14:44:48Z. */
  cloudDate: string | null;
  /** Deleted in Voice Memos: in Recently Deleted, its file still here until Voice Memos erases it. */
  deleted: boolean;
}

/** Core Data's dates count seconds from 2001-01-01 UTC. */
const CORE_DATA_EPOCH_S = 978_307_200;

/**
 * Voice Memos' index, read-only (it may be writing it): each recording it lists, by file name. Null when there is no
 * index beside the recordings (a scratch folder); NoAccess when there is one this cannot read. Only its dates, lengths,
 * titles and file names are read, and whether each is deleted: Voice Memos sets ZEVICTIONDATE (when it was deleted) on
 * one moved to Recently Deleted and keeps its file, and drops the row when it erases it for good.
 */
export const readMemoIndex = Effect.fn("readMemoIndex")(function* (folder: string) {
  const file = join(folder, MEMO_INDEX);
  const unreadable = (error: unknown) => new NoAccess({ folder, message: `cannot read ${file}: ${(error as Error).message}` });
  const exists = yield* Effect.tryPromise({
    try: () => stat(file).then(() => true, (error) => (isMissingFile(error) ? false : Promise.reject(error))),
    catch: unreadable,
  });
  if (!exists) return null;
  return yield* Effect.try({
    try: () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT ZPATH AS path, ZDATE AS date, ZDURATION AS duration, ZENCRYPTEDTITLE AS title, ZCUSTOMLABEL AS label, ZEVICTIONDATE IS NOT NULL AS deleted " +
            "FROM ZCLOUDRECORDING WHERE ZPATH IS NOT NULL",
        ).all() as Array<{
          path: string;
          date: number | null;
          duration: number | null;
          title: string | null;
          label: string | null;
          deleted: number;
        }>;
        const facts = new Map<string, MemoFacts>();
        for (const row of rows) {
          const deleted = row.deleted === 1;
          // A deleted one is kept whatever its date, so it is never taken for one the index does not list.
          if (row.date === null && !deleted) continue;
          facts.set(row.path.split("/").at(-1)!, {
            startedAt: row.date === null ? 0 : Math.round((row.date + CORE_DATA_EPOCH_S) * 1000),
            seconds: row.duration ?? 0,
            title: row.title || null,
            cloudDate: row.label && /^\d{4}-\d{2}-\d{2}T/.test(row.label) ? row.label : null,
            deleted,
          });
        }
        return facts;
      } finally {
        db.close();
      }
    },
    catch: unreadable,
  });
});

/** When a recording began, from its name (the phone's clock, taken as the archive's), when Voice Memos' index has no word. */
export function startFromName(name: string): number | null {
  const match = NAMED.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return wallClock(`${year}-${month}-${day}`, `${hour}:${minute}`) + Number(second) * 1000;
}

/** Why one the index does not list waits. */
export const UNLISTED = "Voice Memos' index does not list it (not synced yet, or deleted)";

/** How long a recording must sit unchanged before it is taken: Voice Memos (or iCloud) writes it in pieces. */
export const SETTLE_MS = 60_000;
/** How long one may wait, unchanged, on Voice Memos' word on its length before it is taken anyway. */
export const GIVE_UP_WAITING_MS = 6 * 3_600_000;

export type Readiness = { ready: true; doubt: string | null } | { ready: false; why: string };

/**
 * Whether a recording has finished arriving. A recording is still arriving while it is empty or changed within the
 * last minute, while its audio cannot be read through (`probedSeconds` null: a file cut short has no index of its
 * sound), and while Voice Memos' index lists it with a length the file does not reach. One left unchanged for six hours
 * that the index lists shorter is taken, its doubt said. One the index does not list is never taken: Voice Memos drops
 * a recording's row when it erases it for good, so its file left behind is one the captain deleted.
 */
export function readiness(input: {
  size: number;
  mtimeMs: number;
  now: number;
  probedSeconds: number | null;
  /** Voice Memos' facts; undefined when there is no index at all, null when the index does not list it. */
  facts: MemoFacts | null | undefined;
  /** Since when it has waited at this size, if it has. */
  waitingSince: number | null;
}): Readiness {
  if (input.size === 0) return { ready: false, why: "it is empty" };
  if (input.now - input.mtimeMs < SETTLE_MS) return { ready: false, why: "it changed in the last minute" };
  const waitedOut = input.waitingSince !== null && input.now - input.waitingSince >= GIVE_UP_WAITING_MS;
  if (input.probedSeconds === null) return { ready: false, why: "its audio cannot be read through yet" };
  if (input.facts === null) return { ready: false, why: UNLISTED };
  if (input.facts && input.facts.seconds > 0) {
    const short = input.facts.seconds - input.probedSeconds;
    if (short > Math.max(2, input.facts.seconds * 0.01)) {
      const said = `it is ${formatLength(input.probedSeconds)} of the ${formatLength(input.facts.seconds)} Voice Memos lists`;
      return waitedOut ? { ready: true, doubt: said } : { ready: false, why: `${said} (still syncing)` };
    }
  }
  return { ready: true, doubt: null };
}

/** A length as a clock shows it: 35:36, or 2:20:31. */
export function formatLength(seconds: number): string {
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  return hours > 0 ? `${hours}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}


const dateWords = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short", timeZoneName: "short" });

/** When a recording began, as the journal names it. */
export interface Moment {
  /** The journal (ritual) day it belongs to, YYYY-MM-DD. */
  journalDate: string;
  /** The calendar day and time it began, local: 2026-11-02 and 01:44. */
  day: string;
  time: string;
  /** HHMM, the start of its files' names: 0144. */
  hhmm: string;
  /** 2026-11-02T01:44:48+11:00. */
  iso: string;
  /** Mon 2 Nov, and AEDT. */
  weekdayDate: string;
  zone: string;
  /** Whether it is the day before's, being before 06:00. */
  nightBefore: boolean;
}

export function moment(ms: number): Moment {
  const parts = Object.fromEntries(dateWords.formatToParts(ms).map((p) => [p.type, p.value]));
  const day = dayKey(ms);
  const time = timeOfDay(ms);
  const [hour, minute] = time.split(":");
  const nightBefore = Number(hour) < DAY_STARTS_AT_HOUR;
  return {
    journalDate: journalDay(day, Number(hour)),
    day,
    time,
    hhmm: `${hour}${minute}`,
    iso: isoAt(ms),
    weekdayDate: `${parts.weekday} ${parts.day} ${parts.month}`,
    zone: parts.timeZoneName ?? "",
    nightBefore,
  };
}

/** A recording's name with no spaces, as its copy in the journal's assets is named: 20261102-014448-AAAA1111. */
export function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/\s+/g, "-");
}

/** The journal's id for a recording, its source record's source_id: voicememo-20261102-014448-AAAA1111. */
export function sourceIdOf(name: string): string {
  return `voicememo-${stemOf(name)}`;
}
