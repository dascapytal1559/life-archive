// Vite serves the page under /life-archive/ (on the tailnet): any file it is allowed by path, so what it is allowed is
// held here (vite.config.ts): the page's code, the SDK and the modules, and the packages, never the repository's root
// or the archive's folder.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type PluginOption } from "vite";
import { describe, expect, it, vi } from "vitest";
import viteConfig from "../vite.config.ts";

/** A made-up module: its package.json, and its viewer.tsx (one declaring an aspect at its id, unless given). */
interface MadeUp {
  readonly manifest?: string;
  readonly viewer?: string;
}

/** A made-up checkout: the page's real viewer/modules.ts, and under modules/ each folder given. */
function checkout(modules: Readonly<Record<string, MadeUp>>): string {
  const root = mkdtempSync(join(tmpdir(), "life-archive-vite-"));
  mkdirSync(join(root, "viewer"));
  cpSync(fileURLToPath(new URL("../viewer/modules.ts", import.meta.url)), join(root, "viewer", "modules.ts"));
  for (const [id, { manifest = `{ "lifeArchive": true }\n`, viewer }] of Object.entries(modules)) {
    mkdirSync(join(root, "modules", id), { recursive: true });
    writeFileSync(join(root, "modules", id, "package.json"), manifest);
    writeFileSync(join(root, "modules", id, "viewer.tsx"), viewer ?? `export default { aspects: [{ key: "${id}" }], views: [] };\n`);
  }
  return root;
}

/** What viewer/modules.ts loads for the page when Vite, with the real config's plugins, serves it from `root` and the server said `on`. */
async function moduleViewers(root: string, on: Readonly<Record<string, boolean>>): Promise<unknown> {
  const server = await createServer({
    configFile: false,
    root: join(root, "viewer"),
    cacheDir: join(root, "cache"),
    plugins: (viteConfig as { plugins: PluginOption[] }).plugins,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false, watch: null },
  });
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const modules = (await server.ssrLoadModule("/modules.ts")) as { loadModuleViewers: (on: Readonly<Record<string, boolean>>) => Promise<unknown> };
    return await modules.loadModuleViewers(on);
  } finally {
    quiet.mockRestore();
    await server.close();
  }
}

/** Runs `test` on a made-up checkout of `modules`, removed after. */
async function inCheckout<T>(modules: Readonly<Record<string, MadeUp>>, test: (root: string) => Promise<T>): Promise<T> {
  const root = checkout(modules);
  try {
    return await test(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A viewer.tsx that does not parse, and one that throws as it loads. */
const UNPARSABLE = "export default { aspects: [, views: \n";
const THROWS = `throw new Error("made-up failure");\n`;

describe("Vite, serving the page under /life-archive/ (on the tailnet)", () => {
  it("is allowed the page's code, the SDK, the modules and the packages alone, never the repository's root or the archive's folder", () => {
    const fs = (viteConfig as { server: { fs: { strict: boolean; allow: string[]; deny: string[] } } }).server.fs;
    const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
    expect(fs.strict).toBe(true);
    expect(fs.allow.map((path) => path.replace(/\/$/, ""))).toEqual([`${root}/viewer`, `${root}/src`, `${root}/sdk`, `${root}/modules`, `${root}/node_modules`]);
    expect(fs.deny).toEqual(expect.arrayContaining(["**/data/**", "**/life-archive-data/**", "**/*.sqlite", ".env.*"]));
  });

  // docs/modules.md: a module whose package.json does not parse is broken, and off for the page, and the console goes
  // on. Vite's resolver reads that file too, as it serves viewer/modules.ts, whose every viewer.tsx it resolves:
  // left alone it fails viewer/modules.ts, and with it every page.
  it("serves the page's modules with one whose package.json does not parse as declaring nothing, the others as they are", async () => {
    const loaded = await inCheckout({ sample: {}, typo: { manifest: `{ "lifeArchive": true, oops }\n` } }, (root) => moduleViewers(root, { sample: true, typo: true }));
    expect(loaded).toEqual([
      { id: "sample", viewer: { aspects: [{ key: "sample" }], views: [] } },
      { id: "typo", viewer: { aspects: [], views: [] } },
    ]);
  }, 30_000);

  it("loads only the modules the server said are on: a broken viewer.tsx of one off, or one it did not name, is never loaded", async () => {
    const loaded = await inCheckout({ off: { viewer: UNPARSABLE }, sample: {}, unnamed: { viewer: THROWS } }, (root) => moduleViewers(root, { off: false, sample: true }));
    expect(loaded).toEqual([{ id: "sample", viewer: { aspects: [{ key: "sample" }], views: [] } }]);
  }, 30_000);

  // Vite's scan for the packages to bundle ahead reads every module's files, off or broken too, and fails whole on one
  // that does not parse, leaving the page with no packages bundled: the scan reads such a file as empty.
  it("scans a module's file that does not parse as empty, every other as it is", async () => {
    const scan = (viteConfig as { optimizeDeps: { rolldownOptions: { plugins: { load: (id: string) => unknown }[] } } }).optimizeDeps.rolldownOptions.plugins[0];
    await inCheckout({ broken: { viewer: UNPARSABLE }, sample: {} }, async (root) => {
      expect(scan.load(join(root, "modules", "broken", "viewer.tsx"))).toBe("");
      expect(scan.load(join(root, "modules", "sample", "viewer.tsx"))).toBeNull();
      expect(scan.load(join(root, "viewer", "modules.ts"))).toBeNull();
    });
  });

  it("tells an on module whose viewer.tsx does not load, or declares no viewer, as failed, and loads every other", async () => {
    const loaded = await inCheckout(
      { broken: { viewer: UNPARSABLE }, empty: { viewer: "export const nothing = 1;\n" }, sample: {}, throws: { viewer: THROWS } },
      (root) => moduleViewers(root, { broken: true, empty: true, sample: true, throws: true }),
    );
    expect(loaded).toEqual([
      { id: "broken", failed: expect.any(String) },
      { id: "empty", failed: "its viewer.tsx has no default export of defineViewer's shape" },
      { id: "sample", viewer: { aspects: [{ key: "sample" }], views: [] } },
      { id: "throws", failed: "made-up failure" },
    ]);
  }, 30_000);
});
