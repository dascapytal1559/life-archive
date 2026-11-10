// Whether the Spider web's spider casts its shadow on the web (drawSpider in
// webSpider.ts): a toggle in the Spider web's settings in the menu
// (viewSettings.ts), on by default, as it was drawn before there was a
// setting. Saved on friend-map's server in the real app and the demo's
// default (savedStore.ts), as the web's other settings are.

import { demoMode } from "../demoMode.ts";
import { useStore } from "../keptSetting.ts";
import { savedSetting } from "../savedStore.ts";

/** Where the setting is kept. */
export const SHADOW_KEY = "friend-map.web.shadow";

/** An app's spider's shadow, on or off (the demo's, `demo`, or the real one's). */
export function makeWebShadowStore(demo: boolean) {
  return savedSetting(SHADOW_KEY, demo, true, (kept, fallback) => (kept === "on" ? true : kept === "off" ? false : fallback), {
    write: (on) => (on ? "on" : "off"),
  });
}

/** This page's: the demo's in the demo, the real app's everywhere else. */
export const webShadowStore = makeWebShadowStore(demoMode);

export function useWebShadow(): boolean {
  return useStore(webShadowStore);
}
