// A training session of Polar's account data export ("Download your data" at account.polar.com), one
// training-session_<start>_<id>.json for each, read two ways, as the AccessLink copy is (../polar/exercise.ts):
//   - workoutEvents: one workout of each of its exercises (a multisport session has several) for the module's index (server/workoutIndex.ts):
//     when, the sport, how far, what recorded it (the session's product), and which sample streams it holds, never a
//     heart rate or a coordinate. Keyed `export/<the exercise's id>`: the export's ids are not AccessLink's, and the
//     matcher (server/workouts.ts) joins an export's copy of a run to the API's by time.
//   - heartRateOf: what the Fitness page shows of an activity's heart rate. This reads content, for the Fitness page
//     (and the Health tab's highest heart rate) alone; the Fitness page reads its samples and route too
//     (server/track.ts).
// The format, as learned from the captain's export by its key paths and types alone: the session's startTime (local,
// to the second) and timezoneOffsetMinutes (east of UTC), product.modelName ("Polar Flow app"), hrAvg and hrMax; each
// exercise's identifier.id, startTime, durationMillis, distanceMeters, sport.id (Polar's number for it), its samples
// (samples.samples: each a type such as HEART_RATE, SPEED or DISTANCE, intervalMillis and values, where "NaN" is a
// sensor's gap), its route (routes.route.wayPoints: latitude, longitude, elapsedMillis), its statistics and zones
// (ZONE_TYPE_HEART_RATE: lowerLimit, higherLimit and inZone, in milliseconds, absent for none). The session also holds
// the captain's note and his Flow profile (physicalInformation), which nothing here reads.

import { clock, type HeartRate } from "../polar/exercise.ts";
import type { SportFamily, StreamInfo, WorkoutEvent, WorkoutStream } from "../../../../sdk/connector.ts";

/** What of an exported session is read here. */
export interface PolarSession {
  startTime?: string;
  timezoneOffsetMinutes?: number;
  hrAvg?: number;
  hrMax?: number;
  product?: { modelName?: string };
  exercises?: SessionExercise[];
}

export interface SessionExercise {
  identifier?: { id?: string | number };
  startTime?: string;
  timezoneOffsetMinutes?: number;
  durationMillis?: number;
  distanceMeters?: number;
  sport?: { id?: string | number };
  statistics?: { statistics?: Array<{ type?: string; min?: number; avg?: number; max?: number }> };
  zones?: Array<{ type?: string; zones?: Array<{ lowerLimit?: number; higherLimit?: number; inZone?: number }> }>;
  samples?: { samples?: Array<{ type?: string; intervalMillis?: number; values?: Array<number | string | null> }> };
  routes?: { route?: { wayPoints?: Array<{ latitude?: number; longitude?: number; elapsedMillis?: number }> } };
}

/** Polar's sport numbers this archive knows, by its sport's name; another is kept as POLAR_SPORT_<n>, of no family. */
const SPORTS: Record<string, { name: string; family: SportFamily }> = {
  "1": { name: "RUNNING", family: "run" },
  "2": { name: "CYCLING", family: "ride" },
  "3": { name: "WALKING", family: "walk" },
};

/** The export's sample types, each as the stream it is; another is not counted. */
const SAMPLE_STREAMS: Record<string, WorkoutStream> = {
  HEART_RATE: "heartRate",
  SPEED: "speed",
  DISTANCE: "distance",
  CADENCE: "cadence",
  ALTITUDE: "altitude",
  POWER: "power",
  TEMPERATURE: "temperature",
  RR_INTERVAL: "rr",
  RR: "rr",
};

/** The id an exercise of a session is kept under in the index. */
export const exportId = (exercise: SessionExercise) => `export/${String(exercise.identifier?.id ?? "")}`;

/** The readings of a sample's values: a number, never a gap ("NaN"); a heart rate of 0 is none. */
function readings(values: Array<number | string | null> | undefined, stream: WorkoutStream): number[] {
  return (values ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && !(stream === "heartRate" && value <= 0));
}

/** When an exercise started: its local start time (or its session's) less its offset from UTC. */
function startOf(session: PolarSession, exercise: SessionExercise): number {
  const local = exercise.startTime ?? session.startTime;
  const wall = local ? Date.parse(`${local.replace(/Z$/, "")}Z`) : Number.NaN;
  if (Number.isNaN(wall)) throw new Error("a session has a start time this connector cannot read");
  return wall - (exercise.timezoneOffsetMinutes ?? session.timezoneOffsetMinutes ?? 0) * 60_000;
}

