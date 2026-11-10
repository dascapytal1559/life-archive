// The viewer's People tab: everyone the archive lists (the SQL views' `people`: anyone with an account, or whom the
// captain has edited; never the captain), one row each: their name, platforms, accounts, tags, location, whether they
// are hidden and by whom, their first and last message, call or hangout, and how many messages, calls and hangouts
// there were with them. Searched by any of their names, filtered by tag, platform and hidden, and charted as how many
// people were active (a message, call or hangout with them) in each bucket, or how many were new (their first). The
// time range narrows the table to those active in it, and its counts to what was in it.
//
// How it stays quick over a large archive (say 20,000 people and a million messages), in two things kept (memo.ts)
// until the archive's people, links, messages, chats, calls or hangouts change (version), or ten minutes pass:
//   - the people, read once from the people view;
//   - the activity: every hour each person had a message with the captain (a one-to-one chat's messages either way,
//     what they sent in a group; Marketplace, dropped chats and notices aside), read in one pass over the message_time
//     index grouped by hour (cut at local midnight, which in some zones falls within one), chat and sender (a few
//     hundred thousand rows at that size, under a second), with every call (person_call) and hangout,
//     in time order. Ranges, buckets and counts are then worked out here, by the hour, without asking the archive again.

import { archiveOf } from "./reads.ts";
import type { DatabaseSync } from "node:sqlite";
import { chartBuckets, type DetailField, type EditField, type FacetValue, type Filters, HANGOUT, type KindSpec, LIVE_TOGETHER_TAG, LOCALE, Memo, MOST_FACET_VALUES, nameKey, NotFoundError, only, type Page, type Row, type RowDetail, type RowsAnswer, type Tab, type VolumeAnswer, volumeAnswer, type VolumeAsk } from "../../../../sdk/server.ts";
import { byCloseness, scoreLabel } from "../../page/src/demos/closeness.ts";
import { closenessOf } from "./closeness.ts";
import { chatLookup } from "./messagesTab.ts";

const APPS: Record<string, string> = {
  messenger: "Messenger", wechat: "WeChat", telegram: "Telegram", whatsapp: "WhatsApp", instagram: "Instagram", imessage: "iMessage",
  signal: "Signal", discord: "Discord", x: "X", phone: "Phone",
};
/** Whether someone is hidden, and by whom: the captain (the archive tag) or the archive rules. */
const HIDDEN: Record<string, string> = { shown: "Shown", you: "Hidden by you", rules: "Hidden by the rules" };
/** The Tag filter's value for someone with no tag. */
const NO_TAG = "-";

/** A person's kind in the record of edits (their row's key: server/edits/editor.ts's EditRow). */
export const PERSON_ROW = "person";

/** The Hidden field's values: the "archive" tag, the "keep" tag (shown whatever the archive rules say), or neither. */
export const HIDDEN_YOU = "hidden";
export const HIDDEN_SHOWN = "shown";
export const HIDDEN_RULES = "rules";

/** What Add person asks (the Table's Add person's form): a name, and where they are, their tags and a note if wanted. */
const NEW_PERSON: EditField[] = [
  { key: "name", label: "Name", input: "text" },
  { key: "location", label: "Location", input: "text", clearable: true, suggests: true },
  { key: "tags", label: "Tags", input: "tags", suggests: true },
  { key: "note", label: "Note", input: "text", long: true, clearable: true },
];

