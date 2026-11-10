// The Calendar view (calendar.ts has its arithmetic): the archive's events of a day moment by moment, of a week as
// cards on a calendar, of a month at a glance or of a year shaded, under the console's Events aspect beside the table,
// in the design language of the reference the captain pointed at (a calendar dashboard: "take on this kind of
// design language"), in the console's tokens so it sits in both its looks. Across the top what is shown (the day, the
// month, the year), with Day, Week, Month and Year, Today, previous and next, and no line under it ("we don't need the
// subtitle"); under it a toggle a kind (messages, calls, hangouts, agents, workouts, rituals) to show or hide it in every
// view, and the person picked, if any, with × for everyone again. In every view each toggle on carries its kind's count
// over what the view shows (the day, the week, the month's own days, the year), the line under it in its title (the
// captain: "we can just combine the count. Into the filter chips"; they were a row of KPIs over the view). Each view
// uses the whole width: the day panel the week, the month and the year had beside them is gone, the day being its own view ("day should just become its own thing").
// Its days run from 06:00 to 06:00 (src/calendarDay.ts's EVENTS_DAY_BEGINS: "let's make today end at 6 a.m. every day"): every
// range it reads, every chart by day it asks for (begins=06:00), Today and each day's cards follow it.
// The day (?view=day, DayView.tsx; the phone's own, day.ts): the calendar's building block, its summaries in the chips and
// the day event by event under them (DayList.tsx); previous and next step a day. It reads the day's cards, whom he messaged, its
// messages and its agent messages.
// The week (WeekList.tsx: each day's events one by one as the day lists them, no hours; "Explore if weekly calendar could
// also look like day calendar with the events event by event layout", and, the calendar looking back, "we don't actually
// need the grid"): a day a column (its date over its weekday, today underlined; a
// day's head opens its day), a Messaged row of faces under the heads (whom he messaged each day, by his word never a
// card and never a time; a face narrows the week to them), an Agents row (each day's agent messages and sessions, a
// summary, never at a time: "show Hangouts and Calls as events in a day in their appropriate time as opposed to
// messages and agents where we're just showing a summary"), a Rituals row (each day's rituals, under Agents and
// out of the lanes ("let's put ritual items in its own row in the week view. Similar to messaged and agent. But we do
// want to retain exercise in the main time lanes"), a summary, done over asked, "5/5" (day.ts's ritualsSumOf; "I rather
// it just said five out of five ... in the week view, just show a summary"), that opens the day, which lists them),
// then each day's calls, hangouts and workouts one by one in its lane (WeekList.tsx). A click on a card opens its row's
// drawer (viewer/RowDrawer.tsx), as the table's does, with a link to the row in its own table on Events' Tables (its day, its drawer open). A row is edited in
// that drawer as in its table's, the same fields with the same editor (the captain: "The most ideal case is that I can edit events right here from the
// calendar"), and the span is read again after each edit, so its card shows it at once. The day adds a hangout or a call
// of the captain's own (+ Hangout, + Call: AddRow.tsx with the day's date, Friend Map's Calendar's Add event folded in
// here), and its People open that day's chat with someone, one at a time (DayPeople.tsx). The lists of people (the
// day's People, the week's Messaged) leave out whom friend map hides, until hidden=show. The week is read
// from the calendar (server/calendar/): the tabs' own routes (/life-archive/api/:kind/rows over the week, every page of
// each, the LLM tab's sessions alone) and the calendar's day summaries (/life-archive/api/calendar/days: how many
// messages each day, whom he messaged, how many messages he sent agents, and how each day's rituals went, done over
// asked, as rituals' own day summary says); the address
// carries the view, the day, the kinds, the person and the card open (calendar.ts's CalendarState). Keyboard: ← and →
// a day, week, month or year, ↑ and ↓ a moment on the day, T today, D, W, M and Y the views, Enter on a card opens it,
// Esc closes. On a phone the week's days stack, opening on the day picked.
// The month (?view=month): a day a cell, Monday first, whole weeks from the week of its 1st to the week of its last,
// each of its days tinted by how many messages it had (a quarter of the month's busiest a step; the calendar's day
// summaries, one answer for the month), and along its foot one line of counts, an icon and a number each: its
// messages, calls, hangouts (who was at each in the count's title), agent messages (the messages he sent to agents,
// every prompt he wrote, from the day summaries; "lets rename llm sessions to agent messages"), workouts and rituals; on a
// phone a dot for each kind it has. A day's cell opens its day; the week's number at a row's left opens its week.
// The year (?view=year, YearGrid.tsx; "The calendar view also needs a yearly view"): twelve small months, each day
// shaded by how much happened (year.ts's measure), over the year's totals; read as the charts by day of its calls,
// hangouts, workouts and rituals, one answer a kind, and the day summaries for its messages and agent messages (five
// requests a year). A month opens the month ("year where we can only select month"); its
// days show their counts on hovering, and open nothing.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { addDays, dayStart, LOCALE, zonePlace } from "../../../src/time.ts";
import { countText } from "../../format.ts";
import { RowDrawer } from "../../RowDrawer.tsx";
import { fetchCalendarDays, fetchRows, fetchVolume, kindsOnce } from "../../api.ts";
import { type DaySummary, type KindSpec, type RitualsDaySummary, type Row, type ViewLink } from "../../wire.ts";
import type { EditDone } from "../../editWire.ts";
import { linkAddress, rowAddress, TABLES_HOME } from "../EventsSection.tsx";
import { Icon } from "../icons.tsx";
import { isFutureDay, ritualsSumOf, spanTally, weekOf } from "./day.ts";
import { DayView } from "./DayView.tsx";
import { Face } from "./faces.tsx";
import { useNarrow } from "./narrow.ts";
import { AddRow } from "../../AddRow.tsx";
import { consolePath, openAddress } from "../address.ts";
import { planYear, stepYear, yearAsks, yearDays, yearMonths, yearTally, type YearCounts } from "./year.ts";
import { WeekList, type WeekRow } from "./WeekList.tsx";
import { YearGrid } from "./YearGrid.tsx";
import {
  agentsText, cardDay, calendarDayOf, EVENTS_DAY_BEGINS, calendarDayStart, ALL_KINDS, CALENDAR_KINDS, CALENDAR_MODES, CALENDAR_PATH, calendarAddress, CARD_KINDS, dayCounts, dayNumber, eventsOf, glancesOf, glanceText, hueOf, initials,
  isCardKind, kindFilters, kindsServed, lineCount, longDateText, monthGrid, monthStart, monthText, openOf, readCalendarState, shadeOf, shownDays, spanText, stepMonth, weekdayText, weekNumber,
  wordsOf, zoneText,
  type CalendarEvent, type CalendarKind, type CalendarMode, type CalendarState, type CallsShown, type CardKind, type Count, type DayGlance, type KindWords, type Messaged, type Tally,
} from "./calendar.ts";
import "./calendar.css";

