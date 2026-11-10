// Rituals' editor (sdk/server.ts's `edits`; the core's server/edits/): a habit's day set done or not done, from a row of
// the Ritual days table (daysTab.ts: each habit of the day) or of the Rituals table (habitsTab.ts: a habit done, its
// drawer opened from the Calendar's card too). The store is rituals' own and written by ritualctl alone, so every
// change is ritualctl's requests (agents.ts's ritualctl), with rituals' rules, revisions, backups and audit:
//
//   done      a day rituals has a record of: `correct` the habit true; a day it has none: `ritual_put` it true, with a
//             doing of unknown time, as rituals asks of a tick (HANDOFF.md's "Habit times")
//   not done  its doings that day removed first (`habit_event_remove`, as rituals refuses to un-tick under them), then
//             `correct` it false, or `ritual_put` it false on a day with no record
//
// Each request's id is the edit's attempt's (life-archive-edit-<n>-<attempt>/<step>), its source text says it was the captain's change in
// the life archive's tables, and the receipt keeps what the habit was (true, false or not reported) and the doings
// removed, with their times, so an undo puts back both: refused when the habit, or its doings that day, have changed since. After either, the
// module's rows are pushed into the calendar at once, as the watch (watch.ts) would on its next look. A plank is its held
// time, logged through rituals itself, so it is not changed here.

import { randomUUID } from "node:crypto";
import {
  Effect, InvalidInputError, NotFoundError, UnavailableError,
  type Applied, type EditMeta, type EditRow, type EditValue, type FieldState, type ModuleContext, type ModuleLive, type TableEditor,
} from "../../../sdk/server.ts";
import { habitRows, PLANKS, ritualsRows } from "./calendar.ts";
import { DAYS_TAB, EDITABLE_HABITS } from "./daysTab.ts";
import { HABITS_TAB } from "./habitsTab.ts";
import { ritualctl } from "./agents.ts";
import { readRitualsNow } from "./view.ts";
import type { RitualsView } from "../wire.ts";

/** A habit as a day's record keeps it: true, false, or null for not reported. */
type Raw = boolean | null;

interface DayRecord {
  date: string;
  revision: number;
  [habit: string]: unknown;
}

interface HabitEvent {
  id: string;
  date: string;
  habit: string;
  done_at: string | null;
  basis: string;
  revision: number;
}

/** What the receipt keeps of a change: the day and habit, what it was and became in the record, the doings it removed and those it left. */
interface Receipt {
  date: string;
  habit: string;
  raw: Raw;
  now: Raw;
  removed: Array<{ done_at: string | null; basis: string }>;
  /** The ids of the doings it left that day (absent from a receipt kept before undo checked them). */
  left?: string[];
}

/** An edit's meta with the attempt's own id, for its requests' ids. */
type Attempt = EditMeta & { attempt: string };

const PLANK_LOCKED = "a plank is its held time: log it through rituals";

