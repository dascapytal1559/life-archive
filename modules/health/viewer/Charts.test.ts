import { describe, expect, it } from "vitest";
import type { HealthPoint, HealthTest, Status } from "../wire.ts";
import { labelledPoints, screenBands, yearStep } from "./Charts.tsx";
import { screenWord } from "./format.ts";

describe("a chart's labels at the width it is given", () => {
  it("labels the latest point always, and each other with room from the last labelled", () => {
    expect([...labelledPoints([10, 100, 200], 38)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect([...labelledPoints([10, 180, 200], 38)].sort((a, b) => a - b)).toEqual([0, 2]);
    expect([...labelledPoints([195, 198, 200], 38)]).toEqual([2]);
  });

  it("labels every year with room, and fewer when narrow", () => {
    expect(yearStep(8, 560)).toBe(1);
    expect(yearStep(8, 280)).toBe(2);
    expect(yearStep(20, 280)).toBe(3);
  });
});

describe("a screen's chart", () => {
  const screen = (shown: "Clear" | "Immune", ...statuses: Status[]): Pick<HealthTest, "screen" | "points"> => ({
    screen: { shown, line: "Lab screen" },
    points: statuses.map((status) => ({ status }) as HealthPoint),
  });

  it("draws green alone while every result is clear", () => {
    expect(screenBands(screen("Clear", "in", "in"))).toEqual(["in"]);
    expect(screenBands(screen("Immune", "in"))).toEqual(["in"]);
  });

  it("adds red above it for a positive result", () => {
    expect(screenBands(screen("Clear", "in", "out"))).toEqual(["out", "in"]);
  });

  it("names each result by the screen's words", () => {
    const test = screen("Immune");
    expect(screenWord(test, "in")).toBe("Immune");
    expect(screenWord(test, "out")).toBe("Positive");
    expect(screenWord(test, "unjudged")).toBeNull();
    expect(screenWord({ screen: null }, "in")).toBeNull();
  });
});
