import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { archiveFolder, archiveUrl, envSetting, REPO } from "./dataHome.ts";
import { loadSettings, moduleSettingsOf, SETTINGS_FILE, SettingsProblem, writeMovedSwitches } from "./settings.ts";

let folder: string;
const load = () => loadSettings(folder, { root: folder, env: {} });
const write = (settings: unknown) => writeFile(join(folder, SETTINGS_FILE), typeof settings === "string" ? settings : JSON.stringify(settings));

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-archive-settings-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("the settings", () => {
  it("are a stranger's defaults with no file", () => {
    const machine = Intl.DateTimeFormat().resolvedOptions();
    expect(load()).toEqual({
      timeZone: machine.timeZone,
      locale: machine.locale,
      phoneCountry: null,
      owner: { name: "Me" },
      nasBackup: { hosts: ["nas"], repository: null, folders: [] },
      vault: { folder: "Vault" },
      llmSessions: { projects: [] },
      cua: { agent: "friend-map-exports" },
      maps: { regions: {} },
      pages: "ready",
      modules: {},
      moduleSettings: {},
    });
  });

  it("switch a module by name, every other by its ready mark (src/pages.ts)", async () => {
    await write({ modules: { health: false } });
    expect(load().modules).toEqual({ health: false });
    await write({ modules: { health: "off" } });
    expect(load).toThrow(SettingsProblem);
    await write({ pages: "every" });
    expect(load).toThrow(SettingsProblem);
  });

  it("read the switch of a core page that is a module now as its module's in the archive's own file, leaving the file as it is", async () => {
    const written = JSON.stringify({ aspects: { inspirations: true, shopping: false }, modules: { health: false } });
    await write(written);
    expect(load().modules).toEqual({ health: false, inspirations: true, shopping: false });
    expect(await readFile(join(folder, SETTINGS_FILE), "utf8")).toBe(written);
    await write({ aspects: {} });
    expect(load().modules).toEqual({});
  });

  it("refuse the switch of a core page that is a module now in a file LIFE_ARCHIVE_SETTINGS names, saying where it went, and `aspects` with nothing it knows", async () => {
    const named = () => loadSettings(folder, { root: folder, env: { LIFE_ARCHIVE_SETTINGS: SETTINGS_FILE } });
    await write({ aspects: { inspirations: true } });
    expect(named).toThrow(/"aspects": \{"inspirations"\} is a module's switch now: write "modules": \{"inspirations": true\} instead/);
    await write({ aspects: { shopping: false } });
    expect(named).toThrow(/"aspects": \{"shopping"\} is a module's switch now: write "modules": \{"shopping": false\} instead/);
    await write({ aspects: {} });
    expect(named).toThrow(/"aspects" is no setting any more: every page it switched is a module now, switched in "modules"/);
  });

  it("are written back with the moved switches by the archive's server alone (writeMovedSwitches), into the archive's own file", async () => {
    vi.stubEnv("LIFE_ARCHIVE_DATA", folder);
    vi.stubEnv("LIFE_ARCHIVE_SETTINGS", undefined);
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await write({ owner: { name: "Riley" }, aspects: { shopping: false } });
      expect(writeMovedSwitches()).toBe(true);
      expect(JSON.parse(await readFile(join(folder, SETTINGS_FILE), "utf8"))).toEqual({ owner: { name: "Riley" }, modules: { shopping: false } });
      expect(writeMovedSwitches()).toBe(false);
    } finally {
      said.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("leave a private module's settings to the checkouts that have it, saying so, and read them where it is installed", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await write({ owner: { name: "Riley" }, aspects: { baby: false }, baby: { notesFolder: "Notes" }, modules: { baby: false } });
      const without = load();
      expect(without.owner.name).toBe("Riley");
      expect(without.moduleSettings).toEqual({});
      expect(said).toHaveBeenCalledWith(expect.stringContaining(`"aspects": {"baby"}, "baby" are settings of a module this checkout does not have, so they are left as written and not read here`));
      // A section of a module the file switches, which this checkout does not have, is another checkout's too.
      await write({ modules: { garden: false }, garden: { plots: [] } });
      expect(load().moduleSettings).toEqual({});
      // With Baby installed, its section is its own, and its old switch its module's, or refused in a file named, saying where it goes.
      await mkdir(join(folder, "modules", "baby"), { recursive: true });
      await writeFile(join(folder, "modules", "baby", "package.json"), JSON.stringify({ lifeArchive: true }));
      await write({ baby: { notesFolder: "Notes" } });
      expect(load().moduleSettings).toEqual({ baby: { notesFolder: "Notes" } });
      await write({ aspects: { baby: false } });
      expect(load().modules).toEqual({ baby: false });
      expect(() => loadSettings(folder, { root: folder, env: { LIFE_ARCHIVE_SETTINGS: SETTINGS_FILE } })).toThrow(/"aspects": \{"baby"\} is a module's switch now: write "modules": \{"baby": false\} instead/);
    } finally {
      said.mockRestore();
    }
  });

  it("still refuse what a private module's switch is beside: `aspects` it does not know, and a key no setting or switch names", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await write({ aspects: { baby: true, garden: true } });
      expect(load).toThrow(/"aspects" is no setting any more/);
      await write({ baby: { notesFolder: "Notes" }, timezone: "Asia/Tokyo" });
      expect(load).toThrow(/"timezone" is no setting of the core's/);
    } finally {
      said.mockRestore();
    }
  });

  it("take what the file names, and a default for each key it does not", async () => {
    await write({ timeZone: "Asia/Tokyo", owner: { name: "Riley" } });
    const settings = load();
    expect(settings.timeZone).toBe("Asia/Tokyo");
    expect(settings.owner.name).toBe("Riley");
    expect(settings.vault.folder).toBe("Vault");
  });

  it("take a key naming an installed module as that module's own, for it to read as strictly", async () => {
    // A made-up module installed in the folder taken for the checkout.
    await mkdir(join(folder, "modules", "garden"), { recursive: true });
    await writeFile(join(folder, "modules", "garden", "package.json"), JSON.stringify({ lifeArchive: true }));
    await write({ owner: { name: "Riley" }, garden: { plots: ["north"] } });
    const settings = load();
    expect(settings.moduleSettings).toEqual({ garden: { plots: ["north"] } });
    expect("garden" in settings).toBe(false);
    const Garden = Schema.Struct({ plots: Schema.Array(Schema.String) });
    expect(moduleSettingsOf("garden", Garden, settings)).toEqual({ plots: ["north"] });
    // Its section left out is {}, so a schema with defaults reads its defaults, and one without says what is missing.
    expect(() => moduleSettingsOf("garden", Garden, { ...settings, moduleSettings: {} })).toThrow(/the settings' "garden"/);
    // A key its schema does not know is refused, as the core's are.
    await write({ garden: { plots: ["north"], plotz: [] } });
    expect(() => moduleSettingsOf("garden", Garden, load())).toThrow(SettingsProblem);
    // A key naming neither a setting nor an installed module stops it, naming the key.
    await write({ gardne: { plots: [] } });
    expect(load).toThrow(/"gardne" is no setting of the core's, and no module gardne is installed \(the installed modules are garden\)/);
  });

  it("stop at a file that cannot be used, rather than run on defaults its owner did not choose", async () => {
    for (const wrong of ["{", { timezone: "Asia/Tokyo" }, { owner: { nickname: "Riley" } }, { timeZone: "Mars/Olympus" }, { locale: "not a locale" }, { phoneCountry: "+61" }, { nasBackup: { hosts: "nas" } }]) {
      await write(wrong);
      expect(load, JSON.stringify(wrong)).toThrow(SettingsProblem);
    }
  });

  it("name the key that no setting has", async () => {
    await write({ timezone: "Asia/Tokyo" });
    expect(load).toThrow(/timezone/);
  });

  it("are read from LIFE_ARCHIVE_SETTINGS when it names a file, which must be there", async () => {
    await writeFile(join(folder, "other.json"), JSON.stringify({ owner: { name: "Riley" } }));
    await write({ owner: { name: "Ignored" } });
    expect(loadSettings(folder, { root: folder, env: { LIFE_ARCHIVE_SETTINGS: "other.json" } }).owner.name).toBe("Riley");
    expect(() => loadSettings(folder, { root: folder, env: { LIFE_ARCHIVE_SETTINGS: "missing.json" } })).toThrow(SettingsProblem);
  });

  it("are each a row of docs/settings.md's table, and testing-data/settings.json is a sound file", async () => {
    const doc = await readFile(join(REPO, "docs", "settings.md"), "utf8");
    const paths = (group: object, prefix = ""): string[] =>
      Object.entries(group).flatMap(([key, value]) => (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 ? paths(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
    // A module's own settings are its README's, not this table's.
    const { moduleSettings: _modules, ...core } = load();
    expect([...doc.matchAll(/^\| `([^`]+)` \|/gm)].map(([, key]) => key).sort()).toEqual(paths(core).sort());
    expect(loadSettings(folder, { root: REPO, env: { LIFE_ARCHIVE_SETTINGS: "testing-data/settings.json" } }).phoneCountry).toBe("61");
  });
});

describe(".env.example", () => {
  it("is a .env.local that changes nothing, its lines uncommented", async () => {
    const example = await readFile(join(REPO, ".env.example"), "utf8");
    const before = { url: archiveUrl({ root: folder, env: {} }), data: archiveFolder({ root: folder, env: {} }) };
    await writeFile(join(folder, ".env.local"), example.split("\n").map((line) => line.replace(/^# ([A-Z_]+=)/, "$1")).join("\n"));
    expect({ url: archiveUrl({ root: folder, env: {} }), data: archiveFolder({ root: folder, env: {} }) }).toEqual(before);
    expect(envSetting("POLAR_LOGIN_PORT", { root: folder, env: {} })).toBe("4655");
    expect(envSetting("CUA_BRIDGE_PORT", { root: folder, env: {} })).toBe("4656");
  });
});
