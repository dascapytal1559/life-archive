// The Health tab's results, on made-up data only (../fixtures/health.ts): reading Everlab's Pathology Results
// Report and QML Pathology's own report from their lines and from real (made-up) PDFs through PDFKit, the import over
// the export folders, one lab's result kept once whichever exports print it, the records that are no lab result, the one
// authority on range (every test has an entry, bands that do not overlap), judging by the band for the age on the day,
// the page's order, the physical assessment and heart rate, and the route: at the module's address and nowhere else,
// to the page alone, read only. The door that mounts it (the Host guard, the tailnet) is the core's, tested there.

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, type Peak } from "../../../sdk/server.ts";
import { ageOn, rungFor, STATUS_ORDER, type HealthAnswer, type Limits, type Rung } from "../wire.ts";
import { HEALTH_API } from "../wire.ts";
import {
  madeUpByHand, madeUpQmlReport, madeUpQmlReports, madeUpReport, madeUpReports, MADE_UP_LABS, MADE_UP_MHR_FILES, MADE_UP_PERSON, writeMadeUpHealth, writeMadeUpPdfs,
} from "../fixtures/health.ts";
import { TESTS, testOf, testPrinted, unitOf } from "./catalogue.ts";
import { dayOfPrinted, isRange, numberOf, readPathologyReport } from "./everlab.ts";
import { createHealthApi } from "./http.ts";
import { importHealth, sameOnce } from "./import.ts";
import { bandSpans, healthAnswer, judge, openEdge, recordsOf, rungsOf, scaleOf, standing } from "./judge.ts";
import { PDF_READER, readPdfLines, type PdfLine } from "./pdf.ts";
import { isQmlReport, readQmlReport } from "./qml.ts";
import { accountsWith, rangesWith, sourcesWith } from "./labIntervals.ts";
import { TEST_ACCOUNTS } from "./rangeAccounts.ts";
import { bandFor, gradingFor, lineSource, PERCENT, PERCENT_RULE, STARS, type Judged } from "./ranges.ts";
import { BY_HAND_FILE, byHandProblem, byHandReadings, healthDir, printedDifferently, runsByHand, sameResultOnce, type Imported, type Reading } from "./store.ts";

/** Whether this machine has its PDF reader (pdf.ts): swift on macOS, pdftotext elsewhere. The real PDFs' tests need it. */
const hasPdfReader = spawnSync(PDF_READER, [PDF_READER === "swift" ? "--version" : "-v"], { stdio: "ignore" }).error === undefined;

const limits = (low: number | null, high: number | null, lowOpen = false, highOpen = false): Limits => ({ low, high, lowOpen, highOpen });

// The authority as the made-up archive has it: the table's own, with the made-up labs' intervals (labIntervals.test.ts
// tests the table without them).
const RANGES = rangesWith(MADE_UP_LABS);
const SOURCES = sourcesWith(MADE_UP_LABS);
const SOURCE_ACCOUNTS = accountsWith(MADE_UP_LABS);

/** Every reading of the made-up reports, as the import reads them. */
function madeUpReadings(): Reading[] {
  return sameOnce(madeUpReports().flatMap((report) => readPathologyReport(report.pages, report.file)));
}

describe("reading a Pathology Results Report", () => {
  const readings = madeUpReadings();
  const find = (test: string, date: string) => readings.find((r) => r.test === test && r.date === date)!;

  it("reads each row's test, result, unit, printed range, lab and page", () => {
    expect(find("sodium", "2019-04-02")).toMatchObject({ value: 139, qualifier: null, unit: "mmol/L", labRange: "135-145", printed: "Sodium", lab: "Sample Pathology" });
    expect(find("sodium", "2022-08-10")).toMatchObject({ value: 141, printed: "S Sodium" });
    expect(find("sodium", "2022-08-10").sources[0]).toMatch(/2022-08-10_Sample_Pathology\/SE-_CHEMISTRY\.pdf p1$/);
    expect(find("platelets", "2022-08-10")).toMatchObject({ value: 228, unit: "x 10*9/L", labRange: "150-450" });
  });

  it("reads a result printed as more than a number, and a row with no unit", () => {
    expect(find("egfr", "2019-04-02")).toMatchObject({ value: 90, qualifier: ">", unit: null, labRange: ">59" });
    expect(find("chol-hdl", "2026-02-18")).toMatchObject({ value: 5.9, unit: null, labRange: "<4.5" });
  });

  it("keeps a result printed in another unit, or as a class, beside the one in the test's own unit", () => {
    expect(find("hba1c", "2026-02-18")).toMatchObject({ value: 5.8, unit: "%", alsoAs: ["40 mmol/mol"] });
    expect(find("lead", "2026-02-18")).toMatchObject({ value: 0.1, alsoAs: ["2.1 µg/dL"] });
    expect(find("ige-cat", "2026-02-18")).toMatchObject({ value: 2.4, unit: "kU/L", labRange: null, alsoAs: ["class II", "Moderate"] });
    expect(readings.filter((r) => r.test === "lead")).toHaveLength(1);
  });

  it("reads results in words, with the site a swab was taken from", () => {
    expect(find("hbsag", "2025-11-04")).toMatchObject({ value: null, text: "Negative" });
    expect(find("hbsab", "2025-11-04")).toMatchObject({ text: "Detected" });
    expect(find("swab-culture", "2023-05-11")).toMatchObject({ text: "No pathogens isolated", note: "Site: Throat Swab" });
  });

  it("keeps a name no test has as an unknown test", () => {
    const pages = madeUpReport("2026-01-05", [{ title: "SE-NEW PANEL", kind: "numbers", rows: [["Made-up Marker", "12", "U/L", "0-20"]] }]);
    expect(readPathologyReport(pages, "x.pdf")[0]).toMatchObject({ test: "unknown:made-upmarker", printed: "Made-up Marker", value: 12 });
  });

  it("refuses what is not one", () => {
    expect(() => readPathologyReport([[[["Something else", 50]]]], "x.pdf")).toThrow(/not a Pathology Results Report/);
  });

  it("reads printed days, numbers and ranges", () => {
    expect(dayOfPrinted("9 July 2024")).toBe("2024-07-09");
    expect(dayOfPrinted("5 June 1975")).toBe("1975-06-05");
    expect(dayOfPrinted("Someday")).toBeNull();
    expect(numberOf("> 90")).toEqual({ value: 90, qualifier: ">" });
    expect(numberOf("0.04")).toEqual({ value: 0.04, qualifier: null });
    expect(numberOf("Negative")).toBeNull();
    for (const range of ["135-145", "0-0.9", "<1.7", ">59", "> 1.00"]) expect(isRange(range)).toBe(true);
    for (const unit of ["mmol/L", "10*12/L", "x 10*9/L", "%"]) expect(isRange(unit)).toBe(false);
    expect(unitOf("umol/L")).toBe("µmol/L");
    expect(unitOf("x 10*9/L")).toBe("×10⁹/L");
  });
});

