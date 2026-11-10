import { describe, expect, it } from "vitest";
import { dayStart, MIDNIGHT, wallClock } from "../../../src/time.ts";
import type { RitualsDaySummary } from "../../wire.ts";
import { calendarDayOf, type CalendarEvent, type CardKind } from "./calendar.ts";
import { cardHours, dayListOf, idleGap, idleRows, isFutureDay, momentsOf, noMomentsText, nowIndex, spanTally, ritualsSumOf, ritualText, stepMoment, weekListOf, weekOf, isWeekLaneKind } from "./day.ts";

const DAY = "2026-10-27";
const at = (time: string, day = DAY) => wallClock(day, time);

/** A moment as the calendar's cards make one: of `kind`, from `from` for `minutes`, with `people`. */
function moment(key: string, kind: CardKind, from: number, minutes: number, people: number[] = [], allDay = false): CalendarEvent {
  return { key, kind, at: from, until: allDay ? from : from + minutes * 60_000, length: minutes * 60, allDay, title: key, detail: null, people, others: 0, row: { kind, id: key } };
}

describe("the day event by event", () => {
  it("says a day's rituals from the first timed to the last, those with no time not among them", () => {
    const read = (events: CalendarEvent[]) => spanTally({ events, messages: 0, agentMessages: 0, messaged: [] }, ["habits"]).habits?.note;
    const untimed = moment("Journal", "habits", dayStart(DAY), 0, [], true);
    expect(read([untimed, moment("Protein", "habits", at("20:32"), 0), moment("Plank", "habits", at("22:54"), 0)])).toBe("8:32 – 10:54 pm");
    expect(read([untimed])).toBe("No time kept");
  });

  const events = [
    moment("run", "workouts", at("07:00"), 30),
    moment("late call", "calls", at("23:30", "2026-10-26"), 60),
    moment("lunch", "hangouts", at("12:30"), 90, [1]),
    moment("call at lunch", "calls", at("13:00"), 10, [2]),
    moment("missed", "calls", at("15:00"), 0, [3]),
    moment("picnic", "hangouts", dayStart(DAY), 180, [2], true),
    moment("session", "llm", at("09:00"), 120),
    moment("tomorrow", "calls", at("09:00", "2026-10-28"), 5),
    moment("yesterday's", "calls", at("10:00", "2026-10-26"), 5),
    moment("brunch", "hangouts", at("11:00"), 0, [1], true),
  ];
  const items = momentsOf(events, DAY, MIDNIGHT);
  const keys = items.map((item) => item.event.key);

  it("orders what has no time by kind, then title, above everything at a time", () => {
    const list = dayListOf([moment("run", "workouts", at("07:00"), 30), moment("Stretch", "habits", dayStart(DAY), 0, [], true), moment("Protein", "habits", dayStart(DAY), 0, [], true), moment("zoo", "hangouts", dayStart(DAY), 0, [], true)], DAY, MIDNIGHT);
    expect(list.map((item) => item.event.key)).toEqual(["Protein", "Stretch", "zoo", "run"]);
  });

  it("lists what has no time first, then each call, hangout and workout by when it began, with no agent session and nothing of another day", () => {
    // Those with no time by kind, then title: brunch before picnic, both hangouts.
    expect(keys).toEqual(["brunch", "picnic", "late call", "run", "lunch", "call at lunch", "missed"]);
  });

  it("keeps a call begun the night before at the top, said as begun before", () => {
    expect(items.filter((item) => item.before).map((item) => item.event.key)).toEqual(["late call"]);
  });

  it("orders events that begin together by when they end, the shorter first", () => {
    const same = dayListOf([moment("long", "calls", at("09:00"), 60), moment("short", "calls", at("09:00"), 5)], DAY, MIDNIGHT);
    expect(same.map((item) => item.event.key)).toEqual(["short", "long"]);
  });

  it("puts the present before the first event at a time still to begin, after everything when none is, and nowhere without one", () => {
    expect(nowIndex(items, at("12:00"))).toBe(keys.indexOf("lunch"));
    expect(nowIndex(items, at("06:00"))).toBe(keys.indexOf("run"));
    expect(nowIndex(items, at("22:00"))).toBe(items.length);
    expect(nowIndex(items, null)).toBeNull();
    expect(nowIndex(dayListOf([moment("picnic", "hangouts", dayStart(DAY), 0, [], true)], DAY, MIDNIGHT), at("12:00"))).toBeNull();
  });

  it("steps one at a time, from none to the first going down and the last going up, stopping at either end", () => {
    expect(stepMoment(null, 1, 4)).toBe(0);
    expect(stepMoment(null, -1, 4)).toBe(3);
    expect(stepMoment(1, 1, 4)).toBe(2);
    expect(stepMoment(3, 1, 4)).toBe(3);
    expect(stepMoment(0, -1, 4)).toBe(0);
    expect(stepMoment(null, 1, 0)).toBeNull();
  });
});

