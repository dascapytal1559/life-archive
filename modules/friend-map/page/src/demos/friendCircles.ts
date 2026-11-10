// Friend circles: the order round the sun on the Circles page (the same map
// as Orbits, which goes A to Z). Distance from the
// sun stays closeness; only each person's direction changes, so that people
// who share group chats sit side by side, grouped into circles:
//
// - Ties: two people are tied by every group chat they share, each counting
//   more the smaller it is, 1 / (its people - 1) as a link's weight is
//   (you left out), but over everyone in it, on the map or not, and the
//   busier it is, 1 + log10(1 + its messages): a chat of three with
//   thousands of messages binds far more than a cohort of eighty that never wrote.
// - Circles: communities of those ties by Louvain (modularity), worked
//   through people in id order with every tie broken by id, so the same
//   people and chats always give the same circles: nothing random, and
//   nothing reshuffled on a reload.
// - Room: each person takes a share of the ring by how much they show on the
//   map, their presence: their tier's strength (TIERS) to the power
//   PRESENCE_POWER, so the closest ten take about 11 times the room of anyone
//   past the hundredth, who sit far out where the orbits are long. A circle's arc
//   is the sum of its people's, near the sun counting most, not its head count.
// - Balance: every circle of at least BIG_SHARE of everyone's presence (or,
//   with none, the biggest) gets a part of the ring of its own, the parts
//   sharing the circles' presence alike; each smaller circle joins the part
//   it is tied to most that is not yet full, else the emptiest. So the big
//   circles sit evenly round the ring, each in the middle of its part, with
//   smaller ones between them, and no side is crowded while another is empty.
// - Order: within a part, related circles side by side outward from its big
//   one, and the parts so related ones sit side by side; people within a
//   circle so the most tied sit side by side, and each circle turned so its
//   ends face the circles beside it; then everyone who shares no group chat
//   with anyone else on the map, together, A to Z, as a part of its own.
// - Gaps: CIRCLE_GAP spaces between circles and PART_GAP between parts (and
//   before the people in no chat), narrower when they would crowd the ring
//   (orbitsLayout.ts spread).
//
// Pure functions, no DOM; Orbits works this out once per change to who is
// on the map, never per frame.

import { ARCHIVE_TAG, KEEP_TAG } from "../archive.ts";
import { byName, tierOpacity } from "./orbitsLayout.ts";

/** A group chat, as the circles read it. */
export interface CircleGroup {
  id: number;
  /** Its people on the map, you left out. */
  memberIds: readonly number[];
  /** Everyone in it but you, on the map or not. */
  size: number;
  messageCount: number;
}

export interface Circle {
  /** Its people, in their order round the ring. */
  ids: number[];
  /** A tag most of them have and few others on the map do, to name it by (see circleLabel); null for none. */
  label: string | null;
}

export interface FriendCircles {
  /** Everyone, in order round the ring: each circle's people in turn, then `apart`. */
  order: number[];
  /** Each person's presence, in `order`: their share of the ring (orbitsLayout.ts spread). */
  weights: number[];
  circles: Circle[];
  /** Everyone who shares no group chat with anyone else on the map, A to Z. */
  apart: number[];
  /** The room left before each circle but the first, and before `apart`: where in `order`, and how many spaces (orbitsLayout.ts spread). */
  gaps: Gap[];
}

/** Who is tied to whom, and how strongly, both ways round. */
export type Ties = Map<number, Map<number, number>>;

/** Two weights this close are one: sums taken in another order differ in the last digits. */
const EPSILON = 1e-9;
/** How much the ends of a line count when choosing who goes beside it: the end itself fully, the one before it half, and so on. */
const END_WEIGHTS = [1, 0.5, 0.25];
/** A circle needs this many people before it is named. */
const LABELLED = 3;
/**
 * How steeply presence follows how strongly someone is drawn (tierOpacity). Steeper spreads the closest more
 * evenly round the ring but squeezes everyone far out into less room, pushing them off their orbits: on a made-up
 * crowd of 1,000, 2 balanced the closest 50 best but pushed the far-out 99th percentile 38 px further out, 1.5 only 11.
 */
