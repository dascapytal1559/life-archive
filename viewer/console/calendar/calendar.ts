// The Calendar view's arithmetic (CalendarView.tsx draws it): the archive's events of a day moment by moment (day.ts),
// of a week as cards on a calendar, or of a month at a glance (a day a cell: its cards counted by kind on one line, its
// messages as a tint), in the design language of the reference the captain pointed at (a soft week calendar: day
// columns, an All day row, an hour grid, rounded pale cards with an icon, a title, a time range and the people's
// faces). Everything here is pure, so calendar.test.ts holds it: how each tab's rows (viewer/wire.ts's Row, as
// /life-archive/api/:kind/rows answers them) become cards (a call, a hangout, an agent session, a workout, a habit
// done), which of them the day and the week draw at their time (calls, hangouts, workouts and rituals; the agents are a
// day's summary), where a
// card sits on each day it touches (by the archive's clock, split where its days begin: 06:00 on Events), how cards that overlap share a column's
// width (lanes), whom the captain messaged each day (the calendar's day summaries, by the rule of the Messages tab's
// person facet; by his word never a card and never a time: "show people's initials or icons that i messaged that day, dont show when exactly"), what a
// month's days hold (their messages and agent messages counted, not carded: "lets rename llm sessions to agent
// messages"), what the calendar's addresses say (?view=, day=, show=, person=, calls=, open=), and the words on the page (the
// month, the span, a time range, a face's initials). The year's days (shaded by how much happened) are year.ts's.

import { HANGOUT } from "../../../src/eventWords.ts";
import { addDays, dayKey, dayKeyAt, dayStart, dayStartAt, TIME_ZONE, LOCALE } from "../../../src/time.ts";
import { lengthText, timeText } from "../../format.ts";
import { NO_FILTERS, type Filters, type PeopleCell, type Row } from "../../wire.ts";
import type { IconName } from "../icons.tsx";

export { CALENDAR_PATH } from "../eventsPaths.ts";

/**
 * When the Events calendar's days begin (06:00, so the small hours stay with the evening before), and which day an instant is in: one rule for the
 * page and the server (src/calendarDay.ts), whose day summaries are keyed by it.
 */
export { calendarDayOf, calendarDayStart, EVENTS_DAY_BEGINS } from "../../../src/calendarDay.ts";

/** The tabs of events that make cards, by the server's kind (server/viewer/tabs.ts). */
export type CardKind = "calls" | "hangouts" | "llm" | "workouts" | "habits";

/** What the calendar shows of each tab: the cards' kinds, and the people messaged each day. */
export type CalendarKind = "messages" | CardKind;

export interface KindWords {
  kind: CalendarKind;
  /** Its name on its toggle in the bar ("Agents": its sessions and the messages he sent them; "Messages"). */
  label: string;
  /** One and many ("call", "calls"; "person", "people" for the people messaged). */
  one: string;
  many: string;
  icon: IconName;
}

/** The kinds, in the order the bar's toggles list them and the addresses name them. */
export const CALENDAR_KINDS: readonly KindWords[] = [
  { kind: "messages", label: "Messages", one: "person", many: "people", icon: "message" },
  { kind: "calls", label: "Calls", one: "call", many: "calls", icon: "call" },
  { kind: "hangouts", label: HANGOUT.Many, one: HANGOUT.one, many: HANGOUT.many, icon: "hangout" },
  { kind: "llm", label: "Agents", one: "session", many: "sessions", icon: "llm" },
  { kind: "workouts", label: "Workouts", one: "workout", many: "workouts", icon: "workout" },
  // A trial (the captain: "Let's also trial um adding ritual events"): each habit done at its time, under its own chip.
  { kind: "habits", label: "Rituals", one: "ritual", many: "rituals", icon: "rituals" },
];

export const ALL_KINDS: readonly CalendarKind[] = CALENDAR_KINDS.map((k) => k.kind);

/**
 * The kinds the calendar can show with the server's tabs `tabs` (/life-archive/api/kinds): the people messaged always
 * (the calendar's day summaries, never a tab) and each kind of card whose tab the server has. A module's tab goes with
 * the module (Workouts is exercise's), so with it switched off its chip is not shown and its rows are not asked for.
 */
