// An edit's value read to its field's kind (values.ts), for the two kinds People brought: a short text (a name, a
// location, a person's note) and tags (several words in order), and how the record says each (editWire.ts).

import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../errors.ts";
import { editValueText, TEXT_MOST, type EditField } from "../../viewer/editWire.ts";
import { readValue } from "./values.ts";

const NAME: EditField = { key: "name", label: "Name", input: "text" };
const LOCATION: EditField = { key: "location", label: "Location", input: "text", clearable: true, suggests: true };
const NOTE: EditField = { key: "note", label: "Note", input: "text", long: true, clearable: true };
const TAGS: EditField = { key: "tags", label: "Tags", input: "tags" };

describe("a text field", () => {
  it("is one line, its spaces made one, or a few lines for a long one", () => {
    expect(readValue(NAME, "  Ada \n  Sample ")).toBe("Ada Sample");
    expect(readValue(NOTE, " first line\r\nsecond line ")).toBe("first line\nsecond line");
  });

  it("is emptied only where it can be, and refuses what is not text or too long", () => {
    expect(readValue(LOCATION, "  ")).toBeNull();
    expect(readValue(LOCATION, null)).toBeNull();
    expect(() => readValue(NAME, " ")).toThrow(InvalidInputError);
    expect(() => readValue(NAME, null)).toThrow(/cannot be left empty/);
    expect(() => readValue(NAME, 7)).toThrow(/is text/);
    expect(() => readValue(NAME, "x".repeat(TEXT_MOST + 1))).toThrow(/at most/);
  });

  it("is said as written", () => {
    expect(editValueText(NAME, "Ada Sample")).toBe("Ada Sample");
    expect(editValueText(LOCATION, null)).toBe("none");
  });
});

describe("a tags field", () => {
  it("is a list of words in order, each trimmed, without repeats or empties; empty is none", () => {
    expect(readValue(TAGS, [" climbing ", "uni  friends", "climbing", ""])).toEqual(["climbing", "uni friends"]);
    expect(readValue(TAGS, [])).toEqual([]);
    expect(readValue(TAGS, null)).toEqual([]);
  });

  it("refuses what is not a list of words", () => {
    expect(() => readValue(TAGS, "climbing")).toThrow(/a list of words/);
    expect(() => readValue(TAGS, [1, 2])).toThrow(InvalidInputError);
  });

  it("is said with commas, or none", () => {
    expect(editValueText(TAGS, ["climbing", "keep"])).toBe("climbing, keep");
    expect(editValueText(TAGS, [])).toBe("none");
  });
});