export const PRESENCE_POWER = 1.5;
/** A circle with at least this share of everyone's presence gets a part of the ring of its own, the big ones spread evenly round it. */
export const BIG_SHARE = 0.05;
/** The room, in spaces (an average person's share of the ring), between two circles in one part... */
export const CIRCLE_GAP = 2;
/** ...and between two parts, and before the people in no chat: wider, so each big circle and its neighbours stand apart. */
export const PART_GAP = 6;

/** Room before the person at `at` in an order round the ring, in spaces. */
export interface Gap {
  at: number;
  spaces: number;
}

/** How much someone `place`th closest (null with no closeness yet) shows on the map: their share of the ring. */
export function presence(place: number | null): number {
  return tierOpacity(place) ** PRESENCE_POWER;
}

/**
 * How strongly one group chat ties each pair of its people: more the smaller
 * it is (its people you left out, on the map or not) and the busier.
 */
export function groupWeight(group: Pick<CircleGroup, "memberIds" | "size" | "messageCount">): number {
  const people = Math.max(group.size, group.memberIds.length);
  return (1 + Math.log10(1 + Math.max(0, group.messageCount))) / Math.max(1, people - 1);
}

/** Each pair of people on the map (`shown`) who share a group chat, and the sum of those chats' weights (groupWeight). */
export function circleTies(groups: readonly CircleGroup[], shown: ReadonlySet<number>): Ties {
  const ties: Ties = new Map();
  const add = (a: number, b: number, weight: number) => {
    const row = ties.get(a) ?? ties.set(a, new Map()).get(a)!;
    row.set(b, (row.get(b) ?? 0) + weight);
  };
  // In id order, so the sums are the same however the chats are listed.
  for (const group of [...groups].sort((a, b) => a.id - b.id)) {
    const members = [...new Set(group.memberIds)].filter((id) => shown.has(id)).sort((a, b) => a - b);
    if (members.length < 2) continue;
    const weight = groupWeight(group);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        add(members[i], members[j], weight);
        add(members[j], members[i], weight);
      }
    }
  }
  return ties;
}

/**
 * Communities of a weighted graph, by Louvain: each node in turn joins the
 * neighbouring community that raises modularity most, until none moves; then
 * each community becomes one node and it goes again, until nothing merges.
 * Nodes are 0 to n - 1, `graph[i]` their ties (both ways round, no ties to
 * themselves). Deterministic: nodes are taken in order, a node stays where it
 * is unless a move gains, and equal gains go to the community met first.
 * Returns each node's community, numbered from 0 in order of their first node.
 */
export function louvain(graph: ReadonlyArray<ReadonlyMap<number, number>>, resolution = 1): number[] {
  let membership = graph.map((_, i) => i);
  let level: ReadonlyArray<ReadonlyMap<number, number>> = graph;
  for (;;) {
    const community = settle(level, resolution);
    const number = new Map<number, number>();
    for (const c of community) if (!number.has(c)) number.set(c, number.size);
    if (number.size === level.length) break;
    membership = membership.map((c) => number.get(community[c])!);
    level = merge(level, community.map((c) => number.get(c)!), number.size);
  }
  return membership;
}

