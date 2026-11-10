import { describe, expect, it } from "vitest";
import type { AuthorityBand, Rung } from "../wire.ts";
import { shownRungs } from "./format.ts";
import { bandOf, bandWho, restatesLine } from "./RangeInfo.tsx";

const band = (sex: AuthorityBand["sex"], ages: AuthorityBand["ages"], low: number, high: number): AuthorityBand => ({ sex, ages, low, high, lowOpen: false, highOpen: false });
const UREA = [band("male", [18, 50], 3.5, 8.0), band("male", [50, 70], 4.0, 9.0), band("male", [70, null], 4.5, 10.0), band("female", [18, 50], 3.0, 7.0)];

describe("the information modal's bands", () => {
  it("picks the band for the sex and the age that day, as the server does", () => {
    expect(bandOf(UREA, "male", 49)).toBe(UREA[0]);
    expect(bandOf(UREA, "male", 50)).toBe(UREA[1]);
    expect(bandOf(UREA, "male", 82)).toBe(UREA[2]);
    expect(bandOf(UREA, "female", 30)).toBe(UREA[3]);
    expect(bandOf(UREA, "female", 60)).toBeNull();
    expect(bandOf(UREA, "male", 17)).toBeNull();
    expect(bandOf([band(null, null, 1, 2)], "female", 5)).not.toBeNull();
  });

  it("says who a band is for", () => {
    expect(bandWho(UREA[1])).toBe("Men, 50 to 69");
    expect(bandWho(UREA[2])).toBe("Men, 70 and over");
    expect(bandWho(band(null, [18, null], 1, 2))).toBe("Everyone, 18 and over");
    expect(bandWho(band("female", null, 1, 2))).toBe("Women");
  });
});

describe("the band table's out rows", () => {
  const rung = (grade: Rung["grade"], side: Rung["side"], low: number | null, high: number | null, source = "lab"): Rung => ({ grade, side, low, high, lowOpen: false, highOpen: false, source, label: null });
  const dropped = (rungs: Rung[]) => {
    const bands = shownRungs(rungs);
    return bands.filter((band) => restatesLine(band, bands, "lab")).map((band) => band.side);
  };

  it("leaves out an out row that only restates the line, from its own source", () => {
    // Transferrin: 2.0 to 3.2, out either side, nothing graded further.
    expect(dropped([rung("out", "below", null, 2), rung("in", "in", 2, 3.2), rung("out", "above", 3.2, null)])).toEqual(["below", "above"]);
  });

  it("keeps one with a bound or grade of its own, or another source", () => {
    // LDL: mildly out to 4.1, then out, graded by another source.
    expect(dropped([rung("in", "in", null, 3), rung("mild", "above", 3, 4.1, "ncep"), rung("out", "above", 4.1, null, "ncep")])).toEqual([]);
    // Graded by the line's own source: yellow then red.
    expect(dropped([rung("in", "in", 2, 3), rung("mild", "above", 3, 4), rung("out", "above", 4, null)])).toEqual([]);
    // Vitamin D: an upper limit adopted from another source.
    expect(dropped([rung("out", "below", null, 50), rung("in", "in", 50, 125), rung("out", "above", 125, null, "iom")])).toEqual(["below"]);
  });
});