const SPEC: KindSpec = {
  kind: "people",
  label: "People",
  noun: ["person", "people"],
  columns: [
    { key: "name", label: "Name", kind: "text", width: 200, sortable: true },
    { key: "tags", label: "Tags", kind: "text", width: 190 },
    { key: "location", label: "Location", kind: "text", width: 130 },
    { key: "platforms", label: "Platforms", kind: "text", width: 170 },
    { key: "accounts", label: "Accounts", kind: "count", width: 85, numeric: true, sortable: true },
    { key: "hidden", label: "Hidden", kind: "text", width: 160 },
    { key: "closeness", label: "Closeness", kind: "text", width: 110, numeric: true, sortable: true },
    { key: "first", label: "First", kind: "time", width: 175, sortable: true },
    { key: "last", label: "Last", kind: "time", width: 175, sortable: true },
    { key: "messages", label: "Messages", kind: "count", width: 95, numeric: true, sortable: true },
    { key: "direct", label: "Direct", kind: "count", width: 80, numeric: true, sortable: true },
    { key: "calls", label: "Calls", kind: "count", width: 70, numeric: true, sortable: true },
    { key: "hangouts", label: HANGOUT.Many, kind: "count", width: 90, numeric: true, sortable: true },
    { key: "added", label: "Added", kind: "time", width: 175, sortable: true },
    { key: "note", label: "Note", kind: "text", width: 260 },
  ],
  // Friend Map's Table, the person panel's fields and the tag manager's, through People's own writes (../peopleEdits.ts).
  edits: [
    { key: "name", label: "Name", input: "text" },
    { key: "aliases", label: "Also called", input: "tags" },
    { key: "tags", label: "Tags", input: "tags", suggests: true },
    { key: "location", label: "Location", input: "text", clearable: true, suggests: true },
    {
      key: "hidden", label: "Hidden", input: "choice", choices: [
        { value: HIDDEN_RULES, label: "As the archive rules say" },
        { value: HIDDEN_YOU, label: "Hidden (the archive tag)" },
        { value: HIDDEN_SHOWN, label: "Shown, whatever the rules say (the keep tag)" },
      ],
    },
    { key: "reach", label: "Reach out", input: "choice", choices: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] },
    { key: "note", label: "Note", input: "text", long: true, clearable: true },
  ],
  // People he added by hand, with no accounts, are his own: Add person adds one; anyone from his chats is never deleted.
  own: { add: NEW_PERSON, deletes: "people you added, with no accounts" },
  filters: [
    { key: "tag", label: "Tag", kind: "choice", find: "Find a tag" },
    { key: "platform", label: "Platform", kind: "choice" },
    { key: "hidden", label: "Hidden", kind: "choice" },
  ],
  measures: [
    { key: "active", label: "Active people", unit: "count" },
    { key: "new", label: "New people", unit: "count" },
  ],
  sort: "last",
  splits: ["hidden"],
  search: "Find by name",
};

interface Person {
  id: number;
  name: string;
  aliases: string[];
  tags: string[];
  /** HIDDEN's key. */
  hidden: string;
  /** The rule that hides them, when the rules do. */
  rule: string | null;
  location: string | null;
  platforms: string[];
  accounts: number;
  /** His note for them ("" for none): no content, as names and tags are not. */
  note: string;
  /** Whether they are to be reached out to. */
  reach: boolean;
  /** When they were added to the archive, by an import or by him. */
  added: number;
  /** Every name of theirs as nameKey writes it, for the search. */
  keys: string[];
}

/** A message in a group chat (theirs), one in a one-to-one chat (either way), a call, a hangout. */
const MESSAGE = 0;
const CALL = 1;
const HANGOUT_EVENT = 2;
const DIRECT = 3;

/** Every message hour, call and hangout with someone (see the top), in time order. */
interface Activity {
  at: Float64Array;
  /** The last message of a message hour; a call's or hangout's own time. */
  end: Float64Array;
  person: Int32Array;
  what: Uint8Array;
  /** A message hour's messages; 1 for a call or a hangout. */
  n: Uint32Array;
}

/** What there was with each person in a range: messages (and of them, in one-to-one chats), calls, hangouts, and the first and last. */
interface Tally {
  messages: number;
  direct: number;
  calls: number;
  hangouts: number;
  first: number;
  last: number;
}

const memo = new Memo(64);

