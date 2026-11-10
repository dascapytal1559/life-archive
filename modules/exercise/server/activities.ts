// The Fitness page's activities: every workout the archive has, from every source of workouts, one an activity
// (workouts.ts matches the copies and ranks them by detail), each with what the page shows of it.
//
// The sources:
//   - the module's index of workouts (workoutIndex.ts: the polar connector's, from AccessLink, and polar-export's,
//     from Polar's account export; Strava's or Garmin's would be more), each read from its copy in the archive's
//     folder (content: the route and the heart rate are in it);
//   - health/by-hand.json's runs, transcribed by hand from Polar's sharing pages: a copy like any other, with a summary
//     of its heart rate and no route;
//   - the workouts the captain logged in Rituals (the rituals module's RitualWorkouts, rituals.ts): each laid beside
//     the activity it is (the same day, sport and duration), else an activity of its own, known by its day alone, with
//     no heart rate. Its log (Rituals' title and his words) is shown on the activity's page.
// Of each activity:
//   - the card's facts (when, the sport, how far, how long) are the copy shown's, the one with the most detail;
//   - its route, moving time and splits are the first copy, by that order, with distance over time or a route;
//   - its heart rate is the first copy, by that order, whose heart rate the captain trusts and that holds one (his rule
//     in each source's settings, data/connectors/<origin>.json's trustedHeartRate: a chest strap's, never a watch's).
//     None trusted, the activity is shown without heart rate, saying why. This is the rule the Health tab's runs had,
//     and the Health tab's highest heart rate is still taken from it (peakOf);
//   - its time in each zone is counted from that heart rate's samples by the zones exercise.json sets (zones.ts), and
//     is Polar's own only for a copy with no samples, or while exercise.json sets no zones;
//   - its minutes in zone 2 are its trusted heart rate's, else its Rituals log's when that says zone 2 (rituals.ts's
//     zone2Of), once an activity, so nothing is counted twice.

import { readFile } from "node:fs/promises";
import { dayKey, dayStart, timeOfDay, wallClock, type LoggedWorkout, type Run } from "../../../sdk/server.ts";
import { heartRateOf as exerciseHeartRate, sportFamily, type HeartRate, type PolarExercise } from "../connectors/polar/exercise.ts";
import { heartRateOf as sessionHeartRate, type PolarSession } from "../connectors/polar-export/session.ts";
import { RITUALS_SOURCE, type ActivityDetail, type Family, type Shape, type Split, type Zone, type ZoneSettings } from "../wire.ts";
import { regionHolding, type Bounds, type MapRegion } from "./maps/tiles.ts";
import { matchLogs, zone2Of } from "./rituals.ts";
import { boundsOf, distanceOverTime, heartRateSeries, movingSeconds, shapeOf, splitsOf, trackOf } from "./track.ts";
import { fileAt, type WorkoutRow } from "./workoutIndex.ts";
import { activities, indexCopy, trustRule, type TrustRule, type WorkoutCopy } from "./workouts.ts";
import { heartRateTime, zonesOf, type HeartRateTime } from "./zones.ts";

/** What the page shows of one copy, worked out from its file once (copies are never changed). */
export interface CopyReading {
  heartRate: HeartRate | null;
  heartRateSeries: Array<[number, number]>;
  /** The seconds at each heart rate of its samples, to count its zones by (zones.ts); none without samples. */
  heartRateTime: HeartRateTime;
  movingS: number | null;
  /** Each split's heart rate is the copy's own, trusted or not: the caller drops it when not. */
  splits: Split[];
  thumb: Shape | null;
  route: Shape | null;
  /** The route's box in degrees: where it is, told the page only to lay it on a map kept here. */
  bounds: Bounds | null;
}

/** A copy to read: its source and id, its file (relative to the archive's folder, or absolute), how big, its family. */
export interface CopyToRead {
  origin: string;
  nativeId: string;
  file: string;
  bytes: number | null;
  family: Family;
}

