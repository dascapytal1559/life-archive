// The Calendar's day (DayView.tsx draws it): the calendar's building block ("it
// should almost feel like a time machine where I can go through moment by moment and I can see some summaries up
// top"). Pure, so day.test.ts holds it: the day event by event, in time order, with no hours drawn and no empty
// stretch ("on the days that I have a lot of spacing, I don't need to see that"): what is on the day with no time first,
// then each call, hangout, workout and ritual from its start, one begun the night before at the
// top, the day running from where its days begin (06:00, so its small hours come last);
// where the present falls among them on today; stepping from one to the next; and the counts in the kind chips over
// it, a day's, a week's or a month's (a count a kind on, its agent messages among them). Messages are never moments:
// by the captain's word the calendar never says when he messaged ("dont document messages in calendar", "dont show
// when exactly"), so the day counts them and says with whom; nor are agent sessions, which the day counts.

import { habitDoing } from "../../../src/habitWords.ts";
import { dayStartAt } from "../../../src/time.ts";
import { countText, lengthText, timeText } from "../../format.ts";
import type { RitualsDaySummary } from "../../wire.ts";
import { cardDay, daysOf, isTimedKind, rangeText, TIMED_KINDS, wordsOf, type CalendarEvent, type CalendarKind, type CardKind, type Messaged, type Tally, type Timed } from "./calendar.ts";

/** An event's kind or title, when it has one, for ordering those with no time. */
const wordOf = (event: Timed, key: "kind" | "title") => {
  const word = (event as Partial<Record<typeof key, unknown>>)[key];
  return typeof word === "string" ? word : "";
};

/** A row of the day's list: its event, and whether it began on an earlier day (a call over midnight). */
export interface DayItem<E extends Timed = CalendarEvent> {
  event: E;
  before: boolean;
}

/**
 * The day event by event, the day beginning at `begins` (HH:MM): those with no time on it first (by kind, then title),
 * then every event at a time that is on the day (begun on it, or begun earlier and still going at its start), by when
 * it began, then when it ended.
 */
export function dayListOf<E extends Timed>(events: readonly E[], day: string, begins: string): DayItem<E>[] {
  const start = dayStartAt(day, begins);
  const allDay = events
    .filter((event) => event.allDay && cardDay(event, begins) === day)
    .toSorted((a, b) => wordOf(a, "kind").localeCompare(wordOf(b, "kind")) || wordOf(a, "title").localeCompare(wordOf(b, "title")) || a.key.localeCompare(b.key));
  const timed = events
    .filter((event) => {
      if (event.allDay) return false;
      const [first, last] = daysOf(event, begins);
      return first <= day && day <= last;
    })
    .toSorted((a, b) => a.at - b.at || a.until - b.until || a.key.localeCompare(b.key));
  return [...allDay.map((event) => ({ event, before: false })), ...timed.map((event) => ({ event, before: event.at < start }))];
}

/** A day of the week's list: the day, and its events one by one (dayListOf). */
export interface WeekDay<E extends Timed = CalendarEvent> {
  day: string;
  items: DayItem<E>[];
}

/**
 * The week event by event (WeekList.tsx draws it): each of `days` its own list, as the day's is ordered (dayListOf), so
 * an event over midnight is on each day it touches, begun the day before at the top of the next.
 */
export function weekListOf<E extends Timed>(events: readonly E[], days: readonly string[], begins: string): WeekDay<E>[] {
  return days.map((day) => ({ day, items: dayListOf(events, day, begins) }));
}

/**
 * Whether the Events week lists a card in its days' lanes: calls, hangouts and workouts. Rituals have a row of their own
 * over the lanes, as whom he messaged and the agents do (the captain: "let's put ritual items in its own row in the week
 * view. Similar to messaged and agent. But we do want to retain exercise in the main time lanes"); the day keeps them
 * among its moments.
 */
export const isWeekLaneKind = (kind: CardKind): boolean => isTimedKind(kind) && kind !== "habits";

/**
 * The Events week split: its lanes (calls, hangouts and workouts, each day's one by one) and each day's rituals (in the
 * same order: those with no time first, then by their time), of the cards shown, for its Rituals row (ritualsSumOf).
 */
export function weekOf(events: readonly CalendarEvent[], days: readonly string[], begins: string): { lanes: WeekDay[]; rituals: Record<string, DayItem[]> } {
  const rituals = weekListOf(events.filter((event) => event.kind === "habits"), days, begins);
  return { lanes: weekListOf(events.filter((event) => isWeekLaneKind(event.kind)), days, begins), rituals: Object.fromEntries(rituals.map((d) => [d.day, d.items])) };
}

