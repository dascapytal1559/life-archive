// The maps kept on this Mac, on a made-up map (../../fixtures/pmtiles.ts): which are here and what each covers, a tile of
// one, the routes that serve tiles and fonts only to the page itself, and the download's command for a region.

import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context, serve } from "../../../../sdk/server.ts";
import { writeMadeUpPmtiles } from "../../fixtures/pmtiles.ts";
import { MAP_API } from "../../wire.ts";
import { placeOf } from "../activities.ts";
import { extractArgs, terrainArgs } from "./download.ts";
import { mapRoute } from "./http.ts";
import { glyphFile, regionFile, regions, terrainFile } from "./regions.ts";
import { Maps, mapStore, regionHolding, type MapRegion } from "./tiles.ts";

const TILE = new Uint8Array([1, 2, 3, 4, 5]);
/** A made-up terrain tile's bytes (a real one is a Terrarium WebP). */
const GROUND = new Uint8Array([8, 6, 4]);
/** A made-up map's box, around 0°, 0° (where the made-up workouts loop). */
const BOX: [number, number, number, number] = [-0.5, -0.5, 0.5, 0.5];

let archive: string;
beforeAll(async () => {
  archive = await mkdtemp(join(tmpdir(), "life-archive-maps-"));
  await writeMadeUpPmtiles(regionFile(archive, "made-up"), { bbox: BOX, maxZoom: 14, tiles: [{ z: 0, x: 0, y: 0, bytes: TILE }, { z: 14, x: 8192, y: 8191, bytes: new Uint8Array([9]) }] });
  await writeMadeUpPmtiles(terrainFile(archive, "made-up"), { bbox: BOX, maxZoom: 12, tiles: [{ z: 0, x: 0, y: 0, bytes: GROUND }] });
  await mkdir(join(archive, "maps", "fonts", "Noto Sans Regular"), { recursive: true });
  await writeFile(glyphFile(archive, "Noto Sans Regular", "0-255"), Buffer.from([7, 7]));
});
afterAll(async () => {
  await rm(archive, { recursive: true, force: true });
});

describe("the maps kept here", () => {
  it("lists each map with the box it covers, and reads its tiles", async () => {
    const store = mapStore(archive);
    expect(await store.regions()).toEqual([{ region: "made-up", bbox: BOX, maxZoom: 14 }]);
    expect(await store.tile("made-up", 0, 0, 0)).toEqual(TILE);
    expect(await store.tile("made-up", 14, 8192, 8191)).toEqual(new Uint8Array([9]));
    expect(await store.tile("made-up", 1, 0, 0)).toBeNull();
    expect(await store.tile("made-up", 15, 0, 0)).toBeNull();
    expect(await store.tile("elsewhere", 0, 0, 0)).toBeNull();
    expect(await store.tile("../made-up", 0, 0, 0)).toBeNull();
    await store.close();
  });

  it("reads a region's terrain beside its map, and is not misled into listing it as a map", async () => {
    const store = mapStore(archive);
    expect(await store.terrain("made-up")).toEqual({ maxZoom: 12, bbox: BOX });
    expect(await store.terrainTile("made-up", 0, 0, 0)).toEqual(GROUND);
    expect(await store.terrainTile("made-up", 13, 0, 0)).toBeNull();
    expect(await store.terrain("elsewhere")).toBeNull();
    expect(await store.terrain("../made-up")).toBeNull();
    expect((await store.regions()).map((r) => r.region)).toEqual(["made-up"]);
    await store.close();
  });

  it("opens a map downloaded again afresh", async () => {
    const file = regionFile(archive, "again");
    await writeMadeUpPmtiles(file, { bbox: BOX, maxZoom: 3, tiles: [{ z: 0, x: 0, y: 0, bytes: new Uint8Array([1]) }] });
    const store = mapStore(archive);
    expect(await store.tile("again", 0, 0, 0)).toEqual(new Uint8Array([1]));
    await writeMadeUpPmtiles(file, { bbox: BOX, maxZoom: 3, tiles: [{ z: 0, x: 0, y: 0, bytes: new Uint8Array([2, 2]) }] });
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(await store.tile("again", 0, 0, 0)).toEqual(new Uint8Array([2, 2]));
    await store.close();
    await rm(file);
  });

  it("lays a route on the first map that holds all of it, and on none that holds only part", () => {
    const maps: MapRegion[] = [{ region: "made-up", bbox: BOX, maxZoom: 14 }];
    const inside = { south: -0.01, west: -0.02, north: 0.01, east: 0.02 };
    expect(regionHolding(maps, inside)?.region).toBe("made-up");
    expect(regionHolding(maps, { ...inside, east: 0.6 })).toBeNull();
    expect(placeOf(inside, maps)).toEqual({ region: "made-up", maxZoom: 14, south: -0.01, west: -0.02 });
    expect(placeOf(inside, [])).toBeNull();
    expect(placeOf(null, maps)).toBeNull();
  });
});