/** The streams an exercise holds: each one's readings and how often, in seconds. */
export function streamsOf(exercise: SessionExercise): Partial<Record<WorkoutStream, StreamInfo>> {
  const streams: Partial<Record<WorkoutStream, StreamInfo>> = {};
  for (const sample of exercise.samples?.samples ?? []) {
    const stream = SAMPLE_STREAMS[sample.type ?? ""];
    if (!stream) continue;
    const count = readings(sample.values, stream).length;
    if (count === 0) continue;
    const every = stream === "rr" || !sample.intervalMillis ? null : sample.intervalMillis / 1000;
    const known = streams[stream];
    streams[stream] = known ? { samples: known.samples + count, everySeconds: known.everySeconds ?? every } : { samples: count, everySeconds: every };
  }
  const points = (exercise.routes?.route?.wayPoints ?? []).filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number");
  if (points.length > 0) {
    const first = points[0].elapsedMillis;
    const last = points.at(-1)!.elapsedMillis;
    const every = points.length > 1 && first !== undefined && last !== undefined && last > first ? Math.round((last - first) / (points.length - 1) / 10) / 100 : null;
    streams.gps = { samples: points.length, everySeconds: every };
  }
  return streams;
}

/** A session's exercises as workout events, its copy `file` (the export's own file, kept where it is), `bytes` long. */
export function workoutEvents(session: PolarSession, file: string, bytes: number): WorkoutEvent[] {
  return (session.exercises ?? []).map((exercise) => {
    if (exercise.identifier?.id === undefined || exercise.identifier.id === "") throw new Error("a session's exercise has no id");
    if (typeof exercise.durationMillis !== "number" || exercise.durationMillis < 0) throw new Error("a session's exercise has no duration");
    const at = startOf(session, exercise);
    const sportId = String(exercise.sport?.id ?? "");
    const sport = SPORTS[sportId] ?? { name: `POLAR_SPORT_${sportId || "UNKNOWN"}`, family: "other" as const };
    return {
      kind: "workout" as const,
      id: exportId(exercise),
      sport: sport.name,
      family: sport.family,
      at,
      endAt: at + Math.round(exercise.durationMillis),
      ...(typeof exercise.distanceMeters === "number" && Number.isFinite(exercise.distanceMeters) && exercise.distanceMeters >= 0 ? { distanceMeters: exercise.distanceMeters } : {}),
      ...(session.product?.modelName ? { recorder: session.product.modelName } : {}),
      streams: streamsOf(exercise),
      file,
      bytes,
    };
  });
}

/** The heart rate of the exercise `id` (as exportId names it) of a session, or null when it holds none. */
export function heartRateOf(session: PolarSession, id: string): HeartRate | null {
  const exercise = (session.exercises ?? []).find((e) => exportId(e) === id);
  if (!exercise) return null;
  const samples = (exercise.samples?.samples ?? []).filter((s) => s.type === "HEART_RATE").flatMap((s) => readings(s.values, "heartRate"));
  const stats = exercise.statistics?.statistics?.find((s) => s.type === "STATISTICS_TYPE_HEART_RATE");
  const one = (session.exercises ?? []).length === 1;
  const average = stats?.avg ?? (one ? session.hrAvg : undefined) ?? (samples.length > 0 ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : undefined);
  const maximum = stats?.max ?? (one ? session.hrMax : undefined) ?? (samples.length > 0 ? Math.max(...samples) : undefined);
  if (average === undefined || maximum === undefined) return null;
  const zones = [...(exercise.zones?.find((z) => z.type === "ZONE_TYPE_HEART_RATE")?.zones ?? [])]
    .map((zone) => ({ from: zone.lowerLimit ?? null, seconds: (zone.inZone ?? 0) / 1000 }))
    .sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  const inZones = zones.reduce((n, zone) => n + zone.seconds, 0);
  return {
    average: Math.round(average),
    maximum: Math.round(maximum),
    minimum: Math.round(stats?.min ?? (samples.length > 0 ? Math.min(...samples) : average)),
    zones: inZones > 0 ? zones.map((zone, i) => ({ zone: i + 1, share: Math.round((zone.seconds / inZones) * 100), time: clock(zone.seconds), from: zone.from })) : [],
  };
}
