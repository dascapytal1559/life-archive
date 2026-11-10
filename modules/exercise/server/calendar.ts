// The module's rows in the core's calendar (sdk/server.ts's ModuleEvents; docs/events.md's "The calendar"): each copy of a
// workout the index holds (workoutIndex.ts) is a moment, keyed on its source and the source's own id, with its sport
// family as its subkind and, in its facts, the sport in the source's word, how far and what recorded it: what the
// Events page's Workouts tab reads beyond the row's own columns (workoutsTab.ts). Never a heart rate or a coordinate,
// and nobody is in a workout. The module's `apply` answers the rows of what an import added or changed, which the host
// pushes under its name once its transaction has committed (apply.ts); the module forgets a deleted activity's
// (delete.ts), and gives every row for the calendar's rebuild and drift check (`rows`).
//
// The two hooks the Events pages ask the owner of a row through: nobody to name, and a workout's drawer, which says its
// family, when it ended and how many copies its activity has in the index, and leads to the day's messages.

import type { DatabaseSync } from "node:sqlite";
import { dateText, dayOf, only, timeText, type CalendarRow, type ModuleEvents, type OwnerDetail } from "../../../sdk/server.ts";
import { EXERCISE } from "./db.ts";
import { WorkoutIndex, type WorkoutRow } from "./workoutIndex.ts";
import { EDITED_COLUMN } from "./corrections.ts";
import { MIN_OVERLAP, SAME_START_MS, sameActivity } from "./workouts.ts";

/** The sport families, as the Workouts tab and a workout's drawer say them. */
export const FAMILIES: Record<string, string> = { run: "Run", ride: "Ride", walk: "Walk", swim: "Swim", other: "Other" };

/**
 * Whether two rows `o` and `e` with a sport family (`subkind` in the calendar, `family` in the index), `at` and `at_end`
 * are copies of one activity (workouts.ts's sameActivity, in SQL), the family's column named by `family`.
 */
export const sameActivitySql = (family: string): string => `o.${family} = e.${family} AND abs(o.at - e.at) <= ${SAME_START_MS} AND (
    CASE WHEN min(coalesce(o.at_end, o.at) - o.at, coalesce(e.at_end, e.at) - e.at) <= 0
      THEN min(coalesce(o.at_end, o.at), coalesce(e.at_end, e.at)) - max(o.at, e.at) >= 0
      ELSE min(coalesce(o.at_end, o.at), coalesce(e.at_end, e.at)) - max(o.at, e.at) >= ${MIN_OVERLAP} * min(coalesce(o.at_end, o.at) - o.at, coalesce(e.at_end, e.at) - e.at) END)`;

/** The same over the calendar's rows, whose family is the subkind. */
export const SAME_ACTIVITY = sameActivitySql("subkind");

/** One index row as its calendar row. */
export function calendarRow(row: WorkoutRow): CalendarRow {
  return {
    module: EXERCISE, origin: row.origin, nativeId: row.nativeId, shape: "moment", kind: "workout", subkind: row.subkind, at: row.at, atEnd: row.atEnd, day: row.day,
    self: true, direction: null, size: row.size, hasContent: true, people: [],
    facts: {
      sport: row.workout.sport, distance_m: row.workout.distanceMeters, recorder: row.workout.recorder,
      // The Workouts table's columns the captain corrected (corrections.ts), for its "edited" marks.
      ...(row.corrected ? { edited: [...new Set(row.corrected.fields.map((field) => EDITED_COLUMN[field]))].join(",") } : {}),
    },
    summary: null,
  };
}


/**
 * The copies of the activity copy `origin`/`nativeId` is of, among `rows` (the index's, corrected): that copy first,
 * then each other copy of the same activity (workouts.ts's sameActivity, as the Workouts table matches them); none when
 * the index has no such copy.
 */
export function activityOf(rows: readonly WorkoutRow[], origin: string, nativeId: string): WorkoutRow[] {
  const copy = rows.find((row) => row.origin === origin && row.nativeId === nativeId);
  if (!copy) return [];
  const as = (row: WorkoutRow) => ({ family: row.subkind, at: row.at, endAt: row.atEnd });
  return [copy, ...rows.filter((row) => row !== copy && sameActivity(as(row), as(copy)))];
}

/** "6 Mar 2026 9:30 am": when something ended, as a drawer says it. */
const endedText = (at: number): string => `${dateText(at)} ${timeText(at)}`;

/** The module's answers for its rows, over its database. */
export function exerciseEvents(db: DatabaseSync): ModuleEvents {
  const index = new WorkoutIndex(db);
  return {
    labelPeople: () => ({}),
    detail: (kind, origin, nativeId): OwnerDetail | null => {
      if (kind !== "workout") return null;
      const copies = activityOf(index.all(), origin, nativeId);
      const raw = copies[0];
      if (!raw) return null;
      return {
        more: [
          { label: "Sport family", kind: "text", value: FAMILIES[raw.subkind] ?? raw.subkind },
          { label: "Ended", kind: "text", value: endedText(raw.atEnd), key: "ended" },
          { label: "Copies", kind: "count", value: copies.length },
        ],
        views: [{ label: "Messages that day", kind: "messages", filters: only(dayOf(raw.at)) }],
      };
    },
    rows: () => index.all().map(calendarRow),
  };
}
