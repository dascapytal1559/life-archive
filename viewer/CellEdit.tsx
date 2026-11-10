// A cell of the grid edited in place (VirtualTable.tsx), the captain's "Edit in the grid": a column its table's owner
// lets be edited (KindSpec's `edits`) is clicked, and the drawer's own field editor (FieldEditor.tsx's OpenEditor) opens
// over the cell, writing through the one edit route (server/edits/), so a cell has the permissions, the record and the
// undo the drawer has. Which cells a row keeps as they are (an imported call's time) comes with each page of rows
// (LocksAnswer), so the grid asks once a page, never once a row; such a cell, and a row the owner has not, opens the
// drawer as every read-only cell does, its title saying why. A note has no column, so it is the drawer's; so are the
// row's record and what the table has no column for. On a phone the grid is only read: a tap opens the drawer, which edits.

import { useEffect, useState } from "react";
import { fetchEditState } from "./api.ts";
import { OpenEditor } from "./FieldEditor.tsx";
import type { EditField, EditState, EditValue } from "./editWire.ts";
import type { KindSpec } from "./wire.ts";

/** The widths at which the grid edits in place: the console's desk layout (console/phone.css's phone is narrower). */
export const EDIT_IN_PLACE = "(min-width: 900px)";

/** What a cell is to editing: a field to edit in place, one this row keeps as it is (and why), or only read. */
export type CellEditing = { field: EditField } | { locked: string } | null;

/**
 * What column `key` of a row is to editing, by its table's fields and the row's locks (LocksAnswer's, undefined for a
 * row its owner has not, or whose locks are not yet known): a note is never a cell's (it has no column).
 */
export function cellEditing(spec: Pick<KindSpec, "edits">, key: string, locks: Readonly<Record<string, string>> | undefined): CellEditing {
  const field = spec.edits?.find((f) => f.key === key && f.input !== "note");
  if (!field || locks === undefined) return null;
  const locked = locks[key];
  return locked === undefined ? { field } : { locked };
}

/** Whether the screen is wide enough to edit in place (EDIT_IN_PLACE), following it as it changes. */
/** The cell open for editing once cell `cell`'s editor is done: none when it is still that one, else the one opened since (another cell clicked while this one saved). */
export function editingAfter<Cell extends { id: string; key: string }>(editing: Cell | null, cell: { id: string; key: string }): Cell | null {
  return editing !== null && editing.id === cell.id && editing.key === cell.key ? null : editing;
}

/** A cell's save, its failure said by `say` too (under the table, which outlasts the cell's editor, gone once another cell is clicked), then to the editor. */
export function sayingFailure<T>(save: Promise<T>, say: (message: string) => void): Promise<T> {
  return save.catch((error: Error) => {
    say(error.message);
    throw error;
  });
}

export function useEditInPlace(): boolean {
  const query = typeof matchMedia === "function" ? matchMedia(EDIT_IN_PLACE) : null;
  const [wide, setWide] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}

/**
 * Field `field` of row `rowId` of table `kind`, open over its cell: the row's fields read as it opens (a time in the
 * archive's wall clock, people by id), saved by `onSave`; `onDone` once saved or put back. Clicks and keys inside it go
 * no further, so the row does not open in the drawer under it.
 */
export function CellEditor({ kind, rowId, field, onSave, onDone }: { kind: string; rowId: string; field: EditField; onSave: (value: EditValue) => Promise<void>; onDone: () => void }) {
  const [state, setState] = useState<EditState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetchEditState(kind, rowId, abort.signal).then(setState, (error: Error) => abort.signal.aborted || setFailed(error.message));
    return () => abort.abort();
  }, [kind, rowId]);
  const standing = state?.fields[field.key];
  return (
    <div className="table__cell-editor" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => (event.key === "Escape" && onDone(), event.stopPropagation())}>
      {failed || (state && (!standing || standing.locked)) ? (
        <span className="table__cell-why">
          <span className={`edit__status${failed ? " edit__status--failed" : ""}`} role="alert">
            {failed ? `Cannot edit it: ${failed}` : `Not editable: ${standing?.locked ?? `this row's ${field.label} cannot be edited`}`}
          </span>
          <button type="button" className="drawer__undo" autoFocus onClick={onDone}>Close</button>
        </span>
      ) : !state || !standing ? (
        <span className="table__dim">Reading…</span>
      ) : (
        <OpenEditor kind={kind} rowId={rowId} field={field} state={standing} people={state.people} onSave={onSave} onDone={onDone} />
      )}
    </div>
  );
}
