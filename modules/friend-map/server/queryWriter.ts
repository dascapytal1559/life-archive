// Writing a query from what the captain said (the Query bar's Generate, POST
// /api/archive/query/generate): a new query from the transcript, which is what
// the Query bar always asks for, or, given a current query, that query changed
// as the transcript says (one in the query language, query.ts, rewritten as SQL).
// It writes SQL (sqlQuery.ts), so whatever the archive can answer is one query.
// The model is told the views and tables a query reads (with what each column
// means), every tag and every field value with how many people (everyone,
// archived people too) have it, today's date, the current query and the
// transcript: never anyone's name, aliases, note or messages. It lists each
// condition the transcript asks for and whether the query has it, and those it
// left out are the note under the Query bar's box, so nothing is dropped quietly.
// What it writes is run before it is shown; a query that does not run is sent
// back once with the error, and if it still does not run, the error is what
// the captain sees. The model is whatever answers the server's AI service
// (server/ai.ts: the installation's adapter, Codex where a model is named).

import { Data, Effect } from "effect";
import { type Ai, dayKey, type GeneratedQuery, InvalidInputError, isSqlQuery, LOCALE, runPromise, UnavailableError, zonePlace } from "../../../sdk/server.ts";
import { QUERY_WORDS, QueryError, valueKey, type QueryPerson, type QueryVocabulary } from "./query.ts";
import { freshSchema } from "./schema.ts";
import { isContent, SQL_VIEWS } from "./sqlRead.ts";

/** One condition the transcript asks for, in the captain's words, and whether the query has it (and if not, why). */
export interface AskedPart {
  said: string;
  in_query: boolean;
  why_not: string;
}

/** A model asked to write a query: its instructions and the request, answered with the query and each condition asked for. */
export type QueryModel = (request: { system: string; prompt: string }) => Promise<{ query: string; parts: AskedPart[] }>;

/** The answer's shape: the query, and each condition the transcript asks for. */
const ANSWER = {
  type: "object",
  properties: {
    query: { type: "string" },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: { said: { type: "string" }, in_query: { type: "boolean" }, why_not: { type: "string" } },
        required: ["said", "in_query", "why_not"],
        additionalProperties: false,
      },
    },
  },
  required: ["query", "parts"],
  additionalProperties: false,
} as const;

/** The AI service as the query writer: asked for an answer in ANSWER's shape. */
export function aiQueryModel(ai: Ai): QueryModel {
  return async ({ system, prompt }) => {
    const text = await ai.ask({ instructions: system, prompt, schema: ANSWER });
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = null;
    }
    const { query, parts } = (answer ?? {}) as { query?: unknown; parts?: unknown };
    const read = Array.isArray(parts) && parts.every((part) =>
      typeof part?.said === "string" && typeof part.in_query === "boolean" && typeof part.why_not === "string");
    if (typeof query !== "string" || !read) throw new UnavailableError(`the model's answer could not be read: ${text.slice(0, 200)}`);
    return { query, parts: parts as AskedPart[] };
  };
}

/** A transcript longer than this is not a query (a paste gone wrong, say). */
const TRANSCRIPT_MAX = 4000;

/** The tables the model is told of, with what a row is. The rest (changesets, sources, connectors' state) never say who someone is. */
const TABLES: Record<string, string> = {
  person: "a person; is_self = 1 is the captain; name (their label), aliases_json (their other names, in order), note and location are his for them; to find someone by any name, use the view person_names",
  import_person: "an account on a platform; person_id is whose it is; is_self = 1 is one of the captain's",
  import_person_stats: "an account's message counts, which the views add up",
  tag: "the captain's tags",
  person_tag: "who has which tag",
  conversation: "a chat: type 'direct' is one-to-one, 'group' a group chat; the views leave out Marketplace chats and dropped ones, whose dropped_at is set",
  conversation_member: "who is in a chat; account_id is an import_person; the views leave out a member the captain took out of a group, whose removed_at is set",
  message: "a message; sender_account_id is an import_person; is_from_self = 1 when the captain sent it",
  reaction: "an emoji reaction to a message",
  attachment: "a file sent with a message",
  catch_up: "a catch-up: time the captain spent with people in person, on a date, for some hours (person_catch_up has who was at each); a call is a call (person_call)",
  catch_up_person: "who was at each catch-up",
  call: "a call in no chat, with one row for each person on it named (an import_person): the phone's call history's, with one other party (platform 'phone'), and an app's call with several people made in no group chat (a WhatsApp three-way call); person_call has it per person, with the other apps' call records",
};

