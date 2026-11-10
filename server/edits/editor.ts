// What a table's owner offers to have its rows edited (sdk/server.ts's `edits`; docs/modules.md's "Editing a table"):
// the captain's own words, "I would want to be able to edit tables directly from wherever I'm looking at a table", and
// the same table has the same permissions everywhere, so permission is the table's and the field's, never the page's.
//
// A table declares the fields it lets be edited beside its definition (sourceTab's `edits`, KindSpec's: how each is
// written, viewer/editWire.ts's EditField); its module gives a TableEditor for it, which the core's one edit route
// (http.ts) hands every edit of that table's rows to, by the row's own table, once the value has been read to its
// field's kind (values.ts). The editor writes through its own path (friend map's changesets, the exercise module's
// corrections, ritualctl), pushes the corrected row into the calendar itself, and answers what the field was and became
// and a receipt, its own record of the edit, which its undo is given back; the core keeps the record (log.ts).
//
// A change to an imported row is the captain's correction kept beside it, never a write over what its source gave, so
// the next import cannot overwrite it (as a person's name, a call's length or note already are): the owner reads its
// rows with its corrections over them, wherever they are read, the calendar's rebuild among them.
//
// Rows of the captain's own (a hangout, a call he logged) he also adds and deletes, in the table (the captain: add and
// delete rows "for his own records only"): an owner whose tab says so (`own`) gives `add`, `remove`, `kept` and
// `undoRow`, each through its own write path as an edit is, so an add or a delete is in the record and undone the same
// way. An imported row is never deleted: it is corrected or hidden instead.

import type { Effect } from "effect";
import type { Changes } from "../archive/changes.ts";
import type { InvalidInputError, NotFoundError, UnavailableError } from "../errors.ts";
import type { EditOption, EditValue, FieldState, RowValues } from "../../viewer/editWire.ts";

/**
 * A row of a table, as the calendar keys it (its module, origin and the source's own id) with its kind there; for a
 * table whose rows are not in the calendar (friend map's People and Tags: TableEditor's `rows`), as its owner keys it
 * the same way.
 */
export interface EditRow {
  readonly module: string;
  readonly origin: string;
  readonly nativeId: string;
  /** Its kind in the calendar (workout, call, hangout, ritual_habit, ritual_day), or its owner's (person, tag). */
  readonly kind: string;
}

/**
 * How an owner finds the rows of a table of its that are not in the calendar (friend map's People and Tags): row `id`
 * of the table (its own id there), null for none; and a row's id in the table now, null once it has gone (a person
 * merged into another, a tag deleted).
 */
export interface OwnTableRows {
  find(id: string): EditRow | null;
  idOf(row: Pick<EditRow, "origin" | "nativeId" | "kind">): string | null;
}

/** Where an edit comes from: the page (app) or the CLI, who (on the CLI, as $LIFE_ARCHIVE_READER names them), his words, and its number in the record. */
export interface EditMeta {
  readonly surface: "app" | "cli";
  readonly who: string | null;
  readonly why: string | null;
  /** The number the record gives this edit, for an owner's request ids (ritualctl's). */
  readonly edit: number;
}

/** What an edit did: the field before and after (null both for a note's words, which the record never keeps), and the owner's receipt. */
export interface Applied {
  readonly before: EditValue;
  readonly after: EditValue;
  /** The owner's own record of the edit, as JSON (friend map's changeset number), which its undo is given back. */
  readonly receipt: Readonly<Record<string, unknown>>;
  /** The row's key after it, when the edit gave it another (a logged call whose people changed); the same row's when left out. */
  readonly row?: Pick<EditRow, "origin" | "nativeId">;
  /** False when it changed nothing (a note given the words it had), so the record keeps nothing; true when left out. */
  readonly changed?: boolean;
}

export type EditFailure = InvalidInputError | NotFoundError | UnavailableError;