/** A copy the playback reads, with when it started (ms), to line one copy's heart rate up with another's route. */
export type TimedCopy = CopyToRead & { at: number };

/** The copies an activity's playback is read from. */
export interface PlaybackCopies {
  track: TimedCopy;
  heartRate: TimedCopy | null;
}

/** What the activities come from: by-hand.json's runs, and the index's workouts with each origin's trust rules. */
export interface ExerciseSources {
  byHand: readonly Run[];
  workouts?: readonly WorkoutRow[];
  rules?: Readonly<Record<string, readonly TrustRule[]>>;
  /** Reads a copy; null when it cannot. */
  read?: (copy: CopyToRead) => Promise<CopyReading | null>;
  /** The maps kept on this Mac (server/maps/): a route inside one is laid on it. */
  maps?: readonly MapRegion[];
  /** The workouts logged in Rituals (the rituals module's RitualWorkouts; rituals.ts lays each on its activity). */
  logged?: readonly LoggedWorkout[];
  /** The zones exercise.json sets, to count each activity's time in zones by (zones.ts); none: Polar's own are kept. */
  zones?: ZoneSettings;
}

const NO_ZONES: ZoneSettings = { starts: null, why: "no zones are set" };

/** One activity worked out: what the page shows, and, for the Health tab's peak, whose its heart rate is. */
export interface Built {
  detail: ActivityDetail;
  /** Its copies, most detail first: each index copy with its row, a by-hand run's with none (for its delete, delete.ts). */
  copies: Array<{ copy: WorkoutCopy; event: WorkoutRow | null }>;
  /** The copy its heart rate is from, when trusted: its source's name and recorder. */
  heartRateFrom: { source: string; recorder: string | null } | null;
  /** The copies its playback reads (playback.ts): the track's, and the trusted heart rate's when a copy of the index holds it; null with no track. */
  playback: PlaybackCopies | null;
  /** Its workout logged in Rituals, when there is one. */
  logged: LoggedWorkout | null;
}

/** Why an activity logged in Rituals is not deleted here. */
export const RITUALS_KEEPS_IT =
  "It cannot be deleted here: it is logged in Rituals, which keeps its own workouts. Take it out there, and the archive follows within five minutes; then whatever else of it is here can be deleted.";

/** Thumbnails are thinned to within this share of the route's larger side; the page's route, to within this. */
const THUMB_TOLERANCE = 0.006;
const ROUTE_TOLERANCE = 0.0015;

