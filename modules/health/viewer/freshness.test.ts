// How the Records tab writes what the immunisations protect against (freshness.ts): the everyday name beside the
// medical one, how far through its interval today is, and how long is left or since it ended.

import { describe, expect, it } from "vitest";
import { diseaseText, durationText, elapsed, spanText } from "./freshness.ts";

describe("how fresh an immunisation is", () => {
  it("writes a disease with its everyday name where it has one", () => {
    expect(diseaseText({ name: "Pertussis", everyday: "whooping cough" })).toBe("Pertussis (whooping cough)");
    expect(diseaseText({ name: "Tetanus", everyday: null })).toBe("Tetanus");
  });

  it("places today on the interval, from 0 at the dose to 1 at its end and after", () => {
    expect(elapsed("2020-01-01", "2030-01-01", "2025-01-01")).toBeCloseTo(0.5, 2);
    expect(elapsed("2020-01-01", "2030-01-01", "2019-06-01")).toBe(0);
    expect(elapsed("2020-01-01", "2030-01-01", "2031-01-01")).toBe(1);
  });

  it("writes the time between two days in years and months, or days under a month", () => {
    expect(durationText("2026-10-20", "2033-12-31")).toBe("7 years 2 months");
    expect(durationText("2027-04-22", "2026-10-20")).toBe("6 months");
    expect(durationText("2026-10-20", "2026-11-01")).toBe("12 days");
    expect(durationText("2026-10-20", "2027-10-19")).toBe("11 months");
  });

  it("says how long is left, since it ended, or why there is no bar, without alarm", () => {
    const today = "2026-10-20";
    expect(spanText({ kind: "until", until: "2031-04-20", interval: "10 years" }, today, true)).toBe("4 years 6 months left of 10 years");
    expect(spanText({ kind: "until", until: "2024-10-20", interval: "10 years" }, today, true)).toBe("Interval of 10 years ended 2 years ago");
    expect(spanText({ kind: "course", until: "2027-01-05", doses: 1, of: 2 }, today, true)).toBe("Course incomplete: 1 of 2 doses; the next is due from 5 Jan 2027");
    expect(spanText({ kind: "lasting", label: "lifelong" }, today, true)).toBe("Lifelong");
    expect(spanText(null, today, true)).toBe("No set interval");
    expect(spanText(null, today, false)).toBe("Interval not known");
  });
});