/** Nobody: the hidden while the span is read. */
const NOBODY: ReadonlySet<number> = new Set();

/** The Friend Map aspect's address in the console (modules/friend-map/viewer.tsx's FRIEND_MAP_ASPECT). */
const FRIEND_MAP_ADDRESS = consolePath("friend-map");

/** The most pages of a tab's rows one day, week or month reads; one with more says so in the bar. */
export const MOST_PAGES = 8;
const PAGE = 500;

/**
 * A day, a week or a month as read: its range, its cards, whom he messaged each day (a day's or a week's) and over it
 * all (the month's own days alone), how many messages and agent messages each day had, the names of everyone in them,
 * and the tabs cut short.
 */
interface Span {
  mode: CalendarMode;
  from: number;
  to: number;
  /** Which calls it was read with (state.calls). */
  calls: CallsShown;
  events: CalendarEvent[];
  messaged: Record<string, Messaged[]>;
  /** Whom he messaged over the days the chips count: the day, the week, or the month's own days. */
  messagedOver: Messaged[];
  messages: Record<string, number>;
  agentMessages: Record<string, number>;
  people: Record<number, string>;
  /** Who friend map hides of everyone on the days, whom the lists of people leave out unless shown (state.showHidden). */
  hidden: ReadonlySet<number>;
  cut: CardKind[];
  /** A week's days as rituals' day summaries in the calendar say them, by date (its Rituals row's sums; a day the calendar has none of null), or null for a day or a month. */
  rituals: Record<string, RitualsDaySummary | null> | null;
}

/** The calendar's day summaries over the days [from, to) (/life-archive/api/calendar/days), by day, with the names of everyone they name and who of everyone on them is hidden. */
async function loadDays(from: string, to: string, person: number | null, signal: AbortSignal): Promise<{ days: Record<string, DaySummary>; people: Record<number, string>; hidden: number[] }> {
  const answer = await fetchCalendarDays(from, to, person, signal);
  return { days: Object.fromEntries(answer.days.map((day) => [day.day, day])), people: answer.people, hidden: answer.hidden };
}

/** A tab's rows over [from, to), page after page, oldest first. */
async function loadKind(kind: CardKind, from: number, to: number, calls: CallsShown, signal: AbortSignal): Promise<{ rows: Row[]; people: Record<number, string>; cut: boolean }> {
  const filters = kindFilters(kind, from, to, calls);
  const rows: Row[] = [];
  const people: Record<number, string> = {};
  let after: string | null = null;
  let offset = 0;
  for (let page = 0; ; page++) {
    const answer = await fetchRows(kind, filters, { offset, limit: PAGE, sort: "when", direction: "asc", after }, signal);
    rows.push(...answer.rows);
    Object.assign(people, answer.people);
    offset += answer.rows.length;
    if (answer.rows.length < PAGE || offset >= answer.total) return { rows, people, cut: false };
    if (page + 1 >= MOST_PAGES) return { rows, people, cut: true };
    after = answer.next;
  }
}

/** Whom he messaged over several days' lists, a person once, their messages added up, the most first. */
function messagedOver(lists: readonly (readonly Messaged[])[]): Messaged[] {
  const counts = new Map<number, number>();
  for (const list of lists) for (const who of list) counts.set(who.id, (counts.get(who.id) ?? 0) + who.count);
  return [...counts].map(([id, count]) => ({ id, count })).toSorted((a, b) => b.count - a.count || a.id - b.id);
}

/**
 * The year `year` (YYYY) counted by the day, of each kind yearAsks asks for, with the person picked: the cards' kinds
 * one chart each, the messages and the agent messages from the calendar's day summaries (a day with nothing left out).
 */