export const kindsServed = (tabs: readonly string[]): CalendarKind[] => ALL_KINDS.filter((kind) => kind === "messages" || tabs.includes(kind));

/** A count as the calendar says it: its name, its number, and the line under it ("Messages", "85", "With 6 people"). */
export interface Count {
  label: string;
  value: string;
  note: string;
}

/**
 * What the kind chips count on the day, the week, the month or the year (the captain: "we can just combine the count.
 * Into the filter chips"): a count for each kind on, in its chip, the line under it in the chip's title.
 */
export type Tally = Partial<Record<CalendarKind, Count>>;

/** The kinds that make cards: every kind but the people messaged. */
export const CARD_KINDS: readonly CardKind[] = ["calls", "hangouts", "llm", "workouts", "habits"];

export const isCardKind = (kind: string): kind is CardKind => (CARD_KINDS as readonly string[]).includes(kind);

/**
 * The kinds the day and the week draw at their time on the hours: calls, hangouts, workouts and rituals. Messages and
 * agents are each day's summaries, never at a time (the captain: "show Hangouts and Calls as events in a day in their
 * appropriate time as opposed to messages and agents where we're just showing a summary"); the month and the year count
 * them all.
 */
export const TIMED_KINDS: readonly CardKind[] = ["calls", "hangouts", "workouts", "habits"];

export const isTimedKind = (kind: CalendarKind): boolean => (TIMED_KINDS as readonly string[]).includes(kind);

export const wordsOf = (kind: CalendarKind): KindWords => CALENDAR_KINDS.find((k) => k.kind === kind)!;

/** A card on the calendar. */
export interface CalendarEvent {
  /** Unique on the calendar: the row's tab and id. */
  key: string;
  kind: CardKind;
  /** When it began, ms. */
  at: number;
  /** When it ended, ms: `at` itself for a point in time (a call never answered). */
  until: number;
  /** How long it lasted, seconds (0 when the app says none): a hangout with no time keeps its hours here alone. */
  length: number;
  /** On its day alone, with no time: a hangout the captain gave no time. */
  allDay: boolean;
  /** Who or what: the people, the project, the sport. */
  title: string;
  /** A few words under the time: the app and the length, the model, the distance. */
  detail: string | null;
  /** The people in it, by id (names in the answer's people), and how many more the app did not name. */
  people: number[];
  others: number;
  /** The row behind it, for its drawer: its tab and its id there. */
  row: { kind: CardKind; id: string };
}

const isPeople = (cell: unknown): cell is PeopleCell => typeof cell === "object" && cell !== null && "ids" in cell;

/** "Ada Sample, Bruno Example", "Ada Sample +2", "3 people": who a row names, for a card's title. */
export function whoText(ids: readonly number[], others: number, people: Record<number, string>): string {
  const names = ids.map((id) => people[id] ?? `Person ${id}`);
  if (names.length === 0) return others === 0 ? "Someone" : `${others} people`;
  return others > 0 ? `${names.join(", ")} +${others}` : names.join(", ");
}

const seconds = (cell: unknown): number => (typeof cell === "number" && cell > 0 ? cell : 0);
const text = (cell: unknown): string | null => (typeof cell === "string" && cell !== "" ? cell : null);

/** A row's own card: its tab's key, its time and length, who it names. */
function card(kind: CardKind, row: Row, at: number, length: number, who: unknown, title: string, detail: string | null): CalendarEvent {
  const people = isPeople(who) ? who : { ids: [], others: 0 };
  return { key: `${kind}:${row.id}`, kind, at, until: at + length * 1000, length, allDay: false, title, detail, people: people.ids, others: people.others, row: { kind, id: row.id } };
}

/**
 * How a call went, as its card says it after its app: its length when it had one; one never answered "Missed" when
 * they called, "No answer" when he did, "Not answered" when the app does not say who; nothing when nobody knows.
 */
export function callOutcome(cells: Row["cells"], length: number): string | null {
  if (length > 0) return lengthText(length);
  if (cells.answered !== "No") return null;
  return cells.way === "They called" ? "Missed" : cells.way === "You called" ? "No answer" : "Not answered";
}

