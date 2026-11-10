// CesiumJS for the playback's photorealistic city (viewer/playback/photorealScene.ts), served as its package built it
// (node_modules/cesium/Build/Cesium: Cesium.js, its workers, assets and widgets' styles) from this server, so the page
// fetches none of it from elsewhere and Vite does not rewrite it (its built script is not a module, and its workers
// load their neighbours by address):
//
//   GET /life-archive/api/m/exercise/cesium/<path>   -> a file of Cesium's build; 404 for anything outside it
//
// Only reads, and only from the page itself, as the module's other routes.

import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { ForbiddenError, fromOwnPage, NotFoundError, sendJson, type Route } from "../../../sdk/server.ts";
import { CESIUM_URL } from "../wire.ts";

/** Cesium's build, where its package is installed. */
const BUILD = join(dirname(fileURLToPath(import.meta.resolve("cesium/package.json"))), "Build", "Cesium");

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

/** The file of Cesium's build at `path` (under CESIUM_URL), or null when it is outside the build or not a file. */
export async function cesiumFile(path: string): Promise<string | null> {
  const relative = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
  if (relative === "" || relative.startsWith("..") || relative.includes(`${sep}..${sep}`)) return null;
  const file = join(BUILD, relative);
  if (!file.startsWith(BUILD + sep)) return null;
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? file : null;
}

/** The route serving Cesium's build. */
export const cesiumRoute: Route<ForbiddenError | NotFoundError, never> = (req, res) =>
  Effect.gen(function* () {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "CesiumJS is only read" });
    yield* fromOwnPage(req);
    const path = new URL(req.url ?? "/", "http://localhost").pathname.slice(CESIUM_URL.length);
    const file = yield* Effect.promise(() => cesiumFile(path));
    if (!file) return yield* new NotFoundError(`no file ${path} in CesiumJS's build`);
    const bytes = yield* Effect.promise(() => readFile(file));
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": bytes.length, "cache-control": "private, max-age=86400" });
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