/** A table's owner's answers for editing its rows (see the top). */
export interface TableEditor {
  /** The table it edits: its tab's kind. */
  readonly table: string;
  /** For a table whose rows are not in the calendar: how its rows are found (OwnTableRows). Left out, by their calendar row. */
  readonly rows?: OwnTableRows;
  /** The row's editable fields as they stand now, by key (a field this row cannot have changed `locked`, saying why); null when the owner has no such row. */
  state(row: EditRow): Record<string, FieldState> | null;
  /**
   * Changes `field` of `row` to `value` (already read to the field's kind: values.ts), through the owner's own write,
   * and pushes the row into the calendar; refused (InvalidInputError) for a value its rules do not take, or a field this
   * row cannot have changed.
   */
  apply(row: EditRow, field: string, value: EditValue, meta: EditMeta): Effect.Effect<Applied, EditFailure>;
  /** Puts back the edit whose receipt is `receipt`, as an edit of its own; refused (UnavailableError) when the field has changed since. */
  undo(row: EditRow, field: string, receipt: Readonly<Record<string, unknown>>, meta: EditMeta): Effect.Effect<Applied, EditFailure>;
  /**
   * Which fields of each of `rows` this row keeps as it is, and why (state's `locked`), in one go, for a page of the
   * grid, which edits a cell in place only where its row lets it; null for a row the owner has not. For an owner whose
   * state is slow to read row by row (a call's, rituals' view); left out, each row's state is read.
   */
  locked?(rows: readonly EditRow[]): ReadonlyArray<Readonly<Record<string, string>> | null>;
  /**
   * For an owner whose own log keeps each edit and can undo it outside the tables too (friend map's change log, from
   * its Changes): whether the edit whose receipt is `receipt` stands undone in that log now (what undid it, by its
   * receipt, and where, in words), or stands (false); null once the log no longer has it, so the core's record says.
   * The record reads an edit's standing from here, so the two never tell different stories (undoneInLog makes one).
   */
  undone?(receipt: Readonly<Record<string, unknown>>): Undone | false | null;
  /** A note's words, for its editor (content: the route keeps the read in the trail); null for none. */
  note?(row: EditRow, field: string): string | null;
  /**
   * What a people field can take, matching `query` by name, the best first; or what a `text` or `tags` field that
   * `suggests` offers (the locations in use, the tags), the best first.
   */
  options?(field: string, query: string): EditOption[];
  /**
   * For a table whose rows are partly the captain's own records (its tab's `own`, viewer/editWire.ts's OwnRows): adds
   * one, from each field Add asks (already read to its kind: values.ts), through the owner's own write, and pushes it
   * into the calendar; its key there, and the receipt its undo is given back. Refused for values its rules do not take;
   * refused with UnavailableError for one it would have him be sure of (someone already goes by the name), unless
   * `anyway`, which Add then offers.
   */
  add?(values: RowValues, meta: EditMeta, options?: { anyway: boolean }): Effect.Effect<Added, EditFailure>;
  /**
   * Deletes `row`, one of the captain's own, through the owner's own write, and takes it from the calendar; the receipt
   * its undo is given back. Refused (InvalidInputError) for a row that is not his own: an imported row is never deleted.
   */
  remove?(row: EditRow, meta: EditMeta): Effect.Effect<Pick<Applied, "receipt">, EditFailure>;
  /** Why `row` cannot be deleted (an imported call's "its source's"), or null when it can. */
  kept?(row: EditRow): string | null;
  /** Puts back the add or delete whose receipt is `receipt` (the row gone again, or back), as an edit of its own. */
  undoRow?(row: EditRow, receipt: Readonly<Record<string, unknown>>, meta: EditMeta): Effect.Effect<Pick<Applied, "receipt">, EditFailure>;
}

/** A row of the captain's own added: its key in the calendar, and the owner's receipt. */
export interface Added {
  readonly row: Pick<EditRow, "origin" | "nativeId" | "kind">;
  readonly receipt: Readonly<Record<string, unknown>>;
}

/** What undid an edit, as its owner's log says: the receipt that undo would have been given, and where, in words. */
export interface Undone {
  readonly by: Readonly<Record<string, unknown>>;
  readonly where: string;
}

/**
 * TableEditor's `undone` for an owner whose receipts are a change log's changesets ({changeset}: friend map's, the
 * exercise module's), named `where` ("Friend Map's Changes"): read from the log's own standing (changes.ts).
 */
export function undoneInLog(changes: Pick<Changes, "standing">, where: string): NonNullable<TableEditor["undone"]> {
  return (receipt) => {
    if (typeof receipt.changeset !== "number") return null;
    const standing = changes.standing(receipt.changeset);
    if (standing === null) return null;
    return standing.undoneBy === null ? false : { by: { changeset: standing.undoneBy }, where: `${where} (its #${standing.undoneBy})` };
  };
}
