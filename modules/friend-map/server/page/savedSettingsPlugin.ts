// Serves your saved view settings (viewSettings.ts) into every page,
// as JSON in <script type="application/json" id="friend-map-saved-settings">
// in its head, which the page reads as it opens (the page's src/savedStore.ts):
// the app's settings come from it. Read afresh for each page the core's Vite
// serves of friend-map's (sdk/server.ts's `page`). Only the saved settings,
// each one of its own values, ever go in: never anything else from the data
// folder. The demo build (tools/demo/build.ts) reads them once the same
// way, from the made-up folder's page folder.

import { join } from "node:path";
import type { Plugin } from "vite";
import { SAVED_SETTINGS_ID, savedSettingsJson } from "../../page/src/savedSettings.ts";
import { readViewSettings } from "./viewSettings.ts";

/** Where friend-map's page is served (the core serves it in the server's process, sdk/server.ts's `page`): the phone's bookmark's /friend-map/. */
export const PAGE_PATH = "/friend-map";

/**
 * The page's own folder in the archive's folder `folder`, friend-map's data/ before it was a module: its settings
 * (settings.json), the view settings it saves (view-settings.json), how its views are used (usage.jsonl) and the
 * captain's photo (me/).
 */
export const pageFolder = (folder: string): string => join(folder, "modules", "friend-map", "page");

/** The plugin, reading the saved set from `dataDir` (the page's folder); `built` hears, in a build, which settings went in. */
export function savedSettingsPlugin(dataDir: string, built?: (names: string[]) => void): Plugin {
  return {
    name: "friend-map:saved-settings",
    async transformIndexHtml(_html, context) {
      const saved = await readViewSettings(dataDir);
      if (!context.server) built?.(Object.keys(saved));
      return [{ tag: "script", attrs: { type: "application/json", id: SAVED_SETTINGS_ID }, children: savedSettingsJson(saved), injectTo: "head" }];
    },
  };
}
