// A made-up crowd for developing the map views: about 120 people with the
// shapes a real message history has (a few close friends, friendships that
// fade or start late, occasional contacts, people met only in group chats,
// deleted accounts, Marketplace sellers) and a dozen overlapping group chats,
// month by month from March 2024 to `end`. Deterministic for a given `end`.
// Every name is invented and every message text a made-up line (LINES), the
// same for a message's number every time, so the viewer has chats to read. The
// automatic archive rules take the deleted accounts, the Marketplace sellers
// and the group-only people in no small group (about half of them) off the
// map; four group-only people are archived
// by hand (tagged "archive") and one is kept on it (tagged "keep").
//
//   npm run testing-data -- /tmp/friend-map-crowd --crowd

import { type ArchiveEvent, CROWD_FIRST, CROWD_LAST, CROWD_SELF } from "../../../sdk/server.ts";
import type { SamplePerson } from "./samplePeople.ts";

/** One shape of friendship: how many messages a month over time (t from 0 to 1), and who writes more. */
interface Arc {
  kind: string;
  count: number;
  /** Direct messages per month at time t, before noise. */
  rate: (t: number, r: () => number) => number;
}

/** What the crowd says: made-up lines, one picked by each message's number (not the crowd's random, which they leave as it was). */
const LINES = [
  "are you around this weekend?", "yes! saturday works", "how did the climb go?", "running ten minutes late, sorry",
  "did you see the sunset tonight", "haha that's so good", "can you send me the recipe?", "on my way",
  "we should do the coast walk again", "thanks for yesterday, it was lovely", "what time is the game?", "I'll bring snacks",
  "the café on the corner opens at 8", "just finished the book, no spoilers", "happy birthday!! 🎉", "miss you, call soon?",
  "the train's delayed again", "sounds like a plan", "how's the new job going?", "lol", "ok see you there",
  "did the plants survive the heat?", "can't make it tonight, next week?", "that photo is amazing",
  "remind me which trail it was?", "good luck tomorrow!", "back home safe", "let's book the cabin before it fills up",
];

const ARCS: Arc[] = [
  { kind: "close", count: 7, rate: (t) => 90 + 50 * Math.sin(t * 6) },
  { kind: "rising", count: 7, rate: (t) => (t < 0.45 ? 0 : 140 * (t - 0.45)) },
  { kind: "fading", count: 9, rate: (t) => Math.max(0, 80 * (0.7 - t)) },
  { kind: "flare", count: 6, rate: (t) => 110 * Math.exp(-((t - 0.5) ** 2) / 0.01) },
  { kind: "steady", count: 14, rate: () => 14 },
  { kind: "occasional", count: 22, rate: (_t, r) => (r() < 0.18 ? 6 : 0) },
  { kind: "group-only", count: 52, rate: () => 0 },
];

/**
 * Group chats: a size, how busy (messages a month), the captain's share of
 * the messages (none in the choir and the neighbours' chat, most in the
 * housemates'), and which arcs its members come from.
 */
const GROUPS = [
  { key: "climbing", size: 9, busy: 70, mine: 0.2, from: ["close", "steady", "group-only"] },
  { key: "uni", size: 14, busy: 40, mine: 0.05, from: ["fading", "occasional", "group-only"] },
  { key: "work", size: 11, busy: 90, mine: 0.25, from: ["rising", "steady", "group-only"] },
  { key: "family", size: 7, busy: 30, mine: 0.3, from: ["close", "steady", "group-only"] },
  { key: "housemates", size: 4, busy: 60, mine: 0.35, from: ["close", "fading"] },
  { key: "book-club", size: 8, busy: 12, mine: 0.1, from: ["occasional", "group-only", "flare"] },
  { key: "footy", size: 16, busy: 50, mine: 0.02, from: ["group-only", "steady", "occasional"] },
  { key: "trip-2025", size: 6, busy: 45, mine: 0.3, from: ["flare", "close", "rising"] },
  { key: "choir", size: 20, busy: 25, mine: 0, from: ["group-only", "occasional"] },
  { key: "neighbours", size: 30, busy: 15, mine: 0, from: ["group-only", "occasional", "steady"] },
  { key: "old-team", size: 10, busy: 35, mine: 0.08, from: ["fading", "group-only"] },
  { key: "dinner-crew", size: 5, busy: 40, mine: 0.3, from: ["close", "rising", "flare"] },
];

