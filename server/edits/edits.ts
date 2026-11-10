// Editing the tables (editor.ts says what an owner offers, http.ts the route): one registry over every table, its
// fields as its definition declares them (KindSpec's `edits`) and its owner's editor (sdk/server.ts's `edits`), which
// finds a row by the table's own id for it, hands an edit to the row's own owner, refuses a field the table does not
// let be edited (or this row's owner keeps as it is: an imported call's time), keeps every edit in the record
// (log.ts), and undoes any of it through the owner that made it. A row's id in a table that can be edited is its
// calendar row's (a table over the calendar, server/viewer/sourceTab.ts), so the calendar names its owner and key; a
// table whose rows are not in the calendar (friend map's People and Tags) has its owner find them (TableEditor's `rows`).
// It says the grid which cells of a page of rows stay as they are (locks), so a cell is edited in place only where its
// row lets it. The record is one: for an owner whose own log keeps its edits and undoes them outside the tables too
// (friend map's change log, from its Changes), whether an edit stands undone is read from that log (undoneOf).
// A table whose rows are partly the captain's own (its tab's `own`) takes an add of one and a delete of one (add,
// remove), each in the record as an edit is (its action), undone through the owner the same way; a row its owner says
// is not his own (`kept`: an imported call) is never deleted.

import type { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import type { ModuleEvents } from "../../sdk/server.ts";
import type { ContentLog } from "../archive/contentLog.ts";
import type { Archive } from "../archive/index.ts";
import { moduleEditors, moduleEvents, moduleOwners } from "../modules/loader.ts";
import { ownerOf, type Owners } from "../calendar/owners.ts";
import { ForbiddenError, InvalidInputError, NotFoundError, UnavailableError } from "../errors.ts";
import type { Tab } from "../viewer/tab.ts";
import { LOCKS_MOST, rowValuesText, unnamedPerson, type EditDone, type EditField, type EditOption, type EditRecord, type EditState, type EditValue, type OwnRows, type RowValues } from "../../viewer/editWire.ts";
import type { EditFailure, EditMeta, EditRow, TableEditor } from "./editor.ts";
import { EditLog, type LoggedEdit, type LoggedValue } from "./log.ts";
import { readValue, valueText } from "./values.ts";

/** Where an edit or an undo comes from (EditMeta less its number, which the registry gives). */
export type EditSource = Omit<EditMeta, "edit">;

const same = (a: EditValue, b: EditValue) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a value of the record is a row's fields (an add's or a delete's), not one field's. */
const isRow = (value: LoggedValue): value is RowValues => value !== null && typeof value === "object" && !Array.isArray(value);

/** The person ids a people field's value names (none for any other value). */
const idsIn = (value: unknown): number[] => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : []);

export class TableEdits {
  private readonly tabs: readonly Tab[];
  private readonly editors: ReadonlyMap<string, TableEditor>;
  private readonly calendar: DatabaseSync;
  private readonly log: EditLog;
  private readonly owners: Owners;
  private readonly contentLog: Pick<ContentLog, "record">;

  constructor({ tabs, editors, calendar, core, owners, contentLog }: {
    tabs: readonly Tab[];
    editors: readonly TableEditor[];
    calendar: DatabaseSync;
    core: DatabaseSync;
    owners: Owners;
    contentLog: Pick<ContentLog, "record">;
  }) {
    this.tabs = tabs;
    this.editors = new Map(editors.map((editor) => [editor.table, editor]));
    this.calendar = calendar;
    this.log = new EditLog(core);
    this.owners = owners;
    this.contentLog = contentLog;
    for (const editor of editors) {
      const tab = tabs.find((t) => t.spec.kind === editor.table);
      if (!tab?.spec.edits?.length) throw new Error(`an editor was given for the ${editor.table} table, which ${tab ? "declares no fields to edit" : "there is not"}`);
      const adds = Boolean(editor.add && editor.remove && editor.undoRow);
      if (Boolean(tab.spec.own) !== adds) {
        throw new Error(tab.spec.own
          ? `the ${editor.table} table takes rows of the captain's own, but its editor cannot add, delete and undo them`
          : `the ${editor.table} table's editor adds rows, but the table declares none of the captain's own (own)`);
      }
    }
  }

