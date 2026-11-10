// The Workouts table, the module's (sdk/server.ts's `tabs`), one of the tables the Events page's Tables lists and
// opens as it is kept: the captain's activities (runs, rides) from the calendar's workouts (this module's rows, pushed from
// its index: calendar.ts), one row each: when, the sport, how far, how long, what recorded it and its source. Metadata
// only, as the index keeps it: never a heart rate, a route or a sample, which stay in the copies.
//
// The captain can edit a row (workoutEdits.ts, the module's editor; server/edits/): its sport, when it started and ended,
// how far, and a note, each kept as his correction beside its copies (corrections.ts), which the row is read with; a
// column he corrected is marked edited (the calendar row's facts.edited).
//
// Every source keeps its own copy of an activity (Polar's API and its export, say), so two copies of one run are one
// row: copies are one activity as workouts.ts matches them (one sport family, starts within two minutes, 80% of
// the shorter shared), and the row is the copy the calendar had first, with how many copies there are. Which copy has
// the most detail is the Health tab's question, not this one's: the copies of one run agree on its sport, distance and
// time near enough for a list.

import { sourceTab, type SourceRow } from "../../../sdk/server.ts";
import { FAMILIES, SAME_ACTIVITY } from "./calendar.ts";
import { EXERCISE } from "./db.ts";

/** One row for each activity: its first copy, with its sport family, the sport in its source's word, how far and long, and how many copies. */
const SOURCE = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.at_end, e.subkind AS family, e.facts ->> '$.sport' AS sport,
    e.facts ->> '$.distance_m' AS distance_m, e.facts ->> '$.recorder' AS recorder, e.facts ->> '$.edited' AS edited,
    CASE WHEN e.at_end IS NULL THEN NULL ELSE (e.at_end - e.at) / 1000.0 END AS seconds,
    (SELECT count(*) FROM event o WHERE o.kind = 'workout' AND (o.id = e.id OR ${SAME_ACTIVITY})) AS copies
  FROM event e
  WHERE e.kind = 'workout' AND NOT EXISTS (SELECT 1 FROM event o WHERE o.kind = 'workout' AND o.id < e.id AND ${SAME_ACTIVITY})`;

const SOURCES: Record<string, string> = { polar: "Polar", strava: "Strava", garmin: "Garmin" };

const name = (names: Record<string, string>) => (value: string) => names[value] ?? value;

/** The sports a workout can be corrected to, in Polar's words (each one's family is the connector's, corrections.ts's familyOf). */
export const SPORTS: readonly string[] = [
  "RUNNING", "TRAIL_RUNNING", "TREADMILL_RUNNING", "WALKING", "HIKING", "CYCLING", "ROAD_BIKING", "MOUNTAIN_BIKING", "INDOOR_CYCLING",
  "SWIMMING", "OPEN_WATER_SWIMMING", "STRENGTH_TRAINING", "CIRCUIT_TRAINING", "YOGA", "PILATES", "ROWING", "OTHER_INDOOR", "OTHER_OUTDOOR",
];

/** The most a distance can be corrected to, in km. */
export const MOST_KM = 1000;

/** A sport in its source's word, as people write it: ROAD_BIKING is "Road biking". */
export function sportName(sport: string): string {
  const words = sport.replace(/_/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How far, as people say it: "850 m", "12.4 km". */
export function distanceText(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export const WORKOUTS = sourceTab({
  kind: "workouts",
  label: "Workouts",
  noun: ["workout", "workouts"],
  module: EXERCISE,
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "sport", label: "Sport", kind: "text", width: 150 },
    { key: "distance", label: "Distance", kind: "text", width: 100, numeric: true, sortable: true },
    { key: "length", label: "Length", kind: "duration", width: 110, numeric: true, sortable: true },
    { key: "recorder", label: "Recorded by", kind: "text", width: 170 },
    { key: "origin", label: "From", kind: "text", width: 100 },
  ],
  sort: "when",
  edits: [
    { key: "sport", label: "Sport", input: "choice", choices: SPORTS.map((sport) => ({ value: sport, label: sportName(sport) })) },
    { key: "when", label: "When", input: "datetime" },
    { key: "ended", label: "Ended", input: "datetime" },
    { key: "distance", label: "Distance", input: "number", unit: "km", min: 0, max: MOST_KM, clearable: true },
    { key: "note", label: "Note", input: "note" },
  ],
  splits: ["family", "recorder"],
  sorts: { when: "at", distance: "distance_m", length: "seconds" },
  source: SOURCE,
  filters: [
    { key: "family", label: "Sport", kind: "choice", expr: "family", name: name(FAMILIES), order: Object.keys(FAMILIES) },
    { key: "recorder", label: "Recorded by", kind: "choice", expr: "coalesce(recorder, '')", name: (value) => value || "Not known" },
  ],
  measures: [
    { key: "workouts", label: "Workouts", unit: "count", expr: "count(r.id)" },
    { key: "minutes", label: "Minutes", unit: "minutes", expr: "coalesce(sum(r.seconds), 0) / 60.0" },
  ],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.at,
      sport: sportName(String(raw.sport)),
      distance: raw.distance_m === null ? null : distanceText(Number(raw.distance_m)),
      length: raw.seconds,
      recorder: raw.recorder,
      origin: SOURCES[String(raw.origin)] ?? String(raw.origin),
    },
    ...(raw.edited ? { edited: String(raw.edited).split(",") } : {}),
  }),
});
