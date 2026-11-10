// The rituals module on made-up stores only (../fixtures/rituals.ts): the store read in-process, read-only, or why
// there is none; its rows in the calendar (each habit done a moment, keyed as the core keyed them, each day a summary),
// and the Rituals tab of events over them; the watch that keeps the calendar in step with a store written outside the
// server; the RitualWorkouts service the exercise module asks for; and the route, read-only and the page's own.

import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RitualHabits, RitualWorkouts, type CalendarRow, type ModuleContext, type ModuleLive, type PushCounts } from "../../../sdk/server.ts";
import { NO_FILTERS, testingLifeArchive, type TestingLifeArchive } from "../../../sdk/testing.ts";
import { addDays, dayStart } from "../../../sdk/wire.ts";
import { madeUpRitualsView, writeMadeUpRituals } from "../fixtures/rituals.ts";
import rituals from "../module.ts";
import { openStore } from "../src/store.ts";
import { RITUALS_API, RITUALS_DASHBOARD_API, type RitualsAnswer, type RitualsCell, type RitualsDashboardAnswer, type RitualsView } from "../wire.ts";
import { dayRows, habitRows, ritualDaySummary, ritualsRows } from "./calendar.ts";
import { HABITS_TAB } from "./habitsTab.ts";
import { ritualsDashboard } from "./dashboard.ts";
import { createRitualsApi } from "./http.ts";
import { ritualsServices, ritualWorkoutsLayer } from "./service.ts";
import { readRituals, readRitualsNow, RITUALS, ritualsAnswer, ritualsRoot, STORE_FILE, storeFile } from "./view.ts";
import { PUSH_EVERY_MS, ritualsSync } from "./watch.ts";

/** A Wednesday afternoon in Melbourne: rituals' open day is the 4th, and the week runs from Monday 2 November. */
const NOW = Date.parse("2026-11-04T03:00:00Z");

let root: string;
let view: RitualsView;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-rituals-module-"));
  view = await madeUpRitualsView(NOW);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A new archive's folder with the made-up store in its modules/rituals/ (when `withStore`). */
async function folderWith(name: string, withStore = true): Promise<string> {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  if (withStore) await writeMadeUpRituals(ritualsRoot(folder), NOW);
  return folder;
}

/** Logs the made-up `request` into the store at `folder`, as ritualctl would. */
const log = (folder: string, request: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openStore(join(ritualsRoot(folder), "data"));
        yield* store.request(request);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

describe("rituals' store, read in-process", () => {
  it("is rituals' own view of the store in the archive's folder, format 7, every rule applied", async () => {
    const folder = await folderWith("read");
    const read = await Effect.runPromise(ritualsAnswer(folder, NOW));
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.view).toEqual(view);
    expect(read.view.format).toBe(7);
    expect(read.view.daily.rows[0]).toMatchObject({ date: "2026-11-04", period: "open" });
    expect(read.view.daily.rows.slice(1).every((row) => row.period === "closed")).toBe(true);
    expect(read.view.events.some((event) => event.done_at === null)).toBe(true);
    expect(read.view.weekly_targets.weeks.filter((week) => week.current).map((week) => week.week_start)).toEqual(["2026-11-02"]);
    expect(read.view.attachments.items.map((item) => item.ritual)).toEqual(["evening", "morning", "morning", "noon"]);
    expect(readRitualsNow(folder, NOW)).toEqual(view);
    expect(storeFile(folder)).toBe(join(folder, "modules", RITUALS, STORE_FILE));
  });

  it("says the archive has no rituals store when there is none, and why a store cannot be read", async () => {
    const none = await folderWith("none", false);
    expect(await Effect.runPromise(ritualsAnswer(none))).toEqual({ state: "unset", reason: `this archive has no rituals store: modules/rituals/${STORE_FILE} is not in its folder` });
    expect(readRitualsNow(none)).toBeNull();
    const broken = await folderWith("broken", false);
    await mkdir(join(ritualsRoot(broken), "data"), { recursive: true });
    await writeFile(storeFile(broken), "not a database");
    const answer = await Effect.runPromise(ritualsAnswer(broken));
    expect(answer).toMatchObject({ state: "failed", reason: expect.stringMatching(/not a database|file is not a database|malformed/i) });
    expect(() => readRitualsNow(broken)).toThrow(/could not be read/);
    expect(await Effect.runPromise(Effect.result(readRituals(broken)))).toMatchObject({ _tag: "Failure" });
  });
});