describe("the day's summaries", () => {
  const events = [
    moment("call", "calls", at("09:00"), 25, [1]),
    moment("missed", "calls", at("10:00"), 0, [2]),
    moment("lunch", "hangouts", at("12:30"), 90, [1]),
    moment("picnic", "hangouts", dayStart(DAY), 120, [3], true),
    moment("session", "llm", at("20:00"), 45),
  ];
  const read = { events, messages: 142, agentMessages: 37, messaged: [{ id: 1, count: 100 }, { id: 2, count: 42 }] };

  it("are the kind chips' counts: a count a kind on, with the line under it", () => {
    expect(spanTally(read, ["messages", "calls", "hangouts", "llm", "workouts"])).toEqual({
      messages: { label: "Messages", value: "142", note: "With 2 people" },
      calls: { label: "Calls", value: "2", note: "25 min in all" },
      hangouts: { label: "Hangouts", value: "2", note: "3 h 30 min in all" },
      llm: { label: "Agent messages", value: "37", note: " " },
      workouts: { label: "Workouts", value: "0", note: "No workouts" },
    });
  });

  it("leave out the kinds off", () => {
    expect(spanTally(read, ["calls"])).toEqual({ calls: { label: "Calls", value: "2", note: "25 min in all" } });
  });

  it("say agent messages with no session note, and a call with no length", () => {
    const quiet = { events: [], messages: 0, agentMessages: 6, messaged: [] };
    expect([spanTally(quiet, ["messages", "llm"]).messages?.note, spanTally(quiet, ["llm"]).llm?.note]).toEqual(["With nobody", " "]);
    expect(spanTally({ events: [moment("x", "calls", at("09:00"), 0)], messages: 0, agentMessages: 0, messaged: [] }, ["calls"]).calls?.note).toBe("No length kept");
  });

  it("say a day's rituals by how many and from the first to the last, never a length", () => {
    const habits = { events: [moment("magnesium", "habits", at("21:00"), 0), moment("plank", "habits", at("21:40"), 0), moment("journal", "habits", at("01:00", "2026-10-28"), 0)], messages: 0, agentMessages: 0, messaged: [] };
    expect(spanTally(habits, ["habits"]).habits).toEqual({ label: "Rituals", value: "3", note: "9:00 pm – 1:00 am" });
    expect(spanTally({ ...habits, events: [] }, ["habits"]).habits?.note).toBe("No rituals");
    expect(noMomentsText(["workouts", "habits"], null)).toBe("No workouts or rituals on this day.");
  });

  it("say a week's or a month's rituals on how many days, each counted on its own day from where the days begin", () => {
    // 01:00 on the 28th is still the 27th's (its days begin at 06:00); 07:00 on the 29th is the 29th's.
    const habits = { events: [moment("magnesium", "habits", at("21:00"), 0), moment("journal", "habits", at("01:00", "2026-10-28"), 0), moment("plank", "habits", at("07:00", "2026-10-29"), 0)], messages: 0, agentMessages: 0, messaged: [] };
    expect(spanTally(habits, ["habits"], "06:00").habits).toEqual({ label: "Rituals", value: "3", note: "On 2 days" });
    expect(spanTally(habits, ["habits"], MIDNIGHT).habits?.note).toBe("On 3 days");
  });

  it("say what a day with no moment of the kinds on lacks", () => {
    expect(noMomentsText(["messages", "calls", "hangouts", "llm", "workouts"], null)).toBe("No calls, hangouts or workouts on this day.");
    expect(noMomentsText(["calls"], "Ada Sample")).toBe("No calls with Ada Sample on this day.");
    expect(noMomentsText(["messages", "llm"], null)).toBe("Nothing at a time on this day.");
  });
});

