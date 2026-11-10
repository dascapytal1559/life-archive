// Reads your settings file, data/settings.json (see src/settings.ts
// for the keys). A missing file means the defaults; a file that isn't valid
// JSON, or a key that is wrong, means the defaults for what it got wrong, with
// a problem naming it. Read afresh on every request, so an edit applies the
// next time the page loads.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closenessSettings, parseSettings, type ClosenessSettings, type SettingsReport } from "../../page/src/settings.ts";
import { isMissingFile } from "../../../../sdk/server.ts";

export function settingsFile(dataDir: string): string {
  return join(dataDir, "settings.json");
}

export async function readSettings(dataDir: string): Promise<SettingsReport> {
  let text: string;
  try {
    text = await readFile(settingsFile(dataDir), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return parseSettings(undefined);
    throw error;
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const report = parseSettings(undefined);
    return { ...report, problems: [`is not valid JSON (${(error as Error).message}); using the defaults`] };
  }
  return parseSettings(input);
}

/** The settings the closeness score is worked out with (the defaults for any missing or wrong), read at once: for the People table's Closeness. */
export function closenessSettingsNow(dataDir: string): ClosenessSettings {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(settingsFile(dataDir), "utf8"));
  } catch (error) {
    if (!isMissingFile(error) && !(error instanceof SyntaxError)) throw error;
    input = undefined;
  }
  return closenessSettings(parseSettings(input).settings);
}
