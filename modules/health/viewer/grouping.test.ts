import { describe, expect, it } from "vitest";
import type { HealthTest, Status } from "../wire.ts";
import { SYSTEMS } from "../server/catalogue.ts";
import { collapsedOf, foldedHint, groupByOf, groupBySearch, groupTests, toggled } from "./grouping.ts";

const test = (key: string, system: string, status: Status): HealthTest => ({
  key,
  name: key,
  unit: null,
  system,
  kind: "number",
  status,
  margin: 0.5,
  points: [],
  bands: [],
  rungs: [],
  scale: null,
  authority: null,
  noAuthority: null,
  screen: null,
  treatment: null,
});

const SYSTEM_LIST = Object.entries(SYSTEMS).map(([key, name]) => ({ key, name }));

// In the server's order: by status first.
const TESTS = [
  test("ferritin", "Iron and vitamins", "far"),
  test("ldl", "Heart and cholesterol", "out"),
  test("b12", "Iron and vitamins", "mild"),
  test("hba1c", "Blood sugar", "edge"),
  test("hdl", "Heart and cholesterol", "in"),
  test("mystery", "Other", "unjudged"),
];

const shape = (by: "status" | "category") =>
  groupTests(TESTS, by, SYSTEM_LIST).map((g) => [g.title, g.status ?? g.category, g.tests.map((t) => t.key)]);

describe("the Health page's grouping", () => {
  it("by status, folds far out into out and leaves out empty statuses", () => {
    expect(shape("status")).toEqual([
      ["Out", "out", ["ferritin", "ldl"]],
      ["Mildly out", "mild", ["b12"]],
      ["At the edge", "edge", ["hba1c"]],
      ["In range", "in", ["hdl"]],
      ["Not judged", "unjudged", ["mystery"]],
    ]);
  });

  it("by category, in the catalogue's order, worst first within, an unlisted category last and uncoloured", () => {
    expect(shape("category")).toEqual([
      ["Heart and cholesterol", "heart", ["ldl", "hdl"]],
      ["Blood sugar", "sugar", ["hba1c"]],
      ["Iron and vitamins", "iron", ["ferritin", "b12"]],
      ["Other", null, ["mystery"]],
    ]);
  });

  it("keeps the grouping in the query, status as none", () => {
    expect(groupByOf("")).toBe("status");
    expect(groupByOf("?group=nonsense")).toBe("status");
    expect(groupByOf(groupBySearch("", "category"))).toBe("category");
    expect(groupBySearch("", "category")).toBe("?group=category");
    expect(groupBySearch("?group=category", "status")).toBe("");
    expect(groupBySearch("?x=1&group=category", "status")).toBe("?x=1");
  });
});

describe("folding categories", () => {
  it("reads what is stored, and nothing from anything else", () => {
    expect(collapsedOf(null)).toEqual(new Set());
    expect(collapsedOf("not json")).toEqual(new Set());
    expect(collapsedOf('{"a":1}')).toEqual(new Set());
    expect(collapsedOf('["Heart and cholesterol", 3]')).toEqual(new Set(["Heart and cholesterol"]));
  });

  it("toggles one category without touching the set it was given", () => {
    const start = new Set(["Liver"]);
    expect(toggled(start, "Kidney")).toEqual(new Set(["Liver", "Kidney"]));
    expect(toggled(start, "Liver")).toEqual(new Set());
    expect(start).toEqual(new Set(["Liver"]));
  });

  it("hints at a folded section's worst: out (far counted), else mildly out, else nothing", () => {
    expect(foldedHint([test("a", "x", "far"), test("b", "x", "out"), test("c", "x", "mild")])).toEqual({ status: "out", text: "2 out" });
    expect(foldedHint([test("a", "x", "mild"), test("b", "x", "in")])).toEqual({ status: "mild", text: "1 mildly out" });
    expect(foldedHint([test("a", "x", "edge"), test("b", "x", "in")])).toBeNull();
  });
});