/** The state of the archive the tab's answers depend on (see the top). */
function versionOf(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT (SELECT value FROM meta WHERE key = 'people_version') AS people, (SELECT value FROM meta WHERE key = 'links_version') AS links,
      (SELECT max(id) FROM message) AS messages, (SELECT max(id) FROM conversation) AS chats, (SELECT count(*) FROM conversation_member) AS members,
      (SELECT max(id) FROM call) AS calls, (SELECT count(*) || '-' || coalesce(max(id), 0) FROM manual_call) AS logged,
      (SELECT count(*) || '-' || coalesce(max(id), 0) FROM catch_up) AS hangouts, (SELECT count(*) FROM catch_up_person) AS at_hangouts,
      (SELECT count(*) FROM person_tag) AS tagged`)
    .get() as Record<string, string | number | null>;
  return [...Object.values(row), Math.floor(Date.now() / 600_000)].join(".");
}

function peopleOf(db: DatabaseSync, version: string): Map<number, Person> {
  return memo.get(version, "people", () => {
    const rows = db
      .prepare(`SELECT pv.person_id AS id, pv.name, pv.aliases, pv.archived_by, pv.location, pv.platforms, pv.accounts, pv.note, pv.should_reach_out, p.created_at,
          (SELECT json_group_array(x.name) FROM (SELECT t.name FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.person_id = pv.person_id ORDER BY t.sort_order) x) AS tags
        FROM people pv JOIN person p ON p.id = pv.person_id`)
      .all() as Array<{ id: number; name: string; aliases: string; archived_by: string | null; location: string | null; platforms: string | null; accounts: number; note: string; should_reach_out: number; created_at: number; tags: string }>;
    return new Map(rows.map((row) => {
      const aliases = JSON.parse(row.aliases) as string[];
      const name = row.name.trim() || `Person ${row.id}`;
      return [row.id, {
        id: row.id, name, aliases, tags: JSON.parse(row.tags) as string[],
        hidden: row.archived_by === null ? "shown" : row.archived_by === "you" ? "you" : "rules",
        rule: row.archived_by === null || row.archived_by === "you" ? null : row.archived_by,
        location: row.location, platforms: row.platforms ? row.platforms.split(",") : [], accounts: row.accounts,
        note: row.note ?? "", reach: row.should_reach_out === 1, added: row.created_at,
        keys: [name, ...aliases].map(nameKey),
      }];
    }));
  });
}

function activityOf(db: DatabaseSync, version: string): Activity {
  return memo.get(version, "activity", () => {
    const lookup = chatLookup(db);
    const at: number[] = [];
    const end: number[] = [];
    const person: number[] = [];
    const what: number[] = [];
    const n: number[] = [];
    const add = (when: number, until: number, who: number, kind: number, count: number) => {
      at.push(when);
      end.push(until);
      person.push(who);
      what.push(kind);
      n.push(count);
    };
    const hours = db.prepare(`SELECT min(sent_at), max(sent_at), conversation_id, sender_account_id, count(*) FROM message INDEXED BY message_time
      WHERE type != 'system' GROUP BY sent_at / 3600000, day(sent_at), conversation_id, sender_account_id`);
    hours.setReturnArrays(true);
    for (const [first, last, chatId, sender, count] of hours.iterate() as Iterable<[number, number, number, number | null, number]>) {
      const chat = lookup.chats.get(chatId);
      if (!chat || chat.dropped || chat.kind === "marketplace") continue;
      const who = chat.kind === "direct" ? chat.other : sender === null || lookup.self.has(sender) ? null : (lookup.personOf.get(sender) ?? null);
      if (who !== null) add(first, last, who, chat.kind === "direct" ? DIRECT : MESSAGE, count);
    }
    for (const row of db.prepare("SELECT at, person_id FROM person_call").all() as Array<{ at: number; person_id: number }>) add(row.at, row.at, row.person_id, CALL, 1);
    const hangouts = db.prepare("SELECT wall_clock(c.day, c.time) AS at, cp.person_id FROM catch_up_person cp JOIN catch_up c ON c.id = cp.catch_up_id").all() as
      Array<{ at: number; person_id: number }>;
    for (const row of hangouts) add(row.at, row.at, row.person_id, HANGOUT_EVENT, 1);
    const order = Array.from(at, (_, i) => i).sort((a, b) => at[a] - at[b]);
    return {
      at: Float64Array.from(order, (i) => at[i]),
      end: Float64Array.from(order, (i) => end[i]),
      person: Int32Array.from(order, (i) => person[i]),
      what: Uint8Array.from(order, (i) => what[i]),
      n: Uint32Array.from(order, (i) => n[i]),
    };
  });
}

/** The first index of `times` (ascending) at or after `t`. */
function firstAtOrAfter(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The activity's indexes in [from, to) (null for no bound). */
function span(activity: Activity, from: number | null, to: number | null): [number, number] {
  return [from === null ? 0 : firstAtOrAfter(activity.at, from), to === null ? activity.at.length : firstAtOrAfter(activity.at, to)];
}

/** What there was with each person in [from, to), kept. */
function talliesOf(db: DatabaseSync, version: string, from: number | null, to: number | null): Map<number, Tally> {
  return memo.get(version, `tallies ${from} ${to}`, () => {
    const activity = activityOf(db, version);
    const tallies = new Map<number, Tally>();
    const [start, stop] = span(activity, from, to);
    for (let i = start; i < stop; i++) {
      const who = activity.person[i];
      let tally = tallies.get(who);
      if (!tally) tallies.set(who, (tally = { messages: 0, direct: 0, calls: 0, hangouts: 0, first: activity.at[i], last: activity.end[i] }));
      if (activity.what[i] === MESSAGE) tally.messages += activity.n[i];
      else if (activity.what[i] === DIRECT) (tally.messages += activity.n[i]), (tally.direct += activity.n[i]);
      else if (activity.what[i] === CALL) tally.calls++;
      else tally.hangouts++;
      tally.last = Math.max(tally.last, activity.end[i]);
    }
    return tallies;
  });
}

/** Each filter's own test of a person, for those that narrow (but the one keyed `except`). */
function personTest(db: DatabaseSync, version: string, filters: Filters, except?: string): (person: Person) => boolean {
  const tests: Array<(person: Person) => boolean> = [];
  const tags = except === "tag" ? undefined : filters.choices.tag;
  if (tags) tests.push((p) => tags.some((tag) => (tag === NO_TAG ? p.tags.length === 0 : p.tags.includes(tag))));
  const platforms = except === "platform" ? undefined : filters.choices.platform;
  if (platforms) tests.push((p) => platforms.some((platform) => p.platforms.includes(platform)));
  const hidden = except === "hidden" ? undefined : filters.choices.hidden;
  if (hidden) tests.push((p) => hidden.includes(p.hidden));
  if (filters.search !== null) {
    const needle = nameKey(filters.search);
    tests.push((p) => p.keys.some((key) => key.includes(needle)));
  }
  if (filters.from !== null || filters.to !== null) {
    const active = talliesOf(db, version, filters.from, filters.to);
    tests.push((p) => active.has(p.id));
  }
  return (person) => tests.every((test) => test(person));
}

/** A key for the filters, the same however they were written. */
function filtersKey(filters: Filters): string {
  const choices = Object.entries(filters.choices).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]);
  return JSON.stringify([filters.from, filters.to, filters.search, choices]);
}

/** Everyone's closeness now (closeness.ts), kept with the rest; empty when no friend map is open to score them. */
function scoresOf(db: DatabaseSync, version: string): ReadonlyMap<number, number> {
  return memo.get(version, "closeness", () => closenessOf(db) ?? new Map<number, number>());
}

/** What one person's row is drawn and sorted from: what was with them in the range and ever, and their closeness. */
interface Known {
  tally: Tally | undefined;
  ever: Tally | undefined;
  closeness: number;
}

/** What each sortable column sorts by: a number, or null (always last). */
const SORTS: Record<string, (person: Person, known: Known) => number | null> = {
  accounts: (p) => p.accounts,
  closeness: (_, { closeness }) => closeness,
  first: (_, { ever }) => ever?.first ?? null,
  last: (_, { ever }) => ever?.last ?? null,
  messages: (_, { tally }) => tally?.messages ?? 0,
  direct: (_, { tally }) => tally?.direct ?? 0,
  calls: (_, { tally }) => tally?.calls ?? 0,
  hangouts: (_, { tally }) => tally?.hangouts ?? 0,
  added: (p) => p.added,
};

const collator = new Intl.Collator(LOCALE, { sensitivity: "base", numeric: true });

/** What is known of each person for their row, over the filters' range. */
function knownOf(db: DatabaseSync, version: string, filters: Filters): (person: Person) => Known {
  const tallies = talliesOf(db, version, filters.from, filters.to);
  const ever = talliesOf(db, version, null, null);
  const scores = scoresOf(db, version);
  return (person) => ({ tally: tallies.get(person.id), ever: ever.get(person.id), closeness: scores.get(person.id) ?? 0 });
}

/** Everyone the filters leave, in the page's order, kept. */
function listed(db: DatabaseSync, version: string, filters: Filters, sort: string, direction: "asc" | "desc"): Person[] {
  return memo.get(version, `list ${filtersKey(filters)} ${sort} ${direction}`, () => {
    const passes = personTest(db, version, filters);
    const known = knownOf(db, version, filters);
    const sign = direction === "asc" ? 1 : -1;
    const byName = (a: Person, b: Person) => collator.compare(a.name, b.name) || a.id - b.id;
    const people = [...peopleOf(db, version).values()].filter(passes);
    if (sort === "name") return people.sort((a, b) => sign * byName(a, b));
    const value = SORTS[sort];
    const keyed = people.map((p) => [p, value(p, known(p))] as const);
    keyed.sort(([a, x], [b, y]) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : sign * (x - y)) || byName(a, b));
    return keyed.map(([p]) => p);
  });
}

/**
 * Each person's rank by closeness among the people the filters leave but the search (as Friend Map's Table ranked the
 * people it showed): whoever he lives with first, then by score; nobody with no score is ranked. Kept.
 */
function ranksOf(db: DatabaseSync, version: string, filters: Filters): Map<number, number> {
  const unsearched = { ...filters, search: null };
  return memo.get(version, `ranks ${filtersKey(unsearched)}`, () => {
    const scores = scoresOf(db, version);
    const passes = personTest(db, version, unsearched);
    const together = (p: Person) => p.tags.includes(LIVE_TOGETHER_TAG);
    const score = (p: Person) => scores.get(p.id) ?? 0;
    return new Map([...peopleOf(db, version).values()]
      .filter((p) => passes(p) && (together(p) || score(p) > 0))
      .sort((a, b) => byCloseness(together(a), score(a), a.id, together(b), score(b), b.id))
      .map((p, i) => [p.id, i + 1]));
  });
}

/** A person's row: what was with them in the range (`known.tally`) and ever (their first and last), their closeness and its rank. */
function rowOf(person: Person, known: Known, rank: number | undefined): Row {
  const { tally, ever, closeness } = known;
  return {
    id: String(person.id),
    cells: {
      name: person.name,
      tags: person.tags.join(", ") || null,
      location: person.location,
      platforms: person.platforms.map((platform) => APPS[platform] ?? platform).join(", ") || null,
      accounts: person.accounts,
      hidden: person.hidden === "shown" ? null : person.hidden === "you" ? "By you" : `By the rules (${person.rule})`,
      closeness: closeness > 0 || rank !== undefined ? `${scoreLabel(closeness)}${rank === undefined ? "" : `  #${rank.toLocaleString(LOCALE)}`}` : null,
      first: ever?.first ?? null,
      last: ever?.last ?? null,
      messages: tally?.messages ?? 0,
      direct: tally?.direct ?? 0,
      calls: tally?.calls ?? 0,
      hangouts: tally?.hangouts ?? 0,
      added: person.added,
      note: person.note || null,
    },
  };
}

function rows(db: DatabaseSync, filters: Filters, page: Page): RowsAnswer {
  const version = versionOf(db);
  const people = listed(db, version, filters, page.sort, page.direction);
  const known = knownOf(db, version, filters);
  const ranks = ranksOf(db, version, filters);
  const shown = people.slice(page.offset, page.offset + page.limit).map((person) => rowOf(person, known(person), ranks.get(person.id)));
  return { total: people.length, offset: page.offset, rows: shown, people: {}, next: null };
}

/**
 * How many people the filters leave were active in each bucket (a message, call or hangout with them), or new (their
 * first ever falling in it); split, by whether they are hidden. The buckets span the filters' range, or the people's
 * first activity to their last.
 */
function volume(db: DatabaseSync, filters: Filters, ask: VolumeAsk): VolumeAnswer {
  const version = versionOf(db);
  const activity = activityOf(db, version);
  const people = peopleOf(db, version);
  const passes = personTest(db, version, filters);
  const allowed = new Set([...people.values()].filter(passes).map((p) => p.id));
  const ever = talliesOf(db, version, null, null);
  let first: number | null = null;
  let last: number | null = null;
  for (const id of allowed) {
    const tally = ever.get(id);
    if (!tally) continue;
    if (first === null || tally.first < first) first = tally.first;
    if (last === null || tally.last > last) last = tally.last;
  }
  const chosen = chartBuckets(filters, { first, last }, ask.grain, ask.begins);
  if (chosen === null) return volumeAnswer(ask, null, () => 0);
  const keyOf = (id: number) => (ask.split === null ? "" : people.get(id)!.hidden);
  const counts = chosen.edges.map((edge) => {
    const parts = new Map<string, number>();
    if (ask.measure === "new") {
      for (const id of allowed) {
        const at = ever.get(id)?.first;
        if (at !== undefined && at >= edge.start && at < edge.end) parts.set(keyOf(id), (parts.get(keyOf(id)) ?? 0) + 1);
      }
    } else {
      const seen = new Set<number>();
      const [start, stop] = span(activity, edge.start, edge.end);
      for (let i = start; i < stop; i++) {
        const id = activity.person[i];
        if (seen.has(id) || !allowed.has(id)) continue;
        seen.add(id);
        parts.set(keyOf(id), (parts.get(keyOf(id)) ?? 0) + 1);
      }
    }
    return parts;
  });
  const answer =
    ask.split === null ? volumeAnswer(ask, chosen, (i) => counts[i].get("") ?? 0) : volumeAnswer(ask, chosen, (i) => counts[i], (value) => HIDDEN[value] ?? value, Object.keys(HIDDEN));
  if (ask.measure === "new") return answer;
  // Someone active in many buckets is one person over the chart: its totals count each once.
  const whole = new Map<string, number>();
  const [start, stop] = span(activity, chosen.edges[0].start, chosen.edges.at(-1)!.end);
  const seen = new Set<number>();
  for (let i = start; i < stop; i++) {
    const id = activity.person[i];
    if (seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    whole.set(keyOf(id), (whole.get(keyOf(id)) ?? 0) + 1);
  }
  return { ...answer, total: seen.size, ...(ask.split === null ? {} : { seriesTotals: answer.series.map((s) => whole.get(s.value) ?? 0) }) };
}

/** Each filter's values under every other filter, with how many people have each; a value chosen is listed even with none. */
function facets(db: DatabaseSync, filters: Filters): Record<string, FacetValue[]> {
  const version = versionOf(db);
  const people = [...peopleOf(db, version).values()];
  const tagOrder = new Map((db.prepare("SELECT name, sort_order FROM tag").all() as Array<{ name: string; sort_order: number }>).map((row) => [row.name, row.sort_order]));
  const counted = (key: string, valuesOf: (p: Person) => string[]) => {
    const passes = personTest(db, version, filters, key);
    const counts = new Map<string, number>();
    for (const person of people) if (passes(person)) for (const value of valuesOf(person)) counts.set(value, (counts.get(value) ?? 0) + 1);
    for (const value of filters.choices[key] ?? []) if (!counts.has(value)) counts.set(value, 0);
    return counts;
  };
  const list = (counts: Map<string, number>, label: (value: string) => string, order: (a: string, b: string) => number) =>
    [...counts].sort(([a], [b]) => order(a, b)).slice(0, MOST_FACET_VALUES).map(([value, count]) => ({ value, label: label(value), count }));
  const byCount = (counts: Map<string, number>) => (a: string, b: string) => counts.get(b)! - counts.get(a)! || a.localeCompare(b);
  const tags = counted("tag", (p) => (p.tags.length === 0 ? [NO_TAG] : p.tags));
  const platforms = counted("platform", (p) => p.platforms);
  const hidden = counted("hidden", (p) => [p.hidden]);
  return {
    // Tags in the captain's order, as friend-map lists them; no tag at the end.
    tag: list(tags, (value) => (value === NO_TAG ? "No tag" : value), (a, b) => (tagOrder.get(a) ?? Infinity) - (tagOrder.get(b) ?? Infinity) || a.localeCompare(b)),
    platform: list(platforms, (value) => APPS[value] ?? value, byCount(platforms)),
    hidden: list(hidden, (value) => HIDDEN[value] ?? value, (a, b) => Object.keys(HIDDEN).indexOf(a) - Object.keys(HIDDEN).indexOf(b)),
  };
}

/**
 * One person for their drawer: their row (counts over their whole history), their aliases, accounts and the hours of
 * their hangouts; their messages, calls and hangouts, to open.
 */
function detail(db: DatabaseSync, id: string): RowDetail {
  const version = versionOf(db);
  const person = /^\d+$/.test(id) ? peopleOf(db, version).get(Number(id)) : undefined;
  if (!person) throw new NotFoundError(`no person ${JSON.stringify(id)} in the People tab`);
  const ever = talliesOf(db, version, null, null).get(person.id);
  const row = rowOf(person, { tally: ever, ever, closeness: scoresOf(db, version).get(person.id) ?? 0 }, ranksOf(db, version, only({})).get(person.id));
  const accounts = db
    .prepare("SELECT platform, display_name FROM import_person WHERE person_id = ? AND is_self = 0 ORDER BY platform, display_name")
    .all(person.id) as Array<{ platform: string; display_name: string }>;
  const hours = (db.prepare("SELECT coalesce(sum(c.hours), 0) AS hours FROM catch_up_person cp JOIN catch_up c ON c.id = cp.catch_up_id WHERE cp.person_id = ?")
    .get(person.id) as { hours: number }).hours;
  const more: DetailField[] = [
    { label: "Also called", kind: "text", value: person.aliases.join(", ") || null, key: "aliases" },
    { label: "Reach out", kind: "text", value: person.reach ? "Yes" : "No", key: "reach" },
    ...accounts.map((account) => ({ label: APPS[account.platform] ?? account.platform, kind: "text" as const, value: account.display_name })),
    { label: `Hours of ${HANGOUT.many}`, kind: "duration", value: hours * 3600 },
  ];
  return {
    row,
    more,
    people: {},
    views: [
      { label: "Messages with them", kind: "messages", filters: only({ person: person.id }) },
      { label: "Calls with them", kind: "calls", filters: only({ person: person.id }) },
      { label: `${HANGOUT.Many} with them`, kind: "hangouts", filters: only({ person: person.id }) },
    ],
    // What stays in a person's panel (merging, accounts, "this is me", their chat, a draft) is Friend Map's.
    places: [{ label: "Their panel in Friend Map", place: "friend-map", query: { person: String(person.id) } }],
  };
}

/** The People tab reads the archive alone (tab.ts's Reads): people are friend map's, and nothing of them is in the calendar. */
export const PEOPLE: Tab = {
  spec: SPEC,
  version: (reads) => versionOf(archiveOf(reads)),
  rows: (reads, filters, page) => rows(archiveOf(reads), filters, page),
  volume: (reads, filters, ask) => volume(archiveOf(reads), filters, ask),
  facets: (reads, filters) => facets(archiveOf(reads), filters),
  detail: (reads, id) => detail(archiveOf(reads), id),
};
