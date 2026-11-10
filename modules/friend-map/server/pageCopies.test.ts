// friend-map's page (page/, the module's own since friend-map-frontend was retired) keeps its own copies of three of the
// archive's pieces, so its demo mode answers with none of the server's code: the name check `isPlaceholderName`
// (page/src/names.ts, against the archive's names.ts), the query language (page/src/demo/query.ts, against
// query.ts), and the tags Hide starts with on (page/src/demos/hideChoices.ts's HIDDEN_BY_DEFAULT, against tags.ts's,
// which decides whom the Events calendar leaves out and which tags are kept with nobody tagged). They answer as the
// archive's do, case by case: parsing, checking against a vocabulary, running and answering over the same made-up
// people, hiding the same tags. Change each pair together, or better, have the page's import the archive's (a
// follow-up now that both are this repository's).
//
// This is what is left of the demo parity test, which ran friend-map-frontend's demo (its generator, its in-page
// archive and its copy of the archiving rules) beside a real archive: that demo was never part of the page this module
// serves, so it went with friend-map-frontend.

import { describe, expect, it } from "vitest";
import { isPlaceholderName } from "../../../sdk/server.ts";
import { isPlaceholderName as pageIsPlaceholderName } from "../page/src/names.ts";
import { HIDDEN_BY_DEFAULT as PAGE_HIDDEN_BY_DEFAULT, hiddenTags, hides } from "../page/src/demos/hideChoices.ts";
import { EXAMPLES } from "../page/src/demo/examples.ts";
import * as pageQuery from "../page/src/demo/query.ts";
import { answerQuery, checkQuery, parseQuery, QUERY_WORDS, runQuery, valueKey, type QueryPerson } from "./query.ts";
import { deletesWhenEmpty, HIDDEN_BY_DEFAULT } from "./tags.ts";

/** What `f` gives for `input`, or the message it throws, to compare a copy with the original. */
const outcome = <I, O>(f: (input: I) => O, input: I) => {
  try {
    return { gives: f(input) };
  } catch (error) {
    return { throws: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error) };
  }
};

