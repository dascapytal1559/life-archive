// The exercise module's tools at the agents' door (agents.ts), on made-up workouts (the module's testing data) and
// made-up ritual days: the activities over a range of days, facts alone (no heart rate, route or title), and a week's
// five pillars, counted as the Fitness page's Bryan Johnson tab counts them.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RitualHabits, type HabitDay } from "../../../sdk/server.ts";
import { testingLifeArchive, type TestingLifeArchive } from "../../../sdk/testing.ts";
import exercise from "../module.ts";
import { exerciseAgents } from "./agents.ts";
import { mapStore } from "./maps/tiles.ts";
import { ExerciseReads, exerciseLoader, exerciseReads } from "./service.ts";

let root: string;
let life: TestingLifeArchive;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-exercise-agents-"));
  life = await testingLifeArchive(root, exercise);
  await exercise.fixtures!.write(root, life.module.context as never);
}, 60_000);

afterAll(async () => {
  life?.close();
  await rm(root, { recursive: true, force: true });
});

const DAYS: HabitDay[] = [
  { day: "2026-11-02", habits: { stretching: "done", planks: "done" } },
  { day: "2026-11-03", habits: { stretching: "not_done", planks: "done" } },
];

/** The tool `name`'s answer to `input` at `now`, with the module's reads and the ritual days above. */
function answer(name: string, input: Record<string, unknown>, now: number) {
  const { folder, db } = life.module.context as { folder: string; db: Parameters<typeof exerciseReads>[1] };
  const tool = exerciseAgents(life.module.context as never).tools.find((t) => t.name === name)!;
  const reads = exerciseReads(exerciseLoader(folder, Effect.succeed([])), db, mapStore(folder));
  const services = Context.make(ExerciseReads, reads).pipe(Context.add(RitualHabits, { days: Effect.succeed(DAYS) }));
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      return yield* (tool.run as unknown as (input: unknown) => Effect.Effect<Record<string, unknown>, never, ExerciseReads | RitualHabits>)(input);
    }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
  );
}

describe("exercise_activities", () => {
  it("lists the activities in a range, newest first, facts alone", async () => {
    const all = (await answer("exercise_activities", { from: "2000-01-01", to: "2100-01-01" }, Date.now())) as { count: number; activities: Array<Record<string, unknown>> };
    expect(all.count).toBeGreaterThan(0);
    const starts = all.activities.map((a) => String(a.start));
    expect(starts).toEqual([...starts].sort().reverse());
    for (const activity of all.activities) {
      expect(Object.keys(activity).sort()).toEqual(["alsoIn", "distanceKm", "elapsedMinutes", "family", "id", "movingMinutes", "recorder", "ritualsCategory", "source", "sport", "start", "zone2Minutes"]);
    }
    expect(JSON.stringify(all)).not.toMatch(/heartRate|thumb|"title"|details/);
  });

  it("refuses a range that ends before it begins", async () => {
    await expect(answer("exercise_activities", { from: "2026-11-05", to: "2026-11-01" }, Date.now())).rejects.toThrow(/after to/);
  });
});

describe("exercise_pillars", () => {
  it("counts a week's five pillars against their targets, mobility from the ritual days, balance never from the plank days", async () => {
    const week = (await answer("exercise_pillars", { week: "2026-11-04" }, Date.parse("2026-11-04T03:00:00Z"))) as { week: { from: string; to: string }; pillars: Array<{ pillar: string; value: number | null; target: number | null; reading: string }> };
    expect(week.week).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
    expect(week.pillars.map((p) => p.pillar)).toEqual(["Strength Training", "Low Intensity Cardio", "High Intensity Cardio", "Mobility & Flexibility", "Balance"]);
    expect(week.pillars.find((p) => p.pillar === "Mobility & Flexibility")).toMatchObject({ value: 1, target: 7, reading: "1 / 7 days" });
    expect(week.pillars.find((p) => p.pillar === "Balance")).toMatchObject({ value: null, reading: "no balance logged" });
  });
});