const START = Date.parse("2024-03-01T00:00:00+11:00");

export interface Crowd {
  events: ArchiveEvent[];
  /** People the captain has named and tagged (see samplePeople.ts), each with their Messenger account. */
  people: SamplePerson[];
}

export function makeCrowd(end = Date.now()): Crowd {
  const random = mulberry32(20240301);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const events: ArchiveEvent[] = [{ kind: "account", key: CROWD_SELF, keyKind: "name", displayName: CROWD_SELF, isSelf: true }];

  const used = new Set<string>();
  const people: Array<{ name: string; arc: Arc; mine: number; phase: number }> = [];
  for (const arc of ARCS) {
    for (let i = 0; i < arc.count; i++) {
      let name = `${pick(CROWD_FIRST)} ${pick(CROWD_LAST)}`;
      while (used.has(name)) name = `${pick(CROWD_FIRST)} ${pick(CROWD_LAST)}`;
      used.add(name);
      // Who writes more: the captain's share of a direct chat, 0.2 to 0.8.
      people.push({ name, arc, mine: 0.2 + 0.6 * random(), phase: random() });
      events.push({ kind: "account", key: name, keyKind: "name", displayName: name });
    }
  }
  const unknown = ["Facebook user", "Facebook user", "Facebook user"].map((name, i) => ({ name, key: `${name} #${i + 1}` }));
  for (const { name, key } of unknown) events.push({ kind: "account", key, keyKind: "name", displayName: name });

  const months: number[] = [];
  for (let d = new Date(START); d.getTime() < end; d.setMonth(d.getMonth() + 1)) months.push(d.getTime());
  const span = Math.max(1, months.length - 1);
  let id = 0;
  const message = (conversation: string, sender: string, sentAt: number): ArchiveEvent => ({
    kind: "message", id: `crowd-${id++}`, idKind: "platform", conversation, sender, isFromSelf: sender === CROWD_SELF,
    sentAt, type: "text", text: LINES[(id * 7919) % LINES.length], raw: {},
  });
  const timeIn = (month: number) => Math.min(end - 60_000, month + Math.floor(random() * 30 * 86_400_000));

  for (const person of people) {
    const conversation = `direct:${person.name}`;
    const messages: ArchiveEvent[] = [];
    months.forEach((month, i) => {
      const t = i / span;
      const rate = person.arc.rate((t + person.phase * 0.08) % 1.0001, random) * (0.6 + 0.8 * random());
      // Talking comes in bursts: a month's messages fall on a few days.
      const n = Math.round(rate);
      const days = Array.from({ length: Math.max(1, Math.ceil(n / 12)) }, () => timeIn(month));
      for (let k = 0; k < n; k++) {
        const burst = days[k % days.length] + k * 45_000;
        if (burst >= end) continue;
        messages.push(message(conversation, random() < person.mine ? CROWD_SELF : person.name, burst));
      }
    });
    if (messages.length === 0) continue;
    events.push({ kind: "conversation", id: conversation, type: "direct", title: person.name, members: [CROWD_SELF, person.name] });
    events.push(...messages);
    reactTo(messages, person.name);
  }
  unknown.forEach(({ key }, i) => {
    const conversation = `direct:unknown-${i}`;
    events.push({ kind: "conversation", id: conversation, type: "direct", title: "Facebook user", members: [CROWD_SELF, key] });
    for (let k = 0; k < 3 + i * 4; k++) events.push(message(conversation, k % 2 ? CROWD_SELF : key, timeIn(months[2 + i * 5])));
  });

  for (const group of GROUPS) {
    const pool = people.filter((p) => group.from.includes(p.arc.kind));
    const members = new Set<string>();
    while (members.size < Math.min(group.size, pool.length)) members.add(pick(pool).name);
    const conversation = `group:${group.key}`;
    events.push({ kind: "conversation", id: conversation, type: "group", title: group.key, members: [CROWD_SELF, ...members] });
    const list = [...members];
    const from = Math.floor(random() * months.length * 0.4);
    const until = from + Math.ceil((months.length - from) * (0.5 + 0.5 * random()));
    for (let i = from; i < Math.min(until, months.length); i++) {
      const n = Math.round(group.busy * (0.4 + random()));
      const messages: ArchiveEvent[] = [];
      for (let k = 0; k < n; k++) {
        const at = timeIn(months[i]);
        // A few members do most of the talking.
        const sender = random() < group.mine ? CROWD_SELF : list[Math.floor(list.length * random() ** 2)];
        messages.push(message(conversation, sender, at));
      }
      events.push(...messages);
    }
  }

  // Marketplace chats with sellers met nowhere else, and one with a friend (it counts in nothing).
  const sellers = [["Opal Vendorly", "Road bike"], ["Rudi Vendorly", "Bookshelf"], ["Siv Vendorly", "Concert tickets"]];
  const closeFriend = people.find((p) => p.arc.kind === "close")!.name;
  [...sellers, [closeFriend, "Camping stove"]].forEach(([name, item], i) => {
    const conversation = `marketplace:${i}`;
    if (i < sellers.length) events.push({ kind: "account", key: name, keyKind: "name", displayName: name });
    events.push({
      kind: "conversation", id: conversation, type: "direct", title: `${name.split(" ")[0]} · ${item}`,
      members: [CROWD_SELF, name], marketplace: true,
    });
    for (let k = 0; k < 4; k++) events.push(message(conversation, k % 2 ? name : CROWD_SELF, timeIn(months[3 + i * 4]) + k * 60_000));
  });

  const named: SamplePerson[] = [
    ...people.filter((p) => p.arc.kind === "close").map((p) => ({ name: p.name, tags: [] })),
    ...people.filter((p) => p.arc.kind === "rising").slice(0, 3).map((p) => ({ name: p.name, tags: ["work"] })),
    ...people.filter((p) => p.arc.kind === "group-only").slice(0, 4).map((p) => ({ name: p.name, tags: ["archive"] })),
    ...people.filter((p) => p.arc.kind === "group-only").slice(4, 5).map((p) => ({ name: p.name, tags: ["keep"] })),
  ].map((person) => ({ ...person, accounts: [{ platform: "messenger", key: person.name }] }));
  return { events, people: named };

  function reactTo(messages: ArchiveEvent[], name: string) {
    for (const m of messages) {
      if (m.kind !== "message" || random() > 0.08) continue;
      const actor = m.sender === CROWD_SELF ? name : CROWD_SELF;
      events.push({ kind: "reaction", message: m.id, actor, emoji: pick(["❤️", "😂", "👍", "😮"]) });
    }
  }
}

