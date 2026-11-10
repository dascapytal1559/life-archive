// The maps the archive keeps on this Mac, each a region's OpenStreetMap data downloaded once (npm run map; download.ts)
// into the archive's folder, maps/<region>.pmtiles, with the fonts its labels are drawn in, maps/fonts/. The module's
// route serves them to the Fitness page (http.ts), which draws a route over the map of the region it lies in, so
// viewing a workout never asks a map server for anything (the module's privacy lines, ../privacy.ts).
//
// The data is Protomaps' daily build of OpenStreetMap as vector tiles (build.protomaps.com, schema v4, the style
// @protomaps/basemaps draws), cut to a region's box by go-pmtiles' `pmtiles extract`, which fetches only the region's
// tiles (a few hundred requests' worth of ranges) from the build. The fonts are Protomaps' (protomaps/basemaps-assets).
// Beside each, its terrain (maps/terrain/<region>.pmtiles), cut the same way from Mapterhorn's open terrain.

import { join } from "node:path";
import { settings } from "../../../../sdk/server.ts";

/** A region that can be downloaded: its name in words and its box, [west, south, east, north] in degrees. */
export interface RegionPlan {
  name: string;
  bbox: readonly [number, number, number, number];
}

/** The regions `npm run map -- download <region>` knows: the settings' maps.regions, read as asked (never as this file loads). */
export const regions = (): Readonly<Record<string, RegionPlan>> => settings().maps.regions;

/** The highest zoom a build has; the page zooms on past it by enlarging its tiles. */
export const MAX_ZOOM = 15;

/** Protomaps' daily builds, each `<YYYYMMDD>.pmtiles`, and the list of them. */
export const BUILDS_URL = "https://build.protomaps.com";
export const BUILDS_LIST_URL = "https://build-metadata.protomaps.dev/builds.json";

/** The fonts the page's map style draws its labels in (viewer/mapStyle.ts), and where they are fetched. */
export const MAP_FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"] as const;
export const FONTS_URL = "https://protomaps.github.io/basemaps-assets/fonts";
/** A font's glyphs come in 256 files of 256 code points each: 0-255, 256-511, … 65280-65535. */
export const GLYPH_RANGES = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}`);

/** What the archive's maps are credited with, as OpenStreetMap's licence (ODbL) asks wherever one is shown. */
export const MAP_ATTRIBUTION = "© OpenStreetMap contributors";

/** A region's name in a file or a path: lower-case words and dashes. */
export const REGION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The maps' folder in the archive's folder. */
export const mapsFolder = (archive: string): string => join(archive, "maps");

/** A region's map file. */
export const regionFile = (archive: string, region: string): string => join(mapsFolder(archive), `${region}.pmtiles`);

/** A region's terrain file: its ground's height, for the playback's 3D (terrain.ts). */
export const terrainFile = (archive: string, region: string): string => join(mapsFolder(archive), "terrain", `${region}.pmtiles`);

/**
 * Mapterhorn's terrain (mapterhorn.com, built from open elevation data, Copernicus GLO-30 and national surveys such as
 * Geoscience Australia's, each source's licence on its attribution page; its data-access page gives `pmtiles extract`
 * as the way to take an area): its whole earth to zoom 12, Terrarium-encoded WebP tiles of 512 pixels, about 15 m a
 * pixel at Melbourne's latitude. Its zoom 13 to 15 files are kept by area and are much larger (about 300 MB for
 * Greater Melbourne); zoom 12 is plenty behind a moving camera.
 */
export const TERRAIN_URL = "https://download.mapterhorn.com/planet.pmtiles";

/** A font's glyph file. */
export const glyphFile = (archive: string, font: string, range: string): string => join(mapsFolder(archive), "fonts", font, `${range}.pbf`);
