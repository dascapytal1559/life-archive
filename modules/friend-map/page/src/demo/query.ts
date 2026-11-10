// The demo's own copy of the archive's query language (server/archive/query.ts,
// whose words follow), so the demo's archive answers a query in the page with
// none of the archive's code, which is moving to a project of its own. Change
// the two together: the demo parity test (server/archive/demoParity.test.ts)
// checks this one answers as the archive's does.
//
// The query language: a small, readable form over people's tags and fields, typed by
// you in the CLI's --query (and still run for a query an older page kept on Orbits or the Table), and run
// here in the server over the person table (GET /api/archive/query). A query
// whose first word is SELECT or WITH is SQL instead, run by sqlQuery.ts.
//
//   location:berlin OR location:paris
//   location:tokyo AND NOT plays-chess
//   (is-* OR platform:telegram) AND messages>100
//   should-reach-out AND last-spoke<2025-01
//   group:"Climbing crew" AND untagged
//
// Grammar (NOT binds tightest, then AND, then OR; parentheses group):
//
//   query  := or                          empty: everyone
//   or     := and (OR and)*
//   and    := unary (AND unary)*
//   unary  := NOT unary | "(" or ")" | term
//   term   := TAG                         a tag; * matches any run of characters (is-*, *-chess)
//           | tag:TAG                     the same
//           | FIELD:VALUE                 a field holding the value (location:brisbane); * as in tags
//           | group:TITLE                 in a group chat of that title, as its header lists who is in it
//                                         (listed as a member, or wrote there); * as in tags;
//                                         group:#ID for one group chat by its number, titled or not
//           | FLAG                        should-reach-out, untagged, archived
//           | COUNT OP NUMBER             messages, direct-messages, group-messages
//           | last-spoke OP DATE          2025, 2025-01 or 2025-01-31
//   OP     := < | <= | > | >= | =
//
// Which fields there are, and their values, come from the archive (see
// QueryVocabulary and ArchiveStructure.queryable): location,
// yours, and platform, those of someone's accounts (met: and lives:, the
// fields Location took over, say so). A
// tag or value is written as tags are, lowercase with dashes for spaces
// (location:new-york matches "New York"), or in double quotes (location:"New York");
// quotes also make a word such as "and" a tag. AND, OR, NOT and the fields may
// be written in any case. Two terms side by side are an error, never a guess.
// A date is a period in local time (the backend's time zone, time.ts): last-spoke<2025-01 is before January
// 2025 began, last-spoke>2025-01 after it ended, last-spoke=2025-01 during it;
// someone never spoken to matches no date. Group chats come from the archive
// too (QueryGroups), and who is in one is asked only for the groups a query
// names. "archive" is on everyone archived, by you or by the rules
// (tagsWithRule), as the Table shows it, so it matches both. A tag or value that
// nobody has is an error, with the nearest one suggested, so a typo never
// quietly matches nobody.

import { ARCHIVE_TAG, FORMER_FIELDS, KEEP_TAG, tagsWithRule, writtenTag, type ArchiveReason, type QueryResult } from "../archive.ts";
import { dayKey } from "../time.ts";
import { InvalidInputError } from "../invalidInput.ts";

/** What a query reads of a person. */
export interface QueryPerson {
  id: number;
  /** Their stored tags. */
  tags: string[];
  archived: ArchiveReason | null;
  shouldReachOut: boolean;
  /** Each field's values (platform: the platforms of their accounts), as stored. */
  fields: Readonly<Record<string, readonly string[]>>;
  messageCount: number;
  directMessageCount: number;
  groupMessageCount: number;
  lastMessageAt: number | null;
}

/** What there is to query: every tag, and every value each field has, as stored, and the group chats. */
export interface QueryVocabulary {
  tags: readonly string[];
  fields: Readonly<Record<string, readonly string[]>>;
  /** Without it, a query naming a group chat does not run (the model writing queries is not told of them). */
  groups?: QueryGroups;
}

