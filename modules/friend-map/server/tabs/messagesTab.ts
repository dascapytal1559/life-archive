// The viewer's Messages tab: every message in the archive, one row each, over a million of them, so it plans its own
// queries rather than filtering one SELECT (sourceTab.ts) as the small tabs do. Metadata only: when, the app, the chat,
// who sent it, its type, how long its text is (message_chars, kept by the archive so nothing here reads the text),
// its attachments and reactions, and whether it was edited or unsent.
//
// How it stays fast, on the archive's own indexes:
//   - Every filter is a condition on columns of the message_time index (sent_at, conversation_id, sender_account_id,
//     type): the app, the chat's kind and the chat become one set of chats, worked out here from the chats' table;
//     who it was from is the sender being one of the captain's accounts, another's, or none (a notice); a person is
//     their accounts sending it or their one-to-one chats holding it.
//   - Rows are paged by their order (keyset): a page after another starts right after its last row, however deep;
//     only a jump (the scrollbar dragged) counts its way down.
//   - The chart counts each bucket with a subquery that reads only that bucket's stretch of message_time.
//   - The filters' counts come from one grouping of the filters' time range by chat, sender and type (the cube), kept,
//     from which every filter's values are counted here under the others, without asking the archive again.
//   - What it works out is kept (memo.ts) until the archive's people, links, messages or chats change (version), or
//     ten minutes pass, for changes those do not show (a chat renamed).

import { archiveOf } from "./reads.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type BucketEdge, type Cell, chartBuckets, dayOf, type DetailField, edgesJson, type FacetValue, type Filters, type Grain, InvalidInputError, type KindSpec, LOCALE, Memo, MOST_FACET_VALUES, NAMED_BY, namesOf, NotFoundError, only, type Page, peopleOf, type Row, type RowDetail, type RowsAnswer, type Tab, type ViewLink, type VolumeAnswer, volumeAnswer, type VolumeAsk } from "../../../../sdk/server.ts";
import { whoIsWhom } from "../calendarRows.ts";

/** The apps, in the order a chart split by app stacks and colours them: the busiest first, as the archive goes. */
export const APPS: Record<string, string> = {
  messenger: "Messenger", wechat: "WeChat", telegram: "Telegram", whatsapp: "WhatsApp", instagram: "Instagram", imessage: "iMessage",
  signal: "Signal", discord: "Discord", x: "X", phone: "Phone",
};
const TYPES: Record<string, string> = {
  text: "Text", media: "Media", link: "Link", sticker: "Sticker", call: "Call", location: "Location", contact: "Contact", system: "Notice", other: "Other",
};
/** Who a message is from: the captain, someone else, or no one (a notice: "you created the group"). */
const FROM: Record<string, string> = { you: "You", others: "Others", none: "No one" };
type ChatKind = "direct" | "group" | "marketplace";
const KINDS: Record<ChatKind, string> = { direct: "One-to-one", group: "Group", marketplace: "Marketplace" };
const ATTACHMENTS: Record<string, [string, string]> = {
  image: ["image", "images"], video: ["video", "videos"], audio: ["audio", "audio"], gif: ["GIF", "GIFs"], sticker: ["sticker", "stickers"], file: ["file", "files"],
};

const name = (names: Record<string, string>) => (value: string) => names[value] ?? value;

/** The captain's own accounts. */
const SELF = "(SELECT ip.id FROM import_person ip JOIN person p ON p.id = ip.person_id WHERE ip.is_self = 1 OR p.is_self = 1)";
/** Who message `m` is from, as FROM keys it. */
const FROM_SQL = `CASE WHEN m.sender_account_id IS NULL THEN 'none' WHEN m.sender_account_id IN ${SELF} THEN 'you' ELSE 'others' END`;
/** Each value of the From filter as a condition on `m` alone. */
const FROM_WHERE: Record<string, string> = { you: `m.sender_account_id IN ${SELF}`, others: `m.sender_account_id NOT IN ${SELF}`, none: "m.sender_account_id IS NULL" };

/**
 * Past this many chats, a condition on a set of chats is checked row by row along the time index (the + keeps SQLite
 * from looking each chat up in its own index, which is quicker only for a few).
 */
