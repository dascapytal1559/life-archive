// What the module reads of a workout logged in rituals, on made-up words only: the minutes they state (one duration,
// or an hour and minutes said together, never guessed between two), whether they say zone 2 and no other zone, the
// sport's family by its category, and the made-up store's workouts as the Fitness page is given them.

import { beforeAll, describe, expect, it } from "vitest";
import { madeUpRitualsView } from "../fixtures/rituals.ts";
import type { RitualsView } from "../wire.ts";
import { familyOf, loggedWorkouts, saysZone2, statedMinutes, workoutDays } from "./workouts.ts";

describe("what the archive reads of a workout logged in rituals", () => {
  it("is the minutes it states, one duration or an hour and minutes said together, never guessed between two", () => {
    expect(["44 minutes, zone 2", "Bike 40 min to the beach", "1h 30m easy", "1 hour and 15 minutes, zone 2", "2 hours", "45min"].map(statedMinutes)).toEqual([44, 40, 90, 75, 120, 45]);
    expect(["Bench press: 20 kg x 8; 40 kg x 10", "20 min warm-up, 40 min ride", "5 km easy", ""].map(statedMinutes)).toEqual([null, null, null, null]);
  });

  it("is zone 2 when its words name zone 2 and no other zone", () => {
    expect(["44 minutes, zone 2", "Z2 spin", "zone two the whole way", "Zone 2 mostly."].map(saysZone2)).toEqual([true, true, true, true]);
    expect(["zone 2-3", "zone 2, then zone 4 intervals", "zone 3", "an easy ride", "zones 2 and 3"].map(saysZone2)).toEqual([false, false, false, false, false]);
  });

  it("is its sport's family by its category, gym none of the families", () => {
    expect(["bike", "cycling", "run", "trail run", "walk", "hike", "swim", "gym push", "yoga"].map(familyOf)).toEqual(["ride", "ride", "run", "run", "walk", "walk", "swim", "other", "other"]);
  });
});

describe("the made-up store's workouts, as the Fitness page is given them", () => {
  /** A Wednesday afternoon in Melbourne. */
  const NOW = Date.parse("2026-11-04T03:00:00Z");
  let view: RitualsView;

  beforeAll(async () => {
    view = await madeUpRitualsView(NOW);
  }, 60_000);

  it("are each day's, oldest first, in rituals' order, with rituals' title (else the category) and his words", () => {
    const days = workoutDays(view);
    expect(days.map((day) => day.day)).toEqual([...days.map((day) => day.day)].sort());
    expect(days.some((day) => day.workouts.length === 2)).toBe(true);
    expect(days.some((day) => day.workouts.some((w) => w.title !== w.type))).toBe(true);
    const logged = loggedWorkouts(view);
    expect(logged.map((w) => w.id)).toEqual(days.flatMap((day) => day.workouts.map((_, i) => `rituals-${day.day}-${i + 1}`)));
    // Two days before: the ride of 48 minutes, zone 2, which the Fitness page lays on the made-up Polar ride.
    expect(logged.find((w) => w.day === "2026-11-02")).toMatchObject({ family: "ride", log: { type: "bike", title: "Bike 48 min", minutes: 48, zone2: true } });
    // The day before: a gym session, no family, no minutes, his words whole.
    const gym = logged.find((w) => w.day === "2026-11-03")!;
    expect(gym).toMatchObject({ family: "other", log: { type: "gym push", minutes: null, zone2: false } });
    expect(gym.log.title.toLowerCase()).toBe("gym push");
    expect(gym.log.details).toContain("Bench press: 20 kg x 8");
  });
});
