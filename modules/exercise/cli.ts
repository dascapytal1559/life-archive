// The exercise module's commands (README.md):
//
//   npm run exercise -- status                       what the module's database holds: its workouts by source, its
//                                                    tombstones and its connectors' runs, and when its rows were
//                                                    taken over from the archive (the migration's check)
//   npm run exercise -- polar login [--new-client]   connect Polar, once: asks for the API client registered at
//                                                    admin.polaraccesslink.com (kept in the Keychain; --new-client asks
//                                                    again), opens Polar's page in the browser to sign in and accept,
//                                                    catches its way back on http://localhost:4655/polar/callback, keeps
//                                                    the token in the Keychain and switches the polar connector on
//   npm run exercise -- map download <region> [--build <YYYYMMDD>.pmtiles]
//                                                    downloads the region's map once, from Protomaps' newest build (or
//                                                    that build), the fonts and its terrain (Mapterhorn's), into the
//                                                    archive's folder, maps/; a region downloaded again is replaced once
//                                                    the new copy is whole, and the server opens it at the next request
//                                                    (`npm run map` is this)
//   npm run exercise -- map terrain <region>         the region's terrain alone, for the playback's 3D (maps/terrain/)
//   npm run exercise -- map list                     the regions there are (the settings' maps.regions), and which are
//                                                    downloaded, how big and covering what
//
// The archive's folder is found as every entry point finds it (the core's dataHome.ts, through the SDK). It opens the
// module's own database for `status` and never the archive's. A module's command: sdk/command.ts first (the pinned
// Node, the settings), then the SDK for the rest.

import { DATA_OPTION } from "../../sdk/command.ts";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { archiveFolder, Effect, getMeta, runMain } from "../../sdk/server.ts";
import { polarLoginCommand } from "./connectors/polar/loginCommand.ts";
import { counts, EXERCISE, EXERCISE_DB } from "./server/db.ts";
import { downloadRegion, downloadTerrain } from "./server/maps/download.ts";
import { mapsFolder, regions, terrainFile } from "./server/maps/regions.ts";
import { mapStore } from "./server/maps/tiles.ts";
import { WorkoutIndex } from "./server/workoutIndex.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...DATA_OPTION, build: { type: "string" }, "new-client": { type: "boolean" } } });
const [command, ...args] = positionals;
const archive = archiveFolder();

const USAGE = "Usage: npm run exercise -- status | polar login [--new-client] | map download <region> [--build <YYYYMMDD>.pmtiles] | map terrain <region> | map list";

try {
  if (command === "status") status();
  else if (command === "polar" && args[0] === "login") await polarLoginCommand(archive, { newClient: values["new-client"] ?? false });
  else if (command === "map" && args[0] === "download" && args[1]) await download(args[1]);
  else if (command === "map" && args[0] === "terrain" && args[1]) await terrain(args[1]);
  else if (command === "map" && args[0] === "list") await list();
  else {
    console.log(USAGE);
    if (command === "map") console.log(`regions: ${Object.keys(regions()).join(", ")}`);
    if (command !== undefined && command !== "help") process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

/** What the module's database holds, read on a connection of this command's own (its schema is the server's to bring up to date). */
function status(): void {
  const file = join(archive, "modules", EXERCISE, EXERCISE_DB);
  if (!existsSync(file)) return console.log(`No ${file} yet: the server makes it when it next starts with the module on.`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const held = counts(db);
    console.log(`${file}:`);
    for (const row of new WorkoutIndex(db).summary()) console.log(`  ${row.origin}: ${row.count} workout copies, ${row.firstDay} to ${row.lastDay}`);
    console.log(`  ${held.workouts} workout copies in all, ${held.deleted} tombstones, ${held.sources} connector runs and ${held.states} connector states.`);
    const taken = getMeta(db, "taken_over");
    console.log(taken === "nothing" ? "  Taken over from no archive: it was new beside none." : taken === null ? "  Not taken over from the archive yet." : `  Taken over from the archive on ${taken}.`);
  } finally {
    db.close();
  }
}

/** Bytes in MB, to one place. */
function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A folder's bytes, all the way down. */
async function folderBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) total += entry.isDirectory() ? await folderBytes(join(path, entry.name)) : (await stat(join(path, entry.name))).size;
  return total;
}

async function list(): Promise<void> {
  const store = mapStore(archive);
  const here = await store.regions();
  await store.close();
  const known = regions();
  for (const [id, plan] of Object.entries(known)) {
    const map = here.find((m) => m.region === id);
    const size = map ? (await stat(join(mapsFolder(archive), `${id}.pmtiles`))).size : 0;
    const ground = await stat(terrainFile(archive, id)).catch(() => null);
    const terrainNote = ground ? `; terrain ${mb(ground.size)}` : map ? `; no terrain (npm run map -- terrain ${id})` : "";
    console.log(`${id}  ${plan.name}  ${map ? `downloaded, ${mb(size)}, covering ${map.bbox.join(", ")} to zoom ${map.maxZoom}` : "not downloaded"}${terrainNote}`);
  }
  for (const map of here.filter((m) => !(m.region in known))) console.log(`${map.region}  (not in the settings)  covering ${map.bbox.join(", ")}`);
  console.log(`fonts: ${mb(await folderBytes(join(mapsFolder(archive), "fonts")))}; the maps' folder, ${mapsFolder(archive)}: ${mb(await folderBytes(mapsFolder(archive)))}`);
}

async function download(region: string): Promise<void> {
  await finish(downloadRegion(archive, region, { build: values.build, log: (line) => console.log(line) }));
}

async function terrain(region: string): Promise<void> {
  await finish(downloadTerrain(archive, region, (line) => console.log(line)));
}

/** Runs a download, its failure said and the exit code set. */
async function finish<A>(job: Effect.Effect<A, { message: string }>): Promise<void> {
  await runMain(
    job.pipe(
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (error) => {
          console.error(error.message);
          process.exitCode = 1;
        },
      }),
    ),
  );
}
