// Puts a fixture export where the captain puts a real one: its zips in an
// export folder (data/platform-exports/<platform>/<export date>/ in a data
// folder, or any folder for a connector read on its own), unpacked there,
// since an export's media are kept in place and must be files.

import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { unpackExport } from "../server/platformExports.ts";
import { MESSENGER_SAMPLE } from "./make-fixtures.ts";

/** Copies the zips into `folder`, unpacks them there, and returns the folder. */
export async function unpackedExport(zips: string | string[], folder: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  for (const zip of [zips].flat()) await copyFile(zip, join(folder, basename(zip)));
  await unpackExport(folder);
  return folder;
}

/** An export's folder in a data folder: data/platform-exports/<platform>/<date>/. */
export function exportFolder(dataDir: string, platform: string, date: string): string {
  return join(dataDir, "platform-exports", platform, date);
}

/** The sample Messenger export (data/messenger/messages.zip), unpacked as the captain keeps an export: in data/platform-exports/messenger/2026-09-27/. */
export function sampleMessengerExport(dataDir: string): Promise<string> {
  return unpackedExport(MESSENGER_SAMPLE, exportFolder(dataDir, "messenger", "2026-09-27"));
}
