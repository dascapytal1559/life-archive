// How much clear space each map view (Orbits 2D, Orbits, the solar system,
// and the Spider web) keeps between names when it fits them round the sun
// (useNameFit in orbitsSky.ts): Name padding in that view's settings in the
// menu (viewSettings.ts), 0 to 10 pixels, so two names are at least that far
// apart, across and up and down, ink to ink, wherever the fitting finds room
// (on the solar system, as seen from straight above). Until another is
// chosen, 3 on Orbits 2D and the solar system (10 on the solar system in the
// demo), the room the fitting kept before there was a setting, and 5 on the
// Spider web, its default. Kept per
// view: both Orbits' on this device, as the app's other settings are (per
// browser, and apart in the demo), the Spider web's saved on friend-map's
// server in the real app and the demo's default (savedStore.ts), as the web's
// other settings are.

import { DEMO_ORBITS_NAME_PADDING } from "../demo/defaults.ts";
import { demoMode, keptAs } from "../demoMode.ts";
import { keptSetting, useStore, type KeptSetting } from "../keptSetting.ts";
import { savedSetting } from "../savedStore.ts";

/** The map views, each with its own Name padding. */
export const MAP_VIEWS = ["orbits", "orbits-3d", "web"] as const;

export type MapView = (typeof MAP_VIEWS)[number];

/** What the slider offers, in pixels: whole steps from none to 10. */
export const NAME_PADDING = { min: 0, max: 10, step: 1 } as const;
/** Orbits' padding (either one's) until another is chosen: 3, as the names were fitted before there was a setting. */
export const DEFAULT_NAME_PADDING = 3;
/** The Spider web's until another is chosen: 5. */
export const WEB_NAME_PADDING = 5;

/** Where a view's setting is kept: the Spider web's saved (savedStore.ts), Orbits' per browser (the demo's, `demo`, apart). */
export function namePaddingKey(slug: MapView, demo: boolean = demoMode): string {
  return keptAs(`friend-map.${slug}.name-padding`, demo);
}

/** A padding as a whole number of pixels in NAME_PADDING's range; anything else is `fallback`. */
export function namePaddingOf(value: unknown, fallback: number = DEFAULT_NAME_PADDING): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.max(NAME_PADDING.min, Math.min(NAME_PADDING.max, Math.round(n))) : fallback;
}

/** Each map view's Name padding in an app (the demo's, `demo`, or the real one's). */
export function makeNamePaddingStores(demo: boolean): Record<MapView, KeptSetting<number>> {
  const parse = (kept: string | null, fallback: number) => namePaddingOf(kept ?? undefined, fallback);
  // The solar system's starts at the demo's own in the demo (src/demo/defaults.ts).
  const solar = demo ? DEMO_ORBITS_NAME_PADDING : DEFAULT_NAME_PADDING;
  return {
    orbits: keptSetting(namePaddingKey("orbits", demo), DEFAULT_NAME_PADDING, (kept) => parse(kept, DEFAULT_NAME_PADDING)),
    "orbits-3d": keptSetting(namePaddingKey("orbits-3d", demo), solar, (kept) => parse(kept, solar)),
    web: savedSetting("friend-map.web.name-padding", demo, WEB_NAME_PADDING, parse),
  };
}

/** This page's: the demo's in the demo, the real app's everywhere else. */
export const namePaddingStores = makeNamePaddingStores(demoMode);

/** The clear space, in pixels, the view `slug` keeps between names. */
export function useNamePadding(slug: MapView): number {
  return useStore(namePaddingStores[slug]);
}