const DONE: RitualsCell = { status: "done", basis: "explicit_report", text: "✓", label: "Done", numeric: false };
const NOT_DONE: RitualsCell = { status: "not_done", basis: "explicit_report", text: "×", label: "Not done", numeric: false };
const NOT_ASKED: RitualsCell = { status: "not_applicable", basis: "exception", text: "N/A", label: "Not applicable", numeric: false };
const NOT_YET: RitualsCell = { status: "unreported", basis: "open_day", text: "·", label: "Open — not reported", numeric: false };
const heldFor = (text: string, seconds: number): RitualsCell => ({ status: "done", basis: "explicit_report", text, label: `${seconds} seconds`, numeric: true });
const evening = (date: string, period: string, magnesium: RitualsCell, protein: RitualsCell, stretching: RitualsCell, planks: RitualsCell, journalling: RitualsCell) =>
  ({ date, period, cells: { magnesium, protein, stretching, planks, journalling } });

/**
 * A small made-up view for working the rows out by hand, newest day first, with only what the rows read of it. Melbourne
 * is 11 hours ahead of UTC in these days, so a day's midnight is 13:00 UTC the day before.
 */
const SMALL = {
  daily: {
    rows: [
      evening("2026-10-22", "upcoming", NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET),
      evening("2026-10-21", "open", DONE, NOT_ASKED, NOT_YET, DONE, NOT_YET),
      evening("2026-10-20", "closed", NOT_DONE, NOT_DONE, NOT_DONE, heldFor("2:10", 130), DONE),
      evening("2026-10-19", "closed", DONE, DONE, DONE, heldFor("1:06", 66), NOT_DONE),
      evening("2026-10-18", "closed", NOT_ASKED, NOT_DONE, NOT_DONE, heldFor("1:15", 75), NOT_DONE),
    ],
  },
  events: [
    { id: "he_1", date: "2026-10-19", habit: "magnesium", done_at: "2026-10-19T21:00:00+11:00", basis: "message_received" },
    { id: "he_2", date: "2026-10-19", habit: "planks", done_at: "2026-10-19T21:40:00+11:00", basis: "user_stated" },
    { id: "he_3", date: "2026-10-19", habit: "protein", done_at: "2026-10-20T01:00:00+11:00", basis: "user_stated" },
    { id: "he_4", date: "2026-10-20", habit: "planks", done_at: "2026-10-20T19:00:00+11:00", basis: "user_stated" },
    { id: "he_5", date: "2026-10-20", habit: "planks", done_at: "2026-10-20T20:00:00+11:00", basis: "user_stated" },
    { id: "he_6", date: "2026-10-20", habit: "journalling", done_at: null, basis: "unknown" },
  ],
  attachments: { active_date: "2026-10-21", items: [] },
} as unknown as RitualsView;

