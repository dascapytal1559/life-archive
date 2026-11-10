// The drawer: one row, opened from the table, with everything the viewer may say of it (/life-archive/api/:kind/row,
// RowDetail): each column's value under its name, what the table has no column for, and the other tabs narrowed to
// it ("Messages that day", "Calls with them"), and, opened from the Calendar, the row in its own table. At the right on a wide screen, from the bottom on a phone; ✕ or Escape
// closes it. Metadata only, as everything the viewer shows, until the captain asks for a message's chat or an LLM
// event's conversation (Conversation.tsx): only then is any of its content read, through the archive's logged path.
//
// A row of a table its owner lets be edited is edited here (FieldEditor.tsx, server/edits/), the same whether the
// drawer was opened from the Calendar or from the table, and the same as in the table's cells (CellEdit.tsx), as the captain asked ("the same table has the same
// permissions everywhere"): a click on a value edits it, Enter or leaving it saves, Escape puts it back; under the
// fields, what was saved or why it was not, with an Undo, and the row's record of edits, each of which can be undone.
// A field only the editor knows (a workout's note, whether a habit was done) is a field of its own at the foot. A row of
// the captain's own (KindSpec's `own`: a hangout, a call he logged) has Delete at the very foot, asked once more; it
// leaves the table, and the Undo said in its place brings it back. An imported row says it is never deleted, and why.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./add.css";
import { fetchEdits, fetchEditState, fetchRow, postDelete, postEdit, postUndo } from "./api.ts";
import { Conversation, CONVERSATIONS } from "./Conversation.tsx";
import { EditableField } from "./FieldEditor.tsx";
import { dateText, timeText } from "./format.ts";
import { CellView } from "./VirtualTable.tsx";
import { editChangeText, editValueText, type EditDone, type EditField, type EditRecord, type EditState, type EditValue } from "./editWire.ts";
import type { KindSpec, PlaceLink, Row, RowDetail, ViewLink } from "./wire.ts";

interface Props {
  spec: KindSpec;
  id: string;
  onClose: () => void;
  /** Narrow the tab to the rows whose `filter` is `value` (a person's name, a chat), as the table's cells do. */
  onNarrow: (filter: string, value: string) => void;
  /** Open another tab, narrowed (a ViewLink). */
  onView: (link: ViewLink) => void;
  /** Whether a link has somewhere to go; one that has not is left out. */
  canView: (link: ViewLink) => boolean;
  /** Opens the row in its own table, for a drawer opened elsewhere (a Calendar card). */
  onTable?: (row: Row) => void;
  /** Opens a page of the console beyond the tables (a person's panel in Friend Map); none where there is no console. */
  onPlace?: (place: PlaceLink) => void;
  /** Hears that an edit (or its undo) changed row `row` (its id before it), so what drew it (the table, the Calendar) reads it again, and with `done`, where it is now. */
  onEdited?: (row: string, done: EditDone) => void;
  /** Bumped when the row was edited elsewhere (in its cell), so the drawer reads it again. */
  refresh?: number;
}

/** What is said of the last edit: saved (with its Undo), undone, or nothing changed; the drawer's, and the table's for an edit in a cell. */
export interface Said {
  text: string;
  undo: number | null;
  failed?: boolean;
}

/** "Saved. When: 7 Mar 2026 8:00 pm", of `field` given `value` (a note's words never said), people by `names`. */
export function savedText(field: EditField, value: EditValue, names: Readonly<Record<number, string>>): string {
  return `Saved. ${field.label}${field.input === "note" ? " changed" : `: ${editValueText(field, value, names)}`}`;
}

