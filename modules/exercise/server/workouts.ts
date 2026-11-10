// The captain's activities (runs, rides) from every source of workouts, as one list: which copies are the same
// activity, and which copy of each to show. Every source keeps its own copy and writes it to the module's index as a
// `workout` event (workoutIndex.ts), each saying which sample streams it holds; nothing here is stored, it is worked out
// over the index each time, so a source imported later (Strava's export, Garmin's) joins what is there by itself.
//
// Source-blind: a source only has to give its copies the same shape (WorkoutCopy). Two copies are one activity when
// they are of the same sport family, start within two minutes of each other and overlap for at least 80% of the
// shorter. Copies join in chains (union-find), so Polar's API copy, its export's, Strava's and a later Garmin's copy
// of one run are one activity. Distance is not needed to tell candidates apart: two copies that each share 80% of a
// run from within two minutes of its start share most of each other too, so they are the same run.
// An activity only one source has is an activity of one copy, and is kept as any other.
//
// Which copy to show, "the most detail", in a fixed order where the first difference decides (docs/events.md's "Workouts from Polar"):
//   1. heart rate the captain trusts (his hand-set rule: a chest strap's, never a watch's) over any other or none
//   2. heart rate sample by sample over a summary of it
//   3. RR intervals
//   4. a GPS route
//   5. more of the other streams (cadence, power, altitude, speed, ...)
//   6. heart rate sampled more often, then more samples in all
//   7. a hardware maker's own copy (Polar's, Garmin's) over an aggregator's (Strava's), over one transcribed by hand
// and, all else equal, the copy the index had first. Every copy is kept and listed beside the one shown.

import type { SportFamily, StreamInfo, WorkoutStream } from "../../../sdk/server.ts";
import type { WorkoutRow } from "./workoutIndex.ts";

/** Starts this close count as the same activity's. */
export const SAME_START_MS = 2 * 60_000;
/** ... when they overlap for at least this share of the shorter. */
export const MIN_OVERLAP = 0.8;

/** What kind of source a copy comes from, for the last of the rules: a hardware maker's own, an aggregator's, or by hand. */
export const SOURCE_KINDS: Record<string, "maker" | "aggregator" | "by-hand"> = {
  polar: "maker",
  garmin: "maker",
  strava: "aggregator",
  "by-hand": "by-hand",
};
const KIND_RANK = { maker: 0, aggregator: 1, "by-hand": 2 } as const;

/** The streams beyond heart rate, RR and GPS, counted for the fifth rule. */
const OTHER_STREAMS: readonly WorkoutStream[] = ["speed", "distance", "cadence", "altitude", "power", "temperature"];

/** One source's copy of an activity, as every source gives it. */
export interface WorkoutCopy {
  /** Its source: a connector's origin (polar), or by-hand for a run transcribed into health/by-hand.json. */
  origin: string;
  /** The source's own id for it. */
  nativeId: string;
  /** The index's row, when it is in the index. */
  event: number | null;
  family: SportFamily;
  at: number;
  endAt: number;
  distanceMeters: number | null;
  /** What recorded it, in the source's word ("Polar Flow app"). */
  recorder: string | null;
  streams: Partial<Record<WorkoutStream, StreamInfo>>;
  /** It has heart rate only as a summary (an average and a maximum), no samples. */
  summaryHeartRate: boolean;
  /** Its heart rate is one the captain trusts (his rule; see trustRule). */
  trustedHeartRate: boolean;
}

/** One activity: the copy shown, the rule that chose it over the next (null when it is the only copy), and the rest. */
export interface Activity {
  chosen: WorkoutCopy;
  decidedBy: DetailRule | null;
  others: WorkoutCopy[];
}

export type DetailRule = "trusted-heart-rate" | "heart-rate-samples" | "rr" | "gps" | "more-streams" | "sample-rate" | "maker" | "first";

/** A workout copy from the index's row (WorkoutIndex), its trust from `trusted`. */
export function indexCopy(event: WorkoutRow, trusted: (copy: Omit<WorkoutCopy, "trustedHeartRate">) => boolean): WorkoutCopy {
  const { workout } = event;
  const copy = {
    origin: event.origin, nativeId: event.nativeId, event: event.id, family: event.subkind, at: event.at,
    endAt: event.atEnd, distanceMeters: workout.distanceMeters, recorder: workout.recorder, streams: workout.streams,
    summaryHeartRate: false,
  };
  return { ...copy, trustedHeartRate: trusted(copy) };
}

/** The captain's rule for a source's heart rate: which recorders' heart rate he trusts, and the sensor behind it. */
export interface TrustRule {
  /** The recorder, as the source names it ("Polar Flow app"). */
  device: string;
  /** The sensor whose heart rate it is, as he names it ("Polar H10"), for the page. */
  sensor?: string;
}

/** The rule of `rules` that trusts a copy's heart rate: its recorder named, and heart rate in it; else null. */
export function trustRule(rules: readonly TrustRule[], copy: Pick<WorkoutCopy, "recorder" | "streams" | "summaryHeartRate">): TrustRule | null {
  if (!copy.streams.heartRate && !copy.summaryHeartRate) return null;
  return rules.find((rule) => rule.device === copy.recorder) ?? null;
}

