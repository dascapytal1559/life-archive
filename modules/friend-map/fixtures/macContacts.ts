// A made-up copy of the Mac's Contacts (see connectors/addressBook.ts) for tests: the folder
// ~/Library/Application Support/AddressBook keeps, with the Mac's own store and two accounts' stores under Sources/,
// holding the same cards as the iPhone's book from writeAddressBookFixture (fixtures/whatsapp.ts), so both read alike.
// Only the tables and columns the reader needs are made, with the real names, and a few it does not read.
//
//   AddressBook-v22.abcddb          the Mac's own cards: two companies
//   Sources/<account>/...           the account the phone syncs with: every other card, changed this year, a group,
//                                   and the info record whose ZME names the captain's own card
//   Sources/<old account>/...       an account no longer used: a second, older card with Ada's number

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One card of a store, by its Z_PK. */
export interface MacCard {
  pk: number;
  first?: string;
  middle?: string;
  last?: string;
  organization?: string;
  /** Shown as a company (ZDISPLAYFLAGS bit 1). */
  company?: boolean;
  department?: string;
  jobTitle?: string;
  note?: string;
  phones?: string[];
  emails?: string[];
  /** ZMODIFICATIONDATE, in Core Data's seconds since 2001. */
  changed: number;
  /** The captain's own card, as an info record's ZME names it, or by ZCONTAINERWHERECONTACTISME. */
  me?: "info" | "container";
}

/** Core Data's seconds since 2001 for a time. */
export const coreDataTime = (iso: string) => (Date.parse(iso) - Date.parse("2001-01-01T00:00:00Z")) / 1000;

const ENTITIES = [[17, "ABCDRecord", 0], [18, "ABCDAbstractGroup", 17], [19, "ABCDGroup", 18], [22, "ABCDContact", 17], [24, "ABCDInfo", 17], [25, "CNCDContainer", 17]] as const;
const ENTITY = { group: 19, contact: 22, info: 24, container: 25 };

/** Writes one Contacts store (an AddressBook-v22.abcddb) at `file` with these cards, and a group when asked. */
export function writeMacStore(file: string, cards: MacCard[], { group }: { group?: string } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDISPLAYFLAGS INTEGER,
        ZCONTAINERWHERECONTACTISME INTEGER, ZME INTEGER, ZMODIFICATIONDATE TIMESTAMP, ZDEPARTMENT VARCHAR, ZFIRSTNAME VARCHAR,
        ZJOBTITLE VARCHAR, ZLASTNAME VARCHAR, ZMIDDLENAME VARCHAR, ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR, ZNAME VARCHAR);
      CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
      CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR);
      CREATE TABLE ZABCDNOTE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACT INTEGER, ZTEXT VARCHAR);
    `);
    const entity = db.prepare("INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, ?, 0)");
    for (const [id, name, parent] of ENTITIES) entity.run(id, name, parent);
    const record = db.prepare(
      `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZDISPLAYFLAGS, ZCONTAINERWHERECONTACTISME, ZME, ZMODIFICATIONDATE, ZDEPARTMENT, ZFIRSTNAME,
         ZJOBTITLE, ZLASTNAME, ZMIDDLENAME, ZORGANIZATION, ZNAME) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const phone = db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER, ZLABEL) VALUES (?, ?, '_$!<Mobile>!$_')");
    const email = db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS, ZADDRESSNORMALIZED) VALUES (?, ?, lower(?))");
    const note = db.prepare("INSERT INTO ZABCDNOTE (ZCONTACT, ZTEXT) VALUES (?, ?)");
    // The records that are not cards come after them.
    let next = Math.max(0, ...cards.map((card) => card.pk)) + 1;
    for (const card of cards) {
      const container = card.me === "container" ? next++ : null;
      if (container !== null) record.run(container, ENTITY.container, null, null, null, null, null, null, null, null, null, null, "iCloud");
      record.run(card.pk, ENTITY.contact, card.company ? 1 : 0, container, null, card.changed, card.department ?? null, card.first ?? null,
        card.jobTitle ?? null, card.last ?? null, card.middle ?? null, card.organization ?? null, null);
      for (const number of card.phones ?? []) phone.run(card.pk, number);
      for (const address of card.emails ?? []) email.run(card.pk, address, address);
      if (card.note !== undefined) note.run(card.pk, card.note);
      if (card.me === "info") record.run(next++, ENTITY.info, null, null, card.pk, null, null, null, null, null, null, null, null);
    }
    if (group) record.run(next++, ENTITY.group, null, null, null, null, null, null, null, null, null, null, group);
  } finally {
    db.close();
  }
}

/** The account folders under Sources/, as the Mac names them. */
export const MAC_ACCOUNT = "0A1B2C3D-0000-4000-8000-000000000001";
export const OLD_ACCOUNT = "0A1B2C3D-0000-4000-8000-000000000002";

/** Writes the made-up Mac Contacts folder (see the top) at `folder`. */
export function writeMacContactsFixture(folder: string): void {
  const thisYear = coreDataTime("2026-10-01T09:00:00Z");
  writeMacStore(join(folder, "AddressBook-v22.abcddb"), [
    { pk: 1, organization: "Plumbing Co", company: true, phones: ["+61 3 7010 0000"], note: "Fixed the hot water", changed: thisYear },
    { pk: 2, organization: "Apple", company: true, phones: ["1-555-MY-SAMPLE"], changed: thisYear },
  ]);
  writeMacStore(join(folder, "Sources", MAC_ACCOUNT, "AddressBook-v22.abcddb"), [
    { pk: 11, first: "Ada", last: "Sample", phones: ["+61 491 571 266"], emails: ["ada@example.com"],
      organization: "Sample Labs", jobTitle: "Engineer", note: "Met at the climbing gym.\nVegetarian.", changed: thisYear },
    { pk: 12, first: "Bruno", last: "Placeholder", phones: ["0491 571 491"], note: "  Lent me a tent  ", changed: thisYear },
    { pk: 13, first: "Cleo", middle: "M.", last: "Example", phones: ["0061 491-571-804"], changed: thisYear },
    { pk: 14, first: "Riley", last: "Captain", phones: ["+61491570737"], emails: ["riley@example.com"],
      organization: "Captain Pty Ltd", jobTitle: "Owner", note: "My own card", changed: thisYear, me: "info" },
    { pk: 15, first: "Dana Example", last: "Example", phones: ["+44 7700 900008"], department: "Research", changed: thisYear },
    { pk: 16, first: "Li", last: "Li", phones: ["+1 202 555 0109"], changed: thisYear },
    { pk: 17, first: "‪+61 491 574‑118‬", phones: ["+61 491 574 118"], changed: thisYear },
  ], { group: "Climbing" });
  writeMacStore(join(folder, "Sources", OLD_ACCOUNT, "AddressBook-v22.abcddb"), [
    { pk: 3, first: "Ada", last: "S.", phones: ["+61 491571266"], changed: coreDataTime("2021-03-01T09:00:00Z") },
  ]);
}
