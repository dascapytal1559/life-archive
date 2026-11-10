import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, isSqlQuery, LOCALE, TIME_ZONE } from "../../../sdk/server.ts";
import { importChats as importInto, me, type Chat } from "../fixtures/chats.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { runQuery } from "./query.ts";
import { matchQuery, matchQuerySync, sqlQuery, sqlQuerySync } from "./sqlQuery.ts";
import { setClock } from "../../../sdk/testing.ts";
import { SQL_VIEWS, openForQuery } from "./sqlRead.ts";
import { ArchiveStructure } from "./structure.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

const importChats = (platform: string, chats: Chat[]) => importInto(db, platform, chats);
const id = (name: string) => structure.listPeople().people.find((p) => p.name === name)!.id;
const ids = (...names: string[]) => names.map(id).sort((a, b) => a - b);
const sorted = (list: readonly number[]) => [...list].sort((a, b) => a - b);
const sql = async (text: string) => sorted(await sqlQuery(db, text));

/** docs/queries.md's worked example: everyone only on Discord, with 10 or fewer Discord direct messages, not archived. */
const DISCORD_PURGE = "SELECT person_id FROM people WHERE platforms = 'discord' AND direct_messages <= 10 AND NOT archived";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-sql-query-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
  // Discord's data package holds only the captain's messages.
  importChats("discord", [
    { id: "dee", members: ["Dee"], from: me(3), selfOnly: true },
    { id: "dan", members: ["Dan"], from: me(12), selfOnly: true },
    { id: "dot", members: ["Dot"], from: me(2), selfOnly: true },
    { id: "duo", members: ["Duo"], from: me(1), selfOnly: true },
    { id: "ten", members: ["Ten"], from: me(10), selfOnly: true },
    { id: "guild", type: "group", members: ["Dee", "Gil", ...Array.from({ length: 12 }, (_, i) => `Crowd${i + 1}`)], from: ["Me"] },
  ]);
  importChats("telegram", [
    { id: "tia", members: ["Tia"], from: ["Tia", "Me", "Tia", "Me", "Tia"] },
    { id: "duo-tg", members: ["Duo on Telegram"], from: ["Duo on Telegram", "Me"] },
  ]);
  people.runRules();
  people.merge(id("Duo"), id("Duo on Telegram"));
  people.setTags(id("Dot"), ["archive"]);
  people.setTags(id("Tia"), ["climbing"]);
  people.setLocation(id("Tia"), "Tokyo");
});

