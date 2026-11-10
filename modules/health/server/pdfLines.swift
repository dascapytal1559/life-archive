// A PDF's text as lines of cells, through PDFKit (macOS has no pdftotext): for each file named, each page's lines top
// to bottom, each line its cells left to right as [text, x], where x is how far across the page (in points) the cell
// starts. A cell ends at a gap wider than a word space, which is how a table's columns come apart; positions come from
// each character's selection (PDFPage.characterBounds drifts on these files). Printed to standard output as JSON:
// { "<file>": [ [ [ ["Sodium", 62], ["140", 310] ], ... ], ... ] }. Run by modules/health/server/pdf.ts:
//
//   swift modules/health/server/pdfLines.swift <file.pdf> ...

import Foundation
import PDFKit

/** A space wider than this many points is a gap between cells, not between words. */
let cellGap: CGFloat = 12

var out: [String: Any] = [:]
for path in CommandLine.arguments.dropFirst() {
  guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
    FileHandle.standardError.write("cannot read \(path) as a PDF\n".data(using: .utf8)!)
    exit(1)
  }
  var pages: [[[[Any]]]] = []
  for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let text = (page.string ?? "") as NSString
    var lines: [[[Any]]] = []
    var cells: [[Any]] = []
    var cell = ""
    var x = 0.0
    func endCell() {
      let trimmed = cell.trimmingCharacters(in: .whitespaces)
      if !trimmed.isEmpty { cells.append([trimmed, x]) }
      cell = ""
    }
    func endLine() {
      endCell()
      if !cells.isEmpty { lines.append(cells) }
      cells = []
    }
    for i in 0..<text.length {
      let character = text.substring(with: NSRange(location: i, length: 1))
      if character == "\n" || character == "\r" {
        endLine()
        continue
      }
      let bounds = page.selection(for: NSRange(location: i, length: 1))?.bounds(for: page) ?? .zero
      if character.trimmingCharacters(in: .whitespaces).isEmpty {
        if bounds.width > cellGap { endCell() } else if !cell.isEmpty { cell += " " }
        continue
      }
      if cell.isEmpty { x = Double(bounds.minX).rounded() }
      cell += character
    }
    endLine()
    pages.append(lines)
  }
  out[path] = pages
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]))
