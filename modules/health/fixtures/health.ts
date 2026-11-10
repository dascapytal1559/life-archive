// Made-up health results for the tests and the testing data (npm run testing-data): a made-up man born in 1975, so
// his urea band changes at 50 inside the charts, with Everlab-style Pathology Results Reports in three years
// (madeUpReports, laid out as Everlab lays them out, and written as real PDFs by pdfFile.ts), a QML Pathology report
// in a My Health Record export (madeUpQmlReport, laid out as QML lays its own out), a by-hand file with a transcribed
// panel, a body scan, a physical assessment and runs (one from a watch, untrusted), the made-up labs' printed intervals
// for the tests no guideline covers (MADE_UP_LABS), an allergy result under treatment,
// and the records that are no lab result (immunisations, medicines, Medicare's services and PBS items, some read only
// from a transcription). Every value, medicine, item and provider is invented; none is anyone's.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pdfFile } from "./pdfFile.ts";
import { importHealth, EVERLAB_EXPORTS, MY_HEALTH_RECORD_EXPORTS } from "../server/import.ts";
import type { PdfLine } from "../server/pdf.ts";
import type { LabInterval, LabIntervalsFile } from "../server/labIntervals.ts";
import { BY_HAND_FILE, healthDir, LAB_INTERVALS_FILE, writeImported, type ByHand } from "../server/store.ts";
import { CROWD_SELF } from "../../../sdk/server.ts";

export const MADE_UP_PERSON: ByHand["person"] = { born: "1975-06-15", sex: "male" };

/**
 * The made-up labs' printed intervals for the tests no guideline covers (health/lab-intervals.json): most from one lab,
 * three from another that was the last to run them, so a lab no result uses is left off the page.
 */
export const MADE_UP_LABS: LabInterval[] = [
  {
    key: "spl-2024",
    lab: "Sample Pathology",
    year: 2024,
    reports: "its reports of July 2024",
    sex: "male",
    tests: {
      haemoglobin: { low: 130, high: 180 }, haematocrit: { low: 0.39, high: 0.51 }, "red-cells": { low: 4.3, high: 5.8 }, mcv: { low: 80, high: 100 },
      mch: { low: 27, high: 34 }, mchc: { low: 310, high: 360 }, rdw: { low: 11, high: 17 }, platelets: { low: 150, high: 450 },
      "white-cells": { low: 4.0, high: 11.0 }, neutrophils: { low: 2.0, high: 7.5 }, lymphocytes: { low: 1.0, high: 4.0 }, monocytes: { high: 1.0 },
      eosinophils: { high: 0.5 }, basophils: { high: 0.3 }, iron: { low: 5, high: 30 }, transferrin: { low: 2.0, high: 3.2 },
      "transferrin-saturation": { low: 10, high: 45 }, ferritin: { low: 30, high: 500 }, "active-b12": { low: 37, high: 188 },
      folate: { low: 6.0, lowOpen: true }, zinc: { low: 9.0, high: 19.0 }, urate: { low: 0.2, high: 0.5 }, homocysteine: { low: 4, high: 15 },
      crp: { high: 5, highOpen: true }, apob: { low: 0.49, high: 1.73 }, "insulin-fasting": { high: 17, highOpen: true },
      testosterone: { low: 12.0, high: 31.9 }, "free-testosterone": { low: 260, high: 740 }, shbg: { low: 17, high: 56 }, tsh: { low: 0.5, high: 5.5 },
      psa: { low: 0.2, high: 2.1 }, mercury: { high: 60, highOpen: true },
    },
  },
  {
    key: "sample-lab-2019",
    lab: "Sample Lab",
    year: 2019,
    reports: "its report of May 2019",
    last: true,
    sex: "male",
    tests: { tibc: { low: 45, high: 70 }, esr: { low: 1, high: 12 }, b12: { low: 150, lowOpen: true } },
  },
];

/** The made-up export's folder, from the archive's folder. */
export const MADE_UP_EXPORT = join(EVERLAB_EXPORTS, "2026-03-01");

