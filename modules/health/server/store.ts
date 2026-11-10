// The health records the archive keeps, in the module's folder of the archive's folder, modules/health/ (never
// committed; real records stay there), or in health/ while an archive's are still there (HEALTH_MOVE):
//
//   health/imported.json   what `npm run health -- import` read from the health exports (HEALTH_EXPORTS: Everlab's,
//                          then My Health Record's, each in platform-exports/<platform>/<export date>/), written whole
//                          each time: every result of every lab report it reads, and which files it read, left to the
//                          file below, or could not read.
//   health/by-hand.json    reviewed by hand, never written by code: the person the results are judged for (date of
//                          birth and sex), the results of the PDFs the import cannot read (transcribed, each with its
//                          file and page), the physical assessment as the report has it, trusted heart-rate
//                          recordings, treatments that answer a result, and the records that are no lab result
//                          (immunisations, medicines prescribed and dispensed, Medicare's services and PBS items), each
//                          with the files it was read from; which files are someone's transcription rather than the
//                          platform's own print, and the files that hold nothing to import.
//   health/lab-intervals.json  reviewed by hand too: the labs' printed intervals for the tests no guideline covers
//                          (labIntervals.ts).
//
// One lab's result for one test on one day is kept once, whichever exports print it (sameResultOnce). The server
// reads both files on each request it answers (they are small), so an edit to by-hand.json shows at once.

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { atomicWrite, Effect, movedPath, type ModuleMove, type Run } from "../../../sdk/server.ts";

/**
 * Where the records are: the module's own folder of the archive's folder, modules/health/, which they were moved into
 * from health/ (the archive's folder's, from before modules kept their files in theirs). An archive whose records are
 * still in health/ is read there until `npm run archive -- migrate module-data` moves them (the module's `moves`).
 */
export const HEALTH_MOVE: ModuleMove = { from: "health", to: "." };

/**
 * The exports health records are read from, in the archive's folder, in the order their copies lead: Everlab's (the
 * results the page was built on), then My Health Record's (the labs' own reports, and the records that are no lab
 * result). A result both print is shown as the first's, with the other's file beside it.
 */
export const HEALTH_EXPORTS = [join("platform-exports", "everlab"), join("platform-exports", "my-health-record")] as const;
export const IMPORTED_FILE = "imported.json";
export const BY_HAND_FILE = "by-hand.json";
export const LAB_INTERVALS_FILE = "lab-intervals.json";

/** One result as a report printed it. */
export interface Reading {
  /** The test (catalogue.ts), or "unknown:<printed name>" for a name no test has. */
  test: string;
  /** The day it was collected, YYYY-MM-DD. */
  date: string;
  /** A number, or null for a result in words. */
  value: number | null;
  /** A value printed as more or less than a number: ">90". */
  qualifier: "<" | ">" | null;
  /** A result in words ("Negative"), or null. */
  text: string | null;
  /** The unit as printed. */
  unit: string | null;
  /** The name as printed. */
  printed: string;
  /** The lab's printed range, kept as evidence: never used to judge or order anything. */
  labRange: string | null;
  lab: string;
  /** Where it was read: the file (from the archive's folder) and page, "<file> p2"; two when two files print it alike. */
  sources: string[];
  /** The same result printed another way: "34 mmol/mol", "class II", "Moderate". */
  alsoAs: string[];
  /** What the report says beside it: "Site: Nose Swab", "fasting". */
  note: string | null;
}

/** What one import read, written to health/imported.json. */
export interface Imported {
  version: 1;
  /** When it was read, ISO. */
  importedAt: string;
  /** Each PDF found, from the archive's folder, and how it was read: as a lab report, by hand, skipped by hand, or not at all. */
  files: Array<{ path: string; read: "report" | "by-hand" | "skipped" | "unread" }>;
  readings: Reading[];
}

/** Where a number in the physical assessment came from. */
export type Provenance = "measured" | "everlab-test" | "wearable" | "everlab-score";

/** A number (or words) the physical assessment prints, or, for "measured", a reading by test. */
export interface PhysicalItem {
  from: Provenance;
  /** For a measurement kept as a reading (blood pressure): its test, whose reading on the assessment's day it shows. */
  test?: string;
  label?: string;
  value?: number;
  text?: string;
  unit?: string;
  /** What Everlab called it, as printed ("Optimal"). */
  everlab?: string;
  page?: number;
  /** For a heart-rate zone's lower bound: its zone, so the page can set the zones beside a recorded peak. */
  zone?: number;
}