describe("the page's copies of the archive's name check and query language", () => {
  it("check names as the archive does", () => {
    for (const name of [
      "Ada Sample", "Bo", "Facebook user", "Instagram user", "Messenger user", "Unknown user", "Deleted user", "WhatsApp user",
      "Telegram user", "Meta user", "Signal user", "Ghost user", "INSTAGRAM USER", " deleted   user ", "", "   ", "?!", "+61 491 570 006", "0491 570 110",
      "‪+61 491 570‑110‬", "(03) 7010 0000", "78787", "CommBank", "ada@example.com", " Ada@Example.COM ",
      "COC7/7cGIAA=", "CKqC+pYG", "+EAA=", "Cleo", "Cleo2000", "+61491571266", "0061 491 570 006", "Ada Sample 🌱", "樣本",
    ]) {
      expect([name, pageIsPlaceholderName(name)]).toEqual([name, isPlaceholderName(name)]);
    }
  });

  it("read a query as the archive does, and refuse the same ones with the same words", () => {
    expect(pageQuery.QUERY_WORDS).toEqual(QUERY_WORDS);
    const queries = [
      ...EXAMPLES.map((e) => e.query), "", "climbing", "tag:climbing", "is-* OR *-chess", "location:new-york", 'location:"New York"',
      "NOT (a OR b) AND c", "not a and b or c", "group:#12", 'group:"Lorem crew"', "messages>100", "direct-messages<=3", "group-messages=0",
      "last-spoke<2025-01", "last-spoke>=2025", "last-spoke=2025-01-31", "should-reach-out AND untagged", "archived", '"and"',
      "a b", "(a", "a)", "AND", "messages>lots", "last-spoke<soon", "location:", "tag:", "a OR", "NOT", "messages>", 'location:"open',
    ];
    for (const query of queries) {
      expect([query, outcome(pageQuery.parseQuery, query)]).toEqual([query, outcome(parseQuery, query)]);
    }
    for (const value of ["New York", "  Ada's  Place ", "climbing", "Ünïcödé"]) expect(pageQuery.valueKey(value)).toBe(valueKey(value));
  });

  it("check, run and answer a query over the same people as the archive does, refusing the same ones", () => {
    // Made-up people covering each word of the language: tags, fields, flags, counts, the last time they spoke, groups.
    const at = (day: string) => Date.parse(`${day}T12:00:00`);
    const people: QueryPerson[] = [
      { id: 1, tags: ["climbing", "is-chess"], archived: null, shouldReachOut: true, fields: { location: ["new-york"], platform: ["messenger"] }, messageCount: 250, directMessageCount: 200, groupMessageCount: 50, lastMessageAt: at("2024-12-20") },
      { id: 2, tags: ["archive"], archived: "you", shouldReachOut: false, fields: { location: ["melbourne"], platform: ["whatsapp"] }, messageCount: 3, directMessageCount: 3, groupMessageCount: 0, lastMessageAt: at("2025-01-31") },
      { id: 3, tags: [], archived: "no-name", shouldReachOut: false, fields: {}, messageCount: 0, directMessageCount: 0, groupMessageCount: 0, lastMessageAt: null },
      { id: 4, tags: ["keep", "and"], archived: null, shouldReachOut: true, fields: { location: ["new-york"] }, messageCount: 101, directMessageCount: 1, groupMessageCount: 100, lastMessageAt: at("2025-06-01") },
      { id: 5, tags: ["climbing", "keep"], archived: null, shouldReachOut: false, fields: { platform: ["messenger", "whatsapp"] }, messageCount: 40, directMessageCount: 40, groupMessageCount: 0, lastMessageAt: at("2025-01-01") },
    ];
    const groups = { list: [{ id: 12, title: "Lorem crew" }, { id: 13, title: null }], members: (ids: readonly number[]) => new Set(ids.includes(12) ? [1, 4] : ids.includes(13) ? [5] : []) };
    const vocabulary = { tags: ["climbing", "is-chess", "archive", "keep", "and"], fields: { location: ["new-york", "melbourne"], platform: ["messenger", "whatsapp"] }, groups };
    const queries = [
      ...EXAMPLES.map((e) => e.query), "", "climbing", "tag:climbing", "is-* OR *-chess", "location:new-york", 'location:"New York"', "location:nowhere", "platform:whatsapp",
      "NOT (climbing OR keep) AND untagged", "not climbing and keep or archived", "group:#12", "group:#99", 'group:"Lorem crew"', 'group:"No such crew"', "messages>100",
      "direct-messages<=3", "group-messages=0", "last-spoke<2025-01", "last-spoke>=2025", "last-spoke=2025-01-31", "should-reach-out AND untagged", "archived", '"and"',
      "nosuchtag", "a b", "(a", "AND", "messages>lots", "location:", "NOT",
    ];
    for (const query of queries) {
      expect([query, outcome((text: string) => pageQuery.checkQuery(pageQuery.parseQuery(text), vocabulary), query)]).toEqual([query, outcome((text: string) => checkQuery(parseQuery(text), vocabulary), query)]);
      expect([query, outcome((text: string) => pageQuery.runQuery(text, people, vocabulary), query)]).toEqual([query, outcome((text: string) => runQuery(text, people, vocabulary), query)]);
      for (const hide of [[], ["archive"], ["keep", "climbing"]]) {
        expect([query, hide, outcome((text: string) => pageQuery.answerQuery(text, people, vocabulary, hide), query)]).toEqual([query, hide, outcome((text: string) => answerQuery(text, people, vocabulary, hide), query)]);
      }
    }
    // Not every query refused: the comparison means something only if most of them answer.
    expect(queries.filter((query) => "gives" in outcome((text: string) => answerQuery(text, people, vocabulary), query)).length).toBeGreaterThan(queries.length / 2);
  });
});

describe("the page's copy of the tags Hide starts with on", () => {
  it("is the archive's, so the map hides as it starts whom the Events calendar leaves out", () => {
    expect(PAGE_HIDDEN_BY_DEFAULT).toEqual(HIDDEN_BY_DEFAULT);
    expect(hiddenTags({})).toEqual([...HIDDEN_BY_DEFAULT]);
    for (const tag of [...HIDDEN_BY_DEFAULT, "climbing", "keep", "live-together", "aspiring", "system-archive"]) {
      expect([tag, hides({}, tag)]).toEqual([tag, HIDDEN_BY_DEFAULT.includes(tag)]);
      if (hides({}, tag)) expect([tag, deletesWhenEmpty({ name: tag, builtIn: false })]).toEqual([tag, false]);
    }
  });
});
