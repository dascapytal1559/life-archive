// The module's rows in the core's calendar (sdk/server.ts's ModuleEvents; docs/events.md's "The calendar"), from rituals' view
// (view.ts): each habit done a moment (kind ritual_habit), and each day rituals shows a day summary (kind ritual_day),
// from which the Events week's Rituals row reads done over asked ("5/5") without reading rituals live. The watch
// (watch.ts) pushes them whole whenever the store changes, and `rows` gives them again for the calendar's rebuild and
// drift check. The same rows, keyed the same, as the core pushed for rituals before it was a module (habit/<id>,
// tick/<day>/<habit>, day/<day>), so the calendar is what it was.
//
// A habit done: one row for each doing rituals records (its view's `events`, keyed on rituals' own id, so a time it
// corrects updates the row), at its time, with how the time is known as its subkind (user_stated, message_received). One
// whose time rituals does not know (basis unknown, done_at null) is at its day's midnight, subkind unknown, as a hangout
// with no time is kept, so the calendar shows it on its day with no time (the captain: "we still want to include an
// event that has a day but not a time"). A habit a day ticks done with no doing of it behind the tick (most days before
// 2026-10-19, when rituals began keeping doings, and the days since that no message gave a time for) is one too, keyed
// on the day and habit (tick/<day>/<habit>), at its day's midnight with subkind unknown (the captain: "I've been doing
// my rituals so it'll be weird for rituals to not show up"); once rituals keeps a doing of that habit that day, the tick
// is no more. A plank ends as long after it as its day's plank cell says (its m:ss), when the day has that one plank:
// rituals keeps a plank's time by the day, not by the doing, so a day of two planks says neither's. Metadata only:
// rituals keeps no words with a doing.
//
// A day: each day rituals shows, closed or still open, never one to come, from its start to its end, summed up as
// which of its items were done, not done and not reported yet and a plank's held time by habit. Its items are the
// habits (in rituals' order) and, since rituals took temporary items (2026-11-05), each required check on the day it
// applied, by its id (the captain: "today it should be five out of seven"). No content: statuses, ids and a time; a
// check's words are the captain's own and stay in rituals. Check-ins and the workouts are on no calendar: nothing draws them (the Fitness page
// reads the workouts through the RitualWorkouts service, service.ts).
//
// The two hooks the Events pages ask the owner of a row through: nobody is in a ritual, and a habit's drawer leads to
// the day's messages and to its ritual day in the Ritual days table.

import { dayOf, only, type CalendarRow, type ModuleEvents, type OwnerDetail } from "../../../sdk/server.ts";
import { addDays, dayKey, dayStart } from "../../../sdk/wire.ts";
import type { RitualsAttachmentDay, RitualsCell, RitualsDay, RitualsView } from "../wire.ts";
import { readRitualsNow, RITUALS } from "./view.ts";

/** The habit whose day's cell says how long it lasted: the plank, its m:ss. */
export const PLANKS = "planks";

/** What every tick's row id begins with: the Rituals tab hides a tick when the calendar has a doing of its habit that day. */
export const TICK_PREFIX = "tick/";

/** The id of the row for a habit `day` ticks done with no doing of it behind the tick. */
export const tickId = (day: string, habit: string): string => `${TICK_PREFIX}${day}/${habit}`;

/** How many seconds a day's plank cell says it was held ("1:06" is 66), or null when it says no time (not done, a mark). */
export function plankSeconds(cell: RitualsCell | undefined): number | null {
  if (!cell || cell.status !== "done" || !cell.numeric) return null;
  const time = /^(\d+):([0-5]\d)$/.exec(cell.text.trim());
  const seconds = time ? Number(time[1]) * 60 + Number(time[2]) : 0;
  return seconds > 0 ? seconds : null;
}

/** A habit done as a row of the calendar: at its time (or its day's midnight), for the ritual's day, its habit and how its time is known. */
function habitRow(nativeId: string, { date, habit, at, held, basis, tick }: { date: string; habit: string; at: number; held: number | null; basis: string; tick: boolean }): CalendarRow {
  return {
    module: RITUALS, origin: RITUALS, nativeId, shape: "moment", kind: "ritual_habit", subkind: basis, at, atEnd: held === null ? null : at + held * 1000, day: dayKey(at),
    self: true, direction: null, size: null, hasContent: false, people: [], facts: { habit, date, tick }, summary: null,
  };
}

/**
 * Each habit done in rituals' view, oldest first, one with no time at its day's midnight; a habit a day ticks done with
 * no doing of it that day is one too, with no time (tickId). A plank lasts as long as its day's plank cell says, when
 * the day has that one plank alone.
 */
