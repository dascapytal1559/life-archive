// The Fitness page's activities, on made-up copies only (../fixtures/polar.ts, modules/health/fixtures/health.ts): a copy's track in
// either of Polar's shapes and what is worked out from it (moving time, splits, heart rate over time, the route's
// shape with no coordinate in it); every source's copies made one activity each, the heart rate shown only where it is
// trusted, the Health tab's highest heart rate from them; a route's corner given only to lay it on a map kept here (a
// made-up one, ../fixtures/pmtiles.ts); and the routes, which only read and only for the page itself.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Exercise, Layer, RunsByHand } from "../../../sdk/server.ts";
import { testingLifeArchive, type TestingLifeArchive } from "../../../sdk/testing.ts";
import { FLOW_APP, madeUpExercise, madeUpSession, RUNS_BY_HAND, TESTING_RUNS, writeMadeUpPolar } from "../fixtures/polar.ts";
import { writeMadeUpPmtiles } from "../fixtures/pmtiles.ts";
import exercise from "../module.ts";
import type { ActivityDetail, ExerciseAnswer } from "../wire.ts";
import { copyReader, exerciseActivities, peakOf, titleOf, type Built } from "./activities.ts";
import { createExerciseApi } from "./http.ts";
import { regionFile } from "./maps/regions.ts";
import { exerciseLayer, ExerciseReads } from "./service.ts";
import { distanceOverTime, exerciseTrack, heartRateSeries, movingSeconds, sessionTrack, shapeOf, splitsOf, type Timed } from "./track.ts";
import { WorkoutIndex } from "./workoutIndex.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-exercise-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a copy's track", () => {
  const run = TESTING_RUNS.october;

  it("reads AccessLink's samples and route, in Polar's spelling or its documentation's", () => {
    const exercise = madeUpExercise("Ab12Cd", run);
    const track = exerciseTrack(exercise);
    expect(track.heartRate).toHaveLength(35 * 60);
    expect(track.distance.at(-1)).toMatchObject({ t: 35 * 60 - 1 });
    expect(track.route).toHaveLength(35 * 60);
    expect(track.route[10].t).toBe(10);
    const dashed = { ...exercise, samples: exercise.samples!.map((s) => ({ "recording-rate": s.recording_rate, "sample-type": String(s.sample_type), data: s.data })) };
    expect(exerciseTrack(dashed)).toEqual(track);
  });

  it("reads the export's samples and route, a sensor's gap left out at its time", () => {
    const track = sessionTrack(madeUpSession("7000000002", run), "export/7000000002");
    expect(track.heartRate).toHaveLength(35 * 60);
    expect(track.route[0].t).toBe(0);
    expect(track.heartRateEvery).toBe(1);
    expect(sessionTrack(madeUpSession("7000000002", run), "export/1")).toEqual({ heartRate: [], heartRateEvery: 0, distance: [], altitude: [], route: [] });
  });

  it("adds the distance up along the route when the copy has no distance samples", () => {
    const route = [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: 30 }, { lat: 0, lon: 0.002, t: 60 }, { lat: 0, lon: 0.002, t: null }];
    const distance = distanceOverTime({ distance: [], route });
    expect(distance.map((d) => d.t)).toEqual([0, 30, 60]);
    // A thousandth of a degree of longitude at the equator is about 111 m.
    expect(distance[2].v).toBeCloseTo(222.4, 0);
  });

  it("counts the time moving: a stop, and a gap in the recording, are not", () => {
    const steady = (from: number, to: number, start: number, speed: number): Timed[] => Array.from({ length: to - from }, (_, i) => ({ t: from + i, v: start + i * speed }));
    // 100 s running at 3 m/s, 50 s stood still, then a 60 s gap, then 40 s more.
    const distance = [...steady(0, 100, 0, 3), ...steady(100, 150, 297, 0), ...steady(210, 250, 297, 3)];
    expect(movingSeconds(distance, "run")).toBe(99 + 39);
    // A walk at 0.4 m/s is moving on foot, a stop on a bike.
    expect(movingSeconds(steady(0, 11, 0, 0.4), "walk")).toBe(10);
    expect(movingSeconds(steady(0, 11, 0, 0.4), "ride")).toBe(0);
    expect(movingSeconds([], "run")).toBeNull();
  });

  it("splits a kilometre at a time, the last what is left, each with its moving time and heart rate", () => {
    // 2.5 km at 4 m/s: 250 s a kilometre, the heart rate 140 in the first, 150 in the second, 160 after.
    const distance = Array.from({ length: 626 }, (_, t) => ({ t, v: t * 4 }));
    const heartRate = distance.map(({ t }) => ({ t, v: t < 250 ? 140 : t < 500 ? 150 : 160 }));
    expect(splitsOf(distance, heartRate, "run")).toEqual([
      { distanceM: 1000, seconds: 250, heartRate: 140 },
      { distanceM: 1000, seconds: 250, heartRate: 150 },
      { distanceM: 500, seconds: 125, heartRate: 160 },
    ]);
    expect(splitsOf(distance, [], "run").map((s) => s.heartRate)).toEqual([null, null, null]);
    // A few steps past the last kilometre are no split of their own.
    expect(splitsOf(distance.slice(0, 262), [], "run")).toHaveLength(1);
  });

  it("thins the heart rate for a chart, each point its stretch's average", () => {
    const heartRate = Array.from({ length: 1000 }, (_, t) => ({ t, v: t % 2 === 0 ? 140 : 150 }));
    const series = heartRateSeries(heartRate, 100);
    expect(series).toHaveLength(100);
    expect(series[0]).toEqual([5, 145]);
  });

  it("gives the route as a shape in metres from its south-west corner, never a coordinate", () => {
    const track = exerciseTrack(madeUpExercise("Ab12Cd", run));
    const shape = shapeOf(track.route, 0.002)!;
    // A loop about a hundredth of a degree across each way: two kilometres and more.
    expect(shape.width).toBeGreaterThan(1500);
    expect(shape.height).toBeGreaterThan(1500);
    expect(shape.points.length).toBeLessThan(track.route.length / 4);
    expect(shape.points.every(([x, y]) => x >= 0 && y >= 0 && x <= shape.width && y <= shape.height && Number.isInteger(x))).toBe(true);
    // Its corner is the route's own, which thinning may leave a point short of.
    expect(Math.min(...shape.points.map((p) => p[0]))).toBeLessThan(shape.width * 0.01);
    expect(shapeOf(track.route.slice(0, 1), 0.002)).toBeNull();
  });
});

