// What a module's page half hears of an edit saved on the Events page's Tables (sdk/viewer.ts's ViewerDefinition's
// `saved`): which table and field, and what it was and became as the record keeps them, in words. For what a module
// keeps in the browser beside its tables: friend map's Hide carries a tag renamed in its Tags table over to the new
// name. A field changed in a cell or a drawer (api.ts's postEdit) is told, and an undo (postUndo) as the edit it is; not an add or a delete. One
// module's hook that fails takes nothing from the edit, which stands, nor from the other modules' hooks.

import type { EditDone, EditsAnswer } from "./editWire.ts";
import type { ModuleViewer } from "./modules.ts";

/** An edit saved, as a module's `saved` hears it. */
export interface SavedEdit {
  /** The module whose table it is, and the table (its kind). */
  module: string;
  kind: string;
  field: string;
  /** What the field was and became, in words, as the record keeps them (editWire.ts's editValueText; null for a note's). */
  before: string | null;
  after: string | null;
  /** The row left its table with it (a tag renamed onto one that exists, so merged into it). */
  gone: boolean;
}

/** Tells each module's page half that listens of the edit `done` made (to table `kind`, when known), as the record keeps it; never throws. */
export async function tellSaved(
  kind: string | undefined,
  done: EditDone,
  { viewers, record }: { viewers: () => readonly ModuleViewer[]; record: (ask: { kind?: string; limit: number; before: number }) => Promise<EditsAnswer> },
): Promise<void> {
  try {
    const hooks = viewers().flatMap(({ viewer }) => (viewer?.saved ? [viewer.saved] : []));
    if (done.edit === null || hooks.length === 0) return;
    const { edits } = await record({ kind, limit: 1, before: done.edit + 1 });
    const edit = edits.find((logged) => logged.id === done.edit);
    if (!edit) return;
    const saved: SavedEdit = { module: edit.module, kind: edit.kind, field: edit.field, before: edit.before, after: edit.after, gone: done.gone };
    for (const hook of hooks) {
      try {
        hook(saved);
      } catch (cause) {
        console.error("A module's page half failed on a saved edit:", cause);
      }
    }
  } catch (cause) {
    console.error("The modules' page halves were not told of a saved edit:", cause);
  }
}
