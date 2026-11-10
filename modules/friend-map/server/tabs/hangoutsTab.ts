// The viewer's Hangouts tab: every hangout the captain recorded (a catch-up in the archive, and who was at each), time
// in person, one row each, as friend map pushed them into the calendar (../calendarRows.ts), without their notes, which
// are content. A call is a call, in the Calls tab. Friend Map's own Table had a Hangouts tab until 10 November 2026;
// this is it now.
// A hangout is kept as a local date and, if he said, the time it started; its instant is at the start of its day when
// it has no time. A trip over several days is one row at when it began, its hours its time together in all. Its rows are
// edited in their cells and drawer (../tableEdits.ts): when, hours (but a trip's), who and his note. Each is his own
// record, so Add hangout adds one here and any can be deleted (`own`); a trip is added from a person's panel.

import { dateText, FRIEND_MAP, HANGOUT, HOURS_MOST, type SourceRow, sourceTab } from "../../../../sdk/server.ts";

/**
 * One row for each hangout, from the calendar's rows of kind `hangout`: when (its instant), its date and time as kept,
 * how many hours, the people at it (a JSON array of person ids), how many more he did not name, and so whether it was
 * with one person or more. A trip's end and private hours are its drawer's, from the owner.
 */
const SOURCE = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.people AS person_ids,
    e.day, e.facts ->> '$.time' AS time, e.facts ->> '$.hours' AS hours, e.facts ->> '$.others' AS others, e.facts ->> '$.size' AS size,
    CASE WHEN e.facts ->> '$.size' > 1 THEN 'group' ELSE 'one' END AS size_word
  FROM event e WHERE e.kind = 'hangout'`;

const SIZES: Record<string, string> = { one: "One person", group: "Several" };

export const HANGOUTS = sourceTab({
  kind: "hangouts",
  label: HANGOUT.Many,
  noun: [HANGOUT.one, HANGOUT.many],
  module: FRIEND_MAP,
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "with", label: "With", kind: "people", width: 340 },
    { key: "hours", label: "Hours", kind: "duration", width: 110, numeric: true, sortable: true },
    { key: "size", label: "People", kind: "count", width: 80, numeric: true, sortable: true },
  ],
  sort: "when",
  edits: [
    { key: "when", label: "When", input: "datetime", dateOnly: true },
    { key: "hours", label: "Hours", input: "hours", min: 0.01, max: HOURS_MOST },
    { key: "with", label: "With", input: "people" },
    { key: "note", label: "Note", input: "note" },
  ],
  // Every hangout is his own record: Add hangout asks what an edit changes; any can be deleted.
  own: {
    add: [
      { key: "when", label: "When", input: "datetime", dateOnly: true },
      { key: "hours", label: "Hours", input: "hours", min: 0.01, max: HOURS_MOST },
      { key: "with", label: "With", input: "people" },
      { key: "note", label: "Note", input: "note" },
    ],
    deletes: `any ${HANGOUT.one}`,
  },
  splits: ["size"],
  sorts: { when: "at", hours: "hours", size: "size" },
  source: SOURCE,
  undated: { when: "time IS NULL", day: "day" },
  filters: [
    { key: "size", label: "With", kind: "choice", expr: "size_word", name: (value) => SIZES[value] ?? value, order: Object.keys(SIZES) },
    { key: "person", label: "Person", kind: "person", ids: "person_ids", find: "Find a person" },
  ],
  measures: [
    { key: "hangouts", label: HANGOUT.Many, unit: "count", expr: "count(r.id)" },
    { key: "hours", label: "Hours", unit: "minutes", expr: "coalesce(sum(r.hours), 0) * 60" },
  ],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      // A hangout with no time is on its date alone.
      when: raw.time === null ? dateText(Number(raw.at)) : raw.at,
      with: { ids: JSON.parse(String(raw.person_ids)) as number[], others: Number(raw.others) },
      hours: Number(raw.hours) * 3600,
      size: raw.size,
    },
  }),
});
