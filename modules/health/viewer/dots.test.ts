import { describe, expect, it } from "vitest";
import { ARROW_LENGTH, arrowHeads, dotRadius } from "./dots.ts";

describe("a dot's size", () => {
  it("draws the chart's latest result at 6 px and every other at 4.5 px", () => {
    expect(dotRadius(true)).toBe(6);
    expect(dotRadius(false)).toBe(4.5);
  });
});

describe("the arrows on the line", () => {
  it("puts one on each step, pointing forward, centred in the part the dots leave showing", () => {
    const [head] = arrowHeads([
      { x: 0, y: 0, r: 4 },
      { x: 100, y: 0, r: 8 },
    ]);
    // Showing from 4 to 92, so the middle at 48 and the tip half a head ahead of it.
    expect(head[0][0]).toBeCloseTo(48 + ARROW_LENGTH / 2);
    expect(head[0][1]).toBeCloseTo(0);
    expect(head[1][0]).toBeCloseTo(48 - ARROW_LENGTH / 2);
    expect(head[2][0]).toBeCloseTo(48 - ARROW_LENGTH / 2);
    expect(Math.abs(head[1][1] - head[2][1])).toBeGreaterThan(0);
  });

  it("keeps clear of the dots whatever their size", () => {
    const dots = [
      { x: 0, y: 0, r: 12 },
      { x: 30, y: 40, r: 12 },
    ];
    for (const [px, py] of arrowHeads(dots)[0]) {
      expect(Math.hypot(px - dots[0].x, py - dots[0].y)).toBeGreaterThan(dots[0].r);
      expect(Math.hypot(px - dots[1].x, py - dots[1].y)).toBeGreaterThan(dots[1].r);
    }
  });

  it("points up a rising step and leaves out a step whose dots nearly touch", () => {
    const heads = arrowHeads([
      { x: 0, y: 100, r: 4 },
      { x: 0, y: 0, r: 4 },
      { x: 12, y: 0, r: 4 },
    ]);
    expect(heads).toHaveLength(1);
    expect(heads[0][0][1]).toBeLessThan(heads[0][1][1]);
  });
});
