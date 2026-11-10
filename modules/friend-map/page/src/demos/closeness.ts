// The closeness score: how close you are to each person, from who wrote
// what where and when, never from what was said, and from the catch-ups you
// had with them outside messages. It sets how far from the sun everyone sits
// on Orbits. Pure functions, no DOM.
//
//   closeness = Σ over every month of direct messages:          direct × ½^(age ÷ half-life)
//             + Σ over every group message between you and them: weight × ½^(age ÷ half-life)
//             + Σ over every catch-up you had with them:          worth × ½^(age ÷ half-life)
//
//   direct = (1 − r) × (yours + theirs) + r × 2√(yours × theirs)
//            that month's direct messages each way, weighed by how evenly
//            you both wrote (directWeight): r is messageReciprocity in
//            data/settings.json (1 by default). At 1, 50 each way counts
//            100, as plainly counted, 90 and 10 count 60, 99 and 1 count
//            20, and 100 from one side alone counts nothing; at 0 every
//            message counts 1. Each month on its own, before fading, so a
//            friendship gone one-way lately counts less now and its even
//            years still count as they were.
//   weight = your share ÷ others   a message they sent in a group chat you are both in
//          = their share ÷ others  a message you sent in a group chat they are in
//   worth  = how many direct messages a catch-up counts as: its hours times the
//            worth of an hour (catchUpHourWorth in data/settings.json,
//            src/catchUps.ts), times each one's share of it with n people
//            there (you not counted, the others you did not name counted):
//            s + (1 − s) ÷ n (groupShare, s = groupSharedPart, ½ by
//            default), part of it shared by all and the rest split
//            equally: 2 hours with 4 people is 100 × (½ + ½ ÷ 4) = 62.5
//            each; 3 hours with 1 friend and 2 others is 100 for the
//            friend. A trip (several days away together) counts each of
//            its days apart, dated and fading on its own: that day's
//            time together, from when it began to when it ended less the
//            private window (midnight to 10 am by default), its first
//            8 hours (tripFullHours) whole and the rest by their square
//            root, F × √(hours ÷ F) (tripCountedHours), shared out over
//            its days by their time together: a whole day away with one
//            friend is 14 hours, 529; ten of them, 1,673
//
// A day's answered calls with someone count the same way, by how many hours
// they were connected in all (callHours in src/catchUps.ts; a day under
// callMinimumMinutes counts nothing; callCatchUps), beside any catch-up with
// them that day. A day's calls are the phone's call history's and the other
// apps' in one-to-one chats whose length is known (Messenger's and
// Instagram's, and any you gave a length) and those you logged, added up
// together, a phone call you logged that the call history brings in too
// counted once (callDays in the life archive's server/archive/calls.ts); every
// call record in a one-to-one chat counts as no message, so one whose length
// is not known counts nothing. A call you logged with several people (and any
// you did not name on it) adds to each one's day their share of
// its time (groupShare: an hour with three, at half shared, 40 minutes each;
// callDaySeconds), as a catch-up's worth is shared out, before the shortest
// day that counts and the hour's worth apply.
//
// A share is the share of that group's messages someone wrote, up to the
// month being scored. Each side's messages are credited by how active the
// other side is there, as a rough guess at how much of what each says is
// addressed to the other. A group adds, for each member P,
//
//   (P's messages × your share + your messages × P's share) ÷ others
//
// So a group you never write in adds nothing, and a member who never writes
// there gets nothing from yours either. "Others" is how many people are in the
// group besides you: a message to a group is split among everyone in it, so
// no group message ever weighs more than a direct one. Other members'
// messages to each other are not between you and them and count for nobody.
// Marketplace chats and system messages count nothing
// (the report leaves them out).
//
// Some sources hold only your own messages (Discord's data package:
// conversation.is_self_only), so what anyone else wrote there is not known.
// The score assumes an even exchange: each of your messages in a one-to-one
// chat there counts 2, yours and an assumed reply (what an even month counts,
// whatever messageReciprocity); in a group chat there, every
// other member is taken to have written as many as you did each month, so each
// of the n people in it (you too) holds a 1/n share, and the formula above
// gives each member  2 × your messages ÷ n ÷ others.
//
// The half-life is closenessHalfLifeDays in data/settings.json (90 days by
// default): a message that old counts half, twice that a quarter. The report
// gives counts by month, so every message is dated at the middle of its month
// (the current month: halfway through the part of it gone by), and a past
// month is scored as of its last day. A catch-up is dated at the middle of its
// own date.
//
// The score alone never places whoever you live with (tagged
// "live-together"): they are infinitely close, ranked first whatever it is
// (closenessRanks), and Orbits sets them right next to the sun.