/** Every activity, newest first. */
export async function exerciseActivities({ byHand, workouts = [], rules = {}, read, maps = [], logged = [], zones = NO_ZONES }: ExerciseSources): Promise<Built[]> {
  const hand = new Map<WorkoutCopy, Run>();
  const indexed = new Map<WorkoutCopy, WorkoutRow>();
  for (const [i, run] of byHand.entries()) hand.set(byHandCopy(run, i), run);
  for (const event of workouts) indexed.set(indexCopy(event, (copy) => trustRule(rules[copy.origin] ?? [], copy) !== null), event);
  const readings = new Map<WorkoutCopy, Promise<CopyReading | null>>();
  const toRead = (copy: WorkoutCopy): TimedCopy | null => {
    const event = indexed.get(copy);
    return event ? { origin: copy.origin, nativeId: copy.nativeId, file: event.workout.file, bytes: event.size, family: copy.family, at: copy.at } : null;
  };
  const reading = (copy: WorkoutCopy) => {
    const file = toRead(copy);
    if (!file || !read) return Promise.resolve(null);
    if (!readings.has(copy)) readings.set(copy, read(file).catch(() => null));
    return readings.get(copy)!;
  };

  const built: Array<Built & { at: number }> = [];
  for (const activity of activities([...hand.keys(), ...indexed.keys()])) {
    const ranked = [activity.chosen, ...activity.others];
    const shown = activity.chosen;
    const run = hand.get(shown);
    const event = indexed.get(shown);

    // The heart rate: the first trusted copy that holds one.
    let heart: { summary: HeartRate; sensor: string | null; series: Array<[number, number]>; time: HeartRateTime; copy: WorkoutCopy; link: string | null } | null = null;
    for (const copy of ranked.filter((c) => c.trustedHeartRate)) {
      const own = hand.get(copy);
      if (own) {
        heart = { summary: handHeartRate(own), sensor: own.device, series: [], time: [], copy, link: own.source };
        break;
      }
      const got = await reading(copy);
      if (!got?.heartRate) continue;
      heart = { summary: got.heartRate, sensor: trustRule(rules[copy.origin] ?? [], copy)?.sensor ?? null, series: got.heartRateSeries, time: got.heartRateTime, copy, link: null };
      break;
    }
    // Its zones: counted from the trusted samples by exercise.json's zones, else Polar's own.
    const counted = heart && zones.starts ? zonesOf(heart.time, zones.starts) : [];
    const shownZones = counted.length > 0 ? counted : (heart?.summary.zones ?? []);

    // The track: the first copy with distance over time or a route.
    let track: CopyReading | null = null;
    let trackCopy: WorkoutCopy | null = null;
    for (const copy of ranked.filter((c) => indexed.has(c) && (c.streams.distance || c.streams.gps))) {
      track = await reading(copy);
      if (track) {
        trackCopy = copy;
        break;
      }
    }

    const elapsedS = Math.round((shown.endAt - shown.at) / 1000);
    const start = `${dayKey(shown.at)}T${timeOfDay(shown.at)}`;
    const sport = run ? run.sport : sportWord(event!.workout.sport);
    const family = shown.family as Family;
    const anyHeartRate = ranked.some((c) => c.streams.heartRate || c.summaryHeartRate);
    // A split's heart rate is shown only when the copy it was read from is the trusted one.
    const splits = (track?.splits ?? []).map((split) => (heart && heart.copy === trackCopy ? split : { ...split, heartRate: null }));
    built.push({
      detail: {
        id: run ? `hand-${run.start.replace(/[-:T]/g, "")}` : String(shown.event),
        start,
        sport,
        family,
        title: titleOf(start, family, sport),
        distanceM: shown.distanceMeters ?? trackCopy?.distanceMeters ?? null,
        elapsedS,
        movingS: Math.min(elapsedS, track?.movingS ?? elapsedS),
        heartRate: heart ? { average: heart.summary.average, maximum: heart.summary.maximum, sensor: heart.sensor } : null,
        heartRateNote: heart ? null : anyHeartRate ? "Heart rate not shown: not from a recorder you trust" : "No heart rate recorded",
        thumb: track?.thumb ?? null,
        map: placeOf(track?.bounds ?? null, maps),
        recorder: shown.recorder,
        source: sourceName(shown),
        alsoIn: activity.others.map(sourceName),
        route: track?.route ?? null,
        heartRateSeries: heart?.series ?? [],
        minHeartRate: heart?.summary.minimum ?? null,
        zones: shownZones satisfies Zone[],
        zonesBy: counted.length > 0 ? "archive" : shownZones.length > 0 ? "polar" : null,
        splits,
        link: heart?.link ?? run?.source ?? null,
        cannotDelete: ranked.some((c) => hand.has(c))
          ? "It cannot be deleted here: it was transcribed by hand into the health module's by-hand.json, which only you edit. Take it out there."
          : null,
        logged: null,
        zone2: null,
      },
      copies: ranked.map((copy) => ({ copy, event: indexed.get(copy) ?? null })),
      heartRateFrom: heart ? { source: sourceName(heart.copy), recorder: heart.copy.recorder } : null,
      playback: trackCopy && toRead(trackCopy) ? { track: toRead(trackCopy)!, heartRate: heart ? toRead(heart.copy) : null } : null,
      logged: null,
      at: shown.at,
    });
  }

  // Each Rituals log beside the activity it is, else an activity of its own.
  const matched = matchLogs(logged, built.map((b) => ({ day: b.detail.start.slice(0, 10), family: b.detail.family, elapsedS: b.detail.elapsedS, movingS: b.detail.movingS })));
  logged.forEach((log, l) => {
    const into = matched.get(l);
    if (into !== undefined) {
      const b = built[into];
      b.logged = log;
      b.detail.logged = log.log;
      b.detail.alsoIn.push(RITUALS_SOURCE);
      b.detail.cannotDelete ??= RITUALS_KEEPS_IT;
      return;
    }
    built.push({ detail: loggedDetail(log), copies: [], heartRateFrom: null, playback: null, logged: log, at: dayStart(log.day) });
  });
  // An activity's zones are its trusted heart rate's alone, so its zone 2 is counted from them.
  for (const b of built) b.detail.zone2 = zone2Of(b.detail.zones, b.detail.logged);
  return built.sort((a, b) => b.at - a.at || a.detail.id.localeCompare(b.detail.id)).map(({ at: _at, ...rest }) => rest);
}

