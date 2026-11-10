// Events in the console, the life archive's home: the captain's ("events is almost gonna become like home page for
// life archive"), first in the rail and what the archive's own address opens. Its views: the Calendar
// (calendar/CalendarView.tsx), first and at the aspect's own address ("The events page should default to calendar as
// its default tab"): a day moment by moment, the week's events as cards, the month's at a glance or the year's days
// shaded, the one view that puts the tables' rows together. Then Tables (once Table): every table the archive has, the core's and
// the modules' (the server's tabs, /life-archive/api/kinds; the console asks for them once, kindsOnce), as a list
// grouped by whose each is (tablesByOwner), each saying what of it can be edited (editsText), and first among the
// archive's own, Edits (EditsTable.tsx): every edit to every table, each with its Undo. It is the one place a
// table is shown and edited, a cell in place or a row in its drawer: a module's page draws none of its own (Friend Map's Messages tab folded in here, the
// captain's "let's just fold friend maps messages and potentially even tables into the events page"), and Jump to
// finds each by name (tableAddress). Each opens
// as it is kept ("when you click on a table it shows that table exactly as it's kept", viewer/Rows.tsx:
// its filter bar, its chart, its table and its drawer), nothing mixed into one table ("At the moment I don't have any
// plans for like mixing table contents into one aggregated table"). The table open is in the address's query with its
// view (/life-archive/dev/events/tables?table=calls&person=3); with none, the list. A kind's own view once had its
// own address (…/events/calls), which opens that table still. A drawer's link to another table opens it here
// (linkAddress), as a Calendar card's link to its own row does (rowAddress: the row's table on its Calendar day, its
// drawer open), since a row is changed in its table, never on the Calendar ("for editing it has to take us to the table page").
// Then Sources (SourcesView.tsx): where the events come from, a row a connector, how each syncs, how often, when it
// last did and whether it is overdue. A module's view may sit here too (rituals' Daily rituals, second, by its order).

import { lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { calendarDayOf, calendarDayStart } from "../../src/calendarDay.ts";
import { addDays, dayKey, dayStart } from "../../src/time.ts";
import { fetchRows, kindsOnce } from "../api.ts";
import { countText } from "../format.ts";
import { moduleViewers } from "../modules.ts";
import { Rows, type RowsHome } from "../Rows.tsx";
import { freshView, viewOf, viewQuery } from "../viewState.ts";
import { NO_FILTERS, type KindSpec, type Row, type ViewLink } from "../wire.ts";
import { consolePath, openAddress, stepsOf } from "./address.ts";
import { EVENTS_ASPECT, EVENTS_PATH } from "./eventsPaths.ts";
import { EDITS_OF, EDITS_TABLE, EditsTable } from "./EditsTable.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { MOVED, stepsNow } from "./moved.ts";
import type { View } from "./registry.ts";
import { SourcesView } from "./SourcesView.tsx";
import "./tables.css";

const CalendarView = lazy(() => import("./calendar/CalendarView.tsx").then((module) => ({ default: module.CalendarView })));

export { EVENTS_ASPECT, EVENTS_PATH } from "./eventsPaths.ts";

/**
 * Events' tabs left to right, by View.order: the Calendar, Daily rituals, Tables, Sources ("tab ordering should be
 * calendar, daily rituals, tables (rename), and sources"). Daily rituals is the rituals module's (2, written in its
 * HabitViews.tsx, which imports only the SDK); a tab with no order follows Sources.
 */
const EVENTS_ORDER = { calendar: 1, tables: 3, sources: 4 } as const;

/** The query's key naming the table open in Tables. */
export const TABLE_PARAM = "table";

/** Tables, the third tab (EVENTS_ORDER): every table, a list, each opening as it is kept. Called All, then Table ("Also rename the all tab to table"), until the captain's "tab ordering should be calendar, daily rituals, tables"; …/events/table, …/events/all and each old kind's address (…/events/calls) still open it. */
export const TABLE_VIEW: View = {
  key: "events-table",
  label: "Tables",
  aspects: [EVENTS_ASPECT],
  section: "tables",
  formerSections: ["table", "all", "messages", "calls", "hangouts", "llm", "workouts"],
  order: EVENTS_ORDER.tables,
  blurb: "Every table the archive keeps, the core's and the modules': pick one to open it as it is kept.",
  fill: true,
  component: () => <EventsTable />,
};

/** The Calendar, Events' first tab and its address alone: a day moment by moment, the week's events as cards, the month's at a glance or the year's days shaded, loaded when first opened. */
export const CALENDAR_VIEW: View = {
  key: "events-calendar",
  label: "Calendar",
  aspects: [EVENTS_ASPECT],
  section: "calendar",
  order: EVENTS_ORDER.calendar,
  blurb: "The day, the week, the month or the year as a calendar: a day moment by moment under its totals, every call, hangout, agent session and workout a card on the week, whom you messaged each day, a month's days at a glance (its messages and agent messages counted), a year's days shaded by how much happened.",
  fill: true,
  component: () => (
    <Suspense fallback={<p className="viewer__message">Loading…</p>}>
      <CalendarView />
    </Suspense>
  ),
};

/** Sources, the last tab: a status table of where the events come from. */
export const SOURCES_VIEW: View = {
  key: "events-sources",
  label: "Sources",
  aspects: [EVENTS_ASPECT],
  section: "sources",
  order: EVENTS_ORDER.sources,
  blurb: "Where the events come from: each source, how it syncs (live in the server, a scheduled job on this Mac, the Cua Space's exports, by hand), how often, when it last synced, whether it is failing or overdue, and what it has brought.",
  component: () => <SourcesView />,
};

/** The Events views of its own: the Calendar, Tables, then Sources (Daily rituals, the rituals module's, sits between the first two by its `order`). */
export function eventsViews(): View[] {
  return [CALENDAR_VIEW, TABLE_VIEW, SOURCES_VIEW];
}

/**
 * The table an address of Tables names, of `kinds`: its TABLE_PARAM, or an old kind's own section (…/events/calls), read
 * through the places that moved (`moved`: Friend Map's Messages tab's address, …/friend-map/messages, names
 * …/events/messages, so the Messages table); none for the list.
 */
export function tableNamed(kinds: readonly KindSpec[], pathname: string, search: string, moved: Readonly<Record<string, string>> = MOVED): KindSpec | null {
  const asked = new URLSearchParams(search).get(TABLE_PARAM) ?? stepsNow(stepsOf(pathname), moved)[1];
  return kinds.find((k) => k.kind === asked) ?? null;
}

/** Where Tables keeps a table's views: at Tables' address, the table named first in the query. */
export const TABLES_HOME: RowsHome = {
  read: (spec) => viewOf(spec, location.search),
  address: (view, spec) => `${EVENTS_PATH}${viewQuery(view, spec, { [TABLE_PARAM]: spec.kind })}`,
  leave: openAddress,
  // A page of the console's own (Friend Map, opened at someone's panel: its frame passes ?person= on).
  place: ({ place, query }) => `${consolePath(place)}?${new URLSearchParams(query)}`,
};

/** The address of the table `spec` as it opens from the list: its view fresh. */
export const tableAddress = (spec: KindSpec): string => TABLES_HOME.address(freshView(spec), spec);

/** Where a table is, in words, for Jump to: the Events page's Tables. */
export const TABLES_AT = "Events · Tables";

/** The console's address of a drawer's link (a table, narrowed as it says), or null for a table the server has not. */
export function linkAddress(kinds: readonly KindSpec[], link: ViewLink): string | null {
  const spec = kinds.find((k) => k.kind === link.kind);
  return spec ? TABLES_HOME.address({ ...freshView(spec), filters: link.filters }, spec) : null;
}

/** The range of the Calendar's day a row at `at` is on: 06:00 to 06:00, or for one with no time (kept at its date's midnight) its date. */
function calendarRange(at: number, timed: boolean): { from: number; to: number } {
  const [day, start] = timed ? [calendarDayOf(at), calendarDayStart] : [dayKey(at), dayStart];
  return { from: start(day), to: start(addDays(day, 1)) };
}

/** The address of a Calendar card's `row` in its own table `spec`: the table on the row's Calendar day (when it has one), its drawer open. */
export function rowAddress(spec: KindSpec, row: Row): string {
  const filters = row.at === undefined ? NO_FILTERS : { ...NO_FILTERS, ...calendarRange(row.at, typeof row.cells.when === "number") };
  return TABLES_HOME.address({ ...freshView(spec), filters, open: row.id }, spec);
}

/** Table: the list of tables, or the one the address names. */
export function EventsTable() {
  const [kinds, setKinds] = useState<KindSpec[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [at, setAt] = useState(() => ({ pathname: location.pathname, search: location.search }));
  useEffect(() => {
    let live = true;
    kindsOnce().then(
      (got) => live && setKinds(got),
      (error: Error) => live && setFailed(error.message),
    );
    const back = () => setAt({ pathname: location.pathname, search: location.search });
    addEventListener("popstate", back);
    return () => {
      live = false;
      removeEventListener("popstate", back);
    };
  }, []);

  if (failed) return <p className="viewer__message">The archive is unavailable: {failed}</p>;
  if (!kinds) return <p className="viewer__message">Loading…</p>;
  const head = (label: string) => (count: string, add: ReactNode = null) => (
    <div className="rows__head">
      <nav className="rows__trail" aria-label="Tables">
        <a href={EVENTS_PATH} onClick={inPlace(EVENTS_PATH)}>Tables</a>
        <Icon name="next" />
        <h2>{label}</h2>
      </nav>
      <span className="rows__count">{count}</span>
      {add}
    </div>
  );
  const query = new URLSearchParams(at.search);
  if (query.get(TABLE_PARAM) === EDITS_TABLE) {
    return (
      <EditsTable
        kinds={kinds}
        of={query.get(EDITS_OF)}
        onOf={(kind) => TABLES_HOME.leave(editsAddress(kind))}
        onRow={(spec, rowId) => TABLES_HOME.leave(TABLES_HOME.address({ ...freshView(spec), open: rowId }, spec))}
        head={head("Edits")}
      />
    );
  }
  const spec = tableNamed(kinds, at.pathname, at.search);
  if (!spec) return <TableList kinds={kinds} />;
  return <Rows key={spec.kind} spec={spec} kinds={kinds} home={TABLES_HOME} className="rows" head={({ count, add }) => head(spec.label)(count, add)} />;
}

/** The address of Edits, every table's or table `of`'s. */
export const editsAddress = (of: string | null = null): string =>
  `${EVENTS_PATH}?${new URLSearchParams({ [TABLE_PARAM]: EDITS_TABLE, ...(of ? { [EDITS_OF]: of } : {}) })}`;

/** Each table's icon, by its kind; a table with none of its own gets a sheet. */
const TABLE_ICONS: Readonly<Record<string, IconName>> = {
  messages: "message", calls: "call", hangouts: "hangout", llm: "llm", people: "friends", workouts: "workout", habits: "rituals",
};

/** What a module is called on its page (its first aspect's label), by its id; its id as a name for one with no page or whose page is not loaded. */
export function moduleName(id: string): string {
  return moduleViewers().find((m) => m.id === id)?.viewer?.aspects[0]?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The tables of one owner: a module's (its id), or the core's (null). */
export interface OwnedTables {
  owner: string | null;
  tables: KindSpec[];
}

/**
 * `kinds` grouped by whose each is, the groups in the order the server first names each owner and the tables of a group
 * in the server's order, so an owner's tables sit together whatever the server's list puts between them (friend map's
 * People beside its Messages, Calls and Hangouts).
 */
export function tablesByOwner(kinds: readonly KindSpec[]): OwnedTables[] {
  const groups: OwnedTables[] = [];
  for (const spec of kinds) {
    const owner = spec.module ?? null;
    const group = groups.find((g) => g.owner === owner);
    if (group) group.tables.push(spec);
    else groups.push({ owner, tables: [spec] });
  }
  return groups;
}

/** What of a table can be edited, in a line: the fields its owner lets be edited (KindSpec's `edits`), or that it is only read. */
export function editsText(spec: KindSpec): string {
  const fields = spec.edits ?? [];
  if (fields.length === 0) return "Read only";
  const edit = `Edit: ${fields.map((field) => field.label).join(", ")}`;
  return spec.own ? `${edit} · Add, delete ${spec.own.deletes}` : edit;
}

/**
 * The list: the tables under whose each is (the archive's own, then each module's: tablesByOwner), a row a table, each
 * with what of it can be edited, how many rows it has and its columns.
 */
function TableList({ kinds }: { kinds: readonly KindSpec[] }) {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  useEffect(() => {
    document.title = "Tables · Life archive";
    const abort = new AbortController();
    for (const spec of kinds) {
      fetchRows(spec.kind, NO_FILTERS, { offset: 0, limit: 1, sort: spec.sort, direction: "desc" }, abort.signal).then(
        (answer) => setCounts((was) => ({ ...was, [spec.kind]: answer.total })),
        () => abort.signal.aborted || setCounts((was) => ({ ...was, [spec.kind]: null })),
      );
    }
    return () => abort.abort();
  }, [kinds]);
  const groups = tablesByOwner(kinds);
  // Edits is the archive's own, first among its tables (even where it has none of its own), wherever a table can be edited.
  const editing = kinds.some((spec) => (spec.edits?.length ?? 0) > 0);
  if (editing && !groups.some((group) => group.owner === null)) groups.unshift({ owner: null, tables: [] });
  const edits = editsAddress();
  return (
    <div className="tables">
      {groups.map(({ owner, tables }) => {
        const whose = owner === null ? "Life archive" : moduleName(owner);
        return (
          <section key={owner ?? ""} className="tables__group">
            <h3 className="tables__owner">{whose}</h3>
            <ul className="tables__list" aria-label={`${whose}'s tables`}>
              {owner === null && editing && (
                <li>
                  <a className="tables__item" href={edits} onClick={inPlace(edits)}>
                    <Icon name="edit" className="tables__icon" />
                    <span className="tables__name">
                      <strong>Edits</strong>
                      <small className="tables__edits">Undo any edit</small>
                    </span>
                    <span className="tables__count" />
                    <span className="tables__columns">Every edit to every table, the newest first</span>
                    <Icon name="next" className="tables__go" />
                  </a>
                </li>
              )}
              {tables.map((spec) => {
                const address = tableAddress(spec);
                const count = counts[spec.kind];
                return (
                  <li key={spec.kind}>
                    <a className="tables__item" href={address} onClick={inPlace(address)}>
                      <Icon name={TABLE_ICONS[spec.kind] ?? "file"} className="tables__icon" />
                      <span className="tables__name">
                        <strong>{spec.label}</strong>
                        <small className={spec.edits?.length ? "tables__edits" : undefined}>{editsText(spec)}</small>
                      </span>
                      <span className="tables__count">{count === undefined ? "…" : count === null ? "unavailable" : `${countText(count)} ${count === 1 ? spec.noun[0] : spec.noun[1]}`}</span>
                      <span className="tables__columns">{spec.columns.map((c) => c.label).join(" · ")}</span>
                      <Icon name="next" className="tables__go" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A link's plain click, opening `address` in place (a modified one opens a new tab, as a link does). */
const inPlace = (address: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  TABLES_HOME.leave(address);
};
