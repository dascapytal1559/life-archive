// What of friend-map's page moved to the Events page (page/src/demos/movedToEvents.ts): the Table, its People, Hangouts
// and Calls tabs, to Events' Tables, and the Calendar, to Events' Calendar; an old address opens the new place, the
// older /demos/ ones too, and the page's addresses for Events are the console's own (its CALENDAR_PATH and EVENTS_PATH).

import { describe, expect, it } from "vitest";
import { CALENDAR_PATH, EVENTS_PATH } from "../../../sdk/testing.ts";
import { movedToEvents } from "../page/src/demos/movedToEvents.ts";
import { movedAddress, VIEWS } from "../page/src/views.ts";

/** Where the page's entry (page/src/main.tsx) sends an address: first where an older one lives now, then on to Events if it moved there. */
function opened(at: { pathname: string; search: string }): string | null {
  const moved = movedAddress({ ...at, hash: "" });
  const now = moved === null ? at : new URL(moved, "http://page.invalid");
  return movedToEvents({ pathname: now.pathname, search: now.search });
}

describe("the folded Table", () => {
  it("sends /table?tab=hangouts and ?tab=calls on to the same table in Events' Tables", () => {
    expect(movedToEvents({ pathname: "/table", search: "?tab=hangouts" })).toBe(`${EVENTS_PATH}?table=hangouts`);
    expect(movedToEvents({ pathname: "/table/", search: "?tab=calls&person=3" })).toBe(`${EVENTS_PATH}?table=calls`);
  });

  it("sends People, and a Table that names no tab or one it never had, on to Events' People table", () => {
    expect(movedToEvents({ pathname: "/table", search: "?tab=people" })).toBe(`${EVENTS_PATH}?table=people`);
    expect(movedToEvents({ pathname: "/table", search: "" })).toBe(`${EVENTS_PATH}?table=people`);
    expect(movedToEvents({ pathname: "/table", search: "?tab=nonsense" })).toBe(`${EVENTS_PATH}?table=people`);
  });

  it("leaves every view of the map where it is, and the switcher lists no Table", () => {
    expect(movedToEvents({ pathname: "/spider", search: "?tab=calls" })).toBeNull();
    expect(VIEWS.map((view) => view.path)).not.toContain("/table");
  });

  it("sends the address from before the views left /demos/ on too, its tab kept", () => {
    expect(movedAddress({ pathname: "/demos/table", search: "?tab=calls", hash: "" })).toBe("/table?tab=calls");
    expect(opened({ pathname: "/demos/table", search: "?tab=calls" })).toBe(`${EVENTS_PATH}?table=calls`);
    expect(opened({ pathname: "/demos/table/", search: "" })).toBe(`${EVENTS_PATH}?table=people`);
    expect(opened({ pathname: "/demos/spider", search: "" })).toBeNull();
  });

  it("names Events' Tables where the console keeps them, unmounted (docs/console.md's \"Tables\")", () => {
    expect(movedToEvents({ pathname: "/table", search: "" })).toBe("/life-archive/dev/events/tables?table=people");
  });
});

describe("the folded Calendar", () => {
  it("sends a day on to the same day in Events' Calendar", () => {
    expect(movedToEvents({ pathname: "/calendar", search: "?day=2026-11-06" })).toBe(`${CALENDAR_PATH}?view=day&day=2026-11-06`);
    expect(movedToEvents({ pathname: "/calendar/", search: "?day=2026-11-06&theme=dark" })).toBe(`${CALENDAR_PATH}?view=day&day=2026-11-06`);
  });

  it("sends a month on to the same month, and anything else to Events' Calendar as it opens", () => {
    expect(movedToEvents({ pathname: "/calendar", search: "?month=2026-10" })).toBe(`${CALENDAR_PATH}?view=month&day=2026-10-01`);
    expect(movedToEvents({ pathname: "/calendar", search: "" })).toBe(CALENDAR_PATH);
    expect(movedToEvents({ pathname: "/calendar", search: "?day=yesterday" })).toBe(CALENDAR_PATH);
  });

  it("sends the address from before the views left /demos/ on too, its day kept", () => {
    expect(opened({ pathname: "/demos/calendar", search: "?day=2026-11-06" })).toBe(`${CALENDAR_PATH}?view=day&day=2026-11-06`);
    expect(opened({ pathname: "/demos/calendar", search: "" })).toBe(CALENDAR_PATH);
  });

  it("names Events' Calendar where the console keeps it, unmounted", () => {
    expect(movedToEvents({ pathname: "/calendar", search: "" })).toBe("/life-archive/dev/events");
  });
});