/** Every call as a card: with whom, its app and how it went (its length, or missed), from when it began. */
export function callEvents(rows: readonly Row[], people: Record<number, string>): CalendarEvent[] {
  return rows.map((row) => {
    const at = Number(row.cells.when);
    const length = seconds(row.cells.length);
    const who = row.cells.with;
    const detail = [text(row.cells.app) ?? "Call", callOutcome(row.cells, length)].filter(Boolean).join(" · ");
    return card("calls", row, at, length, who, whoText(isPeople(who) ? who.ids : [], isPeople(who) ? who.others : 0, people), detail);
  });
}

/**
 * Every hangout as a card: with whom, in person (as every one is: the archive keeps no title or place for one, and its
 * note is content) and how long; one with no time is on its day alone.
 */
export function hangoutEvents(rows: readonly Row[], people: Record<number, string>): CalendarEvent[] {
  return rows.map((row) => {
    const timed = typeof row.cells.when === "number";
    const at = timed ? Number(row.cells.when) : (row.at ?? 0);
    const length = seconds(row.cells.hours);
    const who = row.cells.with;
    const detail = ["Hangout", length > 0 ? lengthText(length) : null].filter(Boolean).join(" · ");
    const made = card("hangouts", row, at, length, who, whoText(isPeople(who) ? who.ids : [], isPeople(who) ? who.others : 0, people), detail);
    return timed ? made : { ...made, until: at, allDay: true };
  });
}

/** Every agent session (the LLM tab's) as a card (a prompt or reply is a turn of one, not a card): its project, its model, its length. */
export function llmEvents(rows: readonly Row[]): CalendarEvent[] {
  return rows
    .filter((row) => row.cells.kind === "Session")
    .map((row) => {
      const at = Number(row.cells.when);
      const detail = [text(row.cells.model), text(row.cells.how)].filter(Boolean).join(" · ") || null;
      return card("llm", row, at, seconds(row.cells.length), null, text(row.cells.project) ?? "Agent session", detail);
    });
}

/** Every workout as a card: its sport, its distance and its length. */
export function workoutEvents(rows: readonly Row[]): CalendarEvent[] {
  return rows.map((row) => {
    const at = Number(row.cells.when);
    const length = seconds(row.cells.length);
    const detail = [text(row.cells.distance), length > 0 ? lengthText(length) : null].filter(Boolean).join(" · ") || null;
    return card("workouts", row, at, length, null, text(row.cells.sport) ?? "Workout", detail);
  });
}

/**
 * Every habit the captain did (the Rituals tab of events, modules/rituals/server/habitsTab.ts) as a moment of its day:
 * "Magnesium", "Plank" with how long it was held on its third line ("1:15") when its day says. One whose time is not
 * known (rituals began keeping doings on 2026-10-19) is on its day with no time, at the top.
 */
export function habitEvents(rows: readonly Row[]): CalendarEvent[] {
  return rows.map((row) => {
    const timed = typeof row.cells.when === "number";
    const at = timed ? Number(row.cells.when) : (row.at ?? 0);
    const made = card("habits", row, at, 0, null, text(row.cells.habit) ?? "Ritual", text(row.cells.held));
    return timed ? made : { ...made, allDay: true };
  });
}

/** The cards of a tab's rows. */
export function eventsOf(kind: CardKind, rows: readonly Row[], people: Record<number, string>): CalendarEvent[] {
  switch (kind) {
    case "calls":
      return callEvents(rows, people);
    case "hangouts":
      return hangoutEvents(rows, people);
    case "llm":
      return llmEvents(rows);
    case "workouts":
      return workoutEvents(rows);
    case "habits":
      return habitEvents(rows);
  }
}

/**
 * Which calls the Calls chip's menu shows, each off at first and each apart from the other: unknown calls (nobody on
 * them the archive has a name for) and missed calls (never answered: one that came in and was missed, or went out and
 * was never picked up; the captain: "Add another filter to calls alongside unknown: Missed calls"). By default the
 * calendar shows known, answered calls alone (DEFAULT_CALLS; the captain: "Make this the default").
 */
export interface CallsShown {
  unknown: boolean;
  missed: boolean;
}

export const ALL_CALLS: CallsShown = { unknown: true, missed: true };

/** The calendar's calls at first: known, answered calls alone. */
export const DEFAULT_CALLS: CallsShown = { unknown: false, missed: false };

