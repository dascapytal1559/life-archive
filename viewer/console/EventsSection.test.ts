import { afterEach, describe, expect, it, vi } from "vitest";
import { dayStart } from "../../src/time.ts";
import { NO_FILTERS, type KindSpec } from "../wire.ts";
import { openAddress } from "./address.ts";
import { editsAddress, editsText, EVENTS_PATH, linkAddress, moduleName, rowAddress, tableAddress, tableNamed, TABLES_HOME, tablesByOwner } from "./EventsSection.tsx";

// moduleName reads the modules' page halves, as the page loads them before the console (viewer/main.tsx): every one, on.
await vi.hoisted(async () => {
  const { installedViewers, loadModuleViewers } = await import("../modules.ts");
  await loadModuleViewers(Object.fromEntries(installedViewers().map((id) => [id, true])));
});

/** Made-up tables of the server's shape: Calls and Hangouts. */
const CALLS: KindSpec = {
  kind: "calls",
  label: "Calls",
  noun: ["call", "calls"],
  columns: [{ key: "when", label: "When", kind: "time", width: 100, sortable: true }],
  filters: [{ key: "app", label: "App", kind: "choice" }, { key: "person", label: "Person", kind: "person" }],
  measures: [{ key: "calls", label: "Calls", unit: "count" }],
  sort: "when",
  splits: ["app"],
};
const HANGOUTS: KindSpec = { ...CALLS, kind: "hangouts", label: "Hangouts", filters: [{ key: "person", label: "Person", kind: "person" }] };
const KINDS = [CALLS, HANGOUTS];

/** The table Table opens at `address`, and the view it reads there. */
const at = (address: string) => {
  const url = new URL(address, "http://archive.test");
  vi.stubGlobal("location", { pathname: url.pathname, search: url.search });
  const spec = tableNamed(KINDS, url.pathname, url.search);
  return { spec, view: spec && TABLES_HOME.read(spec) };
};
afterEach(() => vi.unstubAllGlobals());

const HOUR = 3_600_000;

/** The time range an address narrows to. */
const rangeOf = (address: string) => {
  const params = new URL(address, "http://archive.test").searchParams;
  return { from: Number(params.get("from")), to: Number(params.get("to")) };
};

describe("A table's module, on the list of tables", () => {
  it("is named by its page, and a module with no page of its own by its id as a name", () => {
    expect(moduleName("exercise")).toBe("Fitness");
    expect(moduleName("rituals")).toBe("Rituals");
  });
});

describe("The list of tables", () => {
  /** Made-up tables as the server orders them: a module's two with the archive's own between them, then another module's. */
  const of = (kind: string, module?: string): KindSpec => ({ ...CALLS, kind, label: kind, ...(module ? { module } : {}) });
  const LISTED = [of("chats", "social"), of("visits", "social"), of("sessions"), of("friends", "social"), of("runs", "sport")];

  it("groups the tables under whose each is, an owner's together, in the order the server first names each", () => {
    expect(tablesByOwner(LISTED).map(({ owner, tables }) => [owner, tables.map((t) => t.kind)])).toEqual([
      ["social", ["chats", "visits", "friends"]],
      [null, ["sessions"]],
      ["sport", ["runs"]],
    ]);
    expect(tablesByOwner([])).toEqual([]);
  });

  it("says what of a table can be edited, by its fields' names, or that it is only read", () => {
    const edits = [{ key: "when", label: "When", input: "datetime" as const }, { key: "note", label: "Note", input: "note" as const }];
    expect(editsText({ ...HANGOUTS, edits })).toBe("Edit: When, Note");
    expect(editsText(CALLS)).toBe("Read only");
    expect(editsText({ ...CALLS, edits: [] })).toBe("Read only");
    // A table of the captain's own rows says they are added and deleted, and which.
    expect(editsText({ ...HANGOUTS, edits, own: { add: edits, deletes: "any hangout" } })).toBe("Edit: When, Note · Add, delete any hangout");
  });

  it("opens a table at Tables' address, the table named, its view fresh", () => {
    expect(tableAddress(CALLS)).toBe("/life-archive/dev/events/tables?table=calls");
  });

  it("opens Edits at Tables' address, every table's or one table's, and it is never a table's kind", () => {
    expect(editsAddress()).toBe("/life-archive/dev/events/tables?table=edits");
    expect(editsAddress("calls")).toBe("/life-archive/dev/events/tables?table=edits&of=calls");
    expect(at(editsAddress("calls")).spec).toBeNull();
  });
});

