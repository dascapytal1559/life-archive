// What the page and the server say to each other about editing a table's rows (server/edits/): which fields of a table
// can be edited and how each is written (EditField, declared by the table's owner beside the table: KindSpec's
// `edits`), a row's fields as they stand now (EditState), an edit asked for (EditAsk) and what it did (EditDone), and
// the record of edits, each undoable (EditRecord). One table has the same fields editable wherever it is drawn: a cell
// of the grid (viewer/VirtualTable.tsx), the Calendar's drawer and the table's own (one drawer, viewer/RowDrawer.tsx)
// all edit through the one field editor (viewer/FieldEditor.tsx), so they edit alike.
//
//   GET  EDITS_API/row?kind=&id=        -> EditState: the row's editable fields now (404 for a table with none)
//   GET  EDITS_API/locks?kind=&ids=     -> LocksAnswer: which fields of each of a page's rows stay as they are, for the grid
//   POST EDITS_API                      {kind, id, field, value} -> EditDone: the edit made, recorded, and the row now
//   POST EDITS_API/:edit/undo           -> EditDone: the edit put back, as an edit of its own
//   GET  EDITS_API?kind=&id=&limit=&before= -> EditsAnswer: the record, newest first (a row's, with kind and id; older than `before`)
//   GET  EDITS_API/options?kind=&field=&q= -> OptionsAnswer: what a people field can take, by name, or a text or tags field offers
//   GET  EDITS_API/note?kind=&id=&field= -> NoteAnswer: a note's words, to edit them; content, so kept in the trail
//   POST EDITS_API/add                  {kind, values, anyway?} -> EditDone: a row of the captain's own added (OwnRows), recorded
//   POST EDITS_API/delete               {kind, id} -> EditDone: a row of his own deleted (`gone`), recorded; an imported row never
//
// A table whose rows are partly the captain's own records (a hangout, a call he logged) says so (KindSpec's `own`):
// what Add asks, and which rows can be deleted. An add or a delete is an edit like any other: one in the record, and
// undone the same way (the record's `action` says which it was).
//
// Values on the wire: a time is the archive's wall clock, "2026-10-04T19:30" (or a date alone, "2026-10-04", for a
// field that may have no time: a hangout's), never an instant, so it is read and written in the archive's time zone
// whatever the browser's; minutes and hours are numbers, a distance a number in its unit, people their ids.

import { wallClock } from "../src/time.ts";
import { dateText, timeText } from "./format.ts";
import { API_BASE } from "./wire.ts";

export const EDITS_API = `${API_BASE}/edits`;

/**
 * How a field is edited: a time of day on a date (`datetime`; `dateOnly` allows a date with no time), a whole number of
 * minutes, hours to two places, a number in `unit`, one of `choices`, people by id, a note (free text: content, so
 * read only when asked, through the trail), a short text that is no content (a person's name, a location; `long` for
 * one of a few lines, a person's note), or tags (several short texts, in order, each one of the table's or a new one).
 */
export type EditInput = "datetime" | "minutes" | "hours" | "number" | "choice" | "people" | "note" | "text" | "tags";

/** The longest text a `text` field takes, and each of a `tags` field's. */
export const TEXT_MOST = 2000;

export interface EditChoice {
  value: string;
  label: string;
}

/** A field of a table that can be edited: a column's (its key) or one only its drawer shows. */
export interface EditField {
  key: string;
  label: string;
  input: EditInput;
  /** For `choice`: what it can be. */
  choices?: EditChoice[];
  /** For `number`: its unit ("km") and its bounds. */
  unit?: string;
  min?: number;
  max?: number;
  /** For `datetime`: a date with no time is a value too (a hangout on its date alone). */
  dateOnly?: boolean;
  /** It can be emptied (a distance taken away, a note removed). */
  clearable?: boolean;
  /** For `text`: a few lines, not one (a person's note). */
  long?: boolean;
  /**
   * For `text` and `tags`: what is typed is offered the table's own values that match it (OptionsAnswer: the locations
   * in use, the tags), a new one taken as well. A `people` field always offers people.
   */
  suggests?: boolean;
}

/** An edit's value on the wire (see the top): `tags` a list of texts, `people` a list of ids. */
export type EditValue = string | number | number[] | string[] | null;

/**
 * The rows of a table that are the captain's own records (a hangout, a call he logged), which he adds and deletes
 * there: what Add asks, in order (the table's own fields, as its `edits` declare them, and any only an add asks: what a
 * call was on), and which rows can be deleted, in words ("calls you logged"). An imported row is never deleted.
 */
export interface OwnRows {
  add: EditField[];
  deletes: string;
}

/** What an edit in the record did: changed a field of a row, added a row of the captain's own, or deleted one. */
export type EditAction = "edit" | "add" | "delete";

/** A row's fields by key, as an add gives them and the record keeps an added or deleted row (a note's words never). */
export type RowValues = Readonly<Record<string, EditValue>>;

/** How a person a people field names is called when nobody has a name for them. */
export const unnamedPerson = (id: number): string => `Person ${id}`;

/**
 * An edit's value in words, the page's and the record's alike (the drawer's "edited" mark, its "Saved." line, the
 * record server/edits/ keeps): a time as a day says it, in the archive's time zone, people by name (`names`), and a
 * note as "a note" (its words are content, never shown here).
 */
