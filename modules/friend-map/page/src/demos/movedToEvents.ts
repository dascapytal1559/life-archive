// What of this page moved to the life archive's Events page. The Table once had three tabs, People, Hangouts and Calls,
// named in its address (/table?tab=hangouts); all three folded into Events' Tables on 10 November 2026, one at a time
// (the captain: "each once Events can do what Friend Map's does"), where hangouts, calls and people are added,
// changed, deleted and undone, and its tag manager became the Tags table. The Calendar (/calendar, a month, ?day= a
// day's panel, ?month= another month) folded into Events' Calendar the same day (the captain: "Fold it"), where a day
// lists who was messaged and opens one chat at a time, and adds a hangout or a call. An address naming either opens
// its new place, in the whole window, out of the console's frame too; any other address is this page's own.

// Events' addresses are the console's own (through the SDK's wire.ts), under the mount the page was built for.

import { CALENDAR_PATH, EVENTS_PATH } from "../../../../../sdk/wire.ts";
import { HANGOUT } from "../eventWords.ts";

/** The query parameter that named the tab. */
const TAB_PARAM = "tab";

/** Each tab's word in the address, and the table in Events' Tables it is now; the Table with no tab (or one not known) opened People. */
const FOLDED: Readonly<Record<string, string>> = { people: "people", [HANGOUT.many]: "hangouts", calls: "calls" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/**
 * Where an address of the page (its app path, the mount taken off, and its query) now leads, when it is one that moved
 * to Events: the Table, to the table its tab is now (People for none); the Calendar, to the same day in Events'
 * Calendar (its day view), the same month (its month view, at the month's 1st), or Events' Calendar as it opens. Null
 * for any other.
 */
export function movedToEvents(at: { pathname: string; search: string }): string | null {
  const path = at.pathname.replace(/\/+$/, "");
  const params = new URLSearchParams(at.search);
  if (path === "/table") {
    const table = FOLDED[params.get(TAB_PARAM) ?? ""] ?? FOLDED.people;
    return `${EVENTS_PATH}?${new URLSearchParams({ table })}`;
  }
  if (path === "/calendar") {
    const day = params.get("day");
    if (day !== null && DAY.test(day)) return `${CALENDAR_PATH}?${new URLSearchParams({ view: "day", day })}`;
    const month = params.get("month");
    if (month !== null && MONTH.test(month)) return `${CALENDAR_PATH}?${new URLSearchParams({ view: "month", day: `${month}-01` })}`;
    return CALENDAR_PATH;
  }
  return null;
}