describe("the module's rows in the calendar", () => {
  it("are one a habit done, keyed on rituals' id, at its time, how it is known its subkind, and nobody in it", () => {
    const rows = habitRows(view);
    const doings = rows.filter((row) => !row.facts.tick);
    expect(doings.map((row) => row.nativeId).sort()).toEqual(view.events.map((event) => `habit/${event.id}`).sort());
    for (const row of doings) {
      const source = view.events.find((event) => `habit/${event.id}` === row.nativeId)!;
      expect(row).toMatchObject({
        module: RITUALS, origin: RITUALS, shape: "moment", kind: "ritual_habit",
        self: true, direction: null, size: null, hasContent: false, people: [], facts: { habit: source.habit, date: source.date, tick: false }, summary: null,
      });
    }
    expect(new Set(rows.map((row) => row.subkind))).toEqual(new Set(["user_stated", "message_received", "unknown"]));
    // Two doses of protein on a day are two rows; one after midnight is the evening's, the day before its own.
    expect(doings.some((a, i) => doings.some((b, j) => i !== j && a.facts.date === b.facts.date && a.facts.habit === b.facts.habit))).toBe(true);
    expect(doings.some((row) => row.day !== row.facts.date)).toBe(true);
    expect(rows.map((row) => row.at)).toEqual([...rows.map((row) => row.at)].sort((x, y) => x - y));
  });

  it("are one too for each habit a day ticks done with no doing of it, at the day's midnight, a plank as long as its cell says", () => {
    const ticks = habitRows(view).filter((row) => row.facts.tick);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) expect(tick).toMatchObject({ subkind: "unknown", facts: { tick: true } });
    // Planks are reported by their seconds, never as a doing: each is a tick, held as long as its day says.
    const planks = ticks.filter((row) => row.facts.habit === "planks");
    expect(planks.length).toBeGreaterThan(0);
    for (const plank of planks) expect(plank.atEnd).toBeGreaterThan(plank.at);
    // A day rituals is later told a doing of is no longer ticked: the doing is the row.
    const [tick] = ticks.filter((row) => row.facts.habit !== "planks");
    const told = { ...view, events: [...view.events, { id: "he_told", date: String(tick.facts.date), habit: String(tick.facts.habit), done_at: null, basis: "unknown" as const }] };
    const after = habitRows(told).map((row) => row.nativeId);
    expect(after).not.toContain(tick.nativeId);
    expect(after).toContain("habit/he_told");
  });

  it("are one a day rituals shows, closed or still open, never one to come, summed up as done over asked", () => {
    const days = dayRows(view);
    expect(days.map((row) => row.day)).toEqual(view.daily.rows.filter((row) => row.period !== "upcoming").map((row) => row.date).sort());
    for (const day of days) {
      expect(day).toMatchObject({ module: RITUALS, origin: RITUALS, nativeId: `day/${day.day}`, shape: "day", kind: "ritual_day", at: dayStart(day.day), atEnd: dayStart(addDays(day.day, 1)), people: [], facts: {} });
    }
    const open = days.find((day) => day.day === "2026-11-04")!.summary!;
    // The open day asks its habits, then the required checks still on it: the reminder and the ended cold shower are not.
    expect(open).toMatchObject({ done: ["magnesium", "protein"], notYet: ["stretching", "planks", "journalling", "morning-priority-review", "noon-reviewed-open-threads"] });
    // A habit not asked that day is in none of the three; a plank's hold is said by habit.
    const notAsked = days.find((day) => view.daily.rows.find((row) => row.date === day.day)!.cells.stretching.status === "not_applicable")!.summary!;
    expect([...(notAsked.done as string[]), ...(notAsked.notDone as string[]), ...(notAsked.notYet as string[])]).not.toContain("stretching");
    const held = days.find((day) => Object.keys(day.summary!.held as object).length > 0)!.summary!;
    expect((held.held as Record<string, string>).planks).toMatch(/^\d+:[0-5]\d$/);
    expect(ritualDaySummary({ magnesium: DONE, planks: heldFor("1:15", 75), protein: NOT_DONE }))
      .toEqual({ done: ["magnesium", "planks"], notDone: ["protein"], notYet: [], held: { planks: "1:15" } });
    expect(ritualsRows(view)).toHaveLength(habitRows(view).length + days.length);
  });

  it("are a small view's, worked out by hand: its time, how long a lone plank was held, and the day a doing counted for", () => {
    const rows = habitRows(SMALL).map(({ nativeId, subkind, at, atEnd, day, facts }) => [nativeId, subkind, new Date(at).toISOString(), atEnd === null ? null : new Date(atEnd).toISOString(), day, facts]);
    expect(rows).toEqual([
      // A plank told by its seconds alone: its day's midnight, and as long as the cell's 1:15.
      ["tick/2026-10-18/planks", "unknown", "2026-10-17T13:00:00.000Z", "2026-10-17T13:01:15.000Z", "2026-10-18", { habit: "planks", date: "2026-10-18", tick: true }],
      ["tick/2026-10-19/stretching", "unknown", "2026-10-18T13:00:00.000Z", null, "2026-10-19", { habit: "stretching", date: "2026-10-19", tick: true }],
      ["habit/he_1", "message_received", "2026-10-19T10:00:00.000Z", null, "2026-10-19", { habit: "magnesium", date: "2026-10-19", tick: false }],
      // The day's one plank, its cell 1:06: it ends 66 seconds after it.
      ["habit/he_2", "user_stated", "2026-10-19T10:40:00.000Z", "2026-10-19T10:41:06.000Z", "2026-10-19", { habit: "planks", date: "2026-10-19", tick: false }],
      // A doing with no time is at its day's midnight, before the small hours of the evening before.
      ["habit/he_6", "unknown", "2026-10-19T13:00:00.000Z", null, "2026-10-20", { habit: "journalling", date: "2026-10-20", tick: false }],
      // Protein at 1 am on the 20th: the 19th's evening still, on the 20th of the calendar.
      ["habit/he_3", "user_stated", "2026-10-19T14:00:00.000Z", null, "2026-10-20", { habit: "protein", date: "2026-10-19", tick: false }],
      // Two planks on a day: the cell's 2:10 says neither's.
      ["habit/he_4", "user_stated", "2026-10-20T08:00:00.000Z", null, "2026-10-20", { habit: "planks", date: "2026-10-20", tick: false }],
      ["habit/he_5", "user_stated", "2026-10-20T09:00:00.000Z", null, "2026-10-20", { habit: "planks", date: "2026-10-20", tick: false }],
      ["tick/2026-10-21/magnesium", "unknown", "2026-10-20T13:00:00.000Z", null, "2026-10-21", { habit: "magnesium", date: "2026-10-21", tick: true }],
      // A plank's cell that is a mark says no time.
      ["tick/2026-10-21/planks", "unknown", "2026-10-20T13:00:00.000Z", null, "2026-10-21", { habit: "planks", date: "2026-10-21", tick: true }],
    ]);
  });

  it("sum up a small view's days by hand, the one to come left out and a habit not asked in none of the three", () => {
    const days = dayRows(SMALL);
    expect(days.map((row) => [row.day, row.summary])).toEqual([
      ["2026-10-18", { done: ["planks"], notDone: ["protein", "stretching", "journalling"], notYet: [], held: { planks: "1:15" } }],
      ["2026-10-19", { done: ["magnesium", "protein", "stretching", "planks"], notDone: ["journalling"], notYet: [], held: { planks: "1:06" } }],
      ["2026-10-20", { done: ["planks", "journalling"], notDone: ["magnesium", "protein", "stretching"], notYet: [], held: { planks: "2:10" } }],
      ["2026-10-21", { done: ["magnesium", "planks"], notDone: [], notYet: ["stretching", "journalling"], held: {} }],
    ]);
    expect([new Date(days[1].at).toISOString(), new Date(days[1].atEnd!).toISOString()]).toEqual(["2026-10-18T13:00:00.000Z", "2026-10-19T13:00:00.000Z"]);
  });

  it("count each required check on the days it applied, by its id, after the habits; a reminder never", () => {
    const check = (date: string, status: string) => ({ date, status });
    const withChecks = {
      ...SMALL,
      attachments: {
        active_date: "2026-10-21",
        items: [
          { id: "evening-lay-out-clothes", role: "reminder_only", days: [check("2026-10-21", "reminder_only"), check("2026-10-20", "reminder_only")] },
          // Begun on the 20th: the 18th and 19th keep their totals.
          { id: "morning-priority-review", role: "required_check", days: [check("2026-10-21", "unreported"), check("2026-10-20", "done")] },
          // Ended on the 19th, an old day left unanswered: not reported still, as rituals keeps it.
          { id: "morning-cold-shower", role: "required_check", days: [check("2026-10-19", "not_done"), check("2026-10-18", "unreported")] },
        ],
      },
    } as unknown as RitualsView;
    expect(dayRows(withChecks).map((row) => [row.day, row.summary])).toEqual([
      ["2026-10-18", { done: ["planks"], notDone: ["protein", "stretching", "journalling"], notYet: ["morning-cold-shower"], held: { planks: "1:15" } }],
      ["2026-10-19", { done: ["magnesium", "protein", "stretching", "planks"], notDone: ["journalling", "morning-cold-shower"], notYet: [], held: { planks: "1:06" } }],
      ["2026-10-20", { done: ["planks", "journalling", "morning-priority-review"], notDone: ["magnesium", "protein", "stretching"], notYet: [], held: { planks: "2:10" } }],
      ["2026-10-21", { done: ["magnesium", "planks"], notDone: [], notYet: ["stretching", "journalling", "morning-priority-review"], held: {} }],
    ]);
    expect(ritualDaySummary({ magnesium: DONE }, [{ id: "a-check", status: "done" }, { id: "b-check", status: "reminder_only" }])).toEqual({ done: ["magnesium", "a-check"], notDone: [], notYet: [], held: {} });
  });
});

