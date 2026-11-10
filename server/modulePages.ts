// The pages the modules serve in a frame (sdk/server.ts's `page`: friend map's friend-map page at /friend-map/), each
// served by a Vite of its own in middleware mode in the server's process, beside the viewer's (vite.config.ts): its
// root the module's page folder, its base the page's path, so its modules and its hot reload are always asked for
// under it, and its hot reload on the server's own port, told apart from the viewer's by that base. A module's page
// is its own app, with its own index.html and its own React, framed by the console as it frames any page.
//
// Like the viewer's, it serves by path only its own folder and the packages, never the repository's root, and denies
// the archive's folder, any data/ and any SQLite database however reached. Loaded here, not imported, so a Vite that
// will not start costs the page and nothing else.

import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { PluginOption, ViteDevServer } from "vite";

/** What the console frames of a module: its path, its root and its plugins. */
export interface PageSpec {
  readonly path: string;
  readonly root: string;
  readonly plugins: PluginOption[];
}

/** The files Vite never serves, however reached (the viewer's own list, vite.config.ts). */
export const DENIED = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/data/**", "**/life-archive-data/**", "**/*.sqlite", "**/*.sqlite-*", "**/*.sqlite3*"];

/** A Vite serving `page` on `server`, admitting `hosts`, or why it could not start. */
export async function startModulePage(server: Server, page: PageSpec, hosts: readonly string[]): Promise<ViteDevServer | Error> {
  try {
    const [{ createServer }, { default: react }] = await Promise.all([import("vite"), import("@vitejs/plugin-react")]);
    return await createServer({
      configFile: false,
      root: page.root,
      base: `${page.path}/`,
      appType: "spa",
      plugins: [react(), ...page.plugins],
      server: {
        middlewareMode: true,
        ws: { server },
        allowedHosts: [...hosts],
        watch: { ignored: ["**/data/**"] },
        // The page's own files, the packages, and the SDK and the core's src/ it may import through it (sdk/contract.ts).
        fs: { strict: true, allow: [page.root, ...["../node_modules", "../sdk", "../src"].map((path) => fileURLToPath(new URL(path, import.meta.url)))], deny: DENIED },
      },
      logLevel: "warn",
    });
  } catch (error) {
    const failed = error instanceof Error ? error : new Error(String(error));
    console.error(`The page at ${page.path}/ is not available:`, failed.message);
    return failed;
  }
}
