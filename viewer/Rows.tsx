// One table the server knows (/life-archive/api/kinds: Messages, Calls, People, a module's Workouts and the rest),
// drawn as it is kept: a filter bar, a chart of the volume over time and a table of the rows, all following one
// filter object kept in the address, and a drawer for the row clicked, which opens other tables narrowed to it. A cell
// its table lets be edited is edited in place on a desk (VirtualTable.tsx, CellEdit.tsx), what was saved said under
// the table with its Undo, as the drawer says it. A table of the captain's own rows (KindSpec's `own`: Hangouts, Calls)
// has Add in its head (AddRow.tsx, in the drawer's place) and Delete in a row's drawer; both are edits, undone alike. Where
// it is drawn says where its views live (a RowsHome): the console's Events, Table (console/EventsSection.tsx), keeps
// every table at Table's address, the table named in its query.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AddRow, addTitle } from "./AddRow.tsx";
import { fetchFacets, fetchRows, fetchVolume, postEdit, postUndo } from "./api.ts";
import { sayingFailure, useEditInPlace } from "./CellEdit.tsx";
import type { EditDone, EditField, EditValue } from "./editWire.ts";
import { FilterBar } from "./FilterBar.tsx";
import { countText } from "./format.ts";
import { openAfter } from "./openRow.ts";
import { RowDrawer, Saved, savedText, type Said } from "./RowDrawer.tsx";
import { freshView, isFiltered, type ViewState } from "./viewState.ts";
import { VirtualTable } from "./VirtualTable.tsx";
import { VolumeChart } from "./VolumeChart.tsx";
import { NO_FILTERS, type FacetValue, type Filters, type KindSpec, type PlaceLink, type ViewLink, type VolumeAnswer } from "./wire.ts";

/** Where a table is drawn: how it reads its view from the address there, and where a view of a table is. */
export interface RowsHome {
  /** The view of the table `spec` the address holds now. */
  read: (spec: KindSpec) => ViewState;
  /** The address of `view`, of the table `spec`. */
  address: (view: ViewState, spec: KindSpec) => string;
  /** Opens `address` (another table's view) in place of this one, as a new step back can return from. */
  leave: (address: string) => void;
  /** The address of a page beyond the tables a row opens (a person's panel in Friend Map); none where there is none. */
  place?: (place: PlaceLink) => string;
}

/** What the page draws above the table from: how many rows there are, and Add for a table of the captain's own rows (null for none). */
export interface RowsHead {
  count: string;
  add: ReactNode;
}

