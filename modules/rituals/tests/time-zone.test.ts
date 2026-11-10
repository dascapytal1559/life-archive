// The store's zone (src/instants.ts): RITUAL_TIME_ZONE, else its life archive's settings.json timeZone, else the
// machine's, with a warning. It is read as the code loads, so each case runs the code in a process of its own.

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NODE_MODULES } from "./helpers/fixtures.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** What src/instants.ts makes of 2026-01-15T05:00:00Z, run from `home` with `env` (RITUAL_TIME_ZONE and RITUAL_ROOT unset unless given), and what it warned. */
function zoneOf(home: string, env: { RITUAL_TIME_ZONE?: string; RITUAL_ROOT?: string } = {}) {
  const script = `
    import { TIMEZONE, ZONE_PLACE, localAbbreviation, ritualDate, isoformatLocal } from ${JSON.stringify(join(home, "src", "instants.ts"))};
    const at = Date.parse("2026-01-15T05:00:00Z") * 1000;
    console.log(JSON.stringify({ zone: TIMEZONE, place: ZONE_PLACE, abbreviation: localAbbreviation(at), date: ritualDate(at), at: isoformatLocal(at) }));
  `;
  const run: NodeJS.ProcessEnv = { ...process.env, TZ: "UTC" };
  delete run.RITUAL_TIME_ZONE;
  delete run.RITUAL_ROOT;
  const ran = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { ...run, ...env }, encoding: "utf8" });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return { ...JSON.parse(ran.stdout), warned: ran.stderr.trim() };
}

describe("the store's time zone", () => {
  let home: string;
  let archive: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "ritual-zone-"));
    await cp(SRC, join(home, "src"), { recursive: true });
    await symlink(NODE_MODULES, join(home, "node_modules"));
    archive = await mkdtemp(join(tmpdir(), "ritual-zone-archive-"));
    await mkdir(join(archive, "modules", "rituals"), { recursive: true });
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(archive, { recursive: true, force: true });
  });

  it("is RITUAL_TIME_ZONE when set: a day closing at 06:00 there, and its own abbreviation", () => {
    expect(zoneOf(home, { RITUAL_TIME_ZONE: "Australia/Melbourne" })).toEqual({ zone: "Australia/Melbourne", place: "Melbourne", abbreviation: "AEDT", date: "2026-01-15", at: "2026-01-15T16:00:00+11:00", warned: "" });
    expect(zoneOf(home, { RITUAL_TIME_ZONE: "America/New_York" })).toEqual({ zone: "America/New_York", place: "New York", abbreviation: "EST", date: "2026-01-14", at: "2026-01-15T00:00:00-05:00", warned: "" });
  });

  it("is its life archive's own without it: the timeZone of the settings.json two folders above the store's root", async () => {
    await writeFile(join(archive, "settings.json"), JSON.stringify({ timeZone: "Europe/Berlin", locale: "en-AU" }));
    expect(zoneOf(home, { RITUAL_ROOT: join(archive, "modules", "rituals") })).toMatchObject({ zone: "Europe/Berlin", abbreviation: "CET", at: "2026-01-15T06:00:00+01:00", warned: "" });
  });

  it("is the machine's with neither, and says so as it loads", async () => {
    const beside = zoneOf(home);
    expect(beside.zone).toBe("UTC");
    expect(beside.warned).toMatch(/^rituals: no time zone named .*this machine's, UTC/);
    // An archive whose settings name no zone is no different.
    await writeFile(join(archive, "settings.json"), JSON.stringify({ locale: "en-AU" }));
    const unnamed = zoneOf(home, { RITUAL_ROOT: join(archive, "modules", "rituals") });
    expect(unnamed.zone).toBe("UTC");
    expect(unnamed.warned).toContain(join(archive, "modules", "rituals", "..", "..", "settings.json"));
  });
});