async function loadYear(year: string, person: number | null, calls: CallsShown, cards: readonly CardKind[], signal: AbortSignal): Promise<YearCounts> {
  const first = `${year}-01-01`;
  const next = `${Number(year) + 1}-01-01`;
  const asks = yearAsks(calendarDayStart(first), calendarDayStart(next), person, calls).filter((ask) => (cards as readonly string[]).includes(ask.kind));
  const [answers, summaries] = await Promise.all([
    Promise.all(asks.map((ask) => fetchVolume(ask.tab, ask.filters, "day", ask.measure, null, signal, EVENTS_DAY_BEGINS))),
    loadDays(first, next, person, signal),
  ]);
  const counts: YearCounts = Object.fromEntries(asks.map((ask, i) => [ask.kind, Object.fromEntries(answers[i].buckets.map((bucket) => [bucket.day, bucket.value]))]));
  const days = Object.values(summaries.days);
  counts.messages = Object.fromEntries(days.map((day) => [day.day, day.messages]));
  if (person === null) counts.llm = Object.fromEntries(days.map((day) => [day.day, day.agentMessages]));
  return counts;
}

/**
 * The days' cards, and the calendar's day summaries over them: whom he messaged each day (and over the days counted:
 * the day, the week, or the month's own days), how many messages each day (with the person picked, those with them),
 * how many agent messages each day (none while a person is picked: nobody is in them, as nobody is in a session), and
 * a week's days as rituals' day summaries say them (none while a person is picked, when its Rituals row is hidden).
 * The cards are of the kinds `cards`, those the server has a tab for.
 */
async function loadSpan(mode: CalendarMode, days: readonly string[], counted: readonly string[], from: number, to: number, person: number | null, calls: CallsShown, cards: readonly CardKind[], signal: AbortSignal): Promise<Span> {
  const last = addDays(days[days.length - 1], 1);
  const [got, all, mine] = await Promise.all([
    // A hangout or ritual with no time is kept at its date's midnight, before its day's 06:00: read from the first date's midnight.
    Promise.all(cards.map((kind) => loadKind(kind, kind === "hangouts" || kind === "habits" ? dayStart(days[0]) : from, to, calls, signal))),
    loadDays(days[0], last, null, signal),
    person === null ? Promise.resolve(null) : loadDays(days[0], last, person, signal),
  ]);
  const people = Object.assign({}, ...got.map((answer) => answer.people), all.people) as Record<number, string>;
  const of = (day: string): DaySummary | undefined => all.days[day];
  return {
    mode,
    from,
    to,
    calls,
    people,
    hidden: new Set(all.hidden),
    // Only the cards on the days read: not a hangout of the small hours before the first, which is the day before's.
    events: cards.flatMap((kind, i) => eventsOf(kind, got[i].rows, people)).filter((event) => days.includes(cardDay(event, EVENTS_DAY_BEGINS))),
    messaged: Object.fromEntries(days.map((day) => [day, of(day)?.messaged ?? []])),
    messagedOver: messagedOver(counted.map((day) => of(day)?.messaged ?? [])),
    messages: Object.fromEntries(days.map((day) => [day, (mine ?? all).days[day]?.messages ?? 0])),
    agentMessages: person === null ? Object.fromEntries(days.map((day) => [day, of(day)?.agentMessages ?? 0])) : {},
    cut: cards.filter((_, i) => got[i].cut),
    rituals: mode === "week" && person === null ? Object.fromEntries(days.map((day) => [day, of(day)?.rituals ?? null])) : null,
  };
}

