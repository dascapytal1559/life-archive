// The map's Hide follows a tag renamed in Events' Tags table (the module's server/tabs/tagsTab.ts), as it followed
// one renamed in the Table's tag manager before that folded in: the console tells the module of each edit saved
// there (sdk/viewer.ts's `saved`), and a tag's new name takes its switch over in the choices friend-map's page keeps
// in this browser (page/src/demos/hideChoices.ts's renameStoredHidden), which the console and the page, on one
// origin, share. Renamed onto a tag that exists, the two merge, and the one kept keeps its own switch.

import type { SavedEdit } from "../../../sdk/viewer.ts";
import { renameStoredHidden } from "../page/src/demos/hideChoices.ts";

/** The module whose tables these are, and its Tags table's kind (server/tabs/tagsTab.ts's TAGS; hide.test.ts holds them equal). */
export const FRIEND_MAP_MODULE = "friend-map";
export const TAGS_KIND = "tags";

/** After an edit saved on the Events page's Tables: a tag renamed takes its Hide switch over to its new name. */
export function followRename(edit: SavedEdit, storage?: Parameters<typeof renameStoredHidden>[3]): void {
  if (edit.module !== FRIEND_MAP_MODULE || edit.kind !== TAGS_KIND || edit.field !== "name") return;
  if (edit.before === null || edit.after === null) return;
  renameStoredHidden(edit.before, edit.after, edit.gone, storage);
}