describe("the module in a life archive", () => {
  let folder: string;
  let life: TestingLifeArchive;

  beforeAll(async () => {
    folder = await folderWith("life");
    life = await testingLifeArchive(folder, rituals);
  });
  afterAll(() => life.close());

  it("has its rows in the calendar's rebuild, and nothing to change after", () => {
    expect(life.archive.calendar.drift()).toEqual([]);
    const pushed = life.archive.calendar.sink.rowsOf(RITUALS);
    const own = ritualsRows(readRitualsNow(folder)!);
    expect(pushed).toHaveLength(own.length);
    expect(pushed.map((row) => row.nativeId).sort()).toEqual(own.map((row) => row.nativeId).sort());
  });

  it("answers the Rituals tab of events over its rows: each habit done as a doing, a plank with its hold, the day it was for, and a tick hidden once its doing is known", () => {
    const reads = life.reads();
    const page = { offset: 0, limit: 10_000, sort: "when", direction: "asc" as const, after: null };
    const rows = HABITS_TAB.rows(reads, NO_FILTERS, page).rows;
    const own = habitRows(readRitualsNow(folder)!);
    expect(rows).toHaveLength(own.length);
    const plank = rows.find((row) => row.cells.habit === "Plank" && row.cells.held !== null)!;
    expect(plank.cells.held).toMatch(/^\d+:[0-5]\d$/);
    expect(rows.every((row) => typeof row.cells.day === "string")).toBe(true);
    expect(rows.filter((row) => row.cells.when === null).length).toBe(own.filter((row) => row.subkind === "unknown").length);
    expect(rows.filter((row) => row.cells.basis === "As you said").length).toBe(own.filter((row) => row.subkind === "user_stated").length);
    // A tick the calendar still keeps beside a doing of the same habit that day (a later backfill, before the next push) is left out.
    const tick = own.find((row) => row.facts.tick && row.facts.habit !== "planks")!;
    const doing: CalendarRow = { ...tick, nativeId: "habit/he_backfilled", subkind: "user_stated", at: tick.at + 3600_000, day: tick.day, facts: { ...tick.facts, tick: false } };
    life.module.context.calendar.replace([...own, doing]);
    const after = HABITS_TAB.rows(reads, NO_FILTERS, page).rows;
    expect(after).toHaveLength(own.length);
    expect(after.some((row) => row.cells.day === tick.facts.date && row.cells.habit === "Magnesium" && row.cells.when === tick.at + 3600_000 || row.cells.when === doing.at)).toBe(true);
    life.module.context.calendar.replace(own);
  });

  it("offers the workouts logged in Rituals, read from the store each time, and none with no store", async () => {
    const logged = (at: string) => Effect.runPromise(Effect.flatMap(RitualWorkouts, (service) => service.logged).pipe(Effect.provide(ritualWorkoutsLayer(at))));
    const workouts = await logged(folder);
    // The fixture's fourteen, oldest first: its first 22 days before 4 November, with two on the day 15 before it.
    expect(workouts).toHaveLength(14);
    expect(workouts[0]).toMatchObject({ id: "rituals-2026-10-13-1", day: "2026-10-13", family: "ride", log: { type: "bike", details: "1 hour 15 minutes, zone 2", minutes: 75, zone2: true } });
    expect(workouts.filter((workout) => workout.day === "2026-10-20").map(({ id, family, log }) => [id, family, log.minutes, log.zone2])).toEqual([
      ["rituals-2026-10-20-1", "ride", 50, true],
      ["rituals-2026-10-20-2", "walk", 20, false],
    ]);
    expect(workouts.find((workout) => workout.day === "2026-11-03")).toMatchObject({ family: "other", log: { type: "gym push", minutes: null, zone2: false } });
    expect(await logged(join(root, "nowhere"))).toEqual([]);
  });

  it("offers each day's habits as statuses alone, oldest first, and none with no store", async () => {
    const days = (at: string) => Effect.runPromise(Effect.flatMap(RitualHabits, (service) => service.days).pipe(Effect.provide(ritualsServices(at))));
    const offered = await days(folder);
    const view = readRitualsNow(folder)!;
    expect(offered.map((d) => d.day)).toEqual(view.daily.rows.map((row) => row.date).sort());
    const [newest] = view.daily.rows;
    expect(offered.at(-1)).toEqual({ day: newest.date, habits: Object.fromEntries(Object.entries(newest.cells).map(([habit, cell]) => [habit, cell.status])) });
    // Nothing of a cell but its status: no plank's m:ss, no label.
    expect(new Set(offered.flatMap((d) => Object.values(d.habits)))).toEqual(new Set(offered.flatMap((d) => Object.values(d.habits)).filter((s) => ["done", "not_done", "not_applicable", "unreported"].includes(s))));
    expect(offered.some((d) => d.habits.planks === "done")).toBe(true);
    expect(await days(join(root, "nowhere"))).toEqual([]);
  });

  it("says its drawer leads to the day's messages and its ritual day for a habit done, and nothing for a day", () => {
    const events = rituals.events!(life.module.context);
    const [habit] = habitRows(readRitualsNow(folder)!);
    const date = String(habit.facts.date);
    expect(events.detail("ritual_habit", RITUALS, habit.nativeId)).toEqual({
      more: [],
      views: [
        { label: "Messages that day", kind: "messages", filters: expect.objectContaining({ from: expect.any(Number), to: expect.any(Number) }) },
        { label: "That day's rituals", kind: "ritual-days", filters: expect.objectContaining({ from: dayStart(date), to: dayStart(addDays(date, 1)) }) },
      ],
    });
    expect(events.detail("ritual_habit", RITUALS, "habit/nonesuch")).toBeNull();
    expect(events.detail("ritual_day", RITUALS, "day/2026-11-04")).toBeNull();
    expect(events.labelPeople([1, 2])).toEqual({});
  });
});

