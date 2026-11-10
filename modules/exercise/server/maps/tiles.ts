// The maps downloaded into the archive's folder (maps/<region>.pmtiles; regions.ts), read where they lie: which are
// here and what each covers (its header's box), and a tile of one, as the page's map asks for them (http.ts).
// Each region may have its terrain beside it (maps/terrain/<region>.pmtiles), read the same way.

import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { Context } from "effect";
import { PMTiles, type Header, type RangeResponse, type Source } from "pmtiles";
import { mapsFolder, REGION_ID, regionFile, terrainFile } from "./regions.ts";

/** A map that is here: its region, the box it covers ([west, south, east, north]) and its highest zoom. */
export interface MapRegion {
  region: string;
  bbox: [number, number, number, number];
  maxZoom: number;
}

/** A box in degrees, as a route's is. */
export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** A PMTiles file read where it lies, a range at a time. */
class FileSourceAt implements Source {
  private readonly path: string;
  private readonly handle: Promise<FileHandle>;
  constructor(path: string) {
    this.path = path;
    this.handle = open(path, "r");
  }
  getKey(): string {
    return this.path;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await (await this.handle).read(buffer, 0, length, offset);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) };
  }
  async close(): Promise<void> {
    await (await this.handle).close();
  }
}

interface Opened {
  /** The file's size and time, so a map downloaded again is opened again. */
  stamp: string;
  source: FileSourceAt;
  tiles: PMTiles;
  header: Header;
}

/** The maps in the archive's folder `archive`, each opened once and again only when its file changes; each region's terrain likewise. */
export function mapStore(archive: string) {
  const opened = new Map<string, Promise<Opened>>();

  /** The PMTiles file at `path`, opened once (kept as `key`) and again when it changes; null when it is not there. */
  const openFile = async (key: string, path: string): Promise<Opened | null> => {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const stamp = `${info.size}:${info.mtimeMs}`;
    const was = opened.get(key);
    if (was) {
      const kept = await was.catch(() => null);
      if (kept?.stamp === stamp) return kept;
      opened.delete(key);
      void kept?.source.close().catch(() => {});
    }
    const next = (async () => {
      const source = new FileSourceAt(path);
      const tiles = new PMTiles(source);
      return { stamp, source, tiles, header: await tiles.getHeader() };
    })();
    opened.set(key, next);
    next.catch(() => opened.delete(key));
    return next;
  };
  const openRegion = (region: string) => (REGION_ID.test(region) ? openFile(`map:${region}`, regionFile(archive, region)) : Promise.resolve(null));
  const openTerrain = (region: string) => (REGION_ID.test(region) ? openFile(`terrain:${region}`, terrainFile(archive, region)) : Promise.resolve(null));
  const tileOf = async (file: Opened | null, z: number, x: number, y: number): Promise<Uint8Array | null> => {
    if (!file || z < file.header.minZoom || z > file.header.maxZoom) return null;
    const got = await file.tiles.getZxy(z, x, y);
    return got ? new Uint8Array(got.data) : null;
  };

  return {
    /** Every map that is here. */
    async regions(): Promise<MapRegion[]> {
      const names = await readdir(mapsFolder(archive)).catch(() => [] as string[]);
      const found: MapRegion[] = [];
      for (const name of names.filter((n) => n.endsWith(".pmtiles")).sort()) {
        const region = name.slice(0, -".pmtiles".length);
        const map = await openRegion(region).catch(() => null);
        if (map) found.push({ region, bbox: [map.header.minLon, map.header.minLat, map.header.maxLon, map.header.maxLat], maxZoom: map.header.maxZoom });
      }
      return found;
    },
    /** A tile of `region`'s map, its bytes as a vector tile (uncompressed); null when the map has none there or is not here. */
    async tile(region: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
      return tileOf(await openRegion(region), z, x, y);
    },
    /** `region`'s terrain, when it is here: its highest zoom and its box ([west, south, east, north]); null otherwise. */
    async terrain(region: string): Promise<{ maxZoom: number; bbox: [number, number, number, number] } | null> {
      const terrain = await openTerrain(region).catch(() => null);
      return terrain && { maxZoom: terrain.header.maxZoom, bbox: [terrain.header.minLon, terrain.header.minLat, terrain.header.maxLon, terrain.header.maxLat] };
    },
    /** A tile of `region`'s terrain, its bytes as a Terrarium-encoded image; null when it has none there or is not here. */
    async terrainTile(region: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
      return tileOf(await openTerrain(region), z, x, y);
    },
    /** Closes every file it has open. */
    async close(): Promise<void> {
      const all = [...opened.values()];
      opened.clear();
      await Promise.all(all.map((p) => p.then((o) => o.source.close()).catch(() => {})));
    },
  };
}

export type MapStore = ReturnType<typeof mapStore>;

/** The server's maps: the archive folder's, opened and closed by the module's Layer (../service.ts's exerciseLayer). */
export class Maps extends Context.Service<Maps, MapStore>()("life-archive/exercise/Maps") {}

/** The first map, of `regions`, whose box holds all of `bounds`; null when none does. */
export function regionHolding(regions: readonly MapRegion[], bounds: Bounds): MapRegion | null {
  return regions.find(({ bbox: [west, south, east, north] }) => bounds.west >= west && bounds.east <= east && bounds.south >= south && bounds.north <= north) ?? null;
}