/** The group chats a query can name. */
export interface QueryGroups {
  /** Every group chat, by number, with its title (null for an untitled one). */
  list: ReadonlyArray<{ id: number; title: string | null }>;
  /** Everyone in these group chats, by person id: listed as a member, or wrote there. */
  members(ids: readonly number[]): ReadonlySet<number>;
}

export type Comparison = "<" | "<=" | ">" | ">=" | "=";

const FLAGS = {
  "should-reach-out": (p: QueryPerson) => p.shouldReachOut,
  untagged: (p: QueryPerson) => p.tags.every((tag) => tag === ARCHIVE_TAG || tag === KEEP_TAG),
  archived: (p: QueryPerson) => p.archived !== null,
} as const;
type Flag = keyof typeof FLAGS;

const COUNTS = {
  messages: (p: QueryPerson) => p.messageCount,
  "direct-messages": (p: QueryPerson) => p.directMessageCount,
  "group-messages": (p: QueryPerson) => p.groupMessageCount,
} as const;
type Count = keyof typeof COUNTS;

/** The words that are not tags (quote one, or write tag:NAME, for a tag named so). */
export const QUERY_WORDS = { flags: Object.keys(FLAGS) as Flag[], counts: Object.keys(COUNTS) as Count[], date: "last-spoke" } as const;

/** A parsed query. Tags and values are as tags are written (see valueKey). */
export type QueryNode =
  | { kind: "or" | "and"; items: QueryNode[] }
  | { kind: "not"; item: QueryNode }
  | { kind: "tag"; pattern: string }
  | { kind: "field"; field: string; pattern: string }
  | { kind: "group"; pattern: string }
  | { kind: "flag"; flag: Flag }
  | { kind: "count"; count: Count; op: Comparison; value: number }
  | { kind: "date"; op: Comparison; value: string };

/** A query that can't be read, or names what nobody has. */
export class QueryError extends InvalidInputError {}

/** A tag or field value as a query compares it: as tags are written, lowercase with dashes for spaces. */
export function valueKey(value: string): string {
  return writtenTag(value);
}

interface Token {
  kind: "word" | "(" | ")" | ":" | "op";
  text: string;
  at: number;
  /** A word in double quotes: always a tag or value, never a keyword. */
  quoted?: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s+|([()])|(<=|>=|[<>=])|(:)|"([^"]*)("?)|([^\s()<>=:"]+)/gy;
  let match: RegExpExecArray | null;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) {
    const at = match.index;
    if (match[1]) tokens.push({ kind: match[1] as "(" | ")", text: match[1], at });
    else if (match[2]) tokens.push({ kind: "op", text: match[2], at });
    else if (match[3]) tokens.push({ kind: ":", text: ":", at });
    else if (match[4] !== undefined) {
      if (!match[5]) throw new QueryError(`the quote at "${text.slice(at, at + 30)}" is never closed: add "`);
      tokens.push({ kind: "word", text: match[4], at, quoted: true });
    } else if (match[6]) tokens.push({ kind: "word", text: match[6], at });
  }
  return tokens;
}

