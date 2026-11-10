import { describe, expect, it } from "vitest";
import { dayStart, MIDNIGHT, wallClock } from "../../../src/time.ts";
import type { Row } from "../../wire.ts";
import {
  ALL_CALLS, DEFAULT_CALLS,
  agentsText, ALL_KINDS, calendarDayOf, calendarDayStart, cardDay, EVENTS_DAY_BEGINS, callOutcome, isTimedKind, TIMED_KINDS, CALENDAR_PATH, calendarAddress, callEvents, CARD_KINDS, dayCounts, daysOf, glancesOf, glanceText, hangoutEvents, initials, isCardKind, kindFilters, kindsServed, lineCount,
  llmEvents, monthGrid, monthOf, monthStart, monthText, onDay, onDayText, openOf, peopleOn, rangeText, readCalendarState, shadeOf,
  shownDays, spanText, stepMonth, weekdayOf, weekdayText, weekNumber, weekOf, whoText, workoutEvents, habitEvents, zoneText, type CalendarEvent,
} from "./calendar.ts";

/** Made-up people, as a rows answer names them. */
const PEOPLE: Record<number, string> = { 1: "Ada Sample", 2: "Bruno Example", 3: "Cleo Demo" };

/** The instant Melbourne's clocks read `time` on `day`. */
const at = (day: string, time: string) => wallClock(day, time);

const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";

/** A call's row, as the Calls tab answers one. */
function call(id: string, day: string, time: string, seconds: number | null, ids: number[], others = 0): Row {
  const when = at(day, time);
  return { id, at: when, cells: { when, with: { ids, others }, app: "FaceTime video", way: "They called", answered: seconds === null ? "No" : "Yes", length: seconds, origin: "Chat" } };
}

/** A hangout's row: with a time, or on its day alone (its When cell the date as words, its `at` the day's start). */
function hangout(id: string, day: string, time: string | null, hours: number, ids: number[]): Row {
  const when = time === null ? dayStart(day) : at(day, time);
  return { id, at: when, cells: { when: time === null ? "26 Oct 2026" : when, with: { ids, others: 0 }, hours: hours * 3600, size: ids.length } };
}

function llm(id: string, kind: "Session" | "Prompt" | "Reply", day: string, time: string, seconds: number | null, project = "garden-planner"): Row {
  const when = at(day, time);
  return { id, at: when, cells: { when, kind, how: "In a terminal", project, model: "claude-opus-5-5", chars: 1200, length: seconds, session: { filter: "session", value: "4", label: `${project} · ${day}` } } };
}

/** A habit done's row, as the Rituals tab of events answers one: its time, the doing in words, how long a plank was held. */
function habit(id: string, day: string, time: string, doing: string, held: string | null = null): Row {
  const when = at(day, time);
  return { id, at: when, cells: { when, habit: doing, held, basis: "As you said", day } };
}

function workout(id: string, day: string, time: string, seconds: number, sport = "Run", distance: string | null = "5.2 km"): Row {
  const when = at(day, time);
  return { id, at: when, cells: { when, sport, distance, length: seconds, recorder: "the watch", origin: "Polar" } };
}