export function habitRows(view: RitualsView): CalendarRow[] {
  const cells = new Map(view.daily.rows.map((row) => [row.date, row.cells]));
  const planksOn = new Map<string, number>();
  for (const event of view.events) if (event.habit === PLANKS) planksOn.set(event.date, (planksOn.get(event.date) ?? 0) + 1);
  const rows = view.events.map((event) => {
    const untimed = event.done_at === null || event.basis === "unknown";
    const at = untimed ? dayStart(event.date) : Date.parse(event.done_at!);
    if (!Number.isSafeInteger(at)) throw new Error(`rituals gave a ${event.habit} of ${event.date} a time the calendar cannot read`);
    const held = event.habit === PLANKS && planksOn.get(event.date) === 1 ? plankSeconds(cells.get(event.date)?.[PLANKS]) : null;
    return habitRow(`habit/${event.id}`, { date: event.date, habit: event.habit, at, held, basis: untimed ? "unknown" : event.basis, tick: false });
  });
  const doings = new Set(view.events.map((event) => `${event.date}/${event.habit}`));
  for (const row of view.daily.rows) {
    for (const [habit, cell] of Object.entries(row.cells)) {
      if (cell.status !== "done" || doings.has(`${row.date}/${habit}`)) continue;
      rows.push(habitRow(tickId(row.date, habit), { date: row.date, habit, at: dayStart(row.date), held: habit === PLANKS ? plankSeconds(cell) : null, basis: "unknown", tick: true }));
    }
  }
  return rows.sort((a, b) => a.at - b.at || a.nativeId.localeCompare(b.nativeId));
}

/** A required check as a day had it: its id (rituals' own key for it, never its words) and how it stood. */
export interface DayCheck {
  readonly id: string;
  readonly status: RitualsAttachmentDay["status"];
}

/**
 * A ritual's day summed up: which of its items were done, not done and not reported yet, and a plank's held time by
 * habit. The items are the habits (in rituals' order), then each required check that applied that day (in rituals'
 * order of its temporary items), by id. A check not answered stays not reported, as rituals keeps it, even once the
 * day has closed.
 */
export function ritualDaySummary(cells: RitualsDay["cells"], checks: readonly DayCheck[] = []): NonNullable<CalendarRow["summary"]> {
  const done: string[] = [];
  const notDone: string[] = [];
  const notYet: string[] = [];
  const held: Record<string, string> = {};
  const put = (item: string, status: string) => {
    if (status === "done") done.push(item);
    else if (status === "not_done") notDone.push(item);
    else if (status === "unreported") notYet.push(item);
  };
  for (const [habit, cell] of Object.entries(cells)) {
    put(habit, cell.status);
    const seconds = plankSeconds(cell);
    if (seconds !== null) held[habit] = cell.text.trim();
  }
  for (const check of checks) put(check.id, check.status);
  return { done, notDone, notYet, held };
}

/** Each day's required checks, by date: only the days each applied on (rituals lists those), so a check begun or ended later leaves other days as they were. */
export function checksByDay(view: RitualsView): Map<string, DayCheck[]> {
  const byDay = new Map<string, DayCheck[]>();
  for (const item of view.attachments.items) {
    if (item.role !== "required_check") continue;
    for (const day of item.days) byDay.set(day.date, [...(byDay.get(day.date) ?? []), { id: item.id, status: day.status }]);
  }
  return byDay;
}

/** Each day rituals shows, closed or still open (never one to come), oldest first, as its day summary. */
export function dayRows(view: RitualsView): CalendarRow[] {
  const checks = checksByDay(view);
  return view.daily.rows
    .filter((row) => row.period !== "upcoming")
    .map((row): CalendarRow => ({
      module: RITUALS, origin: RITUALS, nativeId: `day/${row.date}`, shape: "day", kind: "ritual_day", subkind: null, at: dayStart(row.date), atEnd: dayStart(addDays(row.date, 1)), day: row.date,
      self: true, direction: null, size: null, hasContent: false, people: [], facts: {}, summary: ritualDaySummary(row.cells, checks.get(row.date)),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Every row the module pushes for `view`: the habits done, then the days. */
export function ritualsRows(view: RitualsView): CalendarRow[] {
  return [...habitRows(view), ...dayRows(view)];
}

/** The module's answers for its rows, over the store in the archive kept at `folder`. */
export function ritualsEvents(folder: string): ModuleEvents {
  return ritualsEventsOver(() => readRitualsNow(folder));
}

/** The module's answers for its rows, over rituals' view as `read` gives it: the store's now, or the static demo's recorded view (../demo.ts). */
export function ritualsEventsOver(read: () => RitualsView | null): ModuleEvents {
  return {
    labelPeople: () => ({}),
    detail: (kind, _origin, nativeId): OwnerDetail | null => {
      if (kind !== "ritual_habit") return null;
      const view = read();
      const row = view && habitRows(view).find((habit) => habit.nativeId === nativeId);
      if (!row) return null;
      const date = String(row.facts.date);
      return {
        more: [],
        views: [
          { label: "Messages that day", kind: "messages", filters: only(dayOf(row.at)) },
          // Its ritual day in the Ritual days table (daysTab.ts), where each habit of the day is set done or not.
          { label: "That day's rituals", kind: "ritual-days", filters: only({ from: dayStart(date), to: dayStart(addDays(date, 1)) }) },
        ],
      };
    },
    rows: () => {
      const view = read();
      return view ? ritualsRows(view) : [];
    },
  };
}
