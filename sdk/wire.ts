// What both halves of a module import (sdk/server.ts is the server half's, sdk/viewer.ts the page half's): the
// addresses the page and the server agree on (viewer/wire.ts), which a module's own wire file builds its routes'
// addresses from (modules/health/wire.ts's HEALTH_API is moduleApi("health")), the console's addresses (Events' own
// among them, which friend-map's page sends its folded Table and Calendar on to), the
// archive's clock (src/time.ts) and the words for a habit done (src/habitWords.ts). Nothing here runs anywhere in
// particular: no React, no Node, so a wire file imported by both halves stays importable by both.

export { API_BASE, moduleApi } from "../viewer/wire.ts";
export { consolePath } from "../viewer/console/address.ts";
export { CALENDAR_PATH, EVENTS_PATH } from "../viewer/console/eventsPaths.ts";
export { addDays, dayKey, dayStart, LOCALE, timeOfDay } from "../src/time.ts";
export { habitDoing, heldText, WIND_DOWN_NAME } from "../src/habitWords.ts";
