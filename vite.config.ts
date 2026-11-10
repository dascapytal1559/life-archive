import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, parseAst, type Plugin } from "vite";
import { VIEWER_BASE } from "./viewer/wire.ts";

const NO_VIEWER = "\0life-archive:no-module-viewer";

/**
 * A module's viewer.tsx that Vite cannot resolve declares nothing. Its resolver reads the package.json of the folder a
 * file is in, and throws on one that does not parse: that would fail viewer/modules.ts, which resolves every module's
 * viewer.tsx (loading only those that are on), and every page with it. The server has told the page such a module is broken and off, and logged why
 * (server/modules/loader.ts), so the page loses nothing by the empty definition.
 */
function moduleViewerFallback(): Plugin {
  return {
    name: "life-archive:module-viewer-fallback",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!/\/modules\/[^/]+\/viewer\.tsx$/.test(source)) return null;
      try {
        return await this.resolve(source, importer, { ...options, skipSelf: true });
      } catch {
        return NO_VIEWER;
      }
    },
    load: (id) => (id === NO_VIEWER ? "export default { aspects: [], views: [] };" : null),
  };
}

/**
 * Vite's scan for the packages to bundle ahead (when they change, or on a fresh install) reads every file the page can
 * reach, every module's viewer.tsx among them, loaded or not, and fails whole on one that does not parse: the page then
 * gets no packages bundled, and fails. So the scan reads a module's file that does not parse as empty: the server has
 * said that module is broken or it is off, and its page half is not loaded or shows its own failure (viewer/modules.ts).
 */
function moduleScanFallback(): Plugin {
  return {
    name: "life-archive:module-scan-fallback",
    load(id) {
      const lang = /\/modules\/[^/]+\/[^?]*\.([cm]?[jt]sx?)$/.exec(id)?.[1];
      if (!lang || !existsSync(id)) return null;
      const code = readFileSync(id, "utf8");
      try {
        parseAst(code, { lang: lang.endsWith("x") ? (lang.startsWith("t") ? "tsx" : "jsx") : lang.includes("t") ? "ts" : "js" }, id);
        return null;
      } catch {
        return "";
      }
    },
  };
}

// The archive's viewer (viewer/), served in middleware mode by server/main.ts, which owns the port, the Host check
// (it gives Vite the same names) and the viewer's API under /life-archive/api/.
export default defineConfig({
  root: fileURLToPath(new URL("./viewer", import.meta.url)),
  appType: "spa",
  // Its modules and hot reload are always under /life-archive/, which Tailscale Serve passes on whole.
  base: `${VIEWER_BASE}/`,
  plugins: [moduleViewerFallback(), react()],
  optimizeDeps: { rolldownOptions: { plugins: [moduleScanFallback()] } },
  server: {
    // The archive's folder is never the page's; nothing in it reloads anything.
    watch: { ignored: ["**/data/**"] },
    // Vite serves any file it is allowed by path (/life-archive/@fs/<path>), and /life-archive is on the tailnet: so
    // it is allowed the page's own code, the SDK and the modules (whose page halves it serves, viewer/modules.ts) and
    // its packages alone, never the repository's root, where .env.local (and until it moved, the archive's folder) is;
    // and the archive's folder, any data/ and any SQLite database (rituals' is a .sqlite3) are denied however reached.
    fs: {
      strict: true,
      allow: ["./viewer", "./src", "./sdk", "./modules", "./node_modules"].map((path) => fileURLToPath(new URL(path, import.meta.url))),
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/data/**", "**/life-archive-data/**", "**/*.sqlite", "**/*.sqlite-*", "**/*.sqlite3*"],
    },
  },
});
