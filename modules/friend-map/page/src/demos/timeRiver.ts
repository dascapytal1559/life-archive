// The Time river's numbers (TimeRiver.tsx), as pure functions: its filters
// (the bar on the page: what it measures, Messages, or Calls, Hangouts or both
// as time together; the time it covers; the app; and whether
// calls with no length show), kept per browser; each person's stream of the
// measure month by month over that time; the calls that add no length
// (missed, or with no length known), drawn as marks instead; and the hover
// card's rows. The river's geometry is the frozen river's own
// (riverLayout.ts), imported unchanged.

import type { CatchUp, ListedCall, MessageApps } from "../archive.ts";
import { callDuration, callPlatformName } from "../calls.ts";
import { catchUpDayHours } from "../catchUps.ts";
import { hangoutCount, HANGOUT } from "../eventWords.ts";
import { keptSetting, useStore } from "../keptSetting.ts";
import { platformName } from "../platformNames.ts";
import { addMonths, dayKey, isMonth, locale, monthDays, monthKey, monthRange } from "../time.ts";
import { monthLabel } from "./model.ts";

const number = (n: number) => n.toLocaleString(locale());

/** What the river measures: messages, calls, hangouts, or calls and hangouts together as time. */
export type Measure = "messages" | "calls" | "hangouts" | "together";

/** What the bar toggles: Messages on its own, or Calls, Hangouts or both. */
export type Kind = "messages" | "calls" | "hangouts";

/** The bar's toggles, in the order it shows them. */
export const KINDS: ReadonlyArray<{ value: Kind; title: string; about: string }> = [
  { value: "messages", title: "Messages", about: "Each stream as wide as how many messages you had with them that month" },
  { value: "calls", title: "Calls", about: "Each stream as wide as how long your calls with them were that month; calls with no length are marks below" },
  { value: "hangouts", title: HANGOUT.Many, about: `Each stream as wide as how many hours your ${HANGOUT.many} with them lasted that month` },
];

const MEASURES: readonly Measure[] = ["messages", "calls", "hangouts", "together"];

/** Whether `kind` is on for `measure`. */
export function kindOn(measure: Measure, kind: Kind): boolean {
  return measure === kind || (measure === "together" && kind !== "messages");
}

/**
 * The measure once `kind` is toggled: Messages alone turns the others off, and Calls or Hangouts turns Messages off;
 * Calls and Hangouts go on and off together or apart, but the last one on stays on.
 */
export function toggleKind(measure: Measure, kind: Kind): Measure {
  if (kind === "messages" || measure === "messages") return kind;
  const other: Kind = kind === "calls" ? "hangouts" : "calls";
  if (measure === "together") return other;
  return measure === other ? "together" : measure;
}

/** How much time the river covers: the last 3, 6 or 12 months, everything, or from one month to another. */
export type Span = "3m" | "6m" | "1y" | "all" | "custom";

export const SPANS: ReadonlyArray<{ value: Span; title: string; months?: number }> = [
  { value: "3m", title: "Last 3 months", months: 3 },
  { value: "6m", title: "Last 6 months", months: 6 },
  { value: "1y", title: "Last year", months: 12 },
  { value: "all", title: "All time" },
  { value: "custom", title: "From… to…" },
];

/** Every app, the App filter's first choice. */
export const ALL_APPS = "all";

export interface Filters {
  measure: Measure;
  span: Span;
  /** The custom span's first and last months, YYYY-MM; null for the first (or last) month with any. */
  from: string | null;
  to: string | null;
  /** The app (a platform) messages and calls are on, each its own; ALL_APPS for every one. */
  app: { messages: string; calls: string };
  /** Whether calls with no length (missed, or not known) count and show as marks. */
  missed: boolean;
}

/** Hangouts, all time, every app, missed calls shown. */
export const DEFAULT_FILTERS: Filters = {
  measure: "hangouts", span: "all", from: null, to: null, app: { messages: ALL_APPS, calls: ALL_APPS }, missed: true,
};

export const FILTERS_KEY = "friend-map.timeRiver.filters";