export function RowDrawer({ spec, id: openedId, onClose, onNarrow, onView, canView, onTable, onPlace, onEdited, refresh = 0 }: Props) {
  /** The row's id now: an edit can give it another (a call given other people), or take it from the table. */
  const [id, setId] = useState(openedId);
  const [detail, setDetail] = useState<RowDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [edits, setEdits] = useState<EditState | null>(null);
  const [record, setRecord] = useState<EditRecord[]>([]);
  const [said, setSaid] = useState<Said | null>(null);
  /** The row left its table with an edit (a habit no longer done); its Undo may bring it back. */
  const [gone, setGone] = useState(false);
  /** Bumped to read the row again after an edit. */
  const [reads, setReads] = useState(0);
  /** The conversation is open over the page: asked for, on this row. */
  const [reading, setReading] = useState(false);
  const editable = (spec.edits?.length ?? 0) > 0;

  /** The table and row the drawer last showed, as it opened them or as an edit moved it. */
  const showing = useRef(`${spec.kind}\n${openedId}`);
  useEffect(() => {
    const opened = `${spec.kind}\n${openedId}`;
    if (opened === showing.current) return;
    showing.current = opened;
    setId(openedId);
    setSaid(null);
    setGone(false);
  }, [spec.kind, openedId]);

  useEffect(() => {
    if (gone) return;
    const abort = new AbortController();
    if (reads === 0) setDetail(null);
    setError(null);
    setReading(false);
    fetchRow(spec.kind, id, abort.signal)
      .then(setDetail)
      .catch((e: Error) => abort.signal.aborted || setError(e));
    if (editable) {
      // A table its owner edits, but a server that cannot (the static demo), answers no fields: the row is only read.
      fetchEditState(spec.kind, id, abort.signal).then(setEdits, () => abort.signal.aborted || setEdits(null));
      fetchEdits(spec.kind, id, abort.signal).then((answer) => setRecord(answer.edits), () => abort.signal.aborted || setRecord([]));
    }
    return () => abort.abort();
  }, [spec.kind, id, reads, gone, editable, refresh]);

  useEffect(() => {
    // Escape goes back from the conversation to the row first, then closes the drawer.
    const escape = (event: KeyboardEvent) => event.key === "Escape" && (reading ? setReading(false) : onClose());
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, reading]);

  /** After an edit or an undo: the row read again by its id now, what drew it told, and what was done said. */
  const after = useCallback((done: EditDone, text: string, undo: number | null) => {
    setSaid({ text, undo });
    setGone(done.gone);
    if (!done.gone) {
      showing.current = `${spec.kind}\n${done.id}`;
      setId(done.id);
      setReads((n) => n + 1);
    }
    onEdited?.(id, done);
  }, [onEdited, spec.kind, id]);

  const save = (field: EditField) => async (value: EditValue) => {
    const done = await postEdit(spec.kind, id, field.key, value);
    if (done.edit === null) return setSaid({ text: `${field.label} is that already: nothing changed`, undo: null });
    after(done, savedText(field, value, { ...edits?.people, ...detail?.people, ...done.state?.people }), done.edit);
  };

  const undo = (edit: number) => {
    postUndo(edit).then(
      (done) => after(done, "Undone", null),
      (failed: Error) => setSaid({ text: `Not undone: ${failed.message}`, undo: null, failed: true }),
    );
  };

  /** Deletes the row (one of the captain's own): it leaves the table, and its Undo brings it back. */
  const remove = () =>
    postDelete(spec.kind, id).then(
      (done) => after(done, `${title} deleted`, done.edit),
      (failed: Error) => setSaid({ text: `Not deleted: ${failed.message}`, undo: null, failed: true }),
    );

  const fieldOf = (key: string | undefined) => (key === undefined ? undefined : spec.edits?.find((field) => field.key === key));
  /** A value drawn as the table draws it, made editable when its table lets it be. */
  const value = (key: string | undefined, drawn: ReactNode) => {
    const field = fieldOf(key);
    if (!field || !edits) return drawn;
    return (
      <EditableField kind={spec.kind} rowId={id} field={field} state={edits.fields[field.key]} people={{ ...detail?.people, ...edits.people }} onSave={save(field)}>
        {drawn}
      </EditableField>
    );
  };
  const shown = new Set([...spec.columns.map((c) => c.key), ...(detail?.more.flatMap((f) => (f.key ? [f.key] : [])) ?? [])]);
  const own = (spec.edits ?? []).filter((field) => !shown.has(field.key) && edits?.fields[field.key]);

  const title = spec.noun[0].charAt(0).toUpperCase() + spec.noun[0].slice(1);
  const read = CONVERSATIONS[spec.kind];
  return (
    <aside className="drawer" aria-label={title}>
      <header className="drawer__header">
        <h2>{title}</h2>
        <button type="button" className="drawer__close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {gone && (
        <div className="drawer__body">
          <p className="drawer__note drawer__note--edit">
            This {spec.noun[0]} is no longer in the {spec.label} table.
          </p>
          <Saved said={said} onUndo={undo} />
        </div>
      )}
      {!gone && error && <p className="viewer__error">{error.message}</p>}
      {!gone && !detail && !error && <p className="drawer__note">Loading…</p>}
      {!gone && detail && (
        <div className="drawer__body">
          <dl className="drawer__fields">
            {spec.columns.map((column) => (
              <Field key={column.key} label={column.label}>
                {value(column.key, <CellView column={column} cell={detail.row.cells[column.key] ?? null} people={detail.people} onNarrow={onNarrow} />)}
              </Field>
            ))}
            {detail.more.map((field, i) => (
              <Field key={`more-${i}`} label={field.label}>
                {value(field.key, <CellView column={field} cell={field.value} people={detail.people} onNarrow={onNarrow} />)}
              </Field>
            ))}
            {own.map((field) => (
              <Field key={`edit-${field.key}`} label={field.label}>
                {value(field.key, <span>{editValueText(field, edits!.fields[field.key]!.value, edits!.people)}</span>)}
              </Field>
            ))}
          </dl>
          <Saved said={said} onUndo={undo} />
          {read && (
            <div className="drawer__read">
              <button type="button" className="drawer__read-button" onClick={() => setReading(true)}>
                {read}
              </button>
              <span className="drawer__read-note">Reads its words; each page read is kept in the trail of content reads.</span>
            </div>
          )}
          {(onTable || detail.views.some(canView) || Boolean(onPlace && detail.places?.length)) && (
            <nav className="drawer__views" aria-label="Open in another tab">
              {onTable && (
                <button type="button" className="drawer__view drawer__view--table" onClick={() => onTable(detail.row)}>
                  Open in the {spec.label} table →
                </button>
              )}
              {detail.views.filter(canView).map((link) => (
                <button key={`${link.kind} ${link.label}`} type="button" className="drawer__view" onClick={() => onView(link)}>
                  {link.label} →
                </button>
              ))}
              {onPlace && detail.places?.map((place) => (
                <button key={`${place.place} ${place.label}`} type="button" className="drawer__view drawer__view--place" onClick={() => onPlace(place)}>
                  {place.label} →
                </button>
              ))}
            </nav>
          )}
          {record.length > 0 && <Record record={record} onUndo={undo} />}
          {spec.own && edits?.delete && <Delete noun={spec.noun[0]} locked={edits.delete.locked} onDelete={remove} />}
        </div>
      )}
      {reading && <Conversation kind={spec.kind} id={detail?.content ?? Number(id)} onClose={() => setReading(false)} />}
    </aside>
  );
}

