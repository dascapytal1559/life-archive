// calendar_day, the core's tool for what happened on a day (coreTools.ts): what the Events calendar's day shows
// (viewer/console/calendar/), read the way it reads it, from the calendar alone (server/viewer/): the day's summaries
// (how many messages, whom the owner messaged and how much, how many messages he sent agents, how his rituals went;
// calendarDays.ts) and the rows of each of its cards' tables over the day (its calls, hangouts, agents' sessions,
// workouts and habits done; CARD_KINDS in viewer/console/calendar/calendar.ts), each row as its table's columns say it,
// with the people it names by name. A day runs from 06:00 to 06:00, as the calendar's do (src/calendarDay.ts). Facts
// alone: the viewer's tables carry no content.

import { Clock, Effect, Schema } from "effect";
import { calendarDayOf, calendarDayStart } from "../../src/calendarDay.ts";
import { addDays, isDay, isoAt } from "../../src/time.ts";
import { lengthText } from "../../viewer/format.ts";
import { NO_FILTERS, type Cell } from "../../viewer/wire.ts";
import { UnavailableError } from "../errors.ts";
import { calendarDays } from "../viewer/calendarDays.ts";
import { ViewerDb } from "../viewer/connection.ts";
import type { Reads, Tab } from "../viewer/tab.ts";
import { rowsOf } from "../viewer/tabs.ts";
import { defineTool, ToolRefused } from "./tool.ts";

/** The tables whose rows are the calendar's cards, as its day reads them (calendar.ts's CARD_KINDS and kindFilters). */
const CARD_TABLES: ReadonlyArray<{ kind: string; choices?: Record<string, string[]> }> = [
  { kind: "calls" },
  { kind: "hangouts" },
  { kind: "llm", choices: { kind: ["llm_session"] } },
  { kind: "workouts" },
  { kind: "habits" },
];

/** The most rows of one table a day answers; a day with more says so. */
const MOST_ROWS = 200;

const isPeople = (cell: Cell): cell is { ids: number[]; others: number } => typeof cell === "object" && cell !== null && "ids" in cell;
const isLink = (cell: Cell): cell is { filter: string; value: string; label: string } => typeof cell === "object" && cell !== null && "label" in cell;

/** A cell as an agent reads it: a time in the archive's zone, a length in words, the people by name, a link by its label. */
function cellText(cell: Cell, kind: string, people: Record<number, string>): unknown {
  if (cell === null) return null;
  if (isPeople(cell)) return { names: cell.ids.map((id) => people[id] ?? `Person ${id}`), others: cell.others };
  if (isLink(cell)) return cell.label;
  if (kind === "time" && typeof cell === "number") return isoAt(cell);
  if (kind === "duration" && typeof cell === "number") return lengthText(cell);
  return cell;
}

/** What happened on `day`, a calendar day, from what the viewer reads (`reads`) and its tables (`tabs`). */
export function dayAnswer(reads: Reads, tabs: readonly Tab[], day: string) {
  const from = calendarDayStart(day);
  const to = calendarDayStart(addDays(day, 1));
  const { days, people } = calendarDays(reads, { from: day, to: addDays(day, 1), person: null });
  const summary = days[0];
  const tables = CARD_TABLES.flatMap(({ kind, choices }) => {
    const tab = tabs.find((t) => t.spec.kind === kind);
    if (!tab) return [];
    const answer = rowsOf(reads, tab, { ...NO_FILTERS, from, to, choices: choices ?? {} }, { offset: 0, limit: MOST_ROWS, sort: "when", direction: "asc", after: null });
    const columns = tab.spec.columns;
    return [{
      table: tab.spec.label,
      count: answer.total,
      ...(answer.total > answer.rows.length ? { shown: answer.rows.length } : {}),
      rows: answer.rows.map((row) => Object.fromEntries(columns.map((c) => [c.label, cellText(row.cells[c.key] ?? null, c.kind, answer.people)]))),
    }];
  });
  return {
    day,
    runs: { from: isoAt(from), to: isoAt(to) },
    messages: summary?.messages ?? 0,
    messaged: (summary?.messaged ?? []).map((who) => ({ name: people[who.id] ?? `Person ${who.id}`, messages: who.count })),
    agentMessages: summary?.agentMessages ?? 0,
    rituals: summary?.rituals ?? null,
    tables,
  };
}

const Day = Schema.String.annotate({ description: "A day, YYYY-MM-DD; today (the calendar's, from 06:00) when left out." });

/** The tool, over the viewer's tables `tabs` (the core's and the modules' on: server/viewer/tabs.ts's tabsWith). */
export const calendarDayTool = (tabs: readonly Tab[]) =>
  defineTool({
    name: "calendar_day",
    title: "What happened on a day",
    description:
      "One day of the calendar, 06:00 to 06:00 in the archive's time zone, as the Events calendar shows it: how many messages and with whom, how many messages the owner sent agents, how the day's rituals went (done, not done, not reported yet), and each call, hangout, agent session, workout and habit done, with its time and the people in it by name. Facts only: no message text.",
    access: "facts",
    input: { day: Schema.optionalKey(Day) },
    run: ({ day }) =>
      Effect.gen(function* () {
        const asked = day ?? calendarDayOf(yield* Clock.currentTimeMillis);
        if (!isDay(asked)) return yield* new ToolRefused({ message: `day is a date, YYYY-MM-DD, not ${JSON.stringify(asked)}` });
        const reads = (yield* ViewerDb).reads();
        if (reads instanceof Error) return yield* new UnavailableError(`the archive is not available: ${reads.message}`);
        return dayAnswer(reads, tabs, asked);
      }),
  });