describe("the week event by event", () => {
  const week = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
  const events = [
    moment("dinner", "hangouts", at("19:00", "2026-10-28"), 120, [1]),
    moment("over midnight", "calls", at("23:40", "2026-10-27"), 50, [2]),
    moment("run", "workouts", at("07:00", "2026-10-28"), 30),
    moment("picnic", "hangouts", dayStart("2026-10-28"), 0, [3], true),
    moment("standup", "calls", at("09:00", "2026-10-26"), 15),
    moment("last week", "calls", at("09:00", "2026-10-25"), 15),
    moment("next week", "calls", at("09:00", "2026-11-02"), 15),
    moment("short at nine", "calls", at("09:00", "2026-10-26"), 5),
  ];
  const lists = weekListOf(events, week, MIDNIGHT);
  const keysOn = (day: string) => lists.find((d) => d.day === day)!.items.map((item) => item.event.key);

  it("is a list for each day of the week, Monday to Sunday, in order", () => {
    expect(lists.map((d) => d.day)).toEqual(week);
  });

  it("orders each day as the day does: what has no time first, then by when it began, the shorter first among those begun together", () => {
    expect(keysOn("2026-10-26")).toEqual(["short at nine", "standup"]);
    expect(keysOn("2026-10-28")).toEqual(["picnic", "over midnight", "run", "dinner"]);
  });

  it("puts an event over midnight on both its days, said as begun before on the second, at its top", () => {
    expect(keysOn("2026-10-27")).toEqual(["over midnight"]);
    const second = lists.find((d) => d.day === "2026-10-28")!.items.find((item) => item.event.key === "over midnight")!;
    expect(second.before).toBe(true);
    expect(lists.find((d) => d.day === "2026-10-27")!.items[0].before).toBe(false);
  });

  it("leaves a quiet day empty and nothing from another week in", () => {
    expect(keysOn("2026-10-29")).toEqual([]);
    expect(keysOn("2026-11-01")).toEqual([]);
    expect(lists.flatMap((d) => d.items.map((item) => item.event.key))).not.toContain("last week");
    expect(lists.flatMap((d) => d.items.map((item) => item.event.key))).not.toContain("next week");
  });
});

describe("the Events week's rituals, a row of their own over the lanes", () => {
  const week = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
  const plank = { ...moment("Plank", "habits", at("21:40", "2026-10-28"), 0), detail: "1:15" };
  const events = [
    moment("run", "workouts", at("07:00", "2026-10-28"), 30),
    moment("standup", "calls", at("09:00", "2026-10-28"), 15),
    moment("dinner", "hangouts", at("19:00", "2026-10-28"), 120, [1]),
    plank,
    moment("Protein", "habits", at("08:10", "2026-10-28"), 0),
    moment("Journal", "habits", dayStart("2026-10-28"), 0, [], true),
    moment("Magnesium", "habits", at("01:00", "2026-10-29"), 0),
    moment("session", "llm", at("10:00", "2026-10-28"), 0),
  ];
  const split = weekOf(events, week, "06:00");
  const keys = (items: readonly { event: CalendarEvent }[]) => items.map((item) => item.event.key);

  it("keeps workouts, calls and hangouts in the lanes, never a ritual or an agent session", () => {
    expect(keys(split.lanes[2].items)).toEqual(["run", "standup", "dinner"]);
    expect(split.lanes.flatMap((d) => d.items).some((item) => item.event.kind === "habits")).toBe(false);
    expect((["calls", "hangouts", "llm", "workouts", "habits"] as const).filter(isWeekLaneKind)).toEqual(["calls", "hangouts", "workouts"]);
  });

  it("lists each day's rituals as the day orders them: those with no time first, then by their time, the small hours the day before's", () => {
    expect(Object.keys(split.rituals)).toEqual(week);
    expect(keys(split.rituals["2026-10-28"])).toEqual(["Journal", "Protein", "Plank", "Magnesium"]);
    expect(split.rituals["2026-10-29"]).toEqual([]);
  });

  it("says a ritual by its label, a plank's hold and its time when one is known", () => {
    expect(ritualText(plank)).toBe("Plank 1:15 · 9:40 pm");
    expect(ritualText(moment("Journal", "habits", dayStart(DAY), 0, [], true))).toBe("Journal");
  });
});

