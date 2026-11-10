// The Bryan Johnson tab's read (GET /life-archive/api/m/exercise/pillars, http.ts), on made-up data only: the weekly
// targets exercise.json sets (settings.ts), each with why it is missing, and the ritual days' stretching
// statuses as the rituals module's RitualHabits gives them, nothing else of a day; none with that module off.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HabitDay } from "../../../sdk/server.ts";
import { testingLifeArchive } from "../../../sdk/testing.ts";
import exercise from "../module.ts";
import { PILLARS_API, type PillarsAnswer } from "../wire.ts";
import { createExerciseApi } from "./http.ts";
import { EXERCISE_SETTINGS, pillarTargets, writeExerciseSettings } from "./settings.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-exercise-pillars-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the pillars' weekly targets", () => {
  it("are exercise.json's, each read as the zone 2 target is, each with why it is missing", async () => {
    const dir = await mkdtemp(join(root, "settings-"));
    expect(await pillarTargets(dir)).toEqual({
      zone2: { amount: null, why: `no target is set: put "zone2WeeklyMinutes" in the archive's ${EXERCISE_SETTINGS}` },
      lift: { amount: null, why: `no target is set: put "liftWeeklySessions" in the archive's ${EXERCISE_SETTINGS}` },
      hiit: { amount: null, why: `no target is set: put "hiitWeeklyMinutes" in the archive's ${EXERCISE_SETTINGS}` },
    });
    await writeExerciseSettings(dir, JSON.stringify({ zone2WeeklyMinutes: 300, liftWeeklySessions: 3, hiitWeeklyMinutes: "20 min" }));
    expect(await pillarTargets(dir)).toEqual({
      zone2: { amount: 300 },
      lift: { amount: 3 },
      hiit: { amount: null, why: `${EXERCISE_SETTINGS}'s hiitWeeklyMinutes is not a number of minutes above 0` },
    });
    await writeExerciseSettings(dir, JSON.stringify({ liftWeeklySessions: 0 }));
    expect((await pillarTargets(dir)).lift).toEqual({ amount: null, why: `${EXERCISE_SETTINGS}'s liftWeeklySessions is not a number of sessions above 0` });
    await writeExerciseSettings(dir, "{");
    expect(Object.values(await pillarTargets(dir)).map((t) => t.amount === null && t.why)).toEqual(Array(3).fill(`${EXERCISE_SETTINGS} is not JSON`));
  });
});

describe("the pillars' read", () => {
  const NOW = Date.parse("2026-11-04T03:00:00Z");
  const DAYS: HabitDay[] = [
    { day: "2026-11-02", habits: { magnesium: "done", protein: "not_done", stretching: "done", planks: "done", journalling: "done" } },
    { day: "2026-11-03", habits: { stretching: "not_applicable" } },
    { day: "2026-11-04", habits: { magnesium: "unreported", stretching: "unreported" } },
  ];
  const servers: Array<() => void> = [];
  afterAll(() => servers.forEach((close) => close()));

  /** The route over a made-up archive with exercise.json `settings`, and the ritual days `habits` offered (none: the rituals module off). */
  async function serve(name: string, settings: object, habits?: HabitDay[]): Promise<string> {
    const dataDir = join(root, name);
    const life = await testingLifeArchive(dataDir, exercise);
    await writeExerciseSettings(dataDir, JSON.stringify(settings));
    const server = createServer(createExerciseApi(life.module.context as Parameters<typeof createExerciseApi>[0], { now: () => NOW, habits }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(() => (server.close(), life.close()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}${PILLARS_API}`;
  }

  it("answers the targets and each ritual day's stretching status, nothing else of the day (not its planks)", async () => {
    const url = await serve("on", { zone2WeeklyMinutes: 300, liftWeeklySessions: 3, hiitWeeklyMinutes: 20 }, DAYS);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect((await res.json()) as PillarsAnswer).toEqual({
      today: "2026-11-04",
      targets: { zone2: { amount: 300 }, lift: { amount: 3 }, hiit: { amount: 20 } },
      habits: [
        { day: "2026-11-02", habits: { stretching: "done" } },
        { day: "2026-11-03", habits: { stretching: "not_applicable" } },
        { day: "2026-11-04", habits: { stretching: "unreported" } },
      ],
    });
  });

  it("has no habits with the rituals module off, and is only read", async () => {
    const url = await serve("off", { zone2WeeklyMinutes: 300 });
    expect(((await (await fetch(url)).json()) as PillarsAnswer).habits).toBeNull();
    expect((await fetch(url, { method: "DELETE", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" })).status).toBe(405);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });
});
