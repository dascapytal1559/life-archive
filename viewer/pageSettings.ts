// What the page was told of its archive as it opened (viewer/main.tsx sets it before anything of the console loads).

import type { PageSettings } from "./wire.ts";

/** Before the page is told, and in tests: no module on. */
let told: PageSettings = { timeZone: "UTC", locale: "en", modules: {}, moduleSettings: {} };

export const pageSettings = (): PageSettings => told;

export function setPageSettings(settings: PageSettings): void {
  told = settings;
}
