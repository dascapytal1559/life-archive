// The archive's owner's settings: everything about one person's archive that is not code, so the code holds nothing of
// theirs. Two files, both outside what git keeps (docs/settings.md lists every key and its default):
//
//   .env.local                   addresses and paths on this machine, read by envSetting (dataHome.ts); .env.example
//                                lists every key
//   settings.json                in the archive's folder, for the values with a shape: read here, once, against the schema
//                                below, which holds every default. It travels with the archive and its backups.
//
// A stranger's copy runs with no settings.json at all, on the defaults. A file that is there and wrong stops the process
// with what is wrong, a key no setting has among it, since a value misspelled would otherwise show a default without a
// word. A module keeps its own settings in settings.json too, under its id (`"garden": {...}` for a module garden): the core
// takes a key it does not know that names an installed module as that module's, and the module reads it against its own
// schema, as strictly (moduleSettingsOf). LIFE_ARCHIVE_SETTINGS names another file to read instead (the tests name
// testing-data/settings.json).
//
// `settings()` is the running process's settings, read once. onSettings.ts, imported early by each entry point, applies
// the ones the plain code needs before anything else loads (the clock in src/time.ts, the phone country in names.ts).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Data, Effect, Schema } from "effect";
import { archiveFolder, pathSetting, REPO } from "./dataHome.ts";
import { isMissingFile } from "./files.ts";
import { installedModules } from "./modules/installed.ts";
import { PAGE_CHOICES } from "../src/pages.ts";
import { movedSwitchProblem, moveSwitches, PAGES_NOW_PRIVATE, upgradeMovedSwitches, withoutAbsentSwitches } from "./movedSwitchUpgrade.ts";
import { upgradeToReadyPages } from "./readyPagesUpgrade.ts";

/** The settings' file, in the archive's folder. */
export const SETTINGS_FILE = "settings.json";

/** `self`, or `fallback` when its key is left out. */
const orElse = <S extends Schema.Constraint>(self: S, fallback: () => S["Encoded"]) => Schema.withDecodingDefaultKey<S>(Effect.sync(fallback))(self);

const Names = Schema.Array(Schema.String);

/** A folder backed up beside the archive's: its path (~/ is the home folder), what is left out of it, a database in it. */
const BackupFolder = Schema.Struct({
  folder: Schema.String,
  exclude: orElse(Names, () => []),
  database: Schema.optionalKey(Schema.String),
});

/** The owner's name when settings.json sets none. */
export const DEFAULT_OWNER = "Me";

const MapRegion = Schema.Struct({ name: Schema.String, bbox: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]) });

const SettingsSchema = Schema.Struct({
  /** The IANA zone the archive's days are reckoned in: the machine's unless said, and fixed once an archive is built (db.ts). */
  timeZone: orElse(Schema.String, () => Intl.DateTimeFormat().resolvedOptions().timeZone),
  /** The BCP 47 locale numbers and dates are written in: the machine's unless said. */
  locale: orElse(Schema.String, () => Intl.DateTimeFormat().resolvedOptions().locale),
  /** The country calling code a local number (0 and nine digits) is read in, "61"; left as written unless said. */
  phoneCountry: orElse(Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{1,3}$/))), () => null),
  owner: orElse(Schema.Struct({
    /** The owner's name, as the agents' start_here names the archive ("Riley's life archive"); DEFAULT_OWNER when unset, which names nobody. */
    name: orElse(Schema.String, () => DEFAULT_OWNER),
  }), () => ({})),
  nasBackup: orElse(Schema.Struct({
    /** The ssh hosts (~/.ssh/config) the NAS is tried at, in order. */
    hosts: orElse(Names, () => ["nas"]),
    /** The restic repository on the NAS, from its user's home; unset, there is no NAS backup. */
    repository: orElse(Schema.NullOr(Schema.String), () => null),
    /** Folders backed up beside the archive's. */
    folders: orElse(Schema.Array(BackupFolder), () => []),
  }), () => ({})),
  vault: orElse(Schema.Struct({
    /** The captain's Obsidian vault's folder in the archive's folder (the journal module's), which the voice journals' transcription writes into and the NAS leaves out. */
    folder: orElse(Schema.String, () => "Vault"),
  }), () => ({})),
  llmSessions: orElse(Schema.Struct({
    /** The projects the llm-sessions connector reads when its own settings name none. */
    projects: orElse(Names, () => []),
  }), () => ({})),
  cua: orElse(Schema.Struct({
    /** The Cua persistent agent, and its browser profile, the exports' rounds run as. */
    agent: orElse(Schema.String, () => "friend-map-exports"),
  }), () => ({})),
  maps: orElse(Schema.Struct({
    /** The regions `npm run map -- download <region>` knows, by id: each one's name in words and its box [west, south, east, north]. */
    regions: orElse(Schema.Record(Schema.String, MapRegion), () => ({})),
  }), () => ({})),
  /** Which pages are on when not switched by name: "ready", the pages ready for anyone (src/pages.ts), or "all", every page. */
  pages: orElse(Schema.Literals(PAGE_CHOICES), () => "ready" as const),
  /** Each module's switch, by id ({"health": false}); a module not named follows `pages` and its ready mark, and one named must be installed (server/modules/loader.ts). */
  modules: orElse(Schema.Record(Schema.String, Schema.Boolean), () => ({})),
});

