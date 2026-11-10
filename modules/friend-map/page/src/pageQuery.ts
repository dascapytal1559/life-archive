// The query language run in the page (src/demo/query.ts, the demo's copy of the life archive's), over people as the
// contract lists them: for a backend that does not run queries itself (no `query` capability, archiveHttp.ts), and
// for the demo's crowd (src/demo/archive.ts). A query starting SELECT or WITH is SQL, which only a backend serving
// `query.sql` runs.

import { isSqlQuery, platformsOf, type PersonSummary, type QueryResult } from "./archive.ts";
import { ArchiveError } from "./archiveApi.ts";
import { answerQuery, type QueryGroups, type QueryPerson, type QueryVocabulary } from "./demo/query.ts";
import { InvalidInputError } from "./invalidInput.ts";

/** What a query reads of a person: their tags, flags, counts, and their location and platforms as its fields. */
export function queryPerson(person: PersonSummary): QueryPerson {
  return {
    id: person.id,
    tags: person.tags,
    archived: person.archived,
    shouldReachOut: person.shouldReachOut,
    fields: { location: person.location ? [person.location] : [], platform: platformsOf(person.accounts) },
    messageCount: person.messageCount,
    directMessageCount: person.directMessageCount,
    groupMessageCount: person.groupMessageCount,
    lastMessageAt: person.lastMessageAt,
  };
}

/** What there is to ask for among `people`: every tag (`tags`, else theirs), location and platform, and `groups`. */
export function vocabularyOf(people: readonly QueryPerson[], { tags, locations, groups }: { tags?: readonly string[]; locations?: readonly string[]; groups?: QueryGroups } = {}): QueryVocabulary {
  const values = (field: string) => [...new Set(people.flatMap((p) => p.fields[field] ?? []))];
  return {
    tags: tags ?? [...new Set(people.flatMap((p) => p.tags))],
    fields: { location: locations ?? values("location"), platform: values("platform") },
    groups,
  };
}

/** Group chats a query can name, from their members as the map's report lists them (titled, or by number: group:#12). */
export function groupsOf(groups: ReadonlyArray<{ id: number; memberIds: readonly number[]; title?: string | null }>): QueryGroups {
  return {
    list: groups.map((g) => ({ id: g.id, title: g.title ?? null })),
    members: (ids) => new Set(groups.filter((g) => ids.includes(g.id)).flatMap((g) => g.memberIds)),
  };
}

/** Everyone `q` matches among `people`, and how many of them Hide (`hide`) shows; an ArchiveError, as a backend's 400, when it does not run. */
export function answerInPage(q: string, hide: readonly string[], people: readonly QueryPerson[], vocabulary: QueryVocabulary, sqlWhy: string): QueryResult {
  if (isSqlQuery(q)) throw new ArchiveError(`GET /query failed (400): ${sqlWhy}`, sqlWhy);
  try {
    return answerQuery(q, people, vocabulary, hide);
  } catch (error) {
    if (error instanceof InvalidInputError) throw new ArchiveError(`GET /query failed (400): ${error.message}`, error.message);
    throw error;
  }
}