/** "Plank 1:15 · 9:40 pm", "Journal": a ritual done, its label, how long a plank was held, and its time when one is known. */
export function ritualText(event: CalendarEvent): string {
  return [[event.title, event.detail].filter(Boolean).join(" "), event.allDay ? "" : timeText(event.at)].filter(Boolean).join(" · ");
}

/**
 * A day's rituals as the Events week's Rituals row sums them up (the captain: "I rather it just said five out of five
 * ... in the week view, just show a summary"): how many were done over how many the day asked for, and the words of its
 * title. Both are rituals' own, from its day summary in the calendar (viewer/wire.ts's RitualsDaySummary, pushed from
 * the event index's ritual days): a habit done is one done, and the day asks for every habit but those not asked that
 * day (not applicable), as rituals counts its rates, and each required check that applied that day ("today it should be
 * five out of seven"); one not reported yet is asked and not yet done. A day rituals does not show (before it began, or to come) says nothing; while the calendar has no summary of a
 * day, one with rituals among its cards says how many were done, over nothing.
 */
export interface RitualsSum {
  done: number;
  /** How many the day asked for, or null when rituals' day is not known. */
  expected: number | null;
  /** "5/5", or "3 done" over nothing. */
  text: string;
  /** "5 of 5 rituals done: Magnesium, Protein, Stretch, Plank 1:15, Journal". */
  title: string;
}

/** The sum of `day` from rituals' day summary (null when the calendar has none), else from its rituals among the cards. */
export function ritualsSumOf(day: RitualsDaySummary | null, cards: readonly CalendarEvent[]): RitualsSum | null {
  if (day !== null) {
    const asked = day.done.length + day.notDone.length + day.notYet.length;
    if (asked === 0) return null;
    const said = (habit: string) => (day.held[habit] ? `${habitDoing(habit)} ${day.held[habit]}` : habitDoing(habit));
    const done = day.done.map(said);
    const notDone = day.notDone.map(said);
    const notYet = day.notYet.map(said);
    const title = [
      `${done.length} of ${asked} ${asked === 1 ? "ritual" : "rituals"} done${done.length > 0 ? `: ${done.join(", ")}` : ""}`,
      notDone.length > 0 ? `not done: ${notDone.join(", ")}` : "",
      notYet.length > 0 ? `not yet: ${notYet.join(", ")}` : "",
    ];
    return { done: done.length, expected: asked, text: `${done.length}/${asked}`, title: title.filter(Boolean).join("; ") };
  }
  if (cards.length === 0) return null;
  return { done: cards.length, expected: null, text: `${cards.length} done`, title: `${countText(cards.length)} ${cards.length === 1 ? "ritual" : "rituals"} done: ${cards.map(ritualText).join(", ")}` };
}

/** The archive's day as its list: its calls, hangouts and workouts (dayListOf), never its messages or agent sessions, which the day counts. */
export function momentsOf(events: readonly CalendarEvent[], day: string, begins: string): DayItem[] {
  return dayListOf(events.filter((event) => isTimedKind(event.kind)), day, begins);
}

/** Where the present goes in the day's list (`now`, on today alone): before the first event at a time that begins after it; null on another day or with nothing at a time. */
export function nowIndex(items: readonly DayItem<Timed>[], now: number | null): number | null {
  if (now === null || !items.some((item) => !item.event.allDay)) return null;
  const next = items.findIndex((item) => !item.event.allDay && item.event.at > now);
  return next === -1 ? items.length : next;
}

/** The moment `by` along from `at` (an index among `count`, or null for none yet): down from none is the first, up the last; it stops at either end. */
export function stepMoment(at: number | null, by: number, count: number): number | null {
  if (count === 0) return null;
  if (at === null) return by > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, at + by));
}

/** What a day, a week or a month is read as: its cards, how many messages and agent messages, and whom he messaged. */
export interface DayRead {
  events: readonly CalendarEvent[];
  messages: number;
  agentMessages: number;
  messaged: readonly Messaged[];
}

const LABELS: Record<CalendarKind, string> = { messages: "Messages", calls: "Calls", hangouts: "Hangouts", llm: "Agent messages", workouts: "Workouts", habits: "Rituals" };

/** The time `events` took in all, seconds; a moment counted once however many it overlaps. */
const lengthOf = (events: readonly CalendarEvent[]) => events.reduce((sum, event) => sum + event.length, 0);

