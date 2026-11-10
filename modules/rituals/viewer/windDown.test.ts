// Wind-down's row on Daily rituals, on rituals' made-up store for Friday 20 November 2026 (../fixtures/rituals.ts), its
// marks worked out by hand from the store's pattern: madeUpStatus for the sixth habit, its times (windDownAt, after
// midnight every fourth day back) and their bases, the day with no report. Green before midnight, red at or after it
// or for a closed day without it, neutral for a tick with no time, and nothing before 9 November, when it began.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Clock, Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { WIND_DOWN_NAME } from "../../../sdk/wire.ts";
import { madeUpRitualsView, stoppedAt, writeMadeUpRituals } from "../fixtures/rituals.ts";
import { ritualsDashboard } from "../server/dashboard.ts";
import { viewOf } from "../server/view.ts";
import { HABIT_COLUMNS } from "../src/dashboard.ts";
import { openStore } from "../src/store.ts";
import type { RitualsDashboard } from "../wire.ts";
import { daySlots, habitRow, habitsOf } from "./dots.ts";
import { ritualsViews } from "./HabitViews.tsx";
import { runCount, runMark, runWords } from "./run.ts";

// 03:00 UTC is 14:00 in Melbourne: the 20th is the open day.
const NOW = Date.parse("2026-11-20T03:00:00Z");
let dashboard: RitualsDashboard;

beforeAll(async () => {
  dashboard = ritualsDashboard(await madeUpRitualsView(NOW));
}, 60_000);

const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];

describe("wind-down's row", () => {
  it("is the sixth habit, begun on 9 November, after journalling", () => {
    expect(dashboard.attachments.active_date).toBe("2026-11-20");
    expect(habitsOf(dashboard.daily)).toEqual(["magnesium", "protein", "stretching", "planks", "journalling", "wind_down"]);
    const row = habitRow(dashboard.daily, "wind_down", "2026-11-20");
    expect([row.name, row.since]).toEqual(["Winding down before midnight", "2026-11-09"]);
    // The days before it began are no dot and not a grey "not asked" either: before the row.
    expect([...row.notAsked]).toEqual([]);
    expect(runMark(row, "2026-11-08")).toBe("before");
  });

  it("is green before midnight, red at or after it, neutral with no time, and a closed day without it red", () => {
    const row = habitRow(dashboard.daily, "wind_down", "2026-11-20");
    expect(DAYS.map((day) => row.dots.get(day)?.mark ?? null)).toEqual(["done", "not_done", "late", "untimed", "done", "done", "not_done", null, "not_done", "done", "late"]);
    expect(row.dots.get("2026-11-20")?.mark).toBe("open");
    expect(DAYS.map((day) => runMark(row, day))).toEqual(["done", "not_done", "late", "untimed", "done", "done", "not_done", "not_done", "not_done", "done", "late"]);
    // Its tooltip says when, how that is known and against what.
    expect(runWords(row, "2026-11-09")).toBe("Done · 23:27 as stated, before midnight");
    expect(runWords(row, "2026-11-18")).toBe("Done · 23:14 message receipt, before midnight");
    expect(runWords(row, "2026-11-19")).toBe("Done · 00:00 as stated, after midnight");
    expect(runWords(row, "2026-11-12")).toBe("Done · time not given");
    expect(runWords(row, "2026-11-16")).toBe("Not done (no answer)");
  });

  it("counts a late or untimed tick as done: its colour says when, its count that it was", () => {
    const row = habitRow(dashboard.daily, "wind_down", "2026-11-20");
    expect([row.done, row.counted]).toEqual([7, 10]);
    expect(runCount(row, daySlots("2026-11-01", "2026-11-19", "2026-11-20"))).toEqual({ done: 7, counted: 11 });
  });

  it("leaves every other habit's marks as they were: no deadline, plain green and red", () => {
    for (const habit of ["magnesium", "protein", "stretching", "planks", "journalling"]) {
      const row = habitRow(dashboard.daily, habit, "2026-11-20");
      expect([...row.dots.values()].every((dot) => dot.mark === "done" || dot.mark === "not_done" || dot.mark === "open")).toBe(true);
    }
  });
});