describe("the Rituals tab of events over the small view", () => {
  let life: TestingLifeArchive;

  beforeAll(async () => {
    life = await testingLifeArchive(await folderWith("tab", false), rituals);
    life.module.context.calendar.replace(ritualsRows(SMALL));
  });
  afterAll(() => life.close());

  it("filters by habit: each plank with its hold, no When for one with no time, and the day it was for", () => {
    const page = { offset: 0, limit: 100, sort: "when", direction: "asc" as const, after: null };
    const { rows, total } = HABITS_TAB.rows(life.reads(), { ...NO_FILTERS, choices: { habit: ["planks"] } }, page);
    expect(total).toBe(5);
    expect(rows.map(({ cells }) => [cells.when, cells.habit, cells.held, cells.basis, cells.day])).toEqual([
      [null, "Plank", "1:15", "Not known", "2026-10-18"],
      [Date.parse("2026-10-19T10:40:00Z"), "Plank", "1:06", "As you said", "2026-10-19"],
      [Date.parse("2026-10-20T08:00:00Z"), "Plank", null, "As you said", "2026-10-20"],
      [Date.parse("2026-10-20T09:00:00Z"), "Plank", null, "As you said", "2026-10-20"],
      [null, "Plank", null, "Not known", "2026-10-21"],
    ]);
  });

  it("counts by the day, the small hours the day before's when days begin at 06:00, and a row with no time on its own day", () => {
    const byDay = (from: string, to: string, begins?: string) =>
      HABITS_TAB.volume(life.reads(), { ...NO_FILTERS, from: Date.parse(from), to: Date.parse(to) }, { grain: "day", measure: "rituals", split: null, begins }).buckets.map((bucket) => [bucket.day, bucket.value]);
    // 06:00 on the 19th to 06:00 on the 21st. The 19th: its tick, magnesium, the plank and the 1 am protein; the 20th: the journal with no time and two planks.
    expect(byDay("2026-10-18T19:00:00Z", "2026-10-20T19:00:00Z", "06:00")).toEqual([["2026-10-19", 4], ["2026-10-20", 3]]);
    // Midnight to midnight: the 1 am protein is the 20th's.
    expect(byDay("2026-10-18T13:00:00Z", "2026-10-20T13:00:00Z")).toEqual([["2026-10-19", 3], ["2026-10-20", 4]]);
  });

  it("offers each filter's values, in the page's words, with how many rows have each under the other filters", () => {
    const counts = (filters = NO_FILTERS) => {
      const { habit, basis } = HABITS_TAB.facets(life.reads(), filters);
      return { habit: Object.fromEntries(habit.map((value) => [value.value, [value.label, value.count]])), basis: Object.fromEntries(basis.map((value) => [value.value, [value.label, value.count]])) };
    };
    expect(counts()).toEqual({
      habit: { planks: ["Plank", 5], magnesium: ["Magnesium", 2], protein: ["Protein", 1], stretching: ["Stretch", 1], journalling: ["Journal", 1] },
      basis: { unknown: ["Not known", 5], user_stated: ["As you said", 4], message_received: ["Message received", 1] },
    });
    expect(counts({ ...NO_FILTERS, choices: { basis: ["user_stated"] } }).habit).toEqual({ planks: ["Plank", 3], protein: ["Protein", 1] });
  });
});