  /** The tables that can be edited, by kind. */
  tables(): string[] {
    return [...this.editors.keys()];
  }

  /** Table `kind`, with its fields and its owner's editor; refused for a table there is not, or one with nothing to edit. */
  private tableOf(kind: string): { tab: Tab; fields: readonly EditField[]; editor: TableEditor } {
    const tab = this.tabs.find((t) => t.spec.kind === kind);
    if (!tab) throw new NotFoundError(`there is no ${JSON.stringify(kind)} table`);
    const editor = this.editors.get(kind);
    if (!editor || !tab.spec.edits?.length) throw new ForbiddenError(`the ${tab.spec.label} table is only read: nothing in it can be edited`);
    return { tab, fields: tab.spec.edits, editor };
  }

  /**
   * Row `id` of table `kind`, with the table's fields and its owner's editor; refused for a table with none, or a row
   * that is not its. Found by its owner for a table whose rows are not in the calendar (TableEditor's `rows`), else by
   * its calendar row.
   */
  private rowOf(kind: string, id: string): { row: EditRow; fields: readonly EditField[]; editor: TableEditor } {
    const { tab, fields, editor } = this.tableOf(kind);
    if (!/^\d+$/.test(id)) throw new InvalidInputError(`a row of the ${tab.spec.label} table is its number, not ${JSON.stringify(id)}`);
    if (editor.rows) {
      const row = editor.rows.find(id);
      if (!row) throw new NotFoundError(`the ${tab.spec.label} table has no row ${id}`);
      return { row, fields, editor };
    }
    const event = this.calendar.prepare("SELECT module, origin, native_id, kind FROM event WHERE id = ?").get(Number(id)) as
      { module: string; origin: string; native_id: string; kind: string } | undefined;
    if (!event) throw new NotFoundError(`the ${tab.spec.label} table has no row ${id}`);
    if (event.module !== tab.spec.module) throw new InvalidInputError(`row ${id} is ${event.module}'s, not a row of the ${tab.spec.label} table`);
    return { row: { module: event.module, origin: event.origin, nativeId: event.native_id, kind: event.kind }, fields, editor };
  }