describe("the kinds on the calendar", () => {
  it("are the people messaged and the five kinds of card: messages are never cards", () => {
    expect(ALL_KINDS).toEqual(["messages", "calls", "hangouts", "llm", "workouts", "habits"]);
    expect(CARD_KINDS).toEqual(["calls", "hangouts", "llm", "workouts", "habits"]);
    expect(isCardKind("messages")).toBe(false);
    expect(isCardKind("calls")).toBe(true);
  });

  it("are those the server has a tab for, and the people messaged always: a module's tab goes with its module", () => {
    expect(kindsServed(["events", "messages", "calls", "hangouts", "llm", "workouts", "habits", "people"])).toEqual([...ALL_KINDS]);
    // Exercise switched off: no workouts tab, so no Workouts chip and no workouts asked for.
    expect(kindsServed(["events", "messages", "calls", "hangouts", "llm", "habits", "people"])).toEqual(["messages", "calls", "hangouts", "llm", "habits"]);
    expect(kindsServed(["events"])).toEqual(["messages"]);
  });

  it("are drawn at their time on the day and the week for calls, hangouts, workouts and rituals alone: messages and agents are summaries", () => {
    expect(TIMED_KINDS).toEqual(["calls", "hangouts", "workouts", "habits"]);
    expect(ALL_KINDS.filter(isTimedKind)).toEqual(["calls", "hangouts", "workouts", "habits"]);
  });

  it("say a day's agents as the messages he sent them alone, never the sessions", () => {
    expect(agentsText(MONDAY, { [MONDAY]: 37 })).toBe("37 agent messages");
    expect(agentsText(MONDAY, { [MONDAY]: 1 })).toBe("1 agent message");
    expect(agentsText(TUESDAY, { [MONDAY]: 37 })).toBe("");
  });

  it("make a call a card with whom, its app and how it went; one never answered a point in time", () => {
    const [answered, missed] = callEvents([call("record:12", MONDAY, "14:30", 720, [1, 2]), call("call:9", MONDAY, "16:00", null, [3], 2)], PEOPLE);
    expect(answered).toMatchObject({ key: "calls:record:12", kind: "calls", title: "Ada Sample, Bruno Example", detail: "FaceTime video · 12 min", people: [1, 2], others: 0, allDay: false, row: { kind: "calls", id: "record:12" } });
    expect(answered.until - answered.at).toBe(720_000);
    expect(missed).toMatchObject({ title: "Cleo Demo +2", detail: "FaceTime video · Missed", people: [3], others: 2 });
    expect(missed.until).toBe(missed.at);
  });

  it("say how a call went: its length, missed when they called, no answer when he did, nothing when nobody knows", () => {
    expect(callOutcome({ answered: "Yes", way: "You called" }, 95)).toBe("2 min");
    expect(callOutcome({ answered: "No", way: "They called" }, 0)).toBe("Missed");
    expect(callOutcome({ answered: "No", way: "You called" }, 0)).toBe("No answer");
    expect(callOutcome({ answered: "No", way: "Logged" }, 0)).toBe("Not answered");
    expect(callOutcome({ answered: "Not known", way: null }, 0)).toBeNull();
    const [bare] = callEvents([{ id: "x", at: 0, cells: { when: at(MONDAY, "09:00"), with: { ids: [1], others: 0 }, app: null, answered: "Not known", length: null } }], PEOPLE);
    expect(bare.detail).toBe("Call");
  });

  it("make a hangout a card with its length, or an all-day item when the captain gave it no time", () => {
    const [timed, dateOnly] = hangoutEvents([hangout("3", MONDAY, "19:00", 2.5, [1, 2]), hangout("4", MONDAY, null, 4, [3])], PEOPLE);
    expect(timed).toMatchObject({ key: "hangouts:3", title: "Ada Sample, Bruno Example", detail: "Hangout · 2 h 30 min", allDay: false });
    expect(timed.until - timed.at).toBe(9_000_000);
    expect(dateOnly).toMatchObject({ title: "Cleo Demo", detail: "Hangout · 4 h", allDay: true, at: dayStart(MONDAY), until: dayStart(MONDAY) });
  });

  it("make an agent session a card, titled by its project, and leave its prompts and replies out", () => {
    const rows = [llm("1", "Session", MONDAY, "22:00", 7200), llm("2", "Prompt", MONDAY, "22:01", null), llm("3", "Reply", MONDAY, "22:02", null), llm("4", "Session", TUESDAY, "08:00", null, "")];
    const cards = llmEvents(rows);
    expect(cards.map((card) => [card.key, card.title, card.detail])).toEqual([
      ["llm:1", "garden-planner", "claude-opus-5-5 · In a terminal"],
      ["llm:4", "Agent session", "claude-opus-5-5 · In a terminal"],
    ]);
    expect(cards[0].until - cards[0].at).toBe(7_200_000);
    expect(cards[0].people).toEqual([]);
    expect(kindFilters("llm", 1, 2)).toEqual({ from: 1, to: 2, choices: { kind: ["llm_session"] }, person: null, search: null });
    expect(kindFilters("calls", 1, 2).choices).toEqual({});
    // Unknown calls hidden: the Calls tab is asked for its known callers' alone, and no other tab is touched.
    const known = { unknown: false, missed: true };
    expect(kindFilters("calls", 1, 2, known).choices).toEqual({ caller: ["known"] });
    expect(kindFilters("hangouts", 1, 2, known).choices).toEqual({});
    expect(kindFilters("llm", 1, 2, known).choices).toEqual({ kind: ["llm_session"] });
    // Missed calls hidden: only calls not known to be unanswered (answered, or not known either way); the two combine.
    expect(kindFilters("calls", 1, 2, { unknown: true, missed: false }).choices).toEqual({ answered: ["yes", "unknown"] });
    expect(kindFilters("calls", 1, 2, { unknown: false, missed: false }).choices).toEqual({ caller: ["known"], answered: ["yes", "unknown"] });
    expect(kindFilters("hangouts", 1, 2, { unknown: false, missed: false }).choices).toEqual({});
  });

  it("make a workout a card with its sport, distance and length", () => {
    const [run, swim] = workoutEvents([workout("5", MONDAY, "06:30", 1800), workout("6", MONDAY, "07:30", 2400, "Swim", null)]);
    expect(run).toMatchObject({ key: "workouts:5", title: "Run", detail: "5.2 km · 30 min", people: [] });
    expect(swim.detail).toBe("40 min");
  });

  it("make each habit done a moment at its time, in its own words, a plank with how long it was held, one with no time on its day", () => {
    const [magnesium, plank, untimed] = habitEvents([
      habit("71", MONDAY, "21:00", "Magnesium"),
      habit("72", MONDAY, "21:40", "Plank", "1:06"),
      { id: "73", at: dayStart(MONDAY), cells: { when: null, habit: "Protein", held: null } },
    ]);
    expect(magnesium).toMatchObject({ key: "habits:71", kind: "habits", title: "Magnesium", detail: null, people: [], allDay: false, row: { kind: "habits", id: "71" } });
    expect(magnesium.until).toBe(magnesium.at);
    // A plank is a moment too: how long it was held is its third line, in minutes:seconds, not a range.
    expect(plank).toMatchObject({ title: "Plank", detail: "1:06", length: 0 });
    expect(plank.until).toBe(plank.at);
    // A doing with no time is on its day, with no time.
    expect(untimed).toMatchObject({ title: "Protein", allDay: true, at: dayStart(MONDAY), until: dayStart(MONDAY) });
    expect(kindFilters("habits", 1, 2).choices).toEqual({});
  });

  it("put a ritual of the small hours on the day before, by the 06:00 boundary", () => {
    const [late] = habitEvents([habit("74", "2026-11-02", "01:00", "Magnesium")]);
    expect(cardDay(late, EVENTS_DAY_BEGINS)).toBe("2026-11-01");
    expect(onDay([late], "2026-11-01", EVENTS_DAY_BEGINS).map((c) => c.key)).toEqual(["habits:74"]);
    expect(onDay([late], "2026-11-02", EVENTS_DAY_BEGINS)).toEqual([]);
  });

  it("say who a card is with", () => {
    expect(whoText([1], 0, PEOPLE)).toBe("Ada Sample");
    expect(whoText([1, 2], 1, PEOPLE)).toBe("Ada Sample, Bruno Example +1");
    expect(whoText([9], 0, PEOPLE)).toBe("Person 9");
    expect(whoText([], 0, PEOPLE)).toBe("Someone");
    expect(whoText([], 3, PEOPLE)).toBe("3 people");
  });
});

