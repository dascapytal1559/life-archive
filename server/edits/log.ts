// The record of the tables' edits (archive/coreDb.ts's table_edit): one row for each edit made through a table's owner
// (edits.ts), from the page or the CLI: when, where from and who, which row and field, what it was and became (values,
// never a note's words, and people by the owner's ids, named as the record is read), the owner's receipt (what its undo
// is given back), and the edit that undid it or that it undid. It is the captain's "every edit is recorded and
// undoable": an Undo right after the edit, and `npm run archive -- edits` (cli.ts) to read it and undo any of it.
// A row of his own added or deleted (`action`) is kept the same way, its field empty and the row's fields by key as
// what it was (a delete's) or became (an add's).

import { getMeta, setMeta, transaction, type Db } from "../archive/db.ts";
import { NotFoundError } from "../errors.ts";
import type { EditRow } from "./editor.ts";
import type { EditAction, EditValue, RowValues } from "../../viewer/editWire.ts";

/** What an edit was and became: a field's value, or for an added or deleted row, its fields (null where there was no row). */
export type LoggedValue = EditValue | RowValues;

/** An edit as the record keeps it. */
export interface LoggedEdit {
  id: number;
  action: EditAction;
  at: number;
  surface: "app" | "cli";
  who: string | null;
  kind: string;
  row: EditRow;
  field: string;
  before: LoggedValue;
  after: LoggedValue;
  receipt: Record<string, unknown>;
  undoes: number | null;
  undoneBy: number | null;
}

interface StoredEdit {
  id: number;
  action: EditAction;
  at: number;
  surface: "app" | "cli";
  who: string | null;
  kind: string;
  module: string;
  origin: string;
  native_id: string;
  row_kind: string;
  field: string;
  before_json: string;
  after_json: string;
  receipt: string;
  undoes: number | null;
  undone_by: number | null;
}

const editOf = (row: StoredEdit): LoggedEdit => ({
  id: row.id,
  action: row.action,
  at: row.at,
  surface: row.surface,
  who: row.who,
  kind: row.kind,
  row: { module: row.module, origin: row.origin, nativeId: row.native_id, kind: row.row_kind },
  field: row.field,
  before: JSON.parse(row.before_json) as LoggedValue,
  after: JSON.parse(row.after_json) as LoggedValue,
  receipt: JSON.parse(row.receipt) as Record<string, unknown>,
  undoes: row.undoes,
  undoneBy: row.undone_by,
});

/** The core's meta key holding the last edit number given (reserve). */
const LAST_EDIT = "last_table_edit";

export class EditLog {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * A number for an edit about to be made, its own for good: taken before the owner is asked (its request ids and
   * audit name it), so two edits made at once never share one, and one that fails or changes nothing leaves its
   * number unused rather than handing it to the next (the core's meta keeps the last given).
   */
  reserve(): number {
    return transaction(this.db, () => {
      const given = Number(getMeta(this.db, LAST_EDIT) ?? 0);
      const kept = (this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM table_edit").get() as { id: number }).id;
      const id = Math.max(given, kept) + 1;
      setMeta(this.db, LAST_EDIT, String(id));
      return id;
    });
  }

  /** Keeps edit `id` (reserve's); with `undoes`, marks that edit undone by it. */
  add(id: number, edit: Omit<LoggedEdit, "id" | "undoneBy" | "action"> & { action?: EditAction }): number {
    this.db
      .prepare(`INSERT INTO table_edit (id, action, at, surface, who, kind, module, origin, native_id, row_kind, field, before_json, after_json, receipt, undoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, edit.action ?? "edit", edit.at, edit.surface, edit.who, edit.kind, edit.row.module, edit.row.origin, edit.row.nativeId, edit.row.kind, edit.field, JSON.stringify(edit.before), JSON.stringify(edit.after), JSON.stringify(edit.receipt), edit.undoes);
    if (edit.undoes !== null) this.db.prepare("UPDATE table_edit SET undone_by = ? WHERE id = ?").run(id, edit.undoes);
    return id;
  }

  /** Edit `id`; NotFoundError for none. */
  get(id: number): LoggedEdit {
    const row = this.db.prepare("SELECT * FROM table_edit WHERE id = ?").get(id) as StoredEdit | undefined;
    if (!row) throw new NotFoundError(`there is no edit #${id}`);
    return editOf(row);
  }

  /** The edits that undo edit `id`, the newest first (an undo, its undo undone, and an undo again). */
  undoesOf(id: number): LoggedEdit[] {
    return (this.db.prepare("SELECT * FROM table_edit WHERE undoes = ? ORDER BY id DESC").all(id) as unknown as StoredEdit[]).map(editOf);
  }

  /** The newest edits first: every table's, or one table's (`kind`), or one row's of it (`row`); older than `before` when given. */
  list({ kind, row, limit = 50, before }: { kind?: string; row?: Pick<EditRow, "module" | "origin" | "nativeId">; limit?: number; before?: number } = {}): LoggedEdit[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (kind !== undefined) where.push("kind = ?") && params.push(kind);
    if (row !== undefined) where.push("module = ? AND origin = ? AND native_id = ?") && params.push(row.module, row.origin, row.nativeId);
    if (before !== undefined) where.push("id < ?") && params.push(before);
    return (this.db.prepare(`SELECT * FROM table_edit ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params, limit) as unknown as StoredEdit[]).map(editOf);
  }

  /** A row's key changed by an edit (a logged call given other people): its earlier edits follow it, so its record and undo still find it. */
  moveRow(from: Pick<EditRow, "module" | "origin" | "nativeId">, to: Pick<EditRow, "origin" | "nativeId">): void {
    this.db.prepare("UPDATE table_edit SET origin = ?, native_id = ? WHERE module = ? AND origin = ? AND native_id = ?").run(to.origin, to.nativeId, from.module, from.origin, from.nativeId);
  }
}
