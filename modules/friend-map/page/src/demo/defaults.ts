// The demo's own defaults, where they are not the app's: as they were chosen
// on the demo before it went public. Each holds until its visitor chooses
// otherwise.

import type { SavedSettings } from "../savedSettings.ts";

/** Saved settings (savedSettings.ts) the demo starts at in place of yours: how names fade down the ranking (nameFade.ts). */
export const DEMO_SAVED: SavedSettings = { "name-fade.bottom": "50", "name-fade.faintest": "0.4" };

/** Orbits' (the solar system's) Name padding in the demo until its visitor moves it (namePadding.ts). */
export const DEMO_ORBITS_NAME_PADDING = 10;
