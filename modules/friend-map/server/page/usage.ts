// Which views you use, kept on this Mac only: usage.jsonl in the page's folder (savedSettingsPlugin.ts's pageFolder), one
// JSON line per report from an open page. A line says which view, when that
// visit began, when the line was written, and how many seconds the page was
// visible since the visit's last line:
//
//   {"view":"orbits","opened":1790000000000,"at":1790000060000,"seconds":60}
//
// A visit's first line has 0 seconds. Nothing records who was looked at. The
// page reports through POST /friend-map/api/usage (see the page's src/usage.ts;
// pageApi.ts), and friend-map's `npm run usage` prints the summary over a copy.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InvalidInputError } from "../../page/src/invalidInput.ts";
import { isMissingFile } from "../../../../sdk/server.ts";

export interface UsageRecord {
  view: string;
  /** When the visit began, ms since the epoch: the same on every line of one visit. */
  opened: number;
  /** When the line was written. */
  at: number;
  /** Seconds the page was visible since the visit's previous line. */
  seconds: number;
}

export interface ViewUsage {
  view: string;
  lastOpened: number | null;
  last30: { opens: number; minutes: number };
  allTime: { opens: number; minutes: number };
}

const VIEW_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const DAY = 86_400_000;
/** One report never covers more visible time than this; a longer one is a clock or client fault. */
const MAX_SECONDS = 6 * 60 * 60;

export function usageFile(dataDir: string): string {
  return join(dataDir, "usage.jsonl");
}

/** Checks a report from the page and appends it, stamped with the time now. Returns the line written. */
export async function recordUsage(file: string, input: unknown, now = Date.now()): Promise<UsageRecord> {
  const { view, opened, seconds } = (input ?? {}) as Record<string, unknown>;
  if (typeof view !== "string" || !VIEW_PATTERN.test(view)) throw new InvalidInputError("view must be a view's slug");
  if (typeof opened !== "number" || !Number.isFinite(opened) || opened > now + 60_000 || opened < now - 365 * DAY) {
    throw new InvalidInputError("opened must be when the visit began, in ms");
  }
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
    throw new InvalidInputError(`seconds must be between 0 and ${MAX_SECONDS}`);
  }
  const record: UsageRecord = { view, opened: Math.round(opened), at: now, seconds: Math.round(seconds) };
  // The page's folder in the archive's (modules/friend-map/page/) is made by the first write, as on a new folder.
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

/** Every well-formed line of the usage file; a missing file is no usage yet. */
export async function readUsage(file: string): Promise<UsageRecord[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as UsageRecord;
      if (typeof r.view === "string" && typeof r.opened === "number" && typeof r.at === "number" && typeof r.seconds === "number") {
        records.push(r);
      }
    } catch {
      // A line cut short by a crash: skip it.
    }
  }
  return records;
}

/**
 * Per view, in the order of `views` and then any other view found in the
 * records: when it was last opened, and opens and visible minutes in the last
 * 30 days and all time. A visit counts as an open in the window it began in;
 * visible time counts in the window its line was written in.
 */
export function summarizeUsage(records: UsageRecord[], views: string[], now = Date.now()): ViewUsage[] {
  const since = now - 30 * DAY;
  const order = [...views, ...[...new Set(records.map((r) => r.view))].filter((v) => !views.includes(v)).sort()];
  return order.map((view) => {
    const mine = records.filter((r) => r.view === view);
    const visits = new Set(mine.map((r) => r.opened));
    const seconds = (list: UsageRecord[]) => list.reduce((sum, r) => sum + r.seconds, 0);
    return {
      view,
      lastOpened: visits.size > 0 ? [...visits].reduce((a, b) => Math.max(a, b)) : null,
      last30: { opens: [...visits].filter((t) => t >= since).length, minutes: seconds(mine.filter((r) => r.at >= since)) / 60 },
      allTime: { opens: visits.size, minutes: seconds(mine) / 60 },
    };
  });
}