export function editValueText(field: EditField, value: EditValue, names: Readonly<Record<number, string>> = {}): string {
  if (field.input === "note") return "a note";
  if (value === null) return "none";
  switch (field.input) {
    case "datetime": {
      const [day, time] = String(value).split("T");
      const at = wallClock(day!, time ?? "00:00");
      return time === undefined ? dateText(at) : `${dateText(at)} ${timeText(at)}`;
    }
    case "minutes":
      return `${value} min`;
    case "hours":
      return `${value} h`;
    case "number":
      return `${value}${field.unit ? ` ${field.unit}` : ""}`;
    case "choice":
      return field.choices?.find((choice) => choice.value === value)?.label ?? String(value);
    case "people":
      return (value as number[]).map((id) => names[id] ?? unnamedPerson(id)).join(", ");
    case "text":
      return String(value);
    case "tags":
      return (value as string[]).length === 0 ? "none" : (value as string[]).join(", ");
  }
}

/** A field of one row as it stands. */
export interface FieldState {
  /** Its value now; for a note, null (its words are content: NoteAnswer reads them). */
  value: EditValue;
  /** Whether it has words, for a note. */
  has?: boolean;
  /** What its source said, when the captain's correction stands over it (shown on hovering its "edited" mark). */
  original?: EditValue;
  /** Why this row's field cannot be edited, when it cannot ("an imported call's time is its source's"). */
  locked?: string;
}

/** A row's editable fields as they stand, by key, with the names of the people they name. */
export interface EditState {
  fields: Record<string, FieldState>;
  people: Record<number, string>;
  /** For a table whose own rows can be deleted (OwnRows): whether this one can, and why not (an imported call) when it cannot. */
  delete?: { locked?: string };
}

/**
 * Add asked for: the table, and each field Add asks by key (OwnRows's `add`). An owner may refuse an add it would have
 * him be sure of (someone already goes by that name) with 409; Add then offers to add it `anyway`.
 */
export interface AddAsk {
  kind: string;
  values: Record<string, EditValue>;
  anyway?: boolean;
}

export interface EditAsk {
  kind: string;
  id: string;
  field: string;
  value: EditValue;
}

/**
 * An edit made (or undone): its number in the record (null when the value was the field's already, so nothing changed),
 * and the row as it now stands; `gone` when the row left its table (a habit no longer done).
 */
export interface EditDone {
  edit: number | null;
  /** The row's id now: the same, but for an edit that made it anew. */
  id: string;
  state: EditState | null;
  gone: boolean;
}

/**
 * One edit in the record (server/edits/log.ts): who, when, which row and field, what it was and became (as words; a
 * note's never), and whether it stands undone now. For an owner with a change log of its own (friend map's), whether it
 * stands is that log's, so an edit undone from Friend Map's Changes is undone here too.
 */
export interface EditRecord {
  id: number;
  /** A field changed, or a row added or deleted: for those, `label` is the row's noun and before and after the row in words. */
  action: EditAction;
  at: number;
  surface: string;
  who: string | null;
  kind: string;
  module: string;
  /** The row's id in its table now, to open it; null once it has left the table. */
  rowId: string | null;
  field: string;
  label: string;
  before: string | null;
  after: string | null;
  undoes: number | null;
  /** The edit of the record that undid it, while that undo stands. */
  undoneBy: number | null;
  /** What undid it, in words, while it stands undone ("by #14", "in Friend Map's Changes (its #31)"); null while it stands. */
  undone: string | null;
}

export interface EditsAnswer {
  edits: EditRecord[];
}

/**
 * An edit's change in words, the page's and the CLI's alike: "When: 6 Mar 2026 7:00 pm → 7 Mar 2026 8:00 pm", "Note
 * changed", "Added hangout: 7 Mar 2026 · Ada · 2 h", "Deleted call: …", and an undo's "Undid #12: …".
 */
export function editChangeText(edit: Pick<EditRecord, "action" | "label" | "before" | "after" | "undoes">): string {
  const change = edit.action === "add" ? `Added ${edit.label}${edit.after ? `: ${edit.after}` : ""}`
    : edit.action === "delete" ? `Deleted ${edit.label}${edit.before ? `: ${edit.before}` : ""}`
    : edit.before !== null || edit.after !== null ? `${edit.label}: ${edit.before ?? "—"} → ${edit.after ?? "—"}` : `${edit.label} changed`;
  return edit.undoes !== null ? `Undid #${edit.undoes}: ${change}` : change;
}

/** A row's values in words, for the record of its add or delete: each field Add asks but its note, as the page says it, " · " between. */
export function rowValuesText(fields: readonly EditField[], values: RowValues, names: Readonly<Record<number, string>> = {}): string {
  return fields.filter((field) => field.input !== "note" && values[field.key] !== undefined && values[field.key] !== null)
    .map((field) => editValueText(field, values[field.key]!, names)).join(" · ");
}

/**
 * Which fields of each row asked stay as they are, and why (FieldState's `locked`), by the row's id: what the grid
 * needs to edit a cell in place, for a page of rows in one ask. A row left out cannot be edited at all.
 */
export interface LocksAnswer {
  rows: Record<string, Record<string, string>>;
}

/** The most rows one LocksAnswer is asked for (a page of the grid's is 100). */
export const LOCKS_MOST = 200;

/** What a field can take, matching what was typed: people by id, or a `text` or `tags` field's values in use. */
export interface OptionsAnswer {
  options: EditOption[];
}

export interface EditOption {
  value: number | string;
  label: string;
}

export interface NoteAnswer {
  note: string;
}
