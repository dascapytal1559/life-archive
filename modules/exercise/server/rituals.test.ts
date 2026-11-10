// The workouts logged in Rituals on the Fitness page, on made-up data only (made-up logs, as the rituals module's
// RitualWorkouts service gives them, and ../fixtures/polar.ts): the rule that lays a log on the activity it is (the
// same day, family and duration; one log an activity, the closest first; a log stating no duration only when nothing
// else could be it), every activity's minutes in zone 2 (its trusted zones, else its log saying zone 2), and the
// page's answer on a made-up archive: logs matched into Polar's copies, the rest activities of their own, the weekly
// target from the archive's setting, and nothing counted twice.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, type LoggedWorkout } from "../../../sdk/server.ts";
import { testingLifeArchive } from "../../../sdk/testing.ts";
import { addDays, dayKey } from "../../../sdk/wire.ts";
import { recentRuns, writeMadeUpPolar } from "../fixtures/polar.ts";
import exercise from "../module.ts";
import { weeksTo } from "../viewer/format.ts";
import { RITUALS_SOURCE, zoneSeconds, type ActivityDetail, type ActivitySummary, type ExerciseAnswer, type RitualsLog, type Zone } from "../wire.ts";
import { RITUALS_KEEPS_IT } from "./activities.ts";
import { createExerciseApi } from "./http.ts";
import { matchLogs, zone2Of, type MatchTarget } from "./rituals.ts";
import { EXERCISE_SETTINGS, writeExerciseSettings, zone2Target } from "./settings.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-exercise-rituals-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const log = (minutes: number | null, zone2 = false): RitualsLog => ({ type: "bike", title: "Bike", details: "", minutes, zone2 });
const logged = (day: string, family: string, minutes: number | null) => ({ day, family: family as "ride", log: log(minutes) });
const target = (day: string, family: string, minutes: number, moving = minutes): MatchTarget => ({ day, family, elapsedS: minutes * 60, movingS: moving * 60 });

describe("a workout logged in Rituals is another source's activity", () => {
  it("of the same day, family and duration, within 10 minutes or a quarter of it", () => {
    const targets = [target("2026-11-02", "ride", 48), target("2026-11-02", "run", 45), target("2026-11-03", "ride", 48), target("2026-11-04", "ride", 100)];
    expect([...matchLogs([logged("2026-11-02", "ride", 44)], targets)]).toEqual([[0, 0]]);
    // Another day, another family, or too far from its duration: none.
    expect(matchLogs([logged("2026-11-01", "ride", 48)], targets).size).toBe(0);
    expect(matchLogs([logged("2026-11-02", "other", 48)], targets).size).toBe(0);
    expect(matchLogs([logged("2026-11-02", "ride", 30)], targets).size).toBe(0);
    // A quarter of 80 is 20: 100 minutes is that far.
    expect([...matchLogs([logged("2026-11-04", "ride", 80)], targets)]).toEqual([[0, 3]]);
    // Its moving time counts as much as its elapsed time.
    expect([...matchLogs([logged("2026-11-05", "ride", 40)], [target("2026-11-05", "ride", 70, 42)])]).toEqual([[0, 0]]);
  });

  it("one log an activity, one activity a log, the closest pairs first", () => {
    const targets = [target("2026-11-02", "ride", 30), target("2026-11-02", "ride", 60)];
    const logs = [logged("2026-11-02", "ride", 55), logged("2026-11-02", "ride", 32), logged("2026-11-02", "ride", 58)];
    expect([...matchLogs(logs, targets)].sort()).toEqual([[1, 0], [2, 1]]);
  });

  it("stating no duration, only when it is the day's one log of its family and the day has one such activity", () => {
    expect([...matchLogs([logged("2026-11-02", "walk", null)], [target("2026-11-02", "walk", 35)])]).toEqual([[0, 0]]);
    expect(matchLogs([logged("2026-11-02", "walk", null)], [target("2026-11-02", "walk", 35), target("2026-11-02", "walk", 20)]).size).toBe(0);
    expect(matchLogs([logged("2026-11-02", "walk", null), logged("2026-11-02", "walk", null)], [target("2026-11-02", "walk", 35)]).size).toBe(0);
  });
});

