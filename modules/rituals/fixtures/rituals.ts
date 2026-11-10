// A made-up rituals store for the tests and the testing data (npm run testing-data; sdk/server.ts's ModuleFixtures):
// four weeks of evenings ending on the day it is made (the oldest three imported as rituals' first days were, ticked
// with no doing behind the ticks, wind-down among them once it is asked), their habit times (wind-down's only from the
// day rituals began asking it, so a store made earlier has none) and check-ins, workouts on some of them (a few the testing data's
// made-up Polar workouts, the exercise module's fixtures/polar.ts's recentRuns: a ride two days ago of 48 minutes, a
// run four days ago of 45, a walk six days ago, a ride twelve days ago of 62, so the Fitness page lays them on those;
// the rest workouts of their own, a few of them zone 2, for its weekly zone 2 target), four days a habit was not asked,
// eight weeks of four weekly targets' entries and four temporary items with their marks, written through rituals' own
// store (src/store.ts: import, ritual_put, workout_add, exception_add, target_add, target_log, attachment_add,
// attachment_check), so what the module reads of it is what rituals prints of any store. A pattern, not chance, so
// every store made the same day is the same. Every value is invented; none is anyone's. Written into rituals' root
// (modules/rituals/ of a folder: its data/ritual.sqlite3), where the module reads it (server/view.ts).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { wallClock } from "../../../sdk/server.ts";
import { addDays } from "../../../sdk/wire.ts";
import { sha } from "../src/encoding.ts";
import { habitStarted } from "../src/applicability.ts";
import { isoformatLocal, ritualDate } from "../src/instants.ts";
import { openStore } from "../src/store.ts";
import { viewOf } from "../server/view.ts";
import type { RitualsView } from "../wire.ts";

/** The habits, in rituals' order. */
export const MADE_UP_HABITS = ["magnesium", "protein", "stretching", "planks", "journalling", "wind_down"] as const;

/** The habit with a deadline: asked from rituals' own start for it (HABIT_SINCE), so a store made earlier has none. */
const WIND_DOWN = "wind_down";

/**
 * When the made-up wind-down was done on a closed day `back` days before the open one: before midnight most evenings,
 * after it every fourth, at its first minute (the deadline itself, so red) now and then.
 */
function windDownAt(date: string, back: number): number {
  if (back % 4 === 1) return wallClock(addDays(date, 1), `00:${pad(back % 7 === 1 ? 0 : 15 + back)}`);
  return wallClock(date, `23:${pad((back * 7) % 50)}`);
}

/** How many evenings the store holds, up to the day it is made. */
export const MADE_UP_DAYS = 28;

/** The oldest days, imported as rituals' first days were (a source import: ticks with no doing behind them, no times). */
const IMPORTED_DAYS = 3;

/** The made-up workouts, by how many days before the day the store is made each was logged: its category and what was said of it. */
const WORKOUTS: Readonly<Record<number, ReadonlyArray<{ type: string; details: string }>>> = {
  0: [{ type: "bike", details: "35 min easy spin, zone 2." }],
  1: [{ type: "gym push", details: "Bench press: 20 kg x 8; 40 kg x 10; 50 kg x 6\nOverhead press: 25 kg x 10; 30 kg x 8\nDips: 3 x 12" }],
  2: [{ type: "bike", details: "48 minutes, zone 2" }],
  3: [{ type: "bike", details: "Bike 40 min to the beach and back, zone 2." }],
  4: [{ type: "run", details: "45 min along the river, zone 2 the whole way." }],
  6: [{ type: "walk", details: "Around the block." }],
  8: [{ type: "gym pull", details: "Rows: 40 kg x 8; 45 kg x 8; 45 kg x 8\nPull-ups: 3 x 6\nCurls: 12 kg x 10; 12 kg x 10" }],
  10: [{ type: "run", details: "5 km easy, legs heavy." }],
  12: [{ type: "bike", details: "1h 2m, zone 2 mostly." }],
  13: [{ type: "gym legs", details: "Squats: 60 kg x 5; 70 kg x 5; 80 kg x 5\nLunges: 3 x 10." }],
  15: [{ type: "bike", details: "50 minutes, zone 2" }, { type: "walk", details: "20 min around the block." }],
  19: [{ type: "gym push", details: "Bench press: 40 kg x 10; 50 kg x 8\nDips: 3 x 10" }],
  22: [{ type: "bike", details: "1 hour 15 minutes, zone 2" }],
};

