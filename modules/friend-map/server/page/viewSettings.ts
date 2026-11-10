// Your saved view settings, data/view-settings.json (see
// src/savedSettings.ts for what they are): the Spider web's settings and the
// Reach-out glow, as last chosen on any browser or the phone, each as the page
// keeps it.
//
//   { "names": "initial", "web.spokes": "14" }
//
// A missing file, or one that is not valid JSON, is no setting chosen; a value
// that is not one of its setting's own is left out, and so is a setting no
// longer kept (Name placement's "name-placement", gone since names always
// stand in for their icons), which a page still open from before may send and
// is let pass unsaved. Written by the page (PUT
// /api/view-settings, one change at a time in the order sent, each replacing
// the file whole), read afresh for every page served (savedSettingsPlugin.ts)
// and on GET /api/view-settings, and built into the demo as its defaults.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanSaved, SAVED_SETTINGS, savedAllowed, type SavedName, type SavedSettings } from "../../page/src/savedSettings.ts";
import { InvalidInputError } from "../../page/src/invalidInput.ts";
import { atomicWrite, isMissingFile } from "../../../../sdk/server.ts";

export function viewSettingsFile(dataDir: string): string {
  return join(dataDir, "view-settings.json");
}

/** The saved set: none chosen when there is no file, or it is not valid JSON. */
export async function readViewSettings(dataDir: string): Promise<SavedSettings> {
  let text: string;
  try {
    text = await readFile(viewSettingsFile(dataDir), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
  try {
    return cleanSaved(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Settings once saved and no longer kept: a page still open from before may send one, and it is let pass unsaved. */
const RETIRED = new Set(["name-placement"]);

/** The changes a page sent: saved settings, each to one of its own values, or null to forget it. */
function changesIn(input: unknown): Partial<Record<SavedName, string | null>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InvalidInputError("expected an object of settings");
  const changes: Partial<Record<SavedName, string | null>> = {};
  for (const [name, value] of Object.entries(input)) {
    if (RETIRED.has(name)) continue;
    if (!(SAVED_SETTINGS as readonly string[]).includes(name)) throw new InvalidInputError(`${name} is not a saved setting`);
    if (value !== null && !savedAllowed(name as SavedName, value)) throw new InvalidInputError(`${JSON.stringify(value)} is not a value of ${name}`);
    changes[name as SavedName] = value;
  }
  return changes;
}

let writing: Promise<unknown> = Promise.resolve();

/** Saves `input`'s changes over the saved set, after any still being saved, and answers the set saved. */
export async function saveViewSettings(dataDir: string, input: unknown): Promise<SavedSettings> {
  const changes = changesIn(input);
  const saving = writing.then(async () => {
    const saved: SavedSettings = await readViewSettings(dataDir);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) delete saved[name as SavedName];
      else saved[name as SavedName] = value;
    }
    const path = viewSettingsFile(dataDir);
    await mkdir(dataDir, { recursive: true });
    await atomicWrite(path, `${JSON.stringify(cleanSaved(saved), null, 2)}\n`);
    return cleanSaved(saved);
  });
  writing = saving.catch(() => undefined);
  return saving;
}