export interface Physical {
  file: string;
  /** The day of the assessment. */
  date: string;
  /** The day it was printed from the app. */
  printed: string;
  items: PhysicalItem[];
  /** Parts of the assessment the printout has no results for. */
  missing: string[];
  /** What the report names without showing (how a number was worked out). */
  unexplained: string | null;
}

/** A run recorded with a chest strap, as its sharing page summarises it: the SDK's shape, which the Fitness page shows (RunsByHand). */
export type { Run };

/** A treatment that answers a system's results (allergy shots for the allergy results). */
export interface Treatment {
  /** The system whose results it answers, as catalogue.ts keys them ("allergy"). */
  system: string;
  what: string;
  /** Since when, YYYY-MM or YYYY-MM-DD. */
  since: string;
}

/** A transcribed document: its file, lab and day, and its results. */
export interface ByHandDocument {
  file: string;
  lab: string;
  date: string;
  readings: Array<{
    test: string;
    date?: string;
    value?: number;
    qualifier?: "<" | ">";
    text?: string;
    unit?: string;
    printed: string;
    labRange?: string;
    alsoAs?: string[];
    note?: string;
    page?: number;
  }>;
}

/** A vaccine given, as the immunisation register has it. */
export interface Immunisation {
  /** The day it was given, YYYY-MM-DD. */
  date: string;
  /** What it protects against, as printed ("Tetanus"). */
  against: string;
  /** The vaccine's brand, as printed. */
  vaccine: string;
  /** Where it was read: each file (from the archive's folder), with " p<page>" where it helps. */
  sources: string[];
}

/** A medicine prescribed or dispensed, as the prescription and dispense records have it. */
export interface MedicineRecord {
  date: string;
  record: "prescribed" | "dispensed";
  /** The active ingredients, as printed. */
  medicine: string;
  brand?: string;
  directions?: string;
  /** The supply, as printed ("Supply 10, original supply"). */
  supply?: string;
  sources: string[];
}

/** A Medicare service (an MBS item) claimed, with what it cost where a claims statement gives it. */
export interface MedicareService {
  date: string;
  /** The MBS item number, as printed ("90001"). */
  item: string;
  description: string;
  provider?: string;
  /** In dollars, from a claims statement: the fee charged, Medicare's benefit, the gap the claimant paid, and how it was paid. */
  fee?: { charged: number; benefit: number; gap: number; paid: string };
  sources: string[];
}

/** A medicine supplied under the PBS (or RPBS), as Medicare's overview lists it. */
export interface PbsItem {
  prescribed: string;
  supplied: string;
  /** The generic name, as printed. */
  medicine: string;
  brand: string;
  /** The form and strength, as printed. */
  form: string;
  quantity: number;
  repeats: number;
  /** The PBS item code. */
  code: string;
  sources: string[];
}

export interface ByHand {
  version: 1;
  person: { born: string; sex: "male" | "female" };
  documents: ByHandDocument[];
  physical: Physical | null;
  runs: Run[];
  treatments: Treatment[];
  immunisations?: Immunisation[];
  medicines?: MedicineRecord[];
  medicare?: { services: MedicareService[]; pbs: PbsItem[] };
  /**
   * Files that are someone's transcription of what a platform shows, not its own print (a portal that prints five rows
   * a page, copied out whole by an agent): a record read only from these is shown as transcribed. Why, for each.
   */
  transcriptions?: Array<{ file: string; why: string }>;
  /** Files read by hand that hold nothing to import (a viewer's page of a report beside the report itself), and why. */
  skipped?: Array<{ file: string; why: string }>;
}

/** The health folder of the archive's folder `dataDir`: modules/health/, or health/ while the records are still there and not in modules/health/ (HEALTH_MOVE, read as `npm run archive -- migrate module-data` plans it). */
export const healthDir = (dataDir: string): string => movedPath(dataDir, "health", HEALTH_MOVE);

/** Where a file of the records is, from the archive's folder, for what is said of it: modules/health/<file>, or health/<file> while it is there. */
export const healthFileText = (dataDir: string, file: string): string => relative(dataDir, join(healthDir(dataDir), file));

/** health/imported.json, or null when nothing has been imported. */
export async function readImported(dataDir: string): Promise<Imported | null> {
  return readJson<Imported>(join(healthDir(dataDir), IMPORTED_FILE));
}

