// Events' Tables' Edits (EventsSection.tsx lists it first among the archive's own): the one record of every edit made to
// every table (server/edits/: in a cell, in a drawer opened from a table or the Calendar, or on the CLI), the newest
// first, as the record says each: when, the table, the field, what it was and became (a note's words never), where from,
// and whether it stands. Each that stands has its Undo, through the owner that made it, as the drawer's does; one undone
// says by what, Friend Map's Changes among them (an owner with a change log of its own is read from it, so the two never
// disagree). Narrowed to one table, and paged by "Show older"; each opens its row, in its table, its drawer open.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchRecord, postUndo } from "../api.ts";
import { editChangeText, type EditRecord } from "../editWire.ts";
import { dateText, timeText } from "../format.ts";
import type { KindSpec } from "../wire.ts";

/** The query's name for Edits in Tables (`?table=edits`), beside the tables' kinds, which never take it. */
export const EDITS_TABLE = "edits";

/** The query's key narrowing Edits to one table's (`&of=calls`). */
export const EDITS_OF = "of";

/** How many edits a page of Edits shows. */
const PAGE = 100;

/** Where an edit was made, in words: in the archive's pages, or on the CLI and by whom. */
export function fromText(edit: Pick<EditRecord, "surface" | "who">): string {
  return edit.surface === "cli" ? `CLI${edit.who ? ` · ${edit.who}` : ""}` : "Here";
}

interface Props {
  kinds: readonly KindSpec[];
  /** The table narrowed to, by kind; null for every table's. */
  of: string | null;
  /** Narrows to table `kind` (null: every table's), as a new address. */
  onOf: (kind: string | null) => void;
  /** Opens row `rowId` of table `spec` in its table, its drawer open. */
  onRow: (spec: KindSpec, rowId: string) => void;
  /** What sits above it: the trail back to the list, given how many are shown. */
  head: (count: string) => ReactNode;
}

export function EditsTable({ kinds, of, onOf, onRow, head }: Props) {
  const [edits, setEdits] = useState<EditRecord[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** What the last Undo did, or why it did not. */
  const [said, setSaid] = useState<{ text: string; failed?: boolean } | null>(null);
  const editable = kinds.filter((spec) => (spec.edits?.length ?? 0) > 0);

  useEffect(() => {
    document.title = "Edits · Life archive";
  }, []);

  /** The table narrowed to now, so an answer asked for another is dropped. */
  const showing = useRef(of);
  showing.current = of;

  /** The newest `count` edits again, a page at a time (after an Undo too, as it changes what stands, keeping the older pages shown). */
  const load = useCallback(
    async (count: number, signal?: AbortSignal) => {
      const asked = of;
      try {
        const got: EditRecord[] = [];
        let page: EditRecord[];
        do {
          page = (await fetchRecord({ kind: asked ?? undefined, limit: PAGE, before: got.at(-1)?.id }, signal)).edits;
          got.push(...page);
        } while (page.length === PAGE && got.length < count);
        if (showing.current !== asked) return;
        setEdits(got);
        setMore(page.length === PAGE);
        setFailed(null);
      } catch (error) {
        if (!signal?.aborted && showing.current === asked) setFailed((error as Error).message);
      }
    },
    [of],
  );
  useEffect(() => {
    const abort = new AbortController();
    setEdits(null);
    void load(PAGE, abort.signal);
    return () => abort.abort();
  }, [load]);

  const older = () => {
    const last = edits?.at(-1);
    if (!last) return;
    const asked = of;
    fetchRecord({ kind: asked ?? undefined, limit: PAGE, before: last.id }).then(
      (answer) => showing.current === asked && (setEdits((was) => [...(was ?? []), ...answer.edits]), setMore(answer.edits.length === PAGE)),
      (error: Error) => showing.current === asked && setFailed(error.message),
    );
  };
  const undo = (edit: EditRecord) =>
    postUndo(edit.id).then(
      (done) => (setSaid({ text: `Undid #${edit.id}${done.edit !== null ? ` as #${done.edit}` : ""}: ${edit.label}` }), load((edits?.length ?? 0) + 1)),
      (error: Error) => setSaid({ text: `#${edit.id} not undone: ${error.message}`, failed: true }),
    );

  const label = (kind: string) => kinds.find((spec) => spec.kind === kind)?.label ?? kind;
  const count = edits === null ? "" : `${edits.length}${more ? "+" : ""} ${edits.length === 1 ? "edit" : "edits"}`;
  return (
    <div className="rows edits">
      {head(count)}
      <div className="edits__bar">
        <label className="edits__of">
          <span>Table</span>
          <select value={of ?? ""} onChange={(event) => onOf(event.target.value || null)} aria-label="Only one table's edits">
            <option value="">Every table</option>
            {editable.map((spec) => (
              <option key={spec.kind} value={spec.kind}>
                {spec.label}
              </option>
            ))}
          </select>
        </label>
        {said && (
          <p className={`drawer__saved edits__said${said.failed ? " drawer__saved--failed" : ""}`} role="status">
            {said.failed ? said.text : <>✓ {said.text}</>}
          </p>
        )}
      </div>
      {failed && (
        <p className="viewer__error" role="alert">
          {failed}
        </p>
      )}
      <div className="table edits__table">
        <table>
          <thead>
            <tr>
              <th className="edits__when">When</th>
              <th className="edits__of-table">Table</th>
              <th className="edits__change">Change</th>
              <th className="edits__from">From</th>
              <th className="table__numeric edits__number">#</th>
              <th className="edits__state" aria-label="Undo" />
            </tr>
          </thead>
          <tbody>
            {edits === null && !failed && (
              <tr>
                <td className="table__empty" colSpan={6}>
                  Loading…
                </td>
              </tr>
            )}
            {edits?.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={6}>
                  No edits {of ? `to the ${label(of)} table` : "to any table"} yet
                </td>
              </tr>
            )}
            {edits?.map((edit, i) => {
              const spec = kinds.find((k) => k.kind === edit.kind);
              return (
                <tr key={edit.id} className={i % 2 === 1 ? "table__odd" : undefined}>
                  <td className="edits__when">
                    {dateText(edit.at)} <span className="table__dim table__time">{timeText(edit.at)}</span>
                  </td>
                  <td>
                    {spec && edit.rowId !== null ? (
                      <button type="button" className="chip chip--link" title={`Open this ${spec.noun[0]} in the ${spec.label} table`} onClick={() => onRow(spec, edit.rowId!)}>
                        {spec.label}
                      </button>
                    ) : (
                      label(edit.kind)
                    )}
                  </td>
                  <td className={`edits__change${edit.undone !== null ? " edits__change--undone" : ""}`} title={editChangeText(edit)}>
                    {editChangeText(edit)}
                  </td>
                  <td className="table__dim">{fromText(edit)}</td>
                  <td className="table__numeric table__dim">{edit.id}</td>
                  <td className="edits__state">
                    {edit.undone !== null ? (
                      <span className="table__dim" title={`Undone ${edit.undone}`}>
                        Undone {edit.undone.replace(/ \(its #\d+\)$/, "")}
                      </span>
                    ) : (
                      <button type="button" className="drawer__undo" onClick={() => void undo(edit)}>
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {more && (
          <button type="button" className="edits__older" onClick={older}>
            Show older
          </button>
        )}
      </div>
    </div>
  );
}
