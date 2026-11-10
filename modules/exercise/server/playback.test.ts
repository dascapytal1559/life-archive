// An activity's playback (playback.ts) on the made-up workouts (../fixtures/polar.ts, looping around 0°, 0°): told the
// page only for a route inside a map kept here, its heart rate only when trusted, the terrain and the photorealistic
// city's credentials when there are; and CesiumJS's build served from this server alone (cesium.ts).

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testingLifeArchive, type TestingLifeArchive } from "../../../sdk/testing.ts";
import { RUNS_BY_HAND, TESTING_RUNS, writeMadeUpPolar } from "../fixtures/polar.ts";
import { writeMadeUpPmtiles } from "../fixtures/pmtiles.ts";
import exercise from "../module.ts";
import { CESIUM_URL, type ActivityDetail, type ExerciseAnswer, type PlaybackTrack } from "../wire.ts";
import { cesiumFile } from "./cesium.ts";
import { createExerciseApi } from "./http.ts";
import { regionFile, terrainFile } from "./maps/regions.ts";
import { NO_PLAYBACK, photorealSetting, playbackTrack, valueAt } from "./playback.ts";
import { NO_TRACK } from "./track.ts";

const BOX: [number, number, number, number] = [-0.5, -0.5, 0.5, 0.5];

describe("reading a stream at a time", () => {
  const series = [{ t: 0, v: 10 }, { t: 10, v: 20 }, { t: 20, v: 0 }];
  it("reads between two readings, and holds an end only so far", () => {
    expect(valueAt(series, 5)).toBe(15);
    expect(valueAt(series, 15)).toBe(10);
    expect(valueAt(series, -10)).toBe(10);
    expect(valueAt(series, 49)).toBe(0);
    expect(valueAt(series, 51)).toBeNull();
    expect(valueAt([], 3)).toBeNull();
  });
});

describe("the photorealistic city's credentials", () => {
  const from = (values: Record<string, string>) => (key: string) => values[key];
  it("takes Cesium ion's token first, else a Google key, else none; blank is none", () => {
    expect(photorealSetting(from({ CESIUM_ION_TOKEN: "made-up-token", GOOGLE_MAPS_API_KEY: "made-up-key" }))).toEqual({ via: "cesium-ion", token: "made-up-token" });
    expect(photorealSetting(from({ CESIUM_ION_TOKEN: "  ", GOOGLE_MAPS_API_KEY: "made-up-key" }))).toEqual({ via: "google", key: "made-up-key" });
    expect(photorealSetting(from({}))).toBeNull();
  });
});

describe("a playback from a track", () => {
  const detail = { id: "1", title: "Test ride", start: "2026-10-14T06:50", family: "ride", heartRate: { average: 120, maximum: 150, sensor: null }, zones: [{ zone: 2, share: 50, time: null, from: 110 }, { zone: 1, share: 50, time: null, from: 90 }], map: { region: "made-up", maxZoom: 14, south: 0, west: 0 } } as unknown as ActivityDetail;
  const route = [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: null }, { lat: 0, lon: 0.002, t: 20 }, { lat: 0, lon: 0.001, t: 10 }];
  const track = { ...NO_TRACK, route, heartRate: [{ t: 0, v: 100 }, { t: 10, v: 120 }] };

  it("takes the route's timed points in order, its distance along it, and the trusted heart rate moved to the route's start", () => {
    const played = playbackTrack(detail, track, { heart: track, heartShiftS: 5, terrain: null, photoreal: null })!;
    expect(played.points.t).toEqual([0, 10, 20]);
    expect(played.points.lon).toEqual([0, 0.001, 0.002]);
    // A thousandth of a degree of longitude at the equator is about 111 m.
    expect(played.points.distance[2]).toBeCloseTo(222.4, 0);
    expect(played.points.altitude).toBeNull();
    expect(played.heartRate).toEqual([[5, 100], [15, 120]]);
    expect(played.zones).toEqual([{ zone: 1, from: 90 }, { zone: 2, from: 110 }]);
  });

  it("starts zone 1 from nothing, as the archive's own zones count it, so a heart rate below zone 2 is zone 1", () => {
    const archiveZones = [{ zone: 1, share: 40, time: "4:00", from: null }, { zone: 2, share: 60, time: "6:00", from: 110 }];
    const played = playbackTrack({ ...detail, zones: archiveZones, zonesBy: "archive" } as ActivityDetail, track, { heart: track, terrain: null, photoreal: null })!;
    expect(played.zones).toEqual([{ zone: 1, from: 0 }, { zone: 2, from: 110 }]);
  });

  it("sends no heart rate without a trusted copy's, nor for an activity whose heart rate is not trusted", () => {
    expect(playbackTrack(detail, track, { heart: null, terrain: null, photoreal: null })!.heartRate).toBeNull();
    expect(playbackTrack({ ...detail, heartRate: null }, track, { heart: track, terrain: null, photoreal: null })!.heartRate).toBeNull();
  });

  it("has none without a map kept here, or with under two timed points", () => {
    expect(playbackTrack({ ...detail, map: null }, track, { heart: track, terrain: null, photoreal: null })).toBeNull();
    expect(playbackTrack(detail, { ...track, route: route.slice(0, 2) }, { heart: track, terrain: null, photoreal: null })).toBeNull();
  });
});

