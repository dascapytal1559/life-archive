import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importChats, me } from "../fixtures/chats.ts";
import { type Db, InvalidInputError, UnavailableError } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { QUERY_INSTRUCTIONS, queryPrompt, writeQuery, type AskedPart, type QueryModel } from "./queryWriter.ts";
import { matchQuery } from "./sqlQuery.ts";
import { ArchiveStructure } from "./structure.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

const id = (name: string) => structure.listPeople().people.find((p) => p.name === name)!.id;
const ids = (...names: string[]) => names.map(id).sort((a, b) => a - b);
const run = (query: string) => matchQuery(db, query, structure.queryable());
const sorted = async (query: string) => [...(await run(query))].sort((a, b) => a - b);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-query-writer-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
  importChats(db, "discord", [
    { id: "dan", members: ["Dannoxa"], from: me(12) },
    { id: "ten", members: ["Tenvik"], from: me(10) },
    // Elistro wrote most of it: 17 both ways, 2 from the captain.
    { id: "eli", members: ["Elistro"], from: [...Array.from({ length: 15 }, () => "Elistro"), ...me(2)], text: "secret marmalade plan" },
    { id: "mo", members: ["Mowbray"], from: me(1) },
  ]);
  // Mowbray is on Telegram too, where the captain sent 20.
  importChats(db, "telegram", [{ id: "mo-tg", members: ["Mowbray on Telegram"], from: me(20) }]);
  people.runRules();
  people.merge(id("Mowbray"), id("Mowbray on Telegram"));
  people.setTags(id("Elistro"), ["climbing"]);
  people.setTags(id("Mowbray"), ["climbing"]);
  people.setLocation(id("Elistro"), "New York");
  people.setAliases(id("Elistro"), ["Elijah"]);
  people.setNote(id("Elistro"), "met at the bouldering gym");
});

