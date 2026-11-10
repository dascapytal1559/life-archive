// How many of the closest people each main view (Orbits, Orbits 3D, the Spider web
// and the City) names without hovering: Show top names in that view's settings in
// the menu (viewSettings.ts), the closest 25, 50, 100 or 200, or All, kept per
// view: on this device, as the app's other settings are (per browser, and
// apart in the demo), but the Spider web's, saved on friend-map's server in the
// real app and the demo's default (savedStore.ts), as the web's other settings
// are. Everyone else stays on the map, unnamed until hovered or
// zoomed in on. Until another is chosen every main view names the closest
// 100, in the real app and the demo alike. Circles is not a main view and
// keeps the closest 100 too.

import { demoMode, keptAs } from "../demoMode.ts";
import { keptSetting, useStore, type KeptSetting, type Store } from "../keptSetting.ts";
import { savedSetting } from "../savedStore.ts";

/** Everyone: as many as there are. */
export const ALL = Infinity;

/** The choices offered, closest first. */
export const TOP_NAMES: readonly number[] = [25, 50, 100, 200, ALL];

/**
 * The most surely named: with All, the closest 200 are named as with 200 (and
 * lock in as the Spider web boots), and everyone else in view besides.
 */
export const SURELY_NAMED = 200;

/** How many the main views and Circles name until another is chosen, in the real app and the demo alike. */
export const DEFAULT_TOP_NAMES = 100;

/** The main views, each with its own Show top names. */
export const MAIN_VIEWS = ["orbits", "orbits-3d", "web", "city"] as const;

export type MainView = (typeof MAIN_VIEWS)[number];

/** Where a view's setting is kept: the Spider web's saved (savedStore.ts), the others' per browser (the demo's, `demo`, apart). */
export function topNamesKey(slug: MainView, demo: boolean = demoMode): string {
  return keptAs(`friend-map.${slug}.top-names`, demo);
}

/** What is kept as one of the choices; anything else is `fallback`. */
export function topNamesOf(kept: string | null, fallback: number): number {
  const n = kept === "all" ? ALL : /^\d+$/.test(kept ?? "") ? Number(kept) : NaN;
  return TOP_NAMES.includes(n) ? n : fallback;
}

/** Whether whoever is `place`th closest (1 the closest; null or 0 with no closeness yet) is among the closest `named`. */
export function amongTop(place: number | null | undefined, named: number): boolean {
  return place != null && place > 0 && place <= named;
}

/** Each main view's Show top names in an app (the demo's, `demo`, or the real one's). */
export function makeTopNamesStores(demo: boolean): Record<MainView, KeptSetting<number>> {
  const fallback = DEFAULT_TOP_NAMES;
  const write = (n: number) => (n === ALL ? "all" : String(n));
  return Object.fromEntries(
    MAIN_VIEWS.map((slug) => [
      slug,
      slug === "web"
        ? savedSetting(topNamesKey(slug, false), demo, fallback, topNamesOf, { write })
        : keptSetting(topNamesKey(slug, demo), fallback, (kept) => topNamesOf(kept, fallback), write),
    ]),
  ) as Record<MainView, KeptSetting<number>>;
}

/** This page's: the demo's in the demo, the real app's everywhere else. */
export const topNamesStores = makeTopNamesStores(demoMode);

/** How many of the closest the view `slug` names. */
export function useTopNames(slug: MainView): number {
  return useStore(topNamesStores[slug]);
}

/** Circles' count, which has no setting of its own. */
const FIXED: Store<number> = { get: () => DEFAULT_TOP_NAMES, set: () => {}, subscribe: () => () => {} };

/** How many of the closest the view `slug` names: a main view's Show top names, else DEFAULT_TOP_NAMES. */
export function useTopNamesOf(slug: string): number {
  return useStore((MAIN_VIEWS as readonly string[]).includes(slug) ? topNamesStores[slug as MainView] : FIXED);
}