describe("reading a QML Pathology report, as My Health Record attaches it", () => {
  const [chemistry, screen] = madeUpQmlReports();
  const readings = [...readQmlReport(chemistry.pages, chemistry.file), ...readQmlReport(screen.pages, screen.file)];
  const find = (test: string) => readings.find((r) => r.test === test)!;

  it("reads each row's test, result and unit from one cell, the range in brackets, the lab and the collection's day", () => {
    expect(find("sodium")).toMatchObject({ value: 140, unit: "mmol/L", labRange: "137-147", printed: "Sodium", lab: "QML Pathology", date: "2024-07-09", note: null });
    expect(find("sodium").sources).toEqual([`${chemistry.file} p1`]);
    expect(find("egfr")).toMatchObject({ value: 90, qualifier: ">", unit: "mL/min", labRange: "over 59" });
  });

  it("knows a glucose taken fasting by the word beside its range", () => {
    expect(find("glucose-fasting")).toMatchObject({ value: 5.6, printed: "Glucose", note: "fasting", labRange: "3.0-6.0" });
  });

  it("keeps a count's share as how it was also printed, and its unit without the spaces", () => {
    expect(find("neutrophils")).toMatchObject({ value: 3.1, unit: "x10^9/L", alsoAs: ["55 %"] });
  });

  it("reads results in words, with the specimen noted, and passes over the comments and the foot of the page", () => {
    expect(find("chlamydia")).toMatchObject({ value: null, text: "Negative", note: "Specimen: urine" });
    expect(find("syphilis")).toMatchObject({ text: "Negative", note: null });
    expect(readings.map((r) => r.test)).toEqual(["sodium", "glucose-fasting", "egfr", "neutrophils", "syphilis", "chlamydia"]);
  });

  it("refuses what is not one, and reads nothing from a result printed in one cell", () => {
    expect(isQmlReport(madeUpReports()[0].pages)).toBe(false);
    expect(() => readQmlReport(madeUpReports()[0].pages, "x.pdf")).toThrow(/not a QML Pathology report/);
    const oneCell = madeUpQmlReport("2024-07-09", [{ title: "HIV TESTING", rows: [] }]);
    oneCell[0].splice(-3, 0, [["HIV antigen / HIV 1 HIV 2 antibody : Non reactive", 81]]);
    expect(readQmlReport(oneCell, "x.pdf")).toEqual([]);
  });
});

describe("one lab's result kept once, whichever exports print it", () => {
  const reading = (test: string, source: string, more: Partial<Reading> = {}): Reading => ({
    test, date: "2024-07-09", value: 140, qualifier: null, text: null, unit: "mmol/L", printed: test, labRange: null, lab: "QML Pathology", sources: [source], alsoAs: [], note: null, ...more,
  });
  const everlab = "platform-exports/everlab/2026-01-01/2024-07-09_QML/Panel.pdf p2";
  const mhr = "platform-exports/my-health-record/2026-03-20/pathology/01-chemistry-2024-07-09-attachment.pdf p1";

  it("keeps Everlab's copy, whichever comes first, with My Health Record's file beside it", () => {
    const [kept, ...rest] = sameResultOnce([reading("sodium", mhr, { printed: "Sodium" }), reading("sodium", everlab, { printed: "S Sodium" })]);
    expect(rest).toEqual([]);
    expect(kept).toMatchObject({ printed: "S Sodium", sources: [everlab, mhr], alsoAs: [] });
    expect(printedDifferently([reading("sodium", mhr), reading("sodium", everlab)])).toEqual([]);
  });

  it("keeps a result printed differently beside the one shown, and says so", () => {
    const both = [reading("sodium", everlab), reading("sodium", mhr, { value: 141 })];
    expect(sameResultOnce(both)[0]).toMatchObject({ value: 140, alsoAs: ["141 mmol/L"] });
    expect(printedDifferently(both)).toEqual([{ lab: "QML Pathology", date: "2024-07-09", test: "sodium", sources: [everlab, mhr] }]);
  });

  it("never joins another lab's, another day's or another test's", () => {
    const kept = sameResultOnce([reading("sodium", everlab), reading("sodium", mhr, { lab: "Sample Pathology" }), reading("sodium", mhr, { date: "2024-07-10" }), reading("potassium", mhr)]);
    expect(kept).toHaveLength(4);
  });
});

describe.skipIf(!hasPdfReader)(`a report as a PDF, read through ${PDF_READER}`, () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "health-pdf-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives the same results as its lines", async () => {
    const report = madeUpReports().find((r) => r.file.endsWith("SE-MPS_RAST.pdf"))!;
    const file = join(dir, "report.pdf");
    await writeMadeUpPdfs([{ file, pages: report.pages }]);
    const pages = (await readPdfLines([file])).get(file)!;
    expect(readPathologyReport(pages, report.file)).toEqual(readPathologyReport(report.pages, report.file));
  }, 60_000);

  it("gives a QML report's results as its lines do", async () => {
    const report = madeUpQmlReports()[0];
    const file = join(dir, "qml.pdf");
    await writeMadeUpPdfs([{ file, pages: report.pages }]);
    const pages = (await readPdfLines([file])).get(file)!;
    expect(readQmlReport(pages, report.file)).toEqual(readQmlReport(report.pages, report.file));
  }, 60_000);
});

