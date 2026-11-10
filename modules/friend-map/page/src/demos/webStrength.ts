// How strongly the Spider web's web is drawn (Orbits.tsx, the Spider web view): a slider in
// the Spider web's settings in the menu (viewSettings.ts), 0 (gone) to 100% (as
// strong as it is drawn at all), 35% by default so the people stand out over
// it; the same in every colour. Saved on friend-map's server in the real app
// and the demo's default (savedStore.ts), as the web's other settings are, not
// in the address.

import { demoMode } from "../demoMode.ts";
import { useStore } from "../keptSetting.ts";
import { savedSetting } from "../savedStore.ts";

/** Where the setting is kept. */
export const STRENGTH_KEY = "friend-map.web.strength";
/** The strength until one is chosen: 35%, so people stand out over the web. */
export const DEFAULT_STRENGTH = 0.35;

/** A strength as a number from 0 to 1; anything else is `fallback`. */
export function strengthOf(value: unknown, fallback: number = DEFAULT_STRENGTH): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** An app's web's strength, 0 to 1 (the demo's, `demo`, or the real one's). */
export function makeWebStrengthStore(demo: boolean) {
  return savedSetting(STRENGTH_KEY, demo, DEFAULT_STRENGTH, (kept, fallback) => strengthOf(kept ?? undefined, fallback));
}

/** This page's: the demo's in the demo, the real app's everywhere else. */
export const webStrengthStore = makeWebStrengthStore(demoMode);

export function useWebStrength(): number {
  return useStore(webStrengthStore);
}