/** The core's keys of settings.json: any other must name an installed module, and is that module's own. */
const CORE_KEYS: ReadonlySet<string> = new Set(Object.keys(SettingsSchema.fields));

export type Settings = typeof SettingsSchema.Type & {
  /**
   * Each installed module's own settings, by its id: the top-level key settings.json names it by, as written, which the
   * module reads against its own schema (moduleSettingsOf; docs/settings.md's "A module's own settings").
   */
  readonly moduleSettings: Readonly<Record<string, unknown>>;
};

/** A settings file that cannot be used, in words: it stops the process rather than run on defaults its owner did not choose. */
export class SettingsProblem extends Data.TaggedError("SettingsProblem")<{ readonly message: string }> {}

/** Where the settings of the archive kept at `folder` are read from: LIFE_ARCHIVE_SETTINGS (the environment, then .env.local), else its settings.json. */
function settingsFile(folder: string, options: { root?: string; env?: NodeJS.ProcessEnv }): { file: string; named: boolean } {
  const named = pathSetting("LIFE_ARCHIVE_SETTINGS", options);
  if (!named) return { file: join(folder, SETTINGS_FILE), named: false };
  return { file: resolve(options.root ?? REPO, named), named: true };
}

/** The settings of the archive kept at `folder`, every key not named at its default; SettingsProblem when its file cannot be used. */
export function loadSettings(folder: string, options: { root?: string; env?: NodeJS.ProcessEnv } = {}): Settings {
  const { file, named } = settingsFile(folder, options);
  let text = "{}";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (named || !isMissingFile(error)) throw new SettingsProblem({ message: `${file} could not be read: ${(error as Error).message}` });
  }
  let written: unknown;
  try {
    written = JSON.parse(text);
  } catch (error) {
    throw new SettingsProblem({ message: `${file} is not JSON: ${(error as Error).message}` });
  }
  // A key the core does not know that names an installed module is that module's own, for it to check; any other is
  // left for the schema to refuse, so a key misspelled still stops the process.
  const moduleSettings: Record<string, unknown> = {};
  if (typeof written === "object" && written !== null && !Array.isArray(written)) {
    const installed = installedModules(options.root ?? REPO, options.env).map((m) => m.id);
    // The archive's own settings.json, read with the switches of the pages that became modules moved, in memory: only
    // the archive's server writes that back (writeMovedSwitches), so no other checkout's process rewrites the file.
    const given: Record<string, unknown> = (named ? null : moveSwitches(written, installed)?.settings) ?? (written as Record<string, unknown>);
    const core: Record<string, unknown> = {};
    // The core pages' switches, which every page that had one left for `modules` as it became a module; a private
    // module's, in a checkout without it, is the other checkouts' (movedSwitchUpgrade.ts).
    const { aspects, absent } = withoutAbsentSwitches(given.aspects, installed);
    const moved = movedSwitchProblem(aspects, installed);
    if (moved) throw new SettingsProblem({ message: `${file} is not what docs/settings.md describes: ${moved}` });
    const ignored = absent.map((id) => `"aspects": {"${id}"}`);
    // settings.json is every checkout's: a section of a module another checkout has (a private module's, or one
    // switched in `modules`) is left to it.
    const switched = given.modules;
    const moduleOf = (key: string) => key in PAGES_NOW_PRIVATE || (typeof switched === "object" && switched !== null && !Array.isArray(switched) && key in switched);
    for (const [key, value] of Object.entries(given)) {
      if (key === "aspects") continue;
      if (CORE_KEYS.has(key)) core[key] = value;
      else if (installed.includes(key)) moduleSettings[key] = value;
      else if (moduleOf(key)) ignored.push(`"${key}"`);
      else {
        const have = installed.length === 0 ? "none is installed" : `the installed modules are ${installed.join(", ")}`;
        throw new SettingsProblem({ message: `${file} is not what docs/settings.md describes: "${key}" is no setting of the core's, and no module ${key} is installed (${have})` });
      }
    }
    if (ignored.length > 0) console.error(`${file}: ${ignored.join(", ")} ${ignored.length === 1 ? "is a setting" : "are settings"} of a module this checkout does not have, so ${ignored.length === 1 ? "it is" : "they are"} left as written and not read here (docs/settings.md)`);
    written = core;
  }
  let settings: Settings;
  try {
    settings = { ...Schema.decodeUnknownSync(SettingsSchema)(written, { onExcessProperty: "error" }), moduleSettings };
  } catch (error) {
    throw new SettingsProblem({ message: `${file} is not what docs/settings.md describes: ${(error as Error).message}` });
  }
  try {
    new Intl.DateTimeFormat(settings.locale, { timeZone: settings.timeZone });
  } catch (error) {
    throw new SettingsProblem({ message: `${file}: ${(error as Error).message}` });
  }
  return settings;
}

