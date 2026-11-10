import { describe, expect, it } from "vitest";
import { addDays, addMonths, dayKey, dayKeyAt, dayStart, dayStartAt, daysBetween, isClockTime, isDay, MIDNIGHT, isMonth, monthDays, monthKey, partsTime, relativeDay, timeParts, wallClock } from "./time.ts";

describe("Melbourne days", () => {
  it("counts days on Melbourne's calendar, not UTC's", () => {
    // 9:30 pm on 4 October in Melbourne is still 4 October there, though it is 11:30 am UTC.
    expect(dayKey(Date.parse("2025-10-04T21:30:00+10:00"))).toBe("2025-10-04");
    // 8:30 am on 1 February in Melbourne (AEDT) is 31 January in UTC.
    expect(dayKey(Date.parse("2026-02-01T08:30:00+11:00"))).toBe("2026-02-01");
    expect(monthKey(Date.parse("2026-02-01T08:30:00+11:00"))).toBe("2026-02");
  });

  it("counts whole days across the daylight saving change", () => {
    const saturdayNight = Date.parse("2025-10-04T23:30:00+10:00");
    const sundayMorning = Date.parse("2025-10-05T09:00:00+11:00");
    expect(daysBetween(saturdayNight, sundayMorning)).toBe(1);
    expect(daysBetween(sundayMorning, sundayMorning + 3_600_000)).toBe(0);
    expect(relativeDay(saturdayNight, sundayMorning)).toBe("yesterday");
    expect(relativeDay(saturdayNight, Date.parse("2025-10-07T23:00:00+11:00"))).toBe("3 days ago");
    // 72 hours later is already the fourth Melbourne day, as the clocks went forward.
    expect(relativeDay(saturdayNight, saturdayNight + 3 * 86_400_000)).toBe("4 days ago");
    expect(relativeDay(saturdayNight, saturdayNight + 60 * 86_400_000)).toBe("2025-10-04");
  });
});

describe("Melbourne midnights and calendar days", () => {
  it("starts each day at its own midnight, in whichever offset the clocks are in that day", () => {
    // AEST (+10) and AEDT (+11), and the days the clocks change: forward on 5 October 2025, back on 6 April 2025.
    expect(dayStart("2025-07-01")).toBe(Date.parse("2025-07-01T00:00:00+10:00"));
    expect(dayStart("2026-01-15")).toBe(Date.parse("2026-01-15T00:00:00+11:00"));
    expect(dayStart("2025-10-05")).toBe(Date.parse("2025-10-05T00:00:00+10:00"));
    expect(dayStart("2025-10-06")).toBe(Date.parse("2025-10-06T00:00:00+11:00"));
    expect(dayStart("2025-04-06")).toBe(Date.parse("2025-04-06T00:00:00+11:00"));
    expect(dayStart("2025-04-07")).toBe(Date.parse("2025-04-07T00:00:00+10:00"));
    // So the day the clocks go forward is 23 hours long, and the day they go back 25.
    expect(dayStart("2025-10-06") - dayStart("2025-10-05")).toBe(23 * 3_600_000);
    expect(dayStart("2025-04-07") - dayStart("2025-04-06")).toBe(25 * 3_600_000);
    // And every midnight is the start of its own day, a millisecond before it the day before.
    for (const day of ["2025-10-05", "2025-10-06", "2025-04-06", "2025-04-07", "2024-02-29", "2025-12-31", "2026-01-01"]) {
      expect(dayKey(dayStart(day))).toBe(day);
      expect(dayKey(dayStart(day) - 1)).toBe(addDays(day, -1));
    }
  });

  it("finds when Melbourne's clocks read a time on a day, in either offset", () => {
    expect(wallClock("2026-02-03", "19:30")).toBe(Date.parse("2026-02-03T19:30:00+11:00"));
    expect(wallClock("2026-07-01", "07:05")).toBe(Date.parse("2026-07-01T07:05:00+10:00"));
    expect(wallClock("2025-10-05", "00:00")).toBe(dayStart("2025-10-05"));
    // The day the clocks go forward: before 2 am and after 3 am each in its own offset; 2:30, which they skip, is 3:30.
    expect(wallClock("2025-10-05", "01:30")).toBe(Date.parse("2025-10-05T01:30:00+10:00"));
    expect(wallClock("2025-10-05", "03:30")).toBe(Date.parse("2025-10-05T03:30:00+11:00"));
    expect(wallClock("2025-10-05", "02:30")).toBe(Date.parse("2025-10-05T03:30:00+11:00"));
  });

  it("counts days and months on the calendar alone", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-11", 3)).toBe("2026-02");
    expect(monthDays("2024-02")).toHaveLength(29);
    expect(monthDays("2026-02")).toHaveLength(28);
    expect(monthDays("2026-10")[0]).toBe("2026-10-01");
    expect(monthDays("2026-10").at(-1)).toBe("2026-10-31");
  });

  it("knows a day and a month as they are written", () => {
    for (const day of ["2026-10-04", "2024-02-29"]) expect(isDay(day)).toBe(true);
    for (const day of ["2026-02-29", "2026-10-4", "2026-13-01", "26-10-04", "0999-01-01", "today", ""]) expect(isDay(day)).toBe(false);
    for (const month of ["2026-10", "1999-01"]) expect(isMonth(month)).toBe(true);
    for (const month of ["2026-00", "2026-13", "2026-1", "October", ""]) expect(isMonth(month)).toBe(false);
  });
});