/** Reads a query; null for an empty one (everyone). Throws QueryError naming what is wrong and where. */
export function parseQuery(text: string): QueryNode | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  let i = 0;
  /** Where the last term began, to quote it when a term follows it without AND or OR. */
  let lastTerm = 0;
  const peek = () => tokens[i] as Token | undefined;
  const keyword = (token: Token | undefined, word: string) => token?.kind === "word" && !token.quoted && token.text.toLowerCase() === word;
  const near = (token: Token | undefined) => (token ? `at "${text.slice(token.at, token.at + 30).trimEnd()}"` : "at the end");

  const or = (): QueryNode => {
    const items = [and()];
    while (keyword(peek(), "or")) {
      i++;
      items.push(and());
    }
    return items.length === 1 ? items[0] : { kind: "or", items };
  };
  const and = (): QueryNode => {
    const items = [unary()];
    while (keyword(peek(), "and")) {
      i++;
      items.push(unary());
    }
    return items.length === 1 ? items[0] : { kind: "and", items };
  };
  const unary = (): QueryNode => {
    const token = peek();
    if (keyword(token, "not")) {
      i++;
      return { kind: "not", item: unary() };
    }
    if (token?.kind === "(") {
      i++;
      const inner = or();
      if (peek()?.kind !== ")") throw new QueryError(`the "(" ${near(token)} is never closed: add ")"`);
      i++;
      return inner;
    }
    return term();
  };
  const term = (): QueryNode => {
    const token = peek();
    if (!token || token.kind !== "word" || keyword(token, "and") || keyword(token, "or")) {
      throw new QueryError(`expected a tag, a field or "(" ${near(token)}`);
    }
    i++;
    lastTerm = token.at;
    if (token.quoted) return { kind: "tag", pattern: valueKey(token.text) };
    const word = token.text.toLowerCase();
    if (peek()?.kind === ":") {
      i++;
      const value = peek();
      if (value?.kind !== "word") throw new QueryError(`${word}: needs a value, such as ${word === "tag" ? "tag:lives-brisbane" : `${word}:something`}`);
      i++;
      const pattern = valueKey(value.text);
      if (word === "group") return { kind: "group", pattern };
      return word === "tag" ? { kind: "tag", pattern } : { kind: "field", field: word, pattern };
    }
    if (word in COUNTS || word === QUERY_WORDS.date) return comparison(word);
    if (word in FLAGS) return { kind: "flag", flag: word as Flag };
    if (word === "tag") throw new QueryError(`tag needs a value, such as tag:lives-brisbane`);
    if (word === "group") throw new QueryError(`group needs a title, such as group:"Climbing crew", or a number, such as group:#12`);
    return { kind: "tag", pattern: valueKey(token.text) };
  };
  const comparison = (word: string): QueryNode => {
    const op = peek();
    const example = word === QUERY_WORDS.date ? "last-spoke<2025-01" : `${word}>100`;
    if (op?.kind !== "op") throw new QueryError(`${word} needs a comparison, such as ${example}`);
    i++;
    const value = peek();
    if (value?.kind !== "word") throw new QueryError(`${word}${op.text} needs a value, such as ${example}`);
    i++;
    if (word === QUERY_WORDS.date) {
      if (!isPeriod(value.text)) throw new QueryError(`last-spoke compares with a date written 2025, 2025-01 or 2025-01-31, not "${value.text}"`);
      return { kind: "date", op: op.text as Comparison, value: value.text };
    }
    if (!/^\d+$/.test(value.text)) throw new QueryError(`${word} compares with a whole number, such as ${example}, not "${value.text}"`);
    return { kind: "count", count: word as Count, op: op.text as Comparison, value: Number(value.text) };
  };

  const node = or();
  const rest = peek();
  if (rest) {
    if (rest.kind === ")") throw new QueryError(`the ")" ${near(rest)} has no "(" before it`);
    throw new QueryError(`put AND or OR between "${text.slice(lastTerm, rest.at).trim()}" and "${text.slice(rest.at, rest.at + 30).trim()}"`);
  }
  return node;
}

/** A year, month or day as a query writes it: 2025, 2025-01 or 2025-01-31, a real one. */
function isPeriod(value: string): boolean {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) return false;
  if (day === undefined) return true;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function compare(a: number | string, op: Comparison, b: number | string): boolean {
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b;
}

/** Whether a written tag or value fits a pattern, where * is any run of characters. */
function fits(pattern: string): (key: string) => boolean {
  if (!pattern.includes("*")) return (key) => key === pattern;
  const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "u");
  return (key) => re.test(key);
}

