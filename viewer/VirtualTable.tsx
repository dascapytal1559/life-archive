// The table: every row the filters leave, though only those on screen are drawn, each the same height, and fetched a
// page at a time as they scroll into view (the server sorts and pages them; a page after one already here asks for
// the rows after its last, which the Messages tab finds at once however deep). The header stays at the top; on a phone
// the first column stays at the left as the rest scroll sideways under it. A person's name, or a link (a message's
// chat), in a row narrows the view to it. A cell of a column its table's owner lets be edited is edited in place with a
// click (or Enter) on a desk (CellEdit.tsx), where its row lets it (each page's locks, asked with it); anywhere else, a
// click (or Enter) opens the row in the drawer (RowDrawer.tsx), which edits what has no column (a note) and keeps the
// row's record. A value the captain corrected is marked "edited" here too.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchLocks, fetchRows } from "./api.ts";
import { CellEditor, cellEditing, editingAfter } from "./CellEdit.tsx";
import type { EditField, EditValue } from "./editWire.ts";
import { countText, dateText, lengthText, timeText } from "./format.ts";
import type { Cell, ColumnSpec, Filters, KindSpec, LinkCell, PeopleCell, Row, SortDirection } from "./wire.ts";

/** Every row's height, in pixels (viewer.css draws them so). */
export const ROW = 34;
const PAGE = 100;
/** Rows drawn beyond the screen's edge either way, so a quick scroll does not show blanks. */
const OVERSCAN = 12;

interface Props {
  spec: KindSpec;
  filters: Filters;
  sort: string;
  direction: SortDirection;
  onSort: (sort: string, direction: SortDirection) => void;
  /** Narrow the view to the rows whose `filter` is `value`: a person, or a link's. */
  onNarrow: (filter: string, value: string) => void;
  /** The row open in the drawer, drawn picked out. */
  open: string | null;
  /** Open a row in the drawer. */
  onOpen: (id: string) => void;
  /** How many rows the filters leave, once known. */
  onTotal: (total: number | null) => void;
  onError: (error: Error | null) => void;
  /** Bumped after an edit: the rows on screen are read again where they are, the scroll kept. */
  version?: number;
  /** Saves row `id`'s `field` edited in its cell (resolves once saved, rejects with why not); none where the grid is only read (a phone, a table with nothing to edit). */
  onEdit?: (id: string, field: EditField, value: EditValue) => Promise<void>;
}

interface Loaded {
  /** What the rows are of: the tab, its filters and order. */
  key: string;
  total: number | null;
  rows: Map<number, Row>;
  people: Record<number, string>;
  /** Where each page that follows a page here begins (RowsAnswer.next), by the page's number. */
  starts: Map<number, string>;
  /** Which fields each row keeps as they are (LocksAnswer), by its id, for a table edited in place: a row not here is only read. */
  locks: Map<string, Record<string, string>>;
}

const empty = (key: string): Loaded => ({ key, total: null, rows: new Map(), people: {}, starts: new Map(), locks: new Map() });