  /** Rows `ids` of a table that the owner of `editor` keeps, by id, as the table's rows are found (rowOf); those it has not left out. */
  private rowsOf(module: string, editor: TableEditor, ids: readonly string[]): Array<{ id: string; row: EditRow }> {
    if (editor.rows) {
      const rows = editor.rows;
      return ids.flatMap((id) => {
        const row = rows.find(id);
        return row ? [{ id, row }] : [];
      });
    }
    return (this.calendar.prepare("SELECT id, module, origin, native_id, kind FROM event WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids.map(Number))) as
      Array<{ id: number; module: string; origin: string; native_id: string; kind: string }>)
      .filter((event) => event.module === module)
      .map((event) => ({ id: String(event.id), row: { module: event.module, origin: event.origin, nativeId: event.native_id, kind: event.kind } }));
  }

  /**
   * Which fields of each of rows `ids` of table `kind` stay as they are, and why, by id (LocksAnswer): a page of the
   * grid's, in one ask, from its owner's `locked` when it has one and each row's state otherwise (a field its state
   * leaves out is one this row cannot have changed). A row its owner has not, or not of this table, is left out.
   */
  locks(kind: string, ids: readonly string[]): Record<string, Record<string, string>> {
    const { tab, fields, editor } = this.tableOf(kind);
    if (ids.length > LOCKS_MOST) throw new InvalidInputError(`a page's locks are asked for at most ${LOCKS_MOST} rows, not ${ids.length}`);
    const odd = ids.find((id) => !/^\d+$/.test(id));
    if (odd !== undefined) throw new InvalidInputError(`a row of the ${tab.spec.label} table is its number, not ${JSON.stringify(odd)}`);
    const found = this.rowsOf(tab.spec.module ?? "", editor, ids);
    const said = editor.locked
      ? editor.locked(found.map(({ row }) => row))
      : found.map(({ row }) => {
          const state = editor.state(row);
          if (state === null) return null;
          return Object.fromEntries(fields.flatMap((field) => {
            const standing = state[field.key];
            return !standing ? [[field.key, `this row's ${field.label} cannot be edited`]] : standing.locked ? [[field.key, standing.locked]] : [];
          }));
        });
    return Object.fromEntries(found.flatMap(({ id }, i) => (said[i] ? [[id, { ...said[i] }]] : [])));
  }

  /** The row's id in its table now, by its key: its owner's for a table not in the calendar, else its calendar row's; null once it has gone (a habit no longer done). */
  private idOf(row: EditRow, editor: TableEditor | undefined): string | null {
    if (editor?.rows) return editor.rows.idOf(row);
    const found = this.calendar.prepare("SELECT id FROM event WHERE module = ? AND origin = ? AND native_id = ?").get(row.module, row.origin, row.nativeId) as { id: number } | undefined;
    return found ? String(found.id) : null;
  }

  /**
   * The row's fields as its owner says they stand, the table's alone, with everyone they name, and for a table of the
   * captain's own rows whether this one can be deleted; null when its owner has it no more.
   */
  private stateOf(row: EditRow, fields: readonly EditField[], editor: TableEditor): EditState | null {
    const said = editor.state(row);
    if (said === null) return null;
    const known = Object.fromEntries(fields.filter((field) => said[field.key] !== undefined).map((field) => [field.key, said[field.key]!]));
    const ids = fields.filter((field) => field.input === "people").flatMap((field) => [known[field.key]?.value, known[field.key]?.original]).flatMap(idsIn);
    const state: EditState = { fields: known, people: this.names(row.module, ids) };
    if (editor.remove) {
      const kept = editor.kept?.(row) ?? null;
      state.delete = kept === null ? {} : { locked: kept };
    }
    return state;
  }

  /** Table `kind`, which takes rows of the captain's own, with what Add asks and its owner's editor; refused for one that takes none. */
  private ownOf(kind: string): { tab: Tab; fields: readonly EditField[]; own: OwnRows; editor: Required<Pick<TableEditor, "add" | "remove" | "undoRow">> & TableEditor } {
    const { tab, fields, editor } = this.tableOf(kind);
    const { add, remove, undoRow } = editor;
    if (!tab.spec.own || !add || !remove || !undoRow) throw new ForbiddenError(`the ${tab.spec.label} table's rows all come from imports: none is added or deleted here`);
    return { tab, fields, own: tab.spec.own, editor: { ...editor, add, remove, undoRow } };
  }

  /** A row's fields as the record keeps an added or deleted one: each Add asks that its owner says (a note's words never). */
  private valuesOf(row: EditRow, own: OwnRows, editor: TableEditor): RowValues | null {
    const said = editor.state(row);
    if (said === null) return null;
    return Object.fromEntries(own.add.filter((field) => field.input !== "note" && said[field.key] !== undefined).map((field) => [field.key, said[field.key]!.value]));
  }

  /**
   * Adds a row of the captain's own to table `kind` from `values`, each field Add asks read to its kind (values.ts; one
   * left out is empty, refused where it cannot be): written by the table's owner, kept in the record as an add. An add
   * its owner would have him be sure of (someone of that name already) is refused (409) unless `anyway`.
   */
  add(kind: string, values: unknown, source: EditSource, { anyway = false }: { anyway?: boolean } = {}): Effect.Effect<EditDone, EditFailure | ForbiddenError> {
    return Effect.gen({ self: this }, function* () {
      const { tab, fields, own, editor } = this.ownOf(kind);
      if (typeof values !== "object" || values === null || Array.isArray(values)) throw new InvalidInputError(`an add is the new ${tab.spec.noun[0]}'s fields by key: ${own.add.map((f) => f.key).join(", ")}`);
      const given = values as Record<string, unknown>;
      const odd = Object.keys(given).find((key) => !own.add.some((field) => field.key === key));
      if (odd !== undefined) throw new InvalidInputError(`a new ${tab.spec.noun[0]} takes ${own.add.map((f) => f.label).join(", ")}, not ${JSON.stringify(odd)}`);
      const read = Object.fromEntries(own.add.map((field) => [field.key, readValue(field, given[field.key] ?? null)]));
      const number = this.log.reserve();
      const added = yield* editor.add(read, { ...source, edit: number }, { anyway });
      const row: EditRow = { module: tab.spec.module!, ...added.row };
      this.log.add(number, { action: "add", at: Date.now(), surface: source.surface, who: source.who, kind, row, field: "", before: null, after: this.valuesOf(row, own, editor), receipt: added.receipt, undoes: null });
      return this.done(number, row, fields, editor, "");
    });
  }

  /** Deletes row `id` of table `kind`, one of the captain's own (refused for one its owner keeps: an imported row), kept in the record as a delete. */
  remove(kind: string, id: string, source: EditSource): Effect.Effect<EditDone, EditFailure | ForbiddenError> {
    return Effect.gen({ self: this }, function* () {
      const { own, editor } = this.ownOf(kind);
      const { row, fields } = this.rowOf(kind, id);
      const before = this.valuesOf(row, own, editor);
      if (before === null) throw new NotFoundError(`row ${id} is no longer in the ${kind} table`);
      const kept = editor.kept?.(row) ?? null;
      if (kept !== null) throw new ForbiddenError(kept);
      const number = this.log.reserve();
      const { receipt } = yield* editor.remove(row, { ...source, edit: number });
      this.log.add(number, { action: "delete", at: Date.now(), surface: source.surface, who: source.who, kind, row, field: "", before, after: null, receipt, undoes: null });
      return this.done(number, row, fields, editor, id);
    });
  }

  private names(module: string, ids: readonly number[]): Record<number, string> {
    if (ids.length === 0) return {};
    const named = ownerOf(this.owners, module).labelPeople([...new Set(ids)]);
    return Object.fromEntries([...new Set(ids)].map((id) => [id, named[id] ?? unnamedPerson(id)]));
  }

  /** Row `id` of table `kind`'s editable fields as they stand. */
  state(kind: string, id: string): EditState {
    const { row, fields, editor } = this.rowOf(kind, id);
    const state = this.stateOf(row, fields, editor);
    if (state === null) throw new NotFoundError(`row ${id} is no longer in the ${kind} table`);
    return state;
  }

  /** The answer for an edit made (or undone): its number, and the row now, by its id now. */
  private done(edit: number | null, row: EditRow, fields: readonly EditField[], editor: TableEditor, fallback: string): EditDone {
    const id = this.idOf(row, editor);
    const state = id === null ? null : this.stateOf(row, fields, editor);
    return { edit, id: id ?? fallback, state, gone: state === null };
  }

  /** Where `row` is after an owner's change that may have given it another key (`applied.row`): its earlier edits follow it. */
  private follow(row: EditRow, given: { origin: string; nativeId: string } | undefined): EditRow {
    if (!given || (given.origin === row.origin && given.nativeId === row.nativeId)) return row;
    const moved = { ...row, ...given };
    this.log.moveRow(row, moved);
    return moved;
  }

  /**
   * Changes `field` of row `id` of table `kind` to `value`: refused for a field the table does not let be edited
   * (ForbiddenError), or this row's owner keeps as it is; read to its kind (values.ts); written by the row's owner; kept
   * in the record. A value the field already has changes nothing and is not kept (`edit` null).
   */
  edit(kind: string, id: string, key: string, value: unknown, source: EditSource): Effect.Effect<EditDone, EditFailure | ForbiddenError> {
    return Effect.gen({ self: this }, function* () {
      const { row, fields, editor } = this.rowOf(kind, id);
      const field = fields.find((f) => f.key === key);
      if (!field) throw new ForbiddenError(`the ${kind} table's ${JSON.stringify(key)} cannot be edited; it lets ${fields.map((f) => f.label).join(", ")} be`);
      const now = this.stateOf(row, fields, editor);
      if (now === null) throw new NotFoundError(`row ${id} is no longer in the ${kind} table`);
      const standing = now.fields[key];
      if (!standing) throw new ForbiddenError(`this row's ${field.label} cannot be edited`);
      if (standing.locked) throw new ForbiddenError(standing.locked);
      const wanted = readValue(field, value);
      if (field.input !== "note" && same(standing.value, wanted)) return { edit: null, id, state: now, gone: false } satisfies EditDone;
      // Its number is its own before the owner is asked, which names it in its own record.
      const number = this.log.reserve();
      const applied = yield* editor.apply(row, key, wanted, { ...source, edit: number });
      const at = this.follow(row, applied.row);
      if (applied.changed === false || (field.input !== "note" && same(applied.before, applied.after))) return this.done(null, at, fields, editor, id);
      const edit = this.log.add(number, { at: Date.now(), surface: source.surface, who: source.who, kind, row: at, field: key, before: applied.before, after: applied.after, receipt: applied.receipt, undoes: null });
      return this.done(edit, at, fields, editor, id);
    });
  }

  /**
   * Puts edit `number` back through the owner that made it, as an edit of its own; refused while it stands undone (undo
   * its undo to do it again, as friend map's changesets have it: then it can be undone once more).
   */
  undo(number: number, source: EditSource): Effect.Effect<EditDone, EditFailure | ForbiddenError> {
    return Effect.gen({ self: this }, function* () {
      const logged = this.log.get(number);
      const undone = this.undoneOf(logged);
      if (undone !== null) {
        throw new UnavailableError(undone.by !== null
          ? `edit #${number} was undone by #${undone.by}; undo #${undone.by} to do it again`
          : `edit #${number} was undone ${undone.words}; undo that there to do it again`);
      }
      const tab = this.tabs.find((t) => t.spec.kind === logged.kind);
      const editor = this.editors.get(logged.kind);
      const fields = tab?.spec.edits ?? [];
      if (logged.action !== "edit") {
        // An add or a delete put back: the row gone again, or back. Its undo says the row as the add or delete did.
        if (!tab?.spec.own || !editor?.undoRow) throw new UnavailableError(`edit #${number} ${logged.action === "add" ? "added" : "deleted"} a row of the ${logged.kind} table, which takes no adds or deletes now`);
        const next = this.log.reserve();
        const { receipt } = yield* editor.undoRow(logged.row, logged.receipt, { ...source, edit: next });
        const edit = this.log.add(next, { action: logged.action, at: Date.now(), surface: source.surface, who: source.who, kind: logged.kind, row: logged.row, field: "", before: logged.before, after: logged.after, receipt, undoes: number });
        return this.done(edit, logged.row, fields, editor, this.idOf(logged.row, editor) ?? "");
      }
      if (!tab || !editor || !fields.some((f) => f.key === logged.field)) throw new UnavailableError(`edit #${number} is of the ${logged.kind} table's ${logged.field}, which cannot be edited now`);
      const next = this.log.reserve();
      const applied = yield* editor.undo(logged.row, logged.field, logged.receipt, { ...source, edit: next });
      const at = this.follow(logged.row, applied.row);
      const edit = this.log.add(next, { at: Date.now(), surface: source.surface, who: source.who, kind: logged.kind, row: at, field: logged.field, before: applied.before, after: applied.after, receipt: applied.receipt, undoes: number });
      return this.done(edit, at, fields, editor, this.idOf(at, editor) ?? "");
    });
  }

  /** The record, newest first: every table's, one table's, or one row's of it (`id`, the table's own); older than edit `before` when given. */
  list({ kind, id, limit = 50, before }: { kind?: string; id?: string; limit?: number; before?: number } = {}): EditRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new InvalidInputError("limit is a whole number from 1 to 500");
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new InvalidInputError("before is an edit's number");
    const row = kind !== undefined && id !== undefined ? this.rowOf(kind, id).row : undefined;
    return this.log.list({ kind, row, limit, before }).map((edit) => this.recordOf(edit));
  }