/** A small seeded random number generator, so the crowd is the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LONG_START = Date.parse("2008-01-01T00:00:00+11:00");
const YEAR = 365.25 * 86_400_000;
const DAY_MS = 86_400_000;

/**
 * How long ago the long crowd last spoke with each person, in days: shares
 * shaped like a real Messenger history from 2008 (a few this week, a fifth
 * within the year, and over half last active five to eighteen years ago).
 */
const LAST_SPOKE: Array<{ share: number; from: number; to: number }> = [
  { share: 0.01, from: 0, to: 7 },
  { share: 0.035, from: 7, to: 30 },
  { share: 0.02, from: 30, to: 91 },
  { share: 0.2, from: 91, to: 365 },
  { share: 0.05, from: 365, to: 730 },
  { share: 0.15, from: 730, to: 1826 },
  { share: 0.28, from: 1826, to: 3652 },
  { share: 0.255, from: 3652, to: 6500 },
];

/**
 * A made-up long history for developing the map on a decade and more: about
 * 700 people talked with directly (both ways, so none is archived) from
 * January 2008 to `end`, most of them last active years ago, plus a couple of
 * hundred people met only in old group chats (archived by the rules).
 * Deterministic for a given `end`; every name is invented and every message a placeholder.
 *
 *   npm run testing-data -- /tmp/friend-map-long --long
 */