/** What is kept, as Filters: anything it does not know (or none) as the default's. */
export function parseFilters(kept: string | null): Filters {
  if (kept === null) return DEFAULT_FILTERS;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(kept) ?? {};
  } catch {
    return DEFAULT_FILTERS;
  }
  const one = <T>(choices: ReadonlyArray<{ value: T }>, value: unknown, fallback: T) => choices.find((c) => c.value === value)?.value ?? fallback;
  const month = (value: unknown) => (typeof value === "string" && isMonth(value) ? value : null);
  const app = (value: unknown) => (typeof value === "string" && value !== "" ? value : ALL_APPS);
  const apps = (raw.app ?? {}) as Record<string, unknown>;
  return {
    measure: MEASURES.find((m) => m === raw.measure) ?? DEFAULT_FILTERS.measure,
    span: one(SPANS, raw.span, DEFAULT_FILTERS.span),
    from: month(raw.from),
    to: month(raw.to),
    app: { messages: app(apps.messages), calls: app(apps.calls) },
    missed: typeof raw.missed === "boolean" ? raw.missed : DEFAULT_FILTERS.missed,
  };
}

/** The filters, kept in this browser (or for the page's life without storage). */
export const filtersStore = keptSetting<Filters>(FILTERS_KEY, DEFAULT_FILTERS, parseFilters, (filters) => JSON.stringify(filters));

export function useFilters(): Filters {
  return useStore(filtersStore);
}

/** Changes some of the filters. */
export function setFilters(change: Partial<Filters>): void {
  filtersStore.set({ ...filtersStore.get(), ...change });
}

/** One person's stream: the measure (messages, minutes on calls, hours at hangouts or together) and how many there were, each month. */
export interface Flow {
  id: number;
  /** What the stream's width shows, per month: messages, minutes on answered calls, or hours at hangouts or together. */
  series: number[];
  /** How many calls or hangouts per month (both, together), missed calls among them; for messages, the messages. */
  counts: number[];
  /** Missed calls per month; zeros for messages and hangouts. */
  missed: number[];
  /** Together, its calls (in minutes) and hangouts apart, for the hover card. */
  parts?: { calls: Flow; hangouts: Flow };
}

/** A call that adds no length, drawn as a mark under the river: missed, or answered (or not known) with no length. */
export interface Mark {
  id: number;
  /** Its month, as an index into Flows.months. */
  month: number;
  /** Where in its month, 0 at its start to 1 at its end, by its local day. */
  within: number;
  day: string;
  missed: boolean;
}

export interface Flows {
  /** The months it covers, YYYY-MM: from the first with anything (for the people given) to now, until a span is applied. */
  months: string[];
  flows: Flow[];
  /** Calls only. */
  marks: Mark[];
}

/** What the river draws from: everyone shown, and the measures' data (each empty until loaded). */
export interface RiverData {
  /** Everyone shown, with their messages per month aligned with `months`. */
  people: ReadonlyArray<{ id: number; series: readonly number[] }>;
  /** The months `people`'s series run over (DemoModel.months). */
  months: readonly string[];
  messageApps: readonly MessageApps[];
  calls: readonly ListedCall[];
  catchUps: readonly CatchUp[];
  now: number;
}

/** What the river shows with `filters`: the measure, for the app or kind chosen, over the span chosen. */
export function flowsOf(filters: Filters, data: RiverData): Flows {
  const ids = new Set(data.people.map((p) => p.id));
  const calls = () =>
    callFlows(ids, data.calls.filter((call) => (filters.app.calls === ALL_APPS || call.platform === filters.app.calls) && (filters.missed || hasLength(call))), data.now);
  const hangouts = () => hangoutFlows(ids, data.catchUps, data.now);
  const all = filters.measure === "messages"
    ? messageFlows(filters.app.messages === ALL_APPS ? data.people : appSeries(data.people, data.months, data.messageApps, filters.app.messages), data.months)
    : filters.measure === "calls" ? calls()
    : filters.measure === "hangouts" ? hangouts()
    : togetherFlows(calls(), hangouts());
  return inSpan(all, spanMonths(filters, all.months, data.now));
}

/**
 * Calls and hangouts as time together, in hours: each person's minutes on answered calls and hours at hangouts added
 * up month by month, from the first month with either to the last (now, or one logged ahead), each kept apart in
 * `parts`; the calls' marks as they are.
 */
