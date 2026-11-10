// The exercise module's part of the static demo's build (module.ts's `demo`; the core's docs/demo.md): the Fitness
// page's answers over the made-up testing data, kept as the server gave them: the activities, each one's
// page and its playback in 3D, the pillars, and every tile, terrain tile and font range the maps answer for, each kept
// at its own path. The made-up runs loop in a small area (RUNS_AREA), whose map and terrain the build cuts first from
// the open builds a region's map comes from (extract.ts) into the made-up folder as sample-city's, the testing
// settings' region, so the activities are placed and played back over real open map data. With no network, there is
// no map, and the pages say so as the server does for an area not downloaded.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DemoRecorder } from "../../../sdk/server.ts";
import { RUNS_AREA } from "../fixtures/polar.ts";
import { ACTIVITIES_API, GLYPHS_URL, PILLARS_API, playbackUrl, terrainUrl, tilesUrl, type ExerciseAnswer } from "../wire.ts";
import { extractArea, tilesOver, type Box } from "./maps/extract.ts";
import { BUILDS_LIST_URL, BUILDS_URL, FONTS_URL, glyphFile, MAP_FONTS, MAX_ZOOM, regionFile, TERRAIN_URL, terrainFile } from "./maps/regions.ts";
import { mapStore } from "./maps/tiles.ts";

/** The testing settings' region, whose map the demo's area is kept as. */
const DEMO_REGION = "sample-city";

/** The terrain's highest zoom in the demo: about 20 m a pixel, enough for the playback's hills. */
const DEMO_TERRAIN_ZOOM = 12;

/** The font ranges the area's labels are drawn from: Latin, its extensions and punctuation. */
const DEMO_GLYPH_RANGES = ["0-255", "256-511", "512-767", "768-1023", "7680-7935", "8192-8447"];

/** Cuts the runs' area's map, terrain and fonts from the open builds into the made-up folder `folder`. */
async function cutDemoMaps(folder: string, log: (line: string) => void): Promise<void> {
  const builds = (await (await fetch(BUILDS_LIST_URL)).json()) as Array<{ key: string }>;
  const build = builds.at(-1)?.key;
  if (!build) throw new Error(`${BUILDS_LIST_URL} lists no builds`);
  const box: Box = RUNS_AREA;
  const tiles = await extractArea(`${BUILDS_URL}/${build}`, box, regionFile(folder, DEMO_REGION), { maxZoom: MAX_ZOOM, tileType: 1 });
  log(`the demo's map: ${tiles} tiles of OpenStreetMap's ${build}, over ${box.join(", ")}`);
  const terrain = await extractArea(TERRAIN_URL, box, terrainFile(folder, DEMO_REGION), { maxZoom: DEMO_TERRAIN_ZOOM, tileType: 4 });
  log(`the demo's terrain: ${terrain} tiles of Mapterhorn's`);
  for (const font of MAP_FONTS) {
    for (const range of DEMO_GLYPH_RANGES) {
      const response = await fetch(`${FONTS_URL}/${encodeURIComponent(font)}/${range}.pbf`);
      if (!response.ok) continue;
      const file = glyphFile(folder, font, range);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, new Uint8Array(await response.arrayBuffer()));
    }
  }
}

/** Every tile `url` (a {z}/{x}/{y} template) answers over `box` to `maxZoom`, kept at its own path. */
async function recordTiles(recorder: DemoRecorder, url: string, box: Box, maxZoom: number): Promise<number> {
  const asked: Array<Promise<boolean>> = [];
  for (let z = 0; z <= maxZoom; z++) {
    const { x, y } = tilesOver(box, z);
    for (let tx = x[0]; tx <= x[1]; tx++) {
      for (let ty = y[0]; ty <= y[1]; ty++) asked.push(recorder.file(url.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty))));
    }
  }
  return (await Promise.all(asked)).filter(Boolean).length;
}

/** Asks `recorder` what the Fitness page asks (see the top). */
export async function recordExercise(recorder: DemoRecorder, log: (line: string) => void = console.log): Promise<void> {
  if (recorder.network) await cutDemoMaps(recorder.folder, log);
  const { activities } = await recorder.json<ExerciseAnswer>(ACTIVITIES_API);
  await recorder.json(PILLARS_API);
  await Promise.all(activities.map(async ({ id }) => {
    await recorder.json(`${ACTIVITIES_API}/${encodeURIComponent(id)}`);
    await recorder.json(playbackUrl(id));
  }));
  const maps = mapStore(recorder.folder);
  try {
    for (const region of await maps.regions()) {
      await recordTiles(recorder, tilesUrl(region.region), region.bbox, region.maxZoom);
      const terrain = await maps.terrain(region.region);
      if (terrain) await recordTiles(recorder, terrainUrl(region.region), terrain.bbox, terrain.maxZoom);
    }
  } finally {
    await maps.close();
  }
  for (const font of MAP_FONTS) {
    for (const range of DEMO_GLYPH_RANGES) {
      const [from, to] = range.split("-");
      await recorder.file(GLYPHS_URL.replace("{fontstack}", encodeURIComponent(font)).replace("{range}", `${from}-${to}`));
    }
  }
}