describe("an activity's minutes in zone 2", () => {
  const zones: Zone[] = [
    { zone: 1, share: 10, time: "4:30", from: 95 },
    { zone: 2, share: 60, time: "27:06", from: 114 },
    { zone: 3, share: 30, time: "1:02:03", from: 133 },
  ];

  it("are its trusted zones' zone 2 time, whatever its log says, so nothing is counted twice", () => {
    expect(zone2Of(zones, null)).toEqual({ minutes: 27.1, from: "heart-rate" });
    expect(zone2Of(zones, log(48, true))).toEqual({ minutes: 27.1, from: "heart-rate" });
    expect(zone2Of(zones.filter((z) => z.zone !== 2), null)).toEqual({ minutes: 0, from: "heart-rate" });
    expect([zoneSeconds("27:06"), zoneSeconds("1:02:03"), zoneSeconds(null)]).toEqual([1626, 3723, null]);
  });

  it("are, with no trusted zones, its log's stated minutes when it says zone 2; else none", () => {
    expect(zone2Of([], log(44, true))).toEqual({ minutes: 44, from: "rituals" });
    expect(zone2Of([], log(null, true))).toBeNull();
    expect(zone2Of([], log(44, false))).toBeNull();
    expect(zone2Of([], null)).toBeNull();
  });
});

describe("the weekly zone 2 target", () => {
  it("is the archive's setting, or why there is none", async () => {
    const dir = join(root, "settings");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    expect(await zone2Target(dir)).toMatchObject({ minutes: null, why: expect.stringContaining("zone2WeeklyMinutes") });
    await writeExerciseSettings(dir, JSON.stringify({ zone2WeeklyMinutes: 300 }));
    expect(await zone2Target(dir)).toEqual({ minutes: 300 });
    await writeExerciseSettings(dir, JSON.stringify({ zone2WeeklyMinutes: "5h" }));
    expect(await zone2Target(dir)).toMatchObject({ minutes: null, why: expect.stringContaining("not a number") });
    await writeExerciseSettings(dir, "{");
    expect(await zone2Target(dir)).toMatchObject({ minutes: null, why: `${EXERCISE_SETTINGS} is not JSON` });
  });
});

