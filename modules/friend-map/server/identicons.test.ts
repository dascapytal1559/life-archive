// Every person's identicon seed (src/identicon.ts): given when they are made,
// by an import, by hand, as the captain or by "Not them"; kept through a merge;
// set by setIdenticon, logged and undone as any edit; given again by the
// rules to a row made without one; and given to everyone there was by migration 20.

import { changeLog } from "./changeLog.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, Changes, type Db, identiconSeedOf, isIdenticonSeed, transaction } from "../../../sdk/server.ts";
import { openArchive, SCHEMA_VERSION } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-identicons-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Each name says one thing to the captain in a chat of their own, and the captain answers; then the rules run. */
function importPeople(names: string[]): void {
  const events: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true }];
  names.forEach((name, i) => {
    events.push({ kind: "account", key: name, keyKind: "name", displayName: name });
    events.push({ kind: "conversation", id: `direct-${name}`, type: "direct", title: name, members: ["Me", name] });
    for (const [sender, at] of [[name, 0], ["Me", 500]] as const) {
      events.push({
        kind: "message", id: `${name}-${sender}`, idKind: "platform", conversation: `direct-${name}`, sender,
        isFromSelf: sender === "Me", sentAt: 1_700_000_000_000 + i * 1000 + at, type: "text", text: "hi", raw: {},
      });
    }
  });
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(db, "messenger", source, "export");
    for (const event of events) session.apply(event);
  });
  people.runRules();
}

function id(name: string): number {
  const person = structure.listPeople().people.find((p) => p.name === name);
  if (!person) throw new Error(`nobody named ${name}`);
  return person.id;
}

/** The identicon hue stored on a person's row. */
function hue(personId: number): number | null {
  return (db.prepare("SELECT identicon_hue FROM person WHERE id = ?").get(personId) as { identicon_hue: number | null }).identicon_hue;
}

/** The seed stored on a person's row, and the one People gives a person made with that id at that time. */
function stored(personId: number): { seed: string | null; given: string } {
  const row = db.prepare("SELECT identicon_seed, created_at FROM person WHERE id = ?").get(personId) as { identicon_seed: string | null; created_at: number };
  return { seed: row.identicon_seed, given: identiconSeedOf(personId, row.created_at) };
}

describe("a person's identicon seed", () => {
  it("is given to everyone an import makes, and the captain, from their id and when they were made", () => {
    importPeople(["Ada Lovelace", "Bea Arthur", "Cy Twombly"]);
    const everyone = db.prepare("SELECT id FROM person").all() as { id: number }[];
    expect(everyone.length).toBe(4);
    for (const { id: personId } of everyone) {
      const { seed, given } = stored(personId);
      expect(seed).toBe(given);
    }
    expect(new Set(everyone.map(({ id: personId }) => stored(personId).seed)).size).toBe(4);
    // And the page is told it, in each of the shapes it reads people in.
    const ada = id("Ada Lovelace");
    const seed = stored(ada).seed;
    expect(structure.getPerson(ada)!.identiconSeed).toBe(seed);
    expect(structure.tableRows().find((p) => p.id === ada)!.identiconSeed).toBe(seed);
    expect(structure.relationships().people.find((p) => p.id === ada)!.identiconSeed).toBe(seed);
  });

  it("is given to someone added by hand", () => {
    const ada = people.create("Ada Hand");
    expect(isIdenticonSeed(stored(ada).seed)).toBe(true);
    expect(stored(ada).seed).toBe(stored(ada).given);
  });

  it("stays the kept person's through a merge, and is a fresh one for whoever Not them takes out", () => {
    importPeople(["Ada Lovelace", "Ada L"]);
    const [ada, other] = [id("Ada Lovelace"), id("Ada L")];
    const kept = stored(ada).seed;
    people.merge(ada, other);
    expect(stored(ada).seed).toBe(kept);

    const account = structure.getPerson(ada)!.accounts.find((a) => a.displayName === "Ada L")!.id;
    const fresh = people.detach(ada, account);
    expect(stored(ada).seed).toBe(kept);
    expect(stored(fresh).seed).toBe(stored(fresh).given);
    expect(stored(fresh).seed).not.toBe(kept);
  });

  it("is set by setIdenticon, logged and undone like any edit, and must be 16 hex digits", () => {
    importPeople(["Ada Lovelace"]);
    const ada = id("Ada Lovelace");
    const before = stored(ada).seed!;
    expect(() => people.setIdenticon(ada, "not a seed")).toThrow("16 hex digits");
    expect(() => people.setIdenticon(ada, before.toUpperCase().replace(/[0-9]/, "F"))).toThrow("16 hex digits");

    const changes = changeLog(db, people);
    const changeset = changes.record({ surface: "app", action: "identicon" }, () => people.setIdenticon(ada, "0123456789abcdef")).changeset!;
    expect(stored(ada).seed).toBe("0123456789abcdef");
    expect(structure.getPerson(ada)!.edited).toBe(true);
    expect(changes.show(changeset).people[0].changes).toEqual([{ what: "identicon", before, after: "0123456789abcdef" }]);

    changes.undo(changeset, { surface: "app" });
    expect(stored(ada).seed).toBe(before);
  });

  it("is given by the rules to a row made without one, or with one that is not a seed", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    db.prepare("UPDATE person SET identicon_seed = NULL WHERE id = ?").run(ada);
    db.prepare("UPDATE person SET identicon_seed = 'ABCDEF0123456789' WHERE id = ?").run(bea);
    // Meanwhile the page is told the seed the person would have.
    expect(structure.getPerson(ada)!.identiconSeed).toBe(stored(ada).given);
    people.runRules();
    expect(stored(ada).seed).toBe(stored(ada).given);
    expect(stored(bea).seed).toBe(stored(bea).given);
  });
});