/**
 * What a tab is asked for over [from, to): its rows there, of the LLM tab its sessions alone, and of the Calls tab the
 * calls `calls` shows (callsChoices).
 */
export function kindFilters(kind: CardKind, from: number, to: number, calls: CallsShown = ALL_CALLS): Filters {
  return { ...NO_FILTERS, from, to, choices: kind === "llm" ? { kind: ["llm_session"] } : kind === "calls" ? callsChoices(calls) : {} };
}

/**
 * The Calls tab's choices for the calendar's calls: while unknown calls are hidden only those with someone the archive
 * has a name for (the tab's Caller filter: a call whose people are only numbers is unknown's), and while missed calls
 * are hidden only those not known to be unanswered (its Answered filter: answered, or not known either way, as
 * callLabel calls only a call answered = 0 missed or unanswered).
 */
export function callsChoices(calls: CallsShown): Record<string, string[]> {
  return { ...(calls.unknown ? {} : { caller: ["known"] }), ...(calls.missed ? {} : { answered: ["yes", "unknown"] }) };
}

/** Someone the captain messaged on a day: who, and how many messages between them that day. */
export interface Messaged {
  id: number;
  count: number;
}

/** What the day and the week order: a card's key, when it begins and ends, and whether it is on its day with no time (CalendarEvent's). */
export type Timed = Pick<CalendarEvent, "key" | "at" | "until" | "allDay">;

/** What a card in the week's list shows: CalendarEvent's words, its kind a class (cal-card--<kind>) and its icon (WeekList.tsx's iconOf). */
export type ListEvent = Timed & Pick<CalendarEvent, "title" | "detail" | "length" | "people" | "others"> & { kind: string };

/**
 * The day a card is on, days beginning at `begins` (HH:MM): the one it begins on, or for one with no time (kept at its
 * date's midnight) its date, whenever its days begin.
 */
export function cardDay(event: Pick<Timed, "at" | "allDay">, begins: string): string {
  return event.allDay ? dayKey(event.at) : dayKeyAt(event.at, begins);
}

/**
 * The days a card touches, days beginning at `begins` (HH:MM), from the one it begins on to the one it ends on (a card
 * ending as a day begins ends the day before).
 */
export function daysOf(event: Timed, begins: string): [first: string, last: string] {
  return [dayKeyAt(event.at, begins), dayKeyAt(Math.max(event.at, event.until - 1), begins)];
}

/** Which calendar is shown: the day moment by moment (day.ts), the week's cards, the month's days at a glance, or the year's days shaded (year.ts). */
export type CalendarMode = "day" | "week" | "month" | "year";

export const CALENDAR_MODES: readonly CalendarMode[] = ["day", "week", "month", "year"];

/**
 * The calendar's address: the day, the week, the month or the year (the screen's own when left out: the week, or the
 * day on a phone), the day picked (today when left out), the kinds on (all when left out), a person, which calls are
 * shown (known, answered ones when left out), whether the hidden people are shown (not when left out), and the card
 * open.
 */
