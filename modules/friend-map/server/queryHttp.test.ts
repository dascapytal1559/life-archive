import { mkdtemp, readFile, rm } from "node:fs/promises";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GeneratedQuery, PeopleListing, QueryResult, RelationshipsReport, TableRow } from "../../../sdk/server.ts";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { addSamplePeople, type SamplePerson } from "../fixtures/samplePeople.ts";
import { aiAnswering, archiveHandler } from "../testing/routes.ts";
import type { AskedPart, QueryModel } from "./queryWriter.ts";

const SAMPLE_PEOPLE = new URL("../fixtures/data/people.json", import.meta.url);

let dataDir: string;
let archive: TestArchive;
let server: Server;
let base: string;
/** What the stub model is asked, and what it answers next. */
const asked: Array<{ system: string; prompt: string }> = [];
const answers: Array<{ query: string; parts: AskedPart[] }> = [];
const model: QueryModel = async (request) => {
  asked.push(request);
  return answers.shift() ?? { query: "", parts: [] };
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-query-http-"));
  archive = await openTestArchive(dataDir);
  await archive.host.setEnabled("messenger-export", true);
  await archive.importHistory("messenger-export", await sampleMessengerExport(dataDir));
  addSamplePeople(archive, JSON.parse(await readFile(SAMPLE_PEOPLE, "utf8")) as SamplePerson[]);
  const handler = archiveHandler(archive, aiAnswering(model));
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/archive`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  archive.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

const query = (q: string) => fetch(`${base}/query?${new URLSearchParams({ q })}`);
const ids = async (q: string) => ((await (await query(q)).json()) as QueryResult).ids.sort((a, b) => a - b);
const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
const generate = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/query/generate`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the query routes", () => {
  it("runs a query over everyone, archived people too", async () => {
    const onMap = (await get<RelationshipsReport>("/relationships")).people.map((p) => p.id);
    const everyone = (await get<TableRow[]>("/table-rows")).map((p) => p.id).sort((a, b) => a - b);
    expect(everyone.length).toBeGreaterThan(onMap.length);
    // Empty: everyone.
    expect(await ids("")).toEqual(everyone);
    const ada = (await get<PeopleListing>("/people")).people.find((p) => p.name === "Ada Sample")!;
    expect(await ids("climbing")).toEqual([ada.id]);
    const table = await get<TableRow[]>("/table-rows");
    const onMessenger = table.filter((p) => p.platforms.includes("messenger") && !p.tags.includes("climbing")).map((p) => p.id).sort((a, b) => a - b);
    expect(onMessenger.length).toBeGreaterThan(0);
    expect(await ids("platform:messenger AND NOT climbing")).toEqual(onMessenger);
    expect((await ids("archived")).length).toBe(everyone.length - onMap.length);
    // "archive" is everyone archived, by the captain or the rules, as the Table shows it.
    const archived = table.filter((p) => p.archived !== null).map((p) => p.id);
    expect(archived.some((id) => table.find((p) => p.id === id)!.archived !== "you")).toBe(true);
    expect(await ids("archive")).toEqual(sorted(archived));
    expect(await ids("tag:archive")).toEqual(sorted(archived));
  });

  it("says how many of the matches have none of the hide tags, the rules' archive counting as archive", async () => {
    const answer = async (search: string) => get<QueryResult>(`/query?${search}`);
    const everyone = await answer("q=");
    expect(everyone.shown).toBe(everyone.ids.length);
    const onMap = (await get<RelationshipsReport>("/relationships")).people;
    const archivedHidden = await answer("q=&hide=archive");
    expect(archivedHidden.ids).toEqual(everyone.ids);
    expect(archivedHidden.shown).toBe(onMap.length);
    const climbing = onMap.filter((p) => p.tags.includes("climbing")).length;
    expect(climbing).toBeGreaterThan(0);
    expect((await answer("q=&hide=archive&hide=climbing")).shown).toBe(onMap.length - climbing);
  });

  it("adds to the map's report only the archived people Hide shows that the query matches, by the captain or the rules", async () => {
    const report = (path: string) => get<RelationshipsReport>(path);
    const table = await get<TableRow[]>("/table-rows");
    const onMap = (await report("/relationships")).people.map((p) => p.id);
    const archived = table.filter((p) => p.archived !== null);
    expect(archived.length).toBeGreaterThan(0);
    const plain = await report("/relationships");
    expect(plain.archivedCount).toBe(table.length - onMap.length);

    // Unticking archive with no query shows everyone archived, tagged so.
    const withArchived = await report("/relationships?reveal=archive");
    expect(sorted(withArchived.people.map((p) => p.id))).toEqual(sorted([...onMap, ...archived.map((p) => p.id)]));
    expect(withArchived.people.filter((p) => p.tags.includes("archive")).length).toBe(archived.length);
    expect(withArchived.archivedCount).toBe(plain.archivedCount);

    // Only the query's matches.
    const one = archived[0];
    const byCount = await report(`/relationships?${new URLSearchParams({ q: `messages=${one.messageCount}`, reveal: "archive" })}`);
    const matched = archived.filter((p) => p.messageCount === one.messageCount).map((p) => p.id);
    expect(sorted(byCount.people.map((p) => p.id).filter((id) => !onMap.includes(id)))).toEqual(sorted(matched));

    // The captain's archive and the rules' show together.
    const ada = table.find((p) => p.name === "Ada Sample")!;
    archive.people.setTags(ada.id, [...ada.tags, "archive"]);
    try {
      expect((await report("/relationships")).people.some((p) => p.id === ada.id)).toBe(false);
      const both = await report("/relationships?q=archived&reveal=archive");
      expect(both.people.find((p) => p.id === ada.id)?.tags).toContain("archive");
      // Ada, archived by the captain now, is still among them, as are all the rules archived.
      expect(sorted(both.people.map((p) => p.id))).toEqual(sorted([...onMap, ...archived.map((p) => p.id)]));
    } finally {
      archive.people.setTags(ada.id, ada.tags);
    }

    // A query that does not run shows none (the Query bar says why); anything but archive is refused, the old
    // system-archive too.
    expect((await report("/relationships?q=climbng&reveal=archive")).people.length).toBe(onMap.length);
    expect((await fetch(`${base}/relationships?reveal=commercial`)).status).toBe(400);
    expect((await fetch(`${base}/relationships?reveal=system-archive`)).status).toBe(400);
  });

  it("asks for where people are, and says met: and lives: are location: now", async () => {
    const ada = (await get<PeopleListing>("/people")).people.find((p) => p.name === "Ada Sample")!;
    archive.people.setLocation(ada.id, "New York");
    try {
      expect(await ids("location:new-york")).toEqual([ada.id]);
      expect(await ids('location:"New York"')).toEqual([ada.id]);
      expect(await ids("location:*")).toEqual([ada.id]);
      expect(await (await query("occupation:chef")).json()).toEqual({ error: '"occupation:" is not a field; the fields are tag:, location:, platform:, group:' });
      expect(await (await query("met:tokyo")).json()).toEqual({ error: '"met:" is gone: Met and Lives became one Location, so ask location:tokyo' });
      expect(await (await query("lives:new-york")).json()).toEqual({ error: '"lives:" is gone: Met and Lives became one Location, so ask location:new-york' });
      answers.push({ query: "SELECT person_id FROM people WHERE location = 'New York'", parts: [] });
      await generate({ transcript: "people in America" });
      expect(asked.at(-1)!.prompt).toContain("- location (people.location): New York (1)");
    } finally {
      archive.people.setLocation(ada.id, null);
    }
    // A location nobody is at any more is not there to ask for.
    expect((await query("location:new-york")).status).toBe(400);
  });

  it("asks for the people in a group chat, as its header lists them", async () => {
    const people = (await get<PeopleListing>("/people")).people;
    const named = (ids: number[]) => ids.map((id) => people.find((p) => p.id === id)?.name ?? `archived ${id}`).sort();
    const climbing = await get<QueryResult>(`/query?${new URLSearchParams({ q: 'group:"Climbing crew"' })}`);
    expect(named(climbing.ids)).toEqual(["Ada Sample", "Bruno P", "Cleo Example", "Gus Unlisted"]);
    const flat = await get<QueryResult>(`/query?${new URLSearchParams({ q: "group:old-flat OR group:climbing*" })}`);
    expect(flat.ids.length).toBe(6);
    const wrong = await fetch(`${base}/query?${new URLSearchParams({ q: "group:climbing-crews" })}`);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'there is no group chat "climbing-crews"; did you mean climbing-crew?' });
  });

  it("follows changes to people at once", async () => {
    const ada = (await get<PeopleListing>("/people")).people.find((p) => p.name === "Ada Sample")!;
    expect(await ids("should-reach-out")).toEqual([]);
    archive.people.setShouldReachOut(ada.id, true);
    expect(await ids("should-reach-out")).toEqual([ada.id]);
    archive.people.setShouldReachOut(ada.id, false);
  });

  it("answers 400 with what is wrong when a query does not run", async () => {
    const response = await query("climbing bouldering");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'put AND or OR between "climbing" and "bouldering"' });
    expect(await (await query("climbng")).json()).toEqual({ error: 'there is no tag "climbng"; did you mean climbing?' });
  });

  it("runs SQL as the query language runs: the same people, counted under Hide, its errors as 400", async () => {
    const sqlIds = async (q: string) => {
      const response = await query(q);
      expect(response.status, q).toBe(200);
      return sorted(((await response.json()) as QueryResult).ids);
    };
    // The same question both ways.
    expect(await sqlIds("SELECT person_id FROM people WHERE platforms LIKE '%messenger%' AND coalesce(tags, '') NOT LIKE '%climbing%'"))
      .toEqual(await ids("platform:messenger AND NOT climbing"));
    expect(await sqlIds("SELECT person_id FROM people WHERE archived")).toEqual(await ids("archived"));
    expect(await sqlIds("-- everyone\nSELECT person_id FROM people")).toEqual(await ids(""));
    // Hide counts SQL's matches as it counts the language's.
    const counted = async (q: string) => get<QueryResult>(`/query?${new URLSearchParams([["q", q], ["hide", "archive"]])}`);
    expect((await counted("SELECT person_id FROM people")).shown).toBe((await counted("")).shown);
    // The map's Hide reveals the archived people SQL matches.
    const revealed = await get<RelationshipsReport>(`/relationships?${new URLSearchParams({ q: "SELECT person_id FROM people WHERE archived", reveal: "archive" })}`);
    expect(revealed.people.filter((p) => p.tags.includes("archive")).length).toBe((await ids("archived")).length);
    const wrong = await query("SELECT person_id FROM peple");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "SQL: no such table: peple" });
    expect(await (await query("WITH x AS (SELECT 1) DELETE FROM person")).json()).toEqual({ error: "SQL: a query only reads: DELETE is not allowed" });
  });

  it("generates a new SQL query, and a changed one, checked and counted over everyone, with what it left out", async () => {
    asked.length = 0;
    const climbers = "SELECT pt.person_id\nFROM person_tag pt\nJOIN tag t ON t.id = pt.tag_id\nWHERE t.name = 'climbing'";
    answers.push({ query: climbers, parts: [{ said: "the climbers", in_query: true, why_not: "" }, { said: "who are tall", in_query: false, why_not: "nothing says how tall people are" }] });
    let response = await generate({ query: "", transcript: "the tall climbers" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ query: climbers, count: 1, note: "Not in the query: who are tall (nothing says how tall people are)." } satisfies GeneratedQuery);
    expect(asked[0].prompt).toContain("Current query: (none: write a new one)");
    expect(asked[0].prompt).toContain("climbing (1)");
    expect(asked[0].prompt).toContain("- platform (person_platform.platform): messenger (");

    const more = `${climbers}\nUNION\nSELECT person_id FROM person_platform WHERE platform = 'messenger'`;
    answers.push({ query: more, parts: [] });
    response = await generate({ query: climbers, transcript: "and anyone on Messenger" });
    const changed = (await response.json()) as GeneratedQuery;
    expect(changed.query).toBe(more);
    expect(changed.count).toBe((await ids("climbing OR platform:messenger")).length);
    expect(asked[1].prompt).toContain(`Current query: ${climbers}`);
    expect(asked[1].prompt).toContain("Who is searched: everyone, archived people too");

    // A query in the query language is sent with what it means, to be rewritten as SQL.
    answers.push({ query: climbers, parts: [] });
    await generate({ query: "climbing", transcript: "the climbers" });
    expect(asked[2].prompt).toContain("Current query: climbing");
    expect(asked[2].prompt).toContain("The current query is in the query language");
  });

  it("never sends the model anyone's name or note", async () => {
    asked.length = 0;
    answers.push({ query: "SELECT person_id FROM people", parts: [] });
    await generate({ transcript: "the climbers" });
    const listing = await get<PeopleListing>("/people");
    for (const person of listing.people) {
      expect(asked[0].prompt).not.toContain(person.name);
      if (person.note) expect(asked[0].prompt).not.toContain(person.note);
    }
  });

  it("answers 409 with the error, not the query, when the model's query does not run", async () => {
    answers.push({ query: "SELECT person_id FROM peple", parts: [] }, { query: "SELECT person_id FROM peple", parts: [] });
    const response = await generate({ query: "", transcript: "climbers and hikers" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('the model wrote "SELECT person_id FROM peple", which does not run: SQL: no such table: peple');
  });

  it("asks for a transcript, and takes requests only from friend-map's own page", async () => {
    expect((await generate({ query: "climbing", transcript: "" })).status).toBe(400);
    expect((await generate({ query: 1, transcript: "x" })).status).toBe(400);
    expect((await generate({ transcript: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = await fetch(`${base}/query/generate`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ transcript: "x" }) });
    expect(form.status).toBe(400);
  });

  it("says so when there is no model to ask", async () => {
    const handler = archiveHandler(archive);
    const bare = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/archive/query/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "the climbers" }),
      });
      expect(response.status).toBe(409);
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
  });
});