/** health/by-hand.json, or null when there is none; an Error naming what is wrong when it is not as this file says. */
export async function readByHand(dataDir: string): Promise<ByHand | null> {
  const file = join(healthDir(dataDir), BY_HAND_FILE);
  const found = await readJson<ByHand>(file);
  if (found === null) return null;
  const wrong = byHandProblem(found);
  if (wrong) throw new Error(`${file}: ${wrong}`);
  return found;
}

/** What is wrong with a by-hand file, or null. */
export function byHandProblem(file: ByHand): string | null {
  if (file.version !== 1) return "version is 1";
  if (!isDay(file.person?.born)) return "person.born is a date, YYYY-MM-DD";
  if (file.person.sex !== "male" && file.person.sex !== "female") return "person.sex is male or female";
  for (const document of file.documents ?? []) {
    if (!document.file || !document.lab || !isDay(document.date)) return `each document has a file, a lab and a date (${document.file ?? "one"} does not)`;
    for (const reading of document.readings) {
      if (!reading.test || !reading.printed) return `each reading of ${document.file} has a test and its printed name`;
      if (reading.date !== undefined && !isDay(reading.date)) return `${reading.test} in ${document.file}: date is YYYY-MM-DD`;
      if ((reading.value === undefined) === (reading.text === undefined)) return `${reading.test} in ${document.file}: give a value or a text, one of them`;
    }
  }
  for (const run of file.runs ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(run.start)) return `a run's start is YYYY-MM-DDTHH:MM, not ${run.start}`;
  }
  const records: Array<[string, { sources?: unknown }, unknown[]]> = [
    ...(file.immunisations ?? []).map((r): [string, typeof r, unknown[]] => [`immunisation ${r.vaccine}`, r, [r.date]]),
    ...(file.medicines ?? []).map((r): [string, typeof r, unknown[]] => [`medicine ${r.medicine}`, r, [r.date]]),
    ...(file.medicare?.services ?? []).map((r): [string, typeof r, unknown[]] => [`Medicare item ${r.item}`, r, [r.date]]),
    ...(file.medicare?.pbs ?? []).map((r): [string, typeof r, unknown[]] => [`PBS item ${r.code}`, r, [r.prescribed, r.supplied]]),
  ];
  for (const [what, record, days] of records) {
    if (!days.every(isDay)) return `${what}: its dates are YYYY-MM-DD`;
    if (!Array.isArray(record.sources) || record.sources.length === 0) return `${what}: name the files it was read from in sources`;
  }
  for (const medicine of file.medicines ?? []) {
    if (medicine.record !== "prescribed" && medicine.record !== "dispensed") return `medicine ${medicine.medicine}: record is prescribed or dispensed`;
  }
  return null;
}

/** Every file by-hand.json reads, from the archive's folder: what it transcribes, and what it skips. */
export function byHandFiles(file: ByHand | null): { transcribed: Set<string>; skipped: Set<string> } {
  if (!file) return { transcribed: new Set(), skipped: new Set() };
  const sources = [
    ...(file.immunisations ?? []),
    ...(file.medicines ?? []),
    ...(file.medicare?.services ?? []),
    ...(file.medicare?.pbs ?? []),
  ].flatMap((record) => record.sources.map(fileOf));
  return {
    transcribed: new Set([
      ...file.documents.map((document) => document.file),
      ...(file.physical ? [file.physical.file] : []),
      ...sources,
      ...(file.transcriptions ?? []).map((t) => t.file),
    ]),
    skipped: new Set((file.skipped ?? []).map((s) => s.file)),
  };
}

/** A source's file: "<file> p2" as "<file>". */
export function fileOf(source: string): string {
  return source.replace(/ p\d+$/, "");
}