afterAll(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A model that answers from a list, and keeps what it was asked. */
function stub(...answers: Array<{ query: string; parts?: AskedPart[] }>) {
  const asked: Array<{ system: string; prompt: string }> = [];
  const model: QueryModel = async (request) => {
    asked.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error("asked too often");
    return { parts: [], ...answer };
  };
  return { model, asked };
}

const NOW = Date.parse("2026-09-30T12:00:00+10:00");
const request = (current: string, transcript: string) => ({ current, transcript, ...structure.queryable(), now: NOW });
const part = (said: string, why_not = ""): AskedPart => ({ said, in_query: !why_not, why_not });

const SENT_ON_DISCORD = `SELECT person_id
FROM person_platform
WHERE platform = 'discord'
  AND direct_from_me > 10`;

describe("writing a SQL query from what the captain said", () => {
  it("\"people on Discord I've sent more than 10 messages to\" counts only his own messages, on Discord alone", async () => {
    const { model, asked } = stub({ query: SENT_ON_DISCORD, parts: [part("people on Discord"), part("I've sent more than 10 messages to")] });
    const written = await writeQuery(model, request("", "people on Discord that I've sent more than 10 messages to"), run);
    expect(written).toEqual({ query: SENT_ON_DISCORD, count: 1, note: "" });
    expect(await sorted(written.query)).toEqual(ids("Dannoxa"));
    expect(asked[0].system).toBe(QUERY_INSTRUCTIONS);
    expect(asked[0].prompt).toContain("Current query: (none: write a new one)");
    // The near misses it must not be: both ways counts Elistro's own messages, and every platform counts Mowbray's on Telegram.
    expect(await sorted("SELECT person_id FROM person_platform WHERE platform = 'discord' AND direct_messages > 10")).toEqual(ids("Dannoxa", "Elistro"));
    expect(await sorted("SELECT person_id FROM people WHERE ',' || platforms || ',' LIKE '%,discord,%' AND direct_from_me > 10")).toEqual(ids("Dannoxa", "Mowbray"));
  });

  it("writes who writes to him more than he writes to them, and a tag with a platform", async () => {
    const more = "SELECT person_id\nFROM people\nWHERE direct_from_them > direct_from_me";
    const climbers = `SELECT pp.person_id
FROM person_platform pp
WHERE pp.platform = 'telegram'
  AND pp.person_id IN (
    SELECT pt.person_id FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE t.name = 'climbing'
  )`;
    const { model } = stub({ query: more }, { query: climbers });
    expect(await writeQuery(model, request("", "people who write to me more than I write to them"), run)).toMatchObject({ query: more, count: 1 });
    expect(await sorted(more)).toEqual(ids("Elistro"));
    expect(await writeQuery(model, request("", "climbers on Telegram"), run)).toMatchObject({ query: climbers, count: 1 });
    expect(await sorted(climbers)).toEqual(ids("Mowbray"));
  });

  it("keeps the query's lines and comments as written, but for the space around them", async () => {
    const { model } = stub({ query: "\r\n  -- Discord, sent by me\r\nSELECT person_id   \r\nFROM person_platform\r\nWHERE platform = 'discord';  \n" });
    const written = await writeQuery(model, request("", "Discord"), run);
    expect(written.query).toBe("-- Discord, sent by me\nSELECT person_id\nFROM person_platform\nWHERE platform = 'discord';");
    expect(written.count).toBe(4);
  });

  it("says, under the box, each part it left out and why", async () => {
    const { model } = stub({
      query: "SELECT person_id FROM person_platform WHERE platform = 'discord'",
      parts: [part("on Discord"), part("who like pizza", "Nothing in the archive says what people like."), part("who are tall", "")],
    });
    // A part left out says so even when the model gives no reason.
    const left = { ...part("who are tall"), in_query: false };
    const { model: second } = stub({ query: "SELECT person_id FROM person_platform WHERE platform = 'discord'", parts: [part("on Discord"), left] });
    expect((await writeQuery(model, request("", "Discord people who like pizza"), run)).note)
      .toBe("Not in the query: who like pizza (Nothing in the archive says what people like).");
    expect((await writeQuery(second, request("", "tall Discord people"), run)).note).toBe("Not in the query: who are tall.");
  });

  it("changes the SQL query in the box, which the model is given", async () => {
    const changed = `${SENT_ON_DISCORD}\n  AND person_id IN (SELECT person_id FROM people WHERE location = 'New York')`;
    const { model, asked } = stub({ query: changed });
    expect(await writeQuery(model, request(SENT_ON_DISCORD, "only the ones in New York"), run)).toMatchObject({ query: changed, count: 0 });
    expect(asked[0].prompt).toContain(`Current query: ${SENT_ON_DISCORD}`);
    expect(asked[0].prompt).not.toContain("the query language");
  });

  it("rewrites a query in the query language as SQL, told what that language means", async () => {
    const sql = "SELECT pt.person_id\nFROM person_tag pt\nJOIN tag t ON t.id = pt.tag_id\nWHERE t.name = 'climbing'";
    const { model, asked } = stub({ query: sql });
    expect(await writeQuery(model, request("climbing AND platform:discord", "drop the Discord part"), run)).toMatchObject({ query: sql, count: 2 });
    expect(asked[0].prompt).toContain("The current query is in the query language, not SQL: rewrite it as SQL");
    expect(asked[0].prompt).toContain("Current query: climbing AND platform:discord");
  });

  it("keeps the current query when nothing asked can be put in one, and sends back any other answer that is not SQL", async () => {
    const { model } = stub({ query: "climbing", parts: [part("who like pizza", "nothing says what people like")] });
    expect(await writeQuery(model, request("climbing", "who like pizza"), run))
      .toEqual({ query: "climbing", count: 2, note: "Not in the query: who like pizza (nothing says what people like)." });
    const { model: dsl, asked } = stub({ query: "platform:discord" }, { query: "SELECT person_id FROM person_platform WHERE platform = 'discord'" });
    expect(await writeQuery(dsl, request("", "Discord"), run)).toMatchObject({ count: 4 });
    expect(asked[1].prompt).toContain('You answered with the query "platform:discord", which does not run: it is not SQL');
  });

  it("sends back a query that does not run once, with the error, and takes the fixed one", async () => {
    const { model, asked } = stub({ query: "SELECT person_id FROM people WHERE direct_from_mee > 10" }, { query: "SELECT person_id FROM people WHERE direct_from_me > 10" });
    expect(await writeQuery(model, request("", "people I've sent more than 10"), run)).toMatchObject({ count: 2 });
    expect(asked).toHaveLength(2);
    expect(asked[1].prompt).toContain('which does not run: SQL: no such column: direct_from_mee. Answer again with a query that does.');
  });

  it("shows the error, never the query, when the model's query still does not run", async () => {
    const bad = "SELECT person_id FROM peple";
    const { model } = stub({ query: bad }, { query: bad });
    const error = await writeQuery(model, request("", "everyone"), run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnavailableError);
    expect((error as Error).message).toBe('the model wrote "SELECT person_id FROM peple", which does not run: SQL: no such table: peple');
  });

  it("asks for a transcript first", async () => {
    const { model, asked } = stub();
    await expect(writeQuery(model, request("climbing", "  "), run)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(writeQuery(model, request("", "x".repeat(4001)), run)).rejects.toBeInstanceOf(InvalidInputError);
    expect(asked).toHaveLength(0);
  });
});

describe("what the model is told", () => {
  it("the views with every column's meaning, the tables, the functions and how to quote", () => {
    for (const view of ["people", "person_platform", "person_group", "direct_message"]) expect(QUERY_INSTRUCTIONS).toContain(`- ${view}: one row per `);
    expect(QUERY_INSTRUCTIONS).toContain("    direct_from_me: of those, how many the captain sent them");
    expect(QUERY_INSTRUCTIONS).toContain("    from_me: 1 when the captain sent it");
    expect(QUERY_INSTRUCTIONS).toContain("- person_tag (who has which tag): person_id → person, tag_id → tag, added_at");
    expect(QUERY_INSTRUCTIONS).toMatch(/- message \(.*\): id, platform, conversation_id → conversation, .*sender_account_id → import_person, is_from_self, sent_at, type, reply_to_platform_id,/);
    // Never content, which a query cannot read.
    expect(QUERY_INSTRUCTIONS).not.toMatch(/- message \(.*\):.*\b(text|raw_json)\b/);
    expect(QUERY_INSTRUCTIONS).not.toMatch(/- catch_up \(.*\):.*\bnote\b/);
    expect(QUERY_INSTRUCTIONS).not.toContain("- message_fts");
    expect(QUERY_INSTRUCTIONS).toContain("A query cannot read what anyone wrote");
    expect(QUERY_INSTRUCTIONS).toContain("day(ms)");
    expect(QUERY_INSTRUCTIONS).toContain("days_ago(ms)");
    expect(QUERY_INSTRUCTIONS).toContain("Strings in single quotes, a quote inside doubled");
    expect(QUERY_INSTRUCTIONS).toContain("in_query false and why_not saying why");
    expect(QUERY_INSTRUCTIONS).toContain("Discord's data package holds only his own messages: every Discord message is from_me");
  });

  it("today, the tags and each field's values as stored, with counts, and where each is", () => {
    const prompt = queryPrompt(request("", "anyone"));
    expect(prompt).toContain("Today: 2026-09-30");
    expect(prompt).toContain("Who is searched: everyone, archived people too (the view's Hide then leaves out the tags it hides), 4 people");
    expect(prompt).toMatch(/Tags \(tag\.name\), with how many have each: .*climbing \(2\)/);
    expect(prompt).toContain("- location (people.location): New York (1)");
    expect(prompt).toContain("- platform (person_platform.platform): discord (4), telegram (1)");
    expect(prompt).toMatch(/Archived \(people\.archived\): \d+, of them by him \(archived_by = 'you'\): 0/);
  });

  it("never anyone's name, aliases, note or messages", () => {
    const prompt = queryPrompt(request("", "anyone"));
    const said = `${QUERY_INSTRUCTIONS}\n${prompt}`;
    for (const person of structure.listPeople().people) expect(said).not.toContain(person.name);
    expect(said).not.toContain("Elijah");
    expect(said).not.toContain("bouldering");
    expect(said).not.toContain("marmalade");
  });
});
