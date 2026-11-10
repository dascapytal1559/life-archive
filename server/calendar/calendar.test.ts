// The calendar (db.ts, sink.ts, push.ts) on made-up data: its file, its sink, and a module it cannot ask. The proof the
// captain asked for ("the build must prove the calendar can be rebuilt from the modules") is friend map's
// modules/friend-map/server/calendar.test.ts, over a life archive with the module loaded and the core's own index.

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calendarDayOf, calendarDayStart, EVENTS_DAY_BEGINS } from "../../src/calendarDay.ts";
import { addDays } from "../../src/time.ts";
import { NO_FILTERS } from "../../viewer/wire.ts";
import { transaction } from "../archive/db.ts";
import { Archive } from "../archive/index.ts";
import { coreLedger } from "../archive/coreWrite.ts";
import { isPlatform } from "../connectors/contract.ts";
import type { ArchiveEvent } from "../connectors/contract.ts";
import { PROJECT, writeLlmSessionsFixture } from "../fixtures/llm-sessions.ts";
import { calendarDays } from "../viewer/calendarDays.ts";
import { closeReads, openReads } from "../viewer/connection.ts";
import { CALENDAR_FILE, CALENDAR_SCHEMA_VERSION, calendarVersion, getCalendarMeta, openCalendar, setCalendarMeta } from "./db.ts";
import { CORE, FRIEND_MAP, canonical, rowText, type CalendarRow } from "./rows.ts";
import { CalendarPush } from "./push.ts";
import { EventSink } from "./sink.ts";

const NOW = Date.parse("2026-10-15T10:00:00Z");
const ofKind = (rows: CalendarRow[], kind: string) => rows.filter((row) => row.kind === kind);

describe("the calendar's file", () => {
  it("is made with its schema and keeps what the pushers note in meta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-archive-calendar-db-"));
    try {
      const file = join(dir, CALENDAR_FILE);
      const db = openCalendar(file);
      expect(calendarVersion(db)).toBe(CALENDAR_SCHEMA_VERSION);
      expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect(getCalendarMeta(db, "built")).toBeNull();
      setCalendarMeta(db, "built", "now");
      setCalendarMeta(db, "built", "later");
      expect(getCalendarMeta(db, "built")).toBe("later");
      db.close();
      expect(calendarVersion(openCalendar(file))).toBe(CALENDAR_SCHEMA_VERSION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the event sink", () => {
  const row = (nativeId: string, over: Partial<CalendarRow> = {}): CalendarRow => ({
    module: "sample", origin: "made-up", nativeId, shape: "moment", kind: "thing", subkind: null, at: 1_000, atEnd: null, day: "2026-03-01", self: true,
    direction: null, size: null, hasContent: false, people: [2, 1, 2], facts: { b: 1, a: "x" }, summary: null, ...over,
  });

  it("adds, brings up to date, leaves alone, forgets, and replaces within kinds and days", () => {
    const sink = new EventSink(openCalendar(":memory:"));
    expect(sink.push("sample", [row("a"), row("b")])).toEqual({ added: 2, updated: 0, unchanged: 0, forgotten: 0 });
    // The same rows again, however their facts are ordered and however often someone is named, change nothing.
    expect(sink.push("sample", [row("a", { people: [2, 1], facts: { a: "x", b: 1 } }), row("b")])).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(sink.push("sample", [row("a", { at: 2_000 })])).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(sink.rowsOf("sample").map((r) => [r.nativeId, r.at, r.people])).toEqual([["a", 2_000, [2, 1]], ["b", 1_000, [2, 1]]]);
    expect(sink.forget("sample", [{ origin: "made-up", nativeId: "b" }, { origin: "made-up", nativeId: "nowhere" }])).toBe(1);
    // A replace within a kind forgets only that kind's rows not among the given; a replace within days only those days' summaries.
    sink.push("sample", [row("c", { kind: "other" }), row("d1", { kind: "sum", shape: "day", day: "2026-03-01", summary: { n: 1 } }), row("d2", { kind: "sum", shape: "day", day: "2026-03-02", summary: { n: 2 } })]);
    expect(sink.replace("sample", [row("e")], { kinds: ["thing"] })).toMatchObject({ added: 1, forgotten: 1 });
    expect(sink.rowsOf("sample").map((r) => r.nativeId)).toEqual(["c", "d1", "d2", "e"]);
    expect(sink.replace("sample", [], { kinds: ["sum"], days: ["2026-03-02"] })).toMatchObject({ forgotten: 1 });
    expect(ofKind(sink.rowsOf("sample"), "sum").map((r) => r.nativeId)).toEqual(["d1"]);
    expect(sink.summary()).toEqual([
      { module: "sample", kind: "other", shape: "moment", count: 1, firstDay: "2026-03-01", lastDay: "2026-03-01" },
      { module: "sample", kind: "sum", shape: "day", count: 1, firstDay: "2026-03-01", lastDay: "2026-03-01" },
      { module: "sample", kind: "thing", shape: "moment", count: 1, firstDay: "2026-03-01", lastDay: "2026-03-01" },
    ]);
    expect(sink.modules()).toEqual(["sample"]);
    expect(() => sink.push("other", [row("x")])).toThrow(/pushed as other's/);
  });

  it("compares rows by what they say: their facts in one order, their people each once and in the order given", () => {
    expect(rowText(row("a", { people: [2, 1], facts: { b: 1, a: "x" } }))).toBe(rowText(row("a", { people: [2, 1, 2], facts: { a: "x", b: 1 } })));
    expect(canonical(row("a")).people).toEqual([2, 1]);
    expect(rowText(row("a", { people: [2, 1] }))).not.toBe(rowText(row("a", { people: [1, 2] })));
    expect(rowText(row("a"))).not.toBe(rowText(row("a", { hasContent: true })));
  });
});

describe("a module the calendar cannot ask", () => {
  it("leaves a broken module alone too: nothing can ask its store, so its rows are no drift", async () => {
    const folder = await mkdtemp(join(tmpdir(), "calendar-broken-"));
    const broken = await Archive.open(folder, { stores: { on: [], off: [], broken: [{ id: "sample", folder, problem: "its database could not be opened" }] } });
    try {
      broken.calendar.sink.push("sample", [{
        module: "sample", origin: "made-up", nativeId: "w1", shape: "moment", kind: "workout", subkind: "run", at: NOW, atEnd: NOW + 1_000, day: "2026-10-15", self: true,
        direction: null, size: null, hasContent: false, people: [], facts: {}, summary: null,
      }]);
      expect(broken.calendar.drift()).toEqual([]);
      broken.calendar.rebuild();
      expect(broken.calendar.sink.rowsOf("sample").map((r) => r.nativeId)).toEqual(["w1"]);
    } finally {
      broken.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

});