/** Where a reading's first export stands in HEALTH_EXPORTS: the lower, the more it leads; past them all for another place. */
function exportRank(reading: Reading): number {
  const ranks = reading.sources.map((source) => HEALTH_EXPORTS.findIndex((root) => source.startsWith(`${root}/`))).filter((rank) => rank >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : HEALTH_EXPORTS.length;
}

/** One lab's result for a test on a day: what it is kept once by. */
function resultKey(reading: Reading): string {
  return JSON.stringify([reading.lab, reading.date, reading.test]);
}

/** A result as a reading prints it, to compare: "<90", "5.3", "negative". */
function resultOf(reading: Reading): string {
  return reading.value !== null ? `${reading.qualifier ?? ""}${reading.value}` : (reading.text ?? "").trim().toLowerCase();
}

/**
 * Each lab's result for a test on a day kept once, whichever exports print it (Everlab's copy of a report and My
 * Health Record's): the copy from the first of HEALTH_EXPORTS leads, the others' files join its sources, and a result
 * one prints differently is kept beside it as "also printed as" (printedDifferently says which). In date and test order.
 */
export function sameResultOnce(readings: readonly Reading[]): Reading[] {
  const groups = new Map<string, Reading[]>();
  for (const reading of readings) groups.set(resultKey(reading), [...(groups.get(resultKey(reading)) ?? []), reading]);
  const kept = [...groups.values()].map((group) => {
    const [lead, ...others] = [...group].sort((a, b) => exportRank(a) - exportRank(b));
    const alsoAs = [...lead.alsoAs];
    for (const other of others) {
      for (const also of [...(resultOf(other) === resultOf(lead) ? [] : [printedResult(other)]), ...other.alsoAs]) if (!alsoAs.includes(also)) alsoAs.push(also);
    }
    return { ...lead, alsoAs, sources: [...new Set([lead, ...others].flatMap((r) => r.sources))] };
  });
  return kept.sort((a, b) => a.date.localeCompare(b.date) || a.test.localeCompare(b.test) || a.sources[0].localeCompare(b.sources[0]));
}

/** The results two exports print differently (sameResultOnce keeps the first's): each lab, day and test, and the files that print it. */
export function printedDifferently(readings: readonly Reading[]): Array<{ lab: string; date: string; test: string; sources: string[] }> {
  const groups = new Map<string, Reading[]>();
  for (const reading of readings) groups.set(resultKey(reading), [...(groups.get(resultKey(reading)) ?? []), reading]);
  return [...groups.values()]
    .filter((group) => new Set(group.map(resultOf)).size > 1)
    .map((group) => ({ lab: group[0].lab, date: group[0].date, test: group[0].test, sources: group.flatMap((r) => r.sources) }));
}

/** Whether a record was read only from transcriptions (by-hand.json's `transcriptions`), never from a platform's own print. */
export function onlyTranscribed(record: { sources: readonly string[] }, byHand: ByHand): boolean {
  const transcriptions = new Set((byHand.transcriptions ?? []).map((t) => t.file));
  return record.sources.every((source) => transcriptions.has(fileOf(source)));
}

/** A reading's result as printed: "5.3 mmol/L", "Negative". */
function printedResult(reading: Reading): string {
  return reading.value !== null ? `${reading.qualifier ?? ""}${reading.value}${reading.unit ? ` ${reading.unit}` : ""}` : (reading.text ?? "");
}

/** The readings a by-hand file transcribes, as an import's readings are. */
export function byHandReadings(file: ByHand): Reading[] {
  return file.documents.flatMap((document) =>
    document.readings.map((reading) => ({
      test: reading.test,
      date: reading.date ?? document.date,
      value: reading.value ?? null,
      qualifier: reading.qualifier ?? null,
      text: reading.text ?? null,
      unit: reading.unit ?? null,
      printed: reading.printed,
      labRange: reading.labRange ?? null,
      lab: document.lab,
      sources: [reading.page === undefined ? document.file : `${document.file} p${reading.page}`],
      alsoAs: reading.alsoAs ?? [],
      note: reading.note ?? null,
    })),
  );
}

/**
 * The runs transcribed by hand, for the Fitness page (the RunsByHand service the module offers, module.ts): an error
 * naming the file alone while by-hand.json cannot be read, what is wrong with it said at each read in the log, not the
 * page, as its results are then missing too.
 */
export const runsByHand = (dataDir: string): Effect.Effect<readonly Run[], Error> =>
  Effect.tryPromise({ try: () => readByHand(dataDir), catch: (error) => error as Error }).pipe(
    Effect.map((file) => file?.runs ?? []),
    Effect.tapError((error) => Effect.sync(() => console.error(`${error.message}; its runs are left out until it is fixed`))),
    Effect.mapError(() => new Error(`${healthFileText(dataDir, BY_HAND_FILE)} cannot be read`)),
  );

/** Writes health/imported.json whole (the SDK's atomicWrite), so a reader never sees half of it. */
export async function writeImported(dataDir: string, imported: Imported): Promise<string> {
  const file = join(healthDir(dataDir), IMPORTED_FILE);
  await atomicWrite(file, `${JSON.stringify(imported, null, 2)}\n`);
  return file;
}

/** A JSON file, or null when there is none; an Error naming the file when it is not JSON. */
export async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${file} is not JSON: ${(error as Error).message}`);
  }
}

export function isDay(text: unknown): text is string {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}
