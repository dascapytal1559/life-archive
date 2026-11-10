// The archive's own count of an activity's time in each heart-rate zone (zones.ts), on made-up data and made-up zones
// only: each sample its interval, a gap nothing; the zones exercise.json sets (settings.ts), or why there are none, read
// from the root's exercise.json while an archive keeps it there;
// and every activity counted by them where its trusted heart rate has samples, Polar's zones kept where it has none.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testingLifeArchive } from "../../../sdk/testing.ts";
import { FLOW_APP, MADE_UP_ZONES, madeUpExercise, RUNS_BY_HAND, TESTING_RUNS, writeMadeUpPolar } from "../fixtures/polar.ts";
import exercise from "../module.ts";
import { zoneSeconds, type ZoneSettings } from "../wire.ts";
import { copyReader, exerciseActivities } from "./activities.ts";
import { EXERCISE_SETTINGS, heartRateZones, writeExerciseSettings } from "./settings.ts";
import { exerciseTrack } from "./track.ts";
import { WorkoutIndex } from "./workoutIndex.ts";
import { heartRateTime, zonesOf } from "./zones.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-exercise-zones-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const STARTS = [MADE_UP_ZONES.zone2, MADE_UP_ZONES.zone3, MADE_UP_ZONES.zone4, MADE_UP_ZONES.zone5];

describe("the time at each heart rate", () => {
  it("gives each reading its stream's interval, and a gap in the stream nothing", () => {
    // A strap that dropped out for four readings (null, empty, 0, NaN) between 140s.
    const copy = { ...madeUpExercise("Zz01", TESTING_RUNS.latest), samples: [{ recording_rate: 2, sample_type: 0, data: "140,140,null,,0,NaN,141,90" }] };
    const track = exerciseTrack(copy);
    expect(track.heartRateEvery).toBe(2);
    expect(new Map(heartRateTime(track.heartRate, track.heartRateEvery))).toEqual(new Map([[140, 4], [141, 2], [90, 2]]));
    expect(heartRateTime(track.heartRate, 0)).toEqual([]);
  });
});

describe("the zones counted", () => {
  it("puts each heart rate in the zone whose start it has reached, zone 1 below zone 2's", () => {
    const time: Array<[number, number]> = [[STARTS[0] - 1, 60], [STARTS[0], 120], [STARTS[1] - 1, 60], [STARTS[2], 30], [STARTS[3] + 20, 30]];
    expect(zonesOf(time, STARTS)).toEqual([
      { zone: 1, share: 20, time: "1:00", from: null },
      { zone: 2, share: 60, time: "3:00", from: STARTS[0] },
      { zone: 3, share: 0, time: "0:00", from: STARTS[1] },
      { zone: 4, share: 10, time: "0:30", from: STARTS[2] },
      { zone: 5, share: 10, time: "0:30", from: STARTS[3] },
    ]);
    expect(zonesOf([], STARTS)).toEqual([]);
  });
});