describe("the watch", () => {
  /** A context over `folder` with the calendar of `life`, counting each push. */
  function watched(folder: string, life: TestingLifeArchive): { context: ModuleContext & ModuleLive; pushes: PushCounts[]; lines: string[] } {
    const pushes: PushCounts[] = [];
    const lines: string[] = [];
    const calendar = life.module.context.calendar;
    const context: ModuleContext & ModuleLive = {
      folder,
      calendar: { ...calendar, replace: (rows: readonly CalendarRow[]) => { const counts = calendar.replace(rows); pushes.push(counts); return counts; } },
      pausingLive: life.module.context.pausingLive,
      host: life.module.context.host,
      contentLog: life.module.context.contentLog,
    };
    return { context, pushes, lines };
  }

  it("pushes the store's rows at its first look, again only when the store changed or five minutes passed, and says what changed", async () => {
    const folder = await folderWith("watch");
    const life = await testingLifeArchive(folder, rituals);
    try {
      // The calendar was built with the module's rows as of the real clock; the first look, at NOW, pushes the rows as of
      // NOW: the same but the open day's summary (closed by the real clock, open at NOW), so nothing is added or forgotten.
      const { context, pushes, lines } = watched(folder, life);
      const { look } = ritualsSync(context, (line) => lines.push(line));
      look(NOW);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ added: 0, forgotten: 0 });
      const said = lines.length;
      look(NOW + 20_000);
      expect(pushes).toHaveLength(1);
      // ritualctl writes a habit: the next look pushes it, and the day's summary with it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await log(folder, { op: "ritual_put", date: "2026-11-04", patch: { stretching: true }, events: [{ habit: "stretching", done_at: null, basis: "unknown" }], request_id: "watch:stretch", source_text: "Made-up fixture: watch." });
      look(NOW + 40_000);
      expect(pushes).toHaveLength(2);
      expect(pushes[1]).toMatchObject({ added: 1, updated: 1, forgotten: 0 });
      expect(lines.slice(said)).toEqual(["the calendar's rituals rows: 1 added, 1 updated, 116 unchanged"]);
      const pushed = life.archive.calendar.sink.rowsOf(RITUALS);
      expect(pushed.some((row) => row.kind === "ritual_habit" && row.facts.date === "2026-11-04" && row.facts.habit === "stretching")).toBe(true);
      expect(pushed.map((row) => row.nativeId).sort()).toEqual(ritualsRows(readRitualsNow(folder, NOW + 40_000)!).map((row) => row.nativeId).sort());
      // Nothing changed, but the clock moved on: pushed again all the same, with nothing to say.
      look(NOW + 40_000 + PUSH_EVERY_MS);
      expect(pushes).toHaveLength(3);
      expect(pushes[2]).toMatchObject({ added: 0, updated: 0, forgotten: 0 });
      expect(lines).toHaveLength(said + 1);
    } finally {
      life.close();
    }
  });

  it("pushes nothing with no store, saying so once, and leaves the calendar as it was when the store cannot be read", async () => {
    const folder = await folderWith("watch-none", false);
    const life = await testingLifeArchive(folder, rituals);
    try {
      const { context, pushes, lines } = watched(folder, life);
      const { look } = ritualsSync(context, (line) => lines.push(line));
      look(NOW);
      look(NOW + 20_000);
      expect(pushes).toEqual([]);
      expect(lines).toEqual([`no store at ${storeFile(folder)}: the calendar's rituals rows are left as they are until there is one`]);
      await mkdir(join(ritualsRoot(folder), "data"), { recursive: true });
      await writeFile(storeFile(folder), "not a database");
      look(NOW + 40_000);
      look(NOW + 60_000);
      expect(pushes).toEqual([]);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/could not be read.*left as they were/);
    } finally {
      life.close();
    }
  });
});

