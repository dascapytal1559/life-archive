// Polar's exercise, as AccessLink v3 gives it (GET /v3/exercises/{id}?samples=true&zones=true&route=true, the schema
// `exerciseHashId`), read two ways:
//   - workoutEvent: what the module's index (server/workoutIndex.ts) keeps of it, never a heart rate or a coordinate: when, the sport and its
//     family, how far, what recorded it ("Polar Flow app", or a watch's name), and which sample streams it holds
//     with how many samples and how often (the samples' `recording-rate`; Polar's example uses 5 s, the Flow app 1 s).
//   - heartRateOf: the heart rate the Fitness page shows of an activity its copy holds: average, maximum, minimum and the time
//     in each zone. This reads content (the copy), for the Fitness page (and the Health tab's highest heart rate) alone.
// Polar's account data export, once its format is known, is read into the same WorkoutEvent (origin polar), its
// copies kept under platform-exports/polar/<export date>/: the matcher (server/workouts.ts) joins its copy of a run
// to the API's by time, whatever ids each gives it.

import type { SportFamily, StreamInfo, WorkoutEvent, WorkoutStream } from "../../../../sdk/connector.ts";

/** What of Polar's exercise is read here; the copy keeps all of it. */
export interface PolarExercise {
  id: string;
  upload_time?: string;
  device?: string;
  device_id?: string;
  /** Local time, without its offset: 2026-05-20T07:15:04. */
  start_time: string;
  /** Minutes east of UTC at the start. */
  start_time_utc_offset?: number;
  /** ISO 8601: PT41M2S. */
  duration: string;
  distance?: number;
  heart_rate?: { average?: number; maximum?: number };
  sport?: string;
  detailed_sport_info?: string;
  has_route?: boolean;
  /** Polar's copies spell these keys with underscores (lower_limit); its documentation, with dashes (lower-limit): either is read. */
  heart_rate_zones?: Array<PolarZone>;
  samples?: Array<PolarSample>;
  route?: Array<{ latitude?: number; longitude?: number; time?: string }>;
}

/** A heart-rate zone as Polar gives it, in either spelling. */
export interface PolarZone {
  index?: number;
  lower_limit?: number;
  upper_limit?: number;
  in_zone?: string;
  "lower-limit"?: number;
  "upper-limit"?: number;
  "in-zone"?: string;
}

/** A sample stream as Polar gives it, in either spelling: its type, how often (seconds) and its readings, comma-separated. */
export interface PolarSample {
  recording_rate?: number | null;
  sample_type?: string | number;
  "recording-rate"?: number | null;
  "sample-type"?: string | number;
  data?: string;
}

/** A sample's type and rate, and a zone's limits and time, whichever spelling the copy has. */
export const sampleType = (sample: PolarSample): string => String(sample.sample_type ?? sample["sample-type"]);
export const sampleRate = (sample: PolarSample): number | null => sample.recording_rate ?? sample["recording-rate"] ?? null;
const zoneFrom = (zone: PolarZone): number | null => zone.lower_limit ?? zone["lower-limit"] ?? null;
const zoneTime = (zone: PolarZone): string | undefined => zone.in_zone ?? zone["in-zone"];

/** Polar's sample types (the docs' appendix "Exercise sample types"), each as the stream it is; the rest are not counted. */
const SAMPLE_STREAMS: Record<string, WorkoutStream> = {
  "0": "heartRate",
  "1": "speed",
  "2": "cadence",
  "3": "altitude",
  "4": "power",
  "8": "cadence",
  "9": "temperature",
  "10": "distance",
  "11": "rr",
};

/** Seconds in an ISO 8601 duration of hours, minutes and seconds (PT1H2M3.5S); null when it is not one. */
export function isoSeconds(duration: string | undefined): number | null {
  const match = duration ? /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration) : null;
  if (!match || duration === "PT") return null;
  const [, h = "0", m = "0", s = "0"] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** The instant an exercise started: its local start time less its offset from UTC. */
export function startInstant(exercise: Pick<PolarExercise, "start_time" | "start_time_utc_offset">): number {
  const wall = Date.parse(`${exercise.start_time.replace(/Z$/, "")}Z`);
  if (Number.isNaN(wall)) throw new Error("an exercise has a start time this connector cannot read");
  return wall - (exercise.start_time_utc_offset ?? 0) * 60_000;
}

/** The sport family of Polar's sport name (RUNNING, TRAIL_RUNNING, ROAD_BIKING, ...). */
export function sportFamily(sport: string | undefined, detailed?: string): SportFamily {
  const name = `${sport ?? ""} ${detailed ?? ""}`.toUpperCase();
  if (/RUN|JOG/.test(name)) return "run";
  if (/WALK|HIK/.test(name)) return "walk";
  if (/CYCL|BIK|RIDE/.test(name)) return "ride";
  if (/SWIM/.test(name)) return "swim";
  return "other";
}