export interface CalendarState {
  mode: CalendarMode;
  /** The day picked, YYYY-MM-DD: the day shown, or the day whose week, month or year is shown. */
  day: string;
  kinds: CalendarKind[];
  person: number | null;
  /** Which calls are shown (the Calls chip's menu): `calls=unknown` shows unknown calls, `calls=missed` missed ones; neither by default. */
  calls: CallsShown;
  /** Whether the lists of people show those friend map hides (`hidden=show`): left out by default. */
  showHidden: boolean;
  /** The card open in the drawer: its row's tab and id ("calls:123"), or null. */
  open: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The state the query `search` says, for `today`, with `fallback` the view a query without one opens; what it cannot read is left at the default. */
export function readCalendarState(search: string, today: string, fallback: CalendarMode = "week"): CalendarState {
  const params = new URLSearchParams(search);
  const day = params.get("day");
  const asked = params.getAll("show").filter((kind): kind is CalendarKind => (ALL_KINDS as readonly string[]).includes(kind));
  const kinds = asked.length === 0 ? [...ALL_KINDS] : ALL_KINDS.filter((kind) => asked.includes(kind));
  const personText = params.get("person");
  const person = personText !== null && /^\d+$/.test(personText) ? Number(personText) : null;
  const view = params.get("view");
  const mode = CALENDAR_MODES.find((m) => m === view) ?? fallback;
  const only = params.getAll("calls");
  const calls = { unknown: only.includes("unknown"), missed: only.includes("missed") };
  const showHidden = params.get("hidden") === "show";
  return { mode, day: day !== null && DAY.test(day) && !Number.isNaN(Date.parse(day)) ? day : today, kinds, person, calls, showHidden, open: params.get("open") || null };
}

/** The address of `state` at `path`, leaving out what is the default: `fallback`'s view, today, every kind on, nobody, nothing open. */
export function calendarAddress(state: CalendarState, path: string, today: string, fallback: CalendarMode = "week"): string {
  const params = new URLSearchParams();
  if (state.mode !== fallback) params.set("view", state.mode);
  if (state.day !== today) params.set("day", state.day);
  if (state.kinds.length !== ALL_KINDS.length) for (const kind of ALL_KINDS) if (state.kinds.includes(kind)) params.append("show", kind);
  if (state.person !== null) params.set("person", String(state.person));
  if (state.calls.unknown) params.append("calls", "unknown");
  if (state.calls.missed) params.append("calls", "missed");
  if (state.showHidden) params.set("hidden", "show");
  if (state.open !== null) params.set("open", state.open);
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

/** The card an address's `open` names: its tab and its row's id there. */
export function openOf(open: string): { kind: CardKind; id: string } | null {
  const colon = open.indexOf(":");
  const kind = open.slice(0, colon);
  const id = open.slice(colon + 1);
  return colon > 0 && id && isCardKind(kind) ? { kind, id } : null;
}

/** The day of the week of a date (YYYY-MM-DD): 0 for Monday to 6 for Sunday. */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}

/** The week `day` is in, Monday to Sunday, as the archive's weeks go. */
export function weekOf(day: string): string[] {
  const monday = addDays(day, -weekdayOf(day));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The days a week's columns show: the week, Monday to Sunday (a phone shows three at a time and scrolls along it). */
export function shownDays(day: string): string[] {
  return weekOf(day);
}

/** The week's number in its year by ISO 8601 (Monday first, week 1 the one with the year's first Thursday), for the month's week selectors. */
export function weekNumber(day: string): number {
  const thursday = addDays(weekOf(day)[0], 3);
  const [year, month, date] = thursday.split("-").map(Number);
  const ordinal = (Date.UTC(year, month - 1, date) - Date.UTC(year, 0, 1)) / 86_400_000;
  return Math.floor(ordinal / 7) + 1;
}

/** The first day of the month `day` is in. */
export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;

/** The days of the month `day` is in, its 1st to its last. */
export function monthOf(day: string): string[] {
  const [year, month] = day.split("-").map(Number);
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length }, (_, i) => addDays(monthStart(day), i));
}

/** The days a month's grid shows: whole weeks, Monday to Sunday, from the week of its 1st to the week of its last (four to six rows). */
export function monthGrid(day: string): string[] {
  const days = monthOf(day);
  const first = weekOf(days[0])[0];
  const last = weekOf(days[days.length - 1])[6];
  const grid: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) grid.push(d);
  return grid;
}

/** The day picked on the month `months` from `day`'s: today when that month is today's, else its 1st. */
export function stepMonth(day: string, months: number, today: string): string {
  const [year, month] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 10);
  return today.slice(0, 7) === first.slice(0, 7) ? today : first;
}

/**
 * A day of the month at a glance: its cards counted by kind (those that begin on it), its hangouts (for who was at them), how many messages,
 * and how many agent messages (the prompts he wrote).
 */
export interface DayGlance {
  day: string;
  counts: Record<CardKind, number>;
  hangouts: CalendarEvent[];
  messages: number;
  agentMessages: number;
}

