// The polar connector's settings, data/connectors/polar.json in the archive's folder; never a secret (secrets.ts):
//
//   {
//     "enabled": true,                          the server polls Polar while it is on (login switches it on)
//     "memberId": "life-archive-1a2b3c4d",      the archive's own id for the captain, which login registered with Polar
//     "trustedHeartRate": [                     set by hand, by the captain: whose heart rate the Health tab trusts
//       {"device": "Polar Flow app", "sensor": "Polar H10"}
//     ],
//     "pollEveryHours": 3                       how often the server looks (3 unless said)
//   }
//
// A rule of trustedHeartRate names a recorder as Polar names it (the exercise's `device`); its heart rate is trusted,
// and `sensor`, when given, is what the page calls it. Polar never says which sensor a heart rate came from (the Flow
// app reports itself), so this is the captain's word, not the code's guess: for whoever pairs only a chest strap with the
// app, say, the app's heart rate is the strap's, and a watch (which names itself) stays untrusted. Two settings only the tests set: `source`, the AccessLink to ask
// (a made-up one), and `keychain`, a keychain file of their own.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite, isMissingFile } from "../../../../sdk/server.ts";
import { manifest } from "./manifest.ts";

export const SETTINGS_ID = "polar";

/** How often the server looks at Polar, unless the settings say (`pollEveryHours`): its manifest's cadence, which the Sources tab shows. */
export const POLL_EVERY_HOURS = (manifest.cadence as { everyMs: number }).everyMs / 3_600_000;

/** The settings file in the archive's folder `dataDir`. */
export function settingsFile(dataDir: string): string {
  return join(dataDir, "connectors", `${SETTINGS_ID}.json`);
}

/** The settings, {} when there is no file. */
export async function readSettings(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

/** Sets some of the settings, keeping the rest. */
export async function updateSettings(file: string, change: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...(await readSettings(file)), ...change };
  await mkdir(dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** How often to poll, in milliseconds, from the settings. */
export function pollEveryMs(config: Record<string, unknown>): number {
  const hours = typeof config.pollEveryHours === "number" && config.pollEveryHours > 0 ? config.pollEveryHours : POLL_EVERY_HOURS;
  return Math.round(hours * 3_600_000);
}