export function togetherFlows(calls: Flows, hangouts: Flows): Flows {
  const ends = [...calls.months, ...hangouts.months].sort();
  if (ends.length === 0) return { months: [], flows: [], marks: [] };
  const months = monthRange(ends[0], ends[ends.length - 1]);
  const [c, h] = [inSpan(calls, months), inSpan(hangouts, months)];
  const zeros = (): number[] => new Array(months.length).fill(0);
  const none = (id: number): Flow => ({ id, series: zeros(), counts: zeros(), missed: zeros() });
  const callsOf = new Map(c.flows.map((f) => [f.id, f]));
  const hangoutsOf = new Map(h.flows.map((f) => [f.id, f]));
  const ids = [...new Set([...callsOf.keys(), ...hangoutsOf.keys()])];
  return {
    months,
    flows: ids.map((id) => {
      const [call, hangout] = [callsOf.get(id) ?? none(id), hangoutsOf.get(id) ?? none(id)];
      return {
        id,
        series: months.map((_, i) => call.series[i] / 60 + hangout.series[i]),
        counts: months.map((_, i) => call.counts[i] + hangout.counts[i]),
        missed: call.missed,
        parts: { calls: call, hangouts: hangout },
      };
    }),
    marks: c.marks,
  };
}

/** Everyone's messages on `platform` alone, per month aligned with `months`. */
export function appSeries(
  people: ReadonlyArray<{ id: number }>,
  months: readonly string[],
  messageApps: readonly MessageApps[],
  platform: string,
): Array<{ id: number; series: number[] }> {
  const index = new Map(months.map((m, i) => [m, i]));
  const byId = new Map(messageApps.map((p) => [p.id, p]));
  return people.map(({ id }) => {
    const series = new Array<number>(months.length).fill(0);
    for (const m of byId.get(id)?.apps.find((a) => a.platform === platform)?.months ?? []) {
      const i = index.get(m.month);
      if (i !== undefined) series[i] += m.messages;
    }
    return { id, series };
  });
}

/**
 * The months the filters' span covers, given the months with anything (`months`): those alone for all time (with the
 * month before when there is only one, so a river has two ends to run between).
 */
export function spanMonths(filters: Pick<Filters, "span" | "from" | "to">, months: readonly string[], now: number): string[] {
  const current = monthKey(now);
  const preset = SPANS.find((s) => s.value === filters.span)?.months;
  if (preset) return monthRange(addMonths(current, 1 - preset), current);
  if (filters.span === "all" && months.length === 1) return [addMonths(months[0], -1), months[0]];
  if (filters.span === "all" || months.length === 0 && (filters.from === null || filters.to === null)) return [...months];
  const [from, to] = [filters.from ?? months[0], filters.to ?? months[months.length - 1]].sort();
  return monthRange(from, to);
}

/** `flows` over `months` instead: what falls outside left out, months with nothing as zeros. */
export function inSpan(flows: Flows, months: readonly string[]): Flows {
  const at = new Map(flows.months.map((m, i) => [m, i]));
  const pick = (values: readonly number[]) => months.map((m) => values[at.get(m) ?? -1] ?? 0);
  const index = new Map(months.map((m, i) => [m, i]));
  return {
    months: [...months],
    flows: flows.flows.map(function picked(f): Flow {
      return {
        id: f.id, series: pick(f.series), counts: pick(f.counts), missed: pick(f.missed),
        ...(f.parts && { parts: { calls: picked(f.parts.calls), hangouts: picked(f.parts.hangouts) } }),
      };
    }),
    marks: flows.marks.flatMap((mark) => {
      const month = index.get(flows.months[mark.month]);
      return month === undefined ? [] : [{ ...mark, month }];
    }),
  };
}

/** The App filter's choices for `measure` among the people `ids`: the apps with any of it, the most first (together, the calls'). */
export function appChoices(measure: Measure, ids: ReadonlySet<number>, data: Pick<RiverData, "messageApps" | "calls">): Array<{ value: string; title: string }> {
  const counts = new Map<string, number>();
  const add = (platform: string, n: number) => counts.set(platform, (counts.get(platform) ?? 0) + n);
  if (measure === "messages") {
    for (const person of data.messageApps) {
      if (!ids.has(person.id)) continue;
      for (const app of person.apps) add(app.platform, app.months.reduce((sum, m) => sum + m.messages, 0));
    }
  } else if (measure !== "hangouts") {
    for (const call of data.calls) if (call.people.some((id) => ids.has(id))) add(call.platform, 1);
  }
  const title = measure === "messages" ? platformName : callAppName;
  return [...counts].filter(([, n]) => n > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([value]) => ({ value, title: title(value) }));
}

/** "Phone", "FaceTime", "Another app": what a call's platform is called on the App filter. */
function callAppName(platform: string): string {
  if (platform === "other") return "Another app";
  const name = callPlatformName(platform);
  return name === "another app" ? platformName(platform) : name;
}

/** Whether a call adds length: answered (or not known to be missed) with a length over nothing. */
function hasLength(call: ListedCall): boolean {
  return call.answered !== false && call.durationSeconds !== null && call.durationSeconds > 0;
}

