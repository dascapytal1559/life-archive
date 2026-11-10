// What the Health tab's page and the archive's server say to each other: one answer (GET /life-archive/api/m/health,
// server/http.ts) with every test already judged, graded and ordered, the authority's bands and their rungs
// over time for its chart, the physical assessment by where each number came from, the highest heart rate a trusted
// recording holds (the recordings themselves are the Fitness page's, the exercise module's), and the records that are no lab result (immunisations, medicines, Medicare's services and PBS items).
// The page only draws it.
//
// The route is the health module's, under the viewer's /life-archive/ (sdk/wire.ts's moduleApi), which Tailscale Serve
// passes on to the tailnet whole, so the captain's phone reaches it as it reaches the rest of the viewer; the tailnet's
// ACL admits only his own devices.

import { moduleApi } from "../../sdk/wire.ts";

/** The results' route: the module's, under the viewer's API beside its tabs' (see above). */
export const HEALTH_API = moduleApi("health");

/**
 * How a result stands by the authority: past its line far out, out or mildly out (by the grades past it), at the edge
 * of it, in it, out but answered by a treatment, or not judged (no authority for the test, or none for the age, or
 * words no rule reads).
 */
export type Status = "far" | "out" | "mild" | "edge" | "in" | "treated" | "unjudged";

/** The order the page lists tests in: what needs looking at first, what is fine after, what is not judged last. */
export const STATUS_ORDER: readonly Status[] = ["far", "out", "mild", "edge", "in", "treated", "unjudged"];

/** A grade of the range: in it, or how far past its line. */
export type Grade = "in" | "mild" | "out" | "far";

/** How far a source can be leaned on: 3, a clinical standard made for this; 0, the dashboard's own rule (off). */
export type Stars = 0 | 1 | 2 | 3;

/**
 * One rung of a range, from in range out to far out on either side: its limits, the source that sets it (the line's
 * source for in range, the grading's past it) and that source's name for it.
 */
export interface Rung extends Limits {
  grade: Grade;
  side: "in" | "above" | "below";
  source: string;
  label: string | null;
}

/** An interval: null for no limit that way; open, the limit itself is outside it. */
export interface Limits {
  low: number | null;
  high: number | null;
  lowOpen: boolean;
  highOpen: boolean;
}

/** The authority's interval over a stretch of days [from, to), YYYY-MM-DD, with its rungs: a new stretch where an age band ends. */
export interface BandSpan extends Limits {
  from: string;
  to: string;
  rungs: Rung[];
}

export interface HealthPoint {
  /** The day it was collected, YYYY-MM-DD. */
  date: string;
  /** The person's age that day, in whole years. */
  age: number;
  value: number | null;
  qualifier: "<" | ">" | null;
  text: string | null;
  /** The unit as printed. */
  unit: string | null;
  printed: string;
  status: Status;
  /** The interval it was judged by (the band for that age), or null. */
  limits: Limits | null;
  /** The source of the rung it falls in (the line's in range or at the edge, the grading's past it), or null. */
  by: string | null;
  /** The lab's printed range: evidence only, never what it is judged by. */
  labRange: string | null;
  lab: string;
  sources: string[];
  alsoAs: string[];
  note: string | null;
}

/**
 * What kind of range an authority gives: where healthy adults' results fall (a reference interval), a limit set by
 * risk or diagnosis (a decision limit), a lab's own printed interval chosen once, or a result read by its words; or,
 * for a source that only grades past another's line, grades (a named source's) or the dashboard's own rule.
 */
export type RangeKind = "reference-interval" | "decision-limit" | "lab-interval" | "words" | "grading" | "own-rule";

/** One band of a test's authority as the table holds it: for a sex (null: both) and ages [from, to) (to null: no end). */
export interface AuthorityBand extends Limits {
  sex: "male" | "female" | null;
  ages: [number, number | null] | null;
}

/**
 * How one side of a test's line is graded: by which source, with how its grades were taken (units, conversions); no
 * source (null) when none grades it, and a result past the line there is out, nothing finer.
 */
export interface GradingInfo {
  side: "above" | "below";
  source: string | null;
  note: string | null;
}

/** Which source sets one side's line: the test's own, or another's (vitamin D's upper limit, by the IOM). */
export interface LineInfo {
  side: "above" | "below";
  source: string;
}