describe("the Fitness page with Rituals' workouts", () => {
  // A Wednesday afternoon in Melbourne: Rituals' open day is today, and the week runs from Monday 2 November.
  const NOW = Date.parse("2026-11-04T03:00:00Z");
  const today = dayKey(NOW);
  const ago = (n: number) => addDays(today, -n);
  let answer: ExerciseAnswer;
  let url: string;
  let close: () => void;

  /**
   * The workouts logged in Rituals, as its module's RitualWorkouts service gives them (modules/rituals/server/workouts.ts):
   * a few the made-up Polar workouts (a ride two days ago of 48 minutes, a run four days ago of 45, a walk six days ago,
   * a ride twelve days ago of 62), the rest workouts of their own.
   */
  const logged = (daysAgo: number, type: string, family: LoggedWorkout["family"], title: string, details: string, minutes: number | null, zone2: boolean): LoggedWorkout =>
    ({ id: `rituals-${ago(daysAgo)}-1`, day: ago(daysAgo), family, log: { type, title, details, minutes, zone2 } });
  const LOGS: LoggedWorkout[] = [
    logged(0, "bike", "ride", "Bike 35 min", "35 min easy spin, zone 2.", 35, true),
    logged(1, "gym push", "other", "Gym Push", "Bench press: 20 kg x 8; 40 kg x 10; 50 kg x 6\nOverhead press: 25 kg x 10; 30 kg x 8\nDips: 3 x 12", null, false),
    logged(2, "bike", "ride", "Bike 48 min", "48 minutes, zone 2", 48, true),
    logged(4, "run", "run", "run", "45 min along the river, zone 2 the whole way.", 45, true),
    logged(6, "walk", "walk", "walk", "Around the block.", null, false),
    logged(12, "bike", "ride", "bike", "1h 2m, zone 2 mostly.", 62, true),
  ];

  beforeAll(async () => {
    const dataDir = join(root, "page");
    const life = await testingLifeArchive(dataDir, exercise);
    const context = life.module.context as Parameters<typeof createExerciseApi>[0];
    await writeMadeUpPolar(context.db, dataDir, { recent: recentRuns(NOW) });
    await writeExerciseSettings(dataDir, JSON.stringify({ zone2WeeklyMinutes: 300 }));
    const server = createServer(createExerciseApi(context, { now: () => NOW, logged: Effect.succeed(LOGS) }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise/activities`;
    close = () => {
      server.close();
      life.close();
    };
    answer = (await (await fetch(url)).json()) as ExerciseAnswer;
  });
  afterAll(() => close());

  const on = (day: string) => answer.activities.filter((a) => a.start.slice(0, 10) === day);

  it("lays a log on the Polar workout it is, as another copy, its log on the activity", () => {
    // Two days ago: Polar's 48-minute ride, and the ride logged as "48 minutes, zone 2".
    const [ride] = on(ago(2));
    expect(on(ago(2))).toHaveLength(1);
    expect(ride).toMatchObject({ family: "ride", source: "Polar Flow", alsoIn: [RITUALS_SOURCE], logged: { type: "bike", minutes: 48, zone2: true } });
    // Its zone 2 is its chest strap's, not the 48 minutes logged.
    expect(ride.zone2).toMatchObject({ from: "heart-rate" });
    expect(ride.zone2!.minutes).not.toBe(48);
    // The 45-minute run, the walk logged with no duration (the day's one walk), and "1h 2m" against a 62-minute ride.
    expect(on(ago(4))).toEqual([expect.objectContaining({ family: "run", alsoIn: [RITUALS_SOURCE] })]);
    expect(on(ago(6))).toEqual([expect.objectContaining({ family: "walk", alsoIn: [RITUALS_SOURCE], logged: expect.objectContaining({ minutes: null }) })]);
    expect(on(ago(12))).toEqual([expect.objectContaining({ family: "ride", alsoIn: [RITUALS_SOURCE], logged: expect.objectContaining({ minutes: 62 }) })]);
  });

  it("shows the rest as activities of their own, known by their day, with their log", () => {
    // Yesterday: Polar's run, and the gym push logged in Rituals, two activities.
    const yesterday = on(ago(1));
    expect(yesterday.map((a) => a.source)).toEqual(["Polar Flow", RITUALS_SOURCE]);
    const gym = yesterday[1];
    expect(gym).toMatchObject({ id: `rituals-${ago(1)}-1`, start: ago(1), sport: "Gym push", family: "other", elapsedS: null, heartRate: null, zone2: null });
    // Rituals' own title for it, as rituals derives one from its category.
    expect(gym.title).toBe(gym.logged!.title);
    expect(gym.title.toLowerCase()).toBe("gym push");
    expect(gym.logged!.details).toContain("Bench press: 20 kg x 8");
    // Today's ride, logged as 35 minutes of zone 2: its stated minutes.
    expect(on(today)).toEqual([expect.objectContaining({ start: today, family: "ride", sport: "Cycling", elapsedS: 35 * 60, zone2: { minutes: 35, from: "rituals" } })]);
  });

  it("counts this week's zone 2 against the archive's target, each activity once", () => {
    expect(answer.zone2Target).toEqual({ minutes: 300 });
    // No zones set, so every activity's zones are Polar's own, and the answer says why.
    expect(answer.zones).toEqual({ starts: null, why: `no zones are set: put "heartRateZones" in the archive's ${EXERCISE_SETTINGS}` });
    expect(answer.activities.every((a) => a.zonesBy !== "archive")).toBe(true);
    const [, week] = weeksTo(answer.activities, answer.today, 2);
    const fromHeart = answer.activities.filter((a) => a.start.slice(0, 10) >= week.from && a.zone2?.from === "heart-rate").reduce((n, a) => n + a.zone2!.minutes, 0);
    expect(fromHeart).toBeGreaterThan(0);
    // The two Polar workouts' chest strap (the ride two days ago, merged, and yesterday's run) and today's 35 logged.
    expect(week.zone2Minutes).toBeCloseTo(fromHeart + 35, 5);
    expect(answer.activities.filter((a) => a.start.slice(0, 10) >= week.from).length).toBe(4);
  });

  it("opens a logged workout's page by its id, and will not delete one Rituals keeps", async () => {
    const res = await fetch(`${url}/rituals-${ago(1)}-1`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as ActivityDetail;
    expect(detail).toMatchObject({ cannotDelete: RITUALS_KEEPS_IT, route: null, splits: [], logged: { type: "gym push" } });
    const merged = answer.activities.find((a: ActivitySummary) => a.start.startsWith(ago(2)))!;
    expect(((await (await fetch(`${url}/${merged.id}`)).json()) as ActivityDetail).cannotDelete).toBe(RITUALS_KEEPS_IT);
  });
});