/** Each of `days` (beginning at `begins`) at a glance: the cards that begin on it (one over a day's end counted on its first day, as the day lists it). */
export function glancesOf(
  events: readonly CalendarEvent[],
  days: readonly string[],
  begins: string,
  messages: Readonly<Record<string, number>>,
  agentMessages: Readonly<Record<string, number>> = {},
): DayGlance[] {
  const glances = days.map((day): DayGlance => ({ day, counts: { calls: 0, hangouts: 0, llm: 0, workouts: 0, habits: 0 }, hangouts: [], messages: messages[day] ?? 0, agentMessages: agentMessages[day] ?? 0 }));
  const byDay = new Map(glances.map((glance) => [glance.day, glance]));
  for (const event of events.toSorted((a, b) => a.at - b.at)) {
    const glance = byDay.get(cardDay(event, begins));
    if (!glance) continue;
    glance.counts[event.kind] += 1;
    if (event.kind === "hangouts") glance.hangouts.push(event);
  }
  return glances;
}

/** How strongly a day's messages tint its cell: 0 for none, else 1 to 4 by its share of the month's busiest day, a quarter a step. */
export function shadeOf(messages: number, busiest: number): number {
  if (messages <= 0 || busiest <= 0) return 0;
  return Math.max(1, Math.ceil((4 * Math.min(messages, busiest)) / busiest));
}

/**
 * A count on a day's line: its kind (for the icon and colour), how many, in words ("142 messages"), and its title, the
 * words and for hangouts who was at each ("2 hangouts: Ada Sample, Bruno Example · Cleo Demo").
 */
export interface DayCount {
  kind: CalendarKind;
  count: number;
  text: string;
  title: string;
}

/** "1 message", "12 messages": a count and its word. */
export const counted = (n: number, one: string, many: string) => `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`;

/** "142 messages", "1 call", "37 agent messages": a count of `kind` as a day's line and the year say it. */
export function countWords(kind: CalendarKind, n: number): string {
  if (kind === "messages") return counted(n, "message", "messages");
  if (kind === "llm") return counted(n, "agent message", "agent messages");
  const words = wordsOf(kind);
  return counted(n, words.one, words.many);
}

/** How a day's count of `kind` is said: its messages and agent messages, its cards of the other kinds. */
function countOf(glance: DayGlance, kind: CalendarKind): DayCount {
  const count = kind === "messages" ? glance.messages : kind === "llm" ? glance.agentMessages : glance.counts[kind];
  const text = countWords(kind, count);
  const who = kind === "hangouts" ? glance.hangouts.map((event) => event.title).join(" · ") : "";
  return { kind, count, text, title: who ? `${text}: ${who}` : text };
}

/**
 * A day's line: each of `of` that is on and that it has, in the bar's order (messages, calls, hangouts, agent
 * messages, workouts: "lets make hangouts into like a combined summary as well. just like the other events").
 */
export function dayCounts(glance: DayGlance, kinds: readonly CalendarKind[] = ALL_KINDS, of: readonly CalendarKind[] = ALL_KINDS): DayCount[] {
  return of.filter((kind) => kinds.includes(kind)).map((kind) => countOf(glance, kind)).filter((n) => n.count > 0);
}

const COMPACT = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

/** A count on a day's line, short from a thousand on so they fit a cell's width: "193", "1.2K" (its title says it whole). */
export function lineCount(n: number): string {
  return n >= 1000 ? COMPACT.format(n) : String(n);
}

/** "142 messages · 2 calls · 1 hangout · 37 agent messages": what a day holds, of the kinds on, for its cell's label. */
export function glanceText(glance: DayGlance, kinds: readonly CalendarKind[] = ALL_KINDS): string {
  const parts = dayCounts(glance, kinds).map((n) => n.text);
  return parts.length === 0 ? "Nothing" : parts.join(" · ");
}

const MONTH_YEAR = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, month: "long", year: "numeric" });
const MONTH_SHORT_YEAR = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, month: "short", year: "numeric" });
const DAY_MONTH = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: "numeric", month: "short" });
const WEEKDAY_SHORT = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: "short" });
const WEEKDAY_LONG = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: "long" });
const LONG_DATE = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** "October 2026" for days in one month; "Sep – Oct 2026" or "Dec 2026 – Jan 2027" across two. */
export function monthText(days: readonly string[]): string {
  const first = dayStart(days[0]);
  const last = dayStart(days[days.length - 1]);
  if (days[0].slice(0, 7) === days[days.length - 1].slice(0, 7)) return MONTH_YEAR.format(first);
  if (days[0].slice(0, 4) === days[days.length - 1].slice(0, 4)) return `${MONTH_SHORT_YEAR.format(first).split(" ")[0]} – ${MONTH_SHORT_YEAR.format(last)}`;
  return `${MONTH_SHORT_YEAR.format(first)} – ${MONTH_SHORT_YEAR.format(last)}`;
}