/** A logged workout's sport in the word Polar's copies give it (so the page counts a logged ride with Polar's), else Rituals' category. */
const LOGGED_SPORTS: Partial<Record<string, string>> = { run: "Running", ride: "Cycling", walk: "Walking", swim: "Swimming" };

/** A workout logged in Rituals alone, as an activity: its day, sport and stated duration, and nothing recorded. */
function loggedDetail({ id, day, family, log }: LoggedWorkout): ActivityDetail {
  const seconds = log.minutes === null ? null : Math.round(log.minutes * 60);
  return {
    id, start: day, sport: LOGGED_SPORTS[family] ?? log.type.charAt(0).toUpperCase() + log.type.slice(1), family: family as Family, title: log.title,
    distanceM: null, elapsedS: seconds, movingS: seconds, heartRate: null, heartRateNote: "No heart rate recorded: logged in Rituals",
    thumb: null, map: null, recorder: null, source: RITUALS_SOURCE, alsoIn: [], route: null, heartRateSeries: [], minHeartRate: null,
    zones: [], zonesBy: null, splits: [], link: null, cannotDelete: RITUALS_KEEPS_IT, logged: log, zone2: null,
  };
}

/** Where a route with box `bounds` lies, for the page to lay it on the map kept here that holds it; null with none. */
export function placeOf(bounds: Bounds | null, maps: readonly MapRegion[]): ActivityDetail["map"] {
  if (!bounds) return null;
  const map = regionHolding(maps, bounds);
  return map ? { region: map.region, maxZoom: map.maxZoom, south: bounds.south, west: bounds.west } : null;
}

/** The highest heart rate a trusted recording holds (the earliest of equals), with when, on what and from where. */
export function peakOf(built: readonly Built[]): { bpm: number; date: string; sensor: string | null; recorder: string | null; source: string; activity: string } | null {
  const trusted = built.filter((b) => b.detail.heartRate && b.heartRateFrom);
  const top = trusted.sort((a, b) => b.detail.heartRate!.maximum - a.detail.heartRate!.maximum || a.detail.start.localeCompare(b.detail.start))[0];
  if (!top) return null;
  return {
    bpm: top.detail.heartRate!.maximum,
    date: top.detail.start.slice(0, 10),
    sensor: top.detail.heartRate!.sensor,
    recorder: top.heartRateFrom!.recorder,
    source: top.heartRateFrom!.source,
    activity: top.detail.id,
  };
}

/** A by-hand run's heart rate, as by-hand.json has it. */
function handHeartRate(run: Run): HeartRate {
  return {
    average: run.avgHr,
    maximum: run.maxHr,
    minimum: run.minHr,
    zones: (run.zones ?? []).map((z) => ({ zone: z.zone, share: z.share, time: z.time ?? null, from: z.from ?? null })),
  };
}

/** A by-hand run as a copy: its heart rate a summary, trusted as by-hand.json says. */
function byHandCopy(run: Run, i: number): WorkoutCopy {
  const at = wallClock(run.start.slice(0, 10), run.start.slice(11));
  // 41:02, or 1:02:03.
  const seconds = run.duration.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return {
    origin: "by-hand", nativeId: `${run.start}#${i}`, event: null, family: sportFamily(run.sport), at, endAt: at + seconds * 1000,
    distanceMeters: run.distanceMi === null ? null : run.distanceMi * 1609.344, recorder: null, streams: {}, summaryHeartRate: true,
    trustedHeartRate: run.trusted,
  };
}