export function CalendarView() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  const today = calendarDayOf(now);
  const narrow = useNarrow();
  // An address that names no view opens the screen's own: the week, or on a phone the day.
  const fallback: CalendarMode = narrow ? "day" : "week";
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  // The view shown is the address's; each change is a new address, so back and forward step through them.
  const [state, setStateRaw] = useState<CalendarState>(() => readCalendarState(location.search, calendarDayOf(Date.now()), fallback));
  const setState = useCallback((next: CalendarState, replace = false) => {
    const address = calendarAddress(next, CALENDAR_PATH, calendarDayOf(Date.now()), fallbackRef.current);
    if (address !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", address);
    setStateRaw(next);
  }, []);
  useEffect(() => {
    const back = () => setStateRaw(readCalendarState(location.search, calendarDayOf(Date.now()), fallbackRef.current));
    addEventListener("popstate", back);
    // The address it opened at, written as the view writes it.
    setState(readCalendarState(location.search, calendarDayOf(Date.now()), fallbackRef.current), true);
    return () => removeEventListener("popstate", back);
  }, [setState]);

  const mode = state.mode;
  // The days read as cards: the day alone, the week's, or the month's grid (the year reads its charts alone).
  const days = useMemo(() => (mode === "month" ? monthGrid(state.day) : mode === "day" || mode === "year" ? [state.day] : shownDays(state.day)), [mode, state.day]);
  const from = calendarDayStart(days[0]);
  const to = calendarDayStart(addDays(days[days.length - 1], 1));
  // The days the chips count: the day, the week, or the month's own days (not the grid's days of the months beside it).
  const counted = useMemo(() => (mode === "month" ? days.filter((day) => day.startsWith(state.day.slice(0, 7))) : days), [mode, days, state.day]);
  // The messages are counted with the person picked, so they are read again for another.
  const countedFor = state.person;

  // Kept by its value, so the address read again (Back) does not read the span again for the same calls.
  const calls = useMemo(() => ({ unknown: state.calls.unknown, missed: state.calls.missed }), [state.calls.unknown, state.calls.missed]);
  const [span, setSpan] = useState<Span | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The server's tabs, asked for at once: the kinds the calendar shows are those with a tab (a module's tab goes with
  // its module: no Workouts chip, and no workouts asked for, with exercise off), and the drawer's columns and filters.
  const [specs, setSpecs] = useState<KindSpec[] | null>(null);
  useEffect(() => {
    kindsOnce().then(setSpecs, (e: Error) => setError(e.message));
  }, []);
  const served = useMemo(() => (specs ? kindsServed(specs.map((k) => k.kind)) : null), [specs]);
  const cards = useMemo(() => (served ?? []).filter(isCardKind), [served]);
  /** The kinds on, of those served: the address may name one the server has no tab for. */
  const kindsOn = useMemo(() => state.kinds.filter((kind) => served === null || served.includes(kind)), [state.kinds, served]);

  /** Bumped by an edit made in a card's drawer, so the span is read again and the card shows it. */
  const [edits, setEdits] = useState(0);
  useEffect(() => {
    if (mode === "year" || served === null) return;
    const abort = new AbortController();
    setError(null);
    loadSpan(mode, days, counted, from, to, countedFor, calls, cards, abort.signal).then(
      (got) => {
        if (!abort.signal.aborted) setSpan(got);
      },
      (e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      },
    );
    return () => abort.abort();
  }, [mode, days, counted, from, to, countedFor, calls, served, cards, edits]);
  const loading = span === null || span.mode !== mode || span.from !== from || span.to !== to || span.calls !== calls;

  // The year: each kind's count by day, read again for another year or person.
  const year = mode === "year" ? state.day.slice(0, 4) : null;
  const [yearRead, setYearRead] = useState<{ year: string; person: number | null; calls: CallsShown; counts: YearCounts } | null>(null);
  useEffect(() => {
    if (year === null || served === null) return;
    const abort = new AbortController();
    const person = state.person;
    setError(null);
    loadYear(year, person, calls, cards, abort.signal).then(
      (counts) => {
        if (!abort.signal.aborted) setYearRead({ year, person, calls, counts });
      },
      (e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      },
    );
    return () => abort.abort();
  }, [year, state.person, calls, served, cards]);
  const yearLoading = yearRead === null || yearRead.year !== year || yearRead.person !== state.person || yearRead.calls !== calls;
  const yearPlan = useMemo(() => (year !== null && yearRead !== null ? planYear(yearRead.counts, yearDays(`${yearRead.year}-01-01`), kindsOn) : null), [year, yearRead, kindsOn]);
  const people = span?.people ?? {};

  /** The cards on the grid: of the kinds on, with the person picked. */
  const shown = useMemo(
    () => (loading ? [] : span!.events.filter((event) => kindsOn.includes(event.kind) && (state.person === null || event.people.includes(state.person)))),
    [span, loading, kindsOn, state.person],
  );
  /** The week's calls, hangouts and workouts, each day's one by one in its lane; its rituals and agents are rows over the lanes. */
  const week = useMemo(() => (mode === "week" ? weekOf(shown, days, EVENTS_DAY_BEGINS) : null), [mode, shown, days]);
  /** Whom he messaged each day, as shown: the person picked alone while one is, and the hidden only while they are shown. */
  const messagedOn = (day: string): Messaged[] =>
    (loading ? [] : (span!.messaged[day] ?? [])).filter((who) => (state.person === null || who.id === state.person) && (state.showHidden || !span!.hidden.has(who.id)));

  const go = (day: string) => setState({ ...state, day, open: null });
  const step = (by: number) =>
    go(
      mode === "year"
        ? stepYear(state.day, by, calendarDayOf(Date.now()))
        : mode === "month"
          ? stepMonth(state.day, by, calendarDayOf(Date.now()))
          : addDays(state.day, mode === "week" ? 7 * by : by),
    );
  const toToday = () => go(calendarDayOf(Date.now()));
  const toMode = (next: CalendarMode) => next !== mode && setState({ ...state, mode: next, open: null });
  /** A day on the week or the month: its own view. */
  const openDay = (day: string) => setState({ ...state, mode: "day", day, open: null });
  /** A week's selector on the month: its week, the day picked kept when it is in it, else its Monday. */
  const openWeek = (monday: string) => setState({ ...state, mode: "week", day: shownDays(monday).includes(state.day) ? state.day : monday, open: null });
  /** A month on the year: the month, today picked in today's month, else its 1st. */
  const openMonth = (first: string) => setState({ ...state, mode: "month", day: stepMonth(first, 0, calendarDayOf(Date.now())), open: null });
  const toggleKind = (kind: CalendarKind) => {
    const next = state.kinds.includes(kind) ? state.kinds.filter((k) => k !== kind) : ALL_KINDS.filter((k) => k === kind || state.kinds.includes(k));
    if (next.length > 0) setState({ ...state, kinds: next });
  };
  const [callsMenu, setCallsMenu] = useState(false);
  const setCalls = (shown: CallsShown) => setState({ ...state, calls: shown, open: null });
  const pickPerson = (person: number | null) => setState({ ...state, person, open: null });
  const open = (event: CalendarEvent) => setState({ ...state, open: `${event.row.kind}:${event.row.id}` });
  const close = useCallback(() => setStateRaw((was) => (was.open === null ? was : (setState({ ...was, open: null }), { ...was, open: null }))), [setState]);
  const setShowHidden = (show: boolean) => setState({ ...state, showHidden: show });
  /** Someone's panel in Friend Map (its frame opens at ?person=, modules/friend-map/viewer/FriendMapView.tsx). */
  const toFriendMap = (person: number) => openAddress(`${FRIEND_MAP_ADDRESS}?${new URLSearchParams({ person: String(person) })}`);

  // Add on the day: the tables whose rows are partly the captain's own (hangouts, calls; KindSpec's `own`), in the
  // drawer's place (AddRow.tsx), the day's date filled in; once added, the day is read again with the new card open.
  const [adding, setAdding] = useState<KindSpec | null>(null);
  const adds = useMemo(() => (specs ?? []).filter((spec) => spec.own && (cards as readonly string[]).includes(spec.kind)), [specs, cards]);
  useEffect(() => setAdding(null), [state.day, mode]);
  const startAdd = (spec: KindSpec) => {
    setAdding(spec);
    if (state.open !== null) setState({ ...state, open: null });
  };
  const added = (done: EditDone) => {
    const kind = adding?.kind;
    setAdding(null);
    setEdits((n) => n + 1);
    if (kind && done.id !== "") setState({ ...state, open: `${kind}:${done.id}` });
  };

  // The keys, wherever the focus is on the page (switching the view drops it on the page): not in a field, the rail or a dialog.
  const stepMomentRef = useRef<((by: number) => void) | null>(null);
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || state.open !== null || adding !== null || target.closest?.("input, textarea, select, [contenteditable], nav, [role=dialog]")) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === "ArrowLeft") step(-1);
    else if (key === "ArrowRight") step(1);
    else if (mode === "day" && (key === "ArrowUp" || key === "k")) stepMomentRef.current?.(-1);
    else if (mode === "day" && (key === "ArrowDown" || key === "j")) stepMomentRef.current?.(1);
    else if (key === "t") toToday();
    else if (key === "d") toMode("day");
    else if (key === "w") toMode("week");
    else if (key === "m") toMode("month");
    else if (key === "y") toMode("year");
    else return;
    event.preventDefault();
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const listen = (event: KeyboardEvent) => onKeyRef.current(event);
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, []);

  // The drawer: its tab's columns and filters, from the server's tabs.
  const opened = state.open === null ? null : openOf(state.open);
  const openedSpec = opened && specs ? specs.find((k) => k.kind === opened.kind) : undefined;
  const leaveTo = (link: ViewLink) => {
    const address = specs ? linkAddress(specs, link) : null;
    if (address) TABLES_HOME.leave(address);
  };

  const month = state.day.slice(0, 7);
  const glances = useMemo(() => (mode === "month" && !loading ? glancesOf(shown, days, EVENTS_DAY_BEGINS, span!.messages, span!.agentMessages) : []), [mode, loading, shown, days, span]);
  const messagesOn = kindsOn.includes("messages");
  // The week's Agents row: while agents are on and nobody is picked (nobody is in a session).
  const agentsRow = mode === "week" && kindsOn.includes("llm") && state.person === null;
  // The week's Rituals row: while rituals are on and nobody is picked (nobody is in a ritual).
  const ritualsRow = mode === "week" && kindsOn.includes("habits") && state.person === null;
  const cut = span && !loading && span.cut.length > 0 ? `${span.cut.map((kind) => wordsOf(kind).label).join(", ")} cut at ${countText(MOST_PAGES * PAGE)} rows` : "";
  const nowDay = calendarDayOf(now);
  const unit = mode;
  const openKey = opened ? `${opened.kind}:${opened.id}` : null;
  // The chips' counts, over the days counted (the day, the week, the month's own days) or the year: the messages the
  // person picked's alone while one is, the agent messages none then (nobody is in a session); "…" while they are read.
  const tallyLoading = mode === "year" ? yearLoading || !yearPlan : loading;
  const sumOver = (byDay: Record<string, number>) => counted.reduce((sum, day) => sum + (byDay[day] ?? 0), 0);
  const tally: Tally | null = tallyLoading
    ? null
    : mode === "year"
      ? yearTally(yearPlan!)
      : spanTally(
          {
            events: shown.filter((event) => counted.includes(cardDay(event, EVENTS_DAY_BEGINS))),
            messages: sumOver(span!.messages),
            agentMessages: state.person === null ? sumOver(span!.agentMessages) : 0,
            messaged: span!.messagedOver.filter((who) => state.person === null || who.id === state.person),
          },
          kindsOn,
          counted.length > 1 ? EVENTS_DAY_BEGINS : null,
        );
  const countOf = (kind: CalendarKind): Count | "loading" | null => (!kindsOn.includes(kind) ? null : tally === null ? "loading" : (tally[kind] ?? null));

  // The week's heads and summary rows, the same over its hours and its lists: the zone at the corner, a day's head
  // opening its day, whom he messaged each day, and the agents each day.
  const corner = (
    <div className="cal-corner">
      <span className="cal-zone" title={`${zonePlace()}'s clock`}>{zoneText(now)}</span>
    </div>
  );
  const dayHead = (day: string, i: number) => (
    <div key={day} className={`cal-dayhead${day === nowDay ? " is-today" : ""}${day === state.day ? " is-picked" : ""}${i === days.length - 1 ? " is-last" : ""}`}>
      <button type="button" className="cal-day" onClick={() => openDay(day)} aria-label={`${longDateText(day)}: open the day`} title="Open the day">
        <span className="cal-day__num">{dayNumber(day)}</span>
        <span className="cal-day__name">{weekdayText(day)}</span>
      </button>
    </div>
  );
  const weekRows: WeekRow[] = [];
  if (messagesOn)
    weekRows.push({
      key: "messaged",
      label: (
        <div className="cal-messaged-label" title="Whom you messaged each day">
          <span className="cal-label--long">Messaged</span>
          <span className="cal-label--short" aria-hidden="true">Msgs</span>
        </div>
      ),
      cell: (day, i) => (
        <div key={day} className={`cal-messaged${i === days.length - 1 ? " is-last" : ""}`}>
          <MessagedFaces messaged={messagedOn(day)} people={people} person={state.person} onPerson={pickPerson} />
        </div>
      ),
    });
  if (agentsRow)
    weekRows.push({
      key: "agents",
      label: (
        <div className="cal-agents-label" title="The messages you sent agents each day">
          Agents
        </div>
      ),
      cell: (day, i) => {
        const words = loading ? "" : agentsText(day, span!.agentMessages);
        return (
          <div key={day} className={`cal-agents${i === days.length - 1 ? " is-last" : ""}`}>
            {words && (
              <button type="button" className="cal-agents__sum cal-card--llm" title={`${words}: open the day`} aria-label={`${longDateText(day)}: ${words}. Open the day.`} onClick={() => openDay(day)}>
                <Icon name="llm" />
                <span>{words}</span>
              </button>
            )}
          </div>
        );
      },
    });
  if (ritualsRow)
    weekRows.push({
      key: "rituals",
      label: (
        <div className="cal-rituals-label" title="The rituals you did each day, over those the day asked for">
          Rituals
        </div>
      ),
      cell: (day, i) => {
        const sum = loading ? null : ritualsSumOf(span!.rituals?.[day] ?? null, (week?.rituals[day] ?? []).map((item) => item.event));
        return (
          <div key={day} className={`cal-rituals${i === days.length - 1 ? " is-last" : ""}`}>
            {sum && (
              <button
                type="button"
                className={`cal-rituals__sum cal-card--habits${sum.expected !== null && sum.done === sum.expected ? " is-all" : ""}`}
                title={`${sum.title}. Open the day`}
                aria-label={`${longDateText(day)}: ${sum.title}. Open the day.`}
                onClick={() => openDay(day)}
              >
                <Icon name={wordsOf("habits").icon} />
                <span>{sum.text}</span>
              </button>
            )}
          </div>
        );
      },
    });
  return (
    <div className={`cal cal--${mode}${messagesOn ? "" : " cal--no-messaged"}${agentsRow ? "" : " cal--no-agents"}`}>
      <header className="cal__bar">
        <div className="cal__nav">
          <div className="cal__modes" role="group" aria-label="Day, week, month or year">
            {CALENDAR_MODES.map((m) => (
              <button key={m} type="button" className={mode === m ? "is-on" : ""} aria-pressed={mode === m} title={`The ${m} (${m[0].toUpperCase()})`} onClick={() => toMode(m)}>
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="cal__today" onClick={toToday} disabled={state.day === today}>
            Today
          </button>
          <button type="button" aria-label={`Previous ${unit}`} title={`Previous ${unit} (←)`} onClick={() => step(-1)}>
            <Icon name="prev" />
          </button>
          <button type="button" aria-label={`Next ${unit}`} title={`Next ${unit} (→)`} onClick={() => step(1)}>
            <Icon name="next" />
          </button>
        </div>
        <div className="cal__title">
          <h2>{mode === "year" ? state.day.slice(0, 4) : mode === "day" ? longDateText(state.day) : monthText(mode === "month" ? [monthStart(state.day)] : days)}</h2>
          {cut && (
            <span className="cal__span" role="status">
              {cut}
            </span>
          )}
        </div>
      </header>
      <div className="cal__filters">
        <div className="cal__kinds" role="group" aria-label="What is shown">
          {CALENDAR_KINDS.filter((words) => served !== null && served.includes(words.kind)).map((words) => {
            const on = kindsOn.includes(words.kind);
            if (words.kind === "calls")
              return (
                <CallsKind
                  key={words.kind}
                  words={words}
                  on={on}
                  calls={calls}
                  menu={callsMenu}
                  count={countOf(words.kind)}
                  onToggle={() => toggleKind(words.kind)}
                  onMenu={setCallsMenu}
                  onCalls={setCalls}
                />
              );
            const tallied = countOf(words.kind);
            return (
              <button
                key={words.kind}
                type="button"
                className={`cal-kind cal-card--${words.kind}${on ? " is-on" : ""}`}
                aria-pressed={on}
                aria-label={kindLabel(words, tallied)}
                title={kindTitle(words, on, tallied)}
                onClick={() => toggleKind(words.kind)}
              >
                <Icon name={words.icon} />
                <span className="cal-kind__name">{words.label}</span>
                <KindCount count={tallied} />
              </button>
            );
          })}
        </div>
        {state.person !== null && (
          <button type="button" className="cal-chip" onClick={() => pickPerson(null)} title="Everyone again">
            <Face id={state.person} name={people[state.person] ?? `Person ${state.person}`} />
            <span>Only {people[state.person] ?? `person ${state.person}`}</span>
            <Icon name="close" />
          </button>
        )}
      </div>
      {error && (
        <p className="viewer__error cal__error" role="alert">
          The archive is unavailable: {error}
        </p>
      )}
      <div className="cal__body">
        {mode === "day" ? (
          <DayView
            key={state.day}
            day={state.day}
            from={from}
            isToday={state.day === nowDay}
            isFuture={isFutureDay(state.day, nowDay)}
            now={now}
            events={loading ? [] : span!.events}
            messaged={loading ? [] : (span!.messaged[state.day] ?? [])}
            people={people}
            hidden={loading ? NOBODY : span!.hidden}
            showHidden={state.showHidden}
            kinds={kindsOn}
            person={state.person}
            loading={loading}
            openKey={openKey}
            adds={adds}
            onPerson={pickPerson}
            onShowHidden={setShowHidden}
            onFriendMap={toFriendMap}
            onOpen={open}
            onAdd={startAdd}
            stepRef={stepMomentRef}
          />
        ) : mode === "year" ? (
          <YearGrid months={yearMonths(state.day)} plan={yearPlan} today={nowDay} loading={yearLoading} onMonth={openMonth} />
        ) : mode === "month" ? (
          <MonthGrid days={days} month={month} today={nowDay} picked={state.day} glances={glances} kinds={kindsOn} loading={loading} onDay={openDay} onWeek={openWeek} />
        ) : (
          <WeekList
            week={week?.lanes ?? []}
            now={now}
            nowDay={nowDay}
            picked={state.day}
            openKey={openKey}
            loading={loading}
            label="The week's calendar"
            corner={corner}
            head={dayHead}
            rows={weekRows}
            scrollKey={from}
            onOpen={open}
          />
        )}
      </div>
      {adding && <AddRow key={`${adding.kind}:${state.day}`} spec={adding} day={state.day} onClose={() => setAdding(null)} onAdded={added} />}
      {!adding && opened && openedSpec && (
        <RowDrawer
          spec={openedSpec}
          id={opened.id}
          onClose={close}
          onNarrow={(filter, value) => filter === "person" && pickPerson(Number(value))}
          onView={leaveTo}
          canView={(link) => specs !== null && linkAddress(specs, link) !== null}
          onTable={(row) => TABLES_HOME.leave(rowAddress(openedSpec, row))}
          onEdited={() => setEdits((n) => n + 1)}
        />
      )}
    </div>
  );
}

/** "Calls: 1, 47 min in all": a toggle's count with the line under it, as its title and its label say it. */
function countLine(count: Count): string {
  const note = count.note.trim();
  return `${count.label}: ${count.value}${note ? `, ${note[0].toLowerCase()}${note.slice(1)}` : ""}`;
}

/** What a toggle says to a screen reader: what it shows, and its count. */
const kindLabel = (words: KindWords, count: Count | "loading" | null) => `Show ${words.label.toLowerCase()}${count && count !== "loading" ? ` (${countLine(count)})` : ""}`;

/** A toggle's title: what a click does, and its count with the line under it. */
const kindTitle = (words: KindWords, on: boolean, count: Count | "loading" | null) =>
  `${on ? "Hide" : "Show"} ${words.label.toLowerCase()}${count && count !== "loading" ? ` · ${countLine(count)}` : ""}`;

/** A toggle's count, after its name: "…" while it is read. */
function KindCount({ count }: { count: Count | "loading" | null }) {
  if (count === null) return null;
  return <span className="cal-kind__count">{count === "loading" ? "…" : count.value}</span>;
}

/**
 * The Calls toggle, split: its name toggles calls as every kind's does, and its caret alone opens a menu of two choices,
 * each off at first and each apart from the other: Unknown calls (calls with nobody the archive has a name for: a bare
 * number) and Missed calls (never answered); the chip itself never shows which are on, only the menu does (the captain:
 * "when we change inner filters it It's invisible to the outer filter chip") (the captain: "when I click on specifically the drop down icon, I get to select if I want
 * deselect unknown calls and then it will not show me any unknown calls like calls without a name associated to it").
 */
function CallsKind({ words, on, calls, menu, count, onToggle, onMenu, onCalls }: {
  words: KindWords;
  on: boolean;
  calls: CallsShown;
  menu: boolean;
  count: Count | "loading" | null;
  onToggle: () => void;
  onMenu: (open: boolean) => void;
  onCalls: (shown: CallsShown) => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onMenu(false);
      }
    };
    addEventListener("pointerdown", away);
    addEventListener("keydown", escape, true);
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", escape, true);
    };
  }, [menu, onMenu]);
  return (
    <span ref={box} className={`cal-kind cal-kind--split cal-card--${words.kind}${on ? " is-on" : ""}`}>
      <button
        type="button"
        className="cal-kind__main"
        aria-pressed={on}
        aria-label={kindLabel(words, count)}
        title={kindTitle(words, on, count)}
        onClick={onToggle}
      >
        <Icon name={words.icon} />
        <span className="cal-kind__name">{words.label}</span>
        <KindCount count={count} />
      </button>
      <button
        type="button"
        className="cal-kind__caret"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="Which calls"
        title="Which calls"
        onClick={() => onMenu(!menu)}
      >
        <Icon name="chevron" />
      </button>
      {menu && (
        <span className="cal-kind__menu" role="menu">
          <button type="button" role="menuitemcheckbox" aria-checked={calls.unknown} onClick={() => onCalls({ ...calls, unknown: !calls.unknown })}>
            <span className="cal-kind__check">{calls.unknown && <Icon name="check" />}</span>
            Unknown calls
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={calls.missed} onClick={() => onCalls({ ...calls, missed: !calls.missed })}>
            <span className="cal-kind__check">{calls.missed && <Icon name="check" />}</span>
            Missed calls
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * The month at a glance: the weekdays' names, then a week a row, its number at the left opening the week, and a day a
 * cell, a day of another month dimmed; each its date (today underlined, the day picked in the accent), its messages as
 * a tint, and at its foot one line of its messages, calls, hangouts, agent messages and workouts, an icon and a count
 * each (who was at the hangouts in its title); on a phone a dot a kind. Of the kinds on alone. A cell opens its day.
 */
function MonthGrid({
  days, month, today, picked, glances, kinds, loading, onDay, onWeek,
}: {
  days: readonly string[];
  month: string;
  today: string;
  picked: string;
  glances: readonly DayGlance[];
  kinds: readonly CalendarKind[];
  loading: boolean;
  onDay: (day: string) => void;
  onWeek: (monday: string) => void;
}) {
  const byDay = new Map(glances.map((glance) => [glance.day, glance]));
  const messagesOn = kinds.includes("messages");
  const busiest = Math.max(0, ...glances.filter((glance) => glance.day.startsWith(month)).map((glance) => glance.messages));
  return (
    <div className="cal-month-box">
      <div className="cal-month" role="region" aria-label="The month's calendar" aria-busy={loading} style={{ gridTemplateRows: `auto repeat(${days.length / 7}, minmax(var(--cal-mrow), 1fr))` }}>
        <div className="cal-month__heads" aria-hidden="true">
          <div className="cal-month__head cal-month__head--wk">Wk</div>
          {days.slice(0, 7).map((day) => (
            <div key={day} className="cal-month__head">
              {weekdayText(day)}
            </div>
          ))}
        </div>
        {Array.from({ length: days.length / 7 }, (_, row) => {
          const week = days.slice(row * 7, row * 7 + 7);
          const n = weekNumber(week[0]);
          return (
            <div key={row} className={`cal-month__week${week.includes(today) ? " is-now" : ""}`}>
              <button type="button" className="cal-mweek" aria-label={`Week ${n}, ${spanText(week)}: open the week`} title={`Open the week of ${spanText(week)}`} onClick={() => onWeek(week[0])}>
                <span className="cal-mweek__num">{n}</span>
                <Icon name="next" />
              </button>
              {week.map((day) => {
                const glance = byDay.get(day);
                const out = !day.startsWith(month);
                const shade = messagesOn && glance && !out ? shadeOf(glance.messages, busiest) : 0;
                const label = `${longDateText(day)}: ${loading ? "loading" : glance ? glanceText(glance, kinds) : isFutureDay(day, today) ? "still to come" : "Nothing"}. Open the day.`;
                return (
                  <button
                    key={day}
                    type="button"
                    className={`cal-mday${out ? " is-out" : ""}${day === today ? " is-today" : ""}${day === picked ? " is-picked" : ""}`}
                    data-day={day}
                    data-shade={shade}
                    aria-label={label}
                    title={label}
                    onClick={() => onDay(day)}
                  >
                    <span className="cal-mday__head">
                      <span className="cal-mday__num">{dayNumber(day)}</span>
                    </span>
                    {glance && (
                      <>
                        <span className="cal-mday__chips">
                          {dayCounts(glance, kinds).map((n) => (
                            <span key={n.kind} className={`cal-mchip cal-card--${n.kind}`} title={n.title}>
                              <Icon name={wordsOf(n.kind).icon} />
                              {lineCount(n.count)}
                            </span>
                          ))}
                        </span>
                        <span className="cal-mday__dots" aria-hidden="true">
                          {dayCounts(glance, kinds, CARD_KINDS).map((n) => <i key={n.kind} className={`cal-mdot cal-mdot--${n.kind}`} />)}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Whom he messaged on a day, a face each, the most messages first, the first few and how many more; a face narrows the week to them. */
function MessagedFaces({ messaged, people, person, onPerson, most = 5 }: { messaged: readonly Messaged[]; people: Record<number, string>; person: number | null; onPerson: (person: number | null) => void; most?: number }) {
  const shown = messaged.slice(0, most);
  const more = messaged.length - shown.length;
  if (messaged.length === 0) return null;
  return (
    <span className="cal-faces" role="list" aria-label="Whom you messaged">
      {shown.map((who) => {
        const name = people[who.id] ?? `Person ${who.id}`;
        return (
          <button
            key={who.id}
            type="button"
            role="listitem"
            className={`cal-face${person === who.id ? " is-on" : ""}`}
            style={{ "--face-h": hueOf(who.id) } as CSSProperties}
            title={`${name} · ${who.count.toLocaleString(LOCALE)} ${who.count === 1 ? "message" : "messages"}`}
            aria-label={`${name}, ${who.count} ${who.count === 1 ? "message" : "messages"}`}
            aria-pressed={person === who.id}
            onClick={() => onPerson(person === who.id ? null : who.id)}
          >
            {initials(name)}
          </button>
        );
      })}
      {more > 0 && (
        <i className="cal-face cal-face--more" title={messaged.slice(most).map((who) => people[who.id] ?? `Person ${who.id}`).join(", ")}>
          +{more}
        </i>
      )}
    </span>
  );
}