/** A panel of a made-up report: its title and rows, numbers (name, result, unit, range) or words (name, value). */
export interface MadeUpPanel {
  title: string;
  kind: "numbers" | "words";
  rows: string[][];
}

const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function printedDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${LONG_MONTHS[m - 1]} ${y}`;
}

/** A Pathology Results Report's pages as lines of cells, laid out as Everlab lays them. */
export function madeUpReport(collected: string, panels: MadeUpPanel[], provider = "SPL / Sample Pathology"): PdfLine[][] {
  const day = printedDay(collected);
  const lines: PdfLine[] = [
    [["Pathology Results Report", 52]],
    [["Generated 1 March 2026 | 1 panel | 4 biomarkers", 61]],
    [["Patient", 76], [CROWD_SELF, 165], ["Date of Birth", 298], [printedDay(MADE_UP_PERSON.born), 386]],
    [["Practitioner", 76], ["Ada Sample", 165], ["Provider", 298], [provider, 386]],
    [["Collected", 76], [day, 165], ["Reported", 298], [day, 386]],
    [["Reference ranges shown are provided by the testing laboratory.", 62]],
  ];
  for (const panel of panels) {
    lines.push([[panel.title, 62], [`Collected ${day}`, 402]]);
    if (panel.kind === "numbers") {
      lines.push([["BIOMARKER", 62], ["RESULT", 275], ["UNITS", 368], ["REFERENCE RANGE", 429]]);
      for (const [name, result, unit, range] of panel.rows) {
        const cells: PdfLine = [[name, 62], [result, 310]];
        if (unit) cells.push([unit, 385]);
        if (range) cells.push([range, 480]);
        lines.push(cells);
      }
    } else {
      lines.push([["ITEM", 62], ["VALUE", 371]]);
      for (const [name, value] of panel.rows) lines.push([[name, 62], [value, 470]]);
    }
  }
  lines.push([["Confidential — For clinical use only", 52], ["Generated by Everlab", 252], ["Page 1 of 1", 488]]);
  return [lines];
}

/** The made-up export: each report's file (from the archive's folder) and pages. */
export function madeUpReports(): Array<{ file: string; pages: PdfLine[][] }> {
  const at = (folder: string, name: string) => join(MADE_UP_EXPORT, folder, name);
  const chemistry = (rows: string[][]): MadeUpPanel => ({ title: "SE- CHEMISTRY", kind: "numbers", rows });
  const count = (rows: string[][]): MadeUpPanel => ({ title: "ED-HAEMATOLOGY", kind: "numbers", rows });
  return [
    {
      file: at("2019-04-02_Sample_Pathology", "SE-_CHEMISTRY.pdf"),
      pages: madeUpReport("2019-04-02", [
        chemistry([
          ["Sodium", "139", "mmol/L", "135-145"], ["Potassium", "4.4", "mmol/L", "3.5-5.5"], ["Urea", "6.1", "mmol/L", "3.0-8.0"],
          ["Creatinine", "92", "umol/L", "60-110"], ["eGFR", ">90", "", ">59"], ["Cholesterol", "5.1", "mmol/L", "3.9-5.5"],
          ["ALT", "31", "U/L", "5-40"], ["Albumin", "44", "g/L", "35-48"], ["Haemolysis Index", "8", "mg/dL", "0-40"],
        ]),
      ]),
    },
    {
      file: at("2019-04-02_Sample_Pathology", ".BLOOD_COUNT.pdf"),
      pages: madeUpReport("2019-04-02", [count([["Haemoglobin", "151", "g/L", "135-175"], ["Platelets", "240", "10*9/L", "150-400"]])]),
    },
    {
      file: at("2022-08-10_Sample_Pathology", "SE-_CHEMISTRY.pdf"),
      pages: madeUpReport("2022-08-10", [
        chemistry([
          ["S Sodium:", "141", "mmol/L", "135-145"], ["S Potassium:", "4.0", "mmol/L", "3.5-5.5"], ["S Urea:", "7.2", "mmol/L", "3.0-8.0"],
          ["S Creatinine:", "98", "umol/L", "60-110"], ["eGFR", "84", "", ">59"], ["S Cholesterol:", "5.6", "mmol/L", "3.5-5.5"],
          ["S ALT:", "38", "U/L", "5-40"], ["S Albumin:", "43", "g/L", "36-47"],
        ]),
        count([["HAEMOGLOBIN", "148", "g/L", "130-180"], ["PLATELETS", "228", "x 10*9/L", "150-450"]]),
      ]),
    },
    {
      file: at("2026-02-18_Sample_Pathology", "SE-_CHEMISTRY.pdf"),
      pages: madeUpReport("2026-02-18", [
        chemistry([
          ["S Sodium:", "140", "mmol/L", "135-145"], ["S Potassium:", "5.2", "mmol/L", "3.5-5.5"], ["S Urea:", "8.4", "mmol/L", "3.0-8.0"],
          ["S Creatinine:", "104", "umol/L", "60-110"], ["eGFR", "72", "", ">59"], ["S ALT:", "44", "U/L", "5-40"], ["S Albumin:", "42", "g/L", "36-47"],
        ]),
        count([["HAEMOGLOBIN", "146", "g/L", "130-180"], ["PLATELETS", "210", "x 10*9/L", "150-450"]]),
      ]),
    },
    {
      file: at("2026-02-18_Sample_Pathology", "SE-LIPID_-_HDLLDL.pdf"),
      pages: madeUpReport("2026-02-18", [
        {
          title: "SE-LIPID - HDL/LDL",
          kind: "numbers",
          rows: [
            ["S Cholesterol:", "6.2", "mmol/L", "3.5-5.5"], ["S Triglycerides:", "1.4", "mmol/L", "<1.7"], ["S HDL-Cholesterol:", "1.05", "mmol/L", ">1.00"],
            ["S LDL-Cholesterol:", "4.1", "mmol/L", "<3.5"], ["Chol/HDLC", "5.9", "", "<4.5"], ["Non HDL Cholesterol", "5.15", "mmol/L", "<3.9"],
          ],
        },
      ]),
    },
    {
      file: at("2026-02-18_Sample_Pathology", "ED-_DIABETES_DIAGNOSIS.pdf"),
      pages: madeUpReport("2026-02-18", [
        { title: "ED- DIABETES DIAGNOSIS", kind: "numbers", rows: [["B Glycosylated Haemoglobin (Hb A1c):", "5.8", "%", "4.4-5.6"], ["HBA1c (IFCC)", "40", "mmol/mol", "25-38"]] },
      ]),
    },
    {
      file: at("2026-02-18_Sample_Pathology", "_LEAD_VIRTUAL.pdf"),
      pages: madeUpReport("2026-02-18", [{ title: "_LEAD VIRTUAL", kind: "numbers", rows: [["Lead-blood", "0.10", "umol/L", "0-0.24"], ["Lead-blood", "2.1", "ug/dL", "0-5"]] }]),
    },
    {
      file: at("2026-02-18_Sample_Pathology", "SE-VITAMIN_D.pdf"),
      pages: madeUpReport("2026-02-18", [
        { title: "SE-VITAMIN D", kind: "numbers", rows: [["25-Hydroxy Vitamin D", "48", "nmol/L", "50-250"]] },
        { title: "SE-IRON STUDIES", kind: "numbers", rows: [["S Ferritin:", "280", "ug/L", "30-500"], ["S Transferrin:", "3.4", "g/L", "2.0-3.2"]] },
      ]),
    },
    {
      file: at("2026-02-18_Sample_Pathology", "SE-MPS_RAST.pdf"),
      pages: madeUpReport("2026-02-18", [
        { title: "SE-MPS RAST", kind: "numbers", rows: [["Cat epithelium", "2.40", "kU/L"], ["Alternaria alternata", "0.00", "kU/L"]] },
        { title: "SE-MPS RAST - OTHER", kind: "words", rows: [["Cat epithelium", "II"], ["Cat epithelium", "Moderate"], ["Alternaria alternata", "0"], ["Alternaria alternata", "Negative"]] },
      ]),
    },
    {
      file: at("2025-11-04_Sample_Pathology", "SE-_HEPATITIS_B_VIRTUAL.pdf"),
      pages: madeUpReport("2025-11-04", [
        { title: "SE- HEPATITIS B VIRTUAL", kind: "numbers", rows: [["HBsAb level", "120", "IU/L"]] },
        { title: "SE- HEPATITIS B VIRTUAL - OTHER", kind: "words", rows: [["Hep B surface Antigen", "Negative"], ["HepB surface antibody", "Detected"]] },
      ]),
    },
    {
      file: at("2023-05-11_Sample_Pathology", "SWAB_MCS_EENT_1.pdf"),
      pages: madeUpReport("2023-05-11", [{ title: "SWAB MCS EENT 1", kind: "words", rows: [["Site", "Throat Swab"], ["Culture", "No pathogens isolated"]] }]),
    },
  ];
}

/** The made-up My Health Record export's folder, from the archive's folder. */
export const MADE_UP_MHR_EXPORT = join(MY_HEALTH_RECORD_EXPORTS, "2026-03-20");

/** A section of a made-up QML report: its title, then rows of cells after the name (result and unit, range; or words). */
export interface MadeUpQmlSection {
  title: string;
  /** A line under the title noting the sample ("Specimen: Urine"), or none. */
  specimen?: string;
  rows: string[][];
}

/** "2024-07-09" as QML prints it, "09/07/24". */
function qmlDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

/** A QML Pathology report's page as lines of cells, laid out as QML lays out its own, as My Health Record attaches it. */
export function madeUpQmlReport(collected: string, sections: MadeUpQmlSection[]): PdfLine[][] {
  const day = qmlDay(collected);
  const lines: PdfLine[] = [
    [["SAMPLE DIAGNOSTICS PTY LTD t/a QML Pathology", 65]],
    [["Pathology Report", 363]],
    [["DR ADA SAMPLE", 111]],
    [["Patient", 33]],
    [[`${CROWD_SELF} Male`, 66]],
    [["Sex", 33], ["Age", 106], ["DOB", 174]],
    [["Requested", 329]],
    [["Collected", 329]],
    [[day, 381]],
    [[`${day} 08:15 AM`, 381]],
    [["Reported", 329]],
    [[`${day} 03:40 PM`, 381]],
    [["00012345", 381]],
  ];
  for (const section of sections) {
    lines.push([[section.title, 60]]);
    if (section.specimen) lines.push([[section.specimen, 76]]);
    // A count's share, its number and unit, then the range, each at its column.
    for (const [name, ...cells] of section.rows) {
      const xs = cells.length === 3 ? [216, 259, 378] : [259, 378];
      lines.push([[name, 81], ...cells.map((cell, i): [string, number] => [cell, xs[i]])]);
    }
    lines.push([["A comment the report prints under the results, on one line.", 81]]);
  }
  lines.push([["Pathology", 547], ["Report", 547]]);
  lines.push([["Page 1 of 1", 36]]);
  lines.push([["Dept", 62], ["Date of Service", 181]]);
  return [lines];
}

/** The made-up My Health Record export's lab reports: QML's own, each file (from the archive's folder) and pages. */
export function madeUpQmlReports(): Array<{ file: string; pages: PdfLine[][] }> {
  return [
    {
      file: join(MADE_UP_MHR_EXPORT, "pathology", "01-chemistry-2024-07-09-attachment.pdf"),
      pages: madeUpQmlReport("2024-07-09", [
        {
          title: "SERUM CHEMISTRY - FASTING",
          rows: [["Sodium", "140 mmol/L", "(137-147)"], ["Glucose", "5.6 mmol/L", "fasting (3.0-6.0)"], ["eGFR", "> 90 mL/min", "(over 59)"]],
        },
        { title: "FULL BLOOD EXAMINATION", rows: [["Neutrophils", "55 %", "3.1 x10 ^9 /L", "(2.0-7.5)"]] },
      ]),
    },
    {
      file: join(MADE_UP_MHR_EXPORT, "pathology", "02-screen-2024-07-09-attachment.pdf"),
      pages: madeUpQmlReport("2024-07-09", [
        { title: "SYPHILIS SEROLOGY", rows: [["Treponemal antibody screen", ": Negative"]] },
        { title: "SCREENING", specimen: "Specimen: Urine", rows: [["CHLAMYDIA TRACHOMATIS (NAT)", "Negative"]] },
      ]),
    },
  ];
}

/** The made-up My Health Record export's other files, from the archive's folder: what by-hand.json reads, transcribes and skips. */
export const MADE_UP_MHR_FILES = {
  immunisations: join(MADE_UP_MHR_EXPORT, "immunisations", "immunisation-history-statement.pdf"),
  medicines: join(MADE_UP_MHR_EXPORT, "medicines", "prescription-and-dispense-records.pdf"),
  claims: join(MADE_UP_MHR_EXPORT, "medicare", "claims-history-statement.pdf"),
  overview: join(MADE_UP_MHR_EXPORT, "medicare", "medicare-overview-transcribed.pdf"),
  view: join(MADE_UP_MHR_EXPORT, "pathology", "01-chemistry-2024-07-09-view.pdf"),
};

/** The files the made-up by-hand file transcribes, from the archive's folder. */
export const MADE_UP_TRANSCRIBED = {
  panel: join(MADE_UP_EXPORT, "2023-05-11_Sample_Lab", "Screening.pdf"),
  scan: join(MADE_UP_EXPORT, "2026-02-20_Sample_Imaging", "DEXA_Body_Composition_Scan.pdf"),
  physical: join(EVERLAB_EXPORTS, "2026-03-05", "2026-02-20_Physical_Assessment.pdf"),
};

export function madeUpByHand(): ByHand {
  const { panel, scan, physical } = MADE_UP_TRANSCRIBED;
  return {
    version: 1,
    person: MADE_UP_PERSON,
    documents: [
      {
        file: panel,
        lab: "Sample Lab",
        date: "2023-05-11",
        readings: [
          { test: "chlamydia", text: "Negative", printed: "CHLAMYDIA TRACHOMATIS (NAT)", note: "Specimen: urine", page: 1 },
          // A made-up positive screen, so the screens' red band shows on the testing data.
          { test: "urine-mycoplasma", text: "Detected", printed: "Org 1", note: "Specimen: urine", page: 1 },
          { test: "glucose-fasting", value: 5.9, unit: "mmol/L", printed: "Glucose", labRange: "3.0-6.0", note: "fasting", page: 2 },
        ],
      },
      {
        file: scan,
        lab: "Sample Imaging",
        date: "2026-02-20",
        readings: [
          { test: "weight", value: 82.4, unit: "kg", printed: "Weight", page: 1 },
          { test: "bmi", value: 26.1, unit: "kg/m²", printed: "Body Mass Index (BMI)", page: 1 },
          { test: "body-fat", value: 24.8, unit: "%", printed: "Total Body % Fat", page: 1 },
          { test: "almi", value: 8.9, unit: "kg/m²", printed: "Appen. Lean/Height² (kg/m²)", page: 1 },
          { test: "bmd-z-spine", value: -0.4, printed: "AP Spine L1-L4", alsoAs: ["T-score -0.6"], page: 4 },
        ],
      },
      {
        file: physical,
        lab: "Everlab, measured at the physical assessment",
        date: "2026-02-20",
        readings: [
          { test: "bp-systolic", value: 128, unit: "mmHg", printed: "Systolic blood pressure", page: 4 },
          { test: "bp-diastolic", value: 82, unit: "mmHg", printed: "Diastolic blood pressure", page: 4 },
        ],
      },
    ],
    physical: {
      file: physical,
      date: "2026-02-20",
      printed: "2026-03-05",
      items: [
        { from: "measured", test: "bp-systolic", everlab: "Optimal", page: 4 },
        { from: "measured", test: "bp-diastolic", everlab: "Optimal", page: 4 },
        { from: "everlab-test", label: "VO₂ max", value: 41.2, unit: "mL/kg/min", everlab: "Optimal", page: 11 },
        { from: "everlab-test", label: "Zone 2 heart rate", value: 118, unit: "bpm", zone: 2, page: 11 },
        { from: "everlab-test", label: "Zone 3 heart rate", value: 131, unit: "bpm", zone: 3, page: 11 },
        { from: "everlab-test", label: "Zone 4 heart rate", value: 150, unit: "bpm", zone: 4, page: 11 },
        { from: "everlab-test", label: "Zone 5 heart rate", value: 158, unit: "bpm", zone: 5, page: 11 },
        { from: "wearable", label: "Resting heart rate", value: 58, unit: "bpm", page: 6 },
        { from: "wearable", label: "Sleep", text: "7 hrs, 50 mins", page: 5 },
        { from: "wearable", label: "Steps", value: 9120, unit: "steps", page: 5 },
        { from: "everlab-score", label: "Biological age", value: 47, unit: "years", page: 3 },
        { from: "everlab-score", label: "Latest readings out of range", value: 6, page: 3 },
        { from: "everlab-score", label: "Latest readings suboptimal", value: 14, page: 3 },
        { from: "everlab-score", label: "Latest readings optimal", value: 88, page: 3 },
      ],
      missing: ["Grip strength", "Push-ups", "Balance"],
      unexplained: "The report names a calculator for each but shows neither the method nor its inputs.",
    },
    runs: [
      {
        start: "2026-05-20T07:15", sport: "Running", device: "Polar H10", trusted: true, duration: "41:02", distanceMi: 4.1, avgHr: 152, maxHr: 181, minHr: 104,
        hrMaxSetting: 181,
        zones: [{ zone: 5, share: 22, time: "9:01", from: 162 }, { zone: 4, share: 48, time: "19:42", from: 145 }, { zone: 3, share: 20, from: 127 }, { zone: 2, share: 7, from: 109 }, { zone: 1, share: 3, from: 91 }],
        source: "https://example.com/shared/run-one",
      },
      {
        start: "2026-06-03T18:40", sport: "Running", device: "Polar H10", trusted: true, duration: "32:45", distanceMi: 3.05, avgHr: 148, maxHr: 172, minHr: 110,
        zones: [{ zone: 5, share: 10 }, { zone: 4, share: 45 }, { zone: 3, share: 30 }, { zone: 2, share: 12 }, { zone: 1, share: 3 }],
        source: "https://example.com/shared/run-two",
      },
      {
        start: "2026-06-05T06:30", sport: "Running", device: "Wrist watch", trusted: false, duration: "25:10", distanceMi: 2.4, avgHr: 160, maxHr: 196, minHr: 95,
        source: "https://example.com/shared/run-watch",
      },
    ],
    treatments: [{ system: "allergy", what: "Sample treatment", since: "2025-08" }],
    immunisations: [
      { date: "2019-11-04", against: "Tetanus", vaccine: "Samplevax", sources: [MADE_UP_MHR_FILES.immunisations] },
      { date: "2025-04-22", against: "Influenza", vaccine: "Examplegrip", sources: [MADE_UP_MHR_FILES.immunisations] },
      { date: "2017-03-15", against: "Diphtheria Tetanus Pertussis", vaccine: "Samplevax Trio", sources: [MADE_UP_MHR_FILES.immunisations] },
      { date: "2026-02-09", against: "Hepatitis A", vaccine: "Examplehep", sources: [MADE_UP_MHR_FILES.immunisations] },
      { date: "2016-08-01", against: "Yellow Fever", vaccine: "Sampleyellow", sources: [MADE_UP_MHR_FILES.immunisations] },
    ],
    medicines: [
      {
        date: "2025-04-22", record: "prescribed", medicine: "EXAMPLOMYCIN", brand: "EXAMPLOMYCIN - CAPSULE 250mg", directions: "1 cap twice daily for 5 days",
        supply: "Supply 10, dispense original and 0 repeats", sources: [MADE_UP_MHR_FILES.medicines],
      },
      {
        date: "2025-04-23", record: "dispensed", medicine: "examplomycin 250mg Cap, 10", brand: "EXAMPLOMYCIN (SPL) 250MG CAP (10) - Capsule 250mg",
        directions: "Take ONE capsule TWICE daily for FIVE days", supply: "Supply 10, original supply", sources: [MADE_UP_MHR_FILES.medicines],
      },
    ],
    medicare: {
      services: [
        {
          date: "2025-04-22", item: "90001", description: "Made-up attendance at consulting rooms, less than 20 mins.", provider: "DR ADA SAMPLE",
          fee: { charged: 80, benefit: 43.9, gap: 36.1, paid: "EFT to Claimant" }, sources: [MADE_UP_MHR_FILES.overview, `${MADE_UP_MHR_FILES.claims} p1`],
        },
        { date: "2021-02-08", item: "90002", description: "Made-up test of a sample.", provider: "DR BRUNO PLACEHOLDER", sources: [MADE_UP_MHR_FILES.overview] },
      ],
      pbs: [
        {
          prescribed: "2021-02-08", supplied: "2021-02-09", medicine: "Samplecillin", brand: "SAMPLECILLIN SPL", form: "SAMPLECILLIN 500MG CAPSULE, 20", quantity: 20,
          repeats: 0, code: "99901X", sources: [MADE_UP_MHR_FILES.overview],
        },
      ],
    },
    transcriptions: [{ file: MADE_UP_MHR_FILES.overview, why: "copied out by hand from a portal that prints five rows a page, so it may hold errors." }],
    skipped: [{ file: MADE_UP_MHR_FILES.view, why: "My Health Record's page for the report beside it, which is read instead." }],
  };
}

/** Writes made-up PDFs (pdfFile.ts): each file (absolute) with its pages. */
export async function writeMadeUpPdfs(docs: ReadonlyArray<{ file: string; pages: PdfLine[][] }>): Promise<void> {
  for (const doc of docs) {
    await mkdir(dirname(doc.file), { recursive: true });
    await writeFile(doc.file, pdfFile(doc.pages));
  }
}

/** The made-up health results in the archive's folder `dataDir`: the export's PDFs, by-hand.json, lab-intervals.json and imported.json. */
export async function writeMadeUpHealth(dataDir: string): Promise<void> {
  const byHand = madeUpByHand();
  const placeholder = (title: string): PdfLine[][] => [[[[title, 62]]]];
  await writeMadeUpPdfs([
    ...[...madeUpReports(), ...madeUpQmlReports()].map((report) => ({ file: join(dataDir, report.file), pages: report.pages })),
    ...Object.values(MADE_UP_MHR_FILES).map((file) => ({ file: join(dataDir, file), pages: placeholder("A made-up My Health Record page, read in by-hand.json") })),
    { file: join(dataDir, MADE_UP_TRANSCRIBED.panel), pages: placeholder("A made-up screening panel, transcribed in by-hand.json") },
    { file: join(dataDir, MADE_UP_TRANSCRIBED.scan), pages: placeholder("A made-up body scan, transcribed in by-hand.json") },
    { file: join(dataDir, MADE_UP_TRANSCRIBED.physical), pages: placeholder("A made-up physical assessment, transcribed in by-hand.json") },
  ]);
  await mkdir(healthDir(dataDir), { recursive: true });
  await writeFile(join(healthDir(dataDir), BY_HAND_FILE), `${JSON.stringify(byHand, null, 2)}\n`);
  const labs: LabIntervalsFile = { version: 1, labs: MADE_UP_LABS };
  await writeFile(join(healthDir(dataDir), LAB_INTERVALS_FILE), `${JSON.stringify(labs, null, 2)}\n`);
  await writeImported(dataDir, await importHealth({ dataDir, byHand }));
}

