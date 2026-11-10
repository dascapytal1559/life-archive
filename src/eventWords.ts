// What the captain reads for a catch-up (catch_up in the archive, CatchUp in
// the code): time with people in person, now that a call is an event of its
// own. Every word the page (and the change log it shows) uses for one comes
// from here, so naming it again ("catch-up", say) is a change to ONE alone.
// Code, tables, routes and the CLI keep "catch-up".

import { LOCALE } from "./time.ts";

const ONE = "hangout";

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export const HANGOUT = {
  /** "hangout" */
  one: ONE,
  /** "hangouts" */
  many: `${ONE}s`,
  /** "Hangout" */
  One: capital(ONE),
  /** "Hangouts" */
  Many: capital(`${ONE}s`),
} as const;

/** "1 hangout", "3 hangouts". */
export function hangoutCount(count: number): string {
  return `${count.toLocaleString(LOCALE)} ${count === 1 ? HANGOUT.one : HANGOUT.many}`;
}

/** The kinds of event Add event adds, in the order its toggle shows them. */
export const EVENT_KINDS = ["message", "call", "hangout"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** What each kind is called on Add event's toggle. */
export const EVENT_KIND_NAMES: Record<EventKind, string> = { message: "Message", call: "Call", hangout: HANGOUT.One };

/** Whether Add event offers Message: not yet (a message has no form of its own), so its toggle is left out until this is true. */
export const MESSAGE_EVENTS = false;

/** The kinds Add event offers now. */
export const SHOWN_EVENT_KINDS: readonly EventKind[] = EVENT_KINDS.filter((kind) => kind !== "message" || MESSAGE_EVENTS);