describe("Table in the console's address", () => {
  it("lists the tables at its own address, and at an old one that names no table", () => {
    for (const address of ["/life-archive/dev/events/tables", "/life-archive/dev/events/all", "/life-archive/dev/events/tables?table=texts&app=phone"]) {
      expect(at(address).spec, address).toBeNull();
    }
  });

  it("opens the table its query names, with its view, the table named first", () => {
    const { spec, view } = at("/life-archive/dev/events/tables?table=calls&app=phone&person=4");
    expect(spec).toBe(CALLS);
    expect(view).toMatchObject({ kind: "calls", filters: { choices: { app: ["phone"] }, person: 4 } });
    expect(TABLES_HOME.address(view!, CALLS)).toBe("/life-archive/dev/events/tables?table=calls&person=4&app=phone");
  });

  it("opens a kind's old address (…/events/calls) as that table", () => {
    const { spec, view } = at("/life-archive/dev/events/calls?app=phone");
    expect(spec).toBe(CALLS);
    expect(TABLES_HOME.address(view!, CALLS)).toBe("/life-archive/dev/events/tables?table=calls&app=phone");
  });

  it("opens a page's old tab that moved here (a module's own table page) as that table, its view kept, whatever the tab was called", () => {
    // A made-up module's page had a tab of its calls, at …/people/phone-log, which it says moved to …/events/calls.
    const moved = { "people/phone-log": "events/calls" };
    const url = new URL("/life-archive/dev/people/phone-log?app=phone&person=4", "http://archive.test");
    vi.stubGlobal("location", { pathname: url.pathname, search: url.search });
    const spec = tableNamed(KINDS, url.pathname, url.search, moved);
    expect(spec).toBe(CALLS);
    expect(TABLES_HOME.address(TABLES_HOME.read(spec!), spec!)).toBe("/life-archive/dev/events/tables?table=calls&person=4&app=phone");
    // Without the module's word (it is off, so nothing of it is loaded), the address names no table.
    expect(tableNamed(KINDS, url.pathname, url.search, {})).toBeNull();
  });

  it("reads only the table's own filters, so another's in the address are left out", () => {
    expect(at("/life-archive/dev/events/tables?table=hangouts&app=phone").view?.filters).toEqual(NO_FILTERS);
  });

  it("gives a drawer's link the address of its table, narrowed; none for a table the server has not", () => {
    expect(linkAddress(KINDS, { label: "Calls with them", kind: "calls", filters: { ...NO_FILTERS, person: 4 } })).toBe("/life-archive/dev/events/tables?table=calls&person=4");
    expect(linkAddress(KINDS, { label: "Nothing", kind: "gone", filters: NO_FILTERS })).toBeNull();
  });

  it("gives a Calendar card's row its own table on the Calendar's day, its drawer open", () => {
    const when = dayStart("2026-03-07") + 9 * HOUR;
    const address = new URL(rowAddress(HANGOUTS, { id: "h7", cells: { when }, at: when }), "http://archive.test");
    expect(address.pathname).toBe("/life-archive/dev/events/tables");
    expect(Object.fromEntries(address.searchParams)).toEqual({
      table: "hangouts", from: String(dayStart("2026-03-07") + 6 * HOUR), to: String(dayStart("2026-03-08") + 6 * HOUR), open: "h7",
    });
    expect(rowAddress(HANGOUTS, { id: "h8", cells: {} })).toBe("/life-archive/dev/events/tables?table=hangouts&open=h8");
  });

  it("opens a row of the small hours on the day before, the column its card is in", () => {
    const when = dayStart("2026-03-07") + 1.5 * HOUR;
    expect(rangeOf(rowAddress(CALLS, { id: "c1", cells: { when }, at: when }))).toEqual({ from: dayStart("2026-03-06") + 6 * HOUR, to: dayStart("2026-03-07") + 6 * HOUR });
  });

  it("opens a row with no time on its own date, which midnight alone does not say", () => {
    const at = dayStart("2026-03-07");
    expect(rangeOf(rowAddress(HANGOUTS, { id: "h9", cells: { when: "7 Mar 2026" }, at }))).toEqual({ from: dayStart("2026-03-07"), to: dayStart("2026-03-08") });
    expect(rangeOf(rowAddress(CALLS, { id: "c2", cells: { when: at }, at }))).toEqual({ from: dayStart("2026-03-06") + 6 * HOUR, to: dayStart("2026-03-07") + 6 * HOUR });
  });
});

describe("Opening an address in the console", () => {
  /** A made-up browser at `address`: its address moved by pushState, and each step and telling kept. */
  const browser = (address: string) => {
    const url = new URL(address, "http://archive.test");
    const steps: string[] = [];
    const told: string[] = [];
    vi.stubGlobal("location", url);
    vi.stubGlobal("history", {
      pushState: (_state: unknown, _title: string, next: string) => {
        steps.push(next);
        const moved = new URL(next, url);
        url.pathname = moved.pathname;
        url.search = moved.search;
      },
    });
    vi.stubGlobal("PopStateEvent", Event);
    vi.stubGlobal("dispatchEvent", (event: Event) => told.push(`${event.type} ${url.pathname}${url.search}`));
    return { steps, told };
  };

  it("takes Table's tab from an open table back to the list, a step Back returns from, and tells what follows the address", () => {
    const { steps, told } = browser("/life-archive/dev/events/tables?table=calls&person=4");
    openAddress(EVENTS_PATH);
    expect(steps).toEqual(["/life-archive/dev/events/tables"]);
    expect(told).toEqual(["popstate /life-archive/dev/events/tables"]);
    expect(tableNamed(KINDS, location.pathname, location.search)).toBeNull();
  });

  it("does nothing at the address already open", () => {
    const { steps, told } = browser("/life-archive/dev/events/tables?table=calls");
    openAddress("/life-archive/dev/events/tables?table=calls");
    expect(steps).toEqual([]);
    expect(told).toEqual([]);
  });
});