/** What was done last, saved or not, with its Undo (and, under the table, a ✕ to put it away). */
export function Saved({ said, onUndo, onClose }: { said: Said | null; onUndo: (edit: number) => void; onClose?: () => void }) {
  if (!said) return null;
  return (
    <p className={`drawer__saved${said.failed ? " drawer__saved--failed" : ""}`} role="status">
      {said.failed ? said.text : <>✓ {said.text}</>}
      {said.undo !== null && (
        <button type="button" className="drawer__undo" onClick={() => onUndo(said.undo!)}>
          Undo
        </button>
      )}
      {onClose && (
        <button type="button" className="drawer__said-close" aria-label="Put it away" onClick={onClose}>
          ✕
        </button>
      )}
    </p>
  );
}

/** The row's record of edits, newest first: each what it changed, from what to what, and its Undo while it stands. */
function Record({ record, onUndo }: { record: EditRecord[]; onUndo: (edit: number) => void }) {
  return (
    <details className="drawer__record">
      <summary>Edits ({record.length})</summary>
      <ol>
        {record.map((edit) => (
          <li key={edit.id}>
            <span>{editChangeText(edit)}</span>
            <span className="drawer__record-when">
              #{edit.id}, {dateText(edit.at)} {timeText(edit.at)}
            </span>
            {edit.undone !== null ? <span className="drawer__record-undone table__dim" title={`Undone ${edit.undone}`}>Undone</span> : (
              <button type="button" className="drawer__undo" onClick={() => onUndo(edit.id)}>
                Undo
              </button>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * A row of the captain's own deleted, at the foot of its drawer: asked once more ("Delete this hangout?"), as it goes
 * from every page; a row that is never deleted (an imported call) says why instead.
 */
function Delete({ noun, locked, onDelete }: { noun: string; locked: string | undefined; onDelete: () => Promise<void> }) {
  const [sure, setSure] = useState(false);
  useEffect(() => setSure(false), [noun]);
  if (locked !== undefined) return <p className="drawer__delete drawer__delete-why">Not deletable: {locked}.</p>;
  return (
    <div className="drawer__delete">
      {!sure ? (
        <button type="button" className="drawer__delete-button" onClick={() => setSure(true)}>
          Delete this {noun}
        </button>
      ) : (
        <>
          <span>Delete this {noun}? It goes from every page; Undo brings it back.</span>
          <button type="button" className="drawer__delete-button drawer__delete-button--sure" onClick={() => void onDelete().finally(() => setSure(false))}>
            Delete
          </button>
          <button type="button" className="drawer__undo" onClick={() => setSure(false)}>
            Keep it
          </button>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="drawer__field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
