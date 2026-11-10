import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, getMeta } from "../../../sdk/server.ts";
import { draftsFromOpeners, locationColumn, locationFold, loggedCallsToAccounts, namesFirstAliasLeads, openArchive, schemaVersionOf } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { voipBubble } from "../fixtures/wechat.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-db-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A person's met and lives as the archive kept them before they became Location (migration 27), read from the tables. */
function metAndLives(db: Db, id: number): { met: string | null; lives: string | null } {
  const value = (field: string) =>
    (db.prepare("SELECT v.name FROM person_field_value pv JOIN field_value v ON v.id = pv.value_id WHERE pv.person_id = ? AND pv.field = ?").get(id, field) as
      { name: string } | undefined)?.name ?? null;
  return { met: value("met"), lives: value("lives") };
}

/** Each of those fields' values, the most used first (then A to Z), as the archive listed them then. */
function metAndLivesLists(db: Db): Record<string, Array<{ name: string; count: number }>> {
  const lists: Record<string, Array<{ name: string; count: number }>> = { met: [], lives: [] };
  for (const row of db.prepare(`SELECT v.field, v.name, (SELECT count(*) FROM person_field_value pv WHERE pv.value_id = v.id) AS count
    FROM field_value v ORDER BY count DESC, v.name COLLATE NOCASE, v.id`).all() as { field: string; name: string; count: number }[]) {
    lists[row.field].push({ name: row.name, count: row.count });
  }
  return lists;
}

/** A person's location as migrations 27 to 31 kept it, in field_value. */
function fieldLocation(db: Db, id: number): string | null {
  return (db.prepare("SELECT v.name FROM person_field_value pv JOIN field_value v ON v.id = pv.value_id WHERE pv.person_id = ? AND pv.field = 'location'")
    .get(id) as { name: string } | undefined)?.name ?? null;
}

