// The numbers every demo view draws from, derived from the archive's
// relationships report (GET /api/archive/relationships): who is shown, each
// person's volume, balance, recency, closeness and trend, a month-by-month
// series, and friend groups found from shared group chats. Pure functions, no DOM.

import { ARCHIVE_TAG, connectedIds, unlinkedIds, type PersonLocation, type PersonRelationship, type RelationshipsReport } from "../archive.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings.ts";
import { closenessRanks, reportMonths, reportScores } from "./closeness.ts";
import { hideEntries, hides, shownByHide, type HideChoices, type HideEntry } from "./hideChoices.ts";
import { trendEnd, trendOf, type Trend } from "./trend.ts";

const DAY = 86_400_000;

/** With location, for the hover card. */
export interface DemoPerson extends PersonLocation {
  id: number;
  name: string;
  /** Other names they go by; the first is their label. */
  aliases: string[];
  tags: string[];
  /** Your note about them; empty for none. */
  note: string;
  /** You should reach out to them: Orbits' glow. */
  shouldReachOut: boolean;
  /** What their identicon is drawn from (src/identicon.ts); its main colour fills their dot on Orbits. */
  identiconSeed: string;
  /** The hue picked for it, whole degrees; null for the seed's own. */
  identiconHue: number | null;
  unknown: boolean;
  /** Direct messages both ways plus what they sent in groups: "how much we talk". */
  total: number;
  direct: number;
  directFromMe: number;
  directFromThem: number;
  groupFromMe: number;
  groupFromThem: number;
  /** Your share of the direct messages, 0 to 1; null with no direct chat. */
  myShare: number | null;
  openingsByMe: number;
  openingsByThem: number;
  reactionsFromMe: number;
  reactionsFromThem: number;
  firstAt: number | null;
  lastAt: number | null;
  /** `total` per month, aligned with DemoModel.months. */
  series: number[];
  /** Direct messages from you and from them per month, aligned with DemoModel.months. */
  seriesMe: number[];
  seriesThem: number[];
  /** The closeness score (closeness.ts) as of the end of each month (the last: now), aligned with DemoModel.months. */
  closeness: number[];
  /** Rank by closeness among the people shown, per month: 1 for the closest, 0 with no score yet. */
  rank: number[];
  /** The friend group (see communities) this person belongs to; -1 for none. */
  community: number;
}

export interface DemoModel {
  now: number;
  /** Every month from the first message to now, YYYY-MM. */
  months: string[];
  people: DemoPerson[];
  /**
   * Every group chat with someone on the map: `memberIds` only those on the map it connects (connectedIds: not those
   * unlinked from it), `unlinkedIds` those on the map unlinked from it, `size` everyone in it but you, on the
   * map or not, unlinked or not.
   */
  groups: Array<RelationshipsReport["groups"][number] & { size: number; unlinkedIds: number[] }>;
  links: Link[];
  /**
   * The settings it was built with (data/settings.json): how many months back a trend looks, and the closeness score's
   * half-life and what an hour caught up counts as.
   */
  settings: Settings;
  /** Archived people, who are never on the map. */
  archivedCount: number;
  /** With `hide`: Hide's rows, counted over everyone the query leaves (see hideEntries); empty without. */
  hideEntries: HideEntry[];
  /** People left out by `only` (the query matches none of them) or `hide` (a tag of theirs on in Hide). */
  hiddenCount: number;
}

export interface Link {
  source: number;
  target: number;
  /** Shared group chats, each counting 1/(members - 1), so a big group binds each pair less. */
  weight: number;
  groups: number;
}

