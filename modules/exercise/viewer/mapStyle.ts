// The map the Fitness page lays routes on, as a MapLibre style: Protomaps' basemap (@protomaps/basemaps), quietened to
// sit behind a route in the console's two looks (near-white or near-black land, soft water and parks, roads drawn
// thin, place and street names in grey), drawn from this server alone: its tiles from the region's map kept on this
// Mac and its labels' fonts beside it (../wire.ts). Nothing in it names another server; it uses no icons, so it
// has no sprite (the points of interest, road shields and one-way arrows, which need them, are left out).

import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";
import type { Theme } from "../../../sdk/viewer.ts";
import { GLYPHS_URL, MAP_CREDIT, tilesUrl } from "../wire.ts";

/** The basemap's layers left out: those that need icons, and what is noise behind a route. */
const LEFT_OUT = new Set(["pois", "roads_shields", "roads_oneway", "address_label", "boundaries_country", "boundaries", "places_country", "places_region"]);

/** Each look's colours, over Protomaps' white and black flavours. */
const QUIET: Record<Theme, () => Flavor> = {
  light: () => ({
    ...namedFlavor("white"),
    background: "#f3f3f1",
    earth: "#f3f3f1",
    park_a: "#e6efe3",
    park_b: "#e6efe3",
    wood_a: "#e9f0e5",
    wood_b: "#e9f0e5",
    scrub_a: "#edf1ea",
    scrub_b: "#edf1ea",
    water: "#d5e1e9",
    buildings: "#e8e8e6",
    pedestrian: "#f7f7f6",
    minor_a: "#ffffff",
    minor_b: "#ffffff",
    minor_service: "#fbfbfb",
    other: "#fbfbfb",
    link: "#ffffff",
    major: "#ffffff",
    highway: "#ffffff",
    minor_casing: "#e4e4e2",
    minor_service_casing: "#e9e9e7",
    major_casing_early: "#dcdcda",
    major_casing_late: "#dcdcda",
    highway_casing_early: "#d6d6d4",
    highway_casing_late: "#d6d6d4",
    railway: "#dadad8",
  }),
  dark: () => ({
    ...namedFlavor("black"),
    background: "#121212",
    earth: "#121212",
    park_a: "#15201a",
    park_b: "#15201a",
    wood_a: "#141d17",
    wood_b: "#141d17",
    scrub_a: "#141a15",
    scrub_b: "#141a15",
    water: "#14222c",
    buildings: "#0c0c0c",
    pedestrian: "#171717",
    minor_a: "#232323",
    minor_b: "#1e1e1e",
    minor_service: "#1c1c1c",
    other: "#1c1c1c",
    link: "#262626",
    major: "#2a2a2a",
    highway: "#2e2e2e",
    railway: "#262626",
  }),
};

/** The style for `region`'s map (tiles to `maxZoom`, enlarged past it) in the `theme` look; `origin` is this page's. */
export function mapStyle(region: string, maxZoom: number, theme: Theme, origin = window.location.origin): StyleSpecification {
  return {
    version: 8,
    // MapLibre's workers fetch these, so they are whole addresses, this page's own.
    glyphs: `${origin}${GLYPHS_URL}`,
    sources: {
      protomaps: { type: "vector", tiles: [`${origin}${tilesUrl(region)}`], maxzoom: maxZoom, attribution: MAP_CREDIT },
    },
    layers: layers("protomaps", QUIET[theme](), { lang: "en" }).filter((layer) => !LEFT_OUT.has(layer.id)),
  };
}
