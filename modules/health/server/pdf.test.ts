// The made-up PDFs' writer (../fixtures/pdfFile.ts) and the reading of pdftotext's boxes into lines of cells (pdf.ts),
// both without any PDF reader, so they run on every machine; health.test.ts reads the written PDFs back where there is one.

import { describe, expect, it } from "vitest";
import { pdfFile } from "../fixtures/pdfFile.ts";
import { linesOfBoxes } from "./pdf.ts";

describe("a made-up PDF", () => {
  const pages = [[[["Sodium", 62], ["140", 310]], [["Potassium (K)", 62], ["4.1", 310]]], [[["Confidential — page 2", 52]]]] as const;
  const file = pdfFile(pages.map((page) => page.map((line) => line.map(([text, x]) => [text, x] as [string, number]))));
  const text = file.toString("latin1");

  it("is a PDF whose cross-reference table finds every object where it is", () => {
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(3 + pages.length * 2);
    offsets.forEach((at, i) => expect(text.slice(at).startsWith(`${i + 1} 0 obj\n`)).toBe(true));
  });

  it("draws each cell at its x on its line, 18 points apart, its brackets escaped and its dash in WinAnsiEncoding", () => {
    expect(text).toContain("1 0 0 1 62 782 Tm (Sodium) Tj\n1 0 0 1 310 782 Tm (140) Tj");
    expect(text).toContain("1 0 0 1 62 764 Tm (Potassium \\(K\\)) Tj");
    expect(text).toContain("(Confidential \\227 page 2) Tj");
    expect(text).toContain("/Count 2");
  });

  it("refuses a character Helvetica's encoding has not", () => {
    expect(() => pdfFile([[[["VO₂ max", 62]]]])).toThrow(/cannot draw "₂"/);
  });
});

describe("pdftotext's boxes", () => {
  const word = (xMin: number, yMin: number, width: number, text: string) =>
    `<word xMin="${xMin.toFixed(6)}" yMin="${yMin.toFixed(6)}" xMax="${(xMin + width).toFixed(6)}" yMax="${(yMin + 9).toFixed(6)}">${text}</word>`;
  const xhtml = `<!DOCTYPE html><html><head></head><body><doc>
  <page width="595.000000" height="842.000000">
    ${word(310, 53.4, 14, "140")}
    ${word(62, 53.4, 30, "Sodium")}
    ${word(62, 71.4, 40, "Potassium")}
    ${word(104.5, 71.4, 14, "(K)")}
    ${word(310, 71.4, 12, "4.1")}
  </page>
  <page width="595.000000" height="842.000000">
    ${word(52, 53.4, 20, "A&amp;B")}
  </page>
</doc></body></html>`;

  it("are lines top to bottom, words a word space apart one cell, and cells where the gap is wider", () => {
    expect(linesOfBoxes(xhtml)).toEqual([
      [[["Sodium", 62], ["140", 310]], [["Potassium (K)", 62], ["4.1", 310]]],
      [[["A&B", 52]]],
    ]);
  });

  it("keeps a row's words one line though their tops differ across a rounding boundary, and the next row its own", () => {
    const page = `<!DOCTYPE html><html><head></head><body><doc><page width="595.000000" height="842.000000">
      ${word(62, 53.45, 30, "Sodium")}
      ${word(310, 53.55, 14, "140")}
      ${word(62, 62.6, 40, "Potassium")}
      ${word(310, 62.4, 12, "4.1")}
    </page></doc></body></html>`;
    expect(linesOfBoxes(page)).toEqual([[[["Sodium", 62], ["140", 310]], [["Potassium", 62], ["4.1", 310]]]]);
  });
});
