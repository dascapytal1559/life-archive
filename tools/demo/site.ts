// What Cloudflare Pages reads beside the demo's files (build.ts; docs/demo.md), and the pages' 404s:
//
//   _redirects  the site's root opens the console's home, every console address its page (a rewrite, 200), and the
//               console's former addresses (/life-archive/console/...) the same place at its own. Pages
//               follows a rule even where a file is, so no rule covers a folder with files in it: a module page's
//               addresses (friend-map's /friend-map/spider) are its 404.html instead, the page itself (below).
//   _headers    the page's headers: nothing it loads comes from another site (its Content-Security-Policy,
//               server/demoSite.ts), only the console frames friend-map's page, no referrer, no devices; the built
//               files (named by their hash) kept a year, the rest asked again each time (a build changes them under
//               the same names).
//   404.html    at the root, a page that says it is not in the demo; in each page's folder, that page again, so an
//               address of its own opens it (with 404), and a question the demo has no answer for is a 404 there too.
//
// A demo built for a mount (the main preview) is served by the archive's server (server/mainPreview.ts), which routes
// it itself and sets its own headers: it gets the 404s alone.
//
// serve.ts serves a built demo as Pages does, to look at it here.

import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEMO_DATA } from "../../sdk/demo.ts";
import { DEMO_HEADERS, demoCsp } from "../../server/demoSite.ts";
import { CONSOLE_PATH, FORMER_CONSOLE_PATH, consolePath } from "../../viewer/console/address.ts";

/** The console's home in the demo, which the site's root opens. */
export const DEMO_HOME = consolePath("events");

const notInDemoPage = (home: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>Not in the demo · Life archive</title>
    <style>body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070b16; color: #d8deea; font: 16px/1.5 system-ui, sans-serif; } a { color: #5fe08a; }</style>
  </head>
  <body>
    <p>This is not in the life archive's demo. <a href="${home}">Open the demo</a>.</p>
  </body>
</html>
`;

/**
 * Writes _redirects, _headers and the 404s into the built demo at `out`, whose module pages are at `pages` (/friend-map);
 * for a demo built for `mount`, the 404s alone (see the top).
 */
export async function writeSite(out: string, pages: readonly string[], mount = ""): Promise<void> {
  if (!mount) {
    const redirects = [
      `/ ${DEMO_HOME} 302`,
      `${FORMER_CONSOLE_PATH} ${CONSOLE_PATH} 302`,
      `${FORMER_CONSOLE_PATH}/* ${CONSOLE_PATH}/:splat 302`,
      `${CONSOLE_PATH} /life-archive/index.html 200`,
      `${CONSOLE_PATH}/* /life-archive/index.html 200`,
    ];
    await writeFile(join(out, "_redirects"), `${redirects.join("\n")}\n`);
    const headers = [
      "/*",
      `  Content-Security-Policy: ${demoCsp("'self'")}`,
      ...DEMO_HEADERS.map(([name, value]) => `  ${name}: ${value}`),
      "  Cache-Control: no-cache",
      ...["/life-archive", ...pages].flatMap((page) => [`${page}/assets/*`, "  Cache-Control: public, max-age=31536000, immutable"]),
      `${DEMO_DATA}/db/*`,
      "  Content-Type: application/octet-stream",
    ];
    await writeFile(join(out, "_headers"), `${headers.join("\n")}\n`);
  }
  await writeFile(join(out, "404.html"), notInDemoPage(mount || DEMO_HOME));
  for (const page of ["/life-archive", ...pages]) await copyFile(join(out, page.slice(1), "index.html"), join(out, page.slice(1), "404.html"));
}
