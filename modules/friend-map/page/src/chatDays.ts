// How the person panel's chat lays out messages: as a messaging app does,
// oldest at the top and newest at the bottom, under a heading per local day.

import type { CatchUp, PersonCall } from "./archive.ts";
import { catchUpAt } from "./catchUps.ts";
import { dayKey, formatNumber } from "./time.ts";

/**
 * Each message's day, worked out once: the chat is grouped again as every page
 * arrives, and finding a local date is most of the work.
 */
const dayOf = new WeakMap<object, string>();

/**
 * Messages as the archive pages them (newest first), grouped by local day
 * in reading order: days oldest first, and each day's messages oldest first.
 */
export function chatDays<M extends { sentAt: number }>(newestFirst: readonly M[]): Array<{ day: string; messages: M[] }> {
  const days: Array<{ day: string; messages: M[] }> = [];
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const message = newestFirst[i];
    let day = dayOf.get(message);
    if (day === undefined) dayOf.set(message, (day = dayKey(message.sentAt)));
    if (days.at(-1)?.day !== day) days.push({ day, messages: [] });
    days.at(-1)!.messages.push(message);
  }
  return days;
}

/**
 * Whether a day from `chatDays` holds the same entries as before, so it need not be drawn again: the very same ones
 * (a message keeps its object as pages come, and a call or catch-up its entry until it is loaded again, changed, say).
 */
export function sameDay<M>(before: { day: string; messages: readonly M[] }, after: { day: string; messages: readonly M[] }): boolean {
  return before.day === after.day && before.messages.length === after.messages.length && before.messages.every((entry, i) => entry === after.messages[i]);
}

/**
 * The chat (newest first) with messages that came in since folded in, in order,
 * from `newest`: pages from the newest back to where the chat reaches. Every
 * message shown stays, older pages included; the same array when nothing is new.
 */
export function withNewest<M extends { id: number; sentAt: number }>(shown: M[], newest: readonly M[]): M[] {
  const known = new Set(shown.map((m) => m.id));
  const added = newest.filter((m) => !known.has(m.id));
  if (added.length === 0) return shown;
  const merged = [...added, ...shown];
  // New messages are nearly always newer than all shown; one that came in late is sorted into place.
  const inOrder = shown.length === 0 || added.every((m) => m.sentAt > shown[0].sentAt || (m.sentAt === shown[0].sentAt && m.id > shown[0].id));
  return inOrder ? merged : merged.sort((a, b) => b.sentAt - a.sentAt || b.id - a.id);
}

/**
 * A call as the chat lays it out: at its time (`sentAt`), with an id no message has (the call's own, made
 * negative, since message ids are positive; one you logged from LOGGED_CALLS down, as its own numbers are
 * another table's).
 */
export interface CallEntry {
  id: number;
  sentAt: number;
  call: PersonCall;
}

/**
 * A catch-up as the chat lays it out: at its time on its local date, or at the start of that day when it has none
 * (catchUpAt), before anything else at that instant, so its id is below every message's and call's (the catch-up's
 * own, from the lowest safe integer up).
 */
export interface CatchUpEntry {
  id: number;
  sentAt: number;
  catchUp: CatchUp;
}

/** Where the ids of the calls you logged start, going down: far below any imported call's, far above any catch-up's. */
const LOGGED_CALLS = -(2 ** 51);

/** Each call and catch-up made an entry once, so the chat keeps the same entries (and draws a day again only when one changes). */
const callEntryOf = new WeakMap<PersonCall, CallEntry>();
const catchUpEntryOf = new WeakMap<CatchUp, CatchUpEntry>();

/**
 * The chat (newest first) with the person's calls and catch-ups (each newest first) among the messages, calls at
 * their time and catch-ups at theirs (the start of their day without one): every one when `whole` (the whole history is loaded), else
 * those no older than the oldest message loaded (catch-ups on its day too), which come in as older pages do; and
 * unless `newest` (the chat reaches its newest message: it was opened at a moment and has not paged that far yet),
 * none newer than the newest message loaded (catch-ups on its day aside), which come in as newer pages do. Another
 * app's calls are messages in the chat already (messageId), so they are not added again. The same array when there
 * is nothing to add.
 */
