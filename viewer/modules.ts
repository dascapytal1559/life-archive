// The page's half of the module loader (server/modules/loader.ts is the server's): every installed module's viewer.tsx
// (sdk/viewer.ts's defineViewer), found by Vite by its place, modules/<id>/viewer.tsx, as the page is served, so
// adding a module is cloning its folder. Only the modules the server said are on are loaded (viewer/wire.ts's
// PageSettings.modules), by viewer/main.tsx before anything of the console loads, as it sets the page's settings: a
// module switched off, broken or unnamed is never fetched, so nothing in its viewer.tsx can break the console. One that
// is on but cannot load (a syntax error, a name the SDK no longer exports, no default export) is told as failed, which
// the registry (viewer/console/registry.ts), reading what was loaded here as it loads, makes a page of its own in the
// rail saying so (console/ViewFailed.tsx); every other page goes on.

import type { ViewerDefinition } from "../sdk/viewer.ts";

const found = import.meta.glob<ViewerDefinition>("../modules/*/viewer.tsx", { import: "default" });

/** A module's page half, by its id (its folder's name): what its viewer.tsx declares, or why it did not load. */
export type ModuleViewer =
  | { readonly id: string; readonly viewer: ViewerDefinition; readonly failed?: undefined }
  | { readonly id: string; readonly viewer?: undefined; readonly failed: string };

/** Each installed module's viewer.tsx, not yet loaded, by id, in the ids' order. */
const INSTALLED: ReadonlyArray<{ id: string; load: () => Promise<ViewerDefinition> }> = Object.entries(found)
  .map(([path, load]) => ({ id: path.split("/").at(-2)!, load }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** The ids of every module with a viewer.tsx, loaded or not. */
export const installedViewers = (): string[] => INSTALLED.map(({ id }) => id);

let loaded: readonly ModuleViewer[] = [];
let loading = false;

/** The page halves loaded (loadModuleViewers), in the ids' order; none before. */
export function moduleViewers(): readonly ModuleViewer[] {
  // Read while they load, it would be an incomplete list kept for good: the registry reads it once, as it loads, so a
  // module's viewer.tsx that reached the registry would leave every module out.
  if (loading) throw new Error("the modules' viewers were read while they were still loading (does a viewer.tsx import the registry?)");
  return loaded;
}

/** Loads the page half of each module `on` names as on, each on its own: one that fails takes only its own page. */
export async function loadModuleViewers(on: Readonly<Record<string, boolean>>): Promise<readonly ModuleViewer[]> {
  loading = true;
  try {
    loaded = await Promise.all(
      INSTALLED.filter(({ id }) => on[id] === true).map(async ({ id, load }): Promise<ModuleViewer> => {
        try {
          const viewer = await load();
          if (!Array.isArray(viewer?.aspects) || !Array.isArray(viewer?.views)) throw new Error("its viewer.tsx has no default export of defineViewer's shape");
          return { id, viewer };
        } catch (cause) {
          const failed = cause instanceof Error ? cause.message : String(cause);
          console.error(`The ${id} module's page did not load:`, cause);
          return { id, failed };
        }
      }),
    );
  } finally {
    loading = false;
  }
  return loaded;
}