export interface HealthTest {
  key: string;
  name: string;
  unit: string | null;
  /** The body system's name ("Kidneys and salts"). */
  system: string;
  /** Numbers (a chart or a gauge) or words (a screen's result). */
  kind: "number" | "words";
  /** Its latest result's status, which orders it. */
  status: Status;
  /**
   * How far its latest result is inside the interval (positive) or outside it (negative), as a share of the
   * interval's width (or of its one limit); null when not judged. Orders tests within a status.
   */
  margin: number | null;
  /** Oldest first. */
  points: HealthPoint[];
  /** The authority's interval over the chart's span, with its rungs, for a number with an authority. */
  bands: BandSpan[];
  /** The rungs of the band its latest result was judged by, in range then above then below, nearest first; [] when none. */
  rungs: Rung[];
  /**
   * The values its chart runs over, fixed for its results (judge.ts's scaleOf): to a limit no result goes past, else
   * out to the end of the rung the farthest result falls in.
   */
  scale: [number, number] | null;
  /**
   * The authority: a source's key (HealthAnswer.sources), its note, what is particular to this test in how its range
   * was built (server/rangeAccounts.ts), every band the table holds for it, the source of each side's line (the
   * test's own, or another's where another sets that side), and how each side with a line is graded past it; null
   * when there is none.
   */
  authority: { source: string; note: string | null; specifics: string | null; bands: AuthorityBand[]; lines: LineInfo[]; gradings: GradingInfo[] } | null;
  /** Why there is no authority, when there is none. */
  noAuthority: string | null;
  /** A screen read by its words: the word an expected result is shown as ("Clear", "Immune"; an unexpected one is
   * "Positive"), and how the screen is read, in a plain line. Null for a test of numbers. */
  screen: { shown: "Clear" | "Immune"; line: string } | null;
  /** The treatment that answers it, with the month it began ("<treatment>, since <month>"), when one does. */
  treatment: string | null;
}

export interface HealthSource {
  key: string;
  name: string;
  citation: string;
  url: string | null;
  /** How the ranges taken from it were built (server/rangeAccounts.ts). */
  kind: RangeKind;
  publishes: string;
  taken: string;
  uncovered: string;
  wordingFrom: string;
  stars: Stars;
  /** Why it has those stars. */
  starsWhy: string;
  /** Further places it was read from, where its figure was read second-hand. */
  links: Array<{ label: string; url: string }>;
}

/** Where a number in the physical assessment came from. */
export type Provenance = "measured" | "everlab-test" | "wearable" | "everlab-score";

export interface PhysicalNumber {
  label: string;
  value: number | null;
  text: string | null;
  unit: string | null;
  /** What Everlab called it, as printed. */
  everlab: string | null;
  page: number | null;
  /** For a measurement judged by the authority (blood pressure): its status. */
  status: Status | null;
}

export interface PhysicalAnswer {
  file: string;
  date: string;
  printed: string;
  /** Its numbers, by where they came from, in the order PROVENANCE lists them. */
  groups: Array<{ from: Provenance; numbers: PhysicalNumber[] }>;
  missing: string[];
  unexplained: string | null;
  /** Everlab's zone heart rates, by zone, for the page to set beside the recorded peak. */
  zones: Array<{ zone: number; bpm: number }>;
}

/** The Australian Immunisation Handbook, the source of every immunisation interval the page shows. */
export const IMMUNISATION_HANDBOOK = "https://immunisationhandbook.health.gov.au/";

/** A disease by its medical name and, where it differs, its everyday one ("Pertussis", "whooping cough"). */
export interface DiseaseName {
  name: string;
  everyday: string | null;
}

/** A vaccine given. */
export interface ImmunisationRecord {
  date: string;
  /** What it protects against, as printed. */
  against: string;
  /** Each disease it protects against, split from a combined vaccine's (server/immunisations.ts). */
  diseases: DiseaseName[];
  vaccine: string;
  sources: string[];
  /** Read only from someone's transcription, never from the platform's own print. */
  transcribed: boolean;
}

/**
 * How long a disease's protection runs from its latest dose, as the Australian Immunisation Handbook has it for adults:
 * until a booster interval ends; until the next dose of a course the record holds too few doses of; lasting (lifelong,
 * or no booster set); or null, where the Handbook sets no one interval or the lookup does not know the disease.
 */