  /**
   * Whether edit `edit` stands undone now, and by what: for an owner with a log of its own (TableEditor's `undone`),
   * as that log says, the undo named by the record's number when the record made it; otherwise, or once the owner's
   * log no longer has it, as the record says (undone by an edit whose own undo has not been undone). Null while it stands.
   */
  private undoneOf(edit: LoggedEdit): { by: number | null; words: string } | null {
    const said = this.editors.get(edit.kind)?.undone?.(edit.receipt) ?? null;
    if (said === false) return null;
    if (said !== null) {
      const ours = this.log.undoesOf(edit.id).find((undo) => JSON.stringify(undo.receipt) === JSON.stringify(said.by));
      return ours ? { by: ours.id, words: `by #${ours.id}` } : { by: null, words: `in ${said.where}` };
    }
    const by = this.undoerOf(edit);
    return by === null ? null : { by, words: `by #${by}` };
  }

  /** The edit that undid edit `edit` and stands itself, as the record says (at any depth of undoes of undoes); null while it stands. */
  private undoerOf(edit: LoggedEdit): number | null {
    if (edit.undoneBy === null) return null;
    return this.undoerOf(this.log.get(edit.undoneBy)) === null ? edit.undoneBy : null;
  }

  /** One edit, as the record shows it. */
  record(number: number): EditRecord {
    return this.recordOf(this.log.get(number));
  }