describe("the dashboard tabs' weekly targets", () => {
  const entry = (id: string, date: string, display_date: string, amount: number, amount_text: string) =>
    ({ id, date, display_date, amount, amount_text, note: "Made-up entry note", logged_by: "made-up-assistant" });
  const target = (id: string, unit: string, noun: string | null, entries: ReturnType<typeof entry>[]) =>
    ({ id, name: id, unit, noun, minimum: 3, active: true, position: 0, total: 3, remaining: 0, met: true, fraction: 1, total_text: "3", minimum_text: "3", remaining_text: "0", progress_text: "3 / 3", entries });
  const week = { week_start: "2026-10-26", week_end: "2026-11-01", display: "Oct 26 – Nov 1", full: "26 October to 1 November 2026", current: true, met: 3 };
  const small = {
    daily: { rows: [] },
    attachments: { active_date: "2026-10-29", items: [] },
    weekly_targets: {
      generated_at: "2026-10-29T01:00:00Z", updated_display: "29 Oct, 12:00", timezone: "Australia/Melbourne", active_date: "2026-10-29", current_week: "2026-10-26",
      weeks: [{
        ...week,
        targets: [
          target("laps", "count", "laps", [entry("wte_1", "2026-10-27", "Tue 27", 2, "2 laps"), entry("wte_2", "2026-10-29", "Thu 29", 1, "1 laps")]),
          target("riding", "minutes", null, [entry("wte_3", "2026-10-26", "Mon 26", 90, "1h 30m"), entry("wte_4", "2026-10-28", "Wed 28", 1, "1m")]),
          target("swims", "count", null, []),
        ],
      }],
    },
  } as unknown as RitualsView;

  it("say each target's entries in rituals' words: a single count by its day alone, else with its amount, and when there are none", () => {
    const [week] = ritualsDashboard(small).targets.weeks;
    expect(week.targets.map((row) => row.entries_text)).toEqual(["Tue 27 2 laps · Thu 29", "Mon 26 1h 30m · Wed 28 1m", "Nothing logged yet"]);
  });

  it("keep each target's standing and each entry's day and amount, and lose every entry's note and who logged it", () => {
    const { targets } = ritualsDashboard(small);
    expect(targets.current_week).toBe("2026-10-26");
    expect(targets.weeks[0].targets[0]).toEqual({
      id: "laps", name: "laps", unit: "count", noun: "laps", minimum: 3, active: true, position: 0, total: 3, remaining: 0, met: true, fraction: 1, total_text: "3", minimum_text: "3", remaining_text: "0", progress_text: "3 / 3",
      entries_text: "Tue 27 2 laps · Thu 29",
      entries: [
        { id: "wte_1", date: "2026-10-27", display_date: "Tue 27", amount: 2, amount_text: "2 laps" },
        { id: "wte_2", date: "2026-10-29", display_date: "Thu 29", amount: 1, amount_text: "1 laps" },
      ],
    });
    expect(JSON.stringify(targets)).not.toContain("Made-up entry note");
    expect(JSON.stringify(targets)).not.toContain("made-up-assistant");
  });
});