describe("the activities, from every source", () => {
  it("shows each activity once, from the copy with the most detail, its heart rate only where trusted", async () => {
    const dataDir = join(root, "activities");
    const life = await testingLifeArchive(dataDir, exercise);
    try {
      const { db } = life.module.context as { db: import("node:sqlite").DatabaseSync };
      await writeMadeUpPolar(db, dataDir);
      const workouts = new WorkoutIndex(db).all();
      const rules = { polar: [{ device: FLOW_APP, sensor: "Polar H10" }] };
      const byHand = RUNS_BY_HAND;
      const built = await exerciseActivities({ byHand, workouts, rules, read: copyReader(dataDir) });
      const shown = built.map((b) => b.detail);
      expect(shown.map((a) => [a.start, a.source, a.alsoIn, a.heartRate?.sensor ?? a.heartRateNote])).toEqual([
        ["2026-10-15T17:30", "Polar Flow", [], "Polar H10"],
        ["2026-10-14T06:50", "Polar Flow", ["Polar Flow's account export"], "Polar H10"],
        // A watch's heart rate is never trusted: the activity is shown, its heart rate not.
        ["2026-10-10T07:00", "Polar Flow", [], "Heart rate not shown: not from a recorder you trust"],
        ["2026-06-05T06:30", "Polar Flow's share page, by hand", [], "Heart rate not shown: not from a recorder you trust"],
        ["2026-06-03T18:40", "Polar Flow's share page, by hand", [], "Polar H10"],
        // Sample by sample beats the summary transcribed by hand.
        ["2026-05-20T07:15", "Polar Flow's account export", ["Polar Flow's share page, by hand"], "Polar H10"],
      ]);

      const october = shown[1];
      expect(october).toMatchObject({ title: "Morning Run", sport: "Running", family: "run", distanceM: 5800, elapsedS: 2100, recorder: FLOW_APP, link: null });
      expect(october.movingS).toBeGreaterThan(2090);
      // The last, what the samples reach past 5 km (the copy's last sample is a second before its end).
      expect(october.splits.map((s) => s.distanceM)).toEqual([1000, 1000, 1000, 1000, 1000, 797]);
      expect(october.splits.every((s) => s.heartRate !== null)).toBe(true);
      expect(october.zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
      expect(october.heartRateSeries.length).toBeGreaterThan(100);
      expect(october.route!.points.length).toBeGreaterThan(october.thumb!.points.length);

      // The watch's: its route and splits, never its heart rate, not even a split's.
      const watch = shown[2];
      expect(watch).toMatchObject({ heartRate: null, heartRateSeries: [], zones: [], minHeartRate: null });
      expect(watch.splits.length).toBeGreaterThan(0);
      expect(watch.splits.every((s) => s.heartRate === null)).toBe(true);
      expect(watch.route).not.toBeNull();

      // By hand: its summary and Polar's page, no route.
      expect(shown[4]).toMatchObject({ id: "hand-202606031840", route: null, splits: [], link: "https://example.com/shared/run-two", heartRate: { average: 148, maximum: 172 } });

      // No coordinate leaves: the shapes are in metres.
      expect(JSON.stringify(shown)).not.toMatch(/lat|lon/);

      // The highest trusted heart rate, never the watch's 196.
      expect(peakOf(built)).toMatchObject({ bpm: expect.any(Number), sensor: "Polar H10" });
      expect(peakOf(built)!.bpm).toBeLessThan(196);

      // Until the captain trusts Polar's heart rate, every Polar copy is shown without it; the runs by hand keep theirs.
      const untrusted = (await exerciseActivities({ byHand, workouts, rules: {}, read: copyReader(dataDir) })).map((b) => b.detail);
      expect(untrusted.map((a) => [a.start, a.source, a.heartRate === null])).toEqual([
        ["2026-10-15T17:30", "Polar Flow", true],
        ["2026-10-14T06:50", "Polar Flow", true],
        ["2026-10-10T07:00", "Polar Flow", true],
        ["2026-06-05T06:30", "Polar Flow's share page, by hand", true],
        ["2026-06-03T18:40", "Polar Flow's share page, by hand", false],
        // The trusted summary by hand now leads; the route still comes from the export's copy.
        ["2026-05-20T07:15", "Polar Flow's share page, by hand", false],
      ]);
      expect(untrusted[5].route).not.toBeNull();
      expect(untrusted[5].splits.every((s) => s.heartRate === null)).toBe(true);
    } finally {
      life.close();
    }
  });

  it("names each by the part of the day it started in and its sport", () => {
    expect(["03:59", "04:00", "10:59", "11:00", "14:00", "17:00", "21:00"].map((t) => titleOf(`2026-10-14T${t}`, "run", "Running"))).toEqual([
      "Night Run", "Morning Run", "Morning Run", "Lunch Run", "Afternoon Run", "Evening Run", "Night Run",
    ]);
    expect(titleOf("2026-10-14T18:00", "ride", "Cycling")).toBe("Evening Ride");
    expect(titleOf("2026-10-14T18:00", "other", "Strength training")).toBe("Evening Strength training");
  });
});

describe("the routes", () => {
  let dataDir: string;
  let life: TestingLifeArchive;
  let url: string;
  let close: () => void;
  beforeAll(async () => {
    dataDir = join(root, "route");
    life = await testingLifeArchive(dataDir, exercise);
    await writeMadeUpPolar((life.module.context as { db: import("node:sqlite").DatabaseSync }).db, dataDir);
    const now = () => Date.parse("2026-10-16T01:00:00Z");
    const server = createServer(createExerciseApi(life.module.context as Parameters<typeof createExerciseApi>[0], { now, byHand: RUNS_BY_HAND }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise`;
    close = () => {
      server.close();
      life.close();
    };
  });
  afterAll(() => close());

  it("sees the runs by hand a module offers, asked for at each read, and without one every other source's, none deletable", async () => {
    const { folder, db } = life.module.context as { folder: string; db: import("node:sqlite").DatabaseSync };
    const activities = (offered: Layer.Layer<never>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ExerciseReads).activities;
        }).pipe(Effect.provide(Layer.merge(exerciseLayer(folder, db), offered)), Effect.scoped),
      );
    const starts = (built: readonly Built[]) => built.map((b) => b.detail.start);
    const handOnly = RUNS_BY_HAND.map((run) => run.start).filter((start) => start !== TESTING_RUNS.may.start.slice(0, 16));

    const withHealth = await activities(Layer.succeed(RunsByHand, { runs: Effect.succeed(RUNS_BY_HAND) }));
    expect(starts(withHealth)).toEqual(expect.arrayContaining(RUNS_BY_HAND.map((run) => run.start)));
    expect(withHealth.find((b) => b.detail.start === TESTING_RUNS.october.start.slice(0, 16))!.detail.cannotDelete).toBeNull();

    const withoutHealth = await activities(Layer.empty);
    expect(starts(withoutHealth)).toEqual(starts(withHealth).filter((start) => !handOnly.includes(start)));
    for (const { detail } of withoutHealth) expect(detail.cannotDelete).toBe("It cannot be deleted now, as not every copy of it can be known: the health module is off.");
  });

  it("answers every activity as its card, and one in full by its id", async () => {
    const res = await fetch(`${url}/activities`);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ExerciseAnswer;
    expect(answer.today).toBe("2026-10-16");
    expect(answer.activities).toHaveLength(6);
    expect(answer.activities[0]).not.toHaveProperty("route");
    expect(answer.activities[0]).not.toHaveProperty("splits");
    expect(answer.activities[0].thumb).not.toBeNull();
    // Each card's time in zones, for its zone line: the trusted chest strap's, never the watch's.
    expect(answer.activities[1].zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(answer.activities[2]).toMatchObject({ heartRate: null, zones: [] });

    const one = (await (await fetch(`${url}/activities/${answer.activities[1].id}`)).json()) as ActivityDetail;
    expect(one).toMatchObject({ id: answer.activities[1].id, start: "2026-10-14T06:50" });
    expect(one.splits).toHaveLength(6);
    const hand = await fetch(`${url}/activities/hand-202606031840`);
    expect(hand.status).toBe(200);
    const missing = await fetch(`${url}/activities/999999`);
    expect(missing.status).toBe(404);
    expect((await fetch(`${url}/elsewhere`)).status).toBe(404);
  });

  it("lays a route on a map kept here that holds it, and tells the page nothing of where one with no map is", async () => {
    const before = (await (await fetch(`${url}/activities`)).json()) as ExerciseAnswer;
    expect(before.activities.filter((a) => a.thumb).every((a) => a.map === null)).toBe(true);
    // A made-up map around 0°, 0°, where the made-up runs loop.
    const file = regionFile(dataDir, "made-up");
    await writeMadeUpPmtiles(file, { bbox: [-0.5, -0.5, 0.5, 0.5], maxZoom: 14, tiles: [] });
    try {
      const after = (await (await fetch(`${url}/activities`)).json()) as ExerciseAnswer;
      const routed = after.activities.filter((a) => a.thumb);
      expect(routed.length).toBeGreaterThan(0);
      for (const activity of routed) expect(activity.map).toMatchObject({ region: "made-up", maxZoom: 14, south: expect.any(Number), west: expect.any(Number) });
      expect(after.activities.filter((a) => !a.thumb).every((a) => a.map === null)).toBe(true);
      const one = (await (await fetch(`${url}/activities/${routed[0].id}`)).json()) as ActivityDetail;
      expect(one.map).toEqual(routed[0].map);
      // The map itself, from the same route.
      expect((await fetch(`${url}/map/made-up/0/0/0.mvt`)).status).toBe(204);
    } finally {
      await rm(file);
    }
  });

  it("refuses another site's page and a write", async () => {
    expect((await fetch(`${url}/activities`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${url}/activities`, { method: "POST" })).status).toBe(405);
  });

  it("gives a module that asks (the Health tab) the highest trusted heart rate alone, naming its activity and its page here", async () => {
    const { folder, db } = life.module.context as { folder: string; db: import("node:sqlite").DatabaseSync };
    const peak = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Exercise).peak;
      }).pipe(Effect.provide(Layer.merge(exerciseLayer(folder, db), Layer.succeed(RunsByHand, { runs: Effect.succeed(RUNS_BY_HAND) }))), Effect.scoped),
    );
    expect(peak).toMatchObject({ sensor: "Polar H10", recorder: FLOW_APP, source: expect.stringMatching(/^Polar Flow/) });
    expect(peak).not.toHaveProperty("page");
    expect(peak).not.toHaveProperty("runs");
    const answer = (await (await fetch(`${url}/activities`)).json()) as ExerciseAnswer;
    expect(answer.activities.map((a) => a.id)).toContain(peak!.activity);
  });
});