/**
 * What the kind chips count on a day, a week or a month (the year's are year.ts's yearTally): a count for each kind on,
 * of `read` (the person picked's alone while one is), with the line under it in the chip's title. Rituals are moments,
 * not lengths: on a day their line says from the first timed to the last; over several days (`daysBegin`, where the
 * span's days begin) on how many days they were done.
 */
export function spanTally(read: DayRead, kinds: readonly CalendarKind[], daysBegin: string | null = null): Tally {
  const of = (kind: CardKind) => read.events.filter((event) => event.kind === kind);
  const timeNote = (events: readonly CalendarEvent[], what: string) => (events.length === 0 ? `No ${what}` : lengthOf(events) > 0 ? `${lengthText(lengthOf(events))} in all` : "No length kept");
  const ritualNote = (events: readonly CalendarEvent[]) => {
    if (events.length === 0) return "No rituals";
    if (daysBegin !== null) {
      const days = new Set(events.map((event) => cardDay(event, daysBegin))).size;
      return `On ${countText(days)} ${days === 1 ? "day" : "days"}`;
    }
    // Those with no time say none: "No time kept" when every one is so.
    const at = events.filter((e) => !e.allDay).map((e) => e.at);
    return at.length === 0 ? "No time kept" : rangeText(Math.min(...at), Math.max(...at));
  };
  const out: Tally = {};
  for (const kind of kinds) {
    if (kind === "messages") {
      const people = read.messaged.length;
      out[kind] = { label: LABELS[kind], value: countText(read.messages), note: people === 0 ? "With nobody" : `With ${countText(people)} ${people === 1 ? "person" : "people"}` };
    } else if (kind === "llm") {
      out[kind] = { label: LABELS[kind], value: countText(read.agentMessages), note: " " };
    } else {
      const events = of(kind);
      out[kind] = { label: LABELS[kind], value: countText(events.length), note: kind === "habits" ? ritualNote(events) : timeNote(events, wordsOf(kind).many) };
    }
  }
  return out;
}

/** "No calls, hangouts or workouts with Ada Sample": what a day with no moment of the kinds on says (messages and agents are never moments). */
export function noMomentsText(kinds: readonly CalendarKind[], who: string | null): string {
  const words = TIMED_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => wordsOf(kind).many);
  const list = words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
  return `${words.length === 0 ? "Nothing at a time" : `No ${list}`}${who ? ` with ${who}` : ""} on this day.`;
}

/**
 * Whether `day` is still to come against `today` (the calendar's own, its days running 06:00 to 06:00): such a day
 * shows no "Nothing", only what has not happened yet ("if a day is in the future, don't show nothing").
 */
export function isFutureDay(day: string, today: string): boolean {
  return day > today;
}

/** The longest a card is drawn, in hours; a longer event is drawn this tall and its words say how long it ran. */
export const CARD_MOST_HOURS = 12;

/**
 * How many standard heights a card of the day's or the week's list is drawn ("a three line event card set that height
 * as the standard one hour height. Now if an event lasts longer than one hour we should multiply the height of the box
 * by the number of hours"): its hours when it ran longer than one (2.5 h is 2.5), up to CARD_MOST_HOURS; otherwise,
 * and for anything all day or without a length, one.
 */
export function cardHours(event: Timed): number {
  if (event.allDay) return 1;
  const hours = (event.until - event.at) / 3_600_000;
  return Math.min(CARD_MOST_HOURS, Math.max(1, hours));
}

/**
 * The extra space, px, after a quiet of `ms`: 4 px at an hour and 4 px more for each doubling, smoothly in between
 * (1 h 4, 2 h 8, 4 h 12, 8 h 16, 16 h 20; the captain: "gap: 1hr=4px 2=8 4=12 8=16 16=20", then "smoothly is good. I
 * just wanted the exponential scale"). None under an hour: the list's own spacing.
 */
export function idleGap(ms: number): number {
  const hours = ms / 3_600_000;
  return hours < 1 ? 0 : 4 + 4 * Math.log2(hours);
}

/**
 * How far each row of a day's list sits apart from the one before, px (the day's and the week's lists draw the space
 * as --idle-gap): by idleGap of the quiet between its start and the end of every earlier row at a time (its start plus
 * how long it ran; its start when it has no length). An overlapping row, the first at a time and those with no time
 * get 0.
 */
export function idleRows(items: readonly DayItem<Timed>[]): number[] {
  let ended: number | null = null;
  return items.map(({ event }) => {
    if (event.allDay) return 0;
    const gap = ended === null ? 0 : idleGap(event.at - ended);
    ended = Math.max(ended ?? event.until, event.until, event.at);
    return gap;
  });
}
