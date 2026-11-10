// QML Pathology's own "Pathology Report", as My Health Record attaches it (one PDF per report), read from its lines of
// cells (pdf.ts). Its header names the lab ("... t/a QML Pathology") and the days it was requested, collected and
// reported, the last two with a time ("09/07/24 08:15 AM"), so the earliest of those is the collection's. Its results
// sit under a section's title ("IRON STUDIES"), one row a result, the printed name indented under the title (from 70
// to 120 points across, where no line of the header or the foot starts), then either the result with its unit in one
// cell ("140 mmol/L"; a count's share first, "55 %", as another cell) and the lab's range in brackets, a word before it
// saying how the sample was taken ("fasting (3.1-6.1)"), or the result in words ("Negative", ": Negative"; a culture's
// organism, "Org 1:" and its name). A line "Specimen: Urine", or "Site:" with where, notes the rows after it in
// the report. Every row becomes a Reading of its test (catalogue.ts), the range kept as evidence. Nothing depends on
// the order PDFKit gives the header and the results in, which differs from file to file. A comment, a line of one
// cell, is passed over, so a result laid out as one (two results run together in one line, or "name : result" in a
// single cell) is not read here: a report with none read is listed unread, and one with any is transcribed in
// by-hand.json instead.

import { testPrinted, unknownKey } from "./catalogue.ts";
import type { PdfLine } from "./pdf.ts";
import type { Reading } from "./store.ts";

export const QML_LAB = "QML Pathology";

/** A day and time as the header prints them: "09/07/24 08:15 AM". */
const DAY_TIME = /^(\d{2})\/(\d{2})\/(\d{2}) \d{2}:\d{2} [AP]M$/;

/** Whether pages are a QML Pathology report. */
export function isQmlReport(pages: readonly PdfLine[][]): boolean {
  const first = pages[0] ?? [];
  return first.some((line) => line.some(([text]) => /\bt\/a QML Pathology$/.test(text))) && first.some((line) => lineText(line) === "Pathology Report");
}

/** "09/07/24" (day, month, two-digit year) as 2024-07-09. */
function dayOf(match: RegExpExecArray): string {
  return `20${match[3]}-${match[2]}-${match[1]}`;
}

/** Every result of a QML Pathology report, its file `file` (from the archive's folder). Throws when it is not one. */
export function readQmlReport(pages: readonly PdfLine[][], file: string): Reading[] {
  if (!isQmlReport(pages)) throw new Error(`${file} is not a QML Pathology report`);
  const days = pages.flat().flatMap((line) => line.map(([text]) => DAY_TIME.exec(text.trim())).filter((m) => m !== null).map(dayOf));
  if (days.length === 0) throw new Error(`${file}: no day of collection`);
  const collected = days.sort()[0];
  const rows: Reading[] = [];
  let note: string | null = null;
  pages.forEach((lines, index) => {
    for (const line of lines) {
      const cells = line.map(([text]) => text.trim());
      const specimen = /^Specimen:\s*(.+)$/.exec(cells[0]);
      if (specimen && cells.length === 1) {
        note = `Specimen: ${specimen[1].toLowerCase()}`;
        continue;
      }
      const x = line[0][1];
      if (cells.length < 2 || x < 70 || x >= 120) continue;
      // Where a culture's sample was taken, a note on the rows after it.
      if (cells[0] === "Site:") {
        note = `Site: ${cells.slice(1).join(" ").toLowerCase()}`;
        continue;
      }
      rows.push(rowOf(cells, collected, note, `${file} p${index + 1}`));
    }
  });
  return rows;
}

/** A row: the printed name, then a result with its unit (and a count's share before it) and the range, or words. */
function rowOf([printed, ...rest]: string[], date: string, note: string | null, source: string): Reading {
  const bracket = /^(.*?)\s*\((.*)\)$/.exec(rest.at(-1) ?? "");
  const range = bracket ? bracket[2].trim() : null;
  const said = bracket?.[1] || null;
  const results = bracket ? rest.slice(0, -1) : rest;
  const numbers = results.map(numberCell);
  const name = printed.replace(/:\s*$/, "");
  // How the sample was taken, printed beside the range, can name the test: "Glucose" taken fasting is the fasting glucose.
  const test = (said ? testPrinted(`${name} (${said})`) : undefined) ?? testPrinted(name);
  const result = numbers.at(-1);
  const base = {
    test: test?.key ?? unknownKey(name),
    date,
    printed: name,
    labRange: range,
    lab: QML_LAB,
    sources: [source],
    note: [note, said].filter(Boolean).join("; ") || null,
  };
  if (result && numbers.every(Boolean)) {
    return {
      ...base,
      value: result.value,
      qualifier: result.qualifier,
      text: null,
      unit: result.unit,
      // A count's share, printed before its number ("55 %"), is the same result printed another way.
      alsoAs: results.slice(0, -1).map((cell) => cell.replace(/\s+/g, " ")),
    };
  }
  return { ...base, value: null, qualifier: null, text: results.join(" ").replace(/^:\s*/, ""), unit: null, alsoAs: [] };
}

/** A cell holding a number and its unit: "> 90 mL/min", "3.1 x10 ^9 /L", "0.44"; null for words. */
function numberCell(cell: string): { value: number; qualifier: "<" | ">" | null; unit: string | null } | null {
  const match = /^([<>])?\s*(-?\d[\d,]*(?:\.\d+)?)(?:\s+(.+))?$/.exec(cell.trim());
  if (!match) return null;
  return { value: Number(match[2].replace(/,/g, "")), qualifier: (match[1] as "<" | ">" | undefined) ?? null, unit: match[3]?.replace(/\s+/g, "") ?? null };
}

function lineText(line: PdfLine): string {
  return line.map(([text]) => text).join(" ").replace(/\s+/g, " ").trim();
}
