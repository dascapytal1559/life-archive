// The person panel's events chart, as numbers: what their messages, calls and
// hangouts counted for in closeness points each month (direct messages' worth,
// before fading: personMonthPoints in src/demos/closeness.ts), from their first
// month to their last. Messages are split by who sent them: theirs one-to-one
// and, with `groups`, in group chats too (as the panel's counts and chat do),
// and yours the same. Where a chat's source keeps only your side (Discord's
// data package), the replies the score assumes are on their side, kept apart
// so the chart can show them as assumed. Calls and hangouts are shared. Counts
// only, never text.

import type { PersonActivity, ScoreReport } from "./archive.ts";
import { personMonthPoints, scoreLabel } from "./demos/closeness.ts";
import { HANGOUT, hangoutCount } from "./eventWords.ts";
import type { ClosenessSettings } from "./settings.ts";
import { callDuration } from "./calls.ts";
import { callDaySeconds } from "./catchUps.ts";
import { locale } from "./time.ts";

/**
 * Person `id`'s activity (PersonActivity) from a score report: their messages by month, and the closeness points each
 * month's events counted for with `settings`, with that month's answered call time (a group call at their share of it)
 * and hangouts.
 */
export function personActivity(report: ScoreReport, id: number, settings: ClosenessSettings): PersonActivity {
  const months = report.people.find((p) => p.id === id)?.months ?? [];
  const points = new Map(personMonthPoints(report, id, settings).map((m) => [m.month, { ...m, callSeconds: 0, hangoutCount: 0 }]));
  const at = (month: string) =>
    points.get(month) ??
    points.set(month, { month, directThem: 0, directThemAssumed: 0, directYou: 0, groupThem: 0, groupThemAssumed: 0, groupYou: 0, calls: 0, hangouts: 0, callSeconds: 0, hangoutCount: 0 }).get(month)!;
  for (const c of report.callDays) if (c.personId === id) at(c.day.slice(0, 7)).callSeconds += callDaySeconds(settings, c);
  // A trip is one hangout, counted in the month it began; its points are in the months of its days (personMonthPoints).
  for (const c of report.catchUps) if (c.personIds.includes(id)) at(c.day.slice(0, 7)).hangoutCount += 1;
  return { months, points: [...points.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}

export interface ActivityBars {
  /** Every month (YYYY-MM) from the first with anything to the last, months with nothing included. */
  months: string[];
  /** What their messages counted for each month, in closeness points, with the replies assumed where only your side is kept. */
  them: number[];
  /** Of `them`, the replies assumed: one for each of yours in a chat whose source keeps only your side (Discord's data package), as the score takes them. */
  themAssumed: number[];
  /** What yours counted for. */
  you: number[];
  /** What your calls with them counted for. */
  calls: number[];
  /** What your hangouts with them counted for. */
  hangouts: number[];
  /** How many messages they sent each month. */
  themCount: number[];
  /** How many you sent. */
  youCount: number[];
  /** How long your answered calls ran, in seconds. */
  callSeconds: number[];
  /** How many hangouts they were at. */
  hangoutCount: number[];
}

type Series = Exclude<keyof ActivityBars, "months">;

export function activityBars(activity: PersonActivity, groups: boolean): ActivityBars {
  const byMonth = new Map<string, Record<Series, number>>();
  const at = (month: string) =>
    byMonth.get(month) ??
    byMonth.set(month, { them: 0, themAssumed: 0, you: 0, calls: 0, hangouts: 0, themCount: 0, youCount: 0, callSeconds: 0, hangoutCount: 0 }).get(month)!;
  for (const m of activity.months) {
    const month = at(m.month);
    month.themCount = m.directFromThem + (groups ? m.groupFromThem : 0);
    month.youCount = m.directFromMe + (groups ? m.groupFromMe : 0);
  }
  for (const p of activity.points) {
    const month = at(p.month);
    month.them = p.directThem + (groups ? p.groupThem : 0);
    month.themAssumed = p.directThemAssumed + (groups ? p.groupThemAssumed : 0);
    month.you = p.directYou + (groups ? p.groupYou : 0);
    month.calls = p.calls;
    month.hangouts = p.hangouts;
    month.callSeconds = p.callSeconds;
    month.hangoutCount = p.hangoutCount;
  }
  const empty: ActivityBars = { months: [], them: [], themAssumed: [], you: [], calls: [], hangouts: [], themCount: [], youCount: [], callSeconds: [], hangoutCount: [] };
  const shown = [...byMonth].filter(([, m]) => m.them + m.you + m.calls + m.hangouts + m.themCount + m.youCount + m.callSeconds + m.hangoutCount > 0).map(([month]) => month).sort();
  if (shown.length === 0) return empty;
  const all: string[] = [];
  for (let month = shown[0]; month <= shown.at(-1)!; month = nextMonth(month)) all.push(month);
  const bars = { ...empty, months: all };
  for (const key of Object.keys(empty) as Array<keyof ActivityBars>) {
    if (key !== "months") bars[key] = all.map((month) => byMonth.get(month)?.[key] ?? 0);
  }
  return bars;
}

/** How far a month reaches above the line (theirs, and half of the calls and hangouts) and below it (yours, and the other halves). */
export function monthReach(bars: ActivityBars, i: number): { above: number; below: number } {
  const shared = (bars.calls[i] + bars.hangouts[i]) / 2;
  return { above: bars.them[i] + shared, below: bars.you[i] + shared };
}

/**
 * A month's closeness points as the chart shows them under the pointer: "Mar 2024 · them 42 · you 18 · calls 25 ·
 * hangouts 100", calls and hangouts only when there were any; where some of theirs are assumed, "them 12 (6 assumed)"
 * and why: "· Discord keeps only your side".
 */
export function monthReadout(bars: ActivityBars, i: number): string {
  const assumed = bars.themAssumed[i] > 0;
  const them = `them ${scoreLabel(bars.them[i])}${assumed ? ` (${scoreLabel(bars.themAssumed[i])} assumed)` : ""}`;
  const parts = [monthName(bars.months[i]), them, `you ${scoreLabel(bars.you[i])}`];
  if (bars.calls[i] > 0 || bars.callSeconds[i] > 0) parts.push(`calls ${scoreLabel(bars.calls[i])}`);
  if (bars.hangouts[i] > 0 || bars.hangoutCount[i] > 0) parts.push(`${HANGOUT.many} ${scoreLabel(bars.hangouts[i])}`);
  if (assumed) parts.push(SELF_ONLY);
  return parts.join(" · ");
}

/** Why some of their side is assumed: the only source that keeps just yours is Discord's data package (conversation.is_self_only). */
export const SELF_ONLY = "Discord keeps only your side";

/** What made up a month's points, as counts: "42 messages from them, 18 from you · 35 min of calls · 1 hangout"; empty for nothing. */
export function monthCounts(bars: ActivityBars, i: number): string {
  const parts: string[] = [];
  if (bars.themCount[i] + bars.youCount[i] > 0) {
    parts.push(`${count(bars.themCount[i])} ${bars.themCount[i] === 1 ? "message" : "messages"} from them, ${count(bars.youCount[i])} from you`);
  }
  if (bars.callSeconds[i] > 0) parts.push(`${callDuration(bars.callSeconds[i])} of calls`);
  if (bars.hangoutCount[i] > 0) parts.push(hangoutCount(bars.hangoutCount[i]));
  return parts.join(" · ");
}

const count = (n: number) => n.toLocaleString(locale());

function nextMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

/** "Mar 2024". */
export function monthName(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${year}`;
}