describe("a person's picked identicon colour", () => {
  it("is none until picked, and the page is told it in each shape it reads people in", () => {
    importPeople(["Ada Lovelace"]);
    const ada = id("Ada Lovelace");
    expect(hue(ada)).toBeNull();
    expect(structure.getPerson(ada)!.identiconHue).toBeNull();
    people.setIdenticon(ada, stored(ada).seed!, 200);
    expect(structure.getPerson(ada)!.identiconHue).toBe(200);
    expect(structure.tableRows().find((p) => p.id === ada)!.identiconHue).toBe(200);
    expect(structure.relationships().people.find((p) => p.id === ada)!.identiconHue).toBe(200);
  });

  it("is set with a new picture as one change that undo takes back, seed and colour", () => {
    importPeople(["Ada Lovelace"]);
    const ada = id("Ada Lovelace");
    const seed = stored(ada).seed!;
    const changes = changeLog(db, people);

    const picked = changes.record({ surface: "app", action: "person identicon" }, () => people.setIdenticon(ada, "0123456789abcdef", 200)).changeset!;
    expect([stored(ada).seed, hue(ada)]).toEqual(["0123456789abcdef", 200]);
    expect(changes.show(picked).people[0].changes).toEqual([
      { what: "identicon", before: seed, after: "0123456789abcdef" },
      { what: "identicon colour", before: "", after: "200" },
    ]);

    // A new picture in the colour they have.
    const again = changes.record({ surface: "app", action: "person identicon" }, () => people.setIdenticon(ada, "fedcba9876543210", 200)).changeset!;
    expect([stored(ada).seed, hue(ada)]).toEqual(["fedcba9876543210", 200]);

    // Undone newest first: the picture before, then their own colour and seed.
    changes.undo(again, { surface: "app" });
    expect([stored(ada).seed, hue(ada)]).toEqual(["0123456789abcdef", 200]);
    changes.undo(picked, { surface: "app" });
    expect([stored(ada).seed, hue(ada)]).toEqual([seed, null]);
  });

  it("is whole degrees 0 to 359, and setIdenticon without one keeps the one they have", () => {
    importPeople(["Ada Lovelace"]);
    const ada = id("Ada Lovelace");
    for (const bad of [-1, 360, 12.5, "15"]) expect(() => people.setIdenticon(ada, stored(ada).seed!, bad)).toThrow("whole degrees");
    people.setIdenticon(ada, "0123456789abcdef", 30);
    people.setIdenticon(ada, "fedcba9876543210");
    expect([stored(ada).seed, hue(ada)]).toEqual(["fedcba9876543210", 30]);
    people.setIdenticon(ada, "fedcba9876543210", null);
    expect(hue(ada)).toBeNull();
    expect(() => db.prepare("UPDATE person SET identicon_hue = 360 WHERE id = ?").run(ada)).toThrow();
  });
});

describe("migration 20", () => {
  it("gives everyone there was the seed People gives, the same each time it runs", () => {
    /** An archive from before the migration (which has the captain already), with three others, brought up to date. */
    const migrate = (file: string) => {
      const older = openArchive(file, { version: 19 });
      const insert = older.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'import', ?)");
      for (const [i, name] of ["Ada", "Bea", "Cy"].entries()) insert.run(name, 1_690_000_000_000 + i * 61_000);
      older.close();
      const migrated = openArchive(file);
      const rows = migrated.prepare("SELECT id, created_at, identicon_seed FROM person ORDER BY id").all() as { id: number; created_at: number; identicon_seed: string }[];
      migrated.close();
      return rows.map((row) => ({ ...row }));
    };
    const first = migrate(join(dataDir, "one.sqlite"));
    expect(first.length).toBeGreaterThanOrEqual(3);
    // The migration's own copy of the hash gives what People gives.
    for (const row of first) expect(row.identicon_seed).toBe(identiconSeedOf(row.id, row.created_at));
    expect(new Set(first.map((row) => row.identicon_seed)).size).toBe(first.length);
    // The same rows again (the captain's own is made as an older migration runs, so when it is made differs): the same seeds.
    const others = (rows: typeof first) => rows.filter((row) => row.created_at < 1_700_000_000_000);
    expect(others(first)).toHaveLength(3);
    expect(others(migrate(join(dataDir, "two.sqlite")))).toEqual(others(first));
  });
});