/** One level of Louvain: each node's community once moving any one of them gains nothing. */
function settle(graph: ReadonlyArray<ReadonlyMap<number, number>>, resolution: number): number[] {
  const degree = graph.map((ties) => [...ties.values()].reduce((sum, w) => sum + w, 0));
  const all = degree.reduce((sum, d) => sum + d, 0);
  const community = graph.map((_, i) => i);
  if (all === 0) return community;
  // Each community's degree: the sum of its nodes'.
  const total = [...degree];
  for (let pass = 0; pass < 100; pass++) {
    let moved = false;
    for (let i = 0; i < graph.length; i++) {
      const own = community[i];
      const toward = new Map<number, number>();
      for (const [j, w] of graph[i]) if (j !== i) toward.set(community[j], (toward.get(community[j]) ?? 0) + w);
      total[own] -= degree[i];
      const gain = (c: number) => (toward.get(c) ?? 0) - (resolution * total[c] * degree[i]) / all;
      let best = own;
      let bestGain = gain(own);
      for (const c of toward.keys()) {
        const g = gain(c);
        if (g > bestGain + EPSILON) [best, bestGain] = [c, g];
      }
      total[best] += degree[i];
      if (best !== own) {
        community[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
}

/** The graph of communities: each a node, tied to the others by the sum of its nodes' ties, and to itself by those within. */
function merge(graph: ReadonlyArray<ReadonlyMap<number, number>>, community: number[], count: number): Array<Map<number, number>> {
  const merged = Array.from({ length: count }, () => new Map<number, number>());
  graph.forEach((ties, i) => {
    const row = merged[community[i]];
    for (const [j, w] of ties) row.set(community[j], (row.get(community[j]) ?? 0) + w);
  });
  return merged;
}

/**
 * `items` in a line where each sits beside those it is tied to most: from
 * `start`, the next is whoever is tied most to either end of the line so far
 * (the end itself counting fully, the one before it half, and so on;
 * END_WEIGHTS), put at that end; with `oneEnded`, only ever on the right, so
 * `start` stays first. When nobody left is tied to an end, the one tied most
 * to anyone in the line goes on the right; nobody tied to the line at all,
 * the first of `items` left. Equal ties go right, then to whoever comes first
 * in `items`.
 */
export function line(items: readonly number[], ties: Ties, start: number, { oneEnded = false } = {}): number[] {
  const place = new Map(items.map((item, i) => [item, i]));
  const left = new Set(items);
  const ends: [number[], number[]] = [[], []];
  // How strongly each item left is tied to everyone in the line: the fallback.
  const toLine = new Map<number, number>();
  const put = (item: number, end: 0 | 1) => {
    left.delete(item);
    if (end === 0) ends[0].push(item);
    else ends[1].push(item);
    for (const [other, w] of ties.get(item) ?? []) if (left.has(other)) toLine.set(other, (toLine.get(other) ?? 0) + w);
  };
  const before = (a: number, b: number) => place.get(a)! < place.get(b)!;
  // The line runs ends[0] reversed, then ends[1]: the kth item in from one end, 0 being the end itself.
  const fromEnd = (end: 0 | 1, k: number) => {
    const [near, far] = [ends[end], ends[1 - end]];
    return k < near.length ? near[near.length - 1 - k] : far[k - near.length];
  };
  put(start, 1);
  while (left.size > 0) {
    const length = ends[0].length + ends[1].length;
    const tips = ([0, 1] as const).map((end) => Array.from({ length: Math.min(END_WEIGHTS.length, length) }, (_, k) => fromEnd(end, k)));
    let best: { item: number; end: 0 | 1; score: number } | null = null;
    for (const end of oneEnded ? ([1] as const) : ([1, 0] as const)) {
      const scores = new Map<number, number>();
      tips[end].forEach((tip, k) => {
        for (const [other, w] of ties.get(tip) ?? []) if (left.has(other)) scores.set(other, (scores.get(other) ?? 0) + w * END_WEIGHTS[k]);
      });
      for (const [item, score] of scores) {
        if (!best || score > best.score + EPSILON || (Math.abs(score - best.score) <= EPSILON && end === best.end && before(item, best.item))) {
          best = { item, end, score };
        }
      }
    }
    if (!best) {
      let item: number | null = null;
      for (const candidate of left) {
        const w = toLine.get(candidate) ?? 0;
        if (item === null || w > (toLine.get(item) ?? 0) + EPSILON || (Math.abs(w - (toLine.get(item) ?? 0)) <= EPSILON && before(candidate, item))) item = candidate;
      }
      best = { item: item!, end: 1, score: 0 };
    }
    put(best.item, best.end);
  }
  return [...ends[0]].reverse().concat(ends[1]);
}

/**
 * A part of the ring: `anchor` in the middle, and the rest of `circles`, the
 * most related to it first (line), each on whichever side has less `weight`
 * so far (the right of equals), so it stands apart from the parts beside it.
 */
function around(anchor: number, circles: readonly number[], between: Ties, weight: readonly number[]): number[] {
  const sides: [number[], number[]] = [[], []];
  const load = [0, 0];
  for (const c of line(circles, between, anchor, { oneEnded: true }).slice(1)) {
    const side = load[0] < load[1] - EPSILON ? 0 : 1;
    sides[side].push(c);
    load[side] += weight[c];
  }
  return [...sides[0].reverse(), anchor, ...sides[1]];
}

/**
 * The name for a circle: the tag most of its people have (at least half of
 * them, and two), and that is at least twice as common among them as on the
 * whole map, the commonest such; equal shares go to the rarer tag on the
 * map, then A to Z. Never archive or keep. Null for a circle of fewer than
 * LABELLED people, or with no such tag.
 */
export function circleLabel(members: ReadonlyArray<{ tags: readonly string[] }>, everyone: ReadonlyArray<{ tags: readonly string[] }>): string | null {
  if (members.length < LABELLED) return null;
  const count = (people: ReadonlyArray<{ tags: readonly string[] }>) => {
    const counts = new Map<string, number>();
    for (const person of people) for (const tag of new Set(person.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return counts;
  };
  const onMap = count(everyone);
  const candidates = [...count(members)]
    .filter(([tag, n]) => tag !== ARCHIVE_TAG && tag !== KEEP_TAG && n >= 2 && n * 2 >= members.length)
    .map(([tag, n]) => ({ tag, share: n / members.length, lift: n / members.length / ((onMap.get(tag) ?? n) / Math.max(1, everyone.length)) }))
    .filter((c) => c.lift >= 2 - EPSILON)
    .sort((a, b) => b.share - a.share || b.lift - a.lift || a.tag.localeCompare(b.tag));
  return candidates[0]?.tag ?? null;
}

/**
 * Everyone on the map in friend-circle order, with each person's share of the
 * ring and the gaps between circles (see the top of this file). `presence` is
 * how much each person shows on the map; anyone not in it counts 1.
 */
export function friendCircles(
  people: ReadonlyArray<{ id: number; name: string; tags: readonly string[] }>,
  groups: readonly CircleGroup[],
  presence: ReadonlyMap<number, number> = new Map(),
): FriendCircles {
  const shown = new Set(people.map((p) => p.id));
  const ties = circleTies(groups, shown);
  const tied = [...ties.keys()].sort((a, b) => a - b);
  const index = new Map(tied.map((id, i) => [id, i]));
  const community = louvain(tied.map((id) => new Map([...ties.get(id)!].map(([other, w]) => [index.get(other)!, w]))));

  // Each circle's people, in id order; and how strongly each circle is tied to each other one.
  const members: number[][] = [];
  tied.forEach((id, i) => (members[community[i]] ??= []).push(id));
  const circleOf = new Map(tied.map((id, i) => [id, community[i]]));
  const between: Ties = new Map();
  const within = members.map(() => 0);
  for (const [a, row] of ties) {
    for (const [b, w] of row) {
      const [ca, cb] = [circleOf.get(a)!, circleOf.get(b)!];
      if (ca === cb) {
        within[ca] += w;
        continue;
      }
      const tie = between.get(ca) ?? between.set(ca, new Map()).get(ca)!;
      tie.set(cb, (tie.get(cb) ?? 0) + w);
    }
  }
  // How related two circles are: the ties between them for their sizes, so a small circle that mostly ties to a big
  // one counts as related to it.
  for (const [ca, row] of between) for (const [cb, w] of row) row.set(cb, w / Math.sqrt(members[ca].length * members[cb].length));

  // How much each circle shows: its people's presence. The big ones each get a part of the ring, sharing the circles'
  // presence alike; the rest, biggest first, join the part they are tied to most that is not yet full, else the
  // emptiest (the first of equals).
  const weigh = (ids: readonly number[]) => ids.reduce((sum, id) => sum + (presence.get(id) ?? 1), 0);
  const weight = members.map(weigh);
  const apart = people.filter((p) => !ties.has(p.id)).sort(byName).map((p) => p.id);
  const everyone = weight.reduce((sum, w) => sum + w, 0) + weigh(apart);
  const circleIds = members.map((_, c) => c);
  const bySize = [...circleIds].sort((a, b) => weight[b] - weight[a] || members[b].length - members[a].length || within[b] - within[a] || a - b);
  const big = bySize.filter((c) => weight[c] >= BIG_SHARE * everyone - EPSILON);
  const anchors = big.length > 0 ? big : bySize.slice(0, 1);
  const parts = anchors.map((c) => ({ anchor: c, circles: [c], weight: weight[c] }));
  const full = (everyone - weigh(apart)) / Math.max(1, parts.length);
  for (const c of bySize) {
    if (anchors.includes(c)) continue;
    const tie = (part: (typeof parts)[number]) => part.circles.reduce((sum, other) => sum + (between.get(c)?.get(other) ?? 0), 0);
    let to: (typeof parts)[number] | null = null;
    for (const part of parts) if (part.weight < full - EPSILON && tie(part) > EPSILON && (!to || tie(part) > tie(to) + EPSILON)) to = part;
    to ??= parts.reduce((least, part) => (part.weight < least.weight - EPSILON ? part : least));
    to.circles.push(c);
    to.weight += weight[c];
  }
  // Within a part, its big one in the middle and the rest on either side; the parts so related ones sit side by side,
  // from the biggest's.
  const partTies: Ties = new Map(parts.map((_, i) => [i, new Map<number, number>()]));
  parts.forEach((part, i) => parts.forEach((other, j) => {
    if (i === j) return;
    const w = part.circles.reduce((sum, a) => sum + other.circles.reduce((s, b) => s + (between.get(a)?.get(b) ?? 0), 0), 0);
    if (w > 0) partTies.get(i)!.set(j, w);
  }));
  const partOrder = parts.length > 0 ? line(parts.map((_, i) => i), partTies, 0) : [];
  const runs = partOrder.map((i) => around(parts[i].anchor, parts[i].circles, between, weight));
  const ring = runs.flat();

  // Within each circle, the most tied side by side. A circle tied to the one before it starts from whoever is tied
  // most to that one, so the two meet where they are tied; else one tied to the circle after it ends on whoever is
  // tied most to that one; any other grows both ways from whoever is tied most within it.
  const tiesWithin = (ids: number[]): Ties => {
    const inside = new Set(ids);
    return new Map(ids.map((id) => [id, new Map([...ties.get(id)!].filter(([other]) => inside.has(other)))]));
  };
  const toCircle = (id: number, c: number | undefined) =>
    c === undefined ? 0 : members[c].reduce((sum, other) => sum + (ties.get(id)?.get(other) ?? 0), 0);
  const strongest = (ids: number[], strength: (id: number) => number) =>
    ids.reduce((best, id) => (strength(id) > strength(best) + EPSILON ? id : best), Math.min(...ids));
  const lines = ring.map((c, i) => {
    const [prev, next] = [ring[i - 1], ring[i + 1]];
    const ids = [...members[c]];
    const among = tiesWithin(ids);
    const back = strongest(ids, (id) => toCircle(id, prev));
    if (toCircle(back, prev) > EPSILON) return line(ids, among, back, { oneEnded: true });
    const on = strongest(ids, (id) => toCircle(id, next));
    if (toCircle(on, next) > EPSILON) return line(ids, among, on, { oneEnded: true }).reverse();
    return line(ids, among, strongest(ids, (id) => [...among.get(id)!.values()].reduce((sum, w) => sum + w, 0)));
  });

  const byId = new Map(people.map((p) => [p.id, p]));
  const circles = lines.map((ids) => ({ ids, label: circleLabel(ids.map((id) => byId.get(id)!), people) }));
  // A part's first circle, and the people in no chat, come after a part gap; any other circle after a circle gap.
  const partStarts = new Set(runs.map((run) => run[0]));
  const gaps: Gap[] = [];
  let at = 0;
  lines.forEach((ids, i) => {
    if (at > 0) gaps.push({ at, spaces: partStarts.has(ring[i]) ? PART_GAP : CIRCLE_GAP });
    at += ids.length;
  });
  if (at > 0 && apart.length > 0) gaps.push({ at, spaces: PART_GAP });
  const order = [...lines.flat(), ...apart];
  return { order, weights: order.map((id) => presence.get(id) ?? 1), circles, apart, gaps };
}