import { livesTogether, type ClosenessSettings, type MessageCounts, type MonthPoints, type RelationshipsReport, type ScoreReport } from "../archive.ts";
import { isAspiring } from "../aspiring.ts";
import { callDaySeconds, callHours, catchUpCountedDayHours, catchUpWorth, groupShare } from "../catchUps.ts";
import { dayKey, locale, monthKey, monthRange } from "../time.ts";

/** The average month, in days. */
export const MONTH_DAYS = 30.44;

/** What the score reads: each person's direct messages per month, and the group chats. */
export interface ClosenessInput {
  /** The months to score, YYYY-MM, oldest first; the last is the one in progress at `now`. */
  months: string[];
  now: number;
  halfLifeDays: number;
  /** What each month's direct messages count as (directWeight, with any assumed replies, see reportScores), aligned with `months`, by person id. */
  direct: Map<number, number[]>;
  groups: RelationshipsReport["groups"];
  /** Whom to score, when not everyone: the groups' other members still count in their size. */
  only?: Set<number>;
  /** Catch-ups: each counts `worth` direct messages on its day (YYYY-MM-DD) for each of the people at it. */
  catchUps?: Array<{ day: string; worth: number; personIds: number[] }>;
}

/**
 * Every person's closeness score as of the end of each month (the last as of
 * `now`), aligned with `months`, by person id. Everyone in `direct` or in a
 * group (of `only`, when given) is scored; 0 means nothing between you yet.
 */
export function closenessScores({ months, now, halfLifeDays, direct, groups, only, catchUps = [] }: ClosenessInput): Map<number, number[]> {
  const steps = monthLengths(months, now);
  const index = new Map(months.map((month, i) => [month, i]));
  const scores = new Map<number, number[]>();
  const scoreOf = (id: number) => scores.get(id) ?? scores.set(id, new Array<number>(months.length).fill(0)).get(id)!;

  for (const [id, series] of direct) {
    const decayed = decay(series, steps, halfLifeDays);
    const score = scoreOf(id);
    for (let i = 0; i < months.length; i++) score[i] += decayed[i];
  }

  for (const group of groups) {
    const all = new Array<number>(months.length).fill(0);
    const mine = new Array<number>(months.length).fill(0);
    const theirs = new Map<number, number[]>();
    for (const m of group.months) {
      const i = index.get(m.month);
      if (i === undefined) continue;
      all[i] += m.messages;
      mine[i] += m.fromMe;
      for (const { id, count } of m.fromMembers) {
        (theirs.get(id) ?? theirs.set(id, new Array<number>(months.length).fill(0)).get(id)!)[i] += count;
      }
    }
    // Everyone who is in it or wrote in it, so someone who has since left still counts in its size.
    const people = new Set([...group.memberIds, ...theirs.keys()]);
    const others = Math.max(1, people.size);
    const decayedMine = decay(mine, steps, halfLifeDays);
    if (group.selfOnly) {
      for (const id of people) {
        if (only && !only.has(id)) continue;
        const score = scoreOf(id);
        for (let i = 0; i < months.length; i++) score[i] += selfOnlyGroupPoints(decayedMine[i], people.size);
      }
      continue;
    }
    const myShare = runningShares(all, mine);
    for (const id of people) {
      if (only && !only.has(id)) continue;
      const score = scoreOf(id);
      // Someone who never writes there gets nothing: not theirs, and not yours, at their share of 0.
      const written = theirs.get(id);
      if (!written) continue;
      const theirShare = runningShares(all, written);
      const decayedTheirs = decay(written, steps, halfLifeDays);
      for (let i = 0; i < months.length; i++) score[i] += (decayedTheirs[i] * myShare[i] + decayedMine[i] * theirShare[i]) / others;
    }
  }

  for (const catchUp of catchUps) {
    const at = catchUpAt(catchUp.day, index, steps);
    if (at === null || catchUp.worth === 0) continue;
    for (const id of catchUp.personIds) {
      if (only && !only.has(id)) continue;
      const score = scoreOf(id);
      // Its age at the end of its month, then halving every half-life as the months go by.
      let value = catchUp.worth * 0.5 ** (at.age / halfLifeDays);
      for (let i = at.month; i < months.length; i++) {
        if (i > at.month) value *= 0.5 ** (steps[i] / halfLifeDays);
        score[i] += value;
      }
    }
  }
  return scores;
}