/** Messages, as the river counts them: everyone's series, from the first month anyone has any. */
export function messageFlows(people: ReadonlyArray<{ id: number; series: readonly number[] }>, months: readonly string[]): Flows {
  const first = months.findIndex((_, i) => people.some((p) => (p.series[i] ?? 0) > 0));
  if (first < 0) return { months: [], flows: [], marks: [] };
  const zeros = new Array<number>(months.length - first).fill(0);
  return {
    months: months.slice(first),
    flows: people.map((p) => {
      const series = p.series.slice(first);
      return { id: p.id, series, counts: series, missed: zeros };
    }),
    marks: [],
  };
}

/**
 * Calls with the people `ids` (everyone a call names, each its whole length), by local month: an answered call's
 * minutes widen their stream; one that adds no length (missed, or with no length known) counts as a call and is a mark.
 */
export function callFlows(ids: ReadonlySet<number>, calls: readonly ListedCall[], now: number): Flows {
  const theirs = calls.filter((call) => call.people.some((id) => ids.has(id)));
  const months = axis(theirs.map((call) => monthKey(call.at)), now);
  const index = new Map(months.map((m, i) => [m, i]));
  const flows = new Map<number, Flow>();
  const marks: Mark[] = [];
  for (const call of theirs) {
    const day = dayKey(call.at);
    const month = index.get(day.slice(0, 7));
    if (month === undefined) continue;
    const length = hasLength(call) ? call.durationSeconds! : 0;
    for (const id of new Set(call.people)) {
      if (!ids.has(id)) continue;
      const flow = flowOf(flows, id, months.length);
      flow.counts[month]++;
      if (call.answered === false) flow.missed[month]++;
      if (length > 0) flow.series[month] += length / 60;
      else marks.push({ id, month, within: within(day), day, missed: call.answered === false });
    }
  }
  return { months, flows: [...flows.values()], marks };
}

/**
 * Hangouts with the people `ids` (everyone at one, each its whole length), by month: a trip counted once, in the
 * month it began, and its time together in the month of each of its days (catchUpDayHours).
 */
export function hangoutFlows(ids: ReadonlySet<number>, catchUps: readonly CatchUp[], now: number): Flows {
  const theirs = catchUps.filter((c) => c.people.some((p) => ids.has(p.id)));
  const months = axis(theirs.flatMap((c) => [c.day.slice(0, 7), (c.trip?.lastDay ?? c.day).slice(0, 7)]), now);
  const index = new Map(months.map((m, i) => [m, i]));
  const flows = new Map<number, Flow>();
  for (const catchUp of theirs) {
    const month = index.get(catchUp.day.slice(0, 7));
    if (month === undefined) continue;
    const days = catchUpDayHours(catchUp).map(({ day, hours }) => ({ at: index.get(day.slice(0, 7))!, hours }));
    for (const id of new Set(catchUp.people.map((p) => p.id))) {
      if (!ids.has(id)) continue;
      const flow = flowOf(flows, id, months.length);
      flow.counts[month]++;
      for (const { at, hours } of days) flow.series[at] += hours;
    }
  }
  return { months, flows: [...flows.values()], marks: [] };
}

/** From the first of `months` to now (a later one, logged ahead, too); none when `months` is empty. */
function axis(months: readonly string[], now: number): string[] {
  if (months.length === 0) return [];
  const sorted = [...months, monthKey(now)].sort();
  return monthRange(sorted[0], sorted[sorted.length - 1]);
}

function flowOf(flows: Map<number, Flow>, id: number, length: number): Flow {
  let flow = flows.get(id);
  if (!flow) {
    flow = { id, series: new Array(length).fill(0), counts: new Array(length).fill(0), missed: new Array(length).fill(0) };
    flows.set(id, flow);
  }
  return flow;
}

/** Where in its month a day sits: the middle of the day, from 0 at the month's start to 1 at its end. */
function within(day: string): number {
  return (Number(day.slice(8)) - 0.5) / monthDays(day.slice(0, 7)).length;
}

/** "3 messages", "2 calls · 1 h 5 min", "1 hangout · 3 hours": one month's, or all of them (for one measure, not together). */
export function amountLabel(measure: Exclude<Measure, "together">, amount: number, count: number): string {
  if (measure === "messages") return `${number(Math.round(amount))} ${amount === 1 ? "message" : "messages"}`;
  if (measure === "hangouts") return `${hangoutCount(count)} · ${hoursText(amount)}`;
  const calls = `${number(count)} ${count === 1 ? "call" : "calls"}`;
  return amount > 0 ? `${calls} · ${callDuration(Math.round(amount * 60))}` : calls;
}