/** The rules a connector's settings hold (`trustedHeartRate`), or an Error saying what is wrong with them. */
export function trustRules(settings: Record<string, unknown>): TrustRule[] | Error {
  const rules = settings.trustedHeartRate;
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return new Error("trustedHeartRate is a list of rules, each {\"device\": \"<recorder>\"}");
  for (const rule of rules) {
    const valid = typeof rule === "object" && rule !== null && typeof rule.device === "string" && rule.device !== "" &&
      (rule.sensor === undefined || (typeof rule.sensor === "string" && rule.sensor !== ""));
    if (!valid) return new Error("each trustedHeartRate rule names its recorder, {\"device\": \"<recorder>\"}, and may name its sensor, \"sensor\"");
  }
  return rules as TrustRule[];
}

/** Whether two copies are the same activity: one sport family, starts within two minutes, and 80% of the shorter shared. */
export function sameActivity(a: Pick<WorkoutCopy, "family" | "at" | "endAt">, b: Pick<WorkoutCopy, "family" | "at" | "endAt">): boolean {
  if (a.family !== b.family || Math.abs(a.at - b.at) > SAME_START_MS) return false;
  const shorter = Math.min(a.endAt - a.at, b.endAt - b.at);
  const shared = Math.min(a.endAt, b.endAt) - Math.max(a.at, b.at);
  return shorter <= 0 ? shared >= 0 : shared >= MIN_OVERLAP * shorter;
}

/** The copies as activities, newest first, each with the copy shown and the rest. */
export function activities(copies: readonly WorkoutCopy[]): Activity[] {
  const sorted = [...copies].sort((a, b) => a.at - b.at || order(a, b));
  const parent = sorted.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < sorted.length; i++) {
    // Sorted by start, so only the copies starting within two minutes after it can be the same activity.
    for (let j = i + 1; j < sorted.length && sorted[j].at - sorted[i].at <= SAME_START_MS; j++) {
      if (sameActivity(sorted[i], sorted[j])) parent[root(j)] = root(i);
    }
  }
  const groups = new Map<number, WorkoutCopy[]>();
  sorted.forEach((copy, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), copy]));
  return [...groups.values()]
    .map((group) => {
      const ranked = [...group].sort(moreDetail);
      return { chosen: ranked[0], decidedBy: ranked.length > 1 ? decidingRule(ranked[0], ranked[1]) : null, others: ranked.slice(1) };
    })
    .sort((a, b) => b.chosen.at - a.chosen.at || order(a.chosen, b.chosen));
}

/** Each rule, in order, as a comparison: below 0 when `a` has more detail by it. */
const RULES: ReadonlyArray<[DetailRule, (a: WorkoutCopy, b: WorkoutCopy) => number]> = [
  ["trusted-heart-rate", (a, b) => Number(b.trustedHeartRate) - Number(a.trustedHeartRate)],
  ["heart-rate-samples", (a, b) => Number(Boolean(b.streams.heartRate)) - Number(Boolean(a.streams.heartRate))],
  ["rr", (a, b) => Number(Boolean(b.streams.rr)) - Number(Boolean(a.streams.rr))],
  ["gps", (a, b) => Number(Boolean(b.streams.gps)) - Number(Boolean(a.streams.gps))],
  ["more-streams", (a, b) => others(b) - others(a)],
  ["sample-rate", (a, b) => (a.streams.heartRate?.everySeconds ?? Infinity) - (b.streams.heartRate?.everySeconds ?? Infinity) || samples(b) - samples(a)],
  ["maker", (a, b) => kindRank(a) - kindRank(b)],
];

/** The order of most detail: below 0 when `a` has more (RULES, then the copy the index had first). */
export function moreDetail(a: WorkoutCopy, b: WorkoutCopy): number {
  for (const [, compare] of RULES) {
    const by = compare(a, b);
    if (by !== 0 && !Number.isNaN(by)) return by;
  }
  return order(a, b);
}

/** The first rule by which `chosen` has more detail than `next`. */
function decidingRule(chosen: WorkoutCopy, next: WorkoutCopy): DetailRule {
  for (const [rule, compare] of RULES) {
    const by = compare(chosen, next);
    if (by !== 0 && !Number.isNaN(by)) return rule;
  }
  return "first";
}

const others = (copy: WorkoutCopy) => OTHER_STREAMS.filter((stream) => copy.streams[stream]).length;
const samples = (copy: WorkoutCopy) => Object.values(copy.streams).reduce((n, stream) => n + (stream?.samples ?? 0), 0);
const kindRank = (copy: WorkoutCopy) => KIND_RANK[SOURCE_KINDS[copy.origin] ?? "aggregator"];

/** The index's order, then the source's: the copy had first comes first. */
function order(a: WorkoutCopy, b: WorkoutCopy): number {
  return (a.event ?? Infinity) - (b.event ?? Infinity) || a.origin.localeCompare(b.origin) || a.nativeId.localeCompare(b.nativeId);
}
