// Reading the health exports into the archive's health results (`npm run health -- import`; docs/features.md's "Health"):
// every PDF under each of HEALTH_EXPORTS' <export date>/ folders (Everlab's and My Health Record's; a new export goes
// beside the others, as every platform's does), each read as the lab report it is (an Everlab Pathology Results
// Report, everlab.ts; a QML Pathology report as My Health Record attaches it, qml.ts), or left to
// health/by-hand.json when that file transcribes it or skips it, or listed as unread for someone to transcribe. Run
// again at any time: it reads every export afresh and writes health/imported.json whole, so the same exports always
// give the same file.

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPathologyReport, readPathologyReport } from "./everlab.ts";
import { readPdfLines, type PdfLine } from "./pdf.ts";
import { isQmlReport, readQmlReport } from "./qml.ts";
import { byHandFiles, HEALTH_EXPORTS, type ByHand, type Imported, type Reading } from "./store.ts";

/** Where Everlab's exports are, in the archive's folder. */
export const EVERLAB_EXPORTS = HEALTH_EXPORTS[0];

/** Where My Health Record's exports are, in the archive's folder. */
export const MY_HEALTH_RECORD_EXPORTS = HEALTH_EXPORTS[1];

/** The lab reports the import reads, each by whether a PDF's pages are one and how its results are read. */
const FORMATS: ReadonlyArray<{ is: (pages: readonly PdfLine[][]) => boolean; read: (pages: readonly PdfLine[][], file: string) => Reading[] }> = [
  { is: isPathologyReport, read: readPathologyReport },
  { is: isQmlReport, read: readQmlReport },
];

export interface ImportAsk {
  dataDir: string;
  byHand: ByHand | null;
  /** Reads PDFs as lines of cells (pdf.ts); a test gives made-up ones. */
  read?: (files: readonly string[]) => Promise<Map<string, PdfLine[][]>>;
  now?: Date;
}

/** What the exports hold now, as health/imported.json would keep it. */
export async function importHealth({ dataDir, byHand, read = readPdfLines, now = new Date() }: ImportAsk): Promise<Imported> {
  const found = await Promise.all(HEALTH_EXPORTS.map((root) => everyFile(join(dataDir, root))));
  const pdfs = found.flat().filter((file) => file.toLowerCase().endsWith(".pdf")).map((file) => relative(dataDir, file)).sort();
  const { transcribed, skipped } = byHandFiles(byHand);
  const toRead = pdfs.filter((file) => !transcribed.has(file) && !skipped.has(file));
  const lines = await read(toRead.map((file) => join(dataDir, file)));
  const files: Imported["files"] = [];
  const readings: Reading[] = [];
  for (const file of pdfs) {
    if (transcribed.has(file) || skipped.has(file)) {
      files.push({ path: file, read: transcribed.has(file) ? "by-hand" : "skipped" });
      continue;
    }
    const pages = lines.get(join(dataDir, file)) ?? [];
    // A report none of whose results could be read is laid out in a way the reader does not know: one to transcribe.
    const read = FORMATS.find((f) => f.is(pages))?.read(pages, file) ?? [];
    files.push({ path: file, read: read.length > 0 ? "report" : "unread" });
    readings.push(...read);
  }
  return { version: 1, importedAt: now.toISOString(), files, readings: sameOnce(readings) };
}

/** Readings printed alike by two files (a panel exported twice) kept once, with both files; then in date and test order. */
export function sameOnce(readings: readonly Reading[]): Reading[] {
  const kept = new Map<string, Reading>();
  for (const reading of readings) {
    const key = JSON.stringify([reading.test, reading.date, reading.value, reading.qualifier, reading.text, reading.unit, reading.alsoAs]);
    const same = kept.get(key);
    if (same) same.sources = [...new Set([...same.sources, ...reading.sources])];
    else kept.set(key, { ...reading, sources: [...reading.sources] });
  }
  return [...kept.values()].sort((a, b) => a.date.localeCompare(b.date) || a.test.localeCompare(b.test) || a.sources[0].localeCompare(b.sources[0]));
}

/** Every file under `dir` (dot files too: Everlab names some panels ".ANAEMIA.pdf"); none when it is not there. */
async function everyFile(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}