/** The views, each column with what it means. */
function describeViews(): string {
  return Object.entries(SQL_VIEWS).map(([view, { row, columns }]) =>
    [`- ${view}: one row per ${row}.`, ...Object.entries(columns).map(([column, meaning]) => `    ${column}: ${meaning}`)].join("\n"),
  ).join("\n");
}

/** The tables in TABLES, as the migrations make them, each column with the table it points at, but content, which a query cannot read. */
function describeTables(): string {
  const tables = new Map(freshSchema().tables.map((table) => [table.name, table]));
  return Object.entries(TABLES).map(([name, about]) => {
    const table = tables.get(name);
    if (!table) throw new Error(`the archive has no table ${name}`);
    const points = new Map(table.foreignKeys.map((key) => [key.column, key.table]));
    const columns = table.columns.filter((c) => !isContent(name, c.name));
    return `- ${name} (${about}): ${columns.map((c) => (points.has(c.name) ? `${c.name} → ${points.get(c.name)}` : c.name)).join(", ")}`;
  }).join("\n");
}

export const QUERY_INSTRUCTIONS = `You turn what the captain says into one SQLite query for friend-map, his private map of the people he talks to. He dictates, so expect speech-to-text slips. The query chooses people: one SELECT (or WITH ... SELECT) returning their ids as a column named person_id, each once. It runs read-only over his message archive, and the view he is in shows whom it returns.

The views (start with these):
${describeViews()}

The tables, for what the views do not say:
${describeTables()}

Two functions: day(ms) is the ${zonePlace()} day of a time, written 2025-01-31; days_ago(ms) is whole ${zonePlace()} days from then to today.

How to write it:
- SQLite. Strings in single quotes, a quote inside doubled ('Rock''n''roll'); double quotes only around a table or column name. Times are milliseconds since 1970; a day is text written 2025-01-31, so day >= '2025' and last_day < '2024-06' compare as dates do. Yes and no are 1 and 0.
- Make it easy to read: keywords in capitals, one condition per line, indented under WHERE.
- Each person once: SELECT DISTINCT person_id, or GROUP BY person_id.
- Write tags, values and platforms exactly as the request lists them. Someone with a tag: person_id IN (SELECT pt.person_id FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE t.name = 'climbing'); a family of tags: t.name LIKE 'is-%'. For a place, kind of person or group that no single tag or value names, take every listed tag or value that belongs to it: location IN ('Berlin', 'Paris').
- Archived people: people.archived (by him or by the rules; the archive tag is only those he archived himself). Each view hides archived people until he unticks archive in its Hide, so add NOT archived only when he asks for it.
- Messages: what he sent is from_me in direct_message, or direct_from_me; what they sent him, direct_from_them; both ways, direct_messages. In group chats only what they sent is counted (group_messages, person_group.sent). For one platform, count in person_platform, or in direct_message with its platform. "On Discord" is anyone with an account there (person_platform.platform = 'discord'); "only on Discord" is people.platforms = 'discord'.
- Discord's data package holds only his own messages: every Discord message is from_me, and what the other side sent there is not in the archive at all. So a Discord count is what he sent; never take it as both ways, and say in why_not that what they sent on Discord is not known when he asks for it.
- Dates are relative to today, given in the request: "not talked in a year" is days_ago(last_message_at) > 365.
- Catch-ups are time he spent with someone, which he records, each on a date (and, when he said, the time it started, such as '19:30') with how many hours it lasted (a trip away together runs from day to last_day, its hours its time together in all), always in person, and how many others he did not name were there (person_catch_up). "Caught up with this year" is coalesce(last_day, day) >= the year's first day; "spent more than 5 hours with" adds up hours (SUM(hours) > 5, grouped by person_id). Calls are not catch-ups: they are in person_call, the calls he logged among them; "caught up with, in person or by a call" takes both.
- Calls are in person_call, apart from catch-ups he records: the phone's own call history (phone and FaceTime calls, platform 'phone'), the other apps' calls in one-to-one chats (Messenger, Instagram, WhatsApp, WeChat, Signal, Telegram, by platform), an app's call with several people in no chat (a WhatsApp three-way call: one row for each person on it, people saying how many were on it), and the calls he logged himself (manual_call_id set). A call that happened is answered = 1; "talked for over an hour on calls" adds up duration_seconds over answered calls (SUM(duration_seconds) > 3600, grouped by person_id); "on the phone" is platform = 'phone'; missed calls are answered = 0 AND direction = 'incoming'. Some calls have no length (both null: WeChat's, Signal's answered ones, and Messenger's from its phone-app export, unless the captain gave one a length), so they are in no sum of duration_seconds; Signal and Messenger say when a call was missed, WeChat never does, so leave WeChat out of anything about missed calls, and say so in why_not when he asks for it on WeChat.
- A query cannot read what anyone wrote: message text, the full-text index, catch-ups' notes and drafts are closed to it, and a query reading them is refused. Asked who said or talked about something, leave that out, with why_not saying a query cannot read messages.
- With a current query, change it as the transcript says and keep the rest of it; "also", "and", "plus" add to it, "not", "without", "except" take away from it. Without one, write a new query.

Never leave out quietly any part of what he asks:
- Put every condition the transcript asks for in the query.
- In parts, list each condition the transcript asks for, in his words, with in_query true when the query has it. One the archive cannot answer (nothing in it says who likes pizza, say) stays out of the query, with in_query false and why_not saying why in a few plain words.
- If nothing he asks can be put in a query, answer with the current query unchanged (empty when there is none).

Two examples. "people on Discord I've sent more than 10 messages to":
SELECT person_id
FROM person_platform
WHERE platform = 'discord'
  AND direct_from_me > 10
"in three or more of my group chats but never messaged one to one":
SELECT person_id
FROM person_group
GROUP BY person_id
HAVING count(*) >= 3
EXCEPT
SELECT person_id
FROM people
WHERE direct_messages > 0`;

