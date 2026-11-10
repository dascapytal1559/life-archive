// Which row a table's drawer has open after an edit, an add's or a delete's Undo, or any edit that gives a row another
// id (a call given other people) or takes it from its table (Rows.tsx: from a cell, from the drawer itself): rows are
// named by their id in the table now, as the edit's answer says it, never by the id they had before it.

import type { EditDone } from "./editWire.ts";

/**
 * What is open after edit `done` to row `row`, while `open` was: another row stays open; the row edited follows it to
 * its id now; and once it has left its table, the drawer closes (`gone: "close"`, its Undo said by the table) or stays
 * on it (`"keep"`, the drawer saying it left, with its Undo), never on the empty id an answer gives a row gone.
 */
export function openAfter(open: string | null, row: string, done: Pick<EditDone, "id" | "gone">, gone: "close" | "keep"): string | null {
  if (open !== row) return open;
  if (done.gone) return gone === "close" ? null : open;
  return done.id;
}