describe("the import", () => {
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "health-import-"));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Files the import finds, read by made-up lines rather than PDFKit. */
  async function importOf(files: Record<string, ReturnType<typeof madeUpReport> | null>) {
    for (const file of Object.keys(files)) {
      await mkdir(join(dataDir, file, ".."), { recursive: true });
      await writeFile(join(dataDir, file), "made-up");
    }
    const scanned: PdfLine[][] = [[[["A scanned page", 50]]]];
    const read = async (paths: readonly string[]) => new Map(paths.map((path) => [path, files[path.slice(dataDir.length + 1)] ?? scanned]));
    return importHealth({ dataDir, byHand: madeUpByHand(), read, now: new Date("2026-10-16T00:00:00Z") });
  }

  it("reads every export's reports, dot files too, leaves the transcribed to by-hand.json, and lists the rest as unread", async () => {
    const reports = madeUpReports();
    const byHand = madeUpByHand();
    const imported = await importOf({
      ...Object.fromEntries(reports.map((r) => [r.file, r.pages])),
      [byHand.documents[0].file]: null,
      "platform-exports/everlab/2026-09-01/2026-08-01_Sample_Clinic/Scan.pdf": null,
    });
    const read = Object.fromEntries(imported.files.map((f) => [f.path, f.read]));
    expect(read[reports[1].file]).toBe("report");
    expect(reports[1].file).toMatch(/\/\.BLOOD_COUNT\.pdf$/);
    expect(read[byHand.documents[0].file]).toBe("by-hand");
    expect(read["platform-exports/everlab/2026-09-01/2026-08-01_Sample_Clinic/Scan.pdf"]).toBe("unread");
    expect(imported.readings).toEqual(madeUpReadings());
    expect(imported.importedAt).toBe("2026-10-16T00:00:00.000Z");
  });

  it("reads My Health Record's export beside Everlab's: QML's reports, what by-hand.json transcribes or skips, and a report it cannot read", async () => {
    const [chemistry, screen] = madeUpQmlReports();
    const unreadable = "platform-exports/my-health-record/2026-03-20/pathology/03-hiv-2024-07-09-attachment.pdf";
    const imported = await importOf({
      [chemistry.file]: chemistry.pages,
      [screen.file]: screen.pages,
      [unreadable]: madeUpQmlReport("2024-07-09", [{ title: "HIV TESTING", rows: [] }]),
      [MADE_UP_MHR_FILES.claims]: null,
      [MADE_UP_MHR_FILES.overview]: null,
      [MADE_UP_MHR_FILES.view]: null,
    });
    const read = Object.fromEntries(imported.files.map((f) => [f.path, f.read]));
    expect(read[chemistry.file]).toBe("report");
    expect(read[MADE_UP_MHR_FILES.claims]).toBe("by-hand");
    expect(read[MADE_UP_MHR_FILES.overview]).toBe("by-hand");
    expect(read[MADE_UP_MHR_FILES.view]).toBe("skipped");
    expect(read[unreadable]).toBe("unread");
    expect(imported.readings.filter((r) => r.lab === "QML Pathology").map((r) => r.test)).toEqual(["chlamydia", "egfr", "glucose-fasting", "neutrophils", "sodium", "syphilis"]);
  });

  it("keeps a panel exported twice once, with both files", () => {
    const [one] = readPathologyReport(madeUpReport("2026-02-18", [{ title: "SE- PSA VIRTUAL", kind: "numbers", rows: [["PSA", "0.70", "ug/L", "0.2-2.1"]] }]), "a/SE-_PSA_VIRTUAL.pdf");
    const twice = sameOnce([one, { ...one, sources: ["a/SE-_PSA_VIRTUAL_1.pdf p1"] }]);
    expect(twice).toHaveLength(1);
    expect(twice[0].sources).toEqual(["a/SE-_PSA_VIRTUAL.pdf p1", "a/SE-_PSA_VIRTUAL_1.pdf p1"]);
  });
});