  /** An edit as the record shows it: its field by its label, its values in words, people named as they are now. */
  private recordOf(edit: LoggedEdit): EditRecord {
    const spec = this.tabs.find((t) => t.spec.kind === edit.kind)?.spec;
    const undone = this.undoneOf(edit);
    const common = {
      id: edit.id, action: edit.action, at: edit.at, surface: edit.surface, who: edit.who, kind: edit.kind, module: edit.row.module, rowId: this.idOf(edit.row, this.editors.get(edit.kind)),
      field: edit.field, undoes: edit.undoes, undoneBy: undone?.by ?? null, undone: undone?.words ?? null,
    };
    if (edit.action !== "edit") {
      // An added or deleted row: its noun, and the row in words, its people named as they are now.
      const fields = spec?.own?.add ?? [];
      const rowText = (value: LoggedValue) => {
        if (!isRow(value)) return null;
        const ids = fields.filter((field) => field.input === "people").flatMap((field) => {
          const people = value[field.key];
          return idsIn(people);
        });
        return rowValuesText(fields, value, this.names(edit.row.module, ids)) || null;
      };
      return { ...common, label: spec?.noun[0] ?? "row", before: rowText(edit.before), after: rowText(edit.after) };
    }
    const field = spec?.edits?.find((f) => f.key === edit.field);
    const ids = [edit.before, edit.after].flatMap(idsIn);
    const names = field?.input === "people" ? this.names(edit.row.module, ids) : {};
    const text = (value: LoggedValue) => (field && !isRow(value) ? valueText(field, value, names) : value === null ? null : JSON.stringify(value));
    return { ...common, label: field?.label ?? edit.field, before: text(edit.before), after: text(edit.after) };
  }