const FEW_CHATS = 40;

const SPEC: KindSpec = {
  kind: "messages",
  label: "Messages",
  noun: ["message", "messages"],
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "app", label: "App", kind: "text", width: 100 },
    { key: "chat", label: "Chat", kind: "link", width: 220 },
    { key: "from", label: "From", kind: "people", width: 170 },
    { key: "type", label: "Type", kind: "text", width: 80 },
    { key: "length", label: "Length", kind: "count", width: 80, numeric: true },
    { key: "attachments", label: "Attachments", kind: "text", width: 130 },
    { key: "reactions", label: "Reactions", kind: "count", width: 90, numeric: true },
    { key: "changed", label: "Edited", kind: "text", width: 105 },
  ],
  filters: [
    { key: "app", label: "App", kind: "choice" },
    { key: "kind", label: "Chat kind", kind: "choice" },
    { key: "chat", label: "Chat", kind: "choice", find: "Find a chat" },
    { key: "sender", label: "From", kind: "choice" },
    { key: "type", label: "Type", kind: "choice" },
    { key: "person", label: "Person", kind: "person", find: "Find a person" },
  ],
  measures: [
    { key: "messages", label: "Messages", unit: "count" },
    { key: "characters", label: "Characters", unit: "characters" },
  ],
  sort: "when",
  splits: ["app", "kind", "sender", "type"],
};

export interface Chat {
  platform: string;
  kind: ChatKind;
  title: string | null;
  /** In a one-to-one chat, the person it is with. */
  other: number | null;
  /** The captain dropped it from the archive's people views (a group he left behind). */
  dropped: boolean;
}

/** What the tab looks things up in, read once for each state of the archive. */
export interface Lookup {
  self: Set<number>;
  /** Each account's person. */
  personOf: Map<number, number>;
  /** Each person's accounts. */
  accountsOf: Map<number, number[]>;
  chats: Map<number, Chat>;
  /** Each person's one-to-one chats. */
  directsOf: Map<number, number[]>;
  /** Each chat's name, as asked for (chatLabels). */
  labels: Map<number, string>;
}

/** One cell of the cube: how many messages one sender sent of one type in one chat (sender null for a notice). */
type CubeCell = [chat: number, sender: number | null, type: string, messages: number];

const memo = new Memo(64);

