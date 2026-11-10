// The Rituals table of events, the module's (sdk/server.ts's `tabs`), one of the tables the Events page's Tables lists
// and opens as it is kept: each time the captain did a habit that
// rituals records (the calendar's ritual_habit rows, this module's, pushed from its store: calendar.ts: magnesium,
// protein, stretching, planks, journalling, wind-down), one row each: when, what ("Magnesium", the core's words for a habit done,
// src/habitWords.ts, which the Events calendar's Rituals row uses too), how long a plank was held when its day says,
// how the time is known, and the ritual's day it counted for. Rituals began keeping doings
// on 2026-10-19; one whose time is not known, and a habit its day ticks done with no doing of it, is a row at its day's
// midnight with no When (as a hangout with no time). Metadata only: rituals keeps no words with a doing.
//
// The Events calendar draws these as moments of the day under its Rituals chip (viewer/console/calendar/), a trial the
// captain asked for ("Let's also trial um adding ritual events").

import { sourceTab, type SourceRow } from "../../../sdk/server.ts";
import { habitDoing, heldText } from "../../../sdk/wire.ts";
import { HABIT_CHOICES } from "./daysTab.ts";
import { RITUALS } from "./view.ts";

// A habit rituals ticked done on a day with no doing of it (calendar.ts's tick/<day>/<habit>) is left out once the
// calendar has a doing of that habit that day: a tick stays in the calendar until the next push after rituals is told
// of the doing (a later backfill), and showing both would count it twice.
const SOURCE = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.at_end, e.subkind AS basis, e.facts ->> '$.habit' AS habit, e.facts ->> '$.date' AS date,
    CASE WHEN e.at_end IS NULL THEN NULL ELSE (e.at_end - e.at) / 1000.0 END AS seconds
  FROM event e
  WHERE e.kind = 'ritual_habit' AND NOT (e.facts ->> '$.tick' = 1 AND EXISTS (
    SELECT 1 FROM event d WHERE d.kind = 'ritual_habit' AND d.origin = e.origin AND NOT (d.facts ->> '$.tick' = 1)
      AND d.facts ->> '$.date' = e.facts ->> '$.date' AND d.facts ->> '$.habit' = e.facts ->> '$.habit'))`;

/** The habits in rituals' order, for the chart's split and the filter's menu. */
const HABITS = ["magnesium", "protein", "stretching", "planks", "journalling", "wind_down"];

/** How a doing's time is known, in rituals' word. */
const BASES: Record<string, string> = { user_stated: "As you said", message_received: "Message received", unknown: "Not known" };

export const HABITS_TAB = sourceTab({
  kind: "habits",
  label: "Rituals",
  noun: ["ritual", "rituals"],
  module: RITUALS,
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "habit", label: "What", kind: "text", width: 170 },
    { key: "held", label: "Held", kind: "text", width: 120, sortable: true },
    { key: "basis", label: "Time from", kind: "text", width: 150 },
    { key: "day", label: "For the day", kind: "text", width: 120 },
  ],
  sort: "when",
  // Done or not, for the habit's day (edits.ts): a habit no longer done leaves the table, its day's row in Ritual days
  // saying so.
  edits: [{ key: "done", label: "Done", input: "choice", choices: HABIT_CHOICES }],
  undated: { when: "basis = 'unknown'", day: "date" },
  splits: ["habit"],
  sorts: { when: "at", held: "seconds" },
  source: SOURCE,
  filters: [
    { key: "habit", label: "Habit", kind: "choice", expr: "habit", name: habitDoing, order: HABITS },
    { key: "basis", label: "Time from", kind: "choice", expr: "basis", name: (value) => BASES[value] ?? value },
  ],
  measures: [{ key: "rituals", label: "Rituals", unit: "count", expr: "count(r.id)" }],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.basis === "unknown" ? null : raw.at,
      habit: habitDoing(String(raw.habit)),
      // "1:17", as rituals writes a plank: a duration column would round it to a minute.
      held: raw.seconds === null ? null : heldText(Number(raw.seconds)),
      basis: BASES[String(raw.basis)] ?? String(raw.basis),
      day: String(raw.date),
    },
  }),
});
