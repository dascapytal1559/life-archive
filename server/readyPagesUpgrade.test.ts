import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_FILE, openCore, READY_MARKS_KEY } from "./archive/coreDb.ts";
import { NO_ENV_FILE, REPO } from "./dataHome.ts";
import { upgradeToReadyPages } from "./readyPagesUpgrade.ts";
import { loadSettings, SETTINGS_FILE } from "./settings.ts";

let folder: string;
let file: string;
const pages = () => loadSettings(folder, { root: folder, env: {} }).pages;
const written = async () => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

/** A core.sqlite as the code before the ready marks left it: whole, but without the mark. */
function olderCore(): void {
  openCore(join(folder, CORE_FILE)).close();
  const db = new DatabaseSync(join(folder, CORE_FILE));
  db.prepare("DELETE FROM meta WHERE key = ?").run(READY_MARKS_KEY);
  db.close();
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-archive-ready-pages-"));
  file = join(folder, SETTINGS_FILE);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe("the upgrade to ready pages", () => {
  it("leaves a fresh install on the ready pages, with no settings.json written, before and after its core is made", () => {
    expect(upgradeToReadyPages(folder, file)).toBe(false);
    openCore(join(folder, CORE_FILE)).close();
    expect(upgradeToReadyPages(folder, file)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(pages()).toBe("ready");
  });

  it("turns every page on for an archive made before them, keeping the rest of its settings, once", async () => {
    olderCore();
    await writeFile(file, JSON.stringify({ timeZone: "Australia/Melbourne", owner: { name: "Riley" } }));
    expect(upgradeToReadyPages(folder, file)).toBe(true);
    expect(await written()).toEqual({ timeZone: "Australia/Melbourne", owner: { name: "Riley" }, pages: "all" });
    expect(pages()).toBe("all");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"pages": "all" written'));

    // Its core is marked the next time it is opened; the owner may then take the key out and keep only the ready pages.
    openCore(join(folder, CORE_FILE)).close();
    await writeFile(file, JSON.stringify({ timeZone: "Australia/Melbourne" }));
    expect(upgradeToReadyPages(folder, file)).toBe(false);
    expect(pages()).toBe("ready");
  });

  it("knows the layout before the core had its own database, and writes a settings.json there when it has none", async () => {
    new DatabaseSync(join(folder, "archive.sqlite")).close();
    expect(upgradeToReadyPages(folder, file)).toBe(true);
    expect(await written()).toEqual({ pages: "all" });
  });

  it("is run by settings() on the archive's own settings.json, never on a file LIFE_ARCHIVE_SETTINGS names", async () => {
    olderCore();
    const other = join(folder, "other.json");
    await writeFile(other, "{}");
    const pagesSeen = (env: Record<string, string>) => {
      const script = `import { settings } from ${JSON.stringify(join(REPO, "server", "settings.ts"))}; console.log(settings().pages);`;
      const ran = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { LIFE_ARCHIVE_DATA: folder, [NO_ENV_FILE]: "1", HOME: folder, PATH: "", ...env },
      });
      expect(ran.status, ran.stderr).toBe(0);
      return ran.stdout.trim();
    };
    expect(pagesSeen({ LIFE_ARCHIVE_SETTINGS: other })).toBe("ready");
    expect(existsSync(file)).toBe(false);
    expect(await readFile(other, "utf8")).toBe("{}");
    expect(pagesSeen({})).toBe("all");
    expect(await written()).toEqual({ pages: "all" });
  });

  it("never overrides a `pages` the owner chose, nor touches a file loadSettings will refuse", async () => {
    olderCore();
    await writeFile(file, JSON.stringify({ pages: "ready" }));
    expect(upgradeToReadyPages(folder, file)).toBe(false);
    expect(pages()).toBe("ready");
    for (const text of ["not json", "[]", "null"]) {
      await writeFile(file, text);
      expect(upgradeToReadyPages(folder, file)).toBe(false);
      expect(await readFile(file, "utf8")).toBe(text);
    }
  });
});