describe("the playback's route", () => {
  let root: string;
  let life: TestingLifeArchive;
  let url: string;
  let close: () => void;
  let activities: ExerciseAnswer["activities"];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "life-archive-playback-"));
    life = await testingLifeArchive(root, exercise);
    await writeMadeUpPolar((life.module.context as { db: import("node:sqlite").DatabaseSync }).db, root);
    const handler = createExerciseApi(life.module.context as Parameters<typeof createExerciseApi>[0], { byHand: RUNS_BY_HAND, photoreal: { via: "cesium-ion", token: "made-up-token" } });
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/m/exercise`;
    activities = ((await (await fetch(`${url}/activities`)).json()) as ExerciseAnswer).activities;
    close = () => {
      server.close();
      life.close();
    };
  });
  afterAll(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  const idOf = (start: string) => activities.find((a) => a.start === start.slice(0, 16))!.id;
  const play = (id: string) => fetch(`${url}/activities/${encodeURIComponent(id)}/playback`);

  it("tells the page nothing of where a route is with no map kept here", async () => {
    const res = await play(idOf(TESTING_RUNS.october.start));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NO_PLAYBACK.map });
  });

  it("answers a route inside a map kept here whole, with its trusted heart rate, the terrain and the city's credentials", async () => {
    await writeMadeUpPmtiles(regionFile(root, "made-up"), { bbox: BOX, maxZoom: 14, tiles: [] });
    await writeMadeUpPmtiles(terrainFile(root, "made-up"), { bbox: BOX, maxZoom: 12, tiles: [] });
    const res = await play(idOf(TESTING_RUNS.october.start));
    expect(res.status).toBe(200);
    const played = (await res.json()) as PlaybackTrack;
    const seconds = TESTING_RUNS.october.minutes * 60;
    expect(played.points.t).toHaveLength(seconds);
    expect(played.points.distance.at(-1)).toBeCloseTo(TESTING_RUNS.october.km * 1000, -1);
    expect(played.heartRate).toHaveLength(seconds);
    expect(played.zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(played).toMatchObject({ map: { region: "made-up" }, terrain: { maxZoom: 12, bbox: BOX }, photoreal: { via: "cesium-ion", token: "made-up-token" } });

    // A watch's heart rate is never trusted, so its playback has none.
    const watch = (await (await play(idOf(TESTING_RUNS.watch.start))).json()) as PlaybackTrack;
    expect(watch.heartRate).toBeNull();
    expect(watch.zones).toEqual([]);
  });

  it("has none for a run transcribed by hand, which has no route; and is only read", async () => {
    const res = await play("hand-202606031840");
    expect(res.status).toBe(409);
    expect((await fetch(`${url}/activities/${idOf(TESTING_RUNS.october.start)}/playback`, { method: "DELETE", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" })).status).toBe(405);
    expect((await play("999999")).status).toBe(404);
  });

  it("serves CesiumJS's build from this server, nothing outside it, and only to the page itself", async () => {
    const res = await fetch(`${url}/cesium/Cesium.js`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect((await fetch(`${url}/cesium/Widgets/widgets.css`, { method: "HEAD" })).headers.get("content-type")).toBe("text/css");
    expect((await fetch(`${url}/cesium/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${url}/cesium/Cesium.js`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(await cesiumFile("../../package.json")).toBeNull();
    expect(await cesiumFile("")).toBeNull();
    expect(CESIUM_URL).toBe("/life-archive/api/m/exercise/cesium/");
  });
});