/** What a current query in the query language means, for the model to rewrite it as SQL. */
const LANGUAGE = `The current query is in the query language, not SQL: rewrite it as SQL that means the same, changed as the transcript says. In that language a word is a tag (* is any run of characters: is-* is every tag starting "is-"); field:value is someone with that location value, or an account on that platform, written lowercase with dashes for spaces (location:new-york is 'New York'); group:"title" is someone in a group chat of that title, and group:#75 in the one whose conversation_id is 75 (person_group); ${QUERY_WORDS.flags.join(", ")} mean marked to reach out to, none of his tags but archive and keep, and archived (people.archived); ${QUERY_WORDS.counts.join(", ")} compare messages, direct_messages and group_messages with a number; ${QUERY_WORDS.date} compares last_day with a year, month or day (${QUERY_WORDS.date}<2025-01 is last_day < '2025-01'); the tag archive is everyone archived (people.archived); NOT binds tightest, then AND, then OR.`;

/** Where a field's values are in SQL. */
const FIELD_COLUMNS: Record<string, string> = { location: "people.location", platform: "person_platform.platform" };

/** Each of `values` with how many of `people` have it, as "value (count)", values matched as the query language writes them: in their order, or with `most`, most first. */
function counted(values: readonly string[], people: readonly QueryPerson[], of: (person: QueryPerson) => readonly string[], most = false): string {
  const counts = new Map(values.map((value) => [valueKey(value), { value, count: 0 }]));
  for (const person of people) {
    for (const key of new Set(of(person).map(valueKey))) {
      const entry = counts.get(key);
      if (entry) entry.count++;
    }
  }
  const entries = [...counts.values()];
  if (most) entries.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return entries.map(({ value, count }) => `${value} (${count})`).join(", ") || "none";
}