/** What the page calls a copy's source, crediting its maker. */
export function sourceName(copy: Pick<WorkoutCopy, "origin" | "nativeId">): string {
  if (copy.origin === "by-hand") return "Polar Flow's share page, by hand";
  if (copy.origin === "polar") return copy.nativeId.startsWith("export/") ? "Polar Flow's account export" : "Polar Flow";
  return copy.origin.charAt(0).toUpperCase() + copy.origin.slice(1);
}

/** A source's sport word as the page writes it: RUNNING as Running, TRAIL_RUNNING as Trail running. */
export function sportWord(sport: string): string {
  const words = sport.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const NOUNS: Partial<Record<Family, string>> = { run: "Run", ride: "Ride", walk: "Walk", swim: "Swim" };

/**
 * An activity's name, as a feed names one its owner has not: the part of the day it started in (local time) and
 * the sport ("Morning Run", "Lunch Ride", "Evening Walk"; another sport by its own word, "Afternoon Strength training").
 */
export function titleOf(start: string, family: Family, sport: string): string {
  const hour = Number(start.slice(11, 13));
  const part = hour < 4 ? "Night" : hour < 11 ? "Morning" : hour < 14 ? "Lunch" : hour < 17 ? "Afternoon" : hour < 21 ? "Evening" : "Night";
  return `${part} ${NOUNS[family] ?? sport}`;
}

/** What has been worked out of each archive's copies (copyReader), by its folder: one for the Fitness page and the Health tab. */
const readings = new Map<string, Map<string, Promise<CopyReading | null>>>();

/** Forgets what was worked out of the archive's copies at `dataDir`, so nothing of a deleted one is kept (delete.ts). */
export function forgetReadings(dataDir: string): void {
  readings.delete(dataDir);
}

/**
 * Reads a copy from the archive's folder `dataDir` by its source's format, and works out what the page shows of it,
 * once: the answer is kept by the copy's file, id, size and family, since a copy is written once and never changed
 * (until it is deleted, forgetReadings).
 */
export function copyReader(dataDir: string): NonNullable<ExerciseSources["read"]> {
  return (copy) => {
    const kept = readings.get(dataDir) ?? new Map<string, Promise<CopyReading | null>>();
    readings.set(dataDir, kept);
    if (copy.origin !== "polar") return Promise.resolve(null);
    const key = `${copy.file}\0${copy.nativeId}\0${copy.bytes}\0${copy.family}`;
    let answer = kept.get(key);
    if (!answer) {
      answer = readFile(fileAt(copy.file, dataDir), "utf8").then((text) => reckon(JSON.parse(text) as unknown, copy));
      // A copy that could not be read is tried again next time.
      answer.catch(() => kept.delete(key));
      kept.set(key, answer);
    }
    return answer;
  };
}

/** What the page shows of a copy's JSON. */
export function reckon(json: unknown, copy: Pick<CopyToRead, "nativeId" | "family">): CopyReading {
  const exported = copy.nativeId.startsWith("export/");
  const track = trackOf(json, copy.nativeId);
  const distance = distanceOverTime(track);
  return {
    heartRate: exported ? sessionHeartRate(json as PolarSession, copy.nativeId) : exerciseHeartRate(json as PolarExercise),
    heartRateSeries: heartRateSeries(track.heartRate),
    heartRateTime: heartRateTime(track.heartRate, track.heartRateEvery),
    movingS: movingSeconds(distance, copy.family),
    splits: splitsOf(distance, track.heartRate, copy.family),
    thumb: shapeOf(track.route, THUMB_TOLERANCE),
    route: shapeOf(track.route, ROUTE_TOLERANCE),
    bounds: boundsOf(track.route),
  };
}