/** The editors of the Ritual days and Rituals tables, for the store of the archive kept at `folder`. */
export function ritualsEditors({ folder, calendar }: ModuleContext & ModuleLive): TableEditor[] {
  /** ritualctl's answer, or its refusal as a route error. */
  const ask = (request: Record<string, unknown>) =>
    ritualctl(folder, request).pipe(Effect.mapError((refused) => new UnavailableError(refused.message))) as Effect.Effect<Record<string, unknown>, UnavailableError>;

  const recordOf = (date: string) =>
    Effect.map(ask({ op: "rituals", from: date, to: date }), (answer) => ((answer.records ?? []) as DayRecord[]).find((r) => r.date === date) ?? null);

  const eventsOf = (date: string, habit: string) =>
    Effect.map(ask({ op: "habit_events", from: date, to: date, habit }), (answer) => ((answer.records ?? []) as HabitEvent[]).filter((e) => e.date === date && e.habit === habit));

  /**
   * The request's provenance, as rituals asks every write to carry it: an id of this attempt's own, a fresh one for
   * every apply and undo (two edits at once, or one tried again after a failure part way, never send one id with two
   * payloads), and words saying what it was, naming its edit by the number the record reserved for it.
   */
  const said = (meta: Attempt, step: string, words: string) => ({
    request_id: `life-archive-edit-${meta.edit}-${meta.attempt}/${step}`,
    source_text: `Changed by the captain in the life archive's tables (edit #${meta.edit}${meta.who ? `, by ${meta.who}` : ""}): ${words}.${meta.why ? ` His words: ${meta.why}` : ""}`,
  });

  /** An apply's or an undo's own attempt. */
  const attempt = (meta: EditMeta): Attempt => ({ ...meta, attempt: randomUUID().slice(0, 8) });

  /** Sets `habit` of `date` to `to` in the record (true, false or null), removing its doings first when it is taken off; what was removed. */
  const setRaw = (date: string, habit: string, to: Raw, meta: Attempt, words: string) =>
    Effect.gen(function* () {
      const removed: Receipt["removed"] = [];
      if (to !== true) {
        for (const event of yield* eventsOf(date, habit)) {
          yield* ask({ op: "habit_event_remove", id: event.id, expected_revision: event.revision, reason: "The captain changed the habit's day in the life archive", ...said(meta, `remove-${event.id}`, words) });
          removed.push({ done_at: event.done_at, basis: event.basis });
        }
      }
      const record = yield* recordOf(date);
      if (record) {
        if ((record[habit] ?? null) !== to) {
          yield* ask({ op: "correct", entity: "rituals", id: date, patch: { [habit]: to }, expected_revision: record.revision, reason: "The captain changed it in the life archive's tables", ...said(meta, "correct", words) });
        }
      } else if (to !== null) {
        yield* ask({ op: "ritual_put", date, patch: { [habit]: to }, ...(to ? { events: [{ habit, done_at: null, basis: "unknown" }] } : {}), ...said(meta, "put", words) });
      }
      return removed;
    });

  /** The calendar's rituals rows made the store's again, at once. */
  const push = () =>
    Effect.sync(() => {
      const view = readRitualsNow(folder);
      if (view) calendar.replace(ritualsRows(view));
    });

  /** How `habit` stood on `date` in rituals' view: done, not done, not reported (null), or not asked (locked). */
  const standing = (date: string, habit: string, view = readRitualsNow(folder)): FieldState => {
    if (habit === PLANKS) return { value: null, locked: PLANK_LOCKED };
    const cell = view?.daily.rows.find((row) => row.date === date)?.cells[habit];
    if (!cell || cell.status === "not_applicable") return { value: null, locked: `${habit} was not asked on ${date}` };
    return { value: cell.status === "done" ? "done" : cell.status === "not_done" ? "not_done" : null };
  };

  /** The day and habit a row is of: a day's row and its field, or a habit done's own. */
  const habitOf = (row: EditRow, field: string): { date: string; habit: string } | null => {
    if (row.kind === "ritual_day") return /^day\/(\d{4}-\d{2}-\d{2})$/.test(row.nativeId) ? { date: row.nativeId.slice(4), habit: field } : null;
    if (row.kind !== "ritual_habit") return null;
    const view = readRitualsNow(folder);
    const found = view && habitRows(view).find((habit) => habit.nativeId === row.nativeId);
    return found ? { date: String(found.facts.date), habit: String(found.facts.habit) } : null;
  };

  /** The ids of `habit`'s doings on `date` now, in order. */
  const doingsOf = (date: string, habit: string) => Effect.map(eventsOf(date, habit), (events) => events.map((e) => e.id).sort());

  const apply = (row: EditRow, field: string, value: EditValue, meta: EditMeta) =>
    Effect.gen(function* () {
      const of = habitOf(row, field);
      if (!of) return yield* new NotFoundError(`rituals has no day for ${row.nativeId}`);
      if (of.habit === PLANKS) return yield* new InvalidInputError(PLANK_LOCKED);
      if (!(EDITABLE_HABITS as readonly string[]).includes(of.habit)) return yield* new InvalidInputError(`${of.habit} is not a habit rituals keeps`);
      const before = standing(of.date, of.habit).value;
      const raw = ((yield* recordOf(of.date))?.[of.habit] ?? null) as Raw;
      const to = value === "done";
      const removed = yield* setRaw(of.date, of.habit, to, attempt(meta), `${of.habit} on ${of.date} ${to ? "done" : "not done"}`);
      const left = yield* doingsOf(of.date, of.habit);
      yield* push();
      return { before, after: standing(of.date, of.habit).value, receipt: { date: of.date, habit: of.habit, raw, now: to, removed, left } satisfies Receipt, changed: raw !== to } satisfies Applied;
    });

  const undo = (row: EditRow, _field: string, given: Readonly<Record<string, unknown>>, meta: EditMeta) =>
    Effect.gen(function* () {
      const receipt = given as unknown as Receipt;
      const before = standing(receipt.date, receipt.habit).value;
      const raw = ((yield* recordOf(receipt.date))?.[receipt.habit] ?? null) as Raw;
      const changed = `${receipt.habit} on ${receipt.date} has changed since, so it was left as it is`;
      if (raw !== receipt.now) return yield* new UnavailableError(changed);
      // A doing logged since (the bot's, say) leaves the tick as it was, but an undo would remove it: refused too.
      if (receipt.left && (yield* doingsOf(receipt.date, receipt.habit)).join("\n") !== [...receipt.left].sort().join("\n")) {
        return yield* new UnavailableError(`${receipt.habit} on ${receipt.date} has a doing logged or removed since, so it was left as it is`);
      }
      const words = `${receipt.habit} on ${receipt.date} put back as it was`;
      const own = attempt(meta);
      const removed = yield* setRaw(receipt.date, receipt.habit, receipt.raw, own, words);
      // The doings the change removed come back, each as rituals first recorded it: its time and how the time was known
      // (one known from a message's receipt says that receipt's instant, as rituals asks of it).
      if (receipt.raw === true) {
        for (const [i, doing] of receipt.removed.entries()) {
          const receipt_ = doing.basis === "message_received" && doing.done_at ? ` Received at ${doing.done_at}, as first recorded.` : "";
          const provenance = said(own, `doing-${i}`, `${words}: its doing put back as first recorded`);
          yield* ask({ op: "ritual_put", date: receipt.date, patch: {}, events: [{ habit: receipt.habit, ...doing }], ...provenance, source_text: `${provenance.source_text}${receipt_}` });
        }
      }
      const left = yield* doingsOf(receipt.date, receipt.habit);
      yield* push();
      // A habit done's own row comes back keyed on its doing put back, which rituals gives an id of its own.
      const back = row.kind === "ritual_habit" ? habitRows(readRitualsNow(folder)!).find((r) => r.facts.date === receipt.date && r.facts.habit === receipt.habit) : undefined;
      return {
        before, after: standing(receipt.date, receipt.habit).value, receipt: { date: receipt.date, habit: receipt.habit, raw, now: receipt.raw, removed, left } satisfies Receipt,
        ...(back ? { row: { origin: back.origin, nativeId: back.nativeId } } : {}),
      } satisfies Applied;
    });

  /**
   * An editor over `fields` (a row's fields on rituals' view, read once for each ask): its state one row's, its locks a
   * page of the grid's on one read of the view, as reading it is the whole store's.
   */
  const editor = (table: string, fields: (row: EditRow, view: RitualsView | null) => Record<string, FieldState> | null): TableEditor => ({
    table,
    state: (row) => fields(row, readRitualsNow(folder)),
    locked: (rows) => {
      const view = readRitualsNow(folder);
      return rows.map((row) => {
        const state = fields(row, view);
        return state && Object.fromEntries(Object.entries(state).flatMap(([key, field]) => (field.locked ? [[key, field.locked]] : [])));
      });
    },
    apply,
    undo,
  });

  return [
    editor(DAYS_TAB.spec.kind, (row, view) => {
      if (row.kind !== "ritual_day" || !/^day\/\d{4}-\d{2}-\d{2}$/.test(row.nativeId)) return null;
      const date = row.nativeId.slice(4);
      return Object.fromEntries(EDITABLE_HABITS.map((habit) => [habit, standing(date, habit, view)]));
    }),
    editor(HABITS_TAB.spec.kind, (row, view) => {
      const found = row.kind === "ritual_habit" && view ? habitRows(view).find((habit) => habit.nativeId === row.nativeId) : undefined;
      return found ? { done: standing(String(found.facts.date), String(found.facts.habit), view) } : null;
    }),
  ];
}
