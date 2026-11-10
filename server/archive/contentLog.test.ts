import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "./db.ts";
import { openCalendar } from "../calendar/db.ts";
import { ContentLog, FOLD_MS, readerFromEnvironment } from "./contentLog.ts";
import type { SearchHit, TimelineMessage } from "../../src/archive.ts";

let db: Db;
let log: ContentLog;

beforeEach(() => {
  db = openCalendar(":memory:");
  log = new ContentLog(db);
});

afterEach(() => db.close());

describe("the trail of content reads", () => {
  it("keeps each read with where it came from, who, what and why, the latest first", () => {
    log.record({ surface: "cli", reader: "codex", what: "timeline", scope: { person: 12 }, why: "a summary of our chats" }, 1_000);
    log.record({ surface: "app", reader: null, what: "search", scope: { words: "dinner", person: undefined } }, 2_000);
    expect(log.list()).toEqual([
      { id: 2, at: 2_000, lastAt: 2_000, reads: 1, surface: "app", reader: null, what: "search", scope: { words: "dinner" }, why: null },
      { id: 1, at: 1_000, lastAt: 1_000, reads: 1, surface: "cli", reader: "codex", what: "timeline", scope: { person: 12 }, why: "a summary of our chats" },
    ]);
    expect(log.list({ limit: 1 }).map((read) => read.id)).toEqual([2]);
  });

  it("adds the same read again soon after to its row, and starts a new one after a pause or for anything different", () => {
    const read = { surface: "app", reader: null, what: "attachments", scope: { conversation: 41 } } as const;
    log.record(read, 0);
    log.record(read, 60_000);
    log.record(read, 60_000 + FOLD_MS);
    expect(log.list()).toMatchObject([{ id: 1, at: 0, lastAt: 60_000 + FOLD_MS, reads: 3 }]);
    log.record(read, 60_000 + 2 * FOLD_MS + 1);
    expect(log.list().map((row) => [row.id, row.reads])).toEqual([[2, 1], [1, 3]]);
    // Anything else different is another read.
    const now = 60_000 + 2 * FOLD_MS + 2;
    log.record({ ...read, scope: { conversation: 42 } }, now);
    log.record({ ...read, surface: "cli" }, now);
    log.record({ ...read, reader: "claude-code" }, now);
    log.record({ ...read, why: "the photos from the trip" }, now);
    log.record({ ...read, what: "conversation" }, now);
    expect(log.list().map((row) => [row.id, row.reads])).toEqual([[7, 1], [6, 1], [5, 1], [4, 1], [3, 1], [2, 1], [1, 3]]);
  });

  it("takes the reader from LIFE_ARCHIVE_READER, else FRIEND_MAP_READER, trimmed, and none when both are unset or blank", () => {
    expect(readerFromEnvironment({ LIFE_ARCHIVE_READER: " codex " })).toBe("codex");
    expect(readerFromEnvironment({ FRIEND_MAP_READER: " codex " })).toBe("codex");
    expect(readerFromEnvironment({ LIFE_ARCHIVE_READER: "claude-code", FRIEND_MAP_READER: "codex" })).toBe("claude-code");
    expect(readerFromEnvironment({ LIFE_ARCHIVE_READER: "  ", FRIEND_MAP_READER: "codex" })).toBe("codex");
    expect(readerFromEnvironment({ FRIEND_MAP_READER: "  " })).toBeNull();
    expect(readerFromEnvironment({})).toBeNull();
  });
});
