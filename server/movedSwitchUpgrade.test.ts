import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveSwitches, upgradeMovedSwitches } from "./movedSwitchUpgrade.ts";

let folder: string;
let file: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-archive-moved-switch-"));
  file = join(folder, "settings.json");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe("the switch of a core page that became a module", () => {
  it("moves from aspects to modules, the other keys as they were, and `aspects` goes once empty", () => {
    expect(moveSwitches({ owner: { name: "Riley" }, aspects: { inspirations: true, shopping: false }, modules: { health: false } }, [])).toEqual({
      settings: { owner: { name: "Riley" }, modules: { health: false, shopping: false, inspirations: true } },
      moved: ["shopping", "inspirations"],
    });
    // `modules` comes when there was none.
    expect(moveSwitches({ aspects: { inspirations: false } }, [])?.settings).toEqual({ modules: { inspirations: false } });
    // An `aspects` with nothing in it goes too, as it is no setting any more.
    expect(moveSwitches({ pages: "all", aspects: {} }, [])).toEqual({ settings: { pages: "all" }, moved: [] });
  });

  it("moves Baby's switch to its private module only where one is installed, and leaves it as it is where none is", () => {
    expect(moveSwitches({ aspects: { inspirations: true, baby: true } }, ["baby", "inspirations"])).toEqual({
      settings: { modules: { inspirations: true, baby: true } },
      moved: ["inspirations", "baby"],
    });
    expect(moveSwitches({ aspects: { baby: false } }, ["baby"])).toEqual({ settings: { modules: { baby: false } }, moved: ["baby"] });
    // Without the module, the switch is the checkouts' that have it: left in the file, the rest moved round it.
    expect(moveSwitches({ aspects: { inspirations: true, baby: true } }, ["inspirations"])).toEqual({
      settings: { aspects: { baby: true }, modules: { inspirations: true } },
      moved: ["inspirations"],
    });
    expect(moveSwitches({ owner: { name: "Riley" }, aspects: { baby: false } }, [])).toBeNull();
  });

  it("leaves a module already switched in modules as it is switched there", () => {
    expect(moveSwitches({ aspects: { inspirations: true }, modules: { inspirations: false } }, [])?.settings).toEqual({ modules: { inspirations: false } });
  });

  it("moves nothing from settings that name none, or that loadSettings would refuse anyway", () => {
    for (const written of [{}, { aspects: { garden: true } }, [], "aspects", { aspects: "shopping" }, { aspects: { shopping: true }, modules: [] }]) {
      expect(moveSwitches(written, ["baby"]), JSON.stringify(written)).toBeNull();
    }
  });

  it("is written into the archive's settings.json once, and says so", async () => {
    await writeFile(file, JSON.stringify({ pages: "all", aspects: { inspirations: true } }));
    expect(upgradeMovedSwitches(file, [])).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ pages: "all", modules: { inspirations: true } });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`"aspects": {"inspirations"} is now "modules": {"inspirations"}`));
    expect(upgradeMovedSwitches(file, [])).toBe(false);
  });

  it("never writes Baby's switch from a checkout without the module, and moves it from one with it", async () => {
    const written = JSON.stringify({ aspects: { baby: false } });
    await writeFile(file, written);
    expect(upgradeMovedSwitches(file, [])).toBe(false);
    expect(await readFile(file, "utf8")).toBe(written);
    expect(upgradeMovedSwitches(file, ["baby"])).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ modules: { baby: false } });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`"aspects": {"baby"} is now "modules": {"baby"}`));
  });

  it("leaves a settings.json missing, or one that is not JSON, for loadSettings to say", async () => {
    expect(upgradeMovedSwitches(file, [])).toBe(false);
    await writeFile(file, "{");
    expect(upgradeMovedSwitches(file, [])).toBe(false);
    expect(await readFile(file, "utf8")).toBe("{");
  });
});
