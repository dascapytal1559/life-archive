import { describe, expect, it } from "vitest";
import { dayStart } from "../src/time.ts";
import { bucketText, dateText, lengthText, minutesText, timeText } from "./format.ts";

describe("the viewer's words", () => {
  it("write times in Melbourne", () => {
    const at = Date.parse("2026-10-12T14:50:00+11:00");
    expect(dateText(at)).toBe("12 Oct 2026");
    expect(timeText(at)).toBe("2:50 pm");
  });

  it("write lengths and totals as people say them", () => {
    expect(lengthText(null)).toBe("—");
    expect(lengthText(0)).toBe("—");
    expect(lengthText(45)).toBe("45 s");
    expect(lengthText(4320)).toBe("1 h 12 min");
    expect(minutesText(48.4)).toBe("48 min");
    expect(minutesText(185)).toBe("3 h 5 min");
    expect(minutesText(18_700)).toBe("312 h");
  });

  it("name each bucket by its grain", () => {
    const start = dayStart("2026-10-12");
    expect(bucketText("2026-10-12", start, "day")).toBe("12 Oct 2026");
    expect(bucketText("2026-10-12", start, "week")).toBe("week of 12 Oct 2026");
    expect(bucketText("2026-10-01", dayStart("2026-10-01"), "month")).toBe("Oct 2026");
    expect(bucketText("2026-01-01", dayStart("2026-01-01"), "year")).toBe("2026");
  });
});