describe("the module's route", () => {
  let server: Server;
  let port: number;
  let life: TestingLifeArchive;

  beforeAll(async () => {
    const folder = await folderWith("route");
    life = await testingLifeArchive(folder, rituals);
    server = createServer(createRitualsApi(life.module.context, { now: () => NOW }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    life.close();
  });

  function ask(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const out = request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: body.startsWith("{") ? JSON.parse(body) : body }));
      });
      out.on("error", reject);
      out.end();
    });
  }

  it("answers the whole view at the module's address, and the dashboard's under it, without any note or who logged an entry", async () => {
    expect(RITUALS_API).toBe("/life-archive/api/m/rituals");
    expect(RITUALS_DASHBOARD_API).toBe("/life-archive/api/m/rituals/dashboard");
    const whole = await ask(RITUALS_API);
    expect(whole.status).toBe(200);
    expect(whole.body).toEqual({ state: "ok", view });
    const { status, body } = await ask(RITUALS_DASHBOARD_API);
    expect(status).toBe(200);
    const answer = body as RitualsDashboardAnswer;
    expect(answer.state).toBe("ok");
    if (answer.state !== "ok") return;
    expect(answer.dashboard.daily).toEqual(view.daily);
    expect(answer.dashboard.attachments).toEqual(view.attachments);
    expect(Object.keys(answer.dashboard).sort()).toEqual(["attachments", "daily", "targets"]);
    const entries = answer.dashboard.targets.weeks.flatMap((week) => week.targets.flatMap((target) => target.entries));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["amount", "amount_text", "date", "display_date", "id"]);
    const text = JSON.stringify(answer);
    expect(text).not.toContain("made-up-assistant");
    expect(text).not.toContain("Along the river");
    expect(text).not.toContain('"events"');
    // This week by hand, as of Wednesday 4 November: the fixture's three single laps fall on Monday and, its later days
    // not come yet, twice on Wednesday; its riding is 90 and 110 minutes of a 300-minute minimum.
    const [laps, riding] = answer.dashboard.targets.weeks[0].targets;
    expect(laps).toMatchObject({ id: "made-up-laps", entries_text: "Mon 2 · Wed 4 · Wed 4", progress_text: "3 / 3 laps", met: true, fraction: 1 });
    expect(riding).toMatchObject({ id: "made-up-riding", entries_text: "Mon 2 1h 30m · Wed 4 1h 50m", total: 200, minimum: 300, remaining: 100, remaining_text: "1h 40m", progress_text: "3h 20m / 5h", met: false });
    expect(riding.fraction).toBeCloseTo(0.667, 3);
  });

  it("is only read, only by the page itself, and answers nothing else", async () => {
    expect((await ask(RITUALS_API, {}, "POST")).status).toBe(405);
    expect((await ask(RITUALS_API, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await ask(RITUALS_API, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await ask(`${RITUALS_API}/more`)).status).toBe(404);
  });

  it("says why there is no view when the folder has no store", async () => {
    const none = await folderWith("route-none", false);
    const other = await testingLifeArchive(none, rituals);
    const own = createServer(createRitualsApi(other.module.context));
    own.listen(0, "127.0.0.1");
    await once(own, "listening");
    const ownPort = (own.address() as AddressInfo).port;
    try {
      const body = await new Promise<RitualsAnswer>((resolve, reject) => {
        request({ host: "127.0.0.1", port: ownPort, path: RITUALS_API, headers: { host: `localhost:${ownPort}` } }, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve(JSON.parse(text) as RitualsAnswer));
        }).on("error", reject).end();
      });
      expect(body).toMatchObject({ state: "unset", reason: expect.stringContaining("no rituals store") });
    } finally {
      await new Promise((resolve) => own.close(resolve));
      other.close();
    }
  });
});
