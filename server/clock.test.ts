// The archive's clock and phone country come from its settings (settings.ts, onSettings.ts), and an archive keeps its zone.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptLanguage, dayKey, dayStart, isoAt, LOCALE, setClock, TIME_ZONE, timeOfDay, wallClock, zonePlace } from "../src/time.ts";
import { getMeta } from "./archive/db.ts";
import { openCore } from "./archive/coreDb.ts";
import { normalizeHandle, setPhoneCountry } from "./archive/names.ts";
import { settings } from "./settings.ts";

const testing = { timeZone: TIME_ZONE, locale: LOCALE };

afterEach(() => {
  setClock(testing);
  setPhoneCountry(settings().phoneCountry);
});

describe("the clock", () => {
  // 2026-01-15 14:30 UTC.
  const at = Date.UTC(2026, 0, 15, 14, 30);

  it("reckons days and times in the zone it is set to", () => {
    expect([dayKey(at), timeOfDay(at), isoAt(at)]).toEqual(["2026-01-16", "01:30", "2026-01-16T01:30:00+11:00"]);
    setClock({ timeZone: "America/New_York", locale: "en-US" });
    expect([dayKey(at), timeOfDay(at), isoAt(at)]).toEqual(["2026-01-15", "09:30", "2026-01-15T09:30:00-05:00"]);
    expect(wallClock("2026-01-15", "09:30")).toBe(at);
  });

  it("names the zone's place for people, and says the locale to other sites", () => {
    expect(zonePlace()).toBe("Melbourne");
    expect(acceptLanguage()).toBe("en-AU,en;q=0.9");
    setClock({ timeZone: "America/New_York", locale: "en-US" });
    expect(zonePlace()).toBe("New York");
    expect(acceptLanguage()).toBe("en-US,en;q=0.9");
  });
});

describe("a day whose clocks change", () => {
  const read = (ms: number) => isoAt(ms);

  it("reads a skipped time later by the clock in every zone, Melbourne's as it always has", () => {
    expect(read(wallClock("2026-10-04", "02:30"))).toBe("2026-10-04T03:30:00+11:00");
    setClock({ timeZone: "America/New_York", locale: "en-US" });
    expect(read(wallClock("2026-03-08", "02:30"))).toBe("2026-03-08T03:30:00-04:00");
    setClock({ timeZone: "Australia/Lord_Howe", locale: "en-AU" });
    expect(read(wallClock("2026-10-04", "02:15"))).toBe("2026-10-04T02:45:00+11:00");
  });

  it("reads a time said twice as it always has", () => {
    expect(read(wallClock("2026-04-05", "02:30"))).toBe("2026-04-05T02:30:00+10:00");
    setClock({ timeZone: "America/New_York", locale: "en-US" });
    expect(read(wallClock("2026-11-01", "01:30"))).toBe("2026-11-01T01:30:00-04:00");
  });

  it("begins at its first instant where the clocks skip midnight", () => {
    setClock({ timeZone: "America/Havana", locale: "es-CU" });
    expect(read(dayStart("2026-03-08"))).toBe("2026-03-08T01:00:00-04:00");
    expect(dayKey(dayStart("2026-03-08"))).toBe("2026-03-08");
    expect(dayKey(dayStart("2026-03-08") - 1)).toBe("2026-03-07");
    setClock({ timeZone: "America/Santiago", locale: "es-CL" });
    expect(read(dayStart("2026-09-06"))).toBe("2026-09-06T01:00:00-03:00");
  });

  it("begins at the first of its two midnights where the clocks go back over one", () => {
    setClock({ timeZone: "America/Havana", locale: "es-CU" });
    expect(read(dayStart("2026-11-01"))).toBe("2026-11-01T00:00:00-04:00");
  });
});

describe("the phone country", () => {
  it("is what a local number is read in; with none it stays as written", () => {
    expect(normalizeHandle("0491 570 006")).toBe("+61491570006");
    setPhoneCountry("44");
    // No country's fiction range is "0 and nine digits" but Australia's, so a plainly patterned one.
    expect(normalizeHandle("0555 555 555")).toBe("+44555555555");
    setPhoneCountry(null);
    expect(normalizeHandle("0491 570 006")).toBe("0491 570 006");
    expect(normalizeHandle("+61 491 570 006")).toBe("+61491570006");
  });
});

describe("an archive's time zone", () => {
  let folder: string | undefined;

  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = undefined;
  });

  it("is kept from its first open, and any other is refused", async () => {
    folder = await mkdtemp(join(tmpdir(), "life-archive-clock-"));
    const file = join(folder, "core.sqlite");
    const db = openCore(file);
    expect(getMeta(db, "time_zone")).toBe(TIME_ZONE);
    db.close();
    openCore(file).close();
    setClock({ timeZone: "Asia/Tokyo", locale: "en-AU" });
    expect(() => openCore(file)).toThrow(/the core's days are in Australia\/Melbourne, but its settings say Asia\/Tokyo/);
    setClock(testing);
    openCore(file).close();
  });
});