/**
 * The module `id`'s own settings in `from` (this process's, unless given), read against its `schema`, as strictly as the
 * core's: a key the schema does not know is refused, so a misspelt one never leaves a default standing without a word.
 * Its section left out is `{}`, every key at its default. SettingsProblem when the section is not what the schema says.
 */
export function moduleSettingsOf<S extends Schema.Decoder<unknown>>(id: string, schema: S, from: Settings = settings()): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(from.moduleSettings[id] ?? {}, { onExcessProperty: "error" });
  } catch (error) {
    throw new SettingsProblem({ message: `the settings' "${id}", the ${id} module's own, is not what its README describes: ${(error as Error).message}` });
  }
}

/** The file this process's settings are read from: LIFE_ARCHIVE_SETTINGS's, else settings.json in the archive's folder (for a command that rewrites it, as a module's migration of its own keys does). */
export const settingsPath = (): string => settingsFile(archiveFolder(), {}).file;

let read: Settings | undefined;

/**
 * This process's settings: its archive's, read once, after the upgrade to ready pages when they are its own
 * settings.json (readyPagesUpgrade.ts); the switches of the pages that became modules are moved as they are read
 * (loadSettings), and written back by the archive's server alone (writeMovedSwitches).
 */
export const settings = (): Settings => {
  if (read) return read;
  const folder = archiveFolder();
  const { file, named } = settingsFile(folder, {});
  if (!named) upgradeToReadyPages(folder, file);
  return (read = loadSettings(folder));
};

/**
 * Writes the switches of the pages that became modules into `modules` of the archive's own settings.json, as
 * loadSettings reads them (movedSwitchUpgrade.ts): the archive's server's alone (main.ts), as it runs the code its
 * archive is read with; true when it wrote. A file LIFE_ARCHIVE_SETTINGS names is left alone.
 */
export function writeMovedSwitches(): boolean {
  const { file, named } = settingsFile(archiveFolder(), {});
  return !named && upgradeMovedSwitches(file, installedModules().map((m) => m.id));
}
