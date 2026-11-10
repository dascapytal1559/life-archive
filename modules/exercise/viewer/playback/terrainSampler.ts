// The ground's height under the route, from the region's terrain kept on this Mac (Terrarium-encoded tiles, read from
// this server alone): for the photorealistic city, whose route and marker need a height to stand at, and for the
// elevation readout where the recording kept no altitude. The tiles covering the route are read once, at the
// terrain's highest zoom, and a height is read between a tile's four nearest pixels.

import { terrainUrl, type PlaybackTrack } from "../../wire.ts";

/** A height at a point, metres above sea level; null outside the tiles read. */
export type GroundAt = (lng: number, lat: number) => number | null;

const TILE_PX = 512;

/** A Terrarium pixel's height: red × 256 + green + blue / 256, less 32768. */
export const terrarium = (r: number, g: number, b: number): number => r * 256 + g + b / 256 - 32768;

/** The tile column and row (fractional) of a point at zoom `z`, Web Mercator. */
export function tileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return [((lng + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n];
}

/** The terrain under the box `bounds` ([west, south, east, north]) of `track`'s region, read; null when it has none or it cannot be read. */
export async function groundUnder(track: PlaybackTrack, bounds: [number, number, number, number], signal?: AbortSignal): Promise<GroundAt | null> {
  if (!track.terrain) return null;
  const z = track.terrain.maxZoom;
  const [x0, y0] = tileXY(bounds[0], bounds[3], z).map(Math.floor);
  const [x1, y1] = tileXY(bounds[2], bounds[1], z).map(Math.floor);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return null;
  const tiles = new Map<string, Float32Array>();
  const url = `${window.location.origin}${terrainUrl(track.map.region)}`;
  const reads: Array<Promise<void>> = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      reads.push(
        fetch(url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)), { signal })
          .then(async (res) => {
            if (res.status !== 200) return;
            const bitmap = await createImageBitmap(await res.blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d", { willReadFrequently: true })!;
            context.drawImage(bitmap, 0, 0);
            const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
            const heights = new Float32Array(bitmap.width * bitmap.height);
            for (let i = 0; i < heights.length; i++) heights[i] = terrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
            tiles.set(`${x}/${y}`, heights);
          })
          .catch(() => {}),
      );
  await Promise.all(reads);
  if (tiles.size === 0) return null;
  return (lng, lat) => {
    const [tx, ty] = tileXY(lng, lat, z);
    const heights = tiles.get(`${Math.floor(tx)}/${Math.floor(ty)}`);
    if (!heights) return null;
    const px = (tx - Math.floor(tx)) * TILE_PX - 0.5;
    const py = (ty - Math.floor(ty)) * TILE_PX - 0.5;
    const ix = Math.max(0, Math.min(TILE_PX - 2, Math.floor(px)));
    const iy = Math.max(0, Math.min(TILE_PX - 2, Math.floor(py)));
    const u = Math.max(0, Math.min(1, px - ix));
    const v = Math.max(0, Math.min(1, py - iy));
    const at = (cx: number, cy: number) => heights[cy * TILE_PX + cx];
    return (at(ix, iy) * (1 - u) + at(ix + 1, iy) * u) * (1 - v) + (at(ix, iy + 1) * (1 - u) + at(ix + 1, iy + 1) * u) * v;
  };
}
