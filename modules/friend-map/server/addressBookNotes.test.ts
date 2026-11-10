import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type Db, transaction } from "../../../sdk/server.ts";
import { AddressBook, readIphoneContacts } from "../connectors/addressBook.ts";
import { writeAddressBookFixture } from "../fixtures/whatsapp.ts";
import { contactNote, fillNotesFromAddressBook } from "./addressBookNotes.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { combineNotes, normalizeNote } from "./personFields.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dir: string;
let book: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-contact-notes-"));
  book = join(dir, "AddressBook.sqlitedb");
  writeAddressBookFixture(book);
  db = openArchive(join(dir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Accounts on a platform, each with a handle and a direct chat with the captain (so none is archived), then the rules. */
function importAccounts(platform: string, accounts: Array<{ key: string; name: string; handle?: string }>): void {
  const events: ArchiveEvent[] = [{ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true, handle: "+61491570737" }];
  accounts.forEach(({ key, name, handle }, i) => {
    events.push({ kind: "account", key, keyKind: "id", displayName: name, ...(handle ? { handle } : {}) });
    events.push({ kind: "conversation", id: `chat-${key}`, type: "direct", title: name, members: ["me", key] });
    for (const [sender, offset] of [[key, 0], ["me", 500]] as const) {
      events.push({
        kind: "message", id: `${platform}-${key}-${sender}`, idKind: "platform", conversation: `chat-${key}`, sender,
        isFromSelf: sender === "me", sentAt: 1_700_000_000_000 + i * 1000 + offset, type: "text", text: "hello", raw: {},
      });
    }
  });
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'app-db', 'test', 0, 'ok')")
      .run(platform).lastInsertRowid);
    const session = new ImportSession(db, platform, source, "app-db");
    for (const event of events) session.apply(event);
  });
  people.runRules();
}

const ADA_NOTE = "Company: Sample Labs\nJob title: Engineer\nMet at the climbing gym.\nVegetarian.";

/** The fixture's people: WhatsApp by number, and Ada's email on iMessage under a name that joins nobody. */
function importFixturePeople(): void {
  importAccounts("whatsapp", [
    { key: "61491571266@s.whatsapp.net", name: "Ada Sample", handle: "+61491571266" },
    { key: "61491571491@s.whatsapp.net", name: "Bruno Placeholder", handle: "+61491571491" },
    { key: "61491571804@s.whatsapp.net", name: "Cleo M. Example", handle: "+61491571804" },
    { key: "447700900008@s.whatsapp.net", name: "Dana Example", handle: "+447700900008" },
    { key: "61370100000@s.whatsapp.net", name: "Plumbing Co", handle: "+61370100000" },
  ]);
  importAccounts("imessage", [{ key: "ada@example.com", name: "ada@example.com", handle: "ada@example.com" }]);
}

