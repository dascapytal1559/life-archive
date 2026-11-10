import { describe, expect, it } from "vitest";
import { answerQuery, parseQuery, QueryError, runQuery, type QueryPerson, type QueryVocabulary } from "./query.ts";

const person = (id: number, over: Partial<QueryPerson> = {}): QueryPerson => ({
  id,
  tags: [],
  archived: null,
  shouldReachOut: false,
  fields: { platform: ["messenger"] },
  messageCount: 0,
  directMessageCount: 0,
  groupMessageCount: 0,
  lastMessageAt: null,
  ...over,
});

// Melbourne days: 10 am there is the same calendar day.
const day = (date: string) => Date.parse(`${date}T10:00:00+10:00`);

const PEOPLE: QueryPerson[] = [
  person(1, { tags: ["lives-berlin", "is-programmer"], fields: { platform: ["telegram", "messenger"], location: ["Berlin"] }, messageCount: 500, directMessageCount: 450, groupMessageCount: 50, lastMessageAt: day("2026-09-01") }),
  person(2, { tags: ["lives-paris", "plays-chess"], fields: { platform: ["whatsapp"], location: ["Paris"] }, messageCount: 120, directMessageCount: 20, groupMessageCount: 100, lastMessageAt: day("2024-12-31") }),
  person(3, { tags: ["lives-toronto", "met-tokyo"], fields: { platform: ["messenger"], location: ["New York"] }, messageCount: 99, directMessageCount: 99, lastMessageAt: day("2025-01-01") }),
  person(4, { tags: ["met-tokyo", "keep"], shouldReachOut: true, messageCount: 3, directMessageCount: 3, lastMessageAt: day("2025-01-31") }),
  person(5, { tags: [], fields: { platform: [] } }),
  person(6, { tags: ["archive"], archived: "you", lastMessageAt: day("2019-05-05") }),
  person(7, { tags: [], archived: "groups-silent" }),
];

const VOCABULARY: QueryVocabulary = {
  tags: ["archive", "keep", "lives-berlin", "lives-paris", "lives-toronto", "met-tokyo", "is-programmer", "plays-chess", "high-school"],
  fields: { platform: ["messenger", "telegram", "whatsapp"], location: ["Berlin", "Paris", "New York"] },
};

/** Two group chats called "Climbing crew" (1 and 3 in one, 2 in the other), "Old flat" (4), and an untitled one (5 and 7). */
const GROUPS: NonNullable<QueryVocabulary["groups"]> = {
  list: [{ id: 10, title: "Climbing crew" }, { id: 11, title: "Climbing Crew" }, { id: 12, title: "Old flat" }, { id: 13, title: null }],
  members: (ids) => new Set(ids.flatMap((id) => ({ 10: [1, 3], 11: [2], 12: [4], 13: [5, 7] })[id] ?? [])),
};

const run = (query: string, vocabulary: QueryVocabulary = { ...VOCABULARY, groups: GROUPS }) => runQuery(query, PEOPLE, vocabulary);
const fails = (query: string) => {
  try {
    run(query);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return (error as Error).message;
  }
  throw new Error(`${query} ran`);
};