describe("whom the captain messaged on a day", () => {
  it("counts, with the day's cards, everyone on the day", () => {
    const cards: CalendarEvent[] = [
      ...callEvents([call("a", MONDAY, "10:00", 60, [1, 2]), call("b", TUESDAY, "10:00", 60, [2])], PEOPLE),
      ...hangoutEvents([hangout("c", MONDAY, null, 2, [2, 3])], PEOPLE),
    ];
    const on = onDay(cards, MONDAY, MIDNIGHT);
    expect(on.map((card) => card.key)).toEqual(["hangouts:c", "calls:a"]);
    expect(peopleOn(on, [{ id: 1, count: 12 }, { id: 2, count: 3 }])).toEqual([
      { id: 1, cards: 1, messages: 12 },
      { id: 2, cards: 2, messages: 3 },
      { id: 3, cards: 1, messages: 0 },
    ]);
    expect(peopleOn(on)).toEqual([
      { id: 2, cards: 2, messages: 0 },
      { id: 1, cards: 1, messages: 0 },
      { id: 3, cards: 1, messages: 0 },
    ]);
    expect(onDayText({ id: 1, cards: 1, messages: 12 })).toBe("12 messages · 1 card");
    expect(onDayText({ id: 2, cards: 2, messages: 1 })).toBe("1 message · 2 cards");
    expect(onDayText({ id: 3, cards: 0, messages: 0 })).toBe("");
  });
});