export function VirtualTable({ spec, filters, sort, direction, onSort, onNarrow, open, onOpen, onTotal, onError, version = 0, onEdit }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const key = JSON.stringify([spec.kind, filters, sort, direction]);
  const [loaded, setLoaded] = useState<Loaded>(() => empty(key));
  const asked = useRef(new Set<string>());
  /** The cell open in its editor: its row and column. */
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);
  const inPlace = onEdit !== undefined && (spec.edits ?? []).some((field) => field.input !== "note");

  // New filters or a new order: the rows start again, from the top.
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setView((v) => ({ ...v, top: 0 }));
    asked.current = new Set();
    setEditing(null);
    setLoaded(empty(key));
  }, [key]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setView({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const current = loaded.key === key ? loaded : null;
  const total = current?.total ?? null;
  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(total ?? PAGE, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);

  const load = useCallback(
    (page: number, after: string | null) => {
      const id = `${key}#${version}#${inPlace}#${page}`;
      if (asked.current.has(id)) return;
      asked.current.add(id);
      fetchRows(spec.kind, filters, { offset: page * PAGE, limit: PAGE, sort, direction, after })
        .then((answer) => {
          onError(null);
          setLoaded((was) => {
            if (was.key !== key) return was;
            const rows = new Map(was.rows);
            answer.rows.forEach((row, i) => rows.set(answer.offset + i, row));
            const starts = new Map(was.starts);
            if (answer.next !== null) starts.set(page + 1, answer.next);
            return { ...was, total: answer.total, rows, people: { ...was.people, ...answer.people }, starts };
          });
          // Which of the page's cells its rows keep as they are, in one ask; a page whose locks cannot be read stays only read.
          if (inPlace && answer.rows.length > 0) {
            fetchLocks(spec.kind, answer.rows.map((row) => row.id)).then(
              (said) =>
                setLoaded((was) => {
                  if (was.key !== key) return was;
                  const locks = new Map(was.locks);
                  for (const row of answer.rows) {
                    if (said.rows[row.id]) locks.set(row.id, said.rows[row.id]!);
                    else locks.delete(row.id);
                  }
                  return { ...was, locks };
                }),
              () => undefined,
            );
          }
        })
        .catch((error: Error) => {
          asked.current.delete(id);
          onError(error);
        });
    },
    // The key holds the tab, the filters and the order; the version, the edits made since.
    [key, version, inPlace],
  );

  // Each page on screen, from where the page before it ended when that is known; scrolled down a page at a time, it is.
  const starts = current?.starts;
  useEffect(() => {
    for (let page = Math.floor(first / PAGE); page <= Math.floor(Math.max(first, last - 1) / PAGE); page++) load(page, starts?.get(page) ?? null);
  }, [first, last, load, starts]);

  useEffect(() => onTotal(total), [total, onTotal]);

  const indices: number[] = [];
  for (let i = first; i < (total === null ? 0 : last); i++) indices.push(i);
  const width = spec.columns.reduce((sum, column) => sum + column.width, 0);

  return (
    <div className="table" ref={scroller} onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <table style={{ width }}>
        <colgroup>
          {spec.columns.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {spec.columns.map((column) => (
              <HeaderCell key={column.key} column={column} sort={sort} direction={direction} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 && total !== null && <Spacer height={first * ROW} columns={spec.columns.length} />}
          {indices.map((i) => {
            const row = current?.rows.get(i);
            const className = [i % 2 === 1 ? "table__odd" : "", row ? "table__row" : "", row && row.id === open ? "table__open" : ""].filter(Boolean).join(" ");
            return (
              <tr
                key={row ? row.id : `waiting-${i}`}
                className={className || undefined}
                tabIndex={row ? 0 : undefined}
                aria-selected={row ? row.id === open : undefined}
                onClick={row ? () => onOpen(row.id) : undefined}
                onKeyDown={row ? (event) => event.key === "Enter" && event.target === event.currentTarget && onOpen(row.id) : undefined}
              >
                {spec.columns.map((column) => {
                  const cell = row && inPlace ? cellEditing(spec, column.key, current!.locks.get(row.id)) : null;
                  const field = row && cell && "field" in cell ? cell.field : null;
                  const open = field !== null && editing?.id === row!.id && editing.key === column.key;
                  const edit = field ? () => setEditing({ id: row!.id, key: column.key }) : undefined;
                  const className = [
                    column.numeric ? "table__numeric" : "",
                    row?.edited?.includes(column.key) ? "table__edited" : "",
                    edit ? "table__editable" : "",
                    open ? "table__editing" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <td
                      key={column.key}
                      className={className || undefined}
                      title={cell && "locked" in cell ? `Not editable: ${cell.locked}` : edit ? `Edit ${column.label.toLowerCase()}` : undefined}
                      tabIndex={edit ? 0 : undefined}
                      onClick={edit && !open ? (event) => (event.stopPropagation(), edit()) : undefined}
                      onKeyDown={edit && !open ? (event) => event.key === "Enter" && event.target === event.currentTarget && (event.stopPropagation(), edit()) : undefined}
                    >
                      {row ? <CellView column={column} cell={row.cells[column.key] ?? null} people={current!.people} onNarrow={onNarrow} /> : <span className="table__dim">…</span>}
                      {row?.edited?.includes(column.key) && <span className="edit__dot" role="img" aria-label="edited" title="Edited by you: open the row to see what its source said" />}
                      {edit && !open && <span className="table__pen" aria-hidden="true">✎</span>}
                      {open && <CellEditor kind={spec.kind} rowId={row!.id} field={field} onSave={(value) => onEdit!(row!.id, field, value)} onDone={() => setEditing((now) => editingAfter(now, { id: row!.id, key: column.key }))} />}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {total !== null && last < total && <Spacer height={(total - last) * ROW} columns={spec.columns.length} />}
          {total === 0 && (
            <tr>
              <td className="table__empty" colSpan={spec.columns.length}>
                No {spec.noun[1]} here
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The room the rows not drawn take, above or below those that are, so the scrollbar is the whole table's. */
function Spacer({ height, columns }: { height: number; columns: number }) {
  return (
    <tr className="table__spacer" aria-hidden="true">
      <td colSpan={columns} style={{ height }} />
    </tr>
  );
}

function HeaderCell({ column, sort, direction, onSort }: { column: ColumnSpec; sort: string; direction: SortDirection; onSort: Props["onSort"] }) {
  const sorted = column.key === sort;
  const className = column.numeric ? "table__numeric" : undefined;
  if (!column.sortable) return <th className={className}>{column.label}</th>;
  return (
    <th className={className} aria-sort={sorted ? (direction === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" onClick={() => onSort(column.key, sorted && direction === "desc" ? "asc" : "desc")}>
        {column.label}
        {sorted && <span className="table__arrow">{direction === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

/**
 * A cell, as a column of its kind is written (the drawer writes its fields so too). A time is its date and time, or
 * words for one with no time of day (a hangout's date alone). A name or a link narrows the view to it, and the click
 * goes no further, so the row does not open.
 */
export function CellView({ column, cell, people, onNarrow }: { column: Pick<ColumnSpec, "kind" | "label">; cell: Cell; people: Record<number, string>; onNarrow: Props["onNarrow"] }) {
  if (cell === null || cell === "" || (column.kind === "count" && cell === 0)) return <span className="table__dim">—</span>;
  switch (column.kind) {
    case "time":
      if (typeof cell === "string") return <>{cell}</>;
      return (
        <>
          {dateText(Number(cell))} <span className="table__dim table__time">{timeText(Number(cell))}</span>
        </>
      );
    case "duration":
      return <>{lengthText(Number(cell))}</>;
    case "count":
      return <>{countText(Number(cell))}</>;
    case "link": {
      const link = cell as LinkCell;
      return (
        <button type="button" className="chip chip--link" title={`Only ${link.label}`} onClick={(event) => (event.stopPropagation(), onNarrow(link.filter, link.value))}>
          {link.label}
        </button>
      );
    }
    case "people": {
      if (typeof cell === "string") return <>{cell}</>;
      const { ids, others } = cell as PeopleCell;
      return (
        <>
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              className="chip chip--person"
              title={`Only ${people[id] ?? "them"}`}
              onClick={(event) => (event.stopPropagation(), onNarrow("person", String(id)))}
            >
              {people[id] ?? `Person ${id}`}
            </button>
          ))}
          {others > 0 && <span className="table__dim">+{others} more</span>}
        </>
      );
    }
    default:
      return <>{String(cell)}</>;
  }
}
