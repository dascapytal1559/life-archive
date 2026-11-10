// A made-up map for the tests: a PMTiles v3 file (the format `npm run map -- download` keeps, server/maps/) written
// by hand, uncompressed, whose tiles are made-up bytes and whose box is whatever the test says. Enough for the maps'
// routes and the Fitness page's placing of routes to be tested without a real map.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { zxyToTileId } from "pmtiles";

/** A varint, as PMTiles' directories write their numbers. */
function varint(n: number, out: number[]): void {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

/**
 * Writes a PMTiles v3 file at `file` covering `bbox` ([west, south, east, north]) from zoom 0 to `maxZoom`, with
 * `tiles` (each its z, x, y and bytes) and nothing else; no compression, tile type `tileType` (PMTiles' numbers: 1, the
 * default, vector tiles (MVT); 4 WebP, as terrain is). The static demo's build writes its area's map cut from the open
 * builds with it too (server/maps/extract.ts).
 */
export async function writeMadeUpPmtiles(
  file: string,
  { bbox, maxZoom, tiles, tileType = 1 }: { bbox: [number, number, number, number]; maxZoom: number; tiles: Array<{ z: number; x: number; y: number; bytes: Uint8Array }>; tileType?: number },
): Promise<void> {
  const sorted = tiles.map((t) => ({ ...t, id: zxyToTileId(t.z, t.x, t.y) })).sort((a, b) => a.id - b.id);
  const directory: number[] = [];
  varint(sorted.length, directory);
  let last = 0;
  for (const t of sorted) {
    varint(t.id - last, directory);
    last = t.id;
  }
  for (const _ of sorted) varint(1, directory);
  for (const t of sorted) varint(t.bytes.length, directory);
  // Each tile right after the one before: written as 0, after the first's offset + 1.
  sorted.forEach((_, i) => varint(i === 0 ? 1 : 0, directory));
  const metadata = Buffer.from(JSON.stringify({ name: "made-up" }));
  const data = Buffer.concat(sorted.map((t) => Buffer.from(t.bytes)));

  const header = Buffer.alloc(127);
  header.write("PMTiles", 0, "latin1");
  header.writeUInt8(3, 7);
  const rootOffset = 127;
  const metadataOffset = rootOffset + directory.length;
  const dataOffset = metadataOffset + metadata.length;
  const u64 = (at: number, value: number) => header.writeBigUInt64LE(BigInt(value), at);
  u64(8, rootOffset);
  u64(16, directory.length);
  u64(24, metadataOffset);
  u64(32, metadata.length);
  u64(40, dataOffset);
  u64(48, 0);
  u64(56, dataOffset);
  u64(64, data.length);
  u64(72, sorted.length);
  u64(80, sorted.length);
  u64(88, sorted.length);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(1, 97); // internal compression: none
  header.writeUInt8(1, 98); // tile compression: none
  header.writeUInt8(tileType, 99);
  header.writeUInt8(0, 100);
  header.writeUInt8(maxZoom, 101);
  const [west, south, east, north] = bbox.map((v) => Math.round(v * 1e7));
  header.writeInt32LE(west, 102);
  header.writeInt32LE(south, 106);
  header.writeInt32LE(east, 110);
  header.writeInt32LE(north, 114);
  header.writeUInt8(0, 118);
  header.writeInt32LE(Math.round((west + east) / 2), 119);
  header.writeInt32LE(Math.round((south + north) / 2), 123);

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([header, Buffer.from(directory), metadata, data]));
}