describe("the one authority on range", () => {
  it("has an entry for every test, and a test for every entry", () => {
    expect(TESTS.filter((t) => !RANGES[t.key]).map((t) => t.key)).toEqual([]);
    expect(Object.keys(RANGES).filter((key) => !testOf(key))).toEqual([]);
  });

  it("names a source each entry cites, and a reason for each it cannot judge", () => {
    for (const [key, authority] of Object.entries(RANGES)) {
      if ("none" in authority) expect(authority.none.length, key).toBeGreaterThan(20);
      else expect(SOURCES[authority.source], key).toBeDefined();
    }
  });

  it("tells how every source's ranges were built, and what is particular only of tests it judges", () => {
    expect(Object.keys(SOURCE_ACCOUNTS).sort()).toEqual(Object.keys(SOURCES).sort());
    for (const [key, account] of Object.entries(SOURCE_ACCOUNTS)) {
      for (const part of [account.publishes, account.taken, account.uncovered, account.wordingFrom]) expect(part.length, key).toBeGreaterThan(20);
      expect(account.kind === "words", key).toBe(key === "words");
    }
    for (const key of Object.keys(TEST_ACCOUNTS)) expect(RANGES[key] && !("none" in RANGES[key]), key).toBe(true);
  });

  it("reads a test in words by its words, and every other by its bands", () => {
    for (const test of TESTS) {
      const authority = RANGES[test.key];
      if ("none" in authority) continue;
      expect(authority.source === "words", test.key).toBe(test.words !== undefined);
      if (!test.words) expect(authority.bands.length, test.key).toBeGreaterThan(0);
    }
  });

  it("never gives two bands for the same sex and age", () => {
    for (const [key, authority] of Object.entries(RANGES)) {
      if ("none" in authority) continue;
      for (const sex of ["male", "female"] as const) {
        for (let age = 0; age <= 110; age++) {
          const covering = authority.bands.filter((b) => (b.sex === undefined || b.sex === sex) && (b.ages === undefined || (age >= b.ages[0] && (b.ages[1] === null || age < b.ages[1]))));
          expect(covering.length, `${key} ${sex} ${age}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("picks the band for the age: urea's moves at 50 and 70, creatinine's ends at 60, phosphate's starts at 20", () => {
    expect(bandFor(RANGES.urea, "male", 49)).toMatchObject({ low: 3.5, high: 8.0 });
    expect(bandFor(RANGES.urea, "male", 50)).toMatchObject({ low: 4.0, high: 9.0 });
    expect(bandFor(RANGES.urea, "female", 70)).toMatchObject({ low: 4.0, high: 9.0 });
    expect(bandFor(RANGES.creatinine, "male", 59)).toMatchObject({ low: 60, high: 110 });
    expect(bandFor(RANGES.creatinine, "male", 60)).toBeNull();
    expect(bandFor(RANGES.phosphate, "male", 19)).toBeNull();
    expect(bandFor(RANGES.hdl, "female", 30)).toMatchObject({ low: 1.2 });
    expect(bandFor(RANGES.albumin, "male", 30)).toBeNull();
  });

  it("knows each test by every name its labs print", () => {
    expect(testPrinted("S Creatinine:")?.key).toBe("creatinine");
    expect(testPrinted("HAEMOGLOBIN")?.key).toBe("haemoglobin");
    expect(testPrinted("Dustmite")?.key).toBe("ige-dust-mite");
    expect(testPrinted("Other Anions")?.key).toBe("anion-gap");
  });
});

describe("judging", () => {
  it("works out the age in whole years, a year older on the birthday", () => {
    expect(ageOn("1975-06-15", "2025-06-14")).toBe(49);
    expect(ageOn("1975-06-15", "2025-06-15")).toBe(50);
    expect(ageOn("1996-02-29", "2026-02-28")).toBe(29);
  });

  it("is out past a limit, at the edge within 5% of one, in otherwise; an open limit is itself out", () => {
    expect(standing(4.1, limits(null, 3.0)).status).toBe("out");
    expect(standing(3.0, limits(null, 3.0))).toEqual({ status: "edge", margin: 0 });
    expect(standing(3.0, limits(null, 3.0, false, true)).status).toBe("out");
    expect(standing(5.2, limits(3.5, 5.2)).status).toBe("edge");
    expect(standing(4.3, limits(3.5, 5.2)).status).toBe("in");
    expect(standing(1.05, limits(1.0, null)).status).toBe("edge");
    expect(standing(-1.0, limits(-2.0, null, true)).status).toBe("in");
    expect(standing(4.1, limits(null, 3.0)).margin).toBeCloseTo(-0.3667, 3);
  });

  it("judges by the band for the age that day, never the lab's printed range", () => {
    const reading = (date: string, value: number): Reading => ({
      test: "urea", date, value, qualifier: null, text: null, unit: "mmol/L", printed: "Urea", labRange: "3.0-8.0", lab: "Sample Pathology", sources: ["x"], alsoAs: [], note: null,
    });
    const urea = testOf("urea");
    expect(judge(reading("2025-06-14", 8.4), urea, RANGES.urea, MADE_UP_PERSON)).toMatchObject({ age: 49, status: "out", limits: limits(3.5, 8.0), by: "aacb-urea" });
    expect(judge(reading("2025-06-15", 8.4), urea, RANGES.urea, MADE_UP_PERSON)).toMatchObject({ age: 50, status: "in", limits: limits(4.0, 9.0) });
  });

  it("draws the bands over time, a new stretch only where the age band changes", () => {
    expect(bandSpans(RANGES.urea, "male", "1975-06-15", "2019-01-01", "2026-10-16")).toMatchObject([
      { from: "2019-01-01", to: "2025-06-15", ...limits(3.5, 8.0) },
      { from: "2025-06-15", to: "2026-10-16", ...limits(4.0, 9.0) },
    ]);
    expect(bandSpans(RANGES.sodium, "male", "1975-06-15", "2019-01-01", "2026-10-16")).toHaveLength(1);
    expect(bandSpans(RANGES.albumin, "male", "1975-06-15", "2019-01-01", "2026-10-16")).toEqual([]);
    expect(bandSpans(RANGES.alp, "male", "2000-03-01", "2020-01-01", "2023-01-01")).toMatchObject([{ from: "2022-03-01", to: "2023-01-01", ...limits(30, 110) }]);
  });
});

describe("grading past the line", () => {
  const judged = (key: string) => RANGES[key] as Judged;
  const rungs = (key: string, age = 40) => rungsOf(judged(key), bandFor(judged(key), "male", age)!);
  /** Each rung as "grade low–high" with ( ) for an open end, by source. */
  const shape = (rs: Rung[]) => rs.map((r) => `${r.grade} ${r.lowOpen ? "(" : "["}${r.low ?? "-"},${r.high ?? "-"}${r.highOpen ? ")" : "]"} ${r.source}`);
  const gradeOf = (key: string, value: number, age = 40) => rungFor(value, rungs(key, age))!.grade;

  it("takes the line from the primary source, and its grades from the primary where it publishes them", () => {
    expect(shape(rungs("vitamin-d"))).toEqual([
      "in [50,125] nowson-vitd",
      "out (125,-] iom-vitd",
      "mild [30,50) nowson-vitd",
      "out [12.5,30) nowson-vitd",
      "far [-,12.5) nowson-vitd",
    ]);
    expect(gradeOf("bp-systolic", 129)).toBe("in");
    expect(gradeOf("bp-systolic", 130)).toBe("mild");
    expect(gradeOf("bp-systolic", 140)).toBe("out");
    expect(gradeOf("bp-systolic", 185)).toBe("far");
  });

  it("adds a second named source's grades past the primary's line, never moving it: LDL by the AACB, graded by NCEP", () => {
    expect(shape(rungs("ldl"))).toEqual(["in [-,3] aacb-lipids", "mild (3,4.14) ncep-atp3", "out [4.14,4.91) ncep-atp3", "far [4.91,-] ncep-atp3"]);
    expect(gradeOf("ldl", 3.0)).toBe("in");
    expect(gradeOf("ldl", 3.4)).toBe("mild");
    expect(gradeOf("ldl", 4.2)).toBe("out");
    expect(gradeOf("ldl", 5.2)).toBe("far");
  });

  it("anchors CTCAE's grades on the line, as its limit of normal", () => {
    // ALT for men: 40 is the line; grade 2 from over 3 × it, grades 3 and 4 from over 5 × it.
    expect(shape(rungs("alt")).slice(0, 4)).toEqual(["in [5,40] rcpa", "mild (40,120] ctcae-v5", "out (120,200] ctcae-v5", "far (200,-] ctcae-v5"]);
    // Potassium's grade 2 is told by symptoms, so below it goes from mildly straight to far out.
    expect(shape(rungs("potassium")).filter((r) => r.includes("ctcae"))).toEqual([
      "mild (5.2,5.5] ctcae-v5",
      "out (5.5,6] ctcae-v5",
      "far (6,-] ctcae-v5",
      "mild [3,3.5) ctcae-v5",
      "far [-,3) ctcae-v5",
    ]);
    // A lymphocyte count over the line is CTCAE's grade 2 at once.
    expect(gradeOf("lymphocytes", 4.1)).toBe("out");
  });

  it("judges no grade no authority backs: past a line no source grades is out, by the line's source, with no mildly out", () => {
    expect(judged("transferrin").above).toBeUndefined();
    expect(gradingFor(judged("transferrin"), "above")).toBeNull();
    expect(shape(rungs("transferrin"))).toEqual(["in [2,3.2] spl-2024", "out (3.2,-] spl-2024", "out [-,2) spl-2024"]);
    expect(gradeOf("transferrin", 3.21)).toBe("out");
    expect(gradeOf("transferrin", 9)).toBe("out");
    // A one-sided cut-off with no grades: one red band past it, nothing yellow, nothing on the side it does not bound.
    expect(shape(rungs("crp"))).toEqual(["in [-,5) spl-2024", "out [5,-] spl-2024"]);
    for (const [key, authority] of Object.entries(RANGES)) {
      if ("none" in authority) continue;
      for (const band of authority.bands) {
        for (const side of ["above", "below"] as const) {
          if (authority[side]) continue;
          expect(rungsOf(authority, band).filter((r) => r.side === side).map((r) => r.grade), `${key} ${side}`).toEqual((side === "above" ? band.high : band.low) === undefined ? [] : ["out"]);
        }
      }
    }
  });

  it("keeps the dashboard's own rule, off: 10% and 25% of the width past the line, by PERCENT", () => {
    expect(PERCENT_RULE).toBe(false);
    expect(gradingFor(judged("transferrin"), "above", true)).toBe(PERCENT);
    const rungs = (key: string) => rungsOf(judged(key), bandFor(judged(key), "male", 40)!, true);
    expect(shape(rungs("transferrin"))).toEqual([
      "in [2,3.2] spl-2024",
      "mild (3.2,3.32] percent",
      "out (3.32,3.5] percent",
      "far (3.5,-] percent",
      "mild [1.88,2) percent",
      "out [1.7,1.88) percent",
      "far [-,1.7) percent",
    ]);
    // With one limit, the share is of the limit itself.
    expect(shape(rungs("crp")).slice(1)).toEqual(["mild [5,5.5] percent", "out (5.5,6.25] percent", "far (6.25,-] percent"]);
  });

  it("never moves the line: a grade starting inside the range starts at the line, and the grade it empties is dropped", () => {
    const authority: Judged = { source: "rcpa", bands: [{ low: 3.5, high: 5.6 }], above: RANGES.potassium && (RANGES.potassium as Judged).above };
    expect(shape(rungsOf(authority, authority.bands[0]))).toEqual([
      "in [3.5,5.6] rcpa",
      "out (5.6,6] ctcae-v5",
      "far (6,-] ctcae-v5",
      "out [-,3.5) rcpa",
    ]);
    for (const [key, authority] of Object.entries(RANGES)) {
      if ("none" in authority) continue;
      for (const band of authority.bands) {
        const own = rungsOf(authority, band);
        expect(own[0], key).toMatchObject({ grade: "in", low: band.low ?? null, high: band.high ?? null });
        const above = own.filter((r) => r.side === "above");
        const below = own.filter((r) => r.side === "below");
        if (above.length) expect(above[0].low, key).toBe(band.high);
        if (below.length) expect(below[0].high, key).toBe(band.low);
      }
    }
  });

  it("grades a result by the rung it falls in, and names that rung's source", () => {
    const reading = (test: string, value: number): Reading => ({
      test, date: "2026-02-18", value, qualifier: null, text: null, unit: "mmol/L", printed: test, labRange: null, lab: "Sample Pathology", sources: ["x"], alsoAs: [], note: null,
    });
    expect(judge(reading("ldl", 3.4), testOf("ldl"), RANGES.ldl, MADE_UP_PERSON)).toMatchObject({ status: "mild", by: "ncep-atp3" });
    expect(judge(reading("ldl", 2.9), testOf("ldl"), RANGES.ldl, MADE_UP_PERSON)).toMatchObject({ status: "edge", by: "aacb-lipids" });
    expect(judge(reading("transferrin", 3.6), testOf("transferrin"), RANGES.transferrin, MADE_UP_PERSON)).toMatchObject({ status: "out", by: "spl-2024" });
  });

  describe("where each chart ends", () => {
    const spans = (key: string) => bandSpans(judged(key), "male", "1975-06-15", "2019-01-01", "2026-10-16");
    const at = (...values: number[]) => values.map((value, i) => ({ date: `2020-0${i + 1}-01`, value }));
    const scale = (key: string, ...values: number[]) => scaleOf(spans(key), at(...values));

    it("ends at each limit when every result is in range: nothing out is drawn", () => {
      expect(scale("sodium", 139, 141, 140)).toEqual([135, 145]);
      // A side the range does not bound: as far as its results go, the farthest mid-way (limb lean mass, 7.0 or more).
      expect(scale("almi", 8.9)).toEqual([7, 10.8]);
      expect(scale("ldl", 2.0, 2.4)).toEqual([1, 3]);
      // Never below 0 for a quantity whose range is above 0.
      expect(scale("ldl", 1.0)).toEqual([0, 3]);
      // A result on the limit is not past it.
      expect(scale("vitamin-d", 50, 125)).toEqual([50, 125]);
    });

    it("draws out to the end of the yellow band a result falls in, and no further", () => {
      // LDL 4.1: mildly out, 3.0 to 4.14; nothing red; the open green below as tall, so 3.0 sits mid-chart.
      expect(scale("ldl", 4.1)).toEqual([1.86, 4.14]);
      expect(scale("ldl", 2.0, 4.1)).toEqual([1, 4.14]);
      expect(scale("vitamin-d", 48)).toEqual([30, 125]);
      expect(scale("potassium", 5.3)).toEqual([3.5, 5.5]);
    });

    it("draws out to a red band's end, or, with no end, so the farthest result sits mid-way through it", () => {
      expect(scale("potassium", 5.7)).toEqual([3.5, 6]);
      // Open red: transferrin's out from 3.2, a result 3.6, the edge 4.0.
      expect(openEdge(3.2, [3.6], "above")).toBe(4);
      expect(scale("transferrin", 3.6)).toEqual([2, 4]);
      // Past every grade: LDL's far out from 4.91, a result 5.2, the edge 5.49; the green below as tall as the out above.
      expect(scale("ldl", 5.2)).toEqual([0.51, 5.49]);
      expect(scale("vitamin-d", 10, 130)).toEqual([7.5, 135]);
      // Glucose's new lower limit, graded by CTCAE: grade 2 ends at 2.2.
      expect(scale("glucose-fasting", 5.9)).toEqual([3, 6.1]);
      expect(scale("glucose-fasting", 2.5)).toEqual([2.2, 6.1]);
    });

    it("always draws the green: an open side no result reaches as tall as the out side, a closed one to its other limit", () => {
      // LDL 3.4, past 3.0 or under: yellow 3.0 to its bound 4.14, green 1.86 to 3.0.
      expect(scale("ldl", 3.4)).toEqual([1.86, 4.14]);
      // Never below 0: LDL 7.5 draws so far out that the green would reach below 0.
      expect(scale("ldl", 7.5)![0]).toBe(0);
      // A result in the green sizes it as before.
      expect(scale("ldl", 2.0, 3.4)).toEqual([1, 4.14]);
      // Two-sided, the result out above: green runs to the lower limit.
      expect(scale("transferrin", 3.6)).toEqual([2, 4]);
      expect(scale("potassium", 3.2)![1]).toBe(5.2);
    });

    it("takes the widest over the bands, each judged by its own results, and is null with none", () => {
      // Urea for a man turning 50 in 2025: 3.5–8.0, then 4.0–9.0; a result only in the second band.
      expect(scaleOf(spans("urea"), [{ date: "2026-02-18", value: 8.4 }])).toEqual([3.5, 9]);
      expect(scaleOf(spans("urea"), [{ date: "2020-02-18", value: 8.4 }])).toEqual([3.5, 9]);
      expect(scaleOf(spans("urea"), [{ date: "2020-02-18", value: 9.5 }])).toEqual([3.5, 11]);
      expect(scaleOf([], at(1))).toBeNull();
      // A lone result on a one-sided limit leaves room around it.
      expect(scale("crp", 5)).toEqual([4.5, 5.5]);
    });
  });

  it("takes a side's line from another source where the primary sets none that way, with that source's grades or none", () => {
    expect(lineSource(judged("vitamin-d"), "above")).toBe("iom-vitd");
    expect(lineSource(judged("vitamin-d"), "below")).toBe("nowson-vitd");
    expect(lineSource(judged("ldl"), "above")).toBe("aacb-lipids");
    expect(shape(rungs("hdl"))).toEqual(["in [1,2.3] aacb-lipids", "out (2.3,-] esc-eas-2019", "out [-,1) aacb-lipids"]);
    expect(shape(rungs("glucose-fasting"))).toEqual([
      "in [3,6.1) who-glucose",
      "mild [6.1,7) who-glucose",
      "out [7,-] who-glucose",
      "out [2.2,3) ctcae-v5",
      "far [-,2.2) ctcae-v5",
    ]);
    const reading = (test: string, value: number): Reading => ({
      test, date: "2026-02-18", value, qualifier: null, text: null, unit: null, printed: test, labRange: null, lab: "Sample Pathology", sources: ["x"], alsoAs: [], note: null,
    });
    const judgedAs = (test: string, value: number) => judge(reading(test, value), testOf(test), RANGES[test], MADE_UP_PERSON);
    expect(judgedAs("vitamin-d", 130)).toMatchObject({ status: "out", by: "iom-vitd" });
    expect(judgedAs("vitamin-d", 122)).toMatchObject({ status: "edge", by: "iom-vitd" });
    expect(judgedAs("vitamin-d", 52)).toMatchObject({ status: "edge", by: "nowson-vitd" });
    expect(judgedAs("vitamin-d", 90)).toMatchObject({ status: "in", by: "nowson-vitd" });
    expect(judgedAs("hdl", 2.4)).toMatchObject({ status: "out", by: "esc-eas-2019" });
    expect(judgedAs("hdl", 2.3)).toMatchObject({ status: "edge", by: "esc-eas-2019" });
    expect(judgedAs("glucose-fasting", 2.9)).toMatchObject({ status: "out", by: "ctcae-v5" });
    expect(judgedAs("glucose-fasting", 2.0)).toMatchObject({ status: "far", by: "ctcae-v5" });
    expect(judgedAs("glucose-fasting", 3.0)).toMatchObject({ status: "edge", by: "endo-hypo" });
    expect(judgedAs("glucose-fasting", 6.1)).toMatchObject({ status: "mild", by: "who-glucose" });
  });

  it("says the HDL ceiling is second-hand, and links the guideline and both sources that quote it", () => {
    for (const key of ["iom-vitd", "endo-hypo", "esc-eas-2019"] as const) expect(SOURCES[key]).toMatchObject({ stars: 2, url: expect.stringMatching(/^https:/) });
    expect(SOURCES["esc-eas-2019"].citation).toMatch(/could not be opened/);
    expect(SOURCES["esc-eas-2019"].citation).toMatch(/Franczyk/);
    expect(SOURCES["esc-eas-2019"].citation).toMatch(/E-Journal of Cardiology Practice/);
    expect(SOURCES["esc-eas-2019"].links).toEqual([expect.objectContaining({ url: expect.stringMatching(/PMC8466913/) })]);
    expect(SOURCE_ACCOUNTS["esc-eas-2019"].publishes).toMatch(/^As quoted, not read/);
    expect(SOURCE_ACCOUNTS["esc-eas-2019"].wordingFrom).toMatch(/not checked against the guideline itself/);
  });

  it("rates every source by the one rubric, with a reason", () => {
    for (const [key, source] of Object.entries(SOURCES)) {
      expect([0, 1, 2, 3], key).toContain(source.stars);
      expect(source.starsWhy.length, key).toBeGreaterThan(20);
    }
    expect(SOURCES.percent.stars).toBe(0);
    expect(SOURCES["ctcae-v5"].stars).toBe(2);
    expect(SOURCES["spl-2024"].stars).toBe(1);
    expect(Object.keys(STARS)).toEqual(["0", "1", "2", "3"]);
    expect(PERCENT.source).toBe("percent");
  });
});

/** The highest heart rate the Exercise service gives: the made-up by-hand run's, as the Fitness page works it out (the core's exercise tests). */
const MADE_UP_PEAK: Peak = { bpm: 181, date: "2026-05-20", sensor: "Polar H10", recorder: null, source: "Polar Flow's share page, by hand", activity: "hand-202605200715" };

describe("the page's answer", () => {
  const imported: Imported = { version: 1, importedAt: "2026-03-02T00:00:00.000Z", files: [{ path: "platform-exports/everlab/x/Scan.pdf", read: "unread" }], readings: madeUpReadings() };
  let answer: HealthAnswer;
  beforeAll(() => {
    answer = healthAnswer({ byHand: madeUpByHand(), imported, labs: MADE_UP_LABS, today: "2026-10-16", peak: MADE_UP_PEAK, exercise: true });
  });
  const test = (key: string) => answer.tests.find((t) => t.key === key)!;

  it("orders the tests far out first, then out, mildly out, at the edge, in range, under treatment and not judged", () => {
    const order = answer.tests.map((t) => STATUS_ORDER.indexOf(t.status));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(answer.tests.slice(0, 3).map((t) => [t.key, t.status])).toEqual([["chol-hdl", "out"], ["non-hdl", "out"], ["transferrin", "out"]]);
    expect(answer.tests.at(-1)!.status).toBe("unjudged");
  });

  it("orders within a status by how far inside or outside the interval, then by name", () => {
    for (let i = 1; i < answer.tests.length; i++) {
      const [a, b] = [answer.tests[i - 1], answer.tests[i]];
      if (a.status !== b.status) continue;
      expect((a.margin ?? Infinity) <= (b.margin ?? Infinity), `${a.key} before ${b.key}`).toBe(true);
    }
  });

  it("judges each test by its latest result, and sets an answered result under treatment, never at the top", () => {
    expect(test("cholesterol")).toMatchObject({ status: "mild", kind: "number" });
    expect(test("cholesterol").points.map((p) => p.status)).toEqual(["in", "mild", "mild"]);
    expect(test("ige-cat")).toMatchObject({ status: "treated", treatment: "Sample treatment, since Aug 2025", margin: null });
    expect(test("ige-alternaria")).toMatchObject({ status: "in", treatment: null });
    expect(test("urea").bands).toHaveLength(2);
  });

  it("sends each test's bands as the table holds them, and each source's account, for the information modal", () => {
    expect(test("urea").authority).toMatchObject({ source: "aacb-urea", specifics: null });
    expect(test("urea").authority!.bands).toHaveLength(6);
    expect(test("urea").authority!.bands[1]).toEqual({ sex: "male", ages: [50, 70], low: 4.0, high: 9.0, lowOpen: false, highOpen: false });
    expect(test("hdl").authority).toMatchObject({ specifics: expect.stringMatching(/not read/) });
    expect(test("hdl").authority!.lines).toEqual([{ side: "above", source: "esc-eas-2019" }, { side: "below", source: "aacb-lipids" }]);
    expect(test("ldl").authority!.lines).toEqual([{ side: "above", source: "aacb-lipids" }]);
    expect(answer.sources.find((s) => s.key === "esc-eas-2019")!.links).toHaveLength(1);
    expect(answer.sources.find((s) => s.key === "iom-vitd")!.links).toHaveLength(1);
    expect(answer.sources.find((s) => s.key === "rcpa")!.links).toEqual([]);
    const lipids = answer.sources.find((s) => s.key === "aacb-lipids")!;
    expect(lipids).toMatchObject({ kind: "decision-limit", url: SOURCES["aacb-lipids"].url });
    expect(lipids.publishes).toMatch(/neither population reference intervals nor clinical action limits/);
  });

  it("reads screens by their words, and says why a test with no authority is not judged", () => {
    expect(test("hbsag")).toMatchObject({ status: "in", kind: "words", bands: [] });
    expect(test("hbsag").screen).toEqual({ shown: "Clear", line: "Lab screen: negative is the expected result" });
    expect(test("hbsab")).toMatchObject({ status: "in", screen: { shown: "Immune" } });
    expect(test("hbsab").screen!.line).toMatch(/detected means immune/);
    expect(test("albumin").screen).toBeNull();
    expect(test("albumin")).toMatchObject({ status: "unjudged", authority: null });
    expect(test("albumin").noAuthority).toMatch(/AACB/);
    expect(test("haemolysis-index").status).toBe("unjudged");
  });

  it("names only the sources it uses, and the unread files", () => {
    expect(answer.sources.map((s) => s.key)).toContain("rcpa");
    expect(answer.sources.map((s) => s.key)).toContain("spl-2024");
    expect(answer.sources.map((s) => s.key)).not.toContain("sample-lab-2019");
    expect(answer.unread).toEqual(["platform-exports/everlab/x/Scan.pdf"]);
    expect(answer.span).toEqual({ from: "2019-01-01", to: "2026-10-16" });
  });

  it("gives the physical assessment by where each number came from, blood pressure judged", () => {
    const physical = answer.physical!;
    expect(physical.groups.map((g) => g.from)).toEqual(["measured", "everlab-test", "wearable", "everlab-score"]);
    expect(physical.groups[0].numbers[0]).toMatchObject({ label: "Blood pressure, systolic", value: 128, status: "edge", everlab: "Optimal" });
    expect(physical.zones.map((z) => z.zone)).toEqual([2, 3, 4, 5]);
    expect(physical.missing).toContain("Balance");
  });

  it("takes the highest heart rate from trusted recordings alone, never a watch's, naming the Fitness page's activity", () => {
    expect(answer.peak).toEqual({ bpm: 181, date: "2026-05-20", age: 50, sensor: "Polar H10", recorder: null, source: "Polar Flow's share page, by hand", activity: "hand-202605200715" });
    // The workouts themselves are the Fitness page's.
    expect(answer).not.toHaveProperty("runs");
  });

  it("gives the records that are no lab result, newest first, marking those read only from a transcription", () => {
    const { immunisations, medicines, services, pbs, transcriptions } = answer.records;
    expect(immunisations.map((r) => [r.date, r.transcribed])).toEqual([["2026-02-09", false], ["2025-04-22", false], ["2019-11-04", false], ["2017-03-15", false], ["2016-08-01", false]]);
    expect(immunisations[3].diseases).toEqual([
      { name: "Diphtheria", everyday: null }, { name: "Tetanus", everyday: null }, { name: "Pertussis", everyday: "whooping cough" },
    ]);
    expect(answer.records.protection.map((r) => [r.disease.name, r.latest.date])).toEqual([
      ["Influenza", "2025-04-22"], ["Hepatitis A", "2026-02-09"], ["Diphtheria", "2017-03-15"], ["Pertussis", "2017-03-15"], ["Tetanus", "2019-11-04"],
      ["Yellow fever", "2016-08-01"],
    ]);
    expect(medicines.map((r) => r.record)).toEqual(["dispensed", "prescribed"]);
    expect(services.map((r) => [r.item, r.transcribed])).toEqual([["90001", false], ["90002", true]]);
    expect(services[0].fee).toEqual({ charged: 80, benefit: 43.9, gap: 36.1, paid: "EFT to Claimant" });
    expect(services[1]).toMatchObject({ fee: null, provider: "DR BRUNO PLACEHOLDER" });
    expect(pbs[0]).toMatchObject({ code: "99901X", transcribed: true });
    expect(transcriptions.map((t) => t.file)).toEqual([MADE_UP_MHR_FILES.overview]);
    expect(recordsOf({ ...madeUpByHand(), immunisations: undefined, medicines: undefined, medicare: undefined, transcriptions: undefined }, "2026-10-20")).toEqual({
      immunisations: [], protection: [], medicines: [], services: [], pbs: [], transcriptions: [],
    });
  });

  it("refuses a record without its files or with a date out of shape, and a medicine neither prescribed nor dispensed", () => {
    const noSources = madeUpByHand();
    noSources.immunisations![0].sources = [];
    expect(byHandProblem(noSources)).toMatch(/immunisation Samplevax: name the files/);
    const badDay = madeUpByHand();
    badDay.medicare!.pbs[0].supplied = "9 Feb 2021";
    expect(byHandProblem(badDay)).toMatch(/PBS item 99901X: its dates/);
    const badRecord = madeUpByHand();
    (badRecord.medicines![0] as { record: string }).record = "ordered";
    expect(byHandProblem(badRecord)).toMatch(/prescribed or dispensed/);
  });

  it("refuses a by-hand file without its person, or with a reading of neither value nor text", () => {
    const file = madeUpByHand();
    expect(byHandProblem(file)).toBeNull();
    expect(byHandProblem({ ...file, person: { ...file.person, born: "June 1975" } })).toMatch(/born/);
    const bad = madeUpByHand();
    bad.documents[0].readings.push({ test: "sodium", printed: "Sodium" });
    expect(byHandProblem(bad)).toMatch(/value or a text/);
    expect(byHandReadings(file)[0]).toMatchObject({ lab: "Sample Lab", sources: [`${file.documents[0].file} p1`] });
  });
});

describe.skipIf(!hasPdfReader)("the route", () => {
  let dataDir: string;
  let emptyDir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "health-route-"));
    emptyDir = await mkdtemp(join(tmpdir(), "health-empty-"));
    await writeMadeUpHealth(dataDir);
    const empty = createHealthApi(emptyDir);
    const health = createHealthApi(dataDir, { now: () => Date.parse("2026-10-16T01:00:00Z"), peak: MADE_UP_PEAK });
    const noExercise = createHealthApi(dataDir, { exercise: false });
    // The module's handler alone, as the core's door hands it every request under the module's address.
    server = createServer((req, res) => void (req.headers["x-empty"] ? empty : req.headers["x-no-exercise"] ? noExercise : health)(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(emptyDir, { recursive: true, force: true });
  });

  function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // Answered in words.
          }
          resolve({ status: res.statusCode!, body });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("answers at the module's address, /life-archive/api/m/health, with the results judged and the Exercise service's peak", async () => {
    expect(HEALTH_API).toBe("/life-archive/api/m/health");
    const { status, body } = await get(HEALTH_API);
    expect(status).toBe(200);
    const answer = body as HealthAnswer;
    expect(answer.born).toBe(MADE_UP_PERSON.born);
    expect(answer.today).toBe("2026-10-16");
    expect(answer.tests[0].key).toBe("chol-hdl");
    expect(answer.unread).toEqual([]);
    expect(answer.peak).toEqual({ ...MADE_UP_PEAK, age: 50 });
    expect(answer.exercise).toBe(true);
  }, 60_000);

  it("says there is no Fitness page to link when the exercise module is off, and gives no peak", async () => {
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_API}`, { headers: { "x-no-exercise": "1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exercise: false, peak: null });
  }, 60_000);

  it("answers nothing under its address, and refuses another site's page and a write", async () => {
    expect((await get(`${HEALTH_API}/more`)).status).toBe(404);
    expect((await get(HEALTH_API, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(HEALTH_API, {}, "POST")).status).toBe(405);
  });

  it("says so when the archive keeps no health results", async () => {
    const { status, body } = await get(HEALTH_API, { "x-empty": "1" });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/no health results/);
  });
});

describe("the runs offered to the Fitness page", () => {
  it("are by-hand.json's, none without one, and an error naming the file alone while it cannot be read", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "life-archive-health-runs-"));
    try {
      expect(await Effect.runPromise(runsByHand(dataDir))).toEqual([]);
      await mkdir(healthDir(dataDir), { recursive: true });
      await writeFile(join(healthDir(dataDir), BY_HAND_FILE), JSON.stringify(madeUpByHand()));
      expect(await Effect.runPromise(runsByHand(dataDir))).toEqual(madeUpByHand().runs);
      await writeFile(join(healthDir(dataDir), BY_HAND_FILE), `{"runs": "not made whole`);
      await expect(Effect.runPromise(runsByHand(dataDir))).rejects.toThrow(/^modules\/health\/by-hand\.json cannot be read$/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
