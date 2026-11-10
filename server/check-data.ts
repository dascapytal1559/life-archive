// Checks the captain's data the way the app reads it, without the server:
//
//   npm run check-data                 checks the archive's folder (see dataHome.ts)
//   node server/check-data.ts <dir>    checks the archive in <dir>
//
// Each module's own checks over its database, opened read-only (sdk/server.ts's `checkData`: friend map's people,
// tags, locations, catch-ups, logged calls and call notes, modules/friend-map/server/checkData.ts; the inspirations'
// canonical links, captions, saves, kept files, and both kinds of tags, modules/inspirations/server/store.ts). Prints one line per problem and a summary, and exits 0 when all is fine, 1 when something needs
// fixing, and 2 when there is nothing to check (no archive), the archive can't be read, a module is broken, or a module
// with checks has no database in the folder (said so by name: friend map's people unchecked is never "all fine"). A
// module switched off is not loaded, so not checked, and the summary names it so.

import "./onPinnedNode.ts";
import "./onDataArgument.ts";
import "./onSettings.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CORE_FILE } from "./archive/coreDb.ts";
import { unmovedArchive } from "./archive/index.ts";
import { archiveFolder } from "./dataHome.ts";
import { loadModules } from "./modules/loader.ts";
import { moduleDatabaseFile } from "./modules/store.ts";
import { settings } from "./settings.ts";

const archiveDir = archiveFolder();

try {
  const unmoved = unmovedArchive(archiveDir);
  if (unmoved) throw new Error(unmoved);
  const coreFile = join(archiveDir, CORE_FILE);
  if (!existsSync(coreFile)) throw new Error(`there is no archive in ${archiveDir} (no ${CORE_FILE})`);
  const modules = await loadModules({ switches: settings().modules, pages: settings().pages });
  for (const broken of modules.broken) console.log(`The ${broken.id} module is broken, so its data is not checked: ${broken.problem}`);
  const problems: string[] = [];
  const checked: string[] = [];
  const unchecked: Array<{ id: string; file: string }> = [];
  for (const module of modules.on) {
    const { checkData, database } = module.definition;
    if (!checkData || !database) continue;
    const file = moduleDatabaseFile(archiveDir, module.id, database);
    if (!existsSync(file)) {
      // Never passed over in silence: on a folder that is not the archive's, its checks (friend map's people) never run.
      unchecked.push({ id: module.id, file });
      continue;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      problems.push(...checkData(db, archiveDir));
      checked.push(module.id);
    } finally {
      db.close();
    }
  }
  for (const problem of problems) console.log(problem);
  for (const { id, file } of unchecked) console.log(`The ${id} module has no database at ${file}, so its data is not checked.`);
  const verdict = problems.length > 0 ? `${problems.length} to fix` : unchecked.length > 0 ? "nothing to fix in what was checked" : "all fine";
  const off = modules.off.length > 0 ? `; switched off, so not checked: ${modules.off.map((m) => m.id).join(", ")}` : "";
  console.log(`Checked ${checked.join(", ") || "nothing"} in ${archiveDir}: ${verdict}${unchecked.length > 0 ? `; not checked: ${unchecked.map((m) => m.id).join(", ")}` : ""}${off}.`);
  if (problems.length > 0) process.exitCode = 1;
  if (modules.broken.length > 0 || unchecked.length > 0) process.exitCode = 2;
} catch (error) {
  console.log(`Could not check the data: ${(error as Error).message}`);
  process.exitCode = 2;
}