export function buildModel(
  report: RelationshipsReport,
  {
    settings = DEFAULT_SETTINGS,
    hide = null as HideChoices | null,
    only = null as ReadonlySet<number> | null,
    tags = [] as readonly string[],
  } = {},
): DemoModel {
  // The report holds only people on the map (archived people are just counted).
  const listed = report.people;
  // With `only`, the people the Query bar's query matches, and of them, with `hide`, those Hide does not leave out.
  // Their scores still count what you share in groups; only who is shown, and so the ranks, change.
  const queried = only ? listed.filter((p) => only.has(p.id)) : listed;
  const shown = hide ? queried.filter((p) => shownByHide(hide, p.tags)) : queried;
  const months = reportMonths(report);
  const index = new Map(months.map((month, i) => [month, i]));
  const scores = reportScores(report, months, settings);
  const none = new Array<number>(months.length).fill(0);
  const people = shown.map((p) => toDemoPerson(p, months.length, index, scores.get(p.id) ?? none));
  const ranks = closenessRanks(people, months.length);
  for (const person of people) person.rank = ranks.get(person.id)!;
  const ids = new Set(people.map((p) => p.id));
  // Someone unlinked from a group chat is still in it (its size), but it links them to nobody.
  const groups = report.groups
    .map((g) => ({
      ...g,
      size: g.memberIds.length,
      memberIds: connectedIds(g, report.unlinks).filter((id) => ids.has(id)),
      unlinkedIds: unlinkedIds(g, report.unlinks).filter((id) => ids.has(id)),
    }))
    .filter((g) => g.memberIds.length > 0 || g.unlinkedIds.length > 0);
  // A pair's share of a group chat is as if nobody were unlinked from it, so unlinking one person leaves the rest's links as they were.
  const links = groupLinks(groups.map((g) => ({ memberIds: g.memberIds, people: g.memberIds.length + g.unlinkedIds.length })));
  const community = communities(people.map((p) => p.id), links);
  for (const person of people) person.community = community.get(person.id) ?? -1;
  return {
    now: report.generatedAt,
    months,
    people,
    groups,
    links,
    settings,
    archivedCount: report.archivedCount,
    // Archived people are in the report only while Hide shows them (useDemoModel), so until then they are not counted.
    hideEntries: hide ? hideEntries(queried, tags, hides(hide, ARCHIVE_TAG) ? [ARCHIVE_TAG] : []) : [],
    hiddenCount: listed.length - shown.length,
  };
}

function toDemoPerson(p: PersonRelationship, length: number, index: Map<string, number>, closeness: number[]): DemoPerson {
  const series = new Array<number>(length).fill(0);
  const seriesMe = new Array<number>(length).fill(0);
  const seriesThem = new Array<number>(length).fill(0);
  for (const m of p.months) {
    const i = index.get(m.month);
    if (i === undefined) continue;
    series[i] = m.directFromMe + m.directFromThem + m.groupFromThem;
    seriesMe[i] = m.directFromMe;
    seriesThem[i] = m.directFromThem;
  }
  const direct = p.totals.directFromMe + p.totals.directFromThem;
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    tags: p.tags,
    note: p.note,
    shouldReachOut: p.shouldReachOut,
    identiconSeed: p.identiconSeed,
    identiconHue: p.identiconHue,
    location: p.location,
    unknown: p.unknown,
    total: direct + p.totals.groupFromThem,
    direct,
    directFromMe: p.totals.directFromMe,
    directFromThem: p.totals.directFromThem,
    groupFromMe: p.totals.groupFromMe,
    groupFromThem: p.totals.groupFromThem,
    myShare: direct > 0 ? p.totals.directFromMe / direct : null,
    openingsByMe: p.openings.byMe,
    openingsByThem: p.openings.byThem,
    reactionsFromMe: p.reactions.fromMe,
    reactionsFromThem: p.reactions.fromThem,
    firstAt: p.firstMessageAt,
    lastAt: p.lastMessageAt,
    series,
    seriesMe,
    seriesThem,
    closeness,
    rank: [],
    community: -1,
  };
}

/** One link per pair of people who share a group chat; `people`, how many each pair's share is split over, is its members by default. */
export function groupLinks(groups: Array<{ memberIds: number[]; people?: number }>): Link[] {
  const links = new Map<string, Link>();
  for (const { memberIds, people = memberIds.length } of groups) {
    if (memberIds.length < 2) continue;
    const share = 1 / (people - 1);
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        const [source, target] = memberIds[i] < memberIds[j] ? [memberIds[i], memberIds[j]] : [memberIds[j], memberIds[i]];
        const key = `${source}:${target}`;
        const link = links.get(key) ?? { source, target, weight: 0, groups: 0 };
        link.weight += share;
        link.groups++;
        links.set(key, link);
      }
    }
  }
  return [...links.values()];
}