export function withEvents<M extends { id: number; sentAt: number }>(
  messages: M[],
  calls: readonly PersonCall[],
  catchUps: readonly CatchUp[],
  whole: boolean,
  newest = true,
): Array<M | CallEntry | CatchUpEntry> {
  const from = whole || messages.length === 0 ? -Infinity : messages[messages.length - 1].sentAt;
  const to = newest || messages.length === 0 ? Infinity : messages[0].sentAt;
  const fromDay = from === -Infinity ? "" : dayKey(from);
  const toDay = to === Infinity ? "\uffff" : dayKey(to);
  const callEntries = calls.filter((call) => call.messageId === null && call.at >= from && call.at <= to).map((call) => {
    let entry = callEntryOf.get(call);
    if (!entry) callEntryOf.set(call, (entry = { id: call.manual ? LOGGED_CALLS - call.id : -call.id, sentAt: call.at, call }));
    return entry;
  });
  const catchUpEntries = catchUps.filter((catchUp) => catchUp.day >= fromDay && catchUp.day <= toDay).map((catchUp) => {
    let entry = catchUpEntryOf.get(catchUp);
    if (!entry) catchUpEntryOf.set(catchUp, (entry = { id: Number.MIN_SAFE_INTEGER + catchUp.id, sentAt: catchUpAt(catchUp), catchUp }));
    return entry;
  });
  if (callEntries.length === 0 && catchUpEntries.length === 0) return messages;
  return [...messages, ...callEntries, ...catchUpEntries].sort((a, b) => b.sentAt - a.sentAt || b.id - a.id);
}

/**
 * Where a person's chat opens instead of at its newest message (a chip in the Table's Who): a moment, ms since the epoch, and
 * what to mark there: a call record (its message), a call in no chat or one logged (the call at that moment: its
 * number is each person's own row's, so it is found by its time), or a catch-up.
 */
export interface ChatMoment {
  at: number;
  mark: { message: number } | { call: true } | { catchUp: number };
  /** Which time it was asked for, so asking for the same moment again goes back to it. */
  asked?: number;
}

/** A moment as a page's cursor: everything at it or later is after it, everything earlier before it (ids are never 0). */
export function momentCursor(moment: ChatMoment): string {
  return `${Math.floor(moment.at)}:0`;
}

/** The same moment and mark, asked for the same time, so a chat opened at it need not load again. */
export function momentKey(moment: ChatMoment | undefined): string {
  return moment ? `${moment.at}:${JSON.stringify(moment.mark)}:${moment.asked ?? 0}` : "newest";
}

/** Whether a chat's entry is what `moment` marks. */
export function isMarked(entry: { id: number; sentAt: number } | CallEntry | CatchUpEntry, moment: ChatMoment): boolean {
  const { mark } = moment;
  if ("catchUp" in mark) return "catchUp" in entry && entry.catchUp.id === mark.catchUp;
  if ("call" in mark) return "call" in entry && entry.call.at === moment.at;
  return !("call" in entry) && !("catchUp" in entry) && entry.id === mark.message;
}

/**
 * The entry a chat opened at `moment` scrolls to: the one it marks, or until that has loaded (a person's calls and
 * catch-ups come apart from the messages) the oldest at or after the moment, else the newest; none in an empty chat.
 * `entries` are newest first.
 */
export function aimAt<E extends { id: number; sentAt: number }>(entries: readonly E[], moment: ChatMoment): { entry: E; marked: boolean } | null {
  const marked = entries.find((entry) => isMarked(entry, moment));
  if (marked) return { entry: marked, marked: true };
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].sentAt >= moment.at) return { entry: entries[i], marked: false };
  return entries.length > 0 ? { entry: entries[0], marked: false } : null;
}

/** Progress while the whole history loads: "Loading… 12,000 of 74,075", or without a total until one is known. */
export function loadingAllLabel(loaded: number, total: number | null): string {
  return total === null ? `Loading… ${formatNumber(loaded)}` : `Loading… ${formatNumber(Math.min(loaded, total))} of ${formatNumber(total)}`;
}

/**
 * Which days to draw, the rest standing in as two blank spaces. The chat is
 * anchored at its bottom, so everything is measured up from there: `heights`
 * are the days' heights newest first, `scrolledUp` how far the view is from
 * the bottom, and `margin` how far past the view to keep drawing. Gives the
 * newest and oldest day to draw (indices into `heights`), and the space the
 * days newer and older than those take.
 */
export function dayWindow(
  heights: readonly number[],
  scrolledUp: number,
  viewHeight: number,
  margin: number,
): { newest: number; oldest: number; newer: number; older: number } {
  const low = scrolledUp - margin;
  const high = scrolledUp + viewHeight + margin;
  let newest = -1;
  let oldest = -1;
  let newer = 0;
  let older = 0;
  let bottom = 0;
  for (let i = 0; i < heights.length; i++) {
    const top = bottom + heights[i];
    if (top <= low) newer += heights[i];
    else if (bottom >= high) older += heights[i];
    else {
      if (newest < 0) newest = i;
      oldest = i;
    }
    bottom = top;
  }
  return { newest, oldest, newer, older };
}
