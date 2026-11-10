// Imported after onPinnedNode.ts and before onSettings.ts by each entry point that takes --data <dir>: the folder named
// is the archive's folder for this process and those it starts, so the settings read are that folder's.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(2), options: { data: { type: "string" } }, strict: false, allowPositionals: true });
if (typeof values.data === "string") process.env.LIFE_ARCHIVE_DATA = resolve(values.data);
