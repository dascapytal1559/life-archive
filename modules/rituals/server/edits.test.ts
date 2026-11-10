// Editing a habit's day (edits.ts) through the core's one edit registry (server/edits/), on a made-up store only, each
// change ritualctl's own requests: a habit done set not done (its doings removed, as rituals asks) and the undo that
// puts both back, times and all; a day's habit set done; a habit done's row, opened from the Calendar's card, set not
// done and so gone from the Rituals table; a plank left to rituals; an undo refused once a doing is logged since, and
// allowed again once its undo is undone; two edits at once, each its own number; and the calendar the store's rows after each.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answering, Effect, ForbiddenError, InvalidInputError, NotFoundError, UnavailableError } from "../../../sdk/server.ts";
import { testingLifeArchive, type TableEdits, type TestingLifeArchive } from "../../../sdk/testing.ts";
import { writeMadeUpRituals } from "../fixtures/rituals.ts";
import rituals from "../module.ts";
import { ritualctl } from "./agents.ts";
import { habitRows } from "./calendar.ts";
import { EDITABLE_HABITS } from "./daysTab.ts";
import { readRitualsNow, ritualsRoot } from "./view.ts";

const SOURCE = { surface: "app", who: null, why: null } as const;
// 03:00 UTC is 14:00 in Melbourne on 9 November 2026, the day wind-down joined the ritual: the made-up store's four
// weeks end on it, so its oldest days come before it, and every day of it is closed by the time the edits are made.
const NOW = Date.parse("2026-11-09T03:00:00Z");
const WIND_DOWN_SINCE = "2026-11-09";
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(answering(NotFoundError, InvalidInputError, UnavailableError, ForbiddenError), Effect.flip)) as Promise<Error>;

let root: string;
let folder: string;
let life: TestingLifeArchive;
let edits: TableEdits;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-ritual-edits-"));
  folder = join(root, "data");
  await mkdir(folder, { recursive: true });
  await writeMadeUpRituals(ritualsRoot(folder), NOW);
  life = await testingLifeArchive(folder, rituals);
  edits = life.edits();
}, 60_000);

afterAll(async () => {
  life.close();
  await rm(root, { recursive: true, force: true });
});

const view = () => readRitualsNow(folder)!;
const statusOf = (date: string, habit: string) => view().daily.rows.find((row) => row.date === date)?.cells[habit]?.status;
const dayRow = (date: string) => String((life.archive.calendarDb.prepare("SELECT id FROM event WHERE kind = 'ritual_day' AND native_id = ?").get(`day/${date}`) as { id: number }).id);
const drift = () => life.archive.calendar.drift().map((d) => `${d.nativeId}: ${d.change}`);
const doings = (date: string, habit: string) => view().events.filter((e) => e.date === date && e.habit === habit).map((e) => [e.done_at, e.basis]);

/** A closed day with a habit done and a doing of it on record, and another habit of a closed day not done. */
function pick(): { done: { date: string; habit: string }; notDone: { date: string; habit: string } } {
  const closed = view().daily.rows.filter((row) => row.period === "closed");
  const done = closed.flatMap((row) => EDITABLE_HABITS.filter((h) => row.cells[h]?.status === "done" && doings(row.date, h).length > 0).map((habit) => ({ date: row.date, habit })))[0]!;
  const notDone = closed.flatMap((row) => EDITABLE_HABITS.filter((h) => row.cells[h]?.status === "not_done").map((habit) => ({ date: row.date, habit })))[0]!;
  return { done, notDone };
}

