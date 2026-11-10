import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreDataTime, MAC_ACCOUNT, writeMacContactsFixture, writeMacStore } from "../fixtures/macContacts.ts";
import { writeAddressBookFixture } from "../fixtures/whatsapp.ts";
import { importAddressBook, openAddressBook, type AddressBook } from "./addressBook.ts";

let dir: string;
let work: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "address-book-"));
  work = join(dir, "work");
  await mkdir(work);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What a book says about each of the fixtures' numbers and emails, and what each card adds to a note, by name. */
function said(book: AddressBook) {
  const numbers = ["61491571266", "61491571491", "61491571804", "61491570737", "61370100000", "447700900008", "12025550109", "61491574118", "9999400000002"];
  const emails = ["ADA@example.com", "riley@example.com", "nobody@example.com"];
  return {
    numbers: Object.fromEntries(numbers.map((n) => [n, book.lookup(n)])),
    emails: Object.fromEntries(emails.map((e) => [e, book.lookupEmail(e)])),
    cards: [...book.cards.values()].filter((card) => !book.ownCards.has(card.rowid))
      .map(({ rowid: _, ...card }) => card)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    own: [...book.ownCards].map((id) => book.cards.get(id)?.organization),
  };
}

describe("the Mac's Contacts", () => {
  it("read as the iPhone's book with the same cards reads: names, the captain's own card, companies and notes", async () => {
    const iphone = join(dir, "AddressBook.sqlitedb");
    writeAddressBookFixture(iphone);
    const mac = join(dir, "AddressBook");
    writeMacContactsFixture(mac);

    const fromMac = (await openAddressBook(mac, work))!;
    const fromIphone = (await openAddressBook(iphone, work))!;
    expect(said(fromMac)).toEqual(said(fromIphone));
    // What both say, in particular.
    expect(fromMac.lookup("61491571266")).toEqual({ name: "Ada Sample", self: false });
    expect(fromMac.lookup("61370100000")).toEqual({ name: "Plumbing Co", self: false });
    expect(fromMac.lookup("61491570737")).toEqual({ name: "Riley Captain", self: true });
    expect(fromMac.lookupEmail("ADA@example.com")).toEqual({ name: "Ada Sample", self: false });
    // The group is no card: ten cards, as the iPhone's book has.
    expect(fromMac.cards.size).toBe(10);
  });

  it("names someone from the card changed last, whichever account it is in", async () => {
    const mac = join(dir, "AddressBook");
    writeMacContactsFixture(mac);
    // The old account's card for Ada is edited today, so it is now the newest.
    writeMacStore(join(mac, "Sources", "0A1B2C3D-0000-4000-8000-000000000003", "AddressBook-v22.abcddb"), [
      { pk: 1, first: "Ada", last: "Example", phones: ["+61491571266"], changed: coreDataTime("2026-10-21T09:00:00Z") },
    ]);
    const book = (await openAddressBook(mac, work))!;
    expect(book.lookup("61491571266")).toEqual({ name: "Ada Example", self: false });
    expect(book.contactsWith("+61491571266")).toHaveLength(3);
  });

  it("reads one store alone, and knows the captain's card by its container too", async () => {
    const store = join(dir, "AddressBook-v22.abcddb");
    writeMacStore(store, [
      { pk: 7, first: "Riley", last: "Captain", phones: ["+61491570737"], changed: 0, me: "container" },
      { pk: 8, first: "Bruno", last: "Placeholder", phones: ["+61491571491"], changed: 0 },
    ]);
    const book = (await openAddressBook(store, work))!;
    expect(book.lookup("61491570737")).toEqual({ name: "Riley Captain", self: true });
    expect(book.lookup("61491571491")).toEqual({ name: "Bruno Placeholder", self: false });
    expect(book.ownCards.size).toBe(1);
  });

  it("reads the copy mac-imports takes, a folder of its stores alone", async () => {
    const mac = join(dir, "AddressBook");
    writeMacContactsFixture(mac);
    // The account's store alone, without the Mac's own.
    const copy = join(dir, "copy");
    writeMacStore(join(copy, "Sources", MAC_ACCOUNT, "AddressBook-v22.abcddb"), [
      { pk: 1, first: "Cleo", last: "Example", phones: ["+61491571804"], changed: 0 },
    ]);
    expect((await openAddressBook(copy, work))!.lookup("61491571804")).toEqual({ name: "Cleo Example", self: false });
  });
});

describe("openAddressBook", () => {
  it("is null for nothing there, and refuses a folder with no book, a file that is none, and a store it does not know", async () => {
    expect(await openAddressBook(join(dir, "missing"), work)).toBeNull();
    await mkdir(join(dir, "empty"));
    await expect(openAddressBook(join(dir, "empty"), work)).rejects.toThrow(/holds no AddressBook\.sqlitedb or AddressBook-v22\.abcddb/);
    await writeFile(join(dir, "notes.sqlite"), "");
    await expect(openAddressBook(join(dir, "notes.sqlite"), work)).rejects.toThrow(/is it the iPhone's AddressBook\.sqlitedb or the Mac's AddressBook-v22\.abcddb\?/);
    const store = join(dir, "broken", "AddressBook-v22.abcddb");
    writeMacStore(store, []);
    const db = new DatabaseSync(store);
    db.exec("ALTER TABLE ZABCDPHONENUMBER DROP COLUMN ZFULLNUMBER");
    db.close();
    await expect(openAddressBook(store, work)).rejects.toThrow(/the Mac's address book has no ZABCDPHONENUMBER\.ZFULLNUMBER/);
  });

  it("reads an import's book from its setting, which must be there, else the iPhone's in the folder", async () => {
    const folder = join(dir, "export");
    await mkdir(folder);
    expect(await importAddressBook(undefined, folder, work)).toBeNull();
    writeAddressBookFixture(join(folder, "AddressBook.sqlitedb"));
    expect((await importAddressBook("", folder, work))!.lookup("61491571491").name).toBe("Bruno Placeholder");
    const mac = join(dir, "AddressBook");
    writeMacContactsFixture(mac);
    expect((await importAddressBook(mac, folder, work))!.cards.size).toBe(10);
    await expect(importAddressBook(join(dir, "missing"), folder, work)).rejects.toThrow(/the address book .*missing is not there/);
  });
});