describe("the days a card touches", () => {
  it("runs from the day it begins to the day it ends, one ending at midnight ending the day before", () => {
    const [session] = llmEvents([llm("1", "Session", MONDAY, "23:00", 7200)]);
    const [toMidnight] = llmEvents([llm("2", "Session", MONDAY, "22:00", 7200)]);
    expect(daysOf(session, MIDNIGHT)).toEqual([MONDAY, TUESDAY]);
    expect(daysOf(toMidnight, MIDNIGHT)).toEqual([MONDAY, MONDAY]);
  });
});

describe("the calendar's address", () => {
  const today = "2026-10-26";

  it("is the day picked, the kinds on, a person and the card open, each left out at its default", () => {
    expect(readCalendarState("", today)).toEqual({ mode: "week", day: today, kinds: [...ALL_KINDS], person: null, calls: DEFAULT_CALLS, showHidden: false, open: null });
    const state = readCalendarState("?day=2026-10-20&show=llm&show=calls&person=3&open=calls:record:12", today);
    expect(state).toEqual({ mode: "week", day: "2026-10-20", kinds: ["calls", "llm"], person: 3, calls: DEFAULT_CALLS, showHidden: false, open: "calls:record:12" });
    expect(calendarAddress(state, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?day=2026-10-20&show=calls&show=llm&person=3&open=calls%3Arecord%3A12");
    expect(readCalendarState(calendarAddress(state, CALENDAR_PATH, today).slice(CALENDAR_PATH.length), today)).toEqual(state);
    expect(calendarAddress(readCalendarState("", today), CALENDAR_PATH, today)).toBe(CALENDAR_PATH);
    // Known, answered calls alone by default; calls=unknown and calls=missed show the others, and only those are written.
    expect(readCalendarState("", today).calls).toEqual(DEFAULT_CALLS);
    const unknown = readCalendarState("?view=day&calls=unknown", today);
    expect(unknown.calls).toEqual({ unknown: true, missed: false });
    expect(calendarAddress(unknown, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=day&calls=unknown");
    expect(readCalendarState("?calls=all", today).calls).toEqual(DEFAULT_CALLS);
    const missed = readCalendarState("?calls=missed", today);
    expect(missed.calls).toEqual({ unknown: false, missed: true });
    expect(calendarAddress(missed, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?calls=missed");
    const both = readCalendarState("?calls=missed&calls=unknown", today);
    expect(both.calls).toEqual(ALL_CALLS);
    expect(calendarAddress(both, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?calls=unknown&calls=missed");
  });

  it("leaves the hidden people out unless hidden=show, and writes only that", () => {
    expect(readCalendarState("?view=day", today).showHidden).toBe(false);
    expect(readCalendarState("?hidden=yes", today).showHidden).toBe(false);
    const shown = readCalendarState("?view=day&hidden=show", today);
    expect(shown.showHidden).toBe(true);
    expect(calendarAddress(shown, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=day&hidden=show");
    expect(calendarAddress({ ...shown, showHidden: false }, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=day");
  });

  it("ignores the week's old layout (layout=grid): the week is its list alone", () => {
    const old = readCalendarState("?layout=grid&day=2026-10-20", today);
    expect(old).toEqual(readCalendarState("?day=2026-10-20", today));
    expect(calendarAddress(old, CALENDAR_PATH, today)).toBe(`${CALENDAR_PATH}?day=2026-10-20`);
  });

  it("says the month when it is shown, the week being the default, so a reload opens the same month", () => {
    const month = readCalendarState("?view=month&day=2026-09-01&show=hangouts", today);
    expect(month).toEqual({ mode: "month", day: "2026-09-01", kinds: ["hangouts"], person: null, calls: DEFAULT_CALLS, showHidden: false, open: null });
    expect(calendarAddress(month, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=month&day=2026-09-01&show=hangouts");
    expect(calendarAddress({ ...month, day: today, kinds: [...ALL_KINDS] }, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=month");
    expect(readCalendarState("?view=week", today).mode).toBe("week");
    expect(readCalendarState("?view=decade", today).mode).toBe("week");
    expect(calendarAddress(readCalendarState("?view=week", today), CALENDAR_PATH, today)).toBe(CALENDAR_PATH);
  });

  it("says the year when it is shown, with the day picked, so a reload opens the same year", () => {
    const year = readCalendarState("?view=year&day=2025-01-01&person=2", today);
    expect(year).toEqual({ mode: "year", day: "2025-01-01", kinds: [...ALL_KINDS], person: 2, calls: DEFAULT_CALLS, showHidden: false, open: null });
    expect(calendarAddress(year, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=year&day=2025-01-01&person=2");
    expect(calendarAddress({ ...year, day: today, person: null }, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=year");
  });

  it("says the day when it is shown; on a phone the day is the default, so the week is said instead", () => {
    const day = readCalendarState("?view=day&day=2026-10-21", today);
    expect(day).toEqual({ mode: "day", day: "2026-10-21", kinds: [...ALL_KINDS], person: null, calls: DEFAULT_CALLS, showHidden: false, open: null });
    expect(calendarAddress(day, CALENDAR_PATH, today)).toBe("/life-archive/dev/events?view=day&day=2026-10-21");
    // A phone's: no view is the day, and the week is named.
    expect(readCalendarState("?day=2026-10-21", today, "day").mode).toBe("day");
    expect(readCalendarState("?view=week", today, "day").mode).toBe("week");
    expect(readCalendarState("?view=decade", today, "day").mode).toBe("day");
    expect(calendarAddress(day, CALENDAR_PATH, today, "day")).toBe("/life-archive/dev/events?day=2026-10-21");
    expect(calendarAddress({ ...day, mode: "week" }, CALENDAR_PATH, today, "day")).toBe("/life-archive/dev/events?view=week&day=2026-10-21");
  });

  it("leaves what it cannot read at the default: a day that is none, a person that is none, a kind the calendar has not", () => {
    expect(readCalendarState("?day=2026-13-40&person=ada&show=people", today)).toEqual({ mode: "week", day: today, kinds: [...ALL_KINDS], person: null, calls: DEFAULT_CALLS, showHidden: false, open: null });
    expect(readCalendarState("?day=soon&show=calls&show=people", today).kinds).toEqual(["calls"]);
  });

  it("names the card open by its tab and its row's id there, a card's kinds alone", () => {
    expect(openOf("calls:record:12")).toEqual({ kind: "calls", id: "record:12" });
    expect(openOf("llm:40")).toEqual({ kind: "llm", id: "40" });
    expect(openOf("messages:40")).toBeNull();
    expect(openOf("people:3")).toBeNull();
    expect(openOf("calls:")).toBeNull();
    expect(openOf("nothing")).toBeNull();
  });
});

describe("the week's days and words", () => {
  it("run Monday to Sunday around the day picked", () => {
    expect(weekdayOf("2026-10-26")).toBe(0);
    expect(weekdayOf("2026-11-01")).toBe(6);
    expect(weekOf("2026-10-28")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(shownDays("2026-11-01")).toEqual(weekOf("2026-10-26"));
    expect(weekdayText("2026-10-26")).toBe("Mon");
    expect(weekdayText("2026-10-26", true)).toBe("Monday");
  });

  it("are numbered as ISO 8601 numbers them, for the month's week selectors: week 1 the one with the year's first Thursday", () => {
    expect(weekNumber("2026-10-29")).toBe(44);
    expect(weekNumber("2026-10-26")).toBe(44);
    expect(weekNumber("2026-01-01")).toBe(1);
    // 1 January 2027 is a Friday: its week is 2026's 53rd.
    expect(weekNumber("2027-01-01")).toBe(53);
    expect(weekNumber("2027-01-04")).toBe(1);
    // 29 December 2025 is a Monday whose Thursday is 1 January 2026.
    expect(weekNumber("2025-12-29")).toBe(1);
  });

  it("name the month and the span, across a month or a year", () => {
    expect(monthText(weekOf("2026-10-19"))).toBe("October 2026");
    expect(monthText(weekOf("2026-10-26"))).toBe("Oct – Nov 2026");
    expect(monthText(weekOf("2026-12-28"))).toBe("Dec 2026 – Jan 2027");
    expect(spanText(weekOf("2026-10-19"))).toBe("19 – 25 Oct");
    expect(spanText(weekOf("2026-10-26"))).toBe("26 Oct – 1 Nov");
  });

  it("write a time range once its half of the day is shared, and a point in time alone", () => {
    expect(rangeText(at(MONDAY, "14:50"), at(MONDAY, "15:10"))).toBe("2:50 – 3:10 pm");
    expect(rangeText(at(MONDAY, "11:50"), at(MONDAY, "12:10"))).toBe("11:50 am – 12:10 pm");
    expect(rangeText(at(MONDAY, "14:50"), at(MONDAY, "14:50"))).toBe("2:50 pm");
  });

  it("give Melbourne's zone and a face's letters", () => {
    expect(zoneText(at("2026-01-10", "12:00"))).toBe("AEDT");
    expect(zoneText(at("2026-07-10", "12:00"))).toBe("AEST");
    expect(initials("Ada Sample")).toBe("AS");
    expect(initials("Cleo")).toBe("C");
    expect(initials("周伟")).toBe("周");
    expect(initials("  ")).toBe("?");
  });
});

describe("the month", () => {
  it("is its days, the 1st to the last, in a grid of whole weeks, Monday first, four to six rows", () => {
    expect(monthStart("2026-10-29")).toBe("2026-10-01");
    expect(monthOf("2026-10-29")).toHaveLength(31);
    expect(monthOf("2028-02-10")).toHaveLength(29);
    expect(monthOf("2027-02-10").at(-1)).toBe("2027-02-28");
    // October 2026 begins on a Thursday and ends on a Saturday: five rows, from Monday 28 September to Sunday 1 November.
    const october = monthGrid("2026-10-29");
    expect(october).toHaveLength(35);
    expect([october[0], october.at(-1)]).toEqual(["2026-09-28", "2026-11-01"]);
    expect(october.slice(0, 7)).toEqual(weekOf("2026-09-28"));
    // February 2027 begins on a Monday and has 28 days: four rows exactly; August 2026, from a Saturday to a Monday: six.
    expect(monthGrid("2027-02-14")).toEqual(Array.from({ length: 28 }, (_, i) => monthOf("2027-02-01")[i]));
    expect(monthGrid("2026-08-01")).toHaveLength(42);
    expect(monthText([monthStart("2026-10-29")])).toBe("October 2026");
  });

  it("steps a month at a time, to its 1st, or to today in today's month, across a year", () => {
    const today = "2026-10-29";
    expect(stepMonth("2026-10-31", 1, today)).toBe("2026-11-01");
    expect(stepMonth("2026-10-29", -1, today)).toBe("2026-09-01");
    expect(stepMonth("2026-09-01", 1, today)).toBe(today);
    expect(stepMonth("2026-12-15", 1, today)).toBe("2027-01-01");
    expect(stepMonth("2026-01-10", -1, today)).toBe("2025-12-01");
    expect(stepMonth("2026-10-29", 12, today)).toBe("2027-10-01");
  });

  it("holds each day at a glance: its cards counted by kind on the day they begin, its hangouts in order, its messages and agent messages", () => {
    const events: CalendarEvent[] = [
      ...callEvents([call("record:1", MONDAY, "09:00", 600, [1]), call("record:2", MONDAY, "23:50", 1200, [2])], PEOPLE),
      ...hangoutEvents([hangout("8", MONDAY, "19:00", 2, [3]), hangout("7", MONDAY, null, 3, [1, 2])], PEOPLE),
      ...llmEvents([llm("40", "Session", TUESDAY, "10:00", 1800)]),
      ...workoutEvents([workout("w1", "2026-11-02", "07:00", 1800)]),
    ];
    const [monday, tuesday, wednesday] = glancesOf(events, [MONDAY, TUESDAY, "2026-10-28"], MIDNIGHT, { [MONDAY]: 142, "2026-10-28": 3 }, { [TUESDAY]: 37, "2026-10-28": 1 });
    // The call over midnight is Monday's alone; the hangout with no time comes first, at the day's start; a day not asked for is left out.
    expect(monday).toMatchObject({ day: MONDAY, counts: { calls: 2, hangouts: 2, llm: 0, workouts: 0, habits: 0 }, messages: 142 });
    expect(monday.hangouts.map((event) => event.title)).toEqual(["Ada Sample, Bruno Example", "Cleo Demo"]);
    expect(tuesday).toMatchObject({ counts: { calls: 0, hangouts: 0, llm: 1, workouts: 0 }, messages: 0, agentMessages: 37, hangouts: [] });
    expect(wednesday).toMatchObject({ messages: 3, agentMessages: 1 });
    expect(monday.agentMessages).toBe(0);
    // The LLM kind is said as its agent messages, not its sessions.
    expect(glanceText(monday)).toBe("142 messages · 2 calls · 2 hangouts");
    expect(glanceText(tuesday)).toBe("37 agent messages");
    expect(glanceText(wednesday)).toBe("3 messages · 1 agent message");
    expect(glanceText(monday, ["calls"])).toBe("2 calls");
    expect(glanceText(tuesday, ["calls", "messages"])).toBe("Nothing");
  });

  it("lines a day's counts up in one row: messages, calls, hangouts, agent messages, workouts, of the kinds on that it has", () => {
    const events = [
      ...callEvents([call("record:1", MONDAY, "09:00", 600, [1])], PEOPLE),
      ...hangoutEvents([hangout("8", MONDAY, "19:00", 2, [3]), hangout("7", MONDAY, null, 3, [1, 2])], PEOPLE),
      ...workoutEvents([workout("w1", MONDAY, "07:00", 1800)]),
      ...habitEvents([habit("h1", MONDAY, "21:00", "Magnesium"), habit("h2", MONDAY, "21:40", "Plank", "1:06")]),
    ];
    const [monday] = glancesOf(events, [MONDAY], MIDNIGHT, { [MONDAY]: 1250 }, { [MONDAY]: 4 });
    // Its hangouts are a count like the rest; who was at each is in its title.
    expect(dayCounts(monday).map((n) => [n.kind, n.count, n.text, n.title])).toEqual([
      ["messages", 1250, "1,250 messages", "1,250 messages"],
      ["calls", 1, "1 call", "1 call"],
      ["hangouts", 2, "2 hangouts", "2 hangouts: Ada Sample, Bruno Example · Cleo Demo"],
      ["llm", 4, "4 agent messages", "4 agent messages"],
      ["workouts", 1, "1 workout", "1 workout"],
      ["habits", 2, "2 rituals", "2 rituals"],
    ]);
    expect(dayCounts(monday, ["llm", "calls"]).map((n) => n.kind)).toEqual(["calls", "llm"]);
    expect(dayCounts(monday, ["hangouts", "messages"]).map((n) => n.kind)).toEqual(["messages", "hangouts"]);
    expect([0, 193, 999, 1000, 1250, 12_400].map(lineCount)).toEqual(["0", "193", "999", "1K", "1.3K", "12.4K"]);
    expect(dayCounts(glancesOf([], [MONDAY], MIDNIGHT, {})[0])).toEqual([]);
  });

  it("tints a day by its messages, a quarter of the month's busiest a step, any message at all showing", () => {
    expect(shadeOf(0, 500)).toBe(0);
    expect(shadeOf(12, 0)).toBe(0);
    expect(shadeOf(1, 500)).toBe(1);
    expect(shadeOf(125, 500)).toBe(1);
    expect(shadeOf(126, 500)).toBe(2);
    expect(shadeOf(375, 500)).toBe(3);
    expect(shadeOf(500, 500)).toBe(4);
    expect(shadeOf(900, 500)).toBe(4);
  });
});

describe("the Events calendar's days begin at 06:00", () => {
  const card = (key: string, at: number, kind: CalendarEvent["kind"] = "calls", allDay = false): CalendarEvent =>
    ({ key, kind, at, until: at, length: 0, allDay, title: key, detail: null, people: [], others: 0, row: { kind, id: key } });

  it("is one setting, 06:00", () => {
    expect(EVENTS_DAY_BEGINS).toBe("06:00");
    expect(calendarDayStart("2026-11-03")).toBe(wallClock("2026-11-03", "06:00"));
  });

  it("keeps Today on yesterday's date before 6 am", () => {
    expect(calendarDayOf(wallClock("2026-11-04", "02:30"))).toBe("2026-11-03");
    expect(calendarDayOf(wallClock("2026-11-04", "05:59"))).toBe("2026-11-03");
    expect(calendarDayOf(wallClock("2026-11-04", "06:00"))).toBe("2026-11-04");
  });

  it("counts a card on the day it began by them, a hangout with no time on its own date", () => {
    expect(cardDay(card("late", wallClock("2026-11-04", "05:59")), EVENTS_DAY_BEGINS)).toBe("2026-11-03");
    expect(cardDay(card("picnic", dayStart("2026-11-04"), "hangouts", true), EVENTS_DAY_BEGINS)).toBe("2026-11-04");
    const cards = [card("late", wallClock("2026-11-04", "05:59")), card("early", wallClock("2026-11-04", "06:00")), card("picnic", dayStart("2026-11-04"), "hangouts", true)];
    const [tuesday, wednesday] = glancesOf(cards, ["2026-11-03", "2026-11-04"], EVENTS_DAY_BEGINS, {});
    expect([tuesday.counts.calls, wednesday.counts.calls, wednesday.counts.hangouts]).toEqual([1, 1, 1]);
    expect(onDay(cards, "2026-11-03", EVENTS_DAY_BEGINS).map((c) => c.key)).toEqual(["late"]);
  });
});
