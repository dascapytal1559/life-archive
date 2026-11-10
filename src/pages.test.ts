// The ready marks (pages.ts): which pages a fresh install offers, and that every page this repository ships has one.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "../server/dataHome.ts";
import { loadModules, TRACKED_MODULES_ONLY } from "../server/modules/loader.ts";
import { loadSettings } from "../server/settings.ts";
import { pageOn } from "./pages.ts";

/** The modules this repository ships: those .gitignore names to track. */
const shipped = (): string[] => [...readFileSync(join(REPO, ".gitignore"), "utf8").matchAll(/^!\/modules\/([^/]+)\/$/gm)].map((m) => m[1]!).sort();

const markOf = (id: string): unknown => (JSON.parse(readFileSync(join(REPO, "modules", id, "package.json"), "utf8")) as { lifeArchiveReady?: unknown }).lifeArchiveReady;

describe("the ready marks", () => {
  it("are on every module this repository ships, said either way, so a new one chooses", () => {
    expect(shipped().length).toBeGreaterThan(0);
    for (const id of shipped()) expect(typeof markOf(id), id).toBe("boolean");
  });

  it("offer a fresh install, its settings.json empty, Friend Map and the folder history (which has no page) alone, beside Events, always on", async () => {
    const folder = mkdtempSync(join(tmpdir(), "life-archive-fresh-"));
    try {
      writeFileSync(join(folder, "settings.json"), "{}\n");
      const settings = loadSettings(folder, { env: {} });
      // The modules this repository ships, as the server loads them for these settings (a private one is the owner's).
      const { on } = await loadModules({ switches: settings.modules, pages: settings.pages, env: { [TRACKED_MODULES_ONLY]: "1" } });
      expect(on.map((m) => m.id)).toEqual(["folder-history", "friend-map"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);

  it("let a switch win, then `pages: all`, then the mark", () => {
    expect(pageOn(false, undefined, "ready")).toBe(false);
    expect(pageOn(true, undefined, "ready")).toBe(true);
    expect(pageOn(false, true, "ready")).toBe(true);
    expect(pageOn(false, undefined, "all")).toBe(true);
    expect(pageOn(true, false, "all")).toBe(false);
  });
});