describe("the event form's time box", () => {
  it("shows a time as its hour, minutes and am or pm, and no time as empty boxes on pm", () => {
    expect(timeParts("")).toEqual({ hour: "", minute: "", pm: true });
    expect(timeParts("19:30")).toEqual({ hour: "7", minute: "30", pm: true });
    expect(timeParts("09:05")).toEqual({ hour: "9", minute: "05", pm: false });
    expect(timeParts("00:15")).toEqual({ hour: "12", minute: "15", pm: false });
    expect(timeParts("12:00")).toEqual({ hour: "12", minute: "00", pm: true });
  });

  it("reads what it says as HH:MM, the hour alone on the hour, nothing as no time", () => {
    expect(partsTime({ hour: "7", minute: "30", pm: true })).toBe("19:30");
    expect(partsTime({ hour: "07", minute: "5", pm: false })).toBe("07:05");
    expect(partsTime({ hour: "12", minute: "15", pm: false })).toBe("00:15");
    expect(partsTime({ hour: "12", minute: "00", pm: true })).toBe("12:00");
    expect(partsTime({ hour: "7", minute: "", pm: true })).toBe("19:00");
    expect(partsTime({ hour: "", minute: "", pm: true })).toBe("");
    expect(partsTime({ hour: "", minute: "", pm: false })).toBe("");
    for (const time of ["00:00", "07:05", "12:30", "19:45", "23:59"]) expect(partsTime(timeParts(time))).toBe(time);
  });

  it("says no time from anything it cannot read one from", () => {
    expect(partsTime({ hour: "0", minute: "30", pm: true })).toBeNull();
    expect(partsTime({ hour: "13", minute: "", pm: true })).toBeNull();
    expect(partsTime({ hour: "7", minute: "60", pm: true })).toBeNull();
    expect(partsTime({ hour: "", minute: "30", pm: true })).toBeNull();
  });
});

describe("days that begin later than midnight", () => {
  it("keep 05:59 on the day before and begin the new day at 06:00", () => {
    expect(dayKeyAt(wallClock("2026-11-04", "05:59"), "06:00")).toBe("2026-11-03");
    expect(dayKeyAt(wallClock("2026-11-04", "06:00"), "06:00")).toBe("2026-11-04");
    expect(dayKeyAt(wallClock("2026-11-04", "00:00"), "06:00")).toBe("2026-11-03");
    expect(dayKeyAt(wallClock("2026-11-04", "23:59"), "06:00")).toBe("2026-11-04");
    expect(dayStartAt("2026-11-04", "06:00")).toBe(wallClock("2026-11-04", "06:00"));
  });

  it("are the calendar's own at midnight, and run 23 or 25 hours over a change of the clocks", () => {
    for (const time of ["00:00", "05:59", "12:00"]) expect(dayKeyAt(wallClock("2026-04-05", time), MIDNIGHT)).toBe(dayKey(wallClock("2026-04-05", time)));
    expect(dayStartAt("2026-04-05", MIDNIGHT)).toBe(dayStart("2026-04-05"));
    expect((dayStartAt("2026-04-05", "06:00") - dayStartAt("2026-04-04", "06:00")) / 3_600_000).toBe(25);
    expect((dayStartAt("2026-10-04", "06:00") - dayStartAt("2026-10-03", "06:00")) / 3_600_000).toBe(23);
  });

  it("begin at a time of day, HH:MM", () => {
    expect(["00:00", "06:00", "23:59"].every(isClockTime)).toBe(true);
    expect(["24:00", "6:00", "06:60", "", "06:00:00"].some(isClockTime)).toBe(false);
  });
});