describe("the maps' routes", () => {
  let url: string;
  let close: () => void;
  beforeAll(async () => {
    const store = mapStore(archive);
    const handler = serve(Context.make(Maps, store), mapRoute(archive));
    const server = createServer((req, res) => void handler(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${MAP_API}`;
    close = () => {
      server.close();
      void store.close();
    };
  });
  afterAll(() => close());

  it("serves a tile as a vector tile, and none as 204", async () => {
    const res = await fetch(`${url}/made-up/0/0/0.mvt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TILE);
    expect((await fetch(`${url}/made-up/1/1/1.mvt`)).status).toBe(204);
    expect((await fetch(`${url}/not-downloaded/0/0/0.mvt`)).status).toBe(204);
  });

  it("serves a terrain tile as WebP, and none as 204", async () => {
    const res = await fetch(`${url}/terrain/made-up/0/0/0.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GROUND);
    expect((await fetch(`${url}/terrain/made-up/5/1/1.webp`)).status).toBe(204);
    expect((await fetch(`${url}/terrain/not-downloaded/0/0/0.webp`)).status).toBe(204);
    expect((await fetch(`${url}/terrain/..%2Fmade-up/0/0/0.webp`)).status).toBe(404);
  });

  it("serves the fonts' glyphs, and no file outside them", async () => {
    const res = await fetch(`${url}/fonts/Noto%20Sans%20Regular/0-255.pbf`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
    expect((await fetch(`${url}/fonts/Noto%20Sans%20Regular/256-511.pbf`)).status).toBe(204);
    expect((await fetch(`${url}/fonts/Comic%20Sans/0-255.pbf`)).status).toBe(404);
    expect((await fetch(`${url}/fonts/..%2F..%2F..%2Fmade-up/0-255.pbf`)).status).toBe(404);
    expect((await fetch(`${url}/..%2Fmaps%2Fmade-up/0/0/0.mvt`)).status).toBe(404);
    expect((await fetch(`${url}/made-up.pmtiles`)).status).toBe(404);
  });

  it("refuses another site's page and a write", async () => {
    expect((await fetch(`${url}/made-up/0/0/0.mvt`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${url}/made-up/0/0/0.mvt`, { method: "POST" })).status).toBe(405);
  });
});

describe("downloading a region", () => {
  it("cuts a region's box from the build, to zoom 15", () => {
    expect(extractArgs("20261102.pmtiles", regions()["sample-city"], "/tmp/out.pmtiles")).toEqual([
      "extract",
      "https://build.protomaps.com/20261102.pmtiles",
      "/tmp/out.pmtiles",
      "--bbox=10,50,11,51",
      "--maxzoom=15",
      "--download-threads=4",
    ]);
  });

  it("cuts a region's terrain from Mapterhorn's whole earth, every zoom it has", () => {
    expect(terrainArgs(regions()["sample-city"], "/tmp/ground.pmtiles")).toEqual([
      "extract",
      "https://download.mapterhorn.com/planet.pmtiles",
      "/tmp/ground.pmtiles",
      "--bbox=10,50,11,51",
      "--download-threads=4",
    ]);
  });
});

describe("npm run map -- list", () => {
  it("says which maps are here, and what the fonts and the maps' folder hold, and exits well", async () => {
    const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", cli, "map", "list"], { env: { ...process.env, LIFE_ARCHIVE_DATA: archive } });
    expect(stdout).toContain("made-up  (not in the settings)  covering -0.5, -0.5, 0.5, 0.5");
    expect(stdout).toMatch(/^fonts: 0\.0 MB; the maps' folder, .*: \d+\.\d MB$/m);
  }, 30_000);
});