/** "20 – 26 Oct" within a month, "29 Sep – 5 Oct" across two. */
export function spanText(days: readonly string[]): string {
  const first = dayStart(days[0]);
  const last = dayStart(days[days.length - 1]);
  if (days[0].slice(0, 7) === days[days.length - 1].slice(0, 7)) return `${Number(days[0].slice(8))} – ${DAY_MONTH.format(last)}`;
  return `${DAY_MONTH.format(first)} – ${DAY_MONTH.format(last)}`;
}

/** The day of the month, 1 to 31. */
export const dayNumber = (day: string): number => Number(day.slice(8));

/** "Mon", or "Monday". */
export function weekdayText(day: string, long = false): string {
  return (long ? WEEKDAY_LONG : WEEKDAY_SHORT).format(dayStart(day));
}

/** "Monday 26 October 2026". */
export function longDateText(day: string): string {
  return LONG_DATE.format(dayStart(day)).replace(",", "");
}

/** "2:50 – 3:10 pm", "11:50 am – 12:10 pm", or "2:50 pm" alone for a point in time. */
export function rangeText(at: number, until: number): string {
  const from = timeText(at);
  if (until <= at) return from;
  const to = timeText(until);
  const half = (time: string) => time.slice(-2);
  return half(from) === half(to) ? `${from.slice(0, -3)} – ${to}` : `${from} – ${to}`;
}

const ZONE = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, timeZoneName: "short" });

/** The archive's zone at an instant, as the chip at the corner says it: "AEDT" in summer, "AEST" in winter. */
export function zoneText(ms: number): string {
  return ZONE.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value ?? TIME_ZONE;
}

/** A face's letters: the first letter of the first two words ("AS" for Ada Sample), or the first character of a name in one word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return [...words[0]][0].toUpperCase();
  return `${[...words[0]][0]}${[...words[1]][0]}`.toUpperCase();
}

/** A hue for a person's face, from their id, the same every time. */
export function hueOf(id: number): number {
  return (id * 137.508) % 360;
}

/** Someone on a day: in how many of its cards, and how many messages with them. */
export interface OnDay {
  id: number;
  cards: number;
  messages: number;
}

/** Everyone on a day, the most messages first, then the most cards: in its cards (`events`) or messaged (`messaged`). */
export function peopleOn(events: readonly CalendarEvent[], messaged: readonly Messaged[] = []): OnDay[] {
  const on = new Map<number, OnDay>();
  const of = (id: number) => on.get(id) ?? on.set(id, { id, cards: 0, messages: 0 }).get(id)!;
  for (const event of events) for (const id of event.people) of(id).cards += 1;
  for (const { id, count } of messaged) of(id).messages += count;
  return [...on.values()].sort((a, b) => b.messages - a.messages || b.cards - a.cards || a.id - b.id);
}

/** "12 messages · 1 call": what someone on a day is counted by. */
export function onDayText(who: OnDay, cardWord = "card"): string {
  const parts: string[] = [];
  if (who.messages > 0) parts.push(`${who.messages.toLocaleString(LOCALE)} ${who.messages === 1 ? "message" : "messages"}`);
  if (who.cards > 0) parts.push(`${who.cards} ${who.cards === 1 ? cardWord : `${cardWord}s`}`);
  return parts.join(" · ");
}

/** The cards on `day` (beginning at `begins`): those that begin on it, and the all-day ones. */
export function onDay(events: readonly CalendarEvent[], day: string, begins: string): CalendarEvent[] {
  return events.filter((event) => cardDay(event, begins) === day).sort((a, b) => a.at - b.at);
}

/** "37 agent messages", "1 agent message", "": the agent messages he sent on `day`, in words. */
export function agentsText(day: string, agentMessages: Readonly<Record<string, number>>): string {
  const messages = agentMessages[day] ?? 0;
  return messages === 0 ? "" : countWords("llm", messages);
}