describe("editing a habit's day", () => {
  it("sets a habit done not done, its doings taken off as rituals asks, and its undo puts both back", async () => {
    const { done } = pick();
    const before = doings(done.date, done.habit);
    const row = dayRow(done.date);
    expect(edits.state("ritual-days", row).fields[done.habit]).toEqual({ value: "done" });
    const changed = await Effect.runPromise(edits.edit("ritual-days", row, done.habit, "not_done", SOURCE));
    expect(changed.state!.fields[done.habit]).toEqual({ value: "not_done" });
    expect(statusOf(done.date, done.habit)).toBe("not_done");
    expect(doings(done.date, done.habit)).toEqual([]);
    // The calendar is the store's at once: the day's summary says so, and the doings' rows are gone.
    const summary = JSON.parse((life.archive.calendarDb.prepare("SELECT summary FROM event WHERE id = ?").get(Number(row)) as { summary: string }).summary) as { notDone: string[] };
    expect(summary.notDone).toContain(done.habit);
    expect(drift()).toEqual([]);

    const undone = await Effect.runPromise(edits.undo(changed.edit!, SOURCE));
    expect(undone.state!.fields[done.habit]).toEqual({ value: "done" });
    expect(doings(done.date, done.habit)).toEqual(before);
    expect(drift()).toEqual([]);
    expect(await refusal(edits.undo(changed.edit!, SOURCE))).toBeInstanceOf(UnavailableError);
  }, 60_000);

  it("sets a habit not done done, and refuses its undo once the habit has changed again", async () => {
    const { notDone } = pick();
    const row = dayRow(notDone.date);
    const changed = await Effect.runPromise(edits.edit("ritual-days", row, notDone.habit, "done", SOURCE));
    expect(statusOf(notDone.date, notDone.habit)).toBe("done");
    expect(edits.list({ kind: "ritual-days", id: row })[0]).toMatchObject({ label: expect.any(String), before: "Not done", after: "Done" });
    await Effect.runPromise(edits.edit("ritual-days", row, notDone.habit, "not_done", SOURCE));
    expect(await refusal(edits.undo(changed.edit!, SOURCE))).toBeInstanceOf(UnavailableError);
    expect(drift()).toEqual([]);
  }, 60_000);

  it("sets a habit done's own row not done, from its drawer as the Calendar opens it: the row leaves the Rituals table", async () => {
    const habit = habitRows(view()).find((row) => !row.facts.tick && row.facts.habit !== "planks")!;
    const id = String((life.archive.calendarDb.prepare("SELECT id FROM event WHERE native_id = ?").get(habit.nativeId) as { id: number }).id);
    expect(edits.state("habits", id).fields.done).toEqual({ value: "done" });
    const changed = await Effect.runPromise(edits.edit("habits", id, "done", "not_done", SOURCE));
    expect(changed.gone).toBe(true);
    expect(statusOf(String(habit.facts.date), String(habit.facts.habit))).toBe("not_done");
    const back = await Effect.runPromise(edits.undo(changed.edit!, SOURCE));
    expect(back.gone).toBe(false);
    expect(drift()).toEqual([]);
  }, 60_000);

  it("sets wind-down done on a day it is asked (its first, closed with no answer), and locks a day before it joined the ritual", async () => {
    const row = dayRow(WIND_DOWN_SINCE);
    expect(edits.state("ritual-days", row).fields.wind_down).toEqual({ value: "not_done" });
    await Effect.runPromise(edits.edit("ritual-days", row, "wind_down", "done", SOURCE));
    expect(statusOf(WIND_DOWN_SINCE, "wind_down")).toBe("done");
    // Set by hand, with no time: done, not judged against midnight.
    expect(view().daily.rows.find((r) => r.date === WIND_DOWN_SINCE)!.cells.wind_down!.deadline).toMatchObject({ on_time: null, time_basis: "unknown" });
    expect(drift()).toEqual([]);
    const before = view().daily.rows.find((r) => r.date === "2026-11-08");
    expect(before?.cells.wind_down?.basis).toBe("not_started");
    expect(edits.state("ritual-days", dayRow(before!.date)).fields.wind_down).toMatchObject({ value: null, locked: expect.stringMatching(/not asked/) });
    expect(await refusal(edits.edit("ritual-days", dayRow(before!.date), "wind_down", "done", SOURCE))).toBeInstanceOf(ForbiddenError);
  }, 60_000);

  it("gives a page of the grid the locks each day's state says, on one read of the view", () => {
    const ids = view().daily.rows.slice(0, 20).map((row) => dayRow(row.date));
    const locks = edits.locks("ritual-days", ids);
    for (const id of ids) {
      const locked = Object.fromEntries(Object.entries(edits.state("ritual-days", id).fields).flatMap(([key, field]) => (field.locked ? [[key, field.locked]] : [])));
      expect(locks[id], id).toEqual(locked);
    }
  });

  it("leaves a plank to rituals, and refuses what a day does not take", async () => {
    const row = dayRow(pick().done.date);
    expect(edits.state("ritual-days", row).fields.planks).toBeUndefined();
    expect(await refusal(edits.edit("ritual-days", row, "planks", "done", SOURCE))).toBeInstanceOf(ForbiddenError);
    expect(await refusal(edits.edit("ritual-days", row, "magnesium", "maybe", SOURCE))).toBeInstanceOf(InvalidInputError);
  });

  it("refuses an undo once a doing has been logged since, though the tick is as the edit left it", async () => {
    const closed = view().daily.rows.filter((row) => row.period === "closed");
    const { date, habit } = closed.flatMap((row) => EDITABLE_HABITS.filter((h) => row.cells[h]?.status === "not_done").map((h) => ({ date: row.date, habit: h })))[1]!;
    const changed = await Effect.runPromise(edits.edit("ritual-days", dayRow(date), habit, "done", SOURCE));
    // The bot logs a doing of it since: the tick stays done, and an undo would remove the doing.
    const events = async () => ((await Effect.runPromise(ritualctl(folder, { op: "habit_events", from: date, to: date, habit }))) as { records: unknown[] }).records;
    const left = (await events()).length;
    await Effect.runPromise(ritualctl(folder, {
      op: "ritual_put", date, patch: {}, events: [{ habit, done_at: null, basis: "unknown" }],
      request_id: `made-up-bot-${Date.now()}:ritual`, source_text: `Made-up words. Source ID made-up-bot. Received at ${new Date().toISOString()}.`,
    }));
    expect(await events()).toHaveLength(left + 1);
    expect(await refusal(edits.undo(changed.edit!, SOURCE))).toMatchObject({ message: expect.stringMatching(/a doing logged or removed since/) });
    expect(await events()).toHaveLength(left + 1);
    expect(statusOf(date, habit)).toBe("done");
  }, 60_000);
  it("undoes an edit again once its undo is undone", async () => {
    const { done } = pick();
    const row = dayRow(done.date);
    const changed = await Effect.runPromise(edits.edit("ritual-days", row, done.habit, "not_done", SOURCE));
    const undone = await Effect.runPromise(edits.undo(changed.edit!, SOURCE));
    expect(await refusal(edits.undo(changed.edit!, SOURCE))).toMatchObject({ message: expect.stringMatching(new RegExp(`undone by #${undone.edit}`)) });
    await Effect.runPromise(edits.undo(undone.edit!, SOURCE));
    expect(statusOf(done.date, done.habit)).toBe("not_done");
    // The edit stands again, so it can be undone again.
    await Effect.runPromise(edits.undo(changed.edit!, SOURCE));
    expect(statusOf(done.date, done.habit)).toBe("done");
    expect(drift()).toEqual([]);
  }, 60_000);

  it("gives two edits made at once numbers and request ids of their own", async () => {
    const closed = view().daily.rows.filter((row) => row.period === "closed");
    const two = closed.flatMap((row) => EDITABLE_HABITS.filter((h) => row.cells[h]?.status === "not_done").slice(0, 1).map((habit) => ({ date: row.date, habit }))).slice(-2);
    expect(two).toHaveLength(2);
    const [a, b] = await Effect.runPromise(Effect.all(two.map(({ date, habit }) => edits.edit("ritual-days", dayRow(date), habit, "done", SOURCE)), { concurrency: "unbounded" }));
    expect(a!.edit).not.toBeNull();
    expect(b!.edit).not.toBeNull();
    expect(a!.edit).not.toBe(b!.edit);
    for (const { date, habit } of two) expect(statusOf(date, habit)).toBe("done");
  }, 60_000);
});