/** The values of a sample's data that are readings: a sensor offline is `null`, and a heart rate of 0 is none. */
function readings(data: string | undefined, stream: WorkoutStream): number[] {
  if (!data) return [];
  return data
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "" && value !== "null")
    .map(Number)
    .filter((value) => !Number.isNaN(value) && !(stream === "heartRate" && value <= 0));
}

/** The streams an exercise holds: each one's samples (readings only) and how often, in seconds. */
export function streamsOf(exercise: PolarExercise): Partial<Record<WorkoutStream, StreamInfo>> {
  const streams: Partial<Record<WorkoutStream, StreamInfo>> = {};
  for (const sample of exercise.samples ?? []) {
    const stream = SAMPLE_STREAMS[sampleType(sample)];
    if (!stream) continue;
    const count = readings(sample.data, stream).length;
    if (count === 0) continue;
    const rate = stream === "rr" ? null : sampleRate(sample);
    const known = streams[stream];
    // Two samples of one stream (cycling and running cadence) count together, at the finer rate.
    streams[stream] = known
      ? { samples: known.samples + count, everySeconds: known.everySeconds === null || rate === null ? (known.everySeconds ?? rate) : Math.min(known.everySeconds, rate) }
      : { samples: count, everySeconds: rate !== null && rate > 0 ? rate : null };
  }
  const points = (exercise.route ?? []).filter((point) => typeof point.latitude === "number" && typeof point.longitude === "number");
  if (points.length > 0) {
    const first = isoSeconds(points[0].time);
    const last = isoSeconds(points.at(-1)!.time);
    const every = points.length > 1 && first !== null && last !== null && last > first ? Math.round(((last - first) / (points.length - 1)) * 100) / 100 : null;
    streams.gps = { samples: points.length, everySeconds: every };
  }
  return streams;
}

/** What the module's index keeps of an exercise whose copy is `file` (and its FIT file `fit`, when kept), `bytes` long. */
export function workoutEvent(exercise: PolarExercise, files: { file: string; fit?: string; bytes: number }): WorkoutEvent {
  const at = startInstant(exercise);
  const seconds = isoSeconds(exercise.duration);
  if (seconds === null) throw new Error("an exercise has a duration this connector cannot read");
  const sport = exercise.detailed_sport_info || exercise.sport || "OTHER";
  return {
    kind: "workout",
    id: exercise.id,
    sport,
    family: sportFamily(exercise.sport, exercise.detailed_sport_info),
    at,
    endAt: at + Math.round(seconds * 1000),
    ...(typeof exercise.distance === "number" && Number.isFinite(exercise.distance) && exercise.distance >= 0 ? { distanceMeters: exercise.distance } : {}),
    ...(exercise.device ? { recorder: exercise.device } : {}),
    streams: streamsOf(exercise),
    file: files.file,
    ...(files.fit ? { rawFile: files.fit } : {}),
    bytes: files.bytes,
  };
}

/** The heart rate of a run, as the Health tab shows it; null when the copy holds none. */
export interface HeartRate {
  average: number;
  maximum: number;
  minimum: number;
  /** Each zone, from 1, by its lower limit: its share of the time in zones (%, whole), its time (m:ss) and lower limit. */
  zones: Array<{ zone: number; share: number; time: string | null; from: number | null }>;
}

/** The heart rate an exercise's copy holds (its samples, else its summary), or null. */
export function heartRateOf(exercise: PolarExercise): HeartRate | null {
  const samples = (exercise.samples ?? []).filter((sample) => sampleType(sample) === "0").flatMap((sample) => readings(sample.data, "heartRate"));
  const average = exercise.heart_rate?.average ?? (samples.length > 0 ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null);
  const maximum = exercise.heart_rate?.maximum ?? (samples.length > 0 ? Math.max(...samples) : null);
  if (average === null || maximum === null) return null;
  const zones = [...(exercise.heart_rate_zones ?? [])]
    .map((zone) => ({ from: zoneFrom(zone), seconds: isoSeconds(zoneTime(zone)) ?? 0 }))
    .sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  const inZones = zones.reduce((n, zone) => n + zone.seconds, 0);
  return {
    average,
    maximum,
    minimum: samples.length > 0 ? Math.min(...samples) : average,
    zones: inZones > 0
      ? zones.map((zone, i) => ({ zone: i + 1, share: Math.round((zone.seconds / inZones) * 100), time: clock(zone.seconds), from: zone.from }))
      : [],
  };
}

/** Seconds as a clock reads a duration: 41:02, or 1:02:03. */
export function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