describe("the Events week's Rituals row, a summary a day: done over asked", () => {
  /** Rituals' day summary as the calendar holds it (viewer/wire.ts's RitualsDaySummary): which habits were done, not done and not yet, in rituals' order, and a plank's hold. */
  const summary = (done: string[], notDone: string[] = [], notYet: string[] = [], held: Record<string, string> = {}): RitualsDaySummary => ({ done, notDone, notYet, held });
  const all = summary(["magnesium", "protein", "stretching", "planks", "journalling"], [], [], { planks: "2:00" });

  it("says a day all done as 5/5, its title each habit done in rituals' order, a plank with its hold", () => {
    expect(ritualsSumOf(all, [])).toEqual({ done: 5, expected: 5, text: "5/5", title: "5 of 5 rituals done: Magnesium, Protein, Stretch, Plank 2:00, Journal" });
  });

  it("asks for every habit but those not asked that day, and says which were not done", () => {
    const sum = ritualsSumOf(summary(["magnesium", "journalling"], ["protein", "planks"]), []);
    expect(sum).toMatchObject({ done: 2, expected: 4, text: "2/4" });
    expect(sum?.title).toBe("2 of 4 rituals done: Magnesium, Journal; not done: Protein, Plank");
  });

  it("reads a day with none done as 0/N, and the day still open counts what is not reported yet as asked", () => {
    expect(ritualsSumOf(summary([], ["magnesium", "protein", "stretching", "planks", "journalling"]), [])?.text).toBe("0/5");
    const open = ritualsSumOf(summary(["magnesium", "protein"], [], ["stretching", "planks", "journalling"]), []);
    expect(open?.text).toBe("2/5");
    expect(open?.title).toBe("2 of 5 rituals done: Magnesium, Protein; not yet: Stretch, Plank, Journal");
  });

  it("counts a day's required checks with its habits, each said by its id", () => {
    const sum = ritualsSumOf(summary(["protein", "stretching", "planks", "journalling", "morning-priority-review"], [], ["magnesium", "evening-lay-out-clothes"]), []);
    expect(sum).toMatchObject({ done: 5, expected: 7, text: "5/7" });
    expect(sum?.title).toBe("5 of 7 rituals done: Protein, Stretch, Plank, Journal, Morning priority review; not yet: Magnesium, Evening lay out clothes");
  });

  it("says nothing of a day that asked for nothing, or one the calendar has no summary of with no rituals among its cards", () => {
    expect(ritualsSumOf(summary([]), [])).toBeNull();
    expect(ritualsSumOf(null, [])).toBeNull();
  });

  it("takes rituals' day over the cards, and with no summary of the day counts the cards alone, over nothing", () => {
    const cards = [moment("Journal", "habits", dayStart(DAY), 0, [], true), moment("Protein", "habits", at("08:10"), 0)];
    expect(ritualsSumOf(all, cards)?.text).toBe("5/5");
    expect(ritualsSumOf(null, cards)).toEqual({ done: 2, expected: null, text: "2 done", title: "2 rituals done: Journal, Protein · 8:10 am" });
  });
});