describe("migrations", () => {
  it("turns a direct chat with more than one other person into a group", () => {
    const file = join(dir, "archive.sqlite");
    // As an archive written before the migration.
    let db = openArchive(file, { version: 2 });
    const account = (key: string, isSelf = 0) =>
      Number(db.prepare("INSERT INTO account (platform, key, key_kind, display_name, is_self) VALUES ('messenger', ?, 'name', ?, ?)")
        .run(key, key, isSelf).lastInsertRowid);
    const conversation = (key: string, members: number[], marketplace = 0) => {
      const id = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type, is_marketplace) VALUES ('messenger', ?, 'direct', ?)")
        .run(key, marketplace).lastInsertRowid);
      for (const member of members) db.prepare("INSERT INTO conversation_member VALUES (?, ?)").run(id, member);
    };
    const [me, ada, bea, cy] = [account("Me", 1), account("Ada"), account("Bea"), account("Cy")];
    conversation("left-group", [me, ada, bea, cy]);
    conversation("with-ada", [me, ada]);
    conversation("marketplace", [me, ada, bea], 1);
    db.close();

    db = openArchive(file);
    const types = db.prepare("SELECT platform_conversation_id AS id, type FROM conversation ORDER BY rowid").all();
    expect(types.map((row) => ({ ...row }))).toEqual([
      { id: "left-group", type: "group" }, { id: "with-ada", type: "direct" }, { id: "marketplace", type: "direct" },
    ]);
    db.close();
  });

  it("drops the repeated last word of WhatsApp names the address book doubled, with their direct chats' titles and people", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 3 });
    const account = (platform: string, key: string, name: string) => {
      const id = Number(db.prepare("INSERT INTO account (platform, key, key_kind, display_name) VALUES (?, ?, 'id', ?)")
        .run(platform, key, name).lastInsertRowid);
      db.prepare("INSERT INTO person (display_name, seed_account_id, created_at) VALUES (?, ?, 0)").run(name, id);
      db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type, title) VALUES (?, ?, 'direct', ?)").run(platform, key, name);
    };
    account("whatsapp", "1", "Dana Example Example");
    account("whatsapp", "2", "Dana Example Example");
    account("whatsapp", "3", "Li Li");
    account("whatsapp", "4", "Ada Sample");
    account("messenger", "5", "Bruno Placeholder Placeholder");
    db.close();

    db = openArchive(file);
    const names = (sql: string) => (db.prepare(sql).all() as { name: string }[]).map((row) => row.name);
    const expected = ["Dana Example", "Dana Example", "Li Li", "Ada Sample", "Bruno Placeholder Placeholder"];
    expect(names("SELECT display_name AS name FROM import_person ORDER BY id")).toEqual(expected);
    expect(names("SELECT name FROM person WHERE is_self = 0 ORDER BY id")).toEqual(expected);
    expect(names("SELECT title AS name FROM conversation ORDER BY id")).toEqual(expected);
    db.close();
  });

  it("trims and single-spaces the names people took from their imports (migration 7), leaving the captain's names and the import people's as they were", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 6 });
    const person = (name: string, source: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, ?, 0)").run(name, source).lastInsertRowid);
    const haruki = person("Haruki  Oda", "import");
    db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('messenger', 'Haruki  Oda', 'name', 'Haruki  Oda', ?)").run(haruki);
    person("Kiara Moxie Glyn ", "import");
    person(" ", "import");
    person("Ada Sample", "import");
    person(" Odd  Name", "captain");
    db.close();

    db = openArchive(file, { version: 7 });
    expect((db.prepare("SELECT name FROM person WHERE is_self = 0 ORDER BY id").all() as { name: string }[]).map((row) => row.name))
      .toEqual(["Haruki Oda", "Kiara Moxie Glyn", "", "Ada Sample", " Odd  Name"]);
    expect(db.prepare("SELECT display_name FROM import_person").get()).toEqual({ display_name: "Haruki  Oda" });
    db.close();
  });

  it("gives the people migration 7 tidied their import person's name back as the platform wrote it, leaving edited people alone (migration 8)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 7 });
    const person = (name: string, account: string, editedAt: number | null = null) => {
      const id = Number(db.prepare("INSERT INTO person (name, name_source, edited_at, created_at) VALUES (?, 'import', ?, 0)").run(name, editedAt).lastInsertRowid);
      db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('messenger', ?, 'name', ?, ?)").run(account, account, id);
    };
    person("Haruki Oda", "Haruki  Oda");
    person("Kiara Moxie Glyn", "Kiara Moxie Glyn ");
    person("Edited Name", "Edited  Name", 1);
    person("Other Name", "Another  Name");
    db.close();

    db = openArchive(file);
    expect((db.prepare("SELECT name FROM person WHERE is_self = 0 ORDER BY id").all() as { name: string }[]).map((row) => row.name))
      .toEqual(["Haruki  Oda", "Kiara Moxie Glyn ", "Edited Name", "Other Name"]);
    db.close();
  });

  it("names WhatsApp import people the connector named by encoded messages by their number, with their direct chats (migration 12), and the rules archive them", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 11 });
    const account = (platform: string, key: string, name: string, handle: string | null, personName = name, source = "import") => {
      const personId = Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, ?, 0)").run(personName, source).lastInsertRowid);
      const id = Number(db.prepare(
        "INSERT INTO import_person (platform, key, key_kind, display_name, handle, person_id, link_source) VALUES (?, ?, 'id', ?, ?, ?, 'import')",
      ).run(platform, key, name, handle, personId).lastInsertRowid);
      const chat = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type, title) VALUES (?, ?, 'direct', ?)")
        .run(platform, key, name).lastInsertRowid);
      db.prepare("INSERT INTO conversation_member VALUES (?, ?)").run(chat, id);
    };
    account("whatsapp", "61491571266@s.whatsapp.net", "CKDw3MYGIAA=", "+61491571266");
    // Two accounts with the same encoded name: each chat takes its own account's number.
    account("whatsapp", "61491571491@s.whatsapp.net", "+EAA=", "+61491571491");
    account("whatsapp", "61491571804@s.whatsapp.net", "+EAA=", "+61491571804");
    account("whatsapp", "100000000000001@lid", "COmDxooG", null);
    // The captain's name for someone stays.
    account("whatsapp", "61491572549@s.whatsapp.net", "CJCPsoEG", "+61491572549", "Dana (climbing)", "captain");
    account("whatsapp", "61491572665@s.whatsapp.net", "Ada Sample", "+61491572665");
    account("messenger", "CKDw3MYGIAA=", "CKDw3MYGIAA=", null);
    db.close();

    db = openArchive(file);
    const expected = ["+61491571266", "+61491571491", "+61491571804", "WhatsApp user", "+61491572549", "Ada Sample", "CKDw3MYGIAA="];
    const names = (sql: string) => (db.prepare(sql).all() as { name: string }[]).map((row) => row.name);
    expect(names("SELECT display_name AS name FROM import_person ORDER BY id")).toEqual(expected);
    expect(names("SELECT title AS name FROM conversation ORDER BY id")).toEqual(expected);
    // People follow their import person's name when the rules next run, and are archived as having none.
    const people = new People(db);
    expect(people.rulesAreCurrent()).toBe(false);
    people.runRules();
    expect((db.prepare("SELECT name, archive_rule FROM person WHERE is_self = 0 ORDER BY id").all() as object[]).map((row) => ({ ...row })))
      .toEqual([
        { name: "+61491571266", archive_rule: "no-name" },
        { name: "+61491571491", archive_rule: "no-name" },
        { name: "+61491571804", archive_rule: "no-name" },
        { name: "WhatsApp user", archive_rule: "unknown" },
        { name: "Dana (climbing)", archive_rule: "no-name" },
        { name: "Ada Sample", archive_rule: "no-messages" },
        { name: "CKDw3MYGIAA=", archive_rule: "no-name" },
      ]);
    db.close();
  });

  it("moves everyone's tags into the tag table (migration 9): the quick tag defaults first, then the rest A to Z, archive and keep built in", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 8 });
    const person = (tags: string[], isSelf = 0) =>
      Number(db.prepare("INSERT INTO person (name, name_source, tags_json, is_self, created_at) VALUES ('P', 'captain', ?, ?, 0)")
        .run(JSON.stringify(tags), isSelf).lastInsertRowid);
    const ada = person(["commercial", "work", "archive"]);
    const bea = person(["work", "family", "Dota  games"]);
    const cy = person(["system-archive", "me", "travel"]);
    const before = tagCounts(db, "SELECT j.value AS name, count(*) AS n FROM person, json_each(tags_json) j GROUP BY j.value");
    db.close();

    db = openArchive(file);
    expect(db.prepare("SELECT name, sort_order, built_in FROM tag ORDER BY sort_order").all().map((row) => ({ ...row }))).toEqual([
      { name: "home-town", sort_order: 0, built_in: 0 },
      { name: "school", sort_order: 1, built_in: 0 },
      { name: "work", sort_order: 2, built_in: 0 },
      { name: "travel", sort_order: 3, built_in: 0 },
      { name: "overseas", sort_order: 4, built_in: 0 },
      { name: "internet", sort_order: 5, built_in: 0 },
      { name: "archive", sort_order: 6, built_in: 1 },
      { name: "commercial", sort_order: 7, built_in: 0 },
      { name: "dota-games", sort_order: 8, built_in: 0 },
      { name: "family", sort_order: 9, built_in: 0 },
      { name: "keep", sort_order: 10, built_in: 1 },
      // Added, built in, by migrations 31 and 48.
      { name: "live-together", sort_order: 11, built_in: 1 },
      { name: "show-name", sort_order: 12, built_in: 1 },
    ]);
    const after = tagCounts(db, "SELECT t.name, count(*) AS n FROM person_tag pt JOIN tag t ON t.id = pt.tag_id GROUP BY t.name");
    // Every tag keeps its people, written as tags are now; "system-archive" and "me" were never tags.
    expect(after).toEqual({ ...Object.fromEntries(Object.entries(before).filter(([name]) => !["system-archive", "me", "Dota  games"].includes(name))), "dota-games": 1 });
    const tags = new People(db).tags;
    expect([ada, bea, cy].map((id) => tags.of(id))).toEqual([
      ["work", "archive", "commercial"],
      ["work", "dota-games", "family"],
      ["travel"],
    ]);
    expect(db.prepare("SELECT * FROM person WHERE id = ?").get(ada)).not.toHaveProperty("tags_json");
    db.close();
  });

  it("turns the should-call tag into the should reach out flag (migration 13): its people flagged, the tag gone, everyone else untouched", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 12 });
    const person = (name: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'captain', 0)").run(name).lastInsertRowid);
    const tag = (name: string) =>
      Number(db.prepare("INSERT INTO tag (name, sort_order, built_in, created_at) VALUES (?, (SELECT max(sort_order) + 1 FROM tag), 0, 0)").run(name).lastInsertRowid);
    const give = db.prepare("INSERT INTO person_tag (person_id, tag_id, added_at) VALUES (?, ?, 0)");
    const [family, shouldCall, work] = [tag("family"), tag("should-call"), tag("work")];
    const [ada, bea, cy, dee] = [person("Ada"), person("Bea"), person("Cy"), person("Dee")];
    give.run(ada, family);
    give.run(ada, shouldCall);
    give.run(bea, shouldCall);
    give.run(cy, family);
    give.run(cy, work);
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();

    // As far as the draft opener went (migration 38 made it a draft).
    db = openArchive(file, { version: 37 });
    const fields = db.prepare("SELECT id, should_reach_out, draft_opener FROM person WHERE is_self = 0 ORDER BY id").all().map((row) => ({ ...row }));
    expect(fields).toEqual([
      { id: ada, should_reach_out: 1, draft_opener: "" },
      { id: bea, should_reach_out: 1, draft_opener: "" },
      { id: cy, should_reach_out: 0, draft_opener: "" },
      { id: dee, should_reach_out: 0, draft_opener: "" },
    ]);
    const tags = new People(db).tags;
    expect(db.prepare("SELECT name, sort_order FROM tag ORDER BY sort_order").all().map((row) => ({ ...row }))).toEqual([
      { name: "archive", sort_order: 0 }, { name: "keep", sort_order: 1 }, { name: "family", sort_order: 2 }, { name: "work", sort_order: 3 }, { name: "live-together", sort_order: 4 },
    ]);
    // Open pages reload, as after any tag deleted.
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    expect([ada, bea, cy, dee].map((id) => tags.of(id))).toEqual([["family"], [], ["family", "work"], []]);
    expect(db.prepare("SELECT count(*) AS n FROM person_tag WHERE tag_id = ?").get(shouldCall)).toEqual({ n: 0 });
    // The flag is indexed, so the people to reach out to are found without reading everyone.
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM person WHERE should_reach_out = 1").all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toMatch(/INDEX person_should_reach_out/);
    db.close();
  });

  it("gives a new archive the reaching-out flag, unset, with nothing to convert (migration 13)", () => {
    const db = openArchive(join(dir, "archive.sqlite"));
    const people = new People(db);
    const ada = people.create("Ada");
    expect(db.prepare("SELECT should_reach_out FROM person WHERE id = ?").get(ada)).toEqual({ should_reach_out: 0 });
    db.close();
  });

  it("turns met- and lives- tags into the met and lives fields (migration 14): several of either the first A to Z, the tags gone", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 13 });
    const person = (name: string, isSelf = 0) =>
      Number(db.prepare("INSERT INTO person (name, name_source, is_self, created_at) VALUES (?, 'captain', ?, 0)").run(name, isSelf).lastInsertRowid);
    const tag = (name: string) =>
      Number(db.prepare("INSERT INTO tag (name, sort_order, built_in, created_at) VALUES (?, (SELECT max(sort_order) + 1 FROM tag), 0, 0)").run(name).lastInsertRowid);
    const give = db.prepare("INSERT INTO person_tag (person_id, tag_id, added_at) VALUES (?, ?, 0)");
    const family = tag("family");
    const [tokyo, brisbane, melbourne, online, newYork] = ["met-tokyo", "met-brisbane", "met-melbourne", "met-online", "met-new-york"].map(tag);
    const [livesBrisbane, livesSydney] = ["lives-brisbane", "lives-sydney"].map(tag);
    const work = tag("work");
    const [ada, bea, cy, dee, eve, fay, gus] = ["Ada", "Bea", "Cy", "Dee", "Eve", "Fay", "Gus"].map((name) => person(name));
    give.run(ada, tokyo); // one met tag
    give.run(ada, family);
    give.run(bea, melbourne); // several: Brisbane, the first A to Z, whatever order they were given in
    give.run(bea, brisbane);
    give.run(bea, tokyo);
    give.run(bea, livesBrisbane);
    give.run(cy, online); // several: Melbourne before Online
    give.run(cy, melbourne);
    give.run(dee, newYork); // one of two words
    give.run(eve, online); // New York before Online
    give.run(eve, newYork);
    give.run(fay, livesSydney); // lives only, several: Brisbane before Sydney
    give.run(fay, livesBrisbane);
    give.run(gus, work); // no met or lives tag
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();

    db = openArchive(file, { version: 14 });
    const people = new People(db);
    const of = (id: number) => metAndLives(db, id);
    expect(of(ada)).toEqual({ met: "Tokyo", lives: null });
    expect(of(bea)).toEqual({ met: "Brisbane", lives: "Brisbane" });
    expect(of(cy)).toEqual({ met: "Melbourne", lives: null });
    expect(of(dee)).toEqual({ met: "New York", lives: null });
    expect(of(eve)).toEqual({ met: "New York", lives: null });
    expect(of(fay)).toEqual({ met: null, lives: "Brisbane" });
    expect(of(gus)).toEqual({ met: null, lives: null });
    // Every value carried over, the empty ones too, the most used first.
    expect(metAndLivesLists(db)).toEqual({
      met: [
        { name: "New York", count: 2 }, { name: "Brisbane", count: 1 }, { name: "Melbourne", count: 1 }, { name: "Tokyo", count: 1 },
        { name: "Online", count: 0 },
      ],
      lives: [{ name: "Brisbane", count: 2 }, { name: "Sydney", count: 0 }],
    });
    // The tags are gone from everyone, the rest renumbered, and open pages reload.
    expect(db.prepare("SELECT name, sort_order FROM tag ORDER BY sort_order").all().map((row) => ({ ...row }))).toEqual([
      { name: "archive", sort_order: 0 }, { name: "keep", sort_order: 1 }, { name: "family", sort_order: 2 }, { name: "work", sort_order: 3 },
    ]);
    expect([ada, bea, cy, gus].map((id) => people.tags.of(id))).toEqual([["family"], [], [], ["work"]]);
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    // Met and lives hold one value each.
    const value = (db.prepare("SELECT id FROM field_value WHERE field = 'met' AND name = 'Online'").get() as { id: number }).id;
    expect(() => db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'met', 0)").run(ada, value)).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'lives', 0)").run(gus, value)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("gives a new archive the location column, empty, with nothing to convert or tell (migrations 14, 27 and 32)", () => {
    const db = openArchive(join(dir, "archive.sqlite"));
    const people = new People(db);
    const before = getMeta(db, "people_version");
    expect(people.locations.list()).toEqual([]);
    expect(db.prepare("SELECT location FROM person WHERE id = ?").get(people.create("Ada"))).toEqual({ location: null });
    expect(before).toBeNull();
    expect(locationFold(db)).toBeNull();
    expect(locationColumn(db)).toBeNull();
    db.close();
  });

  it("deletes occupation and narrows the fields to met and lives (migration 15): met and lives kept, people marked changed", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 14 });
    const person = (name: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'captain', 0)").run(name).lastInsertRowid);
    const value = (field: string, name: string) =>
      Number(db.prepare("INSERT INTO field_value (field, name, created_at) VALUES (?, ?, 0)").run(field, name).lastInsertRowid);
    const give = db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, ?, 0)");
    const [ada, bea] = ["Ada", "Bea"].map(person);
    const [tokyo, brisbane, programmer, nurse] = [["met", "Tokyo"], ["lives", "Brisbane"], ["occupation", "Programmer"], ["occupation", "Nurse"]]
      .map(([field, name]) => value(field, name));
    give.run(ada, tokyo, "met");
    give.run(ada, brisbane, "lives");
    give.run(ada, programmer, "occupation");
    give.run(ada, nurse, "occupation");
    give.run(bea, nurse, "occupation");
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();

    db = openArchive(file, { version: 15 });
    expect(metAndLives(db, ada)).toEqual({ met: "Tokyo", lives: "Brisbane" });
    expect(metAndLives(db, bea)).toEqual({ met: null, lives: null });
    expect(metAndLivesLists(db)).toEqual({ met: [{ name: "Tokyo", count: 1 }], lives: [{ name: "Brisbane", count: 1 }] });
    expect(db.prepare("SELECT count(*) AS n FROM person_field_value WHERE field = 'occupation'").get()).toEqual({ n: 0 });
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    // The fields are met and lives only, a person holds one of each, and deleting a value still takes it from everyone.
    expect(() => db.prepare("INSERT INTO field_value (field, name, created_at) VALUES ('occupation', 'Pilot', 0)").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'met', 0)").run(ada, value("met", "Online"))).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM field_value WHERE id = ?").run(tokyo);
    expect(metAndLives(db, ada)).toEqual({ met: null, lives: "Brisbane" });
    db.close();
  });

  it("leaves people_version alone when nobody had an occupation (migration 15)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 14 });
    db.prepare("INSERT INTO field_value (field, name, created_at) VALUES ('occupation', 'Unused', 0)").run();
    const before = getMeta(db, "people_version");
    db.close();
    db = openArchive(file, { version: 15 });
    expect(getMeta(db, "people_version")).toBe(before);
    expect(db.prepare("SELECT count(*) AS n FROM field_value").get()).toEqual({ n: 0 });
    db.close();
  });

  it("folds Met into Lives and Lives into Location (migration 27): Lives kept, Met where there is no Lives, Met gone, and says what moved", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 26 });
    const person = (name: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'captain', 0)").run(name).lastInsertRowid);
    const value = (field: string, name: string) =>
      Number(db.prepare("INSERT INTO field_value (field, name, created_at) VALUES (?, ?, 7)").run(field, name).lastInsertRowid);
    const give = db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, ?, 0)");
    const [metOnly, metToo, livesOnly, same, different, neither] = ["Met Only", "Met Too", "Lives Only", "Both Same", "Both Different", "Neither"].map(person);
    const [tokyo, uni, brisbaneMet] = [value("met", "Tokyo"), value("met", "Uni"), value("met", "brisbane")];
    const [hobart, brisbane, perth] = [value("lives", "Hobart"), value("lives", "Brisbane"), value("lives", "Perth")];
    value("met", "Online"); // nobody's: goes with met
    // A changeset that gave Lives Only her lives value, and one that gave Met Only his met value.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, 0, 'cli', 'person lives', '{}')").run();
    const logged = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'person_field_value', ?, NULL, ?)");
    logged.run(JSON.stringify([livesOnly, hobart]), JSON.stringify({ person_id: livesOnly, value_id: hobart, field: "lives", added_at: 0 }));
    logged.run(JSON.stringify([metOnly, tokyo]), JSON.stringify({ person_id: metOnly, value_id: tokyo, field: "met", added_at: 0 }));
    give.run(metOnly, tokyo, "met");
    give.run(metToo, brisbaneMet, "met"); // a lives value of the same name but for case: becomes that one
    give.run(livesOnly, hobart, "lives");
    give.run(same, brisbaneMet, "met");
    give.run(same, brisbane, "lives");
    give.run(different, uni, "met");
    give.run(different, hobart, "lives");
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();

    db = openArchive(file, { version: 27 });
    expect([metOnly, metToo, livesOnly, same, different, neither].map((id) => fieldLocation(db, id)))
      .toEqual(["Tokyo", "Brisbane", "Hobart", "Brisbane", "Hobart", null]);
    // Lives values all stay (Perth with nobody, as values do); a met value only where someone took it, as it was written.
    expect(db.prepare(`SELECT v.name, (SELECT count(*) FROM person_field_value pv WHERE pv.value_id = v.id) AS count
      FROM field_value v ORDER BY count DESC, v.name COLLATE NOCASE`).all().map((row) => ({ ...row }))).toEqual(
      [{ name: "Brisbane", count: 2 }, { name: "Hobart", count: 2 }, { name: "Tokyo", count: 1 }, { name: "Perth", count: 0 }],
    );
    expect(db.prepare("SELECT created_at FROM field_value WHERE name = 'Tokyo'").get()).toEqual({ created_at: 7 });
    expect(perth).toBe((db.prepare("SELECT id FROM field_value WHERE name = 'Perth'").get() as { id: number }).id);
    expect(db.prepare("SELECT DISTINCT field FROM person_field_value").all().map((row) => ({ ...row }))).toEqual([{ field: "location" }]);
    expect(locationFold(db)).toEqual({
      movedFromMet: 2, keptFromLives: 3, bothSame: 1,
      bothDifferent: [{ id: different, name: "Both Different", met: "Uni", lives: "Hobart" }],
      withLocation: 5,
    });
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    // The change log's lives rows follow; its met rows stay as they were.
    expect(db.prepare("SELECT json_extract(after_json, '$.field') AS field FROM change_row ORDER BY id").all().map((row) => ({ ...row })))
      .toEqual([{ field: "location" }, { field: "met" }]);
    // Location is the only field, and a person holds one value of it.
    expect(() => db.prepare("INSERT INTO field_value (field, name, created_at) VALUES ('met', 'Uni', 0)").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'location', 0)").run(neither, perth);
    expect(() => db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'location', 0)").run(neither, hobart)).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM person_field_value WHERE person_id = ?").run(neither);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();

    // Opened again, nothing more happens.
    db = openArchive(file, { version: 27 });
    expect(fieldLocation(db, metOnly)).toBe("Tokyo");
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    db.close();
  });

  it("moves Telegram messages filed under another chat back to their own, and keeps a one-to-one chat to its two (migration 16)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 15 });
    db.prepare("INSERT INTO source (id, platform, connector, kind, label, started_at, status) VALUES (1, 'telegram', 'matrix-bridge', 'live', 'sample', 0, 'ok')").run();
    const account = (key: string, isSelf = 0) =>
      Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, is_self) VALUES ('telegram', ?, 'id', ?, ?)").run(key, key, isSelf).lastInsertRowid);
    const conversation = (key: string, type: string, members: number[]) => {
      const id = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('telegram', ?, ?)").run(key, type).lastInsertRowid);
      for (const member of members) db.prepare("INSERT INTO conversation_member VALUES (?, ?)").run(id, member);
      return id;
    };
    const message = (conversationId: number, id: string, sender: number) =>
      db.prepare(`INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, sender_account_id, is_from_self, sent_at, type, first_source_id, last_source_id, raw_json)
        VALUES ('telegram', ?, ?, 'platform', ?, 0, 0, 'text', 1, 1, '{}')`).run(conversationId, id, sender);
    const [me, ada, bea, cy] = [account("100", 1), account("200"), account("300"), account("400")];
    // The clash: Bea's messages and Bea herself went to the chat with Ada.
    const withAda = conversation("user:200", "direct", [me, ada, bea]);
    const withBea = conversation("user:300", "direct", [me, bea]);
    const group = conversation("chat:9", "group", [me, ada, bea, cy]);
    message(withAda, "user:200/1", ada);
    message(withAda, "user:300/2", bea);
    message(withAda, "user:300/3", me);
    message(group, "chat:9/4", cy);
    // A message naming a chat the archive does not have stays where it is.
    message(group, "user:500/5", cy);
    const before = Number(getMeta(db, "links_version") ?? 0);
    db.close();

    db = openArchive(file);
    const where = db.prepare("SELECT m.platform_message_id AS id, c.platform_conversation_id AS chat FROM message m JOIN conversation c ON c.id = m.conversation_id ORDER BY m.id").all();
    expect(where.map((row) => ({ ...row }))).toEqual([
      { id: "user:200/1", chat: "user:200" },
      { id: "user:300/2", chat: "user:300" },
      { id: "user:300/3", chat: "user:300" },
      { id: "chat:9/4", chat: "chat:9" },
      { id: "user:500/5", chat: "chat:9" },
    ]);
    const members = (id: number) => (db.prepare("SELECT account_id AS a FROM conversation_member WHERE conversation_id = ? ORDER BY account_id").all(id) as { a: number }[]).map((r) => r.a);
    expect(members(withAda)).toEqual([me, ada]);
    expect(members(withBea)).toEqual([me, bea]);
    expect(members(group)).toEqual([me, ada, bea, cy]);
    expect(Number(getMeta(db, "links_version"))).toBe(before + 1);
    db.close();
  });

  it("leaves links_version alone when no Telegram message is misfiled (migration 16)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 15 });
    const before = getMeta(db, "links_version");
    db.close();
    db = openArchive(file);
    expect(getMeta(db, "links_version")).toBe(before);
    db.close();
  });

  it("gives WhatsApp messages back the text the bridge's own words took from them (migration 17)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 16 });
    db.prepare("INSERT INTO source (id, platform, connector, kind, label, started_at, status) VALUES (1, 'whatsapp', 'whatsapp-db', 'app-db', 'copy', 0, 'ok')").run();
    db.prepare("INSERT INTO source (id, platform, connector, kind, label, started_at, status) VALUES (2, 'whatsapp', 'matrix-whatsapp', 'live', 'live', 1, 'ok')").run();
    const chat = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('whatsapp', '61491571266@s.whatsapp.net', 'direct')").run().lastInsertRowid);
    const live = (content: Record<string, unknown>) => JSON.stringify({ event_id: "$e", type: "m.room.message", content });
    const message = (id: string, type: string, text: string | null, first: number, last: number, raw: string) =>
      Number(db.prepare(`INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, is_from_self, sent_at, type, text, first_source_id, last_source_id, raw_json)
        VALUES ('whatsapp', ?, ?, 'platform', 0, 0, ?, ?, ?, ?, ?)`).run(chat, id, type, text, first, last, raw).lastInsertRowid);
    const version = (messageId: number, text: string | null, source = 2) =>
      db.prepare("INSERT INTO message_version (message_id, text, replaced_at, source_id) VALUES (?, ?, 0, ?)").run(messageId, text, source);
    const failed = { msgtype: "m.notice", body: "Media is no longer available (sample)", "fi.mau.whatsapp.failed_media": { content: { msgtype: "m.image" } } };
    // Imported, then given the bridge's words by live WhatsApp: a photo it could not fetch, an unsupported message, a contact card.
    version(message("photo", "media", failed.body, 1, 2, live(failed)), "The crag");
    version(message("unknown", "other", "Unsupported message (sample)", 1, 2, live({ msgtype: "m.notice", body: "Unsupported message (sample)" })), null);
    version(message("card", "contact", null, 1, 2, live({ msgtype: "m.file", body: "Ada.vcf", info: { mimetype: "text/vcard" } })), "Ada");
    // Kept: a business message whose text live WhatsApp could read, and a photo an import has changed again since.
    version(message("business", "other", "Your order is on its way (sample)", 1, 2, live({ msgtype: "m.text", body: "Your order is on its way (sample)" })), null);
    version(message("later", "media", "A caption (sample)", 1, 1, "{}"), "Media is no longer available (sample)");
    // Only live WhatsApp has these.
    message("live-photo", "text", failed.body, 2, 2, live(failed));
    message("live-notice", "text", "Unsupported message (sample)", 2, 2, live({ msgtype: "m.notice", body: "Unsupported message (sample)" }));
    db.close();

    db = openArchive(file);
    expect(db.prepare("SELECT platform_message_id AS id, type, text FROM message ORDER BY rowid").all().map((row) => ({ ...row }))).toEqual([
      { id: "photo", type: "media", text: "The crag" },
      { id: "unknown", type: "other", text: null },
      { id: "card", type: "contact", text: "Ada" },
      { id: "business", type: "other", text: "Your order is on its way (sample)" },
      { id: "later", type: "media", text: "A caption (sample)" },
      { id: "live-photo", type: "media", text: null },
      { id: "live-notice", type: "other", text: null },
    ]);
    expect(db.prepare("SELECT m.platform_message_id AS id FROM message_version v JOIN message m ON m.id = v.message_id ORDER BY m.id").all().map((row) => ({ ...row })))
      .toEqual([{ id: "business" }, { id: "later" }]);
    db.close();
  });

  it("gives a new archive only the built-in tags (migrations 9, 31 and 48)", () => {
    const db = openArchive(join(dir, "archive.sqlite"));
    expect(new People(db).tags.list()).toEqual([
      { name: "archive", count: 0, builtIn: true },
      { name: "keep", count: 0, builtIn: true },
      { name: "live-together", count: 0, builtIn: true },
      { name: "show-name", count: 0, builtIn: true },
    ]);
    db.close();
  });

  it("makes live-together built in (migration 31): added last, with an id after any tag the change log remembers", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 30 });
    db.prepare("INSERT INTO tag (id, name, sort_order, built_in, created_at) VALUES (40, 'climbing', 2, 0, 0)").run();
    // A tag deleted since, which the change log remembers by its id.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, 0, 'cli', 'edit tag', '{}')").run();
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'tag', '[57]', '{}', NULL)").run();
    db.close();
    db = openArchive(file, { version: 31 });
    expect(db.prepare("SELECT id, name, sort_order, built_in FROM tag ORDER BY sort_order").all().map((row) => ({ ...row }))).toEqual([
      { id: 1, name: "archive", sort_order: 0, built_in: 1 },
      { id: 2, name: "keep", sort_order: 1, built_in: 1 },
      { id: 40, name: "climbing", sort_order: 2, built_in: 0 },
      { id: 58, name: "live-together", sort_order: 3, built_in: 1 },
    ]);
    db.close();
  });

  it("keeps a live-together tag the captain already made, its people and its place, and makes it built in (migration 31)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 30 });
    db.prepare("INSERT INTO tag (id, name, sort_order, built_in, created_at) VALUES (9, 'live-together', 0, 0, 5)").run();
    db.prepare("UPDATE tag SET sort_order = sort_order + 1 WHERE id <> 9").run();
    const ada = Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES ('Ada Sample', 'captain', 0)").run().lastInsertRowid);
    db.prepare("INSERT INTO person_tag (person_id, tag_id, added_at) VALUES (?, 9, 5)").run(ada);
    db.close();
    db = openArchive(file);
    expect(db.prepare("SELECT id, name, sort_order, built_in, created_at FROM tag WHERE name = 'live-together'").all().map((row) => ({ ...row })))
      .toEqual([{ id: 9, name: "live-together", sort_order: 0, built_in: 1, created_at: 5 }]);
    expect(new People(db).tags.of(ada)).toEqual(["live-together"]);
    db.close();
  });

  it("makes show-name built in (migration 48): added last, with an id after any tag the change log remembers, changing nothing else", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 47 });
    const people = new People(db);
    const ada = people.create("Ada Sample");
    people.setTags(ada, ["climbing"]);
    // A tag deleted since, which the change log remembers by its id.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (900, 0, 'cli', 'edit tag', '{}')").run();
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (900, 'tag', '[77]', '{}', NULL)").run();
    const others = () => db.prepare("SELECT id, name, sort_order, built_in FROM tag WHERE name <> 'show-name' ORDER BY sort_order").all().map((row) => ({ ...row }));
    const before = others();
    db.close();
    db = openArchive(file, { version: 48 });
    expect(others()).toEqual(before);
    expect(db.prepare("SELECT id, name, sort_order, built_in FROM tag WHERE name = 'show-name'").get()).toEqual({ id: 78, name: "show-name", sort_order: before.length, built_in: 1 });
    expect(new People(db).tags.of(ada)).toEqual(["climbing"]);
    db.close();
  });

  it("keeps a show-name tag the captain already made, its people and its place, and makes it built in (migration 48)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 47 });
    db.prepare("INSERT INTO tag (id, name, sort_order, built_in, created_at) VALUES (9, 'show-name', 0, 0, 5)").run();
    db.prepare("UPDATE tag SET sort_order = sort_order + 1 WHERE id <> 9").run();
    const ada = Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES ('Ada Sample', 'captain', 0)").run().lastInsertRowid);
    db.prepare("INSERT INTO person_tag (person_id, tag_id, added_at) VALUES (?, 9, 5)").run(ada);
    db.close();
    db = openArchive(file, { version: 48 });
    expect(db.prepare("SELECT id, name, sort_order, built_in, created_at FROM tag WHERE name = 'show-name'").all().map((row) => ({ ...row })))
      .toEqual([{ id: 9, name: "show-name", sort_order: 0, built_in: 1, created_at: 5 }]);
    expect(new People(db).tags.of(ada)).toEqual(["show-name"]);
    db.close();
  });

  it("gives calls notes: every logged call the empty one, its logged changes too, so undo still works, and an empty table for imported calls' (migration 49)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 48 });
    const ada = new People(db).create("Ada Example");
    db.prepare("INSERT INTO manual_call (id, call_group, person_id, account_id, at, duration_seconds, app, created_at) VALUES (4, 4, ?, NULL, 1000, 240, 'phone', 5)").run(ada);
    // The changeset that logged it, as the triggers logged it then, and one that deleted another since.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'app', 'call add', '{}')").run(Date.now());
    const row = { id: 4, call_group: 4, person_id: ada, account_id: null, at: 1000, duration_seconds: 240, app: "phone", created_at: 5 };
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'manual_call', ?, ?, ?)");
    log.run("[4]", null, JSON.stringify(row));
    log.run("[3]", JSON.stringify({ ...row, id: 3, call_group: 3 }), null);
    db.close();
    db = openArchive(file, { version: 49 });
    expect({ ...db.prepare("SELECT id, call_group, duration_seconds, note FROM manual_call").get() }).toEqual({ id: 4, call_group: 4, duration_seconds: 240, note: "" });
    expect((db.prepare("SELECT row_key, before_json, after_json FROM change_row ORDER BY id").all() as { row_key: string; before_json: string | null; after_json: string | null }[])
      .map((r) => [r.row_key, r.before_json && JSON.parse(r.before_json), r.after_json && JSON.parse(r.after_json)])).toEqual([
      ["[4]", null, { ...row, note: "" }],
      ["[3]", { ...row, id: 3, call_group: 3, note: "" }, null],
    ]);
    db.close();
    // On to now: undoing it deletes the call it logged, its note checked as the one it was logged with, and puts back the one it deleted.
    db = openArchive(file);
    changeLog(db, new People(db)).undo(1, { surface: "cli" });
    expect(db.prepare("SELECT id, note FROM manual_call").all().map((r) => ({ ...r }))).toEqual([{ id: 3, note: "" }]);
    // Imported calls' notes: a call record's or a call in no chat's, never both, each call once.
    expect(db.prepare("SELECT count(*) AS n FROM call_note").get()).toEqual({ n: 0 });
    const note = db.prepare("INSERT INTO call_note (message_id, platform, platform_call_id, note, set_at) VALUES (?, ?, ?, 'A note', 0)");
    note.run(null, "phone", "P1");
    expect(() => note.run(null, "phone", "P1")).toThrow(/UNIQUE/);
    expect(() => note.run(null, "phone", null)).toThrow(/CHECK/);
    expect(() => note.run(null, null, null)).toThrow(/CHECK/);
    expect(() => note.run(1, "phone", "P2")).toThrow(/CHECK/);
    db.close();
  });

  it("gives imported calls the captain's answer, an empty table, each call once, a call record's or a call in no chat's (migration 50)", () => {
    const file = join(dir, "archive.sqlite");
    openArchive(file, { version: 49 }).close();
    const db = openArchive(file, { version: 50 });
    expect(db.prepare("SELECT count(*) AS n FROM call_answered").get()).toEqual({ n: 0 });
    const answer = db.prepare("INSERT INTO call_answered (message_id, platform, platform_call_id, answered, set_at) VALUES (?, ?, ?, ?, 0)");
    answer.run(null, "phone", "P1", "missed");
    answer.run(null, "phone", "P2", "");
    expect(() => answer.run(null, "phone", "P1", "answered")).toThrow(/UNIQUE/);
    expect(() => answer.run(null, "phone", "P3", "maybe")).toThrow(/CHECK/);
    expect(() => answer.run(null, "phone", null, "missed")).toThrow(/CHECK/);
    expect(() => answer.run(1, "phone", "P4", "missed")).toThrow(/CHECK/);
    db.close();
  });

  it("keeps each message's length in characters (migration 52): filled once from the texts there, then kept as messages come, change and go", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 51 });
    db.prepare("INSERT INTO source (id, platform, connector, kind, label, started_at, status) VALUES (1, 'telegram', 'matrix-bridge', 'live', 'sample', 0, 'ok')").run();
    db.prepare("INSERT INTO conversation (id, platform, platform_conversation_id, type) VALUES (1, 'telegram', 'chat:1', 'group')").run();
    const message = (id: number, text: string | null) =>
      db.prepare(`INSERT INTO message (id, platform, conversation_id, platform_message_id, id_kind, is_from_self, sent_at, type, text, first_source_id, last_source_id, raw_json)
        VALUES (?, 'telegram', 1, ?, 'platform', 1, 0, 'text', ?, 1, 1, '{}')`).run(id, `m${id}`, text);
    const chars = () => db.prepare("SELECT message_id, chars FROM message_chars ORDER BY message_id").all();
    message(1, "made-up words");
    message(2, null);
    message(3, "");
    db.close();
    db = openArchive(file, { version: 52 });
    // Characters, not bytes: "é" and "日本" are one and two.
    expect(chars()).toEqual([{ message_id: 1, chars: 13 }, { message_id: 3, chars: 0 }]);
    message(4, "café 日本");
    db.prepare("UPDATE message SET text = 'longer made-up words' WHERE id = 1").run();
    db.prepare("UPDATE message SET text = 'now some' WHERE id = 2").run();
    db.prepare("UPDATE message SET text = NULL WHERE id = 3").run();
    db.prepare("UPDATE message SET unsent = 1 WHERE id = 4").run();
    expect(chars()).toEqual([{ message_id: 1, chars: 20 }, { message_id: 2, chars: 8 }, { message_id: 4, chars: 7 }]);
    db.prepare("DELETE FROM message WHERE id = 4").run();
    expect(chars()).toEqual([{ message_id: 1, chars: 20 }, { message_id: 2, chars: 8 }]);
    db.close();
  });

  it("gives catch-ups hours and by call in place of a kind, a way and a time, their logged changes too, so undo still works (migration 26)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 25 });
    const ada = new People(db).create("Ada Example");
    const catchUp = db.prepare("INSERT INTO catch_up (id, day, time, kind, mode, note, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)");
    catchUp.run(1, "2026-10-01", "19:30", "catch-up", "in-person", "dinner");
    catchUp.run(2, "2026-10-02", null, "quick-catch-up", "phone", "");
    for (const id of [1, 2]) db.prepare("INSERT INTO catch_up_person VALUES (?, ?)").run(id, ada);
    // The changeset that added the second, as the triggers logged it then.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up add', '{}')").run(Date.now());
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, ?, ?, NULL, ?)");
    log.run("catch_up", "[2]", JSON.stringify({ id: 2, day: "2026-10-02", time: null, kind: "quick-catch-up", mode: "phone", note: "", created_at: 0 }));
    log.run("catch_up_person", JSON.stringify([2, ada]), JSON.stringify({ catch_up_id: 2, person_id: ada }));
    db.close();

    db = openArchive(file, { version: 26 });
    expect(db.prepare("SELECT id, day, hours, by_call, note FROM catch_up ORDER BY id").all().map((row) => ({ ...row }))).toEqual([
      { id: 1, day: "2026-10-01", hours: 3, by_call: 0, note: "dinner" },
      { id: 2, day: "2026-10-02", hours: 1, by_call: 1, note: "" },
    ]);
    expect(JSON.parse((db.prepare("SELECT after_json FROM change_row WHERE tbl = 'catch_up'").get() as { after_json: string }).after_json))
      .toEqual({ id: 2, day: "2026-10-02", hours: 1, by_call: 1, note: "", created_at: 0 });
    expect(() => db.prepare("UPDATE catch_up SET hours = 0 WHERE id = 1").run()).toThrow(/CHECK/);
    db.close();

    // And on (migration 28 takes by call into the note, 37 back out; to 60, the last that has it, as one by call stops
    // migration 61), where undoing that changeset still works.
    db = openArchive(file, { version: 60 });
    const people = new People(db);
    changeLog(db, people).undo(1, { surface: "cli" });
    expect(people.catchUps.list().map((c) => c.id)).toEqual([1]);
    db.close();
  });

  it("writes by call into a catch-up's note and drops it, their logged changes too, so undo still works (migration 28)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 27 });
    const ada = new People(db).create("Ada Example");
    const catchUp = db.prepare("INSERT INTO catch_up (id, day, hours, by_call, note, created_at) VALUES (?, ?, ?, ?, ?, 0)");
    catchUp.run(1, "2026-10-01", 3, 0, "dinner");
    catchUp.run(2, "2026-10-02", 1, 1, "");
    catchUp.run(3, "2026-10-03", 2.5, 1, "a long Discord call");
    for (const id of [1, 2, 3]) db.prepare("INSERT INTO catch_up_person VALUES (?, ?)").run(id, ada);
    // The changeset that changed the third from an hour in person, as the triggers logged it then.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up change', '{}')").run(Date.now());
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'catch_up', '[3]', ?, ?)").run(
      JSON.stringify({ id: 3, day: "2026-10-03", hours: 1, by_call: 0, note: "a call", created_at: 0 }),
      JSON.stringify({ id: 3, day: "2026-10-03", hours: 2.5, by_call: 1, note: "a long Discord call", created_at: 0 }),
    );
    db.close();

    db = openArchive(file, { version: 28 });
    expect(db.prepare("SELECT id, hours, note FROM catch_up ORDER BY id DESC").all().map((row) => ({ ...row }))).toEqual([
      { id: 3, hours: 2.5, note: "By call: a long Discord call" },
      { id: 2, hours: 1, note: "By call" },
      { id: 1, hours: 3, note: "dinner" },
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('catch_up')").all().map((row) => (row as { name: string }).name)).not.toContain("by_call");
    const logged = () => db.prepare("SELECT before_json, after_json FROM change_row WHERE tbl = 'catch_up'").get() as { before_json: string; after_json: string };
    expect(JSON.parse(logged().before_json)).toEqual({ id: 3, day: "2026-10-03", hours: 1, note: "a call", created_at: 0 });
    expect(JSON.parse(logged().after_json)).toEqual({ id: 3, day: "2026-10-03", hours: 2.5, note: "By call: a long Discord call", created_at: 0 });
    db.close();

    // And on to 60 (the last with by call): migration 37 takes by call back out of the note, as it was, and undo still works.
    db = openArchive(file, { version: 60 });
    const people = new People(db);
    expect(db.prepare("SELECT id, hours, by_call, note FROM catch_up ORDER BY id DESC").all().map((row) => ({ ...row }))).toEqual([
      { id: 3, hours: 2.5, by_call: 1, note: "a long Discord call" },
      { id: 2, hours: 1, by_call: 1, note: "" },
      { id: 1, hours: 3, by_call: 0, note: "dinner" },
    ]);
    // (With no others, which migration 29 gives every catch-up logged, no time, which migration 36 gives, and no trip, which migration 53 gives.)
    const noTrip = { trip_last_day: null, trip_end_time: null, trip_private_from: null, trip_private_to: null };
    expect(JSON.parse(logged().before_json)).toEqual({ id: 3, day: "2026-10-03", hours: 1, by_call: 0, note: "a call", created_at: 0, others: 0, time: null, ...noTrip });
    expect(JSON.parse(logged().after_json)).toEqual({ id: 3, day: "2026-10-03", hours: 2.5, by_call: 1, note: "a long Discord call", created_at: 0, others: 0, time: null, ...noTrip });
    changeLog(db, people).undo(1, { surface: "cli" });
    // (Its hours and note: this code never writes by_call, so on an archive at 60 it stays as it is.)
    expect(db.prepare("SELECT hours, by_call, note FROM catch_up WHERE id = 3").get()).toEqual({ hours: 1, by_call: 1, note: "a call" });
    db.close();
  });

  it("gives every catch-up, and the change log's rows of them, no unnamed others, so undo still works (migration 29)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 28 });
    const ada = new People(db).create("Ada Example");
    const catchUp = db.prepare("INSERT INTO catch_up (id, day, hours, note, created_at) VALUES (?, ?, ?, ?, 0)");
    catchUp.run(1, "2026-10-01", 3, "dinner");
    catchUp.run(2, "2026-10-02", 1, "");
    for (const id of [1, 2]) db.prepare("INSERT INTO catch_up_person VALUES (?, ?)").run(id, ada);
    // A changeset that changed the second, and one that deleted a third, as the triggers logged them then.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up change', '{}'), (2, ?, 'cli', 'catch-up delete', '{}')").run(Date.now(), Date.now());
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, 'catch_up', ?, ?, ?)");
    log.run(1, "[2]", JSON.stringify({ id: 2, day: "2026-10-02", hours: 2, note: "", created_at: 0 }), JSON.stringify({ id: 2, day: "2026-10-02", hours: 1, note: "", created_at: 0 }));
    log.run(2, "[3]", JSON.stringify({ id: 3, day: "2026-10-03", hours: 1, note: "lunch", created_at: 0 }), null);
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (2, 'catch_up_person', ?, ?, NULL)").run(
      JSON.stringify([3, ada]), JSON.stringify({ catch_up_id: 3, person_id: ada }),
    );
    db.close();

    db = openArchive(file);
    const people = new People(db);
    expect(people.catchUps.list().map(({ id, others }) => ({ id, others }))).toEqual([{ id: 2, others: 0 }, { id: 1, others: 0 }]);
    expect(people.catchUps.scored().map((c) => c.others)).toEqual([0, 0]);
    const logged = db.prepare("SELECT before_json, after_json FROM change_row WHERE tbl = 'catch_up' ORDER BY id").all() as { before_json: string; after_json: string | null }[];
    expect(logged.map((row) => [JSON.parse(row.before_json).others, row.after_json && JSON.parse(row.after_json).others])).toEqual([[0, 0], [0, null]]);
    expect(() => db.prepare("UPDATE catch_up SET others = -1 WHERE id = 1").run()).toThrow(/CHECK/);
    // Undoing either puts the catch-up back as catch-ups are now kept.
    const changes = changeLog(db, people);
    changes.undo(1, { surface: "cli" });
    changes.undo(2, { surface: "cli" });
    expect(people.catchUps.get(2)).toMatchObject({ hours: 2, others: 0 });
    expect(people.catchUps.get(3)).toMatchObject({ hours: 1, note: "lunch", others: 0 });
    // And a catch-up with others keeps them.
    people.changeCatchUp(1, { day: "2026-10-01", hours: 3, note: "dinner", personIds: [ada], others: 20 });
    expect(people.catchUps.get(1).others).toBe(20);
    db.close();
  });

  it("indexes messages and calls by when they were, for the Calendar, changing nothing in them (migration 30)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 29 });
    const indexes = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('message_time', 'call_at') ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    expect(indexes()).toEqual([]);
    db.close();
    db = openArchive(file);
    expect(indexes()).toEqual(["call_at", "message_time"]);
    expect((db.prepare("PRAGMA index_info(message_time)").all() as { name: string }[]).map((column) => column.name)).toEqual(["sent_at", "conversation_id", "sender_account_id", "type"]);
    db.close();
  });

  it("makes Location a column of person (migration 32): everyone keeps theirs, the value tables go, and it says how many", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 31 });
    const person = (name: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, edited_at, created_at, identicon_seed) VALUES (?, 'captain', 1, 1, '0123456789abcdef')")
        .run(name).lastInsertRowid);
    const value = (name: string) => Number(db.prepare("INSERT INTO field_value (field, name, created_at) VALUES ('location', ?, 1)").run(name).lastInsertRowid);
    const give = db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'location', 1)");
    const [ada, bea, cy, dee] = ["Ada Sample", "Bea Test", "Cy Example", "Dee Placeholder"].map(person);
    const [brisbane, hobart, tokyo] = ["Brisbane", "Hobart", "Tokyo"].map(value);
    value("Perth"); // nobody's: goes with the table
    give.run(ada, brisbane);
    give.run(bea, hobart);
    give.run(dee, tokyo);
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();

    db = openArchive(file);
    const location = (id: number) => (db.prepare("SELECT location FROM person WHERE id = ?").get(id) as { location: string | null }).location;
    expect([ada, bea, cy, dee].map(location)).toEqual(["Brisbane", "Hobart", null, "Tokyo"]);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%field_value%'").all();
    expect(tables).toEqual([]);
    expect(locationColumn(db)).toEqual({ before: { people: 3, values: 3, unused: 1 }, after: { people: 3, values: 3 } });
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    // Compared without case, in the people view too.
    expect(db.prepare("SELECT id FROM person WHERE location = 'BRISBANE'").all().map((row) => ({ ...row }))).toEqual([{ id: ada }]);
    expect(new People(db).locations.list()).toEqual([{ name: "Brisbane", count: 1 }, { name: "Hobart", count: 1 }, { name: "Tokyo", count: 1 }]);
    db.close();

    // Opened again, nothing more happens.
    db = openArchive(file);
    expect([ada, bea, cy, dee].map(location)).toEqual(["Brisbane", "Hobart", null, "Tokyo"]);
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    db.close();
  });

  it("leaves people_version alone and tells nothing when nobody had a location (migration 32)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 31 });
    db.prepare("INSERT INTO person (name, name_source, created_at) VALUES ('Ada Sample', 'captain', 1)").run();
    const before = getMeta(db, "people_version");
    db.close();
    db = openArchive(file);
    expect(getMeta(db, "people_version")).toBe(before);
    expect(locationColumn(db)).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM person WHERE location IS NOT NULL").get()).toEqual({ n: 0 });
    db.close();
  });

  it("turns the change log's rows of location values into person rows, so older changesets still undo, or refuse (migration 32)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 31 });
    const person = (name: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, edited_at, created_at, identicon_seed) VALUES (?, 'captain', 1, 1, '0123456789abcdef')")
        .run(name).lastInsertRowid);
    const value = (name: string) => Number(db.prepare("INSERT INTO field_value (field, name, created_at) VALUES ('location', ?, 1)").run(name).lastInsertRowid);
    const give = db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, 'location', 1)");
    // A person row as the triggers logged it before migration 32.
    const row = (id: number) => (db.prepare(`SELECT json_object('id', id, 'name', name, 'name_source', name_source, 'aliases_json', aliases_json,
      'is_self', is_self, 'edited_at', edited_at, 'created_at', created_at, 'note', note, 'address_book_note', address_book_note,
      'should_reach_out', should_reach_out, 'draft_opener', draft_opener, 'identicon_seed', identicon_seed) AS row FROM person WHERE id = ?`)
      .get(id) as { row: string }).row;
    const given = (personId: number, valueId: number) => JSON.stringify({ person_id: personId, value_id: valueId, field: "location", added_at: 1 });
    const changeset = (id: number, action: string) =>
      db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (?, ?, 'cli', ?, '{}')").run(id, Date.now(), action);
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, ?, ?, ?, ?)");
    const [ada, bea, cy, dee, eve] = ["Ada Sample", "Bea Test", "Cy Example", "Dee Placeholder", "Eve Sample"].map(person);
    const [brisbane, hobart, tokyo, online] = ["Brisbane", "Hobart", "Tokyo", "Online"].map(value);

    // 1: Ada given Brisbane.
    give.run(ada, brisbane);
    changeset(1, "person location");
    log.run(1, "person_field_value", JSON.stringify([ada, brisbane]), null, given(ada, brisbane));
    // 2: Cy merged into Bea: Cy (at Hobart) deleted, Bea renamed and given Hobart.
    give.run(cy, hobart);
    const [cyBefore, beaBefore] = [row(cy), row(bea)];
    db.prepare("DELETE FROM person_field_value WHERE person_id = ?").run(cy);
    db.prepare("DELETE FROM person WHERE id = ?").run(cy);
    db.prepare("UPDATE person SET name = 'Bea Test-Example' WHERE id = ?").run(bea);
    give.run(bea, hobart);
    changeset(2, "merge");
    log.run(2, "person", JSON.stringify([bea]), beaBefore, row(bea));
    log.run(2, "person", JSON.stringify([cy]), cyBefore, null);
    log.run(2, "person_field_value", JSON.stringify([cy, hobart]), given(cy, hobart), null);
    log.run(2, "person_field_value", JSON.stringify([bea, hobart]), null, given(bea, hobart));
    // 3: Tokio renamed Tokyo, which Dee is at.
    give.run(dee, tokyo);
    changeset(3, "field rename");
    log.run(3, "field_value", JSON.stringify([tokyo]), JSON.stringify({ id: tokyo, field: "location", name: "Tokio", created_at: 1 }),
      JSON.stringify({ id: tokyo, field: "location", name: "Tokyo", created_at: 1 }));
    // 4: Eve given a met value, as migration 27 left the change log (the value gone since): it cannot be put back.
    changeset(4, "person met");
    log.run(4, "person_field_value", JSON.stringify([eve, online]), null, JSON.stringify({ person_id: eve, value_id: online, field: "met", added_at: 1 }));
    db.close();

    db = openArchive(file);
    const location = (id: number) => (db.prepare("SELECT location FROM person WHERE id = ?").get(id) as { location: string | null } | undefined)?.location;
    const rows = (id: number) => (db.prepare("SELECT tbl, row_key, before_json, after_json FROM change_row WHERE changeset_id = ? ORDER BY id").all(id) as
      { tbl: string; row_key: string; before_json: string | null; after_json: string | null }[])
      .map((r) => ({ tbl: r.tbl, key: JSON.parse(r.row_key), before: JSON.parse(r.before_json ?? "null")?.location, after: JSON.parse(r.after_json ?? "null")?.location }));
    expect(rows(1)).toEqual([{ tbl: "person", key: [ada], before: null, after: "Brisbane" }]);
    expect(rows(2)).toEqual([{ tbl: "person", key: [bea], before: null, after: "Hobart" }, { tbl: "person", key: [cy], before: "Hobart", after: undefined }]);
    expect(rows(3)).toEqual([{ tbl: "person", key: [dee], before: "Tokio", after: "Tokyo" }]);
    expect(rows(4).map((r) => r.tbl)).toEqual(["person_field_value"]);

    const people = new People(db);
    const changes = changeLog(db, people);
    changes.undo(1, { surface: "cli" });
    expect(location(ada)).toBeNull();
    changes.undo(2, { surface: "cli" });
    expect([bea, cy].map(location)).toEqual([null, "Hobart"]);
    expect(db.prepare("SELECT name FROM person WHERE id = ?").get(bea)).toEqual({ name: "Bea Test" });
    // Changed again since, a rename is refused; as it was left, it goes back.
    people.setLocation(dee, "Brisbane");
    expect(() => changes.undo(3, { surface: "cli" })).toThrow(`can't undo #3: changed again since: Dee Placeholder [person ${dee}] (location)`);
    people.setLocation(dee, "Tokyo");
    changes.undo(3, { surface: "cli" });
    expect(location(dee)).toBe("Tokio");
    expect(() => changes.undo(4, { surface: "cli" })).toThrow(`can't undo #4: changed again since: Eve Sample [person ${eve}] (met, kept as it no longer is)`);
    expect(location(eve)).toBeNull();
    db.close();
  });

  it("finds people by location, and lists every location with how many, from the index (migration 32)", () => {
    const db = openArchive(join(dir, "archive.sqlite"));
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail).join("; ");
    expect(plan("SELECT id FROM person WHERE location = 'brisbane'")).toMatch(/SEARCH person USING COVERING INDEX person_location \(location=\?\)/);
    const list = plan("SELECT location AS name, count(*) AS count FROM person WHERE location IS NOT NULL GROUP BY location ORDER BY count DESC, location");
    expect(list).toMatch(/USING COVERING INDEX person_location/);
    expect(list).not.toMatch(/TEMP B-TREE FOR GROUP BY/);
    expect(plan("SELECT DISTINCT location FROM person")).toMatch(/SCAN person USING COVERING INDEX person_location/);
    db.close();
  });

  it("keeps how long Messenger's and Instagram's call records were, read from their original records (migration 33)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 32 });
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 't', 'export', 't', 0, 'ok')").run().lastInsertRowid);
    const chat = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('messenger', 'c', 'direct')").run().lastInsertRowid);
    const add = db.prepare(
      `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, is_from_self, sent_at, type, first_source_id, last_source_id, raw_json)
       VALUES (?, ?, ?, 'synthetic', 0, 1, ?, ?, ?, ?)`,
    );
    const records: Array<[string, string, string, unknown]> = [
      ["messenger", "answered", "call", { call_duration: 4320 }],
      ["messenger", "missed", "call", { call_duration: 0, missed: true }],
      ["instagram", "fractional", "call", { call_duration: 61.6 }],
      ["messenger", "no length", "call", {}],
      ["messenger", "a word", "call", { call_duration: "long" }],
      ["wechat", "wechat", "call", { call_duration: 30 }],
      ["messenger", "text", "text", { call_duration: 30 }],
    ];
    for (const [platform, id, type, raw] of records) add.run(platform, chat, id, type, source, source, JSON.stringify(raw));
    db.close();
    db = openArchive(file);
    expect(Object.fromEntries((db.prepare("SELECT platform_message_id AS id, call_seconds FROM message").all() as { id: string; call_seconds: number | null }[])
      .map((row) => [row.id, row.call_seconds]))).toEqual({
      answered: 4320, missed: 0, fractional: 62, "no length": null, "a word": null, wechat: null, text: null,
    });
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT id FROM message WHERE type = 'call' AND conversation_id = 1").all() as { detail: string }[]).map((row) => row.detail).join("; ");
    expect(plan).toMatch(/USING (COVERING )?INDEX message_call/);
    db.close();
  });

  it("reads Messenger's phone-app export's empty links as calls, Signal's unanswered calls as 0 long, and makes the table for the captain's call lengths (migration 34)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 33 });
    const source = (connector: string, platform: string) =>
      Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, ?, 'export', 't', 0, 'ok')").run(platform, connector).lastInsertRowid);
    const exported = source("messenger-export", "messenger");
    const dyi = source("facebook-dyi", "messenger");
    const signal = source("signal-export", "signal");
    const chat = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('messenger', 'c', 'direct')").run().lastInsertRowid);
    const add = db.prepare(
      `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, is_from_self, sent_at, type, text, unsent, first_source_id, last_source_id, raw_json)
       VALUES (?, ?, ?, 'synthetic', 0, 1, ?, ?, ?, ?, ?, ?)`,
    );
    const call = (state: string) => ({ updateMessage: { individualCall: { state } } });
    const records: Array<[string, string, string, string | null, number, number, unknown]> = [
      ["messenger", "empty link", "link", null, 0, exported, { type: "link", text: "", media: [] }],
      ["messenger", "link with words", "link", "https://example.com", 0, exported, { type: "link", text: "https://example.com", media: [] }],
      ["messenger", "link with media", "link", null, 0, exported, { type: "link", text: "", media: [{ uri: "a.jpg" }] }],
      ["messenger", "unsent link", "link", null, 1, exported, { type: "link", text: "", isUnsent: true }],
      ["messenger", "another connector's", "link", null, 0, dyi, { type: "link" }],
      ["signal", "answered", "call", null, 0, signal, call("ACCEPTED")],
      ["signal", "missed", "call", null, 0, signal, call("MISSED")],
      ["signal", "not accepted", "call", null, 0, signal, call("NOT_ACCEPTED")],
      ["signal", "state not known", "call", null, 0, signal, call("UNKNOWN_STATE")],
    ];
    for (const [platform, id, type, text, unsent, from, raw] of records) add.run(platform, chat, id, type, text, unsent, from, from, JSON.stringify(raw));
    db.close();
    db = openArchive(file);
    expect(Object.fromEntries((db.prepare("SELECT platform_message_id AS id, type, call_seconds FROM message").all() as { id: string; type: string; call_seconds: number | null }[])
      .map((row) => [row.id, [row.type, row.call_seconds]]))).toEqual({
      "empty link": ["call", null], "link with words": ["link", null], "link with media": ["link", null], "unsent link": ["link", null],
      "another connector's": ["link", null], answered: ["call", null], missed: ["call", 0], "not accepted": ["call", 0], "state not known": ["call", null],
    });
    expect(db.prepare("SELECT count(*) AS n FROM call_length").get()).toEqual({ n: 0 });
    db.close();
  });

  it("gives WeChat's call records the length their kept words say, 0 when they never connected (migration 35)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 34 });
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('wechat', 'wechat-ios', 'app-db', 't', 0, 'ok')").run().lastInsertRowid);
    const chat = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('wechat', 'c', 'direct')").run().lastInsertRowid);
    const add = db.prepare(
      `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, is_from_self, sent_at, type, first_source_id, last_source_id, raw_json)
       VALUES (?, ?, ?, 'platform', 0, 1, ?, ?, ?, ?)`,
    );
    const records: Array<[string, string, string, unknown]> = [
      ["wechat", "answered", "call", { Type: 50, Message: voipBubble("通话时长 12:05") }],
      ["wechat", "declined", "call", { Type: 50, Message: voipBubble("Declined") }],
      ["wechat", "compressed", "call", { Type: 50, WCDB_CT_Message: 2 }],
      ["wechat", "unknown words", "call", { Type: 50, Message: voipBubble("Something new") }],
      ["wechat", "a text", "text", { Type: 1, Message: "Duration 00:31" }],
      ["signal", "another app's", "call", { Message: voipBubble("Duration 00:31") }],
    ];
    for (const [platform, id, type, raw] of records) add.run(platform, chat, id, type, source, source, JSON.stringify(raw));
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();
    db = openArchive(file);
    expect(Object.fromEntries((db.prepare("SELECT platform_message_id AS id, call_seconds FROM message").all() as { id: string; call_seconds: number | null }[])
      .map((row) => [row.id, row.call_seconds]))).toEqual({
      answered: 725, declined: 0, compressed: null, "unknown words": null, "a text": null, "another app's": null,
    });
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    db.close();
  });

  it("lets a call in no chat be with several people, unnamed others, an app's voice or video, of no known length, keeping every call as it was (migration 45)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 44 });
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('phone', 'call-history', 'app-db', 't', 0, 'ok')").run().lastInsertRowid);
    const account = (platform: string, key: string) =>
      Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name) VALUES (?, ?, 'id', ?)").run(platform, key, key).lastInsertRowid);
    const phone = account("phone", "+61491570006");
    db.prepare(
      `INSERT INTO call (id, platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service, first_source_id, last_source_id, raw_json)
       VALUES (7, 'phone', 'P1', ?, 1, 150, 'outgoing', 1, 'phone', ?, ?, '{}')`,
    ).run(phone, source, source);
    db.close();
    db = openArchive(file);
    expect({ ...db.prepare("SELECT id, import_person_id, duration_seconds, service, others FROM call").get() }).toEqual(
      { id: 7, import_person_id: phone, duration_seconds: 150, service: "phone", others: 0 },
    );
    const [ada, bea] = [account("whatsapp", "ada"), account("whatsapp", "bea")];
    const add = db.prepare(
      `INSERT INTO call (platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service, others, first_source_id, last_source_id, raw_json)
       VALUES ('whatsapp', 'W1', ?, 1, NULL, 'incoming', 1, 'video', 1, ?, ?, '{}')`,
    );
    add.run(ada, source, source);
    add.run(bea, source, source);
    expect(() => add.run(ada, source, source)).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT count(*) AS n FROM call WHERE platform_call_id = 'W1'").get()).toEqual({ n: 2 });
    db.close();
  });

  it("makes Telegram's call notices kept as text call records with how long the words say, and a call ringing a system message from no one (migration 46)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 45 });
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('telegram', 'matrix-bridge', 'live', 't', 0, 'ok')").run().lastInsertRowid);
    const chat = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES ('telegram', 'user:1', 'direct')").run().lastInsertRowid);
    const ada = Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name) VALUES ('telegram', '1', 'id', 'Ada')").run().lastInsertRowid);
    const add = db.prepare(
      `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, sender_account_id, is_from_self, sent_at, type, text, first_source_id, last_source_id, raw_json)
       VALUES (?, ?, ?, 'platform', ?, 0, 1, 'text', ?, ?, ?, ?)`,
    );
    const notice = (body: string) => JSON.stringify({ type: "m.room.message", content: { msgtype: "m.notice", body } });
    const records: Array<[string, string, string, string]> = [
      ["telegram", "ended", "Call ended (1 hour, 2 minutes and 5 seconds)", notice("Call ended (1 hour, 2 minutes and 5 seconds)")],
      ["telegram", "missed", "Video call missed", notice("Video call missed")],
      ["telegram", "video chat", "Ended the video chat (12 minutes)", notice("Ended the video chat (12 minutes)")],
      ["telegram", "started", "Started a video chat", notice("Started a video chat")],
      ["telegram", "ringing", "Started a call", notice("Started a call")],
      ["telegram", "other notice", "Created the group", notice("Created the group")],
      ["telegram", "typed", "Call ended", JSON.stringify({ type: "m.room.message", content: { msgtype: "m.text", body: "Call ended" } })],
      ["whatsapp", "another app's", "Call ended", notice("Call ended")],
    ];
    for (const [platform, id, text, raw] of records) add.run(platform, chat, id, ada, text, source, source, raw);
    const before = Number(getMeta(db, "people_version") ?? 0);
    db.close();
    db = openArchive(file);
    const rows = db.prepare("SELECT platform_message_id AS id, type, call_seconds, sender_account_id, text FROM message ORDER BY id").all() as Record<string, unknown>[];
    expect(Object.fromEntries(rows.map(({ id, ...row }) => [id, { ...row }]))).toEqual({
      ended: { type: "call", call_seconds: 3725, sender_account_id: ada, text: "Call ended (1 hour, 2 minutes and 5 seconds)" },
      missed: { type: "call", call_seconds: 0, sender_account_id: ada, text: "Video call missed" },
      "video chat": { type: "call", call_seconds: 720, sender_account_id: ada, text: "Ended the video chat (12 minutes)" },
      started: { type: "call", call_seconds: null, sender_account_id: ada, text: "Started a video chat" },
      ringing: { type: "system", call_seconds: null, sender_account_id: null, text: "Started a call" },
      "other notice": { type: "text", call_seconds: null, sender_account_id: ada, text: "Created the group" },
      typed: { type: "text", call_seconds: null, sender_account_id: ada, text: "Call ended" },
      "another app's": { type: "text", call_seconds: null, sender_account_id: ada, text: "Call ended" },
    });
    expect(Number(getMeta(db, "people_version"))).toBe(before + 1);
    db.close();
  });

  it("gives catch-ups a time again, none for every one so far nor for the change log's rows of them, so undo still works (migration 36)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 35 });
    const ada = new People(db).create("Ada Example");
    db.prepare("INSERT INTO catch_up (id, day, hours, note, created_at) VALUES (1, '2026-10-01', 3, 'dinner', 0)").run();
    db.prepare("INSERT INTO catch_up_person VALUES (1, ?)").run(ada);
    // A changeset that changed it, and one that deleted a second, as the triggers logged them then.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up change', '{}'), (2, ?, 'cli', 'catch-up delete', '{}')").run(Date.now(), Date.now());
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, 'catch_up', ?, ?, ?)");
    log.run(1, "[1]", JSON.stringify({ id: 1, day: "2026-10-01", hours: 2, note: "dinner", others: 0, created_at: 0 }), JSON.stringify({ id: 1, day: "2026-10-01", hours: 3, note: "dinner", others: 0, created_at: 0 }));
    log.run(2, "[2]", JSON.stringify({ id: 2, day: "2026-10-02", hours: 1, note: "lunch", others: 0, created_at: 0 }), null);
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (2, 'catch_up_person', ?, ?, NULL)").run(
      JSON.stringify([2, ada]), JSON.stringify({ catch_up_id: 2, person_id: ada }),
    );
    db.close();

    db = openArchive(file);
    const people = new People(db);
    expect(people.catchUps.get(1)).toMatchObject({ day: "2026-10-01", time: null, hours: 3 });
    const logged = db.prepare("SELECT before_json, after_json FROM change_row WHERE tbl = 'catch_up' ORDER BY id").all() as { before_json: string; after_json: string | null }[];
    expect(logged.map((row) => [JSON.parse(row.before_json).time, row.after_json && JSON.parse(row.after_json).time])).toEqual([[null, null], [null, null]]);
    expect(() => db.prepare("UPDATE catch_up SET time = '7.30pm' WHERE id = 1").run()).toThrow(/CHECK/);
    // Undoing either puts the catch-up back as catch-ups are now kept, without a time.
    const changes = changeLog(db, people);
    changes.undo(1, { surface: "cli" });
    changes.undo(2, { surface: "cli" });
    expect(people.catchUps.get(1)).toMatchObject({ hours: 2, time: null });
    expect(people.catchUps.get(2)).toMatchObject({ hours: 1, note: "lunch", time: null });
    // And one given a time keeps it.
    people.changeCatchUp(1, { day: "2026-10-01", time: "19:30", hours: 2, note: "dinner", personIds: [ada], others: 0 });
    expect(people.catchUps.get(1).time).toBe("19:30");
    db.close();
  });

  it("gives catch-ups no trip, every one so far nor the change log's rows of them, so undo still works, and holds a trip whole (migration 53)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 52 });
    const ada = new People(db).create("Ada Example");
    db.prepare("INSERT INTO catch_up (id, day, time, hours, by_call, note, others, created_at) VALUES (1, '2026-10-01', '19:30', 3, 0, 'dinner', 0, 0)").run();
    db.prepare("INSERT INTO catch_up_person VALUES (1, ?)").run(ada);
    // A changeset that changed it, as the triggers logged it then.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up change', '{}')").run(Date.now());
    const before = { id: 1, day: "2026-10-01", time: "19:30", hours: 2, by_call: 0, note: "dinner", others: 0, created_at: 0 };
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'catch_up', '[1]', ?, ?)").run(
      JSON.stringify(before), JSON.stringify({ ...before, hours: 3 }),
    );
    db.close();

    db = openArchive(file);
    const people = new People(db);
    expect(people.catchUps.get(1)).toMatchObject({ day: "2026-10-01", time: "19:30", trip: null, hours: 3 });
    const logged = db.prepare("SELECT before_json, after_json FROM change_row WHERE tbl = 'catch_up'").get() as { before_json: string; after_json: string };
    const noTrip = { trip_last_day: null, trip_end_time: null, trip_private_from: null, trip_private_to: null };
    expect(JSON.parse(logged.before_json)).toEqual({ ...before, ...noTrip });
    expect(JSON.parse(logged.after_json)).toEqual({ ...before, hours: 3, ...noTrip });
    changeLog(db, people).undo(1, { surface: "cli" });
    expect(people.catchUps.get(1)).toMatchObject({ hours: 2, trip: null });
    // A trip is whole, after its first day and with the time it began, or none.
    const set = (sql: string) => () => db.prepare(`UPDATE catch_up SET ${sql} WHERE id = 1`).run();
    const whole = "trip_last_day = '2026-10-03', trip_end_time = '16:00', trip_private_from = '00:00', trip_private_to = '10:00'";
    expect(set("trip_last_day = '2026-10-03'")).toThrow(/CHECK/);
    expect(set(`${whole}, trip_end_time = NULL`)).toThrow(/CHECK/);
    expect(set(whole.replace("2026-10-03", "2026-10-01"))).toThrow(/CHECK/);
    expect(set(`${whole}, time = NULL`)).toThrow(/CHECK/);
    expect(set(whole.replace("'16:00'", "'4pm'"))).toThrow(/CHECK/);
    set(whole)();
    expect(people.catchUps.get(1).trip).toEqual({ lastDay: "2026-10-03", endTime: "16:00", privateFrom: "00:00", privateTo: "10:00" });
    db.close();
  });

  it("gives catch-ups by call back, from the notes migration 28 wrote it into, their logged changes too, so undo still works (migration 37)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 36 });
    const ada = new People(db).create("Ada Example");
    const catchUp = db.prepare("INSERT INTO catch_up (id, day, hours, note, created_at) VALUES (?, '2026-10-01', 1, ?, 0)");
    // Its two shapes, and notes of neither: another case, words after "By call" with no colon, and one that only says it later.
    const notes = ["By call", "By call: a long Discord call", "by call", "By call with the family", "Dinner, then by call"];
    notes.forEach((note, i) => catchUp.run(i + 1, note));
    for (const id of notes.keys()) db.prepare("INSERT INTO catch_up_person VALUES (?, ?)").run(id + 1, ada);
    // A changeset that changed the second from an hour in person, and one that deleted a sixth by call.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up change', '{}'), (2, ?, 'cli', 'catch-up delete', '{}')").run(Date.now(), Date.now());
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, 'catch_up', ?, ?, ?)");
    const row = (id: number, hours: number, note: string) => JSON.stringify({ id, day: "2026-10-01", hours, note, created_at: 0, others: 0, time: null });
    log.run(1, "[2]", row(2, 0.5, "a call"), row(2, 1, "By call: a long Discord call"));
    log.run(2, "[6]", row(6, 2, "By call"), null);
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (2, 'catch_up_person', ?, ?, NULL)").run(
      JSON.stringify([6, ada]), JSON.stringify({ catch_up_id: 6, person_id: ada }),
    );
    db.close();

    db = openArchive(file, { version: 60 });
    const people = new People(db);
    expect(db.prepare("SELECT id, by_call, note FROM catch_up ORDER BY id").all().map((row) => ({ ...row }))).toEqual([
      { id: 1, by_call: 1, note: "" },
      { id: 2, by_call: 1, note: "a long Discord call" },
      { id: 3, by_call: 0, note: "by call" },
      { id: 4, by_call: 0, note: "By call with the family" },
      { id: 5, by_call: 0, note: "Dinner, then by call" },
    ]);
    const logged = db.prepare("SELECT before_json, after_json FROM change_row WHERE tbl = 'catch_up' ORDER BY id").all() as { before_json: string; after_json: string | null }[];
    expect(logged.map((r) => [JSON.parse(r.before_json), r.after_json && JSON.parse(r.after_json)].map((j) => j && [j.by_call, j.note]))).toEqual([
      [[0, "a call"], [1, "a long Discord call"]],
      [[1, ""], null],
    ]);
    expect(() => db.prepare("UPDATE catch_up SET by_call = 2 WHERE id = 1").run()).toThrow(/CHECK/);
    // Undoing the first puts the catch-up back as it was, in person; the second would bring back one by call, which
    // this code refuses (migration 61).
    const changes = changeLog(db, people);
    changes.undo(1, { surface: "cli" });
    // (Its hours and note: this code never writes by_call, so on an archive at 60 it stays as it is.)
    expect(db.prepare("SELECT hours, by_call, note FROM catch_up WHERE id = 2").get()).toEqual({ hours: 0.5, by_call: 1, note: "a call" });
    expect(() => changes.undo(2, { surface: "cli" })).toThrow(/can't undo #2: it would bring back a hangout by call: hangout #6/);
    db.close();
  });

  it("makes each draft opener its person's first draft, drops the column, and keeps how many moved; undo of an older opener change puts back nothing (migration 38)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 37 });
    const person = (name: string, opener: string) =>
      Number(db.prepare("INSERT INTO person (name, name_source, created_at, draft_opener) VALUES (?, 'captain', 0, ?)").run(name, opener).lastInsertRowid);
    const [ada, bea, cy] = [person("Ada Sample", "Coffee?\nSoon"), person("Bea Test", ""), person("Cy Example", "How was Japan?")];
    // A changeset that gave Bea an opener, before it was taken off again.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'person opener', '{}')").run(Date.now());
    const row = (opener: string) => JSON.stringify({ id: bea, name: "Bea Test", draft_opener: opener });
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'person', ?, ?, ?)").run(JSON.stringify([bea]), row(""), row("Hi"));
    db.close();

    db = openArchive(file);
    expect(draftsFromOpeners(db)).toBe(2);
    const people = new People(db);
    expect(people.drafts.list(ada).map((d) => d.text)).toEqual(["Coffee?\nSoon"]);
    expect(people.drafts.list(bea)).toEqual([]);
    expect(people.drafts.list(cy).map((d) => d.text)).toEqual(["How was Japan?"]);
    expect((db.prepare("PRAGMA table_info(person)").all() as { name: string }[]).map((c) => c.name)).not.toContain("draft_opener");
    expect(() => db.prepare("INSERT INTO draft (person_id, text, created_at, updated_at) VALUES (?, '', 0, 0)").run(ada)).toThrow(/CHECK/);
    expect(() => changeLog(db, people).undo(1, { surface: "cli" })).toThrow(/changed nothing that can be put back/);
    db.close();

    // A new archive moved none.
    const fresh = openArchive(join(dir, "fresh.sqlite"));
    expect(draftsFromOpeners(fresh)).toBe(0);
    fresh.close();
  });

  it("puts each logged call on the one account of its person's on its app, else on none, their logged changes too, so undo still works, and keeps how many (migration 39)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 38 });
    const person = (name: string) => Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'captain', 0)").run(name).lastInsertRowid);
    const [ada, bea] = [person("Ada Sample"), person("Bea Test")];
    const account = (personId: number, platform: string, key: string) => Number(db
      .prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES (?, ?, 'id', ?, ?)").run(platform, key, key, personId).lastInsertRowid);
    const phone = account(ada, "phone", "+61491570006");
    account(ada, "imessage", "+61491570006");
    const messenger = account(ada, "messenger", "ada.sample");
    account(bea, "telegram", "beatest");
    const call = (personId: number, app: string) => Number(db
      .prepare("INSERT INTO manual_call (person_id, at, duration_seconds, app, created_at) VALUES (?, 1000, 240, ?, 5)").run(personId, app).lastInsertRowid);
    const onPhone = call(ada, "phone");
    const facetime = call(ada, "facetime"); // her phone and her iMessage accounts both: on none
    const onMessenger = call(ada, "messenger");
    const wechat = call(bea, "wechat"); // no WeChat account: on none
    const other = call(bea, "other");
    // The changeset that logged the Messenger one.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'app', 'call add', '{}')").run(Date.now());
    const logged = JSON.stringify({ id: onMessenger, person_id: ada, at: 1000, duration_seconds: 240, app: "messenger", created_at: 5 });
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'manual_call', ?, NULL, ?)").run(JSON.stringify([onMessenger]), logged);
    db.close();

    db = openArchive(file);
    expect(loggedCallsToAccounts(db)).toEqual({ onAccounts: 2, onNone: 3 });
    const rows = db.prepare("SELECT id, person_id, account_id, app FROM manual_call ORDER BY id").all().map((row) => ({ ...row }));
    expect(rows).toEqual([
      { id: onPhone, person_id: null, account_id: phone, app: null },
      { id: facetime, person_id: ada, account_id: null, app: "facetime" },
      { id: onMessenger, person_id: null, account_id: messenger, app: null },
      { id: wechat, person_id: bea, account_id: null, app: "wechat" },
      { id: other, person_id: bea, account_id: null, app: "other" },
    ]);
    // (And on to now: migration 60 gives it no unnamed others.)
    expect(JSON.parse((db.prepare("SELECT after_json FROM change_row WHERE changeset_id = 1").get() as { after_json: string }).after_json))
      .toEqual({ id: onMessenger, call_group: onMessenger, person_id: null, account_id: messenger, at: 1000, duration_seconds: 240, app: null, created_at: 5, note: "", others: 0 });
    // Exactly one of an account and a person (with its app).
    expect(() => db.prepare("INSERT INTO manual_call (call_group, person_id, account_id, at, duration_seconds, app, created_at) VALUES (1, ?, ?, 0, 60, 'phone', 0)").run(ada, phone)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO manual_call (call_group, person_id, account_id, at, duration_seconds, app, created_at) VALUES (1, NULL, ?, 0, 60, 'phone', 0)").run(phone)).toThrow(/CHECK/);
    const people = new People(db);
    changeLog(db, people).undo(1, { surface: "cli" });
    expect(db.prepare("SELECT count(*) AS n FROM manual_call WHERE id = ?").get(onMessenger)).toEqual({ n: 0 });
    db.close();

    // A new archive moved none, and says nothing.
    const fresh = openArchive(join(dir, "fresh.sqlite"));
    expect(loggedCallsToAccounts(fresh)).toBeNull();
    fresh.close();
  });
  it("makes everyone's first alias their name, the label they had, their change log's rows too, so undo still works, and keeps how many (migration 42)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 41 });
    const person = (name: string, source: string, aliases: string[]) => Number(db
      .prepare("INSERT INTO person (name, name_source, aliases_json, created_at) VALUES (?, ?, ?, 0)").run(name, source, JSON.stringify(aliases)).lastInsertRowid);
    const ada = person("Ada Sample", "import", []);
    const bruno = person("Bruno Placeholder", "import", ["Bo", "Bruno P"]);
    const cleo = person("Cleo Example", "captain", ["Cleo Example", "CJ"]);
    // The changeset that gave Bruno his aliases, from none.
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'app', 'person aliases', '{}')").run(Date.now());
    const row = (aliases: string[]) => JSON.stringify({ name: "Bruno Placeholder", name_source: "import", aliases_json: JSON.stringify(aliases), is_self: 0, edited_at: null, created_at: 0 });
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'person', ?, ?, ?)").run(JSON.stringify([bruno]), row([]), row(["Bo", "Bruno P"]));
    db.close();

    db = openArchive(file);
    expect(namesFirstAliasLeads(db)).toBe(1);
    const names = () => db.prepare("SELECT id, name, name_source, aliases_json FROM person WHERE is_self = 0 ORDER BY id").all().map((r) => ({ ...r }));
    expect(names()).toEqual([
      { id: ada, name: "Ada Sample", name_source: "import", aliases_json: "[]" },
      { id: bruno, name: "Bo", name_source: "captain", aliases_json: JSON.stringify(["Bruno Placeholder", "Bruno P"]) },
      // Her first alias was her name: it is listed once, and her name stays as it was.
      { id: cleo, name: "Cleo Example", name_source: "captain", aliases_json: JSON.stringify(["CJ"]) },
    ]);
    const logged = db.prepare("SELECT before_json, after_json FROM change_row WHERE changeset_id = 1").get() as { before_json: string; after_json: string };
    expect(JSON.parse(logged.before_json)).toMatchObject({ name: "Bruno Placeholder", name_source: "import", aliases_json: "[]" });
    expect(JSON.parse(logged.after_json)).toMatchObject({ name: "Bo", name_source: "captain", aliases_json: JSON.stringify(["Bruno Placeholder", "Bruno P"]) });
    // Undoing it puts back the name he had and no aliases.
    changeLog(db, new People(db)).undo(1, { surface: "cli" });
    expect(names()[1]).toEqual({ id: bruno, name: "Bruno Placeholder", name_source: "import", aliases_json: "[]" });
    db.close();

    const fresh = openArchive(join(dir, "fresh.sqlite"));
    expect(namesFirstAliasLeads(fresh)).toBe(0);
    fresh.close();
  });

  it("only adds the empty trail of content reads, changing nothing else (migration 44)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 43 });
    const people = new People(db);
    people.setTags(people.create("Ada Sample"), ["climbing"]);
    people.setNote(people.create("Bruno Placeholder"), "met at the crag");
    /** Every table's definition and rows, but the trail's. */
    const everything = () => (db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'content_read%' ORDER BY name").all() as { type: string; name: string; sql: string | null }[])
      .map((entry) => ({ ...entry, rows: entry.type === "table" ? db.prepare(`SELECT * FROM "${entry.name}"`).all() : null }));
    const before = JSON.stringify(everything());
    db.close();

    db = openArchive(file, { version: 44 });
    expect(JSON.stringify(everything())).toBe(before);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'content_read%' ORDER BY name").all().map((row) => row.name)).toEqual(["content_read", "content_read_last_at"]);
    expect(db.prepare("SELECT count(*) AS n FROM content_read").get()).toEqual({ n: 0 });
    db.close();
  });

  it("only adds the empty event index, its devices and an LLM's sessions and turns, changing nothing else (migration 47)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 46 });
    const people = new People(db);
    people.setTags(people.create("Ada Sample"), ["climbing"]);
    const added = ["device", "event", "llm_session", "llm_turn"];
    /** Every table's and index's definition, and every table's rows, but the event index's. */
    const everything = () => (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all() as { type: string; name: string; tbl_name: string; sql: string | null }[])
      .filter((entry) => !added.includes(entry.tbl_name))
      .map((entry) => ({ ...entry, rows: entry.type === "table" ? db.prepare(`SELECT * FROM "${entry.name}"`).all() : null }));
    const before = JSON.stringify(everything());
    db.close();

    db = openArchive(file, { version: 47 });
    expect(JSON.stringify(everything())).toBe(before);
    for (const table of added) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    // The index refuses what it cannot be: an end before its start, a day that is no date, a second row for one source id.
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('claude-code', 'llm-sessions', 'app-db', 'projects', 0, 'ok')").run().lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO event (origin, native_id, kind, at, at_end, day, self, detail, detail_id, has_content, first_source_id, last_source_id)
       VALUES ('claude-code', ?, 'llm_session', 1000, ?, ?, 1, 'llm_session', ?, 1, ?, ?)`,
    );
    insert.run("s1", 2000, "2026-03-01", 1, source, source);
    expect(() => insert.run("s2", 500, "2026-03-01", 2, source, source)).toThrow(/CHECK/);
    expect(() => insert.run("s2", 2000, "1 March", 2, source, source)).toThrow(/CHECK/);
    expect(() => insert.run("s1", 2000, "2026-03-01", 3, source, source)).toThrow(/UNIQUE/);
    db.close();
  });

  it("lets a call logged on no account be on WhatsApp, Signal or Discord, keeping every logged call and its indexes as they were (migration 51)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 50 });
    const ada = Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES ('Ada Sample', 'captain', 0)").run().lastInsertRowid);
    const phone = Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('phone', '+61491570006', 'id', '+61491570006', ?)").run(ada).lastInsertRowid);
    const insert = (...values: (number | string | null)[]) => db
      .prepare("INSERT INTO manual_call (call_group, person_id, account_id, at, duration_seconds, app, created_at, note) VALUES (?, ?, ?, 1000, 240, ?, 5, ?)").run(...values);
    insert(1, null, phone, null, "Planned the trip");
    insert(1, ada, null, "wechat", "Planned the trip");
    expect(() => insert(3, ada, null, "discord", "")).toThrow(/CHECK/);
    const rows = () => db.prepare("SELECT * FROM manual_call ORDER BY id").all().map((row) => ({ ...row }));
    const indexes = () => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'manual_call' ORDER BY name").all().map((row) => row.name);
    const before = rows();
    expect(indexes()).toEqual(["manual_call_account_at", "manual_call_group", "manual_call_person_at"]);
    db.close();

    db = openArchive(file, { version: 51 });
    expect(rows()).toEqual(before);
    expect(indexes()).toEqual(["manual_call_account_at", "manual_call_group", "manual_call_person_at"]);
    for (const app of ["whatsapp", "signal", "discord"]) insert(3, ada, null, app, "");
    expect(() => insert(3, ada, null, "skype", "")).toThrow(/CHECK/);
    db.close();
  });

  it("lets the viewer's reads into the trail of content reads, keeping every read as it was (migration 59)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 58 });
    const insert = (surface: string) => db
      .prepare(`INSERT INTO content_read (at, last_at, surface, reader, what, scope_json, why) VALUES (1000, 2000, ?, 'claude-code', 'timeline', '{"person":1}', 'a summary')`)
      .run(surface);
    insert("cli");
    insert("app");
    expect(() => insert("viewer")).toThrow(/CHECK/);
    const rows = () => db.prepare("SELECT * FROM content_read ORDER BY id").all().map((row) => ({ ...row }));
    const before = rows();
    db.close();

    db = openArchive(file, { version: 59 });
    expect(rows()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name = 'content_read' ORDER BY name").all().map((row) => row.name)).toEqual(["content_read", "content_read_last_at"]);
    insert("viewer");
    expect(() => insert("phone")).toThrow(/CHECK/);
    db.close();
  });

  it("gives logged calls unnamed others, none for every one so far nor for the change log's rows of them, so undo still works, and leaves catch-ups by call as they are (migration 60)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 59 });
    const ada = Number(db.prepare("INSERT INTO person (name, name_source, created_at) VALUES ('Ada Sample', 'captain', 0)").run().lastInsertRowid);
    const call = Number(db.prepare("INSERT INTO manual_call (call_group, person_id, at, duration_seconds, app, created_at, note) VALUES (1, ?, 1000, 240, 'discord', 5, '')").run(ada).lastInsertRowid);
    const catchUp = Number(db.prepare("INSERT INTO catch_up (day, hours, by_call, note, others, created_at) VALUES ('2026-10-06', 1, 1, '', 2, 0)").run().lastInsertRowid);
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, 0, 'app', 'call add', '{}')").run();
    const logged = JSON.stringify({ id: call, call_group: 1, person_id: ada, account_id: null, at: 1000, duration_seconds: 240, app: "discord", note: "", created_at: 5 });
    db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (1, 'manual_call', ?, NULL, ?)").run(JSON.stringify([call]), logged);
    db.close();

    db = openArchive(file, { version: 60 });
    expect(db.prepare("SELECT others FROM manual_call WHERE id = ?").get(call)).toEqual({ others: 0 });
    expect(JSON.parse((db.prepare("SELECT after_json FROM change_row WHERE changeset_id = 1").get() as { after_json: string }).after_json)).toMatchObject({ others: 0 });
    // A catch-up by call waited for the captain to make it a call (repair by-call-catch-ups, in that release): no migration did.
    expect(db.prepare("SELECT by_call, others FROM catch_up WHERE id = ?").get(catchUp)).toEqual({ by_call: 1, others: 2 });
    expect(() => db.prepare("UPDATE manual_call SET others = -1 WHERE id = ?").run(call)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE manual_call SET others = 10001 WHERE id = ?").run(call)).toThrow(/CHECK/);
    changeLog(db, new People(db)).undo(1, { surface: "cli" });
    expect(db.prepare("SELECT count(*) AS n FROM manual_call").get()).toEqual({ n: 0 });
    db.close();
  });

  it("drops by call from catch-ups, refused while one is still by call; the change log keeps it, shown, and an undo never brings one back (migration 61)", () => {
    const file = join(dir, "archive.sqlite");
    let db = openArchive(file, { version: 60 });
    const ada = new People(db).create("Ada Example");
    const catchUp = db.prepare("INSERT INTO catch_up (id, day, time, hours, by_call, note, others, created_at, trip_last_day, trip_end_time, trip_private_from, trip_private_to) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)");
    catchUp.run(1, "2026-10-01", "19:30", 3, 0, "dinner", 2, null, null, null, null);
    catchUp.run(2, "2026-10-03", "18:00", 30, 0, "the coast", 0, "2026-10-05", "16:00", "00:00", "10:00");
    catchUp.run(3, "2026-10-06", null, 1, 1, "", 0, null, null, null, null);
    for (const id of [1, 2, 3]) db.prepare("INSERT INTO catch_up_person VALUES (?, ?)").run(id, ada);
    // A changeset that changed the first, and one that made a ninth, by call, a call (as repair by-call-catch-ups did),
    // with its summary as it was written then.
    const summary = JSON.stringify({ people: [{ id: ada, name: "Ada Example", changes: [{ what: "hangout", before: "1 hour by call, 1 Oct 2026, 7:30 pm", after: "" }] }], other: [] });
    db.prepare("INSERT INTO changeset (id, at, surface, action, summary_json) VALUES (1, ?, 'cli', 'catch-up change', '{}'), (2, ?, 'cli', 'repair by-call-catch-ups', ?)").run(Date.now(), Date.now(), summary);
    const log = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, ?, ?, ?, ?)");
    const row = (id: number, hours: number, byCall: 0 | 1, note: string) =>
      JSON.stringify({ id, day: "2026-10-01", time: "19:30", hours, by_call: byCall, note, others: 2, created_at: 0, trip_last_day: null, trip_end_time: null, trip_private_from: null, trip_private_to: null });
    log.run(1, "catch_up", "[1]", row(1, 2, 0, "dinner"), row(1, 3, 0, "dinner"));
    log.run(2, "catch_up", "[9]", row(9, 1, 1, ""), null);
    log.run(2, "catch_up_person", JSON.stringify([9, ada]), JSON.stringify({ catch_up_id: 9, person_id: ada }), null);
    db.close();

    // Refused while one is by call, naming what makes it a call; the archive is left as it was.
    expect(() => openArchive(file)).toThrow(/1 catch-up is still by call, and a catch-up is in person now: .*commit 499570f: npm run archive -- repair by-call-catch-ups --apply/);
    expect(schemaVersionOf(file)).toBe(60);
    db = openArchive(file, { version: 60 });
    db.prepare("DELETE FROM catch_up WHERE id = 3").run();
    db.close();

    db = openArchive(file, { version: 61 });
    const people = new People(db);
    expect(db.prepare("SELECT name FROM pragma_table_info('catch_up')").all().map((r) => r.name)).not.toContain("by_call");
    expect(people.catchUps.list().map(({ id, day, time, trip, hours, note, others, people }) => ({ id, day, time, trip, hours, note, others, people: people.length }))).toEqual([
      { id: 2, day: "2026-10-03", time: "18:00", trip: { lastDay: "2026-10-05", endTime: "16:00", privateFrom: "00:00", privateTo: "10:00" }, hours: 30, note: "the coast", others: 0, people: 1 },
      { id: 1, day: "2026-10-01", time: "19:30", trip: null, hours: 3, note: "dinner", others: 2, people: 1 },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name = 'catch_up' AND type = 'index'").all().map((r) => r.name)).toEqual(["catch_up_day"]);
    // Its checks are as they were, but for by call: a trip needs the time it began.
    expect(() => db.prepare("UPDATE catch_up SET time = NULL WHERE id = 2").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE catch_up SET hours = 0 WHERE id = 1").run()).toThrow(/CHECK/);
    // A catch-up still holds its people: deleting it takes them with it.
    db.exec("PRAGMA foreign_keys = ON");
    people.deleteCatchUp(2);
    expect(db.prepare("SELECT count(*) AS n FROM catch_up_person WHERE catch_up_id = 2").get()).toEqual({ n: 0 });

    // The change log is as it was logged: the first undoes; the second still says by call, and is refused.
    const changes = changeLog(db, people);
    expect(JSON.stringify(changes.show(2))).toContain("1 hour by call, 1 Oct 2026, 7:30 pm");
    changes.undo(1, { surface: "cli" });
    expect(people.catchUps.get(1).hours).toBe(2);
    expect(() => changes.undo(2, { surface: "cli" })).toThrow(/can't undo #2: it would bring back a hangout by call: hangout #9/);
    expect(() => people.catchUps.get(9)).toThrow(/no hangout #9/);
    db.close();
  });
});

function tagCounts(db: Db, sql: string): Record<string, number> {
  return Object.fromEntries((db.prepare(sql).all() as { name: string; n: number }[]).map((row) => [row.name, row.n]));
}

describe("moving person files into the person table (migration 5)", () => {
  /** An archive as the code before the person table left it (schema 4), with some person files beside it. */
  async function oldArchive() {
    const file = join(dir, "archive.sqlite");
    const db = openArchive(file, { version: 4 });
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 1000, 'ok')").run().lastInsertRowid);
    const account = (platform: string, key: string, name: string, extra: { handle?: string; isSelf?: boolean } = {}) =>
      Number(db.prepare("INSERT INTO account (platform, key, key_kind, display_name, handle, is_self) VALUES (?, ?, ?, ?, ?, ?)")
        .run(platform, key, platform === "messenger" ? "name" : "id", name, extra.handle ?? null, extra.isSelf ? 1 : 0).lastInsertRowid);
    const person = (id: number, name: string, fields: { file?: string; seed?: number; self?: boolean; into?: number; tags?: string[] } = {}) =>
      db.prepare("INSERT INTO person (id, display_name, file_id, tags_json, seed_account_id, is_self, merged_into, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 5)")
        .run(id, name, fields.file ?? null, JSON.stringify(fields.tags ?? []), fields.seed ?? null, fields.self ? 1 : 0, fields.into ?? null);
    let n = 0;
    /** A one-to-one chat where both wrote, so the archive rules leave them on the map. */
    const chat = (me: number, them: number, platform: string) => {
      const c = Number(db.prepare("INSERT INTO conversation (platform, platform_conversation_id, type) VALUES (?, ?, 'direct')").run(platform, `c${n}`).lastInsertRowid);
      db.prepare("INSERT INTO conversation_member VALUES (?, ?), (?, ?)").run(c, me, c, them);
      for (const [sender, self] of [[them, 0], [me, 1]]) {
        db.prepare(
          `INSERT INTO message (platform, conversation_id, platform_message_id, id_kind, sender_account_id, is_from_self, sent_at, type, text, first_source_id, last_source_id, raw_json)
           VALUES (?, ?, ?, 'platform', ?, ?, ?, 'text', 'hi', ?, ?, '{}')`,
        ).run(platform, c, `m${n++}`, sender, self, 1_700_000_000_000 + n, source, source);
      }
    };
    const me = account("messenger", "Me", "Me", { isSelf: true });
    const meWa = account("whatsapp", "me", "Me", { isSelf: true });
    const a = {
      ada: account("messenger", "Ada", "Ada"),
      kitM: account("messenger", "Kit Ng", "Kit Ng"),
      kitW: account("whatsapp", "61491571266@s.whatsapp.net", "Kit Ng", { handle: "+61491571266" }),
      kitI: account("imessage", "+61491573770", "Kit Ng", { handle: "+61491573770" }),
      riley: account("messenger", "Riley Old", "Riley Old"),
      samM: account("messenger", "Sam Smith", "Sam Smith"),
      samW: account("whatsapp", "61491571491@s.whatsapp.net", "Sam Smith", { handle: "+61491571491" }),
      wa: account("whatsapp", "61491574118@s.whatsapp.net", "Wally", { handle: "+61491574118" }),
      patM: account("messenger", "Pat Doe", "Pat Doe"),
      patW: account("whatsapp", "61491571804@s.whatsapp.net", "Pat Doe", { handle: "+61491571804" }),
      mia: account("messenger", "Mia Wong", "Mia Wong"),
    };
    for (const [key, id] of Object.entries(a)) chat(key.endsWith("W") || key === "wa" ? meWa : me, id, key.endsWith("W") || key === "wa" ? "whatsapp" : key.endsWith("I") ? "imessage" : "messenger");
    // People as the old code made them: the base self folded into the file tagged me, file people, and one seed person per account.
    person(10, "Ada Lovelace", { file: "ada", tags: ["climbing"] });
    person(11, "Kit Ng", { file: "kit" });
    person(12, "old-me", { file: "old-me", self: true, tags: ["me"] });
    person(13, "Wally W", { file: "wa" });
    person(14, "Mia Wong", { file: "mia" });
    person(1, "Me", { self: true, into: 12 });
    const seeds: Record<string, number> = {};
    let id = 20;
    for (const [key, account] of Object.entries(a)) {
      // Kit's file said his iMessage account is not him, so his other two were joined without it.
      const into = { ada: 10, kitW: 0, riley: 12, samW: 0, wa: 13, mia: 14 }[key];
      seeds[key] = id;
      person(id++, key, { seed: account, into: into === 0 ? seeds[`${key.slice(0, -1)}M`] : into });
    }
    // Kit's iMessage account was taken off his file with "Not them"; Pat's two accounts are different people.
    const reject = db.prepare(
      "INSERT INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at, decided_at) VALUES (?, ?, ?, 'low', '{}', ?, 0, 0)",
    );
    reject.run("account:imessage:+61491573770", "file:kit", "detached", "rejected");
    reject.run("account:messenger:Pat Doe", "account:whatsapp:61491571804@s.whatsapp.net", "name-exact", "rejected");
    reject.run("account:messenger:Ada", "file:wa", "name-contained", "pending");
    db.close();

    await mkdir(join(dir, "friends"));
    await mkdir(join(dir, "people"));
    const files: Record<string, string> = {
      "friends/ada.md": "---\nid: ada\nname: Ada Lovelace\naliases:\n  - Addy\nidentity: \"\"\ntags:\n  - climbing\naccounts:\n  - platform: messenger\n    name: Ada\n---\n\n## 2026-09-12\n\nDinner.\n",
      "people/kit.md": "---\nid: kit\nname: Kit Ng\n---\n",
      "people/old-me.md": "---\nid: old-me\ntags: [me]\naccounts:\n  - platform: messenger\n    name: Riley Old\n---\n",
      "people/wa.md": "---\nid: wa\nname: Wally W\ntags: [keep]\naccounts:\n  - platform: whatsapp\n    handle: \"0491 574 118\"\n---\n",
      "people/broken.md": "no frontmatter here\n",
      "people/new-person.md": "---\nid: new-person\nname: Nova New\naliases: [Nov]\n---\n",
      "people/mia.md": "---\nid: mia\nname: Mia Wong\n---\n",
    };
    for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text);
    return { file, a, seeds, files };
  }

  function open(file: string): { db: Db; people: People; structure: ArchiveStructure } {
    const db = openArchive(file, { dataDir: dir });
    const people = new People(db);
    return { db, people, structure: new ArchiveStructure(db, people) };
  }

  it("moves every file's name, aliases, tags and account links into the table, keeps every decision, and leaves the files alone", async () => {
    const { file, a, seeds, files } = await oldArchive();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, people, structure } = open(file);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Moving person files into the archive: people\/broken\.md: /));
    warn.mockRestore();
    // The rules have not run yet: they run on the first open, as Archive.open does.
    expect(people.rulesAreCurrent()).toBe(false);
    people.runRules();
    expect(people.rulesAreCurrent()).toBe(true);

    const everyone = structure.listPeople();
    const byId = new Map(everyone.people.map((p) => [p.id, p]));
    const accounts = (id: number) => byId.get(id)!.accounts.map((x) => [x.id, x.link]).sort();

    // Each file keeps its person, with its name, aliases and tags, edited by the captain; its accounts are the captain's links.
    // (Its first alias is its name since migration 42, as it was its label.)
    expect(byId.get(10)).toMatchObject({ name: "Addy", aliases: ["Ada Lovelace"], tags: ["climbing"], edited: true, archived: null });
    expect(accounts(10)).toEqual([[a.ada, "captain"]]);
    expect(byId.get(13)).toMatchObject({ name: "Wally W", tags: ["keep"], edited: true });
    expect(accounts(13)).toEqual([[a.wa, "captain"]]);
    // A file new since the archive last read the files gets a person too.
    expect(everyone.people.find((p) => p.name === "Nov")).toMatchObject({ aliases: ["Nova New"], edited: true, accounts: [] });

    // Joins by name are made again by the rules: a file's person is kept, and gains the account of exactly its name.
    expect(accounts(14)).toEqual([[a.mia, "rule:same-name"]]);
    // A join with no file keeps the oldest person.
    expect(accounts(seeds.samM)).toEqual([[a.samM, "import"], [a.samW, "rule:same-name"]]);
    expect(byId.has(seeds.samW)).toBe(false);
    // "Not them" between Kit's file and his iMessage account still holds, once the file is a person: neither
    // is joined, even through a third, and his other two accounts are joined without them, as before.
    expect(byId.get(11)).toMatchObject({ name: "Kit Ng", edited: true, accounts: [] });
    expect(accounts(seeds.kitI)).toEqual([[a.kitI, "import"]]);
    expect(accounts(seeds.kitM)).toEqual([[a.kitM, "import"], [a.kitW, "rule:same-name"]]);
    // People the captain said are different stay different.
    expect(everyone.people.filter((p) => p.name === "Pat Doe")).toHaveLength(2);

    // The file tagged "me" gives its accounts to the captain, whose person is the one it always was.
    expect(everyone.me).toMatchObject({ id: 1 });
    expect(everyone.me!.accounts.map((x) => [x.displayName, x.link]).sort()).toEqual([["Me", "import"], ["Me", "import"], ["Riley Old", "captain"]]);
    expect(byId.has(12)).toBe(false);

    // No person file is named any more: rejections name people, and pending proposals are made again by the rules.
    expect(db.prepare("SELECT count(*) AS n FROM merge_proposal WHERE left_key LIKE 'file:%' OR right_key LIKE 'file:%'").get()).toEqual({ n: 0 });
    const keys = db.prepare("SELECT left_key, right_key, status FROM merge_proposal WHERE status = 'rejected' ORDER BY id").all().map((r) => ({ ...r }));
    expect(keys).toEqual([
      { left_key: "account:imessage:+61491573770", right_key: "person:11", status: "rejected" },
      { left_key: "account:messenger:Pat Doe", right_key: "account:whatsapp:61491571804@s.whatsapp.net", status: "rejected" },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM import_person WHERE first_seen_at = 1000 AND last_seen_at = 1000").get()).toEqual({ n: 13 });
    expect(getMeta(db, "rules_version")).not.toBe("0");
    db.close();

    // The files are exactly as they were.
    for (const [path, text] of Object.entries(files)) expect(await readFile(join(dir, path), "utf8")).toBe(text);
  });

  it("does nothing more on later opens: people and links load as stored", async () => {
    const { file } = await oldArchive();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let opened = open(file);
    warn.mockRestore();
    opened.people.runRules();
    const before = JSON.stringify(opened.structure.listPeople());
    opened.db.close();
    // Even with the files changed or gone, nothing is read from them again.
    await rm(join(dir, "friends"), { recursive: true });
    await rm(join(dir, "people"), { recursive: true });
    opened = open(file);
    expect(opened.people.rulesAreCurrent()).toBe(true);
    expect(JSON.stringify(opened.structure.listPeople())).toBe(before);
    opened.db.close();
  });
});