describe("the zones exercise.json sets", () => {
  it("are where zones 2 to 5 start and where they came from, or why there are none", async () => {
    const dir = await mkdtemp(join(root, "settings-"));
    expect(await heartRateZones(dir)).toEqual({ starts: null, why: `no zones are set: put "heartRateZones" in the archive's ${EXERCISE_SETTINGS}` });
    await writeExerciseSettings(dir, JSON.stringify({ heartRateZones: MADE_UP_ZONES }));
    expect(await heartRateZones(dir)).toEqual({ starts: STARTS, source: MADE_UP_ZONES.source });
    const { source: _source, ...unsourced } = MADE_UP_ZONES;
    await writeExerciseSettings(dir, JSON.stringify({ heartRateZones: unsourced }));
    expect(await heartRateZones(dir)).toEqual({ starts: STARTS, source: EXERCISE_SETTINGS });
    const wrong = { starts: null, why: `${EXERCISE_SETTINGS}'s heartRateZones is not zone2, zone3, zone4, zone5 as rising heart rates above 0` };
    for (const zones of [{ ...MADE_UP_ZONES, zone4: MADE_UP_ZONES.zone3 }, { ...MADE_UP_ZONES, zone5: "160" }, { zone2: 110 }, [110, 120, 130, 140], "110"]) {
      await writeExerciseSettings(dir, JSON.stringify({ heartRateZones: zones }));
      expect(await heartRateZones(dir)).toEqual(wrong);
    }
    await writeExerciseSettings(dir, "{");
    expect(await heartRateZones(dir)).toEqual({ starts: null, why: `${EXERCISE_SETTINGS} is not JSON` });
  });

  it("are read from exercise.json at the archive's folder's root while it is still there, and from the module's folder once it is moved", async () => {
    const dir = await mkdtemp(join(root, "settings-moved-"));
    await writeFile(join(dir, "exercise.json"), JSON.stringify({ heartRateZones: { zone2: 100, zone3: 120, zone4: 140, zone5: 150 } }));
    expect(await heartRateZones(dir)).toEqual({ starts: [100, 120, 140, 150], source: "exercise.json" });
    // The module's folder with its database alone in it is no exercise.json: the old one is still read.
    await mkdir(join(dir, "modules", "exercise"), { recursive: true });
    await writeFile(join(dir, "modules", "exercise", "exercise.sqlite"), "");
    expect((await heartRateZones(dir)).starts).toEqual([100, 120, 140, 150]);
    await writeFile(join(dir, EXERCISE_SETTINGS), JSON.stringify({ heartRateZones: MADE_UP_ZONES }));
    expect(await heartRateZones(dir)).toEqual({ starts: STARTS, source: MADE_UP_ZONES.source });
    expect(exercise.moves).toEqual([{ from: "exercise.json", to: "exercise.json" }]);
  });
});

describe("every activity's zones", () => {
  it("are counted from its trusted samples by the zones set, Polar's kept where it has no samples or none are set", async () => {
    const dataDir = join(root, "activities");
    const life = await testingLifeArchive(dataDir, exercise);
    try {
      const { db } = life.module.context as { db: import("node:sqlite").DatabaseSync };
      await writeMadeUpPolar(db, dataDir);
      const sources = { byHand: RUNS_BY_HAND, workouts: new WorkoutIndex(db).all(), rules: { polar: [{ device: FLOW_APP, sensor: "Polar H10" }] }, read: copyReader(dataDir) };
      const zones: ZoneSettings = { starts: STARTS, source: MADE_UP_ZONES.source };
      const ours = (await exerciseActivities({ ...sources, zones })).map((b) => b.detail);
      const polars = (await exerciseActivities(sources)).map((b) => b.detail);

      // The latest run, through AccessLink: its seconds in each made-up zone, read off its own samples.
      const latest = ours.find((a) => a.start === TESTING_RUNS.latest.start.slice(0, 16))!;
      const hr = madeUpExercise("x", TESTING_RUNS.latest).samples![0].data!.split(",").map(Number);
      const inZone2 = hr.filter((bpm) => bpm >= STARTS[0] && bpm < STARTS[1]).length;
      expect(latest.zonesBy).toBe("archive");
      expect(latest.zones.map((z) => [z.zone, z.from])).toEqual([[1, null], [2, STARTS[0]], [3, STARTS[1]], [4, STARTS[2]], [5, STARTS[3]]]);
      expect(zoneSeconds(latest.zones[1].time)).toBe(inZone2);
      expect(latest.zone2).toEqual({ minutes: Math.round((inZone2 / 60) * 10) / 10, from: "heart-rate" });

      // With no zones set, the same run keeps Polar's own, and its zone 2 is theirs.
      const polar = polars.find((a) => a.id === latest.id)!;
      expect(polar.zonesBy).toBe("polar");
      expect(polar.zones.map((z) => z.from)).toEqual([95, 114, 133, 152, 171]);
      expect(polar.zone2!.minutes).not.toBe(latest.zone2!.minutes);

      // A run transcribed by hand has no samples: Polar's zones, whatever is set; a watch's heart rate, none.
      const byHand = ours.find((a) => a.id === "hand-202606031840")!;
      expect(byHand).toMatchObject({ zonesBy: "polar", zones: RUNS_BY_HAND[1].zones!.map((z) => ({ ...z, time: null, from: null })) });
      expect(ours.find((a) => a.start === TESTING_RUNS.watch.start.slice(0, 16))).toMatchObject({ zonesBy: null, zones: [] });
    } finally {
      life.close();
    }
  });
});