/** The state of the archive the tab's answers depend on (see the top). */
function versionOf(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT (SELECT value FROM meta WHERE key = 'people_version') AS people, (SELECT value FROM meta WHERE key = 'links_version') AS links,
      (SELECT max(id) FROM message) AS messages, (SELECT max(id) FROM conversation) AS chats, (SELECT count(*) FROM conversation_member) AS members`)
    .get() as Record<string, string | number | null>;
  return [row.people, row.links, row.messages, row.chats, row.members, Math.floor(Date.now() / 600_000)].join(".");
}

function lookupOf(db: DatabaseSync, version: string): Lookup {
  return memo.get(version, "lookup", () => {
    const { self, personOf, otherOf } = whoIsWhom(db);
    const accountsOf = new Map<number, number[]>();
    for (const [account, person] of personOf) accountsOf.set(person, [...(accountsOf.get(person) ?? []), account]);
    const chats = new Map<number, Chat>();
    for (const row of db.prepare("SELECT id, platform, type, is_marketplace, title, dropped_at FROM conversation").all() as
      Array<{ id: number; platform: string; type: "direct" | "group"; is_marketplace: number; title: string | null; dropped_at: number | null }>) {
      chats.set(row.id, { platform: row.platform, kind: row.is_marketplace ? "marketplace" : row.type, title: row.title, other: otherOf.get(row.id) ?? null, dropped: row.dropped_at !== null });
    }
    const directsOf = new Map<number, number[]>();
    for (const [chat, person] of otherOf) directsOf.set(person, [...(directsOf.get(person) ?? []), chat]);
    return { self, personOf, accountsOf, chats, directsOf, labels: new Map() };
  });
}

/** The archive's chats, accounts and people as the Messages tab reads them (Lookup), kept while they stay as they were. */
export function chatLookup(db: DatabaseSync): Lookup {
  return lookupOf(db, versionOf(db));
}

/** Who a sender is, as FROM keys it. */
function fromOf(lookup: Lookup, sender: number | null): string {
  return sender === null ? "none" : lookup.self.has(sender) ? "you" : "others";
}

/**
 * The name of each chat in `ids`: a one-to-one chat "with" its person, a group (or Marketplace chat) by its title, and
 * an untitled group by the first of its people, most messages there first (as friend-map names one).
 */
function chatLabels(db: DatabaseSync, lookup: Lookup, ids: Iterable<number>): Map<number, string> {
  const wanted = [...new Set(ids)].filter((id) => !lookup.labels.has(id));
  const others = wanted.flatMap((id) => {
    const other = lookup.chats.get(id)?.other;
    return other == null ? [] : [other];
  });
  const untitled = wanted.filter((id) => lookup.chats.get(id)?.kind === "group" && lookup.chats.get(id)?.title === null);
  const namedBy = new Map<number, number[]>();
  if (untitled.length > 0) {
    const rows = db
      .prepare(`SELECT m.conversation_id AS chat, m.sender_account_id AS sender, count(*) AS n FROM message m
        WHERE m.conversation_id IN (SELECT value FROM json_each(?)) AND m.sender_account_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 3 DESC, 2`)
      .all(JSON.stringify(untitled)) as Array<{ chat: number; sender: number; n: number }>;
    for (const row of rows) {
      const person = lookup.personOf.get(row.sender);
      const list = namedBy.get(row.chat) ?? [];
      if (person === undefined || lookup.self.has(row.sender) || list.includes(person) || list.length === NAMED_BY) continue;
      namedBy.set(row.chat, [...list, person]);
    }
  }
  const names = namesOf(db, [...others, ...[...namedBy.values()].flat()]);
  for (const id of wanted) {
    const chat = lookup.chats.get(id);
    const label =
      chat === undefined ? `Chat ${id}`
      : chat.kind === "direct" && chat.other !== null ? `with ${names[chat.other]}`
      : chat.title?.trim() ? chat.title.trim()
      : chat.other !== null ? `with ${names[chat.other]}`
      : namedBy.get(id)?.length ? namedBy.get(id)!.map((person) => names[person]).join(", ")
      : chat.kind === "group" ? "Untitled group" : "Untitled chat";
    lookup.labels.set(id, label);
  }
  return new Map([...new Set(ids)].map((id) => [id, lookup.labels.get(id)!]));
}

interface Where {
  sql: string[];
  params: SQLInputValue[];
}

/** The chats the app, chat kind and chat filters leave (but the one keyed `except`), or null when none of them narrows. */
function chatsOf(lookup: Lookup, filters: Filters, except?: string): number[] | null {
  const pick = (key: string) => (key === except ? undefined : filters.choices[key]);
  const apps = pick("app");
  const kinds = pick("kind");
  const chosen = pick("chat");
  if (!apps && !kinds && !chosen) return null;
  const candidates = chosen ? chosen.map(Number).filter((id) => lookup.chats.has(id)) : [...lookup.chats.keys()];
  return candidates.filter((id) => {
    const chat = lookup.chats.get(id)!;
    return (!apps || apps.includes(chat.platform)) && (!kinds || kinds.includes(chat.kind));
  });
}

/** The conditions on message `m` that `filters` make (but the one keyed `except`; `time` false leaves the range out). */
function whereOf(lookup: Lookup, filters: Filters, { except, time = true }: { except?: string; time?: boolean } = {}): Where {
  const where: Where = { sql: [], params: [] };
  if (time && filters.from !== null) {
    where.sql.push("m.sent_at >= ?");
    where.params.push(filters.from);
  }
  if (time && filters.to !== null) {
    where.sql.push("m.sent_at < ?");
    where.params.push(filters.to);
  }
  const chats = chatsOf(lookup, filters, except);
  if (chats !== null) {
    where.sql.push(`${chats.length > FEW_CHATS ? "+" : ""}m.conversation_id IN (SELECT value FROM json_each(?))`);
    where.params.push(JSON.stringify(chats));
  }
  const types = except === "type" ? undefined : filters.choices.type;
  if (types) {
    where.sql.push(`m.type IN (${types.map(() => "?").join(", ")})`);
    where.params.push(...types);
  }
  const senders = except === "sender" ? undefined : filters.choices.sender;
  if (senders) where.sql.push(`(${senders.map((value) => FROM_WHERE[value] ?? "0").join(" OR ")})`);
  if (except !== "person" && filters.person !== null) {
    where.sql.push("(m.sender_account_id IN (SELECT value FROM json_each(?)) OR m.conversation_id IN (SELECT value FROM json_each(?)))");
    where.params.push(JSON.stringify(lookup.accountsOf.get(filters.person) ?? []), JSON.stringify(lookup.directsOf.get(filters.person) ?? []));
  }
  return where;
}

const and = (where: Where) => where.sql.map((condition) => ` AND ${condition}`).join("");

/** A key for the filters, the same however they were written. */
function filtersKey(filters: Filters): string {
  const choices = Object.entries(filters.choices).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]);
  return JSON.stringify([filters.from, filters.to, filters.person, choices]);
}

/** A page's last row, as RowsAnswer.next gives it: its time and id. */
function readAfter(text: string): [number, number] {
  const match = /^(-?\d+)\.(\d+)$/.exec(text);
  if (!match) throw new InvalidInputError(`after is where a page ended (a time and an id), not ${JSON.stringify(text)}`);
  return [Number(match[1]), Number(match[2])];
}

/** How deep a page may count its way down; deeper, it skips whole months by their counts first (seek). */
const SHALLOW = 2_000;

function rows(db: DatabaseSync, filters: Filters, page: Page): RowsAnswer {
  const version = versionOf(db);
  const lookup = lookupOf(db, version);
  const where = whereOf(lookup, filters);
  const total = memo.get(version, `total ${filtersKey(filters)}`, () => {
    const cube = memo.peek<CubeCell[]>(version, cubeKey(filters));
    if (cube) return cube.reduce((sum, cell) => sum + (cellTest(lookup, filters)(cell) ? cell[3] : 0), 0);
    return (db.prepare(`SELECT count(*) AS n FROM message m WHERE 1${and(where)}`).get(...where.params) as { n: number }).n;
  });
  const direction = page.direction === "asc" ? "ASC" : "DESC";
  // Where the page starts: right after the page before, or so many rows down (past whole months first, when deep).
  const start: Where = { sql: [], params: [] };
  let offset = page.offset;
  if (page.after !== null) {
    start.sql.push(`(m.sent_at, m.id) ${direction === "ASC" ? ">" : "<"} (?, ?)`);
    start.params.push(...readAfter(page.after));
    offset = 0;
  } else if (offset > SHALLOW) {
    const months = monthsOf(db, version, lookup, filters);
    const order = direction === "ASC" ? months : [...months].reverse();
    let skipped = 0;
    let past: number | null = null;
    for (const month of order) {
      if (skipped + month.count > offset) break;
      skipped += month.count;
      past = direction === "ASC" ? month.end : month.start;
    }
    if (past !== null) {
      start.sql.push(direction === "ASC" ? "m.sent_at >= ?" : "m.sent_at < ?");
      start.params.push(past);
    }
    offset -= skipped;
  }
  const raws = db
    .prepare(`SELECT ${RAW} FROM message m WHERE 1${and(where)}${and(start)} ORDER BY m.sent_at ${direction}, m.id ${direction} LIMIT ? OFFSET ?`)
    .all(...where.params, ...start.params, page.limit, offset) as unknown as RawMessage[];
  const result = rowsFor(db, lookup, raws);
  const last = raws.at(-1);
  return {
    total,
    offset: page.offset,
    rows: result,
    people: namesOf(db, peopleOf(result)),
    next: last && raws.length === page.limit ? `${last.sent_at}.${last.id}` : null,
  };
}

/** What a row is drawn from: a message's columns, none of them its text. */
const RAW = "m.id, m.sent_at, m.conversation_id AS chat, m.sender_account_id AS sender, m.type, m.edited_at, m.unsent";
interface RawMessage {
  id: number;
  sent_at: number;
  chat: number;
  sender: number | null;
  type: string;
  edited_at: number | null;
  unsent: number;
}

/** The rows the table draws for messages `raws`, with their lengths, reactions and attachments read in three statements. */
function rowsFor(db: DatabaseSync, lookup: Lookup, raws: RawMessage[]): Row[] {
  const ids = JSON.stringify(raws.map((raw) => raw.id));
  const chars = new Map((db.prepare("SELECT message_id AS id, chars FROM message_chars WHERE message_id IN (SELECT value FROM json_each(?))").all(ids) as
    Array<{ id: number; chars: number }>).map((row) => [row.id, row.chars]));
  const reactions = new Map((db.prepare("SELECT message_id AS id, count(*) AS n FROM reaction WHERE message_id IN (SELECT value FROM json_each(?)) GROUP BY 1").all(ids) as
    Array<{ id: number; n: number }>).map((row) => [row.id, row.n]));
  const attachments = new Map<number, Array<[string, number]>>();
  for (const row of db.prepare("SELECT message_id AS id, type, count(*) AS n FROM attachment WHERE message_id IN (SELECT value FROM json_each(?)) GROUP BY 1, 2 ORDER BY 1, 3 DESC, 2").all(ids) as
    Array<{ id: number; type: string; n: number }>) {
    attachments.set(row.id, [...(attachments.get(row.id) ?? []), [row.type, row.n]]);
  }
  const labels = chatLabels(db, lookup, raws.map((raw) => raw.chat));

  return raws.map((raw) => {
    const person = raw.sender === null ? undefined : lookup.personOf.get(raw.sender);
    const from: Cell = raw.sender === null ? null : lookup.self.has(raw.sender) ? "You" : person === undefined ? "Someone unknown" : { ids: [person], others: 0 };
    const changed = [raw.edited_at !== null ? "Edited" : null, raw.unsent ? "Unsent" : null].filter(Boolean).join(", ");
    return {
      id: String(raw.id),
      cells: {
        when: raw.sent_at,
        app: APPS[lookup.chats.get(raw.chat)?.platform ?? ""] ?? lookup.chats.get(raw.chat)?.platform ?? null,
        chat: { filter: "chat", value: String(raw.chat), label: labels.get(raw.chat)! },
        from,
        type: TYPES[raw.type] ?? raw.type,
        length: chars.get(raw.id) ?? null,
        attachments: attachmentsText(attachments.get(raw.id)),
        reactions: reactions.get(raw.id) ?? null,
        changed: changed || null,
      },
    };
  });
}

/**
 * One message for its drawer: its row, and what the table has no column for (the chat's kind, the account it came
 * from, when it was edited, a call's length, whether it replies to another, each attachment's kind and size); its
 * chat, that day of it, and the person who sent it, to open.
 */
function detail(db: DatabaseSync, id: string): RowDetail {
  const raw = /^\d+$/.test(id) ? (db.prepare(`SELECT ${RAW} FROM message m WHERE m.id = ?`).get(Number(id)) as unknown as RawMessage | undefined) : undefined;
  if (!raw) throw new NotFoundError(`no message ${JSON.stringify(id)}`);
  const lookup = chatLookup(db);
  const [row] = rowsFor(db, lookup, [raw]);
  const extra = db
    .prepare(`SELECT m.call_seconds, m.reply_to_platform_id IS NOT NULL AS replies, ip.display_name AS account, ip.platform AS account_platform
      FROM message m LEFT JOIN import_person ip ON ip.id = m.sender_account_id WHERE m.id = ?`)
    .get(raw.id) as { call_seconds: number | null; replies: number; account: string | null; account_platform: string | null };
  const files = db.prepare("SELECT type, mime, size FROM attachment WHERE message_id = ? ORDER BY ordinal").all(raw.id) as Array<{ type: string; mime: string | null; size: number | null }>;
  const chat = lookup.chats.get(raw.chat);
  const more: DetailField[] = [
    { label: "Chat kind", kind: "text", value: chat ? KINDS[chat.kind] : null },
    { label: "Sent from", kind: "text", value: extra.account === null ? null : `${extra.account} (${APPS[extra.account_platform ?? ""] ?? extra.account_platform})` },
    ...(raw.edited_at === null ? [] : [{ label: "Edited at", kind: "time" as const, value: raw.edited_at }]),
    ...(raw.type === "call" ? [{ label: "Call length", kind: "duration" as const, value: extra.call_seconds }] : []),
    { label: "A reply", kind: "text", value: extra.replies ? "Yes, to another message" : "No" },
    ...files.map((file, i) => ({ label: `Attachment ${i + 1}`, kind: "text" as const, value: [file.type, file.mime, file.size === null ? null : `${file.size.toLocaleString(LOCALE)} bytes`].filter(Boolean).join(" · ") })),
  ];
  const people = namesOf(db, peopleOf([row], more));
  const sender = raw.sender === null || lookup.self.has(raw.sender) ? undefined : lookup.personOf.get(raw.sender);
  const views: ViewLink[] = [
    { label: "This chat", kind: "messages", filters: only({ choices: { chat: [String(raw.chat)] } }) },
    { label: "This chat that day", kind: "messages", filters: only({ ...dayOf(raw.sent_at), choices: { chat: [String(raw.chat)] } }) },
    ...(sender === undefined ? [] : [{ label: `Messages with ${people[sender] ?? `Person ${sender}`}`, kind: "messages", filters: only({ person: sender }) }]),
  ];
  return { row, more, people, views };
}

/** "image", "3 images", "2 images, video": a message's attachments by kind, the commonest first. */
function attachmentsText(kinds: Array<[string, number]> | undefined): string | null {
  if (!kinds) return null;
  return kinds.map(([kind, n]) => {
    const [one, many] = ATTACHMENTS[kind] ?? [kind, kind];
    return n === 1 ? one : `${n} ${many}`;
  }).join(", ");
}

/** The buckets a chart of the rows `where` leaves has: over the filters' range, or from their first row to their last. */
function bucketsOf(db: DatabaseSync, filters: Filters, where: Where, grain: Grain | null, begins?: string): { grain: Grain; edges: BucketEdge[] } | null {
  // The first and last rows' times, along the time index from either end.
  const end = (direction: string) =>
    (db.prepare(`SELECT m.sent_at AS at FROM message m WHERE 1${and(where)} ORDER BY m.sent_at ${direction} LIMIT 1`).get(...where.params) as { at: number } | undefined)?.at ?? null;
  return chartBuckets(filters, filters.from !== null && filters.to !== null ? { first: null, last: null } : { first: end("ASC"), last: end("DESC") }, grain, begins);
}

/**
 * The measure of the rows `where` leaves in each of `edges`, each bucket counted by a subquery over its own stretch
 * of the time index; split, as each bucket's JSON object of the split's keys (a chat, for app and chat kind).
 */
function bucketValues(db: DatabaseSync, where: Where, edges: BucketEdge[], measure: string, split: string | null): Array<number | Record<string, number>> {
  const characters = measure === "characters";
  const value = characters ? "coalesce(sum(c.chars), 0)" : "count(*)";
  // CROSS JOIN keeps message first: the bucket's stretch of the time index, then each message's length by its id.
  const rows = `FROM message m${characters ? " CROSS JOIN message_chars c ON c.message_id = m.id" : ""} WHERE m.sent_at >= b.lo AND m.sent_at < b.hi${and(where)}`;
  const key = split === null ? null : split === "type" ? "m.type" : split === "sender" ? FROM_SQL : "m.conversation_id";
  const each = key === null ? `SELECT ${value} ${rows}` : `SELECT json_group_object(k, v) FROM (SELECT ${key} AS k, ${value} AS v ${rows} GROUP BY 1)`;
  const answers = db
    .prepare(`WITH b AS (SELECT CAST(key AS INTEGER) AS i, value ->> 0 AS lo, value ->> 1 AS hi FROM json_each(?)) SELECT (${each}) AS v FROM b ORDER BY b.i`)
    .all(edgesJson(edges), ...where.params) as Array<{ v: number | string }>;
  return answers.map((answer) => (key === null ? Number(answer.v) : (JSON.parse(String(answer.v)) as Record<string, number>)));
}

/** How many rows the filters leave in each local month they span, for a page deep down to skip by (rows). */
function monthsOf(db: DatabaseSync, version: string, lookup: Lookup, filters: Filters): Array<BucketEdge & { count: number }> {
  return memo.get(version, `months ${filtersKey(filters)}`, () => {
    const where = whereOf(lookup, filters);
    const chosen = bucketsOf(db, filters, where, "month");
    if (chosen === null) return [];
    const counts = bucketValues(db, where, chosen.edges, "messages", null);
    return chosen.edges.map((edge, i) => ({ ...edge, count: counts[i] as number }));
  });
}

function volume(db: DatabaseSync, filters: Filters, ask: VolumeAsk): VolumeAnswer {
  const version = versionOf(db);
  const lookup = lookupOf(db, version);
  const where = whereOf(lookup, filters);
  const chosen = bucketsOf(db, filters, where, ask.grain, ask.begins);
  if (chosen === null) return volumeAnswer(ask, null, () => 0);
  const values = bucketValues(db, where, chosen.edges, ask.measure, ask.split);
  if (ask.split === null) return volumeAnswer(ask, chosen, (i) => values[i] as number);
  // Split by app or chat kind: counted by chat, then added up by the chat's app or kind.
  const partOf = ask.split === "app" ? (k: string) => lookup.chats.get(Number(k))?.platform ?? "?" : ask.split === "kind" ? (k: string) => lookup.chats.get(Number(k))?.kind ?? "?" : (k: string) => k;
  const parts = values.map((value) => {
    const sums = new Map<string, number>();
    for (const [k, v] of Object.entries(value as Record<string, number>)) sums.set(partOf(k), (sums.get(partOf(k)) ?? 0) + v);
    return sums;
  });
  const names: Record<string, Record<string, string>> = { app: APPS, kind: KINDS, sender: FROM, type: TYPES };
  return volumeAnswer(ask, chosen, (i) => parts[i], name(names[ask.split]), Object.keys(names[ask.split]));
}

function cubeKey(filters: Filters): string {
  return `cube ${filters.from} ${filters.to}`;
}

/** Each filter's own test of a cube cell, for those that narrow (but the one keyed `except`). */
function cellTests(lookup: Lookup, filters: Filters, except?: string): Array<(cell: CubeCell) => boolean> {
  const tests = new Map<string, (cell: CubeCell) => boolean>();
  const chat = (cell: CubeCell) => lookup.chats.get(cell[0]);
  const chosen = (key: string) => filters.choices[key];
  if (chosen("app")) tests.set("app", (cell) => chosen("app")!.includes(chat(cell)?.platform ?? ""));
  if (chosen("kind")) tests.set("kind", (cell) => chosen("kind")!.includes(chat(cell)?.kind ?? ""));
  if (chosen("chat")) tests.set("chat", (cell) => chosen("chat")!.includes(String(cell[0])));
  if (chosen("sender")) tests.set("sender", (cell) => chosen("sender")!.includes(fromOf(lookup, cell[1])));
  if (chosen("type")) tests.set("type", (cell) => chosen("type")!.includes(cell[2]));
  if (filters.person !== null) {
    const accounts = new Set(lookup.accountsOf.get(filters.person) ?? []);
    const directs = new Set(lookup.directsOf.get(filters.person) ?? []);
    tests.set("person", (cell) => (cell[1] !== null && accounts.has(cell[1])) || directs.has(cell[0]));
  }
  tests.delete(except ?? "");
  return [...tests.values()];
}

/** Whether a cube cell passes every filter (but the one keyed `except`). */
function cellTest(lookup: Lookup, filters: Filters, except?: string): (cell: CubeCell) => boolean {
  const tests = cellTests(lookup, filters, except);
  return (cell) => tests.every((test) => test(cell));
}

/** The cube for the filters' time range (see the top): every chat, sender and type in it, with how many messages. */
function cubeOf(db: DatabaseSync, version: string, filters: Filters): CubeCell[] {
  return memo.get(version, cubeKey(filters), () => {
    const statement = db.prepare(`SELECT conversation_id, sender_account_id, type, count(*) FROM message INDEXED BY message_time
      WHERE sent_at >= ? AND sent_at < ? GROUP BY 1, 2, 3`);
    statement.setReturnArrays(true);
    return statement.all(filters.from ?? Number.MIN_SAFE_INTEGER, filters.to ?? Number.MAX_SAFE_INTEGER) as unknown as CubeCell[];
  });
}

/**
 * Each filter's values under every other filter, commonest first, with how many messages have each, counted from the
 * cube; a value chosen is listed even with none, so the page can show it chosen. A person's are those they sent and
 * those in their one-to-one chats; only the commonest people and chats are listed.
 */
function facets(db: DatabaseSync, filters: Filters): Record<string, FacetValue[]> {
  const version = versionOf(db);
  const lookup = lookupOf(db, version);
  const cube = cubeOf(db, version, filters);
  const chat = (cell: CubeCell) => lookup.chats.get(cell[0]);
  /** The values `cell` gives facet `key`: one, but a person's (who sent it, and whom its one-to-one chat is with). */
  const valuesOf = (key: string, cell: CubeCell): Array<string | number> => {
    switch (key) {
      case "app": return [chat(cell)?.platform ?? "?"];
      case "kind": return [chat(cell)?.kind ?? "?"];
      case "chat": return [cell[0]];
      case "sender": return [fromOf(lookup, cell[1])];
      case "type": return [cell[2]];
      default: {
        const sender = cell[1] === null || lookup.self.has(cell[1]) ? undefined : lookup.personOf.get(cell[1]);
        const other = chat(cell)?.other ?? undefined;
        return [...new Set([sender, other].filter((p): p is number => p !== undefined))];
      }
    }
  };
  const counted = (key: string) => {
    const counts = new Map<string | number, number>();
    const passes = cellTest(lookup, filters, key);
    for (const cell of cube) if (passes(cell)) for (const value of valuesOf(key, cell)) counts.set(value, (counts.get(value) ?? 0) + cell[3]);
    return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const listed = (key: string, label: (value: string) => string, values: Array<[string | number, number]>): FacetValue[] => {
    const list = values.map(([value, count]) => ({ value: String(value), label: label(String(value)), count }));
    const picked = key === "person" ? (filters.person === null ? [] : [String(filters.person)]) : (filters.choices[key] ?? []);
    for (const value of picked) if (!list.some((v) => v.value === value)) list.push({ value, label: label(value), count: 0 });
    return list;
  };
  const top = (values: Array<[string | number, number]>) => values.slice(0, MOST_FACET_VALUES);
  const chats = top(counted("chat"));
  const chatNames = chatLabels(db, lookup, [...chats.map(([id]) => Number(id)), ...(filters.choices.chat ?? []).map(Number).filter((id) => lookup.chats.has(id))]);
  const people = top(counted("person"));
  const personNames = namesOf(db, [...people.map(([id]) => Number(id)), ...(filters.person === null ? [] : [filters.person])]);
  return {
    app: listed("app", name(APPS), counted("app")),
    kind: listed("kind", name(KINDS), counted("kind")),
    chat: listed("chat", (id) => chatNames.get(Number(id)) ?? `Chat ${id}`, chats),
    sender: listed("sender", name(FROM), counted("sender")),
    type: listed("type", name(TYPES), counted("type")),
    person: listed("person", (id) => personNames[Number(id)] ?? `Person ${id}`, people),
  };
}

/** The Messages tab reads the archive alone (tab.ts's Reads): the per-message table is friend map's, not the calendar's. */
export const MESSAGES: Tab = {
  spec: SPEC,
  version: (reads) => versionOf(archiveOf(reads)),
  rows: (reads, filters, page) => rows(archiveOf(reads), filters, page),
  volume: (reads, filters, ask) => volume(archiveOf(reads), filters, ask),
  facets: (reads, filters) => facets(archiveOf(reads), filters),
  detail: (reads, id) => detail(archiveOf(reads), id),
};