const personWith = (platform: string, key: string) => {
  const { person_id: id } = db.prepare("SELECT person_id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as { person_id: number };
  return structure.getPerson(id)!;
};
const ada = () => personWith("whatsapp", "61491571266@s.whatsapp.net");
const adaByEmail = () => personWith("imessage", "ada@example.com");
const bruno = () => personWith("whatsapp", "61491571491@s.whatsapp.net");
const dana = () => personWith("whatsapp", "447700900008@s.whatsapp.net");

describe("notes from the address book", () => {
  it("writes each card's company, department, job title and note on the people its numbers and emails belong to", async () => {
    importFixturePeople();
    const report = await fillNotesFromAddressBook(db, people, book);
    // Ten cards, the captain's own left out; Plumbing Co's organization is its name, so it counts as a note only.
    expect(report).toEqual({
      contacts: 9, withCompany: 2, withNote: 3, withEither: 4, matched: 4, matchedSeveral: 1, people: 5,
      written: 5, unchanged: 0, keptCaptains: 0,
    });
    expect(ada()).toMatchObject({ note: ADA_NOTE, noteFromContacts: true, edited: false });
    // The same card through its email; a second card with Ada's number and nothing more adds nothing.
    expect(adaByEmail().note).toBe(ADA_NOTE);
    expect(bruno().note).toBe("Lent me a tent");
    expect(dana().note).toBe("Department: Research");
    expect(personWith("whatsapp", "61370100000@s.whatsapp.net").note).toBe("Fixed the hot water");
    expect(personWith("whatsapp", "61491571804@s.whatsapp.net").note).toBe("");
    // The captain's own card writes nothing on the captain.
    expect(structure.listPeople().me?.note).toBe("");
    // The People search finds people by their note.
    expect(structure.listPeople({ query: "climbing gym" }).people.map((p) => p.id).sort()).toEqual([ada().id, adaByEmail().id].sort());
  });

  it("writes again only notes still as it left them, never one the captain has changed", async () => {
    importFixturePeople();
    await fillNotesFromAddressBook(db, people, book);
    expect(await fillNotesFromAddressBook(db, people, book)).toMatchObject({ written: 0, unchanged: 5, keptCaptains: 0 });

    people.setNote(bruno().id, "Lent me a tent; gave it back");
    people.setNote(dana().id, "");
    expect(bruno()).toMatchObject({ noteFromContacts: false, edited: true });
    const card = new DatabaseSync(book);
    card.prepare("UPDATE ABPerson SET Note = 'Met at the climbing gym.' WHERE ROWID = 1").run();
    card.prepare("UPDATE ABPerson SET Note = 'Tent lender' WHERE ROWID = 2").run();
    card.close();

    // Ada's changed card rewrites both her notes, Dana's cleared note is filled again, Bruno's stays his.
    expect(await fillNotesFromAddressBook(db, people, book)).toMatchObject({ written: 3, unchanged: 1, keptCaptains: 1 });
    expect(ada().note).toBe("Company: Sample Labs\nJob title: Engineer\nMet at the climbing gym.");
    expect(dana().note).toBe("Department: Research");
    expect(bruno().note).toBe("Lent me a tent; gave it back");
  });

  it("keeps a note once when a merge brings two together, and still the address book's", async () => {
    importFixturePeople();
    await fillNotesFromAddressBook(db, people, book);
    const kept = people.merge(ada().id, adaByEmail().id);
    expect(structure.getPerson(kept)).toMatchObject({ note: ADA_NOTE, noteFromContacts: true });

    // Merging in someone with a note of the captain's keeps both, and the note is the captain's from then on.
    people.setNote(bruno().id, "Tent");
    people.merge(kept, bruno().id);
    expect(structure.getPerson(kept)).toMatchObject({ note: `${ADA_NOTE}\n\nTent`, noteFromContacts: false });
    expect(await fillNotesFromAddressBook(db, people, book)).toMatchObject({ written: 0, keptCaptains: 1 });
    expect(structure.getPerson(kept)?.note).toBe(`${ADA_NOTE}\n\nTent`);
  });

  it("carries a note into the person the rules join someone into", async () => {
    importAccounts("messenger", [{ key: "bruno.fb", name: "Bruno Placeholder" }]);
    importAccounts("whatsapp", [{ key: "61491571491@s.whatsapp.net", name: "Tent Guy", handle: "+61491571491" }]);
    await fillNotesFromAddressBook(db, people, book);
    const older = personWith("messenger", "bruno.fb").id;
    expect(bruno()).toMatchObject({ note: "Lent me a tent" });
    expect(bruno().id).not.toBe(older);
    // WhatsApp now names him as Messenger does, so the rules join the two into the older person, note and all.
    importAccounts("whatsapp", [{ key: "61491571491@s.whatsapp.net", name: "Bruno Placeholder", handle: "+61491571491" }]);
    expect(bruno()).toMatchObject({ id: older, note: "Lent me a tent", noteFromContacts: true });
  });

  it("reads a book without department, job title or note columns as having none", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY, First TEXT, Last TEXT, Organization TEXT)");
    old.exec("CREATE TABLE ABMultiValue (UID INTEGER PRIMARY KEY, record_id INTEGER, property INTEGER, value TEXT)");
    old.exec("INSERT INTO ABPerson VALUES (1, 'Ada', 'Sample', 'Sample Labs')");
    const { cards } = new AddressBook(readIphoneContacts(old));
    expect(cards.get(1)).toEqual({ rowid: 1, isCompany: false, organization: "Sample Labs", department: "", jobTitle: "", note: "" });
    expect(contactNote(cards.get(1)!)).toBe("Company: Sample Labs");
    old.close();
  });

  it("refuses an address book that is not there", async () => {
    await expect(fillNotesFromAddressBook(db, people, join(dir, "missing.sqlitedb"))).rejects.toThrow(/is not there/);
  });
});

describe("notes", () => {
  it("are text, with Windows line ends made plain and space trimmed", () => {
    expect(normalizeNote("  one\r\ntwo\r\n ")).toBe("one\ntwo");
    expect(normalizeNote("")).toBe("");
    expect(() => normalizeNote(3)).toThrow(/text/);
    expect(() => normalizeNote("x".repeat(10_001))).toThrow(/at most/);
  });

  it("combine without repeating one the other holds", () => {
    expect(combineNotes("a", "")).toBe("a");
    expect(combineNotes("", "b")).toBe("b");
    expect(combineNotes("a\n\nb", "b")).toBe("a\n\nb");
    expect(combineNotes("b", "a\n\nb")).toBe("a\n\nb");
    expect(combineNotes("a", "b")).toBe("a\n\nb");
  });

  it("are set and cleared by the captain, which marks them edited, and go to the captain's person with This is me", () => {
    importFixturePeople();
    const id = bruno().id;
    expect(people.setNote(id, "  Owes me lunch ")).toBe(id);
    expect(structure.getPerson(id)).toMatchObject({ note: "Owes me lunch", noteFromContacts: false, edited: true });
    people.setNote(id, "");
    expect(structure.getPerson(id)?.note).toBe("");
    people.setNote(dana().id, "An old number of mine");
    people.markAsMe(dana().id);
    expect(structure.listPeople().me?.note).toBe("An old number of mine");
  });
});
