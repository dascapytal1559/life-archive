// The SDK a module's page half imports, and nothing else of the core's (sdk.test.ts holds every module to it): how a
// module declares its aspects and views (defineViewer), the registry's own shapes (viewer/console/registry.ts), and the
// console's addresses, blocks, icons and look, and where the page's site sits (SITE: "" but in a mounted demo,
// viewer/mount.ts). The page finds every module's viewer.tsx by its place
// (viewer/modules.ts), and a module finds this file by its place, ../../sdk/viewer.ts.
//
// A module's view may sit under any aspect, its own or another's, the core's included: a view listing "events" among
// its aspects is a tab on the Events page, in the registry's order after the core's own. An aspect may add links, tabs
// that open a page elsewhere, and may bring a drawing of its own for its icon. What the module's server half tells its
// page (sdk/server.ts's `viewerSettings`: an address its settings hold, say) is moduleSettings(id) here.
//
// A module's tables are not drawn by its page: it declares them in its server half (sdk/server.ts's `tabs`, and `edits`
// for what of them can be changed), and the Events page's Tables lists, opens and edits every one. So nothing here draws
// a table, and a page that held one says where it went (`moved`); a module that keeps something in the browser beside
// its tables hears of each edit saved there (`saved`).

import type { Aspect, View } from "../viewer/console/registry.ts";
import { pageSettings } from "../viewer/pageSettings.ts";
import type { SavedEdit } from "../viewer/savedEdits.ts";

export type { Aspect, AspectLink, View } from "../viewer/console/registry.ts";
export type { SavedEdit } from "../viewer/savedEdits.ts";
export { consolePath } from "../viewer/console/address.ts";
export { SITE } from "../viewer/mount.ts";
export { BarChart, Card, Facts, Kpi, Kpis, Table, type Bar, type Column } from "../viewer/console/blocks.tsx";
export { Icon, type IconDrawing, type IconName } from "../viewer/console/icons.tsx";
export { LookContext, type Theme } from "../viewer/console/theme.ts";
export { LOCALE } from "../src/time.ts";
export { ApiError } from "../viewer/api.ts";
export { countText, dateText, timeText } from "../viewer/format.ts";

/** What a module's viewer.tsx declares, as its default export, through defineViewer. */
export interface ViewerDefinition {
  /** Its aspects: each a place in the rail, with at least one view under it. */
  readonly aspects: readonly Aspect[];
  /** Its views: each under one or more aspects, its own or any other's. */
  readonly views: readonly View[];
  /**
   * Places of its that moved to another place, each by its old address's steps ("friend-map/messages") to the steps of
   * an address that opens it now ("events/messages": a view's section under its aspect, or one it answered to before).
   * An old address opens the new place, its query kept (the registry's placeOf; registryProblems holds each to an old
   * place no view is at and a new one that is there).
   */
  readonly moved?: Readonly<Record<string, string>>;
  /**
   * Told of each field edit saved on the Events page's Tables, any table's, once it is made, an undo among them (not an
   * add or a delete; viewer/savedEdits.ts): for what the module keeps in the browser that follows its rows.
   */
  readonly saved?: (edit: SavedEdit) => void;
}

/** What the module `id`'s server half told its page as the console opened (its `viewerSettings`), as it was sent; undefined when it told nothing. */
export function moduleSettings(id: string): unknown {
  // A server older than the page (one still running while new code is served) tells no module's settings at all.
  return pageSettings().moduleSettings?.[id];
}

/** A module's page declaration: `export default defineViewer({...})` in its viewer.tsx. */
export function defineViewer(definition: ViewerDefinition): ViewerDefinition {
  return definition;
}