export function Rows({ spec, kinds, home, head, className }: { spec: KindSpec; kinds: readonly KindSpec[]; home: RowsHome; head: (at: RowsHead) => ReactNode; className: string }) {
  const [view, setViewState] = useState<ViewState>(() => home.read(spec));
  const [volume, setVolume] = useState<VolumeAnswer | null>(null);
  const [facets, setFacets] = useState<Record<string, FacetValue[]> | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [everything, setEverything] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Each change of view is a new address, so back and forward step through them.
  const setView = useCallback(
    (next: ViewState) => {
      const address = home.address(next, spec);
      if (address !== location.pathname + location.search) history.pushState(null, "", address);
      setViewState(next);
    },
    [spec, home],
  );
  useEffect(() => {
    const back = () => setViewState(home.read(spec));
    addEventListener("popstate", back);
    // The address it opened at, written as the page writes it.
    history.replaceState(null, "", home.address(view, spec));
    return () => removeEventListener("popstate", back);
    // Only once: later views write their own addresses.
  }, []);

  useEffect(() => {
    document.title = `${spec.label} · Life archive`;
  }, [spec]);

  /** Bumped by an edit in the drawer or a cell, so the table reads its rows on screen again, and the chart its counts. */
  const [edits, setEdits] = useState(0);
  /** Bumped by an edit in a cell (or its undo), so the drawer, open on its row, reads it again too. */
  const [cellEdits, setCellEdits] = useState(0);
  /** What the last edit in a cell did, with its Undo. */
  const [said, setSaid] = useState<(Said & { row?: string }) | null>(null);
  const editInPlace = useEditInPlace();
  useEffect(() => setSaid(null), [spec.kind]);

  /** An edit in a cell, through the one edit route as the drawer's: the table and the drawer read again, what it did said with its Undo. */
  const saveCell = async (id: string, field: EditField, value: EditValue) => {
    const done = await sayingFailure(postEdit(spec.kind, id, field.key, value), (message) => setSaid({ text: `${field.label} not saved: ${message}`, undo: null, failed: true }));
    setSaid(done.edit === null ? { text: `${field.label} is that already: nothing changed`, undo: null } : { text: savedText(field, value, done.state?.people ?? {}), undo: done.edit, row: done.id });
    if (done.edit === null) return;
    readAgain();
    follow(id, done, "close");
  };
  /** The drawer open on row `row` follows it after an edit (openRow.ts). */
  const follow = (row: string, done: EditDone, gone: "close" | "keep") => {
    const open = openAfter(view.open, row, done, gone);
    if (open !== view.open) setView({ ...view, open });
  };
  const readAgain = () => {
    setEdits((n) => n + 1);
    setCellEdits((n) => n + 1);
  };
  const undoCell = (edit: number) => {
    const row = said?.row;
    return postUndo(edit).then(
      (done) => {
        setSaid({ text: "Undone", undo: null });
        readAgain();
        if (row !== undefined) follow(row, done, "close");
      },
      (failed: Error) => setSaid({ text: `Not undone: ${failed.message}`, undo: null, failed: true }),
    );
  };

  /** Add's drawer is open, in the row drawer's place (a table of the captain's own rows: KindSpec's `own`). */
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [spec.kind]);
  /** A row added: the table read again, the new row's drawer open, and what was added said with its Undo. */
  const added = (done: EditDone) => {
    setAdding(false);
    setSaid({ text: `${spec.noun[0].charAt(0).toUpperCase()}${spec.noun[0].slice(1)} added`, undo: done.edit, row: done.id });
    readAgain();
    if (done.id !== "") setView({ ...view, open: done.id });
  };
  const add = spec.own ? (
    <button type="button" className="rows__add" aria-expanded={adding} title={`Add a ${spec.noun[0]} of your own: it goes in the record of edits, and Undo takes it away again`} onClick={() => (setAdding(!adding), adding || setView({ ...view, open: null }))}>
      + {addTitle(spec)}
    </button>
  ) : null;

  const filtersKey = JSON.stringify(view.filters);
  const filters = useMemo<Filters>(() => view.filters, [filtersKey]);

  useEffect(() => {
    const abort = new AbortController();
    fetchVolume(spec.kind, filters, view.grain, view.measure, view.split, abort.signal)
      .then(setVolume)
      .catch((e: Error) => abort.signal.aborted || setError(e));
    return () => abort.abort();
  }, [spec.kind, filters, view.grain, view.measure, view.split, edits]);

  useEffect(() => {
    const abort = new AbortController();
    setFacets(null);
    fetchFacets(spec.kind, filters, abort.signal)
      .then((answer) => setFacets(answer.facets))
      .catch((e: Error) => abort.signal.aborted || setError(e));
    return () => abort.abort();
  }, [spec.kind, filters]);

  // How many there are in all, for "120 of 2,681 calls": read again after an edit, which may add or delete a row.
  useEffect(() => {
    const abort = new AbortController();
    fetchRows(spec.kind, NO_FILTERS, { offset: 0, limit: 1, sort: spec.sort, direction: "desc" }, abort.signal)
      .then((answer) => setEverything(answer.total))
      .catch((e: Error) => abort.signal.aborted || setError(e));
    return () => abort.abort();
  }, [spec.kind, spec.sort, edits]);
  useEffect(() => setEverything(null), [spec.kind]);

  const setFilters = (next: Filters) => setView({ ...view, filters: next });
  /** A drawer's link: this table narrowed as it says, here, or another table so narrowed, in its place. */
  const openView = (link: ViewLink) => {
    const next = kinds.find((k) => k.kind === link.kind);
    if (!next) return;
    const linked = { ...freshView(next), filters: link.filters };
    if (next.kind === spec.kind) setView(linked);
    else home.leave(home.address(linked, next));
  };
  const closeDrawer = useCallback(() => setView({ ...view, open: null }), [view, setView]);
  /** Only the rows whose `key` filter is `value`: a person, or one value of a choice filter (a chat). */
  const narrow = (key: string, value: string) => {
    const filter = spec.filters.find((f) => f.key === key);
    if (filter?.kind === "person") setFilters({ ...view.filters, person: Number(value) });
    else if (filter) setFilters({ ...view.filters, choices: { ...view.filters.choices, [key]: [value] } });
  };
  const noun = spec.noun;
  const count =
    shown === null || everything === null
      ? ""
      : isFiltered(view.filters)
        ? `${countText(shown)} of ${countText(everything)} ${noun[1]}`
        : `${countText(everything)} ${everything === 1 ? noun[0] : noun[1]}`;

  return (
    <div className={className}>
      {head({ count, add })}
      <FilterBar spec={spec} filters={view.filters} facets={facets} onChange={setFilters} />
      <VolumeChart
        volume={volume?.measure === view.measure && volume.split === view.split ? volume : null}
        measures={spec.measures}
        measure={view.measure}
        grain={view.grain}
        noun={noun[1]}
        splits={spec.splits.map((key) => spec.filters.find((f) => f.key === key)!)}
        split={view.split}
        onMeasure={(measure) => setView({ ...view, measure })}
        onGrain={(grain) => setView({ ...view, grain })}
        onSplit={(split) => setView({ ...view, split })}
        onRange={(range) => setFilters({ ...view.filters, from: range?.from ?? null, to: range?.to ?? null })}
      />
      {error && (
        <p className="viewer__error" role="alert">
          {error.message}
        </p>
      )}
      <VirtualTable
        spec={spec}
        filters={filters}
        sort={view.sort}
        direction={view.direction}
        onSort={(sort, direction) => setView({ ...view, sort, direction })}
        onNarrow={narrow}
        open={view.open}
        onOpen={(open) => (setAdding(false), setView({ ...view, open }))}
        onTotal={setShown}
        onError={setError}
        version={edits}
        onEdit={editInPlace ? saveCell : undefined}
      />
      {said && (
        <div className="rows__said">
          <Saved said={said} onUndo={undoCell} onClose={() => setSaid(null)} />
        </div>
      )}
      {adding && <AddRow spec={spec} onClose={() => setAdding(false)} onAdded={added} />}
      {!adding && view.open !== null && (
        <RowDrawer
          spec={spec}
          id={view.open}
          onClose={closeDrawer}
          onNarrow={narrow}
          onView={openView}
          canView={(link) => kinds.some((k) => k.kind === link.kind)}
          onPlace={home.place ? (place) => home.leave(home.place!(place)) : undefined}
          onEdited={(row, done) => (setEdits((n) => n + 1), setSaid(null), follow(row, done, "keep"))}
          refresh={cellEdits}
        />
      )}
    </div>
  );
}