/**
 * Where a catch-up on `day` (YYYY-MM-DD) falls in the months scored: its month's index (`index`, by YYYY-MM), and how
 * old it is at that month's end, in days, from the middle of its day, in the month's length for scoring (`steps`, see
 * monthLengths). Null for a day outside the months, or later than now in the last.
 */
export function catchUpAt(day: string, index: Map<string, number>, steps: number[]): { month: number; age: number } | null {
  const month = index.get(day.slice(0, 7));
  if (month === undefined) return null;
  const date = Number(day.slice(8, 10));
  if (month === steps.length - 1) {
    // The month in progress, as far as now: its length is the days gone by less half a day, so today is age 0.
    const age = steps[month] - (date - 0.5);
    return age < 0 ? null : { month, age };
  }
  const [year, number] = day.split("-").map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { month, age: (steps[month] * (days - date + 0.5)) / days };
}

/**
 * Every month from the report's first message, catch-up or call to now, YYYY-MM: the first of anyone in it, in any
 * group chat, at any catch-up or on any call, so every score counts from a group's first message even when the report
 * leaves its first writers out (archived people), and from a catch-up or call before any message.
 */
export function reportMonths(report: ScoreReport): string[] {
  const now = monthKey(report.generatedAt);
  const firsts = [...report.people, ...report.groups].flatMap((p) => p.months.slice(0, 1).map((m) => m.month));
  const days = [...report.catchUps, ...report.callDays].map((c) => c.day.slice(0, 7));
  const firstMonth = [...firsts, ...days, now].sort()[0];
  return monthRange(firstMonth, now);
}

/**
 * closenessScores over a relationships report, aligned with `months` (see reportMonths), with the half-life, the
 * worth of an hour caught up, the shortest day of calls that counts (see callCatchUps) and how much a month's direct
 * messages count by their balance (directWeight) in `settings`. Every group is scored as it is, its archived members
 * included, so a group's size is its real size. Each of your direct messages where only your side is known
 * (directFromMeSelfOnly) counts twice, for the reply assumed: an even exchange, which balance never discounts.
 */
export function reportScores(report: ScoreReport, months: string[], settings: ClosenessSettings): Map<number, number[]> {
  const index = new Map(months.map((month, i) => [month, i]));
  const direct = new Map(report.people.map((p) => {
    const series = new Array<number>(months.length).fill(0);
    for (const m of p.months) {
      const i = index.get(m.month);
      if (i !== undefined) series[i] = monthDirect(m, settings.messageReciprocity);
    }
    return [p.id, series];
  }));
  const catchUps = [...hangoutWorths(report, settings), ...callCatchUps(report, settings)];
  // Only the people in the report: its groups and catch-ups also name people it leaves out (the map's report, archived people).
  return closenessScores({
    months, now: report.generatedAt, halfLifeDays: settings.closenessHalfLifeDays, direct, groups: report.groups, only: new Set(direct.keys()), catchUps,
  });
}

/** What a month of someone's direct messages counts as: directWeight of both sides, and each of yours where only your side is known (directFromMeSelfOnly) twice, for the reply assumed. */
export function monthDirect(m: MessageCounts, reciprocity: number): number {
  const { sent, assumed } = directParts(m, reciprocity);
  return sent + assumed;
}

/**
 * monthDirect in its two parts: `sent`, directWeight of the messages where both sides are kept, and `assumed`, each of
 * yours where only your side is (directFromMeSelfOnly) at 2, yours and the reply assumed, half each.
 */
export function directParts(m: MessageCounts, reciprocity: number): { sent: number; assumed: number } {
  return { sent: directWeight(m.directFromMe - m.directFromMeSelfOnly, m.directFromThem, reciprocity), assumed: 2 * m.directFromMeSelfOnly };
}

/**
 * What your `mine` messages in a group chat whose source keeps only your side count for each of its `members`
 * (you aside): everyone is taken to write as many as you do, so each of the n people in it (you too) holds a 1/n
 * share, and the group formula gives each member 2 × mine ÷ n ÷ others, half yours and half the replies assumed.
 */