export function makeLongCrowd(end = Date.now(), { people: count = 700, groupOnly = 200 } = {}): Crowd {
  const random = mulberry32(20080101);
  const events: ArchiveEvent[] = [{ kind: "account", key: CROWD_SELF, keyKind: "name", displayName: CROWD_SELF, isSelf: true }];
  // Every first and last name pairing, shuffled; more than enough for everyone.
  const names = CROWD_FIRST.flatMap((first) => CROWD_LAST.map((last) => `${first} ${last}`))
    .map((name) => ({ name, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ name }) => name);
  if (count + groupOnly > names.length) throw new Error(`At most ${names.length} people`);
  let id = 0;
  const message = (conversation: string, sender: string, sentAt: number): ArchiveEvent => ({
    kind: "message", id: `long-${id++}`, idKind: "platform", conversation, sender, isFromSelf: sender === CROWD_SELF,
    sentAt, type: "text", text: "(placeholder)", raw: {},
  });

  const earliest = end - LONG_START;
  for (let i = 0; i < count; i++) {
    const name = names[i];
    events.push({ kind: "account", key: name, keyKind: "name", displayName: name });
    let u = random();
    const band = LAST_SPOKE.find((b) => (u -= b.share) < 0) ?? LAST_SPOKE.at(-1)!;
    const last = end - Math.min(earliest - DAY_MS, (band.from + (band.to - band.from) * random()) * DAY_MS);
    // Active for a few weeks to eight years before that, never before 2008.
    const first = Math.max(LONG_START, last - (0.05 + 8 * random() ** 2) * YEAR);
    // How much: most friendships are a few dozen messages, a few run to thousands.
    const n = Math.max(2, Math.round(Math.exp(2.5 + 2.2 * gaussian(random))));
    const mine = 0.2 + 0.6 * random();
    const conversation = `direct:${name}`;
    events.push({ kind: "conversation", id: conversation, type: "direct", title: name, members: [CROWD_SELF, name] });
    // Both write at least once, and the last message falls on `last`.
    events.push(message(conversation, CROWD_SELF, first), message(conversation, name, last - 60_000));
    for (let k = 2; k < n; k++) {
      const at = first + (last - first) * random() ** 0.8;
      events.push(message(conversation, random() < mine ? CROWD_SELF : name, Math.min(at, last - 60_000)));
    }
  }

  // Old group chats with people met nowhere else: they widen the history back to 2008 and are archived.
  for (let g = 0; g * 20 < groupOnly; g++) {
    const members = names.slice(count + g * 20, Math.min(count + groupOnly, count + (g + 1) * 20));
    for (const name of members) events.push({ kind: "account", key: name, keyKind: "name", displayName: name });
    const conversation = `group:old-${g}`;
    events.push({ kind: "conversation", id: conversation, type: "group", title: `old group ${g + 1}`, members: [CROWD_SELF, ...members] });
    const from = LONG_START + g * 0.4 * YEAR;
    for (let k = 0; k < 120; k++) events.push(message(conversation, members[k % members.length], from + random() * 0.8 * YEAR));
  }
  return { events, people: [] };
}

/** A standard normal draw (Box-Muller). */
function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}