/** How a habit's time is known, in turn: stated, a message's receipt, stated, not known. */
const HABIT_BASES = ["user_stated", "message_received", "user_stated", "unknown"] as const;

/** The made-up weekly targets: a count with its noun, a duration, a distance begun later, and a count drawn as fish. */
const TARGETS: ReadonlyArray<{ id: string; name: string; unit: "count" | "km" | "minutes"; noun?: string; minimum: number; weeks: number; amounts: readonly (readonly number[])[]; notes: readonly string[] }> = [
  // Each week's amounts, the current week first; each on its own day of the week (Monday, Wednesday, Friday, Saturday).
  { id: "made-up-laps", name: "Swim: laps", unit: "count", noun: "laps", minimum: 3, weeks: 8, amounts: [[1, 1, 1], [1, 1], [1, 1, 1, 1], [1, 1, 1], [1], [1, 1, 1], [1, 1], [1, 1, 1]], notes: ["Morning pool", "", "Lunchtime", ""] },
  { id: "made-up-riding", name: "Easy riding", unit: "minutes", minimum: 300, weeks: 8, amounts: [[90, 110], [120, 90, 105], [60, 130], [150, 160], [90, 45, 80], [200, 110], [75, 60], [180, 140]], notes: ["Along the river", "Trainer, low heart rate", "", "To the beach and back"] },
  { id: "made-up-walks", name: "Long walks", unit: "km", minimum: 10, weeks: 3, amounts: [[4.2], [6, 5.5], [3.1, 2.4]], notes: ["Park loop", "", "Hills"] },
  // A count whose noun the dashboard draws as icons, one a fish, rather than as a bar.
  { id: "made-up-fish", name: "Cat: fish", unit: "count", noun: "fish", minimum: 2, weeks: 8, amounts: [[1], [1, 1], [1, 1, 1], [1], [1, 1], [1, 1], [1], [1, 1]], notes: ["Sardines", ""] },
];

