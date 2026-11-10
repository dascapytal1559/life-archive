// The Fitness page's settings, kept in the module's folder of the archive's folder as modules/exercise/exercise.json
// (or exercise.json at its root, where an archive kept it before modules kept their files in theirs, until
// `npm run archive -- migrate module-data` moves it: SETTINGS_MOVE), which only its owner edits:
//
//   { "zone2WeeklyMinutes": 300,     the weekly zone 2 target: minutes in zone 2 each week, Monday to Sunday, local
//     "liftWeeklySessions": 3,       the Bryan Johnson tab's Strength Training target: gym sessions a week
//     "hiitWeeklyMinutes": 20,       and its High Intensity Cardio target: minutes in heart-rate zones 4 and 5 a week
//     "heartRateZones": {            the zones every activity's time in zones is counted by (zones.ts), in place of Polar's:
//       "source": "a clinic, May 2026",   where they came from, for the pages to say
//       "zone2": 110, "zone3": 128, "zone4": 146, "zone5": 160 } }   the heart rate (bpm) each zone starts at
//
// Read afresh with every answer, so a change shows on the page's next load. With no file, or no target in it, the page
// counts against none and says where to set one; a target that is not a number above 0 is said so too. With no zones,
// or zones that are not four rising numbers above 0, Polar's own zones are kept, and the pages say why.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { isMissingFile, movedPath, type ModuleMove } from "../../../sdk/server.ts";
import type { PillarTargets, WeeklyTarget, Zone2Target, ZoneSettings } from "../wire.ts";

/** The settings' file, from the archive's folder, where a new archive keeps it. */
export const EXERCISE_SETTINGS = "modules/exercise/exercise.json";

/** The settings' file's move, from the archive's folder's root into the module's folder (the module's `moves`). */
export const SETTINGS_MOVE: ModuleMove = { from: "exercise.json", to: "exercise.json" };

/** Where the settings are read: the module's folder's exercise.json, or the root's while it is there (SETTINGS_MOVE). */
export const settingsFile = (dataDir: string): string => movedPath(dataDir, "exercise", SETTINGS_MOVE);

/** Writes the settings' file where it is read (the testing data's, a test's): `text` as it is, so a test may write one that is not JSON. */
export async function writeExerciseSettings(dataDir: string, text: string): Promise<void> {
  const file = settingsFile(dataDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Each weekly target's key in the file, and what it counts. */
const TARGETS = { zone2: ["zone2WeeklyMinutes", "minutes"], lift: ["liftWeeklySessions", "sessions"], hiit: ["hiitWeeklyMinutes", "minutes"] } as const;

/** What was read: the file's settings (none set, with no file), or why they cannot be read; and the file, from the archive's folder, for what is said of it. */
type Read = ({ settings: Record<string, unknown> } | { why: string }) & { file: string };

/** The file's settings, as Read says. */
async function readSettings(dataDir: string): Promise<Read> {
  const path = settingsFile(dataDir);
  const file = relative(dataDir, path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return isMissingFile(error) ? { settings: {}, file } : { why: `${file} cannot be read`, file };
  }
  try {
    const settings: unknown = JSON.parse(text);
    return { settings: typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {}, file };
  } catch {
    return { why: `${file} is not JSON`, file };
  }
}

const notSet = (key: string, file: string) => `no target is set: put "${key}" in the archive's ${file}`;

/** The target `key` sets in what was read, counted in `unit`: its amount, or why there is none. */
function targetIn(read: Read, [key, unit]: readonly [string, string]): WeeklyTarget {
  if ("why" in read) return { amount: null, why: read.why };
  const amount = read.settings[key];
  if (amount === undefined) return { amount: null, why: notSet(key, read.file) };
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return { amount: null, why: `${read.file}'s ${key} is not a number of ${unit} above 0` };
  return { amount };
}

/** Every weekly target the archive kept at `dataDir` sets, each with why it is missing when it is. */
export async function pillarTargets(dataDir: string): Promise<PillarTargets> {
  const read = await readSettings(dataDir);
  return { zone2: targetIn(read, TARGETS.zone2), lift: targetIn(read, TARGETS.lift), hiit: targetIn(read, TARGETS.hiit) };
}

/** The key of the zones in the file, and of each zone's start in them. */
const ZONES = "heartRateZones";
const ZONE_KEYS = ["zone2", "zone3", "zone4", "zone5"] as const;

/** The heart-rate zones the archive kept at `dataDir` sets: where zones 2 to 5 start and where they came from, or why there are none. */
export async function heartRateZones(dataDir: string): Promise<ZoneSettings> {
  const read = await readSettings(dataDir);
  if ("why" in read) return { starts: null, why: read.why };
  const zones = read.settings[ZONES];
  if (zones === undefined) return { starts: null, why: `no zones are set: put "${ZONES}" in the archive's ${read.file}` };
  const wrong = `${read.file}'s ${ZONES} is not ${ZONE_KEYS.join(", ")} as rising heart rates above 0`;
  if (typeof zones !== "object" || zones === null) return { starts: null, why: wrong };
  const { source, ...set } = zones as Record<string, unknown>;
  const starts = ZONE_KEYS.map((key) => set[key]);
  if (!starts.every((bpm, i): bpm is number => typeof bpm === "number" && Number.isFinite(bpm) && bpm > 0 && (i === 0 || bpm > (starts[i - 1] as number)))) {
    return { starts: null, why: wrong };
  }
  return { starts, source: typeof source === "string" && source.trim() !== "" ? source.trim() : read.file };
}

/** The weekly zone 2 target, as the Fitness page reads it: its minutes, or why there is none. */
export async function zone2Target(dataDir: string): Promise<Zone2Target> {
  const target = (await pillarTargets(dataDir)).zone2;
  return target.amount === null ? { minutes: null, why: target.why } : { minutes: target.amount };
}