export function selfOnlyGroupPoints(mine: number, members: number): number {
  return (2 * mine) / (members + 1) / Math.max(1, members);
}

/**
 * The report's catch-ups (hangouts), each with its worth (catchUpWorth) for everyone at it; a trip once for each of
 * its days, dated that day, worth that day's part of the hours its time together counts as (catchUpCountedDayHours).
 */
export function hangoutWorths(report: Pick<ScoreReport, "catchUps">, settings: ClosenessSettings): Array<{ day: string; worth: number; personIds: number[] }> {
  return report.catchUps.flatMap((c) =>
    catchUpCountedDayHours(settings, c).map(({ day, hours }) => ({ day, personIds: c.personIds, worth: catchUpWorth(settings, hours, c.personIds.length, c.others) })));
}

/**
 * Person `id`'s closeness points month by month (MonthPoints), oldest first, every month with any. A group's shares
 * are as of each month itself, where the score weighs every month by the shares as of the month scored, so a group's
 * points are what its messages counted for when they were sent.
 */
export function personMonthPoints(report: ScoreReport, id: number, settings: ClosenessSettings): MonthPoints[] {
  const byMonth = new Map<string, MonthPoints>();
  const at = (month: string) =>
    byMonth.get(month) ??
    byMonth.set(month, { month, directThem: 0, directThemAssumed: 0, directYou: 0, groupThem: 0, groupThemAssumed: 0, groupYou: 0, calls: 0, hangouts: 0 }).get(month)!;

  for (const m of report.people.find((p) => p.id === id)?.months ?? []) {
    const { sent, assumed } = directParts(m, settings.messageReciprocity);
    if (sent + assumed === 0) continue;
    const mine = m.directFromMe - m.directFromMeSelfOnly;
    const both = mine + m.directFromThem;
    const month = at(m.month);
    // The replies assumed where only your side is kept go on their side, as the score takes them: an even exchange.
    month.directThemAssumed += assumed / 2;
    month.directThem += assumed / 2 + (both === 0 ? 0 : (sent * m.directFromThem) / both);
    month.directYou += assumed / 2 + (both === 0 ? 0 : (sent * mine) / both);
  }

  for (const group of report.groups) {
    const members = new Set([...group.memberIds, ...group.months.flatMap((m) => m.fromMembers.map((f) => f.id))]);
    if (!members.has(id)) continue;
    const others = Math.max(1, members.size);
    const all = group.months.map((m) => m.messages);
    const mine = group.months.map((m) => m.fromMe);
    if (group.selfOnly) {
      group.months.forEach((m, i) => {
        if (mine[i] === 0) return;
        const half = selfOnlyGroupPoints(mine[i], members.size) / 2;
        const month = at(m.month);
        month.groupYou += half;
        month.groupThem += half;
        month.groupThemAssumed += half;
      });
      continue;
    }
    const theirs = group.months.map((m) => m.fromMembers.find((f) => f.id === id)?.count ?? 0);
    if (theirs.every((n) => n === 0)) continue;
    const myShare = runningShares(all, mine);
    const theirShare = runningShares(all, theirs);
    group.months.forEach((m, i) => {
      const them = (theirs[i] * myShare[i]) / others;
      const you = (mine[i] * theirShare[i]) / others;
      if (them + you === 0) return;
      at(m.month).groupThem += them;
      at(m.month).groupYou += you;
    });
  }

  for (const c of callCatchUps({ callDays: report.callDays.filter((c) => c.personId === id) }, settings)) {
    at(c.day.slice(0, 7)).calls += c.worth;
  }
  for (const c of hangoutWorths(report, settings)) {
    if (c.personIds.includes(id) && c.worth > 0) at(c.day.slice(0, 7)).hangouts += c.worth;
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * The report's call days as hours caught up (callHours of callDaySeconds, a group call at their share), each with its
 * worth; a day too short to count is left out. A hangout that day is time apart from any call: it counts beside them.
 */
export function callCatchUps(report: Pick<ScoreReport, "callDays">, settings: ClosenessSettings): Array<{ day: string; worth: number; personIds: number[] }> {
  return report.callDays.flatMap((callDay) => {
    const hours = callHours(settings, callDaySeconds(settings, callDay));
    return hours > 0 ? [{ day: callDay.day, personIds: [callDay.personId], worth: catchUpWorth(settings, hours) }] : [];
  });
}

/**
 * What a month's direct messages with someone count as: `mine` and `theirs` (both two-sided, see reportScores),
 * blended by `reciprocity` (messageReciprocity, 0 to 1) from their plain count (0) to 2 × √(mine × theirs) (1), which is
 * the plain count when both write as much and less the more lopsided the month, nothing when only one side writes.
 */
export function directWeight(mine: number, theirs: number, reciprocity: number): number {
  return (1 - reciprocity) * (mine + theirs) + reciprocity * 2 * Math.sqrt(mine * theirs);
}

/** Everyone's closeness score now, by person id; 0 (or missing) for nothing between you. */
export function closenessNow(report: ScoreReport, settings: ClosenessSettings): Map<number, number> {
  const months = reportMonths(report);
  return new Map([...reportScores(report, months, settings)].map(([id, scores]) => [id, scores[months.length - 1] ?? 0]));
}

/**
 * Someone's share of a group chat's messages as of each month: their `counts`
 * of `all`, month by month, up to then. 0 before anyone wrote.
 */
export function runningShares(all: number[], counts: number[]): number[] {
  let sumAll = 0;
  let sumCounts = 0;
  return all.map((count, i) => {
    sumAll += count;
    sumCounts += counts[i];
    return sumAll === 0 ? 0 : sumCounts / sumAll;
  });
}

/**
 * Monthly counts, each message weighted by ½^(age ÷ halfLifeDays), summed as
 * of the end of each month: the running total halves every half-life, and a
 * month's own messages count from its middle. `steps` are the months' lengths
 * in days (see monthLengths).
 */
export function decay(counts: number[], steps: number[], halfLifeDays: number): number[] {
  let total = 0;
  return steps.map((length, i) => {
    total = total * 0.5 ** (length / halfLifeDays) + (counts[i] ?? 0) * 0.5 ** (length / 2 / halfLifeDays);
    return total;
  });
}

/** How long each month is, in days, for scoring: the average month, and the last only as far as `now`. */
export function monthLengths(months: string[], now: number): number[] {
  // The day of the month now, local time, less half a day: roughly how much of the month has gone by.
  const gone = Math.max(0.5, Number(dayKey(now).slice(8, 10)) - 0.5);
  return months.map((_, i) => (i === months.length - 1 ? gone : MONTH_DAYS));
}

/**
 * Rank by closeness in every month, 1 for the closest; 0 for anyone with no
 * score that month. Whoever you live with (livesTogether) is
 * infinitely close: ranked first every month, ahead of any score, even with
 * none, by their own score among themselves. An aspiring friend (isAspiring)
 * is never ranked, whatever their score: they sit out at the edge until the tag
 * comes off, and take nobody's place. Ties go to the lower id, so the
 * order is the same every time.
 */
export function closenessRanks(people: Array<{ id: number; closeness: number[]; tags: readonly string[] }>, monthCount: number): Map<number, number[]> {
  const ranks = new Map(people.map((p) => [p.id, new Array<number>(monthCount).fill(0)]));
  const together = new Set(people.filter(livesTogether).map((p) => p.id));
  const ranked = people.filter((p) => !isAspiring(p));
  for (let i = 0; i < monthCount; i++) {
    ranked
      .filter((p) => together.has(p.id) || p.closeness[i] > 0)
      .sort((a, b) => byCloseness(together.has(a.id), a.closeness[i], a.id, together.has(b.id), b.closeness[i], b.id))
      .forEach((p, k) => {
        ranks.get(p.id)![i] = k + 1;
      });
  }
  return ranks;
}

/**
 * Closest first: whoever you live with ahead of everyone, then by score, ties to the lower id. For
 * closenessRanks and the Table's (filterRows in table.ts).
 */
export function byCloseness(aTogether: boolean, aScore: number, aId: number, bTogether: boolean, bScore: number, bId: number): number {
  return Number(bTogether) - Number(aTogether) || bScore - aScore || aId - bId;
}

/** A score for people to read: "1,234", "42", "3.1", "0.27", "under 0.01". */
export function scoreLabel(score: number): string {
  if (score <= 0) return "0";
  if (score < 0.01) return "under 0.01";
  if (score >= 100) return Math.round(score).toLocaleString(locale());
  return score.toLocaleString(locale(), { maximumSignificantDigits: 2 });
}
