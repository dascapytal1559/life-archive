// The static demo's two pages as Vite builds them (build.ts; docs/demo.md): the console (viewer/demo/, at /life-archive/)
// and friend-map's page (modules/friend-map/page/demo/, at /friend-map/, which the console's Friend Map frames), each the
// page the server serves with the demo's backend under it (sdk/demo.ts), into the demo's folder. What sets them apart
// from the pages the server serves:
//
//   - the server's code the backend runs in the page (the Events tables, the content reads) is bundled with it, and
//     of the server's files only what the page calls is kept: the server's own modules are taken to do nothing as they
//     load (`moduleSideEffects`), so a module the page imports for one function does not bring the rest of the
//     server with it; the node: modules some of them use as they load (path, url, os, sqlite's constants) are the
//     page's own small stand-ins (viewer/demo/node*.ts), and a file naming one of its own by import.meta.url names
//     nowhere (noServerFiles), so nothing of the server's is copied in as an asset;
//   - nothing from an archive's folder, or any database, can be part of a page: the build stops if one is asked for
//     (noArchiveData). The made-up databases the backend reads are copied beside the pages by build.ts, never bundled.

import react from "@vitejs/plugin-react";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineConfig, Plugin } from "vite";
import { REPO } from "../../server/dataHome.ts";
import type { PageSpec } from "../../server/modulePages.ts";
import { installedModules, trackedModules } from "../../server/modules/loader.ts";
import { siteOf } from "../../viewer/mount.ts";

const at = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * The server's own files, whose loading does nothing but define what they export (see the top), from the repository's
 * root: the core's server/, sdk/ and src/, and all of a module's but its page halves (viewer/, viewer.tsx, page/).
 */
const SERVER_CODE = /^(?:(?:server|sdk|src)\/.*\.ts|modules\/[^/]+\/(?!viewer\/|page\/)[^]*\.ts)$/;

const inRepo = (id: string): string | null => (id.startsWith(REPO) ? id.slice(REPO.length) : null);

/**
 * The server's files name files of their own by `new URL(path, import.meta.url)` (a job's script, a page's root),
 * which a build would copy in beside the page as assets; in the page they are never opened, so they are named as
 * nowhere instead, and nothing is copied.
 */
function noServerFiles(): Plugin {
  return {
    name: "life-archive:no-server-files",
    enforce: "pre",
    transform(code, id) {
      if (!SERVER_CODE.test(inRepo(id.split("?")[0]) ?? "") || !code.includes("import.meta.url")) return null;
      return { code: code.replaceAll("import.meta.url", JSON.stringify("file:///demo/")), map: null };
    },
  };
}

/**
 * Refuses any module from an archive's folder (`folders`), the checkout's own data/ (a worktree's archive) or any
 * database, whatever it is called.
 */
export function noArchiveData(folders: readonly string[]): Plugin {
  return {
    name: "life-archive:no-archive-data",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0];
      const own = inRepo(path);
      if (folders.some((folder) => path.startsWith(folder)) || own?.startsWith("data/") || /\.sqlite\d?(?:-|$)/.test(path)) {
        this.error(`the demo may not include anything from an archive's folder or any database (${path})`);
      }
    },
  };
}

/**
 * Keeps the modules git does not track (`untracked`, a private module's) out of a page: each `import.meta.glob` of the
 * modules' files (viewer/modules.ts's viewer.tsx, viewer/demo/backend.ts's demo.ts) leaves them out by name, so neither
 * their code nor their names are bundled, and a file of theirs asked for any other way stops the build.
 */
export function trackedModulesOnly(untracked: readonly string[]): Plugin {
  const GLOB = /import\.meta\.glob(<[^>]*>)?\(\s*(["'])([^"']*modules\/\*\/[^"']+)\2/g;
  return {
    name: "life-archive:tracked-modules-only",
    enforce: "pre",
    transform(code) {
      if (untracked.length === 0 || !code.includes("import.meta.glob")) return null;
      const changed = code.replace(GLOB, (_all, types: string | undefined, _quote: string, pattern: string) =>
        `import.meta.glob${types ?? ""}(${JSON.stringify([pattern, ...untracked.map((module) => `!${pattern.replace("*", module)}`)])}`);
      return changed === code ? null : { code: changed, map: null };
    },
    load(id) {
      const own = inRepo(id.split("?")[0]);
      const module = own?.match(/^modules\/([^/]+)\//)?.[1];
      if (module && untracked.includes(module)) this.error(`the demo may not include a module git does not track (${own})`);
    },
  };
}

/** The installed modules git does not track in this checkout. */
function untrackedHere(): string[] {
  const tracked = trackedModules(REPO);
  return installedModules(REPO, {}).map((m) => m.id).filter((id) => !tracked.has(id));
}

function shared(root: string, base: string, outDir: string, folders: readonly string[], mount: string, plugins: Plugin[] = []): InlineConfig {
  return {
    configFile: false,
    root,
    // Under the demo's site, for a demo built for a mount (viewer/mount.ts).
    base: `${siteOf(mount)}${base}`,
    logLevel: "warn",
    publicDir: false,
    plugins: [noArchiveData(folders), trackedModulesOnly(untrackedHere()), noServerFiles(), react(), ...plugins],
    // Always a production build, whatever NODE_ENV the build runs under (vitest's "test"): a development one carries
    // each file's path on this machine in its JSX (the home folder's name with it), which the check stops.
    mode: "production",
    // A server file run as a script asks process.argv whether it is the one run (sqlRead.ts), and settings ask
    // process.env, as they load: in the page, no script is run and nothing is set.
    // The mount the page is built for, which viewer/mount.ts reads: "" for none.
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.argv": "[]", "process.env": "({})", "import.meta.env.LIFE_ARCHIVE_MOUNT": JSON.stringify(mount) },
    resolve: {
      alias: {
        "node:path": at("viewer/demo/nodePath.ts"),
        "node:url": at("viewer/demo/nodeUrl.ts"),
        "node:os": at("viewer/demo/nodeOs.ts"),
        "node:sqlite": at("viewer/demo/nodeSqlite.ts"),
      },
    },
    build: {
      outDir,
      // build.ts empties the demo's folder first, and has put the server's files in it (under /life-archive/api/).
      emptyOutDir: false,
      chunkSizeWarningLimit: 4000,
      // No modulepreload polyfill: it fetches, and every browser the demo runs in preloads modules itself.
      modulePreload: { polyfill: false },
      rollupOptions: { treeshake: { moduleSideEffects: (id) => !SERVER_CODE.test(inRepo(id) ?? "") } },
    },
  };
}

/**
 * The console's demo, built into `outDir` (served at /life-archive/, under the demo's site for one built for `mount`);
 * `folders` are the archive folders it may take nothing from.
 */
export const consoleDemoConfig = (outDir: string, folders: readonly string[], mount = ""): InlineConfig =>
  shared(at("viewer/demo"), "/life-archive/", outDir, folders, mount);

/** Where a module's page keeps its demo's entry: demo/index.html in its root (friend-map's page/demo/). */
export const pageDemoRoot = (page: PageSpec): string => join(page.root, "demo");

/**
 * A module's page's demo (sdk/server.ts's `page`: friend-map's), built into `outDir` and served at its path, with the
 * page's own plugins over the made-up folder, as the server serves it (`page.plugins`, friend-map's saved view settings).
 */
export const pageDemoConfig = (page: PageSpec, outDir: string, folders: readonly string[], mount = ""): InlineConfig =>
  shared(pageDemoRoot(page), `${page.path}/`, outDir, folders, mount, page.plugins as Plugin[]);
