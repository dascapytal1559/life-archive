// A small area's map and terrain, cut from the open builds `npm run map -- download` cuts a region from (regions.ts:
// Protomaps' daily OpenStreetMap build, Mapterhorn's terrain), in this process: each tile in the area read from the
// build where it lies (a range request each, through the pmtiles package), and written as a PMTiles file of its own
// (fixtures/pmtiles.ts). For the static demo's build (demoRecord.ts), which runs where go-pmtiles may not be installed
// (Cloudflare's build image) and needs only a few hundred tiles; a region of the archive's is downloaded as
// download.ts says.

import { FetchSource, PMTiles } from "pmtiles";
import { writeMadeUpPmtiles } from "../../fixtures/pmtiles.ts";

/** A box in degrees, [west, south, east, north]. */
export type Box = readonly [number, number, number, number];

/** The tiles at zoom `z` over `box`, as x and y ranges (XYZ, y from the north). */
export function tilesOver(box: Box, z: number): { x: [number, number]; y: [number, number] } {
  const n = 2 ** z;
  const x = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const y = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n)));
  };
  return { x: [x(box[0]), x(box[2])], y: [y(box[3]), y(box[1])] };
}

/** Runs `work` over `items`, `most` at a time. */
async function inTurn<T>(items: readonly T[], most: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(most, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/**
 * Cuts `box` from the PMTiles build at `url`, from zoom 0 to `maxZoom` (the build's own highest, when lower), into a
 * PMTiles file at `file`: its tiles as the build keeps them, uncompressed. Resolves to how many tiles it holds.
 */
export async function extractArea(url: string, box: Box, file: string, { maxZoom, tileType }: { maxZoom: number; tileType: number }): Promise<number> {
  const build = new PMTiles(new FetchSource(url));
  const header = await build.getHeader();
  const top = Math.min(maxZoom, header.maxZoom);
  const wanted: Array<{ z: number; x: number; y: number }> = [];
  for (let z = header.minZoom; z <= top; z++) {
    const { x, y } = tilesOver(box, z);
    for (let tx = x[0]; tx <= x[1]; tx++) for (let ty = y[0]; ty <= y[1]; ty++) wanted.push({ z, x: tx, y: ty });
  }
  const tiles: Array<{ z: number; x: number; y: number; bytes: Uint8Array }> = [];
  await inTurn(wanted, 8, async ({ z, x, y }) => {
    const got = await build.getZxy(z, x, y);
    if (got) tiles.push({ z, x, y, bytes: new Uint8Array(got.data) });
  });
  await writeMadeUpPmtiles(file, { bbox: [...box], maxZoom: top, tiles, tileType });
  return tiles.length;
}