describe("the query language", () => {
  it("matches everyone with an empty query", () => {
    expect(run("")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(run("   ")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseQuery("")).toBeNull();
  });

  it("matches the people in a group chat by its title, as tags are written, or by its number", () => {
    expect(run('group:"Climbing crew"')).toEqual([1, 2, 3]);
    expect(run("group:climbing-crew AND NOT platform:whatsapp")).toEqual([1, 3]);
    expect(run("group:old*")).toEqual([4]);
    expect(run("group:#13")).toEqual([5, 7]);
    expect(run("group:#10 OR group:#12")).toEqual([1, 3, 4]);
    expect(fails("group:old-flats")).toBe('there is no group chat "old-flats"; did you mean old-flat?');
    expect(fails("group:#99")).toBe("there is no group chat #99");
    expect(fails("group")).toMatch(/^group needs a title/);
    expect(fails("group:x*")).toBe("there is no group chat matching x*");
    // Where group chats are not given (the model writing queries is not told of them), none can be asked for.
    expect(() => run("group:#10", VOCABULARY)).toThrow("group chats can't be asked for here");
  });

  it("matches tags, in any case", () => {
    expect(run("lives-berlin")).toEqual([1]);
    expect(run("Met-Tokyo")).toEqual([3, 4]);
    expect(run("tag:plays-chess")).toEqual([2]);
    // A tag nobody has yet is fine; it matches nobody.
    expect(run("high-school")).toEqual([]);
  });

  it("binds NOT tightest, then AND, then OR, with parentheses to group", () => {
    expect(run("lives-berlin OR lives-paris AND plays-chess")).toEqual([1, 2]);
    expect(run("(lives-berlin OR lives-paris) AND plays-chess")).toEqual([2]);
    expect(run("lives-berlin OR lives-paris AND NOT plays-chess")).toEqual([1]);
    expect(run("met-tokyo AND NOT lives-toronto")).toEqual([4]);
    expect(run("NOT NOT met-tokyo")).toEqual([3, 4]);
    expect(run("NOT (lives-berlin OR met-tokyo)")).toEqual([2, 5, 6, 7]);
    expect(run("lives-paris and not plays-chess or is-programmer")).toEqual([1]);
  });

  it("takes * as any run of characters, in tags and values", () => {
    expect(run("lives-*")).toEqual([1, 2, 3]);
    expect(run("tag:*-tokyo")).toEqual([3, 4]);
    // Any tag at all, the rules' "archive" included.
    expect(run("*")).toEqual([1, 2, 3, 4, 6, 7]);
    expect(run("location:p*")).toEqual([2]);
  });

  it("matches fields' values as tags are written, or quoted", () => {
    expect(run("platform:telegram")).toEqual([1]);
    expect(run("platform:Messenger")).toEqual([1, 3, 4, 6, 7]);
    expect(run("location:new-york")).toEqual([3]);
    expect(run('location:"New York" OR location:berlin')).toEqual([1, 3]);
    // Someone with no value for a field matches none of its values.
    expect(run("NOT location:*")).toEqual([4, 5, 6, 7]);
  });

  it("has flags for reaching out, the untagged and the archived", () => {
    expect(run("should-reach-out")).toEqual([4]);
    // archive and keep are archive controls, not the captain's tags.
    expect(run("untagged")).toEqual([5, 6, 7]);
    expect(run("archived")).toEqual([6, 7]);
    expect(run("NOT archived AND untagged")).toEqual([5]);
    // "archive" is everyone archived, by the captain or by the rules, as the Table shows it; system-archive is gone.
    expect(run("archive")).toEqual([6, 7]);
    expect(run("tag:archive")).toEqual([6, 7]);
    expect(() => run("system-archive")).toThrow(/no tag "system-archive"/);
  });

  it("compares message counts", () => {
    expect(run("messages>100")).toEqual([1, 2]);
    expect(run("messages >= 99")).toEqual([1, 2, 3]);
    expect(run("messages=3")).toEqual([4]);
    expect(run("direct-messages<50 AND messages>0")).toEqual([2, 4]);
    expect(run("group-messages>=100")).toEqual([2]);
  });

  it("compares the last message's Melbourne day with a year, month or day", () => {
    expect(run("last-spoke<2025-01")).toEqual([2, 6]);
    expect(run("last-spoke=2025-01")).toEqual([3, 4]);
    expect(run("last-spoke>2025-01")).toEqual([1]);
    expect(run("last-spoke>=2025-01-31")).toEqual([1, 4]);
    expect(run("last-spoke<=2025")).toEqual([2, 3, 4, 6]);
    expect(run("last-spoke=2019-05-05")).toEqual([6]);
    // Someone never spoken to matches no date, either way.
    expect(run("NOT last-spoke<2100 AND NOT last-spoke>1900")).toEqual([5, 7]);
  });

  it("says what is wrong with a query that can't be read", () => {
    expect(fails("lives-berlin lives-paris")).toBe('put AND or OR between "lives-berlin" and "lives-paris"');
    expect(fails("messages>100 plays-chess")).toBe('put AND or OR between "messages>100" and "plays-chess"');
    expect(fails("(lives-berlin OR lives-paris")).toBe('the "(" at "(lives-berlin OR lives-paris" is never closed: add ")"');
    expect(fails("lives-berlin)")).toBe('the ")" at ")" has no "(" before it');
    expect(fails("lives-berlin AND")).toBe('expected a tag, a field or "(" at the end');
    expect(fails("NOT")).toBe('expected a tag, a field or "(" at the end');
    expect(fails("OR lives-berlin")).toBe('expected a tag, a field or "(" at "OR lives-berlin"');
    expect(fails("messages")).toBe("messages needs a comparison, such as messages>100");
    expect(fails("messages>")).toBe("messages> needs a value, such as messages>100");
    expect(fails("messages>lots")).toBe('messages compares with a whole number, such as messages>100, not "lots"');
    expect(fails("last-spoke<january")).toBe('last-spoke compares with a date written 2025, 2025-01 or 2025-01-31, not "january"');
    expect(fails("last-spoke<2025-13")).toMatch(/not "2025-13"/);
    expect(fails("last-spoke<2025-02-30")).toMatch(/not "2025-02-30"/);
    expect(fails("platform:")).toBe("platform: needs a value, such as platform:something");
    expect(fails('location:"new york')).toBe('the quote at ""new york" is never closed: add "');
  });

  it("says when a tag, field or value is not there, with the nearest", () => {
    expect(fails("lives-berlim")).toBe('there is no tag "lives-berlim"; did you mean lives-berlin?');
    expect(fails("plays")).toBe('there is no tag "plays"; did you mean plays-chess?');
    expect(fails("banana")).toBe('there is no tag "banana"');
    expect(fails("lives-x*")).toBe("there is no tag matching lives-x*");
    expect(fails("platform:signal")).toBe('nobody has platform "signal"; the values are messenger, telegram, whatsapp');
    expect(fails("location:berln")).toBe('nobody has location "berln"; did you mean berlin?');
    expect(fails("location:x*")).toBe("nobody has location matching x*; the values are berlin, paris, new-york");
    expect(fails("occupation:chef")).toBe('"occupation:" is not a field; the fields are tag:, platform:, location:, group:');
    // Met and Lives became Location.
    expect(fails("met:tokyo")).toBe('"met:" is gone: Met and Lives became one Location, so ask location:tokyo');
    // A field written without its value.
    expect(fails("platform")).toBe("platform needs a value, such as platform:messenger");
    // Quotes make any word a tag, "and" included.
    expect(fails('"and"')).toBe('there is no tag "and"');
  });
});

describe("a query's answer", () => {
  it("counts how many of its matches Hide shows, the rules' archive as \"archive\", so the map can refuse too many", () => {
    // Everyone: 7, of whom 6 (the captain's) and 7 (the rules') are archived.
    expect(answerQuery("", PEOPLE, VOCABULARY)).toEqual({ ids: [1, 2, 3, 4, 5, 6, 7], shown: 7 });
    expect(answerQuery("", PEOPLE, VOCABULARY, ["archive"]).shown).toBe(5);
    expect(answerQuery("", PEOPLE, VOCABULARY, ["archive", "met-tokyo"]).shown).toBe(3);
    // Over the matches only, and a tag nobody here has hides nobody.
    expect(answerQuery("met-tokyo OR archived", PEOPLE, VOCABULARY, ["keep", "commercial"])).toEqual({ ids: [3, 4, 6, 7], shown: 3 });
  });
});