/** "3 hours", "1.5 hours", "1 hour". */
function hoursText(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded.toLocaleString(locale(), { maximumFractionDigits: 2 })} ${rounded === 1 ? "hour" : "hours"}`;
}

/** "3 h together": time together, in hours, for calls and hangouts both. */
export function togetherLabel(hours: number): string {
  return `${callDuration(Math.round(hours * 3600))} together`;
}

/**
 * Calls and hangouts together, each part apart as a row of its own under the total: "Calls", "3 calls · 1 h 10 min"
 * (minutes, as Calls says them); "Hangouts", "2 hangouts · 1 h 50 min"; a part with none left out.
 */
function partRows(parts: NonNullable<Flow["parts"]>, pick: (values: readonly number[]) => number): Array<[string, string]> {
  const [calls, hangouts] = [pick(parts.calls.counts), pick(parts.hangouts.counts)];
  return [
    ...(calls > 0 ? [["Calls", amountLabel("calls", pick(parts.calls.series), calls)] as [string, string]] : []),
    ...(hangouts > 0 ? [[HANGOUT.Many, `${hangoutCount(hangouts)} · ${callDuration(Math.round(pick(parts.hangouts.series) * 3600))}`] as [string, string]] : []),
  ];
}

/** What `flow` amounts to over the months `pick` adds up (one month, or all of them), in `measure`'s own terms. */
function flowAmount(measure: Measure, flow: Flow, pick: (values: readonly number[]) => number): string {
  return measure === "together" ? togetherLabel(pick(flow.series)) : amountLabel(measure, pick(flow.series), pick(flow.counts));
}

/** What the river's width is, for the key: "10 messages", "30 min of calls", "2 hours of hangouts", "2 h of calls and hangouts together". */
export function widthLabel(measure: Measure, amount: number): string {
  if (measure === "messages") return `${number(amount)} messages`;
  if (measure === "calls") return `${callDuration(amount * 60)} of calls`;
  if (measure === "together") return `${callDuration(Math.round(amount * 3600))} of calls and ${HANGOUT.many} together`;
  return `${hoursText(amount)} of ${HANGOUT.many}`;
}

/**
 * The hover card's rows for `flow` at month `month` of `months` (`current`, this month, so far): that month, all of
 * them (together, each with its calls and hangouts under it), the busiest, and missed calls.
 */
export function flowRows(measure: Measure, flow: Flow, month: number, months: readonly string[], current: string): Array<[string, string]> {
  const total = flow.series.reduce((a, b) => a + b, 0);
  const count = flow.counts.reduce((a, b) => a + b, 0);
  const missed = flow.missed.reduce((a, b) => a + b, 0);
  const busiest = flow.series.reduce((best, n, i) => (n > flow.series[best] ? i : best), 0);
  const when = months[month] === current ? `${monthLabel(months[month])} so far` : monthLabel(months[month]);
  const last = months.length - 1;
  const span = last === 0 ? monthLabel(months[0]) : `${monthLabel(months[0])} – ${monthLabel(months[last])}`;
  const at = (i: number) => (values: readonly number[]) => values[i];
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  const parts = (pick: (values: readonly number[]) => number) => (flow.parts ? partRows(flow.parts, pick) : []);
  return [
    [when, flow.counts[month] > 0 ? flowAmount(measure, flow, at(month)) : "nothing"],
    ...parts(at(month)),
    ...(flow.missed[month] > 0 ? [["Missed that month", number(flow.missed[month])] as [string, string]] : []),
    [span, count > 0 ? flowAmount(measure, flow, sum) : "nothing"],
    ...parts(sum),
    ...(missed > 0 ? [["Missed in all", number(missed)] as [string, string]] : []),
    ...(total > 0 && last > 0 ? [["Busiest month", `${monthLabel(months[busiest])} · ${flowAmount(measure, flow, at(busiest))}`] as [string, string]] : []),
  ];
}

/** The mark nearest `x` among marks drawn at `xs`, within `slack` pixels; null for none. */
export function markAt<M>(marks: readonly M[], xs: readonly number[], x: number, slack = 4): M | null {
  let best: M | null = null;
  let distance = slack;
  marks.forEach((mark, i) => {
    const d = Math.abs(xs[i] - x);
    if (d <= distance) [best, distance] = [mark, d];
  });
  return best;
}