/**
 * Checks a parsed query against what there is: each tag, field and value
 * must name at least one that exists. Throws QueryError for the first that
 * does not, suggesting the nearest.
 */
export function checkQuery(node: QueryNode | null, vocabulary: QueryVocabulary): void {
  if (!node) return;
  const tags = [...new Set([...vocabulary.tags.map(valueKey), ARCHIVE_TAG])];
  const fields = Object.keys(vocabulary.fields);
  const visit = (n: QueryNode): void => {
    if (n.kind === "or" || n.kind === "and") n.items.forEach(visit);
    else if (n.kind === "not") visit(n.item);
    else if (n.kind === "tag") {
      if (tags.some(fits(n.pattern))) return;
      if (fields.includes(n.pattern)) throw new QueryError(`${n.pattern} needs a value, such as ${n.pattern}:${vocabulary.fields[n.pattern].map(valueKey)[0] ?? "something"}`);
      throw new QueryError(`there is no tag ${n.pattern.includes("*") ? `matching ${n.pattern}` : `"${n.pattern}"${suggest(n.pattern, tags)}`}`);
    } else if (n.kind === "group") {
      groupsOf(n.pattern, vocabulary);
    } else if (n.kind === "field") {
      if (!fields.includes(n.field) && Object.hasOwn(FORMER_FIELDS, n.field)) {
        throw new QueryError(`"${n.field}:" is gone: Met and Lives became one Location, so ask ${FORMER_FIELDS[n.field]}:${n.pattern}`);
      }
      if (!fields.includes(n.field)) {
        const all = ["tag", ...fields, ...(vocabulary.groups ? ["group"] : [])];
        throw new QueryError(`"${n.field}:" is not a field; the fields are ${all.map((f) => `${f}:`).join(", ")}`);
      }
      const values = [...new Set(vocabulary.fields[n.field].map(valueKey))];
      if (values.some(fits(n.pattern))) return;
      const nearest = n.pattern.includes("*") ? "" : suggest(n.pattern, values);
      const listed = !nearest && values.length <= 8 ? `; the values are ${values.join(", ") || "none yet"}` : "";
      throw new QueryError(`nobody has ${n.field} ${n.pattern.includes("*") ? `matching ${n.pattern}` : `"${n.pattern}"`}${nearest}${listed}`);
    }
  };
  visit(node);
}

/**
 * The group chats a group term names, by number: #ID one by its number, else
 * those whose title, written as tags are, fits. Throws QueryError when it names
 * none, suggesting the nearest title.
 */
function groupsOf(pattern: string, vocabulary: QueryVocabulary): number[] {
  const groups = vocabulary.groups;
  if (!groups) throw new QueryError("group chats can't be asked for here");
  const byId = /^#(\d+)$/.exec(pattern);
  if (byId) {
    if (groups.list.some((g) => g.id === Number(byId[1]))) return [Number(byId[1])];
    throw new QueryError(`there is no group chat #${byId[1]}`);
  }
  const fit = fits(pattern);
  const ids = groups.list.filter((g) => g.title !== null && fit(valueKey(g.title))).map((g) => g.id);
  if (ids.length > 0) return ids;
  const titles = [...new Set(groups.list.flatMap((g) => (g.title === null ? [] : [valueKey(g.title)])))];
  throw new QueryError(`there is no group chat ${pattern.includes("*") ? `matching ${pattern}` : `"${pattern}"${suggest(pattern, titles)}`}`);
}