/** The made-up temporary items: `started` days before the day the store is made, `ended` days before it (or never). */
const ITEMS: ReadonlyArray<{ id: string; ritual: string; text: string; role: "required_check" | "reminder_only"; started: number; ended: number | null }> = [
  { id: "evening-lay-out-clothes", ritual: "evening", text: "Lay out tomorrow's clothes", role: "reminder_only", started: 9, ended: null },
  { id: "morning-priority-review", ritual: "morning", text: "Reviewed today's priority list", role: "required_check", started: 12, ended: null },
  { id: "noon-reviewed-open-threads", ritual: "noon", text: "Noon: reviewed the open threads list and wrote down which one to close first before lunch", role: "required_check", started: 14, ended: null },
  { id: "morning-cold-shower", ritual: "morning", text: "Cold shower", role: "required_check", started: 20, ended: 6 },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as rituals writes one: Melbourne's wall clock and its offset, to the second. */
const instant = (ms: number): string => isoformatLocal(ms * 1000);

/** The Monday of `day`'s week. */
function mondayOf(day: string): string {
  let monday = day;
  while (new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1) monday = addDays(monday, -1);
  return monday;
}

/** One request to rituals' store, with its provenance: its id, and its words (with the receipt they name, for what was "just" done). */
interface MadeUpRequest {
  readonly op: string;
  readonly [field: string]: unknown;
}

/** How each habit stood on the day `back` days before the open one (0: the open one itself), by its place in rituals' order. */
function madeUpStatus(back: number, habit: number): "done" | "not_done" | "not_applicable" | "unreported" {
  if (back === 0) return habit < 2 ? "done" : "unreported";
  if (habit === 2 && back % 7 === 6) return "not_applicable";
  return (back * 3 + habit * 5) % 7 < 5 ? "done" : "not_done";
}

/** The requests that make the store for the day `today` (rituals' current date), in the order they are sent. */
export function madeUpRequests(today: string): MadeUpRequest[] {
  const requests: MadeUpRequest[] = [];
  const send = (id: string, request: MadeUpRequest, received: string | null = null) =>
    requests.push({ ...request, request_id: `made-up:${id}`, source_text: `Made-up fixture: ${id}.${received === null ? "" : ` Received at ${received}.`}` });
  const day = (back: number) => addDays(today, -back);

  // The oldest days, as a source import: each habit's tick with no doing behind it, a check-in, and the evidence.
  const imported = Array.from({ length: IMPORTED_DAYS }, (_, i) => MADE_UP_DAYS - 1 - i).reverse();
  const document = `Made-up source document.\n${imported.map((back) => `${day(back)} evening: made-up evening checkpoint.`).join("\n")}\n`;
  send("import", {
    op: "import",
    bundle: {
      format: "ritual-source-import-v1",
      documents: [{ id: "made-up-doc", path: "made-up/source.md", sha256: sha(document), content: document }],
      checkpoints: imported.map((back) => ({ id: `made-up-checkpoint-${day(back)}`, date: day(back), checkpoint: "evening", source_id: "made-up-doc", text: "Made-up evening checkpoint." })),
      rituals: imported.map((back) => ({
        date: day(back),
        checkins: [instant(wallClock(day(back), `2${back % 2}:${pad((back * 13) % 60)}`))],
        magnesium: madeUpStatus(back, 0) === "done",
        protein: madeUpStatus(back, 1) === "done",
        stretching: madeUpStatus(back, 2) === "done" ? true : null,
        journalling: madeUpStatus(back, 4) === "done",
        plank_seconds: madeUpStatus(back, 3) === "done" ? 60 + ((back * 17) % 90) : null,
        ...(habitStarted(WIND_DOWN, day(back)) ? { wind_down: madeUpStatus(back, 5) === "done" } : {}),
        notes: null,
      })),
      workouts: [],
      uncertainties: ["Made-up fixture: shaped like a source import, no one's."],
    },
  });

  // A habit not asked now and then: one day each.
  for (let back = 1; back < MADE_UP_DAYS - IMPORTED_DAYS; back++) {
    if (back % 7 === 6) send(`exception:${day(back)}`, { op: "exception_add", record: { habit: "stretching", start_date: day(back), end_date: day(back), reason: "Made-up: not asked that day" } });
  }

  for (let back = MADE_UP_DAYS - IMPORTED_DAYS - 1; back >= 0; back--) {
    const date = day(back);
    const open = back === 0;
    // A day now and then with no report: with workouts it shows "Activities only", without "No report".
    if (open || back % 9 !== 4) {
      const patch: Record<string, unknown> = {};
      const events: Array<{ habit: string; at: number | null; basis: (typeof HABIT_BASES)[number] }> = [];
      MADE_UP_HABITS.forEach((habit, i) => {
        const status = madeUpStatus(back, i);
        if (status === "not_applicable" || status === "unreported") return;
        if (habit === WIND_DOWN && !habitStarted(habit, date)) return;
        if (habit === "planks") {
          if (status === "done") patch.plank_seconds = 60 + ((back * 17) % 90);
          return;
        }
        if (status === "not_done") {
          patch[habit] = false;
          return;
        }
        patch[habit] = true;
        // Two doses of protein now and then; the open day's times not given, since they must not be still to come.
        const doses = habit === "protein" && back % 4 === 2 ? 2 : 1;
        for (let dose = 0; dose < doses; dose++) {
          const basis = open ? "unknown" : HABIT_BASES[(back + i * 3 + dose) % HABIT_BASES.length];
          // Mostly in the evening, a journal now and then after midnight (the evening's still).
          const late = habit === "journalling" && back % 5 === 3;
          const at = habit === WIND_DOWN ? windDownAt(date, back) : wallClock(late ? addDays(date, 1) : date, late ? `00:${pad(20 + back)}` : `${(dose ? 13 : 19) + i}:${pad((back * 7 + i * 11) % 60)}`);
          events.push({ habit, at: basis === "unknown" ? null : at, basis });
        }
      });
      // A check-in most closed days, now and then after midnight; the message's receipt is the check-in itself every
      // third day (so the check-in's time is known from it), else the last habit's time. What was "just" done is at it.
      let checkin: number | null = null;
      if (!open && back % 6 !== 5) {
        const late = back % 5 === 3;
        checkin = wallClock(late ? addDays(date, 1) : date, late ? `00:${pad(10 + back)}` : `${20 + (back % 4)}:${pad((back * 13) % 60)}`);
        patch.checkins = [instant(checkin)];
      }
      const receipt = checkin !== null && back % 3 === 0 ? checkin : Math.max(...events.map((event) => event.at ?? 0), 0);
      send(
        `ritual:${date}`,
        {
          op: "ritual_put", date, patch,
          events: events.map((event) => ({ habit: event.habit, done_at: event.basis === "unknown" ? null : instant(event.basis === "message_received" ? receipt : event.at!), basis: event.basis })),
        },
        receipt > 0 ? instant(receipt) : null,
      );
    }
    (WORKOUTS[back] ?? []).forEach((workout, i) => send(`workout:${date}:${i + 1}`, { op: "workout_add", record: { date, type: workout.type, details: workout.details } }));
  }

  // The weekly targets: the current week (today's week, its Monday) and the seven before it, each target's entries on its own days.
  const monday = mondayOf(today);
  const elapsed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000);
  for (const target of TARGETS) {
    send(`target:${target.id}`, { op: "target_add", record: { id: target.id, name: target.name, unit: target.unit, ...(target.noun ? { noun: target.noun } : {}), minimum: target.minimum, start_date: addDays(monday, -7 * (target.weeks - 1)) } });
    for (let back = target.weeks - 1; back >= 0; back--) {
      const start = addDays(monday, -7 * back);
      target.amounts[back]!.forEach((amount, i) => {
        const offset = [0, 2, 4, 5][i]!;
        const date = addDays(start, back === 0 ? Math.min(offset, elapsed) : offset);
        const note = target.notes[(back + i) % target.notes.length];
        send(`target-log:${target.id}:${date}:${i}`, { op: "target_log", record: { target_id: target.id, date, amount, ...(note ? { note } : {}), logged_by: "made-up-assistant" } });
      });
    }
  }

  // The temporary items: a morning check ticked most mornings with its time, now and then answered no or left unreported,
  // today's still open; a noon one never answered; a cold shower that has ended; and an evening reminder, with no tick.
  for (const item of ITEMS) {
    send(`attachment:${item.id}`, {
      op: "attachment_add",
      record: { id: item.id, ritual: item.ritual, text: item.text, start_date: day(item.started), end_date: item.ended === null ? null : day(item.ended), role: item.role },
    });
    if (item.role === "reminder_only" || item.id === "noon-reviewed-open-threads") continue;
    for (let back = item.started; back >= Math.max(1, item.ended ?? 1); back--) {
      const date = day(back);
      if ((back + item.started) % 5 === 4) {
        send(`check:${item.id}:${date}`, { op: "attachment_check", attachment_id: item.id, date, done: false });
        continue;
      }
      const at = wallClock(date, `0${6 + (back % 3)}:${pad((back * 11) % 60)}`);
      const basis = HABIT_BASES[(back + 1) % HABIT_BASES.length];
      send(
        `check:${item.id}:${date}`,
        { op: "attachment_check", attachment_id: item.id, date, done: true, done_at: basis === "unknown" ? null : instant(at), basis },
        basis === "message_received" ? instant(at) : null,
      );
    }
  }
  return requests;
}

