// The Spider web's shape (Orbits.tsx, the Spider web view; webGeometry.ts makes
// the web): two sliders in the Spider web's settings in the menu
// (viewSettings.ts), Strand curve, how deep each cross thread between two
// spokes sags toward the hub (10% until moved), and Spokes, how many (14 until
// moved), the web you settled on. Both saved on friend-map's server
// in the real app and the demo's defaults (savedStore.ts), as the Web
// strength is, not in the address. The web has one style, a clean orb web
// whose rings are the rank rings; the uneven Natural web it once had beside it
// is retired, and a browser that kept that choice simply has it read no more.

import { demoMode } from "../demoMode.ts";
import { useStore } from "../keptSetting.ts";
import { savedSetting } from "../savedStore.ts";

/** Where the web's Strand curve is kept: how deep each cross thread sags toward the hub, 0 (straight) to 1 (STRAND_DEPTH in webGeometry.ts). */
export const CURVE_KEY = "friend-map.web.curve";
/** The curve until one is chosen: a slight sag. */
export const DEFAULT_CURVE = 0.1;

/** A curve as a number from 0 to 1; anything else is `fallback`. */
export function curveOf(value: unknown, fallback: number = DEFAULT_CURVE): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** An app's strand curve, 0 to 1 (the demo's, `demo`, or the real one's). */
export function makeWebCurveStore(demo: boolean) {
  return savedSetting(CURVE_KEY, demo, DEFAULT_CURVE, (kept, fallback) => curveOf(kept ?? undefined, fallback));
}

/** This page's strand curve: the demo's in the demo, the real app's everywhere else. */
export const webCurveStore = makeWebCurveStore(demoMode);

export function useWebCurve(): number {
  return useStore(webCurveStore);
}

/** Where the web's Spokes are kept. */
export const SPOKES_KEY = "friend-map.web.spokes";
/** How many spokes the slider offers, an even number always, so the web stays mirrored top to bottom. */
export const SPOKES = { min: 8, max: 48, step: 2 } as const;
/** The spokes until a number is chosen: a light web. */
export const DEFAULT_SPOKES = 14;

/** A number of spokes, the nearest even one in SPOKES' range; anything else is `fallback`. */
export function spokesOf(value: unknown, fallback: number = DEFAULT_SPOKES): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.max(SPOKES.min, Math.min(SPOKES.max, 2 * Math.round(n / 2))) : fallback;
}

/** An app's web's spokes (the demo's, `demo`, or the real one's). */
export function makeWebSpokesStore(demo: boolean) {
  return savedSetting(SPOKES_KEY, demo, DEFAULT_SPOKES, (kept, fallback) => spokesOf(kept ?? undefined, fallback));
}

/** This page's spokes: the demo's in the demo, the real app's everywhere else. */
export const webSpokesStore = makeWebSpokesStore(demoMode);

export function useWebSpokes(): number {
  return useStore(webSpokesStore);
}