/** The request the model sees: what there is to ask for, and what the captain asked. */
export function queryPrompt(
  { current, transcript, people, vocabulary, now = Date.now() }:
  { current: string; transcript: string; people: readonly QueryPerson[]; vocabulary: QueryVocabulary; now?: number },
): string {
  const query = current.trim();
  const archived = people.filter((person) => person.archived !== null);
  return [
    `Today: ${dayKey(now)}`,
    `Who is searched: everyone, archived people too (the view's Hide then leaves out the tags it hides), ${people.length} people`,
    `Archived (people.archived): ${archived.length}, of them by him (archived_by = 'you'): ${archived.filter((person) => person.archived === "you").length}`,
    `Tags (tag.name), with how many have each: ${counted(vocabulary.tags, people, (person) => person.tags)}`,
    `Fields, with their values and how many have each:`,
    ...Object.entries(vocabulary.fields).map(([field, values]) =>
      `- ${field} (${FIELD_COLUMNS[field] ?? field}): ${counted(values, people, (person) => person.fields[field] ?? [], true)}`),
    ...(query && !isSqlQuery(query) ? [LANGUAGE] : []),
    `Current query: ${query || "(none: write a new one)"}`,
    `Transcript: ${transcript.trim()}`,
  ].join("\n");
}

/** The model's query, kept as written but for line endings and the space around each line. */
function tidy(query: string): string {
  return query.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

/** What the model left out of the query, for the line under the Query bar's box; empty when nothing. */
function leftOut(parts: readonly AskedPart[]): string {
  // Each part's own full stop is dropped: the line ends with one.
  const bare = (text: string) => text.trim().replace(/[.\s]+$/, "");
  const out = parts.filter((part) => !part.in_query);
  if (out.length === 0) return "";
  return `Not in the query: ${out.map((part) => `${bare(part.said)}${bare(part.why_not) ? ` (${bare(part.why_not)})` : ""}`).join("; ")}.`;
}

/** A query the model wrote that does not run, sent back to it once with why. */
class DoesNotRun extends Data.TaggedError("DoesNotRun")<{ readonly query: string; readonly message: string }> {}

/**
 * A query from `transcript`, new or changing `current`, run with `run` (matchQuery
 * over the archive) to count it. Throws InvalidInputError for an empty transcript,
 * and UnavailableError when the model's query still does not run after one retry.
 */
export function writeQuery(
  model: QueryModel,
  request: { current: string; transcript: string; people: readonly QueryPerson[]; vocabulary: QueryVocabulary; now?: number },
  run: (query: string) => Promise<readonly number[]>,
): Promise<GeneratedQuery> {
  const transcript = request.transcript.trim();
  if (!transcript) return Promise.reject(new InvalidInputError("say what you want in the Transcript box first"));
  if (transcript.length > TRANSCRIPT_MAX) return Promise.reject(new InvalidInputError(`a transcript is at most ${TRANSCRIPT_MAX.toLocaleString(LOCALE)} characters`));
  let prompt = queryPrompt({ ...request, transcript });
  const attempt = Effect.gen(function* () {
    const answer = yield* Effect.tryPromise({ try: () => model({ system: QUERY_INSTRUCTIONS, prompt }), catch: (error) => error as Error });
    const query = tidy(answer.query);
    // SQL, or, when nothing could be said, the current query unchanged (empty when there is none).
    if (!isSqlQuery(query) && query !== request.current.trim()) return yield* new DoesNotRun({ query, message: "it is not SQL: answer with one SELECT returning person_id" });
    const found = yield* Effect.tryPromise({
      try: () => run(query),
      catch: (error) => (error instanceof QueryError ? new DoesNotRun({ query, message: error.message }) : (error as Error)),
    });
    return { query, count: found.length, note: leftOut(answer.parts) };
  });
  return runPromise(
    attempt.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error instanceof DoesNotRun) prompt += `\n\nYou answered with the query ${JSON.stringify(error.query)}, which does not run: ${error.message}. Answer again with a query that does.`;
        }),
      ),
      Effect.retry({ times: 1, while: (error) => error instanceof DoesNotRun }),
      Effect.mapError((error) => (error instanceof DoesNotRun ? new UnavailableError(`the model wrote "${error.query}", which does not run: ${error.message}`) : error)),
    ),
  );
}