/** A clock stopped at `ms`: the store's "now" while the made-up requests are written, so none is in its future. */
export const stoppedAt = (ms: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => ms,
  currentTimeMillis: Effect.succeed(ms),
  currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n),
  sleep: () => Effect.void,
});

/**
 * Writes the made-up store into rituals' root `root` (data/ritual.sqlite3 under it), through rituals' own store, for
 * the day of `now`, written as at `now` (so a store can be made for any day, a later one too): a new store, or one
 * already there taken on (every request replays by its id). Rituals' backup before each write is not kept: the folder
 * holds the store alone.
 */
export async function writeMadeUpRituals(root: string, now = Date.now()): Promise<void> {
  const requests = madeUpRequests(ritualDate(now * 1000));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openStore(join(root, "data"));
        for (const request of requests) {
          yield* store.request(request).pipe(Effect.mapError((error) => new Error(`the made-up rituals could not be written (${request.request_id}): ${JSON.stringify(error)}`)));
        }
      }),
    ).pipe(Effect.provideService(Clock.Clock, stoppedAt(now)), Effect.provide(NodeServices.layer)),
  );
  await rm(join(root, "data", "backups"), { recursive: true, force: true });
}

/** The made-up store's view at `now`, as the module reads one: written into a folder of its own and read back through rituals' view. */
export async function madeUpRitualsView(now = Date.now()): Promise<RitualsView> {
  const root = await mkdtemp(join(tmpdir(), "life-archive-made-up-rituals-"));
  try {
    await writeMadeUpRituals(root, now);
    return await Effect.runPromise(viewOf(root, now));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
