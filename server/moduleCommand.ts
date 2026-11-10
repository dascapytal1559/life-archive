// A module's own command, for a module with no npm script of its own (docs/modules.md's "Private modules": one cloned
// in, which no tracked file names):
//
//   npm run module -- <id> [its arguments]     runs modules/<id>/cli.ts, which sees only its own arguments
//
// The pinned Node, the archive's folder its --data names and the settings are taken first, as every entry point takes
// them (sdk/command.ts, which the module's cli.ts imports first too), so a settings file that cannot be used stops it
// before any module's code runs. A module this repository ships keeps its own npm script (`npm run health`).

import "./onPinnedNode.ts";
import "./onDataFlag.ts";
import "./onSettings.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installedModules } from "./modules/installed.ts";

const id = process.argv[2];
const installed = installedModules();
const found = installed.find((m) => m.id === id);

if (!found) {
  const have = installed.length === 0 ? "none is installed" : `the installed modules are ${installed.map((m) => m.id).join(", ")}`;
  console.error(`${id === undefined ? "Name a module" : `No module ${id} is installed`}: npm run module -- <id> [its arguments] (${have}).`);
  process.exit(1);
}
const cli = join(found.folder, "cli.ts");
if (!existsSync(cli)) {
  console.error(`The module ${found.id} has no command of its own (no modules/${found.id}/cli.ts).`);
  process.exit(1);
}
// The module's command reads its arguments from process.argv as if it were run alone.
process.argv.splice(2, 1);
await import(pathToFileURL(cli).href);
