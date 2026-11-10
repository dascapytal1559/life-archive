// The main branch's preview at /life-archive/main (docs/demo.md's "The main preview"): the main branch's demo, built
// for this path on the made-up data (npm run main-preview, tools/mainPreview.ts), served as plain files from the
// archive's folder (MAIN_PREVIEW_FOLDER/current, a link the build swaps in whole). The server only reads those files:
// no route of the archive's answers under this path, the page's own backend answers every question in the page, and its
// headers let it load nothing outside this path (demoSite.ts's demoCsp, with this path as its own), so nothing of the
// real archive is reachable from it. With no build yet it answers a page saying so.
//
//   /life-archive/main and any address under it      the console's page (its console is at the mount, viewer/mount.ts)
//   /life-archive/main/_site/<path>                    the demo's file at <path>: a folder's index.html, else the
//                                                      nearest 404.html (friend-map's page for its own addresses)

import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { Effect } from "effect";
import { VIEWER_BASE } from "../viewer/wire.ts";
import { siteOf } from "../viewer/mount.ts";
import { DEMO_HEADERS, FILE_TYPES, demoCsp } from "./demoSite.ts";
import type { Route } from "./jsonApi.ts";

/** Where the preview is served: the mount its demo is built for. */
export const MAIN_PREVIEW_PATH = `${VIEWER_BASE}/main`;

/** The preview's folder in the archive's folder: each build under builds/, and current, the link to the one served. */
export const MAIN_PREVIEW_FOLDER = "main-preview";

/** The link to the build that is served, in the preview's folder. */
export const CURRENT = "current";

const page = (title: string, text: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>${title} · Life archive</title>
    <style>body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070b16; color: #d8deea; font: 16px/1.5 system-ui, sans-serif; padding: 0 16px; } code { color: #5fe08a; }</style>
  </head>
  <body>
    <p>${text}</p>
  </body>
</html>
`;

/** What the preview answers before its first build. */
export const NOT_BUILT = page("Main preview", "No main preview built yet: <code>npm run main-preview</code> builds one.");

/** A file of the build at `root`, or the folder's index.html; null for none, or for a path that leaves the build. */
function fileIn(root: string, path: string): string | null {
  const file = normalize(join(root, path));
  if (file !== root && !file.startsWith(`${root}${sep}`)) return null;
  const stats = statSync(file, { throwIfNoEntry: false });
  if (stats?.isFile()) return file;
  if (stats?.isDirectory() && statSync(join(file, "index.html"), { throwIfNoEntry: false })?.isFile()) return join(file, "index.html");
  return null;
}

/** The nearest 404.html above `path` in the build at `root`. */
function notFoundPage(root: string, path: string): string | null {
  for (let dir = dirname(normalize(join(root, path))); dir === root || dir.startsWith(`${root}${sep}`); dir = dirname(dir)) {
    if (statSync(join(dir, "404.html"), { throwIfNoEntry: false })?.isFile()) return join(dir, "404.html");
    if (dir === root) break;
  }
  return null;
}

/** The build served (the link `current` in the preview's folder, to a build with the console's page), as its real folder; null before the first. */
export function servedBuild(previewFolder: string): string | null {
  try {
    const root = realpathSync(join(previewFolder, CURRENT));
    return statSync(join(root, "life-archive", "index.html"), { throwIfNoEntry: false })?.isFile() ? root : null;
  } catch {
    return null;
  }
}

/** The preview's headers for a request that came by `host` (the page may load from this path alone, on the host it was opened at). */
function headersFor(host: string, path: string, type: string): Record<string, string> {
  return {
    "content-type": type,
    "content-security-policy": demoCsp(`${host}${MAIN_PREVIEW_PATH}/`),
    ...Object.fromEntries(DEMO_HEADERS.map(([name, value]) => [name.toLowerCase(), value])),
    // The built files are named by their hash; the rest change under the same names with each build.
    "cache-control": /\/assets\//.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
  };
}

/** The preview's route, over the preview's folder `previewFolder` (the archive's folder's MAIN_PREVIEW_FOLDER). */
export const mainPreviewRoute = (previewFolder: string): Route<never, never> => (req: IncomingMessage, res: ServerResponse) =>
  Effect.gen(function* () {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      return void res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }).end("The main preview is read-only.\n");
    }
    const html = FILE_TYPES[".html"]!;
    const root = servedBuild(previewFolder);
    if (root === null) return void res.writeHead(404, { "content-type": html, "cache-control": "no-cache" }).end(req.method === "HEAD" ? undefined : NOT_BUILT);
    const site = siteOf(MAIN_PREVIEW_PATH);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
      if (path.includes("\0")) throw new URIError("a null byte");
    } catch {
      return void res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("A path the preview cannot read.\n");
    }
    let file: string | null;
    let status = 200;
    if (path === site || path.startsWith(`${site}/`)) {
      const own = path.slice(site.length);
      file = fileIn(root, own || "/");
      // A folder's page is at its address with a slash, so what it loads by a relative path is found under it.
      if (file?.endsWith(`${sep}index.html`) && !own.endsWith("/") && !own.endsWith("index.html")) {
        return void res.writeHead(308, { location: `${url.pathname}/${url.search}` }).end();
      }
      if (file === null) {
        status = 404;
        file = notFoundPage(root, own || "/");
      }
    } else {
      // The console's addresses: its page, which reads the place from the address.
      file = join(root, "life-archive", "index.html");
    }
    const headers = headersFor(req.headers.host ?? "localhost", url.pathname, file ? (FILE_TYPES[extname(file)] ?? "application/octet-stream") : "text/plain; charset=utf-8");
    // A file gone between the look and the read (a build swapped in meanwhile) is not there either.
    const body = file === null ? null : yield* Effect.tryPromise(() => readFile(file)).pipe(Effect.catch(() => Effect.succeed(null)));
    if (body === null) return void res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" }).end(req.method === "HEAD" ? undefined : "Not in the main preview.\n");
    res.writeHead(status, { ...headers, "content-length": String(body.length) }).end(req.method === "HEAD" ? undefined : body);
  });