export type ProtectionSpan =
  | { kind: "until"; until: string; interval: string }
  | { kind: "course"; until: string; doses: number; of: number }
  | { kind: "lasting"; label: "lifelong" | "no booster" }
  | null;

/** One disease the immunisations protect against: its latest dose, how many doses name it, and how long it runs. */
export interface ProtectionRow {
  disease: DiseaseName;
  latest: { date: string; vaccine: string };
  doses: number;
  span: ProtectionSpan;
  /** The Handbook's words for adults and its page; null for a disease the lookup does not know. */
  handbook: { says: string; url: string } | null;
}

/** A medicine prescribed or dispensed. */
export interface MedicineAnswer {
  date: string;
  record: "prescribed" | "dispensed";
  medicine: string;
  brand: string | null;
  directions: string | null;
  supply: string | null;
  sources: string[];
  transcribed: boolean;
}

/** A Medicare service (an MBS item) claimed, with what it cost where a claims statement says. */
export interface ServiceAnswer {
  date: string;
  item: string;
  description: string;
  provider: string | null;
  /** In dollars: the fee charged, Medicare's benefit, the gap paid, and how it was paid; null where no statement says. */
  fee: { charged: number; benefit: number; gap: number; paid: string } | null;
  sources: string[];
  transcribed: boolean;
}

/** A medicine supplied under the PBS. */
export interface PbsAnswer {
  prescribed: string;
  supplied: string;
  medicine: string;
  brand: string;
  form: string;
  quantity: number;
  repeats: number;
  code: string;
  sources: string[];
  transcribed: boolean;
}

/** The records that are no lab result, each list newest first. */
export interface HealthRecords {
  immunisations: ImmunisationRecord[];
  /** One row per disease the immunisations protect against, the soonest to end first. */
  protection: ProtectionRow[];
  medicines: MedicineAnswer[];
  services: ServiceAnswer[];
  pbs: PbsAnswer[];
  /** The files that are someone's transcription, not a platform's own print, and why, so the page can say so. */
  transcriptions: Array<{ file: string; why: string }>;
}

export interface HealthAnswer {
  /** The person the results are judged for. */
  born: string;
  sex: "male" | "female";
  /** Today, local, YYYY-MM-DD: the charts run to it. */
  today: string;
  /** The days every chart spans, so they line up: from the first of January of the year of the earliest result, to today. */
  span: { from: string; to: string };
  /** In the page's order: by STATUS_ORDER, then by margin, then by name. */
  tests: HealthTest[];
  /** The catalogue's body systems in its order: the key each is coloured by and its name, as a test's `system` gives it. */
  systems: { key: string; name: string }[];
  sources: HealthSource[];
  /** What each number of stars means. */
  stars: Record<Stars, string>;
  rangesVersion: string;
  physical: PhysicalAnswer | null;
  /**
   * The highest heart rate a trusted recording (a chest strap's) holds, with when, on what, from which source, and the
   * Fitness page's activity it was recorded in, whose address the page makes where it is served; null without one, as
   * with the exercise module off.
   */
  peak: { bpm: number; date: string; age: number; sensor: string | null; recorder: string | null; source: string; activity: string } | null;
  /** Whether the exercise module is on, so there is a Fitness page to link. */
  exercise: boolean;
  records: HealthRecords;
  /** Files of the exports nothing has read: neither a report the import reads nor transcribed or skipped by hand. */
  unread: string[];
  /** When the exports were last imported, ISO; null if never. */
  importedAt: string | null;
}

/** Age in whole years on `day` of someone born on `born` (both YYYY-MM-DD). */
export function ageOn(born: string, day: string): number {
  const [by, bm, bd] = born.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Whether `value` is within `limits`. */
export function within(value: number, limits: Limits): boolean {
  const { low, high, lowOpen, highOpen } = limits;
  if (low !== null && (value < low || (lowOpen && value === low))) return false;
  if (high !== null && (value > high || (highOpen && value === high))) return false;
  return true;
}

/** The rung `value` falls in: the furthest on its side when it is past them all (below a floor of 0). */
export function rungFor(value: number, rungs: readonly Rung[]): Rung | null {
  const found = rungs.find((rung) => within(value, rung));
  if (found) return found;
  const range = rungs.find((rung) => rung.side === "in");
  const side = range?.high != null && value > range.high ? "above" : "below";
  return rungs.filter((rung) => rung.side === side).at(-1) ?? null;
}