  /** A note field's words, to edit them: content, so the read is kept in the trail (the viewer's, as its other content reads are). */
  note(kind: string, id: string, key: string, reader: { surface: "viewer" | "cli"; reader: string | null; why?: string | null } = { surface: "viewer", reader: null }): string {
    const { row, fields, editor } = this.rowOf(kind, id);
    const field = fields.find((f) => f.key === key);
    if (!field || field.input !== "note" || !editor.note) throw new InvalidInputError(`the ${kind} table's ${JSON.stringify(key)} is not a note`);
    const words = editor.note(row, key);
    this.contentLog.record({ ...reader, what: "note", scope: { table: kind, module: row.module, origin: row.origin, row: row.nativeId, field: key } });
    return words ?? "";
  }

  /** What a people field of table `kind` can take, matching `query` by name; or what a text or tags field that suggests offers. */
  options(kind: string, key: string, query: string): EditOption[] {
    const tab = this.tabs.find((t) => t.spec.kind === kind);
    const field = [...(tab?.spec.edits ?? []), ...(tab?.spec.own?.add ?? [])].find((f) => f.key === key);
    const editor = this.editors.get(kind);
    const offers = field?.input === "people" || ((field?.input === "text" || field?.input === "tags") && field.suggests === true);
    if (!field || !offers || !editor?.options) throw new InvalidInputError(`the ${kind} table's ${JSON.stringify(key)} offers nothing to pick from`);
    return editor.options(key, query.trim().slice(0, 100));
  }
}

/**
 * The registry over the open `archive`, as the server makes it (serverLayer.ts) and a test does (sdk/testing.ts):
 * every table (`tabs`, the core's and the loaded modules'), the loaded modules' editors, the calendar, the core's
 * database for the record, the modules' owners to name the people a field names, and the trail.
 */
export function tableEditsOf(archive: Archive, tabs: readonly Tab[], events: ReadonlyMap<string, ModuleEvents> = moduleEvents(archive.modules)): TableEdits {
  return new TableEdits({
    tabs,
    editors: moduleEditors(archive.modules),
    calendar: archive.calendarDb,
    core: archive.coreDb,
    owners: moduleOwners(events),
    contentLog: archive.contentLog,
  });
}