describe("wind-down's name", () => {
  it("is the console's on Daily rituals' tooltip, last, and on rituals' own dashboards", () => {
    const daily = ritualsViews().find((view) => view.key === "rituals-daily")!;
    expect(daily.blurb).toMatch(/, the morning's and evening's checks and winding down before midnight\.$/);
    expect(daily.blurb).not.toMatch(/wind-down/i);
    expect(Object.fromEntries(HABIT_COLUMNS).wind_down).toBe(WIND_DOWN_NAME);
  });
});

describe("wind-down's today, by the clock", () => {
  // Friday 20 November 2026 in Melbourne (+11): 12:59 UTC is 23:59 that evening, 13:30 UTC is 00:30 the next morning,
  // both before the 06:00 close, so the 20th is the open day either way; the made-up store leaves its wind-down unanswered.
  const BEFORE_MIDNIGHT = Date.parse("2026-11-20T12:59:00Z");
  const AFTER_MIDNIGHT = Date.parse("2026-11-20T13:30:00Z");
  const TODAY = "2026-11-20";

  /** Wind-down's row on the made-up store written and read at `now`, after `then` (a write of its own) if given. */
  async function windDownToday(now: number, then?: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "life-archive-rituals-wind-down-"));
    try {
      await writeMadeUpRituals(root, now);
      if (then) {
        await Effect.runPromise(
          Effect.scoped(Effect.flatMap(openStore(join(root, "data")), (store) => store.request(then))).pipe(Effect.provideService(Clock.Clock, stoppedAt(now)), Effect.provide(NodeServices.layer)),
        );
      }
      const read = ritualsDashboard(await Effect.runPromise(viewOf(root, now, { daysThroughActive: true })));
      expect(read.attachments.active_date).toBe(TODAY);
      return habitRow(read.daily, "wind_down", TODAY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("is hollow at 23:59 with no answer: still going", async () => {
    const row = await windDownToday(BEFORE_MIDNIGHT);
    expect(row.dots.get(TODAY)).toEqual({ mark: "open", words: "Today, still going" });
  }, 60_000);

  it("is red at once at 00:30 with no answer, though its day is open until 06:00, and not counted", async () => {
    const row = await windDownToday(AFTER_MIDNIGHT);
    expect(row.dots.get(TODAY)).toEqual({ mark: "overdue", words: "Not done yet, past midnight" });
    const closed = [...row.dots.entries()].filter(([day]) => day !== TODAY);
    expect(row.counted).toBe(closed.length);
  }, 60_000);

  it("is green at 00:30 when it was ticked at 23:40", async () => {
    const row = await windDownToday(AFTER_MIDNIGHT, {
      op: "ritual_put",
      date: TODAY,
      patch: {},
      events: [{ habit: "wind_down", done_at: "2026-11-20T23:40:00+11:00", basis: "user_stated" }],
      request_id: "made-up:wind-down-before-midnight",
      source_text: "Made-up words: wound down at 11:40. Source ID made-up. 11:40 resolved to 23:40 on ritual date 2026-11-20.",
    });
    expect(row.dots.get(TODAY)).toEqual({ mark: "done", words: "Done · 23:40 as stated, before midnight" });
  }, 60_000);
});

describe("the made-up store's imported days", () => {
  it("answer wind-down once it is asked, so a day imported is never a false 'no answer'", async () => {
    // 20 December 2026: the store's oldest three days, imported, are 23 to 25 November, after wind-down began.
    const later = ritualsDashboard(await madeUpRitualsView(Date.parse("2026-12-20T03:00:00Z")));
    const imported = ["2026-11-23", "2026-11-24", "2026-11-25"];
    const cells = imported.map((day) => later.daily.rows.find((row) => row.date === day)!.cells.wind_down!);
    for (const cell of cells) {
      expect(cell.basis).not.toBe("missing_after_close");
      expect(["done", "not_done"]).toContain(cell.status);
    }
    const row = habitRow(later.daily, "wind_down", later.attachments.active_date);
    for (const day of imported) expect(runWords(row, day)).not.toBe("Not done (no answer)");
  }, 60_000);
});
