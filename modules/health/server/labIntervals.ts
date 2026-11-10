// The labs' printed intervals for the tests no guideline or harmonised interval covers (ranges.ts's LAB_TESTS). Which
// lab's interval judges which test is the archive's owner's choice, kept in the archive's folder, never in code: the
// labs that tested someone, and when, are their own health record. Without the file those tests are not judged, and
// say why.
//
//   health/lab-intervals.json   reviewed by hand, never written by code: each lab whose printed intervals are used, the
//                               year and reports it printed them on, the sex they were printed for, and each test's
//                               interval as printed. A test takes one lab's interval, chosen once and kept whichever
//                               lab runs it later.
//
// rangesWith, sourcesWith and accountsWith set them beside the table's own (ranges.ts, rangeAccounts.ts), for the
// page's answer (judge.ts) and `npm run health -- ranges`.

import { join } from "node:path";
import { labIntervalAccount, SOURCE_ACCOUNTS, type SourceAccount } from "./rangeAccounts.ts";
import { ADULT, FURTHER_SOURCES, LAB_TESTS, PRIMARY_SOURCES, RANGES, SOURCES, type Authority, type Sex, type Source, type SourceKey } from "./ranges.ts";
import { healthDir, LAB_INTERVALS_FILE, readJson } from "./store.ts";

/** One test's interval as the lab printed it. Limits are inclusive unless marked open, as in ranges.ts. */
export interface PrintedInterval {
  low?: number;
  high?: number;
  lowOpen?: boolean;
  highOpen?: boolean;
}

/** One lab whose printed intervals judge the tests it is chosen for. */
export interface LabInterval {
  /** The key the page knows it by ("sample-2024"): lower-case letters, digits and dashes, none of the table's own. */
  key: string;
  /** The lab, as it names itself ("Sample Pathology"). */
  lab: string;
  /** The year it printed them, for the source's name: "Sample Pathology's interval (2024)". */
  year: number;
  /** The reports it printed them on, as the account says it after "as on": "its reports of July 2024". */
  reports: string;
  /** Whether it was chosen because it was the last lab to run these tests, not the lab most of them are judged by. */
  last?: boolean;
  /** The sex the intervals were printed for; they judge no one else. */
  sex: Sex;
  /** Each test (catalogue.ts's key, one of ranges.ts's LAB_TESTS) and its interval. */
  tests: Record<string, PrintedInterval>;
}

export interface LabIntervalsFile {
  version: 1;
  labs: LabInterval[];
}

/** health/lab-intervals.json's labs, none when there is no file; an Error naming what is wrong when it is not as this file says. */
export async function readLabIntervals(dataDir: string): Promise<LabInterval[]> {
  const file = join(healthDir(dataDir), LAB_INTERVALS_FILE);
  const found = await readJson<LabIntervalsFile>(file);
  if (found === null) return [];
  const wrong = labIntervalsProblem(found);
  if (wrong) throw new Error(`${file}: ${wrong}`);
  return found.labs;
}

const isLimit = (n: unknown) => n === undefined || (typeof n === "number" && Number.isFinite(n));

/** What is wrong with a lab-intervals file, or null. */
export function labIntervalsProblem(file: LabIntervalsFile): string | null {
  if (file?.version !== 1) return "version is 1";
  if (!Array.isArray(file.labs)) return "labs is a list";
  const keys = new Set<string>();
  const chosen = new Map<string, string>();
  for (const lab of file.labs) {
    if (typeof lab.key !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(lab.key)) return `each lab's key is lower-case letters, digits and dashes (${JSON.stringify(lab.key)} is not)`;
    if (lab.key in SOURCES) return `${lab.key} is the table's own source; give the lab another key`;
    if (keys.has(lab.key)) return `${lab.key} is named twice`;
    keys.add(lab.key);
    if (typeof lab.lab !== "string" || !lab.lab.trim()) return `${lab.key}: lab is the lab's name`;
    if (!Number.isInteger(lab.year)) return `${lab.key}: year is the year it printed them, a number`;
    if (typeof lab.reports !== "string" || !lab.reports.trim()) return `${lab.key}: reports names the reports it printed them on ("its reports of July 2024")`;
    if (lab.last !== undefined && typeof lab.last !== "boolean") return `${lab.key}: last is true or false`;
    if (lab.sex !== "male" && lab.sex !== "female") return `${lab.key}: sex is male or female`;
    if (typeof lab.tests !== "object" || lab.tests === null || Object.keys(lab.tests).length === 0) return `${lab.key}: tests names at least one test and its interval`;
    for (const [test, interval] of Object.entries(lab.tests)) {
      if (!(test in LAB_TESTS)) return `${lab.key}: ${test} is not a test judged by a lab's interval (ranges.ts's LAB_TESTS)${test in RANGES ? "; it has an authority of its own" : ""}`;
      const other = chosen.get(test);
      if (other) return `${test} takes one lab's interval, not ${other}'s and ${lab.key}'s`;
      chosen.set(test, lab.key);
      const { low, high } = interval ?? {};
      if (!isLimit(low) || !isLimit(high) || (low === undefined && high === undefined)) return `${lab.key}: ${test} gives a low or a high limit, as numbers`;
      if (low !== undefined && high !== undefined && low >= high) return `${lab.key}: ${test}'s low limit is under its high`;
    }
  }
  return null;
}

/** The authority for every test (ranges.ts's RANGES), each test a lab's interval is chosen for judged by it. */
export function rangesWith(labs: readonly LabInterval[]): Record<string, Authority> {
  const ranges: Record<string, Authority> = { ...RANGES };
  for (const lab of labs) {
    for (const [test, interval] of Object.entries(lab.tests)) ranges[test] = { source: lab.key, bands: [{ sex: lab.sex, ages: ADULT, ...interval }], ...LAB_TESTS[test] };
  }
  return ranges;
}

/** A lab's interval as a source: one star, as STARS gives a single lab's printed interval. */
function labSource(lab: LabInterval): Source {
  return {
    name: `${lab.lab}'s interval (${lab.year})`,
    citation: `${lab.lab}'s printed reference interval for an adult ${lab.sex === "male" ? "man" : "woman"}, as on ${lab.reports}: used, unchanged, for a test no guideline or harmonised interval covers${lab.last ? ` that ${lab.lab} was the last to run` : ""}.`,
    url: null,
    stars: 1,
    starsWhy: "This lab's own interval. Not independently published, but set for this lab's method, so it is the right comparison for a result from this lab.",
  };
}

/** Every source, the labs' after the table's primary ones and before those that set a side's line or grade past it. */
export function sourcesWith(labs: readonly LabInterval[]): Record<SourceKey, Source> {
  return { ...PRIMARY_SOURCES, ...Object.fromEntries(labs.map((lab) => [lab.key, labSource(lab)])), ...FURTHER_SOURCES };
}

/** How every source's ranges were built (rangeAccounts.ts), each lab's with them. */
export function accountsWith(labs: readonly LabInterval[]): Record<SourceKey, SourceAccount> {
  return { ...SOURCE_ACCOUNTS, ...Object.fromEntries(labs.map((lab) => [lab.key, labIntervalAccount(lab)])) };
}
