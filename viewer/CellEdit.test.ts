import { describe, expect, it } from "vitest";
import { cellEditing, editingAfter, sayingFailure } from "./CellEdit.tsx";
import { fromText } from "./console/EditsTable.tsx";
import { editChangeText, rowValuesText, type EditField } from "./editWire.ts";

/** A made-up Calls table's fields: when, length and who, each a column, and a note, which has none. */
const EDITS: EditField[] = [
  { key: "when", label: "When", input: "datetime" },
  { key: "length", label: "Length", input: "minutes" },
  { key: "with", label: "With", input: "people" },
  { key: "note", label: "Note", input: "note" },
];
const CALLS = { edits: EDITS };

describe("a cell of the grid, to editing", () => {
  it("edits a column its table lets be edited in place, where its row lets it", () => {
    expect(cellEditing(CALLS, "length", {})).toEqual({ field: EDITS[1] });
    expect(cellEditing(CALLS, "with", { when: "an imported call's time is as its source says" })).toEqual({ field: EDITS[2] });
  });

  it("keeps a field its row keeps as it is, saying why", () => {
    expect(cellEditing(CALLS, "when", { when: "an imported call's time is as its source says" })).toEqual({ locked: "an imported call's time is as its source says" });
  });

  it("only reads a column with no field, a note, a row whose locks are not known, and a table with nothing to edit", () => {
    expect(cellEditing(CALLS, "app", {})).toBeNull();
    expect(cellEditing(CALLS, "note", {})).toBeNull();
    expect(cellEditing(CALLS, "length", undefined)).toBeNull();
    expect(cellEditing({}, "length", {})).toBeNull();
  });
});

describe("moving from one cell's editor to another's", () => {
  const a = { id: "call:4:sms", key: "length" };
  const b = { id: "call:7:sms", key: "with" };

  it("closes a cell's editor once it is done, but not another opened while it saved", () => {
    expect(editingAfter(a, a)).toBeNull();
    expect(editingAfter(b, a)).toBe(b);
    expect(editingAfter({ id: a.id, key: "with" }, a)).toEqual({ id: a.id, key: "with" });
    expect(editingAfter(null, a)).toBeNull();
  });

  it("says a save that failed where it outlasts the editor, and still tells the editor", async () => {
    const said: string[] = [];
    await expect(sayingFailure(Promise.reject(new Error("the archive is not running")), (message) => said.push(message))).rejects.toThrow("the archive is not running");
    expect(said).toEqual(["the archive is not running"]);
    await expect(sayingFailure(Promise.resolve(3), (message) => said.push(message))).resolves.toBe(3);
    expect(said).toHaveLength(1);
  });
});

describe("an edit in Edits, in words", () => {
  it("says what changed, an undo's as an undo, and a note's words never", () => {
    expect(editChangeText({ action: "edit", label: "Length", before: "30 min", after: "45 min", undoes: null })).toBe("Length: 30 min → 45 min");
    expect(editChangeText({ action: "edit", label: "Length", before: "45 min", after: "30 min", undoes: 12 })).toBe("Undid #12: Length: 45 min → 30 min");
    expect(editChangeText({ action: "edit", label: "Note", before: null, after: null, undoes: null })).toBe("Note changed");
    expect(editChangeText({ action: "edit", label: "Distance", before: "5 km", after: null, undoes: null })).toBe("Distance: 5 km → —");
  });

  it("says a row added or deleted by its noun and the row in words, and an undo of either as an undo", () => {
    expect(editChangeText({ action: "add", label: "hangout", before: null, after: "7 Mar 2026 · Ada Sample · 2 h", undoes: null })).toBe("Added hangout: 7 Mar 2026 · Ada Sample · 2 h");
    expect(editChangeText({ action: "delete", label: "call", before: "7 Mar 2026 8:00 pm · 30 min", after: null, undoes: null })).toBe("Deleted call: 7 Mar 2026 8:00 pm · 30 min");
    expect(editChangeText({ action: "add", label: "hangout", before: null, after: "7 Mar 2026", undoes: 4 })).toBe("Undid #4: Added hangout: 7 Mar 2026");
    expect(editChangeText({ action: "delete", label: "call", before: null, after: null, undoes: null })).toBe("Deleted call");
  });

  it("says a row's values as Add asks them, what it was on by its choice's label, but never its note", () => {
    const fields: EditField[] = [...EDITS.slice(0, 3), { key: "app", label: "On", input: "choice", choices: [{ value: "usual", label: "Their usual" }] }, EDITS[3]!];
    expect(rowValuesText(fields, { when: "2026-03-07T20:00", length: 30, with: [4], app: "usual", note: "Talked about the move" }, { 4: "Ada Sample" })).toMatch(/^7 Mar 2026 8:00\s?pm · 30 min · Ada Sample · Their usual$/);
    expect(rowValuesText(fields, { when: "2026-03-07T20:00", length: 30, with: [4], app: null, note: null }, { 4: "Ada Sample" })).toMatch(/^7 Mar 2026 8:00\s?pm · 30 min · Ada Sample$/);
  });

  it("says where it was made: here, or on the CLI and by whom", () => {
    expect(fromText({ surface: "app", who: null })).toBe("Here");
    expect(fromText({ surface: "cli", who: "claude-code" })).toBe("CLI · claude-code");
    expect(fromText({ surface: "cli", who: null })).toBe("CLI");
  });
});
