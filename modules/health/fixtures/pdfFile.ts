// Made-up PDFs written in PDF's own syntax, for the tests and the testing data (health.ts): each cell of a line drawn at
// its x in 9-point Helvetica, lines 18 points apart from 60 points below the top of an A4 page, as Everlab lays out its
// reports. Helvetica is one of PDF's standard fonts, which every reader carries, so nothing is embedded and nothing
// outside Node is needed (it was a Swift script on macOS's CoreText once, which kept the testing data to macOS).

import type { PdfLine } from "../server/pdf.ts";

const PAGE = { width: 595, height: 842 };
const TOP = 60;
const LINE_GAP = 18;
const FONT_SIZE = 9;

/** The characters past ASCII a made-up report draws, in Windows' Latin-1 (the font's WinAnsiEncoding). */
const WIN_ANSI: Record<string, number> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };

/** A cell's text as a PDF string: its bytes in WinAnsiEncoding, with ( ) \ and every byte past ASCII escaped. */
function pdfString(text: string): string {
  let out = "(";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    const byte = code >= 0x20 && code < 0x7f ? code : code >= 0xa0 && code <= 0xff ? code : WIN_ANSI[character];
    if (byte === undefined) throw new Error(`a made-up PDF cannot draw ${JSON.stringify(character)} (in ${JSON.stringify(text)}): Helvetica's WinAnsiEncoding has no such character`);
    if (character === "(" || character === ")" || character === "\\") out += `\\${character}`;
    else out += byte < 0x7f ? character : `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${out})`;
}

/** What draws a page: each cell at its x on its line. */
function pageContent(lines: PdfLine[]): string {
  const draws = lines.flatMap((line, index) => {
    const y = PAGE.height - TOP - index * LINE_GAP;
    return line.map(([text, x]) => `1 0 0 1 ${x} ${y} Tm ${pdfString(text)} Tj`);
  });
  return `BT /F1 ${FONT_SIZE} Tf\n${draws.join("\n")}\nET\n`;
}

/** A PDF of `pages`, each page its lines top to bottom, each line its cells as [text, x]. */
export function pdfFile(pages: PdfLine[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  // 1 the catalog, 2 the page tree, 3 the font, then each page and its content.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  for (const [i, lines] of pages.entries()) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    const content = pageContent(lines);
    add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`);
  }
  let file = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(file, "latin1");
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(file, "latin1");
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, "latin1");
}