/**
 * Friend groups from shared group chats, by weighted label propagation: each
 * person repeatedly joins the group their links weigh most toward. Deterministic;
 * people with no links get -1. Groups are numbered 0.. by size, biggest first.
 */
export function communities(ids: number[], links: Link[]): Map<number, number> {
  const neighbours = new Map<number, Array<{ id: number; weight: number }>>();
  for (const { source, target, weight } of links) {
    (neighbours.get(source) ?? neighbours.set(source, []).get(source)!).push({ id: target, weight });
    (neighbours.get(target) ?? neighbours.set(target, []).get(target)!).push({ id: source, weight });
  }
  const label = new Map(ids.map((id) => [id, id]));
  const order = [...ids].sort((a, b) => a - b);
  for (let round = 0; round < 30; round++) {
    let changed = false;
    for (const id of order) {
      const scores = new Map<number, number>();
      for (const n of neighbours.get(id) ?? []) {
        const l = label.get(n.id);
        if (l !== undefined) scores.set(l, (scores.get(l) ?? 0) + n.weight);
      }
      let best = label.get(id)!;
      let bestScore = scores.get(best) ?? 0;
      for (const [l, score] of scores) if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && l < best)) [best, bestScore] = [l, score];
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const sizes = new Map<number, number>();
  for (const id of ids) if (neighbours.has(id)) sizes.set(label.get(id)!, (sizes.get(label.get(id)!) ?? 0) + 1);
  const ranked = [...sizes].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([l]) => l);
  const number = new Map(ranked.map((l, i) => [l, i]));
  return new Map(ids.map((id) => [id, neighbours.has(id) ? number.get(label.get(id)!)! : -1]));
}

/** Where a person stands at the end of month `at` (an index into months; the last one means now). */
export interface Standing {
  /** Messages up to and including that month. */
  total: number;
  /** Days since they last talked, or null if they hadn't yet. */
  daysSince: number | null;
  /** Messages in the last three months (this one included), and in the three before. */
  recent: number;
  before: number;
  /** -1 (fading) to 1 (warming): (recent - before) / (recent + before), 0 when both are 0. */
  trend: number;
}

export function standing(person: DemoPerson, at: number, model: Pick<DemoModel, "months" | "now">): Standing {
  let total = 0;
  let last = -1;
  for (let i = 0; i <= at && i < person.series.length; i++) {
    total += person.series[i];
    // Group messages from you alone don't count as talking with them.
    if (person.series[i] > 0) last = i;
  }
  const isNow = at >= model.months.length - 1;
  let daysSince: number | null;
  if (isNow) daysSince = person.lastAt === null ? null : Math.max(0, (model.now - person.lastAt) / DAY);
  else if (last < 0) daysSince = null;
  // Month granularity in the past: the middle of their last active month to the end of this one.
  else daysSince = (at - last) * 30.44 + 15;
  const sum = (from: number, to: number) => person.series.slice(Math.max(0, from), Math.max(0, to)).reduce((a, b) => a + b, 0);
  const recent = sum(at - 2, at + 1);
  const before = sum(at - 5, at - 2);
  return { total, daysSince, recent, before, trend: recent + before === 0 ? 0 : (recent - before) / (recent + before) };
}

/** A person's trend over the look-back window as of month `at` (see trend.ts). */
export function trendAt(person: DemoPerson, at: number, model: Pick<DemoModel, "months" | "settings">): Trend {
  return trendOf(person.series, trendEnd(at, model.months.length), model.settings.trendMonths);
}

/** Month label, "Mar 2024". */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${year}`;
}

/** "today", "3 days", "5 weeks", "4 months", "2 years". */
export function durationLabel(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 540) return `${Math.round(days / 30.44)} months`;
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, "")} years`;
}
