// The exercise module's tools at the archive's MCP door (module.ts's `agents`; the core's server/mcp/), both facts:
//
//   exercise_activities  the activities over a range of days, one each however many sources have it, as the Fitness
//                        page's feed lists them (http.ts's summaryOf): when, the sport, how far and long, what recorded
//                        it, and its minutes in zone 2; never a heart rate, a route or the captain's words in Rituals
//                        (exercise's and rituals' privacy lines: those are content)
//   exercise_pillars     a week's five pillars, as the Fitness page's Bryan Johnson tab counts them (viewer/pillars.ts, the same
//                        arithmetic): gym sessions, minutes in zone 2 and in zones 4 and 5, the days stretched and balance
//                        (none logged yet), each against its weekly target
//
// Minutes in a zone are counted from the trusted heart rate, but are a count of minutes, not a heart rate: they are
// facts here, as they are on the Bryan Johnson tab.

import { addDays, Clock, dayKey, defineTool, Effect, Schema, ToolRefused, type ModuleAgents, type ModuleStore } from "../../../sdk/server.ts";
import { PILLARS, pillarWeeks, readingText, targetsOf, valueOf, targetOf } from "../viewer/pillars.ts";
import { weekOf } from "../viewer/format.ts";
import { pillarsAnswer, summaryOf } from "./http.ts";
import { ExerciseReads } from "./service.ts";

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

/** The most activities one call answers. */
const MOST = 200;

/** A number to a tenth. */
const tenths = (n: number) => Math.round(n * 10) / 10;

/** `f` of `n`, or null for none. */
const orNull = (n: number | null, f: (n: number) => number) => (n === null ? null : f(n));

/** The exercise module's tools, for the archive kept at `folder`. */
export function exerciseAgents({ folder }: ModuleStore): ModuleAgents<ExerciseReads> {
  return {
    about:
      "The owner's workouts from every source (Polar, runs transcribed by hand, workouts logged in Rituals), one activity each, as the Fitness page lists them, and Bryan Johnson's five pillars of exercise week by week, as its Bryan Johnson tab counts them.",
    tools: [
      defineTool({
        name: "exercise_activities",
        title: "Workouts over a range of days",
        description:
          "Every activity whose start falls in [from, to] (days, YYYY-MM-DD; the last 7 days to today when left out), newest first: when it started, the sport, distance, elapsed and moving time, what recorded it, the sources that have it, the Rituals category it was logged under, and its minutes in zone 2. Facts only: no heart rate, route or the owner's own words.",
        access: "facts",
        input: { from: Schema.optionalKey(Day), to: Schema.optionalKey(Day) },
        run: ({ from, to }) =>
          Effect.gen(function* () {
            const today = dayKey(yield* Clock.currentTimeMillis);
            const last = to ?? today;
            const first = from ?? addDays(last, -6);
            if (first > last) return yield* new ToolRefused({ message: `from (${first}) is after to (${last})` });
            const built = yield* (yield* ExerciseReads).activities;
            const inRange = built.map((b) => summaryOf(b.detail)).filter((a) => a.start.slice(0, 10) >= first && a.start.slice(0, 10) <= last);
            return {
              from: first,
              to: last,
              count: inRange.length,
              ...(inRange.length > MOST ? { shown: MOST } : {}),
              activities: inRange.slice(0, MOST).map((a) => ({
                id: a.id,
                start: a.start,
                sport: a.sport,
                family: a.family,
                // Not its title: a workout logged in Rituals alone is titled in the owner's words, which are content.
                distanceKm: orNull(a.distanceM, (m) => Math.round(m / 10) / 100),
                elapsedMinutes: orNull(a.elapsedS, (s) => Math.round(s / 60)),
                movingMinutes: orNull(a.movingS, (s) => Math.round(s / 60)),
                recorder: a.recorder,
                source: a.source,
                alsoIn: a.alsoIn,
                ritualsCategory: a.logged?.type ?? null,
                zone2Minutes: orNull(a.zone2?.minutes ?? null, tenths),
              })),
            };
          }),
      }),
      defineTool({
        name: "exercise_pillars",
        title: "A week's five pillars",
        description:
          "The five pillars of exercise for the Monday-to-Sunday week holding `week` (this week when left out), as the Fitness page's Bryan Johnson tab counts them: Strength Training (gym sessions), Low Intensity Cardio (minutes in zone 2), High Intensity Cardio (minutes in zones 4 and 5), Mobility & Flexibility (days stretched) and Balance (balance work, none logged yet; planks do not count), each with its value, its weekly target and how it is measured.",
        access: "facts",
        input: {
          week: Schema.optionalKey(Day.annotate({ description: "Any day of the week, YYYY-MM-DD." })),
        },
        run: ({ week }) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const { today, targets, habits } = yield* pillarsAnswer(folder, now);
            const monday = weekOf(week ?? today);
            if (monday > today) return yield* new ToolRefused({ message: `the week of ${monday} has not begun yet` });
            const built = yield* (yield* ExerciseReads).activities;
            const weeks = pillarWeeks(built.map((b) => summaryOf(b.detail)), habits, today);
            const period = weeks.find((w) => w.from === monday);
            if (!period) return { week: { from: monday, to: addDays(monday, 6) }, counted: false, why: "nothing to count that week: it is before the first workout or ritual day the archive has" };
            const set = targetsOf(targets);
            return {
              week: { from: period.from, to: period.to, isoWeek: period.week, current: period.current },
              ritualsOn: habits !== null,
              pillars: PILLARS.map((p) => ({
                pillar: p.name,
                value: orNull(valueOf(period, p.key), tenths),
                target: targetOf(set, p.key),
                unit: p.unit,
                reading: (({ value, of }) => (value === null ? of : `${value} ${of}`))(readingText(period, p.key, set)),
                how: p.how,
              })),
            };
          }),
      }),
    ],
  };
}
