// The Ritual days table, the module's (sdk/server.ts's `tabs`): one row for each day rituals shows (the calendar's
// ritual_day rows, this module's, pushed from its store: calendar.ts's dayRows), with how each habit stood that day,
// done, not done or not reported yet, a plank's held time, and how many of the day's items were done of those asked
// (its required checks among them, by rituals' own count). It is the table where a habit day is changed, done or not
// (edits.ts, the module's editor; the captain's "rituals' habit days (done or not)"); a habit done in the Rituals
// table, opened from the Calendar's card, changes the same way. Statuses only, never a word: a check's words are the
// captain's own and stay in rituals.

import { dateText, sourceTab, type SourceRow } from "../../../sdk/server.ts";
import { habitDoing } from "../../../sdk/wire.ts";
import { PLANKS } from "./calendar.ts";
import { RITUALS } from "./view.ts";

/** The habits a day's row shows, in rituals' order. */
export const DAY_HABITS = ["magnesium", "protein", "stretching", "planks", "journalling", "wind_down"] as const;

/** The habits a day's row can be changed for: a plank is its held time, which is logged through rituals itself. */
export const EDITABLE_HABITS = DAY_HABITS.filter((habit) => habit !== PLANKS);

/** What a habit's day can be set to. */
export const HABIT_CHOICES = [{ value: "done", label: "Done" }, { value: "not_done", label: "Not done" }];

const SOURCE = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.day, e.summary,
    json_array_length(e.summary, '$.done') AS done,
    json_array_length(e.summary, '$.done') + json_array_length(e.summary, '$.notDone') + json_array_length(e.summary, '$.notYet') AS asked
  FROM event e WHERE e.kind = 'ritual_day'`;

/** How a habit stood on a day, in its day summary's words: Done (a plank its held time), Not done, Not yet; null for one not asked. */
function standing(summary: { done: string[]; notDone: string[]; notYet: string[]; held: Record<string, string> }, habit: string): string | null {
  if (summary.done.includes(habit)) return summary.held[habit] ?? "Done";
  if (summary.notDone.includes(habit)) return "Not done";
  if (summary.notYet.includes(habit)) return "Not yet";
  return null;
}

export const DAYS_TAB = sourceTab({
  kind: "ritual-days",
  label: "Ritual days",
  noun: ["ritual day", "ritual days"],
  module: RITUALS,
  columns: [
    { key: "day", label: "Day", kind: "time", width: 130, sortable: true },
    ...DAY_HABITS.map((habit) => ({ key: habit, label: habitDoing(habit), kind: "text" as const, width: 120 })),
    { key: "done", label: "Done", kind: "text", width: 90, numeric: true, sortable: true },
  ],
  sort: "day",
  edits: EDITABLE_HABITS.map((habit) => ({ key: habit, label: habitDoing(habit), input: "choice" as const, choices: HABIT_CHOICES })),
  splits: [],
  sorts: { day: "at", done: "done" },
  source: SOURCE,
  undated: { when: "1", day: "day" },
  filters: [],
  measures: [
    { key: "done", label: "Items done", unit: "count", expr: "coalesce(sum(r.done), 0)" },
    { key: "days", label: "Ritual days", unit: "count", expr: "count(r.id)" },
  ],
  row: (raw: SourceRow) => {
    const summary = JSON.parse(String(raw.summary)) as { done: string[]; notDone: string[]; notYet: string[]; held: Record<string, string> };
    return {
      id: String(raw.id),
      cells: {
        day: dateText(Number(raw.at)),
        ...Object.fromEntries(DAY_HABITS.map((habit) => [habit, standing(summary, habit)])),
        done: `${raw.done}/${raw.asked}`,
      },
    };
  },
});
