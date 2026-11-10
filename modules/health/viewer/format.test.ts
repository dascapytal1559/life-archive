import { describe, expect, it } from "vitest";
import type { HealthPoint, HealthTest, Rung } from "../wire.ts";
import { decimalsOf, limitsText, placesText, shownRungs, starsText } from "./format.ts";

const point = (value: number, labRange: string | null): HealthPoint => ({
  date: "2026-02-18", age: 50, value, qualifier: null, text: null, unit: "mmol/L", printed: "Non HDL Cholesterol", status: "in",
  limits: { low: null, high: 4, lowOpen: false, highOpen: false }, by: null, labRange, lab: "Sample Pathology", sources: ["x"], alsoAs: [], note: null,
});
const test = (points: HealthPoint[]) => ({ points }) as HealthTest;

describe("how the Health tab writes its numbers", () => {
  it("keeps the decimals the lab printed, which a number read from \"4.0\" loses", () => {
    expect(decimalsOf(test([point(4, "<4.0")]))).toBe(1);
    expect(limitsText({ low: null, high: 4, lowOpen: false, highOpen: false }, decimalsOf(test([point(4, "<4.0")])), "mmol/L")).toBe("4.0 mmol/L or under");
    expect(decimalsOf(test([point(4, null)]))).toBe(0);
    expect(decimalsOf(test([point(0.1, "0-0.24")]))).toBe(2);
  });

  it("writes a source's stars out of three", () => {
    expect(starsText(3)).toBe("★★★");
    expect(starsText(1)).toBe("★☆☆");
    expect(starsText(0)).toBe("☆☆☆");
  });
});

describe("the Health tab's three colours", () => {
  const rung = (grade: Rung["grade"], side: Rung["side"], low: number | null, high: number | null, label: string | null = null): Rung => ({
    grade, side, low, high, lowOpen: false, highOpen: side === "above" ? false : true, source: "s", label,
  });
  // In range 3.5–5.5, graded both ways: mildly out, out, then far out.
  const rungs = [
    rung("in", "in", 3.5, 5.5),
    rung("mild", "above", 5.5, 6.5), rung("out", "above", 6.5, 8, "Grade 2"), rung("far", "above", 8, null, "Grade 3"),
    rung("mild", "below", 3, 3.5), rung("out", "below", 2.5, 3), rung("far", "below", null, 2.5),
  ];

  it("draws each side's out and far out as one red band, from the nearest rung to the farthest", () => {
    const shown = shownRungs(rungs);
    expect(shown.map((r) => `${r.side} ${r.grade} ${r.low}–${r.high}`)).toEqual(["in in 3.5–5.5", "above mild 5.5–6.5", "above out 6.5–null", "below mild 3–3.5", "below out null–3"]);
    expect(shown[2].parts.map((p) => p.label)).toEqual(["Grade 2", "Grade 3"]);
  });

  it("draws a one-sided range in range on its open side, with nothing out there", () => {
    // LDL-like: an upper limit, graded above it; everything under it is in range, down to the chart's bottom.
    const upper = [rung("in", "in", null, 3), rung("mild", "above", 3, 4.1), rung("out", "above", 4.1, 4.9), rung("far", "above", 4.9, null)];
    expect(shownRungs(upper).map((r) => `${r.side} ${r.grade} ${r.low}–${r.high}`)).toEqual(["in in null–3", "above mild 3–4.1", "above out 4.1–null"]);
    // A lower limit alone, with no grades: in range up to the top, one red band under it.
    const lower = [rung("in", "in", 50, null), rung("out", "below", null, 50)];
    expect(shownRungs(lower).map((r) => `${r.side} ${r.grade} ${r.low}–${r.high}`)).toEqual(["in in 50–null", "below out null–50"]);
  });

  it("names the places that reported a test, in order and once each, up to any comma", () => {
    const at = (date: string, lab: string) => ({ ...point(4, null), date, lab });
    expect(placesText(test([at("2017-03-01", "Sample Lab"), at("2022-03-01", "Sample Pathology"), at("2026-03-01", "Sample Lab")]))).toBe("Sample Lab, Sample Pathology");
    expect(placesText(test([at("2026-03-01", "Everlab, measured at the physical assessment")]))).toBe("Everlab");
  });
});