afterAll(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("telling SQL from the query language", () => {
  it("takes a query whose first word, after comments, is SELECT or WITH as SQL", () => {
    for (const text of ["SELECT person_id FROM people", "select 1", "  WITH x AS (SELECT 1) SELECT * FROM x", "with\nx as (select 1) select 1",
      "-- Discord purge\nSELECT person_id FROM people", "/* who */ select person_id from people", "SELECT"]) {
      expect(isSqlQuery(text), text).toBe(true);
    }
    for (const text of ["", "climbing", "select-crew", "with-family", "selected", "selection AND x", "tag:select", "\"select\"",
      "location:brisbane OR platform:discord", "-- select person_id", "/* select person_id */"]) {
      expect(isSqlQuery(text), text).toBe(false);
    }
  });
});

describe("SQL queries", () => {
  it("returns the Discord purge list: only on Discord, 10 or fewer Discord direct messages, not archived", async () => {
    // Dan has 12; Dot is archived by the captain; Duo is on Telegram too; Gil and the crowd only share a big group (the rules archive them).
    expect(await sql(DISCORD_PURGE)).toEqual(ids("Dee", "Ten"));
    // The same per platform, as person_platform counts it.
    expect(await sql(`
      SELECT pp.person_id FROM person_platform pp JOIN people p USING (person_id)
      WHERE pp.platform = 'discord' AND p.platform_count = 1 AND pp.direct_messages <= 10 AND NOT p.archived`)).toEqual(ids("Dee", "Ten"));
    // The query language can only come near it: it counts every platform's direct messages together.
    const { people: everyone, vocabulary } = structure.queryable();
    expect(sorted(runQuery("platform:discord AND NOT platform:telegram AND direct-messages<=10 AND NOT archive", everyone, vocabulary)))
      .toEqual(ids("Dee", "Ten"));
  });

  it("runs every example in docs/queries.md's \"SQL queries\", the Discord purge list first", async () => {
    const readme = readFileSync(new URL("../../../docs/queries.md", import.meta.url), "utf8");
    const section = readme.slice(readme.indexOf("### SQL queries"), readme.indexOf("### The AI service"));
    const examples = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThanOrEqual(4);
    expect(await sql(examples[0])).toEqual(ids("Dee", "Ten"));
    for (const example of examples) {
      expect(isSqlQuery(example), example).toBe(true);
      await expect(sqlQuery(db, example), example).resolves.toBeInstanceOf(Array);
    }
  });

  it("has a people view with the app's archive, tags, fields, platforms and counts", async () => {
    expect(await sql("SELECT person_id FROM people WHERE archived_by = 'you'")).toEqual(ids("Dot"));
    expect(await sql("SELECT person_id FROM people WHERE archived AND archived_by != 'you' AND name = 'Gil'")).toEqual(ids("Gil"));
    expect(await sql("SELECT person_id FROM people WHERE platforms = 'discord,telegram'")).toEqual(ids("Duo"));
    expect(await sql("SELECT person_id FROM people WHERE tags = 'climbing' AND location = 'Tokyo'")).toEqual(ids("Tia"));
    // A location is compared without case, as the app takes it.
    expect(await sql("SELECT person_id FROM people WHERE tags = 'climbing' AND location = 'TOKYO'")).toEqual(ids("Tia"));
    expect(await sql("SELECT person_id FROM people WHERE direct_from_them = 3 AND direct_from_me = 2 AND direct_messages = 5")).toEqual(ids("Tia"));
    expect(await sql("SELECT person_id FROM people WHERE untouched AND name LIKE 'D%'")).toEqual(ids("Dan", "Dee"));
    // The view lists whom the views do: never the captain.
    expect(await sql("SELECT person_id FROM people WHERE name = 'Me'")).toEqual([]);
  });

  it("counts per platform both ways, with the last message's Melbourne day", async () => {
    expect(await sql("SELECT person_id FROM person_platform WHERE platform = 'telegram' AND direct_from_them > 0")).toEqual(ids("Duo", "Tia"));
    expect(await sql("SELECT person_id FROM person_platform WHERE platform = 'discord' AND direct_from_me = 1")).toEqual(ids("Duo"));
    // Dee's three messages are the first three days.
    expect(await sql("SELECT person_id FROM person_platform WHERE platform = 'discord' AND last_day = '2023-11-17'")).toEqual(ids("Dee"));
    expect(await sql("SELECT person_id FROM people WHERE days_ago(last_message_at) > 30 AND name = 'Dee'")).toEqual(ids("Dee"));
  });

  it("has group memberships and every direct message, by day", async () => {
    // Everyone listed in the guild's group DM: Dee, Gil and twelve more, none of whom wrote there.
    expect(await sql("SELECT person_id FROM person_group WHERE title = 'guild' AND listed AND sent = 0")).toHaveLength(14);
    expect(await sql("SELECT person_id FROM person_group WHERE title = 'guild' AND listed AND person_id IN (SELECT person_id FROM people WHERE name IN ('Dee', 'Gil'))"))
      .toEqual(ids("Dee", "Gil"));
    // Dan's twelve messages run from 2023-11-18 to 2023-11-29; between the 20th and the 25th there are six.
    expect(await sql(`
      SELECT person_id FROM direct_message WHERE platform = 'discord' AND day BETWEEN '2023-11-20' AND '2023-11-25'
      GROUP BY person_id HAVING count(*) = 6`)).toEqual(ids("Dan"));
    expect(await sql("SELECT DISTINCT person_id FROM direct_message WHERE NOT from_me")).toEqual(ids("Duo", "Tia"));
    // The tables themselves, as they are.
    expect(await sql("SELECT ip.person_id FROM import_person ip WHERE ip.platform = 'telegram' AND ip.display_name = 'Tia'")).toEqual(ids("Tia"));
  });

  it("returns each person once, skipping nulls, from person_id or else id", async () => {
    expect(await sqlQuery(db, "SELECT person_id FROM direct_message WHERE person_id = (SELECT person_id FROM people WHERE name = 'Dan')"))
      .toEqual([id("Dan")]);
    expect(await sql("SELECT NULL AS person_id UNION ALL SELECT person_id FROM people WHERE name = 'Tia'")).toEqual(ids("Tia"));
    expect(await sql("SELECT person_id AS id, name FROM people WHERE name = 'Tia'")).toEqual(ids("Tia"));
    expect(await sql("SELECT 0 AS id, person_id FROM people WHERE name = 'Tia'")).toEqual(ids("Tia"));
    // A comment and a semicolon may follow the statement.
    expect(await sql("SELECT person_id FROM people WHERE name = 'Tia'; -- that's her\n")).toEqual(ids("Tia"));
  });

  it("gives each instant its own local day, in a zone on the half hour as in one on the hour", () => {
    const beforeMidnight = Date.parse("2026-01-15T18:20:00Z");
    const afterMidnight = Date.parse("2026-01-15T18:40:00Z");
    const zone = { timeZone: TIME_ZONE, locale: LOCALE };
    const connection = openForQuery(join(dataDir, "archive.sqlite"));
    const day = (ms: number) => (connection.prepare("SELECT day(?) AS day").get(ms) as { day: string }).day;
    try {
      expect([day(beforeMidnight), day(afterMidnight)]).toEqual(["2026-01-16", "2026-01-16"]);
    } finally {
      connection.close();
    }
    setClock({ timeZone: "Asia/Kolkata", locale: "en-IN" });
    const kolkata = openForQuery(join(dataDir, "archive.sqlite"));
    const there = (ms: number) => (kolkata.prepare("SELECT day(?) AS day").get(ms) as { day: string }).day;
    try {
      expect([there(afterMidnight), there(beforeMidnight)]).toEqual(["2026-01-16", "2026-01-15"]);
    } finally {
      kolkata.close();
      setClock(zone);
    }
  });

  it("says what every column of every view is, as Generate's model is told (SQL_VIEWS)", () => {
    const connection = openForQuery(join(dataDir, "archive.sqlite"));
    try {
      for (const [view, { columns }] of Object.entries(SQL_VIEWS)) {
        expect(connection.prepare(`SELECT * FROM ${view}`).columns().map((column) => column.name), view).toEqual(Object.keys(columns));
      }
      const views = connection.prepare("SELECT name FROM sqlite_temp_schema WHERE type = 'view' ORDER BY name").all() as { name: string }[];
      expect(views.map((view) => view.name)).toEqual(Object.keys(SQL_VIEWS).sort());
    } finally {
      connection.close();
    }
  });

  it("lists every name each person goes by, in order, the first their name (person_names), to find them by any", async () => {
    const tia = id("Tia");
    people.setNames(tia, ["Tia", "Tee", "Tia Placeholder"]);
    try {
      const connection = openForQuery(join(dataDir, "archive.sqlite"));
      try {
        expect(connection.prepare("SELECT name, position, is_display FROM person_names WHERE person_id = ? ORDER BY position").all(tia).map((row) => ({ ...row })))
          .toEqual([{ name: "Tia", position: 1, is_display: 1 }, { name: "Tee", position: 2, is_display: 0 }, { name: "Tia Placeholder", position: 3, is_display: 0 }]);
        // Everyone but the captain, each with one name to show.
        expect(connection.prepare("SELECT count(*) AS n FROM person_names WHERE is_display = 1").get()).toEqual(connection.prepare("SELECT count(*) AS n FROM person WHERE is_self = 0").get());
      } finally {
        connection.close();
      }
      expect(await sql("SELECT person_id FROM person_names WHERE name LIKE '%placeholder%'")).toEqual(ids("Tia"));
    } finally {
      people.setAliases(tia, []);
    }
  });

  it("says what is wrong with a query that does not give person ids", async () => {
    await expect(sqlQuery(db, "SELECT name FROM people")).rejects.toThrow("SQL: return the people as a column named person_id (or id); this query returns name");
    await expect(sqlQuery(db, "SELECT 'x' AS person_id")).rejects.toThrow('SQL: person_id must be a person\'s id, a whole number, not "x"');
    await expect(sqlQuery(db, "SELECT 1.5 AS person_id")).rejects.toThrow("not 1.5");
    await expect(sqlQuery(db, "SELECT 999999 AS id")).rejects.toThrow("SQL: 1 id the query returns is no person's (999999): return person ids");
    await expect(sqlQuery(db, "SELECT person_id FROM peple")).rejects.toThrow("SQL: no such table: peple");
    await expect(sqlQuery(db, "SELECT person_id FROM people WHERE name = \"Tia\"")).rejects.toThrow(/no such column: "Tia"/);
  });

  it("refuses more rows than its cap", async () => {
    await expect(sqlQuery(db, "SELECT person_id FROM direct_message", { timeoutMs: 10_000, maxRows: 5 }))
      .rejects.toThrow("SQL: the query returns more than 5 rows: return each person once (SELECT DISTINCT, or GROUP BY person_id)");
    expect(await sqlQuery(db, "SELECT DISTINCT person_id FROM direct_message WHERE platform = 'telegram'", { timeoutMs: 10_000, maxRows: 5 })).toHaveLength(2);
  });

  it("can never change the archive: writes, several statements, ATTACH, PRAGMA and extensions are refused", async () => {
    const snapshot = () => JSON.stringify([
      db.prepare("SELECT * FROM person ORDER BY id").all(),
      db.prepare("SELECT * FROM person_tag ORDER BY person_id, tag_id").all(),
      db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
    ]);
    const before = snapshot();
    const refused: Array<[string, string]> = [
      ["DELETE FROM person", "SQL: a query is one SELECT, or WITH ... SELECT, that only reads"],
      ["UPDATE person SET name = 'x'", "SQL: a query is one SELECT"],
      [`ATTACH '${join(dataDir, "other.sqlite")}' AS other`, "SQL: a query is one SELECT"],
      ["PRAGMA query_only = OFF", "SQL: a query is one SELECT"],
      [`VACUUM INTO '${join(dataDir, "copy.sqlite")}'`, "SQL: a query is one SELECT"],
      ["BEGIN IMMEDIATE", "SQL: a query is one SELECT"],
      ["WITH gone AS (SELECT id FROM person) DELETE FROM person WHERE id IN gone", "SQL: a query only reads: DELETE is not allowed"],
      ["WITH t AS (SELECT 1) UPDATE person SET name = 'x'", "SQL: a query only reads: UPDATE is not allowed"],
      ["WITH t AS (SELECT 1) INSERT INTO tag (name, sort_order, created_at) VALUES ('x', 9, 0)", "SQL: a query only reads: INSERT is not allowed"],
      ["SELECT person_id FROM people; DELETE FROM person", "SQL: one statement only: take out what follows the first ;"],
      ["SELECT person_id FROM people; SELECT 1", "SQL: one statement only"],
      ["SELECT cid AS id FROM pragma_table_info('person')", "SQL: a query only reads: PRAGMA table_info is not allowed"],
      ["SELECT load_extension('/tmp/x') AS id", "SQL: a query only reads: load_extension is not allowed"],
    ];
    for (const [text, error] of refused) await expect(sqlQuery(db, text), text).rejects.toThrow(error);
    expect(() => sqlQuerySync(db, "SELECT person_id FROM people; DELETE FROM person")).toThrow("SQL: one statement only");
    expect(snapshot()).toBe(before);
    expect(existsSync(join(dataDir, "copy.sqlite"))).toBe(false);
  });

  it("never reads content, so no query can filter on it or confirm a guess at it", async () => {
    const someone = "SELECT DISTINCT dm.person_id FROM direct_message dm JOIN message m ON m.id = dm.message_id";
    const refused: Array<[string, string]> = [
      [`${someone} WHERE m.text LIKE '%a%'`, "message.text"],
      [`${someone} WHERE m.raw_json LIKE '%a%'`, "message.raw_json"],
      ["SELECT * FROM message", "message.text"],
      ["SELECT person_id FROM people WHERE EXISTS (SELECT 1 FROM message WHERE text = 'hi')", "message.text"],
      ["SELECT DISTINCT person_id FROM direct_message WHERE message_id IN (SELECT rowid FROM message_fts WHERE message_fts MATCH 'hi')", "message_fts"],
      ["SELECT person_id FROM people WHERE (SELECT count(*) FROM message_fts WHERE message_fts MATCH 'hi') > 0", "message_fts"],
      ["SELECT 1 AS id FROM message_fts_data", "message_fts_data"],
      ["SELECT DISTINCT person_id FROM direct_message WHERE message_id IN (SELECT message_id FROM message_version)", "message_version"],
      ["SELECT 1 AS id FROM call WHERE raw_json LIKE '%a%'", "call.raw_json"],
      ["SELECT person_id FROM catch_up_person JOIN catch_up ON id = catch_up_id WHERE note LIKE '%a%'", "catch_up.note"],
      ["SELECT person_id FROM draft WHERE text LIKE '%a%'", "draft.text"],
      ["SELECT 1 AS id FROM change_row WHERE after_json LIKE '%a%'", "change_row.after_json"],
    ];
    for (const [text, what] of refused) await expect(sqlQuery(db, text), text).rejects.toThrow(`SQL: a query cannot read content: ${what}`);
    // The rest of a message, and of everything else, is structure, which a query reads.
    expect(await sql(`${someone} WHERE m.type = 'text' AND m.sent_at > 0 AND m.platform = 'telegram'`)).toEqual(ids("Duo", "Tia"));
    expect(await sql("SELECT person_id FROM people WHERE (SELECT count(*) FROM message) > 0 AND name = 'Tia'")).toEqual(ids("Tia"));
  });

  it("refuses a write at each of its guards alone: the authorizer, query_only, and the read-only connection", () => {
    const connection = openForQuery(join(dataDir, "archive.sqlite"));
    const copy = join(dataDir, "copy.sqlite");
    try {
      for (const statement of ["DELETE FROM person", `ATTACH '${copy}' AS other`, "PRAGMA query_only = OFF", `VACUUM INTO '${copy}'`, "CREATE TEMP TABLE x (a)"]) {
        expect(() => connection.prepare(statement).run(), statement).toThrow(/not authorized|authorization denied/);
      }
      connection.setAuthorizer(null);
      for (const statement of ["DELETE FROM person", `VACUUM INTO '${copy}'`, "CREATE TEMP TABLE x (a)"]) {
        expect(() => connection.prepare(statement).run(), statement).toThrow("attempt to write a readonly database");
      }
      connection.exec("PRAGMA query_only = OFF");
      expect(() => connection.prepare("DELETE FROM person").run()).toThrow("attempt to write a readonly database");
      expect(() => connection.prepare("UPDATE person SET name = 'x'").run()).toThrow("attempt to write a readonly database");
    } finally {
      connection.close();
      rmSync(copy, { force: true });
    }
  });

  it("stops a query that runs too long, the server's and the CLI's way alike", async () => {
    const forever = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i AS id FROM n WHERE i < 0";
    const limits = { timeoutMs: 300, maxRows: 100_000 };
    let started = Date.now();
    await expect(sqlQuery(db, forever, limits)).rejects.toThrow("SQL: the query ran longer than 0.3 s and was stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
    started = Date.now();
    expect(() => sqlQuerySync(db, forever, limits)).toThrow("SQL: the query ran longer than 0.3 s and was stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
    // And the archive is still there to ask.
    expect(await sql("SELECT person_id FROM people WHERE name = 'Tia'")).toEqual(ids("Tia"));
  });

  it("answers in the people's order, among those the views list, and leaves the query language as it was", async () => {
    const queryable = structure.queryable();
    const order = queryable.people.map((p) => p.id);
    const everyoneBySql = await matchQuery(db, "SELECT person_id FROM people ORDER BY name DESC", queryable);
    expect(everyoneBySql).toEqual(order);
    // The captain's own person is a person, but no view lists him.
    expect(await matchQuery(db, "SELECT id FROM person WHERE is_self = 1", queryable)).toEqual([]);
    expect(matchQuerySync(db, DISCORD_PURGE, queryable)).toEqual(order.filter((p) => ids("Dee", "Ten").includes(p)));
    for (const text of ["", "climbing", "platform:discord AND direct-messages<=10", "location:tokyo OR archived", "untagged AND NOT archive"]) {
      expect(await matchQuery(db, text, queryable), text).toEqual(runQuery(text, queryable.people, queryable.vocabulary));
      expect(matchQuerySync(db, text, queryable), text).toEqual(runQuery(text, queryable.people, queryable.vocabulary));
    }
    await expect(matchQuery(db, "climbng", queryable)).rejects.toThrow('there is no tag "climbng"; did you mean climbing?');
  });

  it("needs the archive in a file", async () => {
    const memory = openArchive(":memory:");
    try {
      await expect(sqlQuery(memory, "SELECT 1 AS id")).rejects.toThrow("SQL runs only over an archive in a file");
    } finally {
      memory.close();
    }
  });
});
