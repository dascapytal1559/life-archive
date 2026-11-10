// A PDF's text as lines of cells. On macOS PDFKit reads it, through pdfLines.swift (macOS's own PDF reader; a Mac has
// no pdftotext), every file in one run of swift, which compiles the script once; elsewhere poppler's pdftotext does,
// its words with their boxes (-bbox), put into lines and cells as pdfLines.swift puts PDFKit's characters.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** A cell of a line: its text, and how far across the page it starts, in points. */
export type PdfCell = [text: string, x: number];
/** A line of a page: its cells, left to right. */
export type PdfLine = PdfCell[];

const SCRIPT = fileURLToPath(new URL("./pdfLines.swift", import.meta.url));

/** A space wider than this many points is a gap between cells, not between words (as in pdfLines.swift). */
const CELL_GAP = 12;

/** Which program reads PDFs here: PDFKit through swift on macOS, pdftotext elsewhere. */
export const PDF_READER: "swift" | "pdftotext" = process.platform === "darwin" ? "swift" : "pdftotext";

/** Each file's pages, each page its lines top to bottom. */
export async function readPdfLines(files: readonly string[]): Promise<Map<string, PdfLine[][]>> {
  if (files.length === 0) return new Map();
  return PDF_READER === "swift" ? readWithPdfKit(files) : readWithPdftotext(files);
}

async function readWithPdfKit(files: readonly string[]): Promise<Map<string, PdfLine[][]>> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("swift", [SCRIPT, ...files], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    throw readFailed(error, "swift is not installed: reading a PDF needs it (xcode-select --install)");
  }
  const read = JSON.parse(stdout) as Record<string, PdfLine[][]>;
  return new Map(files.map((file) => [file, read[file] ?? []]));
}

async function readWithPdftotext(files: readonly string[]): Promise<Map<string, PdfLine[][]>> {
  const read = new Map<string, PdfLine[][]>();
  for (const file of files) {
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)("pdftotext", ["-bbox", "-enc", "UTF-8", file, "-"], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
      throw readFailed(error, "pdftotext is not installed: reading a PDF needs it (poppler-utils)");
    }
    read.set(file, linesOfBoxes(stdout));
  }
  return read;
}

function readFailed(error: unknown, missing: string): Error {
  const failed = error as NodeJS.ErrnoException & { stderr?: string };
  if (failed.code === "ENOENT") return new Error(missing);
  return new Error(`could not read the PDFs: ${failed.stderr?.trim() || failed.message}`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * pdftotext -bbox's pages as lines of cells: a page's words on one line when they stand side by side (their heights
 * overlap by at least half the shorter one's, so 53.45 and 53.55 are one row, as a rounded top would not have them),
 * lines top to bottom, each line's words left to right, a new cell where the gap to the next word is wider than
 * CELL_GAP, and a cell's x where its first word starts, to the point.
 */
export function linesOfBoxes(xhtml: string): PdfLine[][] {
  const pages: PdfLine[][] = [];
  for (const [, page] of xhtml.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)) {
    const words: Array<{ text: string; xMin: number; xMax: number; yMin: number; yMax: number }> = [];
    for (const [, attributes, raw] of page.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
      const at = (name: string) => Number(new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1]);
      const text = raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]);
      words.push({ text, xMin: at("xMin"), xMax: at("xMax"), yMin: at("yMin"), yMax: at("yMax") });
    }
    const rows: Array<{ top: number; bottom: number; words: typeof words }> = [];
    for (const word of words.sort((a, b) => a.yMin - b.yMin)) {
      const height = Math.max(word.yMax - word.yMin, 0);
      const row = rows.findLast((r) => Math.min(r.bottom, word.yMax) - Math.max(r.top, word.yMin) >= Math.min(height, r.bottom - r.top) / 2);
      if (row) {
        row.words.push(word);
        row.bottom = Math.max(row.bottom, word.yMax);
      } else rows.push({ top: word.yMin, bottom: word.yMax, words: [word] });
    }
    pages.push(rows.sort((a, b) => a.top - b.top).map(({ words: line }) => {
      const cells: PdfLine = [];
      let end = -Infinity;
      for (const word of line.sort((a, b) => a.xMin - b.xMin)) {
        const last = cells.at(-1);
        if (last && word.xMin - end <= CELL_GAP) last[0] += ` ${word.text}`;
        else cells.push([word.text, Math.round(word.xMin)]);
        end = word.xMax;
      }
      return cells;
    }));
  }
  return pages;
}
