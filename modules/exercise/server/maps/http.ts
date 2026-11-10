// The maps' routes (../../wire.ts's MAP_API), among the module's under /life-archive/api/m/exercise (../http.ts):
//
//   GET /life-archive/api/m/exercise/map/<region>/<z>/<x>/<y>.mvt            -> a vector tile of the region's map; 204 when it has none there
//   GET /life-archive/api/m/exercise/map/terrain/<region>/<z>/<x>/<y>.webp   -> a tile of the region's terrain (Terrarium); 204 when none
//   GET /life-archive/api/m/exercise/map/fonts/<font>/<from>-<to>.pbf        -> a font's glyphs; 204 when there are none for the range
//
// Read from the archive's folder (maps/; regions.ts), where `npm run map -- download <region>` put them. Only reads,
// and only from the page itself, as the Fitness page's routes.

import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { Effect } from "effect";
import { ForbiddenError, fromOwnPage, NotFoundError, sendJson, type Route } from "../../../../sdk/server.ts";
import { MAP_API } from "../../wire.ts";
import { glyphFile, MAP_FONTS, REGION_ID } from "./regions.ts";
import { Maps } from "./tiles.ts";

/** A tile or a font is kept by the page's browser for a day: a map is downloaded again seldom. */
const CACHE = "private, max-age=86400";

const TILE = /^\/([^/]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.mvt$/;
const TERRAIN = /^\/terrain\/([^/]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.webp$/;
const GLYPHS = /^\/fonts\/([^/]+)\/(\d{1,5})-(\d{1,5})\.pbf$/;

/** The maps' routes, for the archive kept at `archive`. */
export const mapRoute = (archive: string): Route<ForbiddenError | NotFoundError, Maps> => (req, res) =>
  Effect.gen(function* () {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "the maps are only read" });
    yield* fromOwnPage(req);
    const path = new URL(req.url ?? "/", "http://localhost").pathname.slice(MAP_API.length);
    const glyphs = GLYPHS.exec(path);
    if (glyphs) {
      const font = decodeURIComponent(glyphs[1]);
      const range = `${glyphs[2]}-${glyphs[3]}`;
      if (!(MAP_FONTS as readonly string[]).includes(font)) return yield* new NotFoundError(`no font ${font}`);
      const bytes = yield* Effect.promise(() => readFile(glyphFile(archive, font, range)).catch(() => null));
      return send(res, req.method, bytes, "application/x-protobuf");
    }
    const terrain = TERRAIN.exec(path);
    if (terrain) {
      const region = decodeURIComponent(terrain[1]);
      if (!REGION_ID.test(region)) return yield* new NotFoundError(`no terrain ${region}`);
      const maps = yield* Maps;
      const bytes = yield* Effect.promise(() => maps.terrainTile(region, Number(terrain[2]), Number(terrain[3]), Number(terrain[4])));
      return send(res, req.method, bytes, "image/webp");
    }
    const tile = TILE.exec(path);
    if (tile) {
      const region = decodeURIComponent(tile[1]);
      if (!REGION_ID.test(region)) return yield* new NotFoundError(`no map ${region}`);
      const [z, x, y] = [Number(tile[2]), Number(tile[3]), Number(tile[4])];
      const maps = yield* Maps;
      const bytes = yield* Effect.promise(() => maps.tile(region, z, x, y));
      return send(res, req.method, bytes, "application/x-protobuf");
    }
    return yield* new NotFoundError(`no map route ${path}`);
  });

/** A tile's or a font's bytes; none, 204, which MapLibre draws as empty (a terrain tile as flat ground). */
function send(res: ServerResponse, method: string | undefined, bytes: Uint8Array | null, type: string): void {
  if (!bytes || bytes.length === 0) {
    res.writeHead(204, { "cache-control": CACHE });
    return void res.end();
  }
  res.writeHead(200, { "content-type": type, "content-length": bytes.length, "cache-control": CACHE });
  res.end(method === "HEAD" ? undefined : bytes);
}
