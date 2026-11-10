// Where the Events page and its two main views are in the console (EventsSection.tsx draws it, calendar/ its Calendar),
// apart from them so that what links to them reads the addresses alone, nothing of the page: friend-map's page, whose
// addresses for Events are these, under the mount it was built for.

import { consolePath } from "./address.ts";

/** The Events aspect's key in the registry: the console's home. */
export const EVENTS_ASPECT = "events";

/** The Calendar's address in the console: Events' own, the Calendar being its first tab (…/events/calendar still opens it). */
export const CALENDAR_PATH = consolePath(EVENTS_ASPECT);

/** Tables' address: the list of tables, and each table open, named by EventsSection.tsx's TABLE_PARAM. */
export const EVENTS_PATH = consolePath(EVENTS_ASPECT, "tables");
