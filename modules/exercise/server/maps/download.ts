// Downloading a region's map once (npm run map -- download <region>; regions.ts): the newest Protomaps build cut to the
// region's box by `pmtiles extract` into maps/<region>.pmtiles, then the fonts its labels need, each fetched only when
// it is not here yet, and its terrain from Mapterhorn's (npm run map -- terrain <region> takes the terrain alone). This is
// the only time the maps reach the network: the server serves them from the files after.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect, Exit } from "effect";
import { run, spawnScoped } from "../../../../sdk/server.ts";
import { BUILDS_LIST_URL, BUILDS_URL, FONTS_URL, glyphFile, GLYPH_RANGES, MAP_FONTS, MAX_ZOOM, regionFile, regions, TERRAIN_URL, terrainFile, type RegionPlan } from "./regions.ts";

/** A download that could not be made, and why. */
export class DownloadFailed extends Data.TaggedError("DownloadFailed")<{ readonly message: string }> {}

/** The newest build Protomaps lists (`20261102.pmtiles`). */
export const latestBuild: Effect.Effect<string, DownloadFailed> = Effect.tryPromise({
  try: async () => {
    const response = await fetch(BUILDS_LIST_URL);
    if (!response.ok) throw new Error(`${BUILDS_LIST_URL} answered ${response.status}`);
    const builds = (await response.json()) as Array<{ key?: unknown }>;
    const keys = builds.map((b) => b.key).filter((k): k is string => typeof k === "string" && /^\d{8}\.pmtiles$/.test(k));
    if (keys.length === 0) throw new Error(`${BUILDS_LIST_URL} lists no builds`);
    return keys.sort().at(-1)!;
  },
  catch: (error) => new DownloadFailed({ message: `could not find Protomaps' newest build: ${(error as Error).message}` }),
});

/** The arguments `pmtiles extract` is run with to cut `plan` from `build` into `out`. */
export function extractArgs(build: string, plan: RegionPlan, out: string): string[] {
  return ["extract", `${BUILDS_URL}/${build}`, out, `--bbox=${plan.bbox.join(",")}`, `--maxzoom=${MAX_ZOOM}`, "--download-threads=4"];
}

/** The arguments `pmtiles extract` is run with to cut `plan`'s terrain from Mapterhorn's into `out`. */
export function terrainArgs(plan: RegionPlan, out: string): string[] {
  return ["extract", TERRAIN_URL, out, `--bbox=${plan.bbox.join(",")}`, "--download-threads=4"];
}

/** go-pmtiles' command, said plainly when it is not installed. */
const pmtilesInstalled = run("pmtiles", ["version"]).pipe(
  Effect.mapError(() => new DownloadFailed({ message: "the pmtiles command is not installed: run `brew install pmtiles` (go-pmtiles), then try again" })),
);

/** A region of the settings, said plainly when there is none by that name. */
const planOf = (region: string): Effect.Effect<RegionPlan, DownloadFailed> => {
  const plan = regions()[region];
  return plan ? Effect.succeed(plan) : Effect.fail(new DownloadFailed({ message: `no region ${region}: the regions are ${Object.keys(regions()).join(", ")} (maps.regions in the archive's settings)` }));
};

/** Runs `pmtiles` with `args`, writing `part`, and puts it at `file` once whole; interrupted or failed, the half-made file is deleted. */
const extractInto = (args: string[], part: string, file: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(dirname(file), { recursive: true }));
      // Its progress is shown as it goes.
      const { child, exited } = yield* spawnScoped(() => spawn("pmtiles", args, { stdio: ["ignore", "inherit", "inherit"] }));
      let failedToStart: Error | null = null;
      child.on("error", (error) => (failedToStart ??= error));
      const { code, signal } = yield* exited;
      if (failedToStart) return yield* new DownloadFailed({ message: `pmtiles could not start: ${(failedToStart as Error).message}` });
      if (code !== 0) return yield* new DownloadFailed({ message: `pmtiles extract ${signal ? `was stopped by ${signal}` : `exited ${code}`}` });
      yield* Effect.promise(() => rename(part, file));
    }),
  ).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.promise(() => rm(part, { force: true })))));

/**
 * Downloads `region`'s map into the archive's folder `archive`, from `build` (else the newest), replacing the one there
 * only once the new one is whole, then its fonts and its terrain. Interrupted or failed, the half-made file is deleted.
 */
export const downloadRegion = Effect.fn("downloadRegion")(function* (archive: string, region: string, options: { build?: string; log: (line: string) => void }) {
  const plan = yield* planOf(region);
  yield* pmtilesInstalled;
  const build = options.build ?? (yield* latestBuild);
  const file = regionFile(archive, region);
  options.log(`cutting ${plan.name} (${plan.bbox.join(", ")}) from Protomaps' build ${build}, to zoom ${MAX_ZOOM}`);
  yield* extractInto(extractArgs(build, plan, `${file}.part`), `${file}.part`, file);
  options.log(`${plan.name}'s map is in ${file}`);
  yield* downloadFonts(archive, options.log);
  yield* downloadTerrain(archive, region, options.log);
  return { file, build };
});

/** Downloads `region`'s terrain from Mapterhorn's into the archive's folder `archive`, replacing the one there only once whole. */
export const downloadTerrain = Effect.fn("downloadTerrain")(function* (archive: string, region: string, log: (line: string) => void) {
  const plan = yield* planOf(region);
  yield* pmtilesInstalled;
  const file = terrainFile(archive, region);
  log(`cutting ${plan.name}'s terrain from Mapterhorn's (${TERRAIN_URL})`);
  yield* extractInto(terrainArgs(plan, `${file}.part`), `${file}.part`, file);
  log(`${plan.name}'s terrain is in ${file}`);
  return { file };
});

/** The fonts the map's labels are drawn in, each glyph file fetched once (four at a time); one Protomaps lacks is left out. */
export const downloadFonts = Effect.fn("downloadFonts")(function* (archive: string, log: (line: string) => void) {
  const wanted = MAP_FONTS.flatMap((font) => GLYPH_RANGES.map((range) => ({ font, range }))).filter(({ font, range }) => !existsSync(glyphFile(archive, font, range)));
  if (wanted.length === 0) return;
  log(`fetching ${wanted.length} of the fonts' glyph files`);
  yield* Effect.forEach(
    wanted,
    ({ font, range }) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${FONTS_URL}/${encodeURIComponent(font)}/${range}.pbf`);
          if (response.status === 404) return;
          if (!response.ok) throw new Error(`answered ${response.status}`);
          const file = glyphFile(archive, font, range);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.part`, Buffer.from(await response.arrayBuffer()));
          await rename(`${file}.part`, file);
        },
        catch: (error) => new DownloadFailed({ message: `could not fetch ${font}'s glyphs ${range}: ${(error as Error).message}` }),
      }),
    { concurrency: 4, discard: true },
  );
  log("the fonts are in place");
});