describe("the Events calendar's day, 06:00 to 06:00", () => {
  const SIX = "06:00";
  const NEXT = "2026-10-28";
  const events = [
    moment("small hours", "calls", at("01:30", NEXT), 20),
    moment("evening", "hangouts", at("21:00"), 60, [1]),
    moment("breakfast", "calls", at("06:00"), 5),
    moment("last of the night before", "calls", at("05:59"), 0),
    moment("next morning", "calls", at("06:00", NEXT), 5),
    moment("picnic", "hangouts", dayStart(DAY), 0, [2], true),
  ];

  it("lists its small hours last, after its evening, and leaves 05:59 to the day before", () => {
    const keys = dayListOf(events, DAY, SIX).map((item) => item.event.key);
    expect(keys).toEqual(["picnic", "breakfast", "evening", "small hours"]);
    expect(dayListOf(events, "2026-10-26", SIX).map((item) => item.event.key)).toEqual(["last of the night before"]);
    expect(dayListOf(events, NEXT, SIX).map((item) => item.event.key)).toEqual(["next morning"]);
  });

  it("keeps a call over 06:00 on both days, at the top of the second", () => {
    const over = moment("over six", "calls", at("05:50"), 20);
    expect(dayListOf([over], DAY, SIX)).toEqual([{ event: over, before: true }]);
    expect(dayListOf([over], "2026-10-26", SIX)).toEqual([{ event: over, before: false }]);
  });

  it("ends a week as the next Monday's 06:00 begins: Monday 05:59 is still Sunday's", () => {
    const week = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
    const sundayNight = moment("sunday night", "calls", at("05:59", "2026-11-02"), 5);
    const monday = moment("monday", "calls", at("06:00", "2026-11-02"), 5);
    const lists = weekListOf([sundayNight, monday], week, SIX);
    expect(lists.at(-1)!.items.map((item) => item.event.key)).toEqual(["sunday night"]);
    expect(lists.flatMap((d) => d.items.map((item) => item.event.key))).not.toContain("monday");
  });
});

describe("a card's height in hours", () => {
  it("is one for an hour or less, an instant, or all day, its hours past one, and at most twelve", () => {
    expect(cardHours(moment("missed", "calls", at("15:00"), 0))).toBe(1);
    expect(cardHours(moment("short", "calls", at("15:00"), 40))).toBe(1);
    expect(cardHours(moment("hour", "calls", at("15:00"), 60))).toBe(1);
    expect(cardHours(moment("long", "hangouts", at("15:00"), 150))).toBe(2.5);
    expect(cardHours(moment("evening", "hangouts", at("19:15"), 240))).toBe(4);
    expect(cardHours(moment("all day", "hangouts", dayStart(DAY), 600, [], true))).toBe(1);
    expect(cardHours(moment("marathon", "llm", at("06:00"), 20 * 60))).toBe(12);
  });
});

describe("how far rows sit apart after a quiet", () => {
  it("grows 4 px per doubling from an hour, smoothly, nothing under", () => {
    const h = 3_600_000;
    expect([0, h - 1, h, 2 * h, 4 * h, 8 * h, 16 * h].map(idleGap)).toEqual([0, 0, 4, 8, 12, 16, 20]);
    expect(idleGap(3 * h)).toBeCloseTo(10.34, 2);
  });

  it("measures each row's quiet from the end of every earlier one, and never parts overlapping or untimed rows", () => {
    const list = dayListOf(
      [
        moment("picnic", "hangouts", dayStart(DAY), 0, [], true),
        moment("run", "workouts", at("07:00"), 30),
        moment("call", "calls", at("08:20"), 10),
        moment("missed", "calls", at("09:30"), 0),
        moment("lunch", "hangouts", at("12:00"), 180),
        moment("in lunch", "calls", at("12:30"), 5),
        moment("after lunch", "calls", at("14:30"), 5),
        moment("night", "calls", at("23:00"), 5),
      ],
      DAY,
      MIDNIGHT,
    );
    // 07:30 to 08:20 under an hour; 08:30 to 09:30 an hour; 09:30 to 12:00 two and a half; lunch until 15:00 holds the
    // two calls; 15:00 to 23:00 eight.
    expect(Object.fromEntries(list.map((item, i) => [item.event.key, idleRows(list)[i]]))).toEqual({
      picnic: 0, run: 0, call: 0, missed: 4, lunch: 4 + 4 * Math.log2(2.5), "in lunch": 0, "after lunch": 0, night: 16,
    });
  });
});

describe("a day still to come says no Nothing", () => {
  it("counts today and the days before as come, the day after as to come, by the calendar's 06:00 day", () => {
    // 04:30 on Tuesday 3 November is still Monday 2 November's night.
    const today = calendarDayOf(wallClock("2026-11-03", "04:30"));
    expect(today).toBe("2026-11-02");
    expect(isFutureDay("2026-11-01", today)).toBe(false);
    expect(isFutureDay("2026-11-02", today)).toBe(false);
    expect(isFutureDay("2026-11-03", today)).toBe(true);
    expect(isFutureDay("2026-12-01", today)).toBe(true);
  });
});