/** "; did you mean X?" for the known word closest to a mistyped one (within two letters, or one it starts), or nothing. */
function suggest(typed: string, known: readonly string[]): string {
  let best: { word: string; distance: number } | null = null;
  for (const word of known) {
    const distance = word.startsWith(typed) ? 1 : editDistance(typed, word);
    if (distance <= 2 && (!best || distance < best.distance)) best = { word, distance };
  }
  return best ? `; did you mean ${best.word}?` : "";
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** A person as a compiled query reads them: tags with the rules' "archive" (tagsWithRule), values as written, and their last local day. */
interface Seen {
  person: QueryPerson;
  tags: string[];
  fields: Record<string, string[]>;
  lastDay: string | null;
}

type Test = (seen: Seen) => boolean;

/** The query as one function, its patterns made once; `groups` has who is in each group term's chats. */
function compile(node: QueryNode, groups: ReadonlyMap<QueryNode, ReadonlySet<number>>): Test {
  switch (node.kind) {
    case "or": {
      const items = node.items.map((item) => compile(item, groups));
      return (s) => items.some((item) => item(s));
    }
    case "and": {
      const items = node.items.map((item) => compile(item, groups));
      return (s) => items.every((item) => item(s));
    }
    case "not": {
      const item = compile(node.item, groups);
      return (s) => !item(s);
    }
    case "tag": {
      const fit = fits(node.pattern);
      return (s) => s.tags.some(fit);
    }
    case "field": {
      const fit = fits(node.pattern);
      return (s) => (s.fields[node.field] ?? []).some(fit);
    }
    case "group": {
      const members = groups.get(node)!;
      return (s) => members.has(s.person.id);
    }
    case "flag":
      return (s) => FLAGS[node.flag](s.person);
    case "count": {
      const read = COUNTS[node.count];
      return (s) => compare(read(s.person), node.op, node.value);
    }
    case "date":
      // A local day cut to the period's length sorts against the period: 2024-12-31 < 2025-01, 2025-01-09 = 2025-01.
      return (s) => s.lastDay !== null && compare(s.lastDay.slice(0, node.value.length), node.op, node.value);
  }
}

/**
 * Runs a query over `people`: the ids of everyone it matches, in their order.
 * The text is read, then checked against `vocabulary` (parseQuery, checkQuery).
 */
export function runQuery(text: string, people: readonly QueryPerson[], vocabulary: QueryVocabulary): number[] {
  const node = parseQuery(text);
  checkQuery(node, vocabulary);
  if (!node) return people.map((p) => p.id);
  // Who is in each group chat a query names, asked once per group term.
  const groups = new Map<QueryNode, ReadonlySet<number>>();
  const visit = (n: QueryNode): void => {
    if (n.kind === "or" || n.kind === "and") n.items.forEach(visit);
    else if (n.kind === "not") visit(n.item);
    else if (n.kind === "group") groups.set(n, vocabulary.groups!.members(groupsOf(n.pattern, vocabulary)));
  };
  visit(node);
  const test = compile(node, groups);
  return people
    .filter((person) => test({
      person,
      tags: tagsWithRule(person).map(valueKey),
      fields: Object.fromEntries(Object.entries(person.fields).map(([field, values]) => [field, values.map(valueKey)])),
      lastDay: person.lastMessageAt === null ? null : dayKey(person.lastMessageAt),
    }))
    .map((person) => person.id);
}

/**
 * A query's answer (GET /api/archive/query): everyone it matches, and how many
 * of them a view's Hide shows, leaving out anyone with a tag in `hide` (the
 * rules' archive counting as "archive"), so a view can refuse to draw too many
 * before it loads them.
 */
export function answerQuery(text: string, people: readonly QueryPerson[], vocabulary: QueryVocabulary, hide: readonly string[] = []): QueryResult {
  return queryResult(runQuery(text, people, vocabulary), people, hide);
}

/** A query's answer from the ids it matched among `people` (a SQL query's too, sqlQuery.ts), counted under `hide` as answerQuery says. */
export function queryResult(ids: number[], people: readonly QueryPerson[], hide: readonly string[] = []): QueryResult {
  if (hide.length === 0) return { ids, shown: ids.length };
  const matched = new Set(ids);
  const hidden = new Set(hide);
  const shown = people.filter((person) => matched.has(person.id) && !tagsWithRule(person).some((tag) => hidden.has(tag))).length;
  return { ids, shown };
}
