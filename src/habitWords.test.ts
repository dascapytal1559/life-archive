import { describe, expect, it } from "vitest";
import { habitDoing, heldText } from "./habitWords.ts";

describe("a habit done, in words", () => {
  it("says each of rituals' habits as a doing", () => {
    expect(["magnesium", "protein", "planks", "stretching", "journalling"].map(habitDoing)).toEqual([
      "Magnesium", "Protein", "Plank", "Stretch", "Journal",
    ]);
  });

  it("says wind-down as winding down before midnight", () => {
    expect(habitDoing("wind_down")).toBe("Winding down before midnight");
  });

  it("says a habit it has no words for by its name", () => {
    expect(habitDoing("cold_shower")).toBe("Cold shower");
  });

  it("says a required check by its id", () => {
    expect(habitDoing("morning-priority-review")).toBe("Morning priority review");
  });

  it("says how long a plank was held", () => {
    expect(heldText(1)).toBe("0:01");
    expect(heldText(75)).toBe("1:15");
    expect(heldText(120)).toBe("2:00");
  });
});
