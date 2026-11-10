// The captain's address book, read for the names he gave people and for his
// own numbers and emails, in either of two forms:
//
// - the iPhone's AddressBook.sqlitedb, as taken from an iPhone backup:
//     ABPerson       one row per contact: First, Middle, Last, Organization, Nickname, Kind (1 for a company),
//                    Department, JobTitle and Note
//     ABMultiValue   a contact's numbers, emails and so on; property 3 is a phone number, 4 an email
//     ABStore        each account the contacts come from; MeIdentifier is the ABPerson row of the captain's own card
// - the Mac's Contacts, which iCloud keeps in step with the phone: a folder
//   (~/Library/Application Support/AddressBook, or the copy mac-imports takes of
//   it) with an AddressBook-v22.abcddb for the Mac's own cards and one under
//   Sources/<id>/ for each account, each a Core Data store:
//     ZABCDRECORD        every record; a contact's Z_ENT is ABCDContact's (or a sub-entity's) in Z_PRIMARYKEY:
//                        ZFIRSTNAME, ZMIDDLENAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME, ZDEPARTMENT, ZJOBTITLE,
//                        ZDISPLAYFLAGS (bit 1: shown as a company), ZMODIFICATIONDATE; the captain's own card is
//                        the one an info or account record's ZME names, or one with ZCONTAINERWHERECONTACTISME
//     ZABCDPHONENUMBER   ZOWNER (the contact's Z_PK), ZFULLNUMBER as typed
//     ZABCDEMAILADDRESS  ZOWNER, ZADDRESS
//     ZABCDNOTE          ZCONTACT, ZTEXT: the card's note
//
// Either way it comes to the same cards (Contact), numbered so that the card
// to name someone from, when several have their number, is the lowest: the
// iPhone's by its ABPerson row, which is stable; the Mac's newest changed
// first, so a card edited on the phone this week wins over an old copy in an
// account no longer used. Shared by the connectors that name people by phone
// number or email (whatsapp-db, imessage-db, call-history), and by the archive
// to fill people's notes from their contacts' company and notes
// (archive/addressBookNotes.ts).
//
// Numbers are kept however they were typed ("+61 491 571 266", "0491 571 266",
// "004940..."), so one is matched to a number with its country code (digits
// only) exactly when it was written with its country code, and otherwise by
// its national digits (without the trunk 0) being that number with a
// country code of one to three digits in front. That needs no guess at which
// country an unprefixed number belongs to. Emails are matched ignoring case.

import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { nameKey } from "../../../sdk/connector.ts";
import { columnsOf, isFile, openCopy } from "./appDb.ts";

type Row = Record<string, SQLOutputValue>;

/** The iPhone's address book, as an iPhone backup holds it. */
export const IPHONE_BOOK = "AddressBook.sqlitedb";
/** Each of the Mac's Contacts stores: one in its folder, one in each Sources/<id>/. */
export const MAC_BOOK = "AddressBook-v22.abcddb";

const PHONE_PROPERTY = 3;
const EMAIL_PROPERTY = 4;
const KIND_ORGANIZATION = 1;
/** ZDISPLAYFLAGS' bit for a card shown as a company (the AddressBook framework's kABShowAsCompany). */
const SHOW_AS_COMPANY = 1;
/** Core Data's entities for a contact card, in Z_PRIMARYKEY. */
const MAC_CONTACT_ENTITIES = ["ABCDContact", "ABCDSubscribedContact"];
/** Fewer digits than this are no whole number, and would match too much by their ending. */
const MIN_DIGITS = 7;

/** One card, in either book's form. */
export interface Contact {
  /** Its number in the book: the lowest is the one to name someone from (see the top). */
  id: number;
  first: string;
  middle: string;
  last: string;
  organization: string;
  nickname: string;
  /** A company's own card. */
  isCompany: boolean;
  department: string;
  jobTitle: string;
  note: string;
  /** The captain's own card. */
  self: boolean;
  phones: string[];
  emails: string[];
}

interface Entry {
  name: string;
  self: boolean;
  /** The card's id, to pick the same name every time when one number has several. */
  rowid: number;
}

export interface Match {
  /** The contact's name; the first contact's when several have the number. */
  name?: string;
  /** The number or email is on the captain's own card. */
  self: boolean;
}

export class AddressBook {
  private readonly international = new Map<string, Entry[]>();
  private readonly national = new Map<string, Entry[]>();
  private readonly emails = new Map<string, Entry[]>();
  /** The captain's own cards (by id). */
  readonly ownCards: ReadonlySet<number>;
  /** What each card says beyond its name and numbers, by id. */
  readonly cards: ReadonlyMap<number, ContactCard>;

  constructor(contacts: Contact[]) {
    this.ownCards = new Set(contacts.filter((contact) => contact.self).map((contact) => contact.id));
    this.cards = new Map(contacts.map((contact) => [contact.id, {
      rowid: contact.id,
      isCompany: contact.isCompany,
      organization: contact.organization,
      department: contact.department,
      jobTitle: contact.jobTitle,
      note: contact.note,
    }]));
    const add = (map: Map<string, Entry[]>, key: string, entry: Entry) => map.set(key, [...(map.get(key) ?? []), entry]);
    for (const contact of [...contacts].sort((a, b) => a.id - b.id)) {
      const entry = { name: contactName(contact), self: contact.self, rowid: contact.id };
      for (const email of contact.emails.map((value) => value.toLowerCase())) {
        if (email.includes("@")) add(this.emails, email, entry);
      }
      for (const typed of contact.phones) {
        const number = parseNumber(typed);
        if (number) add(number.international ? this.international : this.national, number.digits, entry);
      }
    }
  }

  /** What the address book says about a phone number (digits with country code, as WhatsApp keeps them). */
  lookup(phone: string): Match {
    return match(this.phoneEntries(phone));
  }

  /** What the address book says about an email address. */
  lookupEmail(email: string): Match {
    return match(this.emailEntries(email));
  }

  /**
   * The contacts (card ids) with this handle, a phone number with its
   * country code ("+61491571266") or an email, matched as lookup and
   * lookupEmail match; the captain's own card is left out.
   */
  contactsWith(handle: string): number[] {
    const entries = handle.includes("@") ? this.emailEntries(handle) : /^\+\d+$/.test(handle) ? this.phoneEntries(handle.slice(1)) : [];
    return [...new Set(entries.filter((entry) => !entry.self).map((entry) => entry.rowid))].sort((a, b) => a - b);
  }

  private phoneEntries(phone: string): Entry[] {
    let entries = this.international.get(phone) ?? [];
    if (entries.length === 0) {
      for (let prefix = 0; prefix <= 3; prefix++) entries = [...entries, ...(this.national.get(phone.slice(prefix)) ?? [])];
    }
    return entries;
  }

  private emailEntries(email: string): Entry[] {
    return this.emails.get(email.trim().toLowerCase()) ?? [];
  }
}

/** What a contact card says about someone beyond their name and numbers. */
export interface ContactCard {
  rowid: number;
  /** A company's own card: its organization is its name, not where someone works. */
  isCompany: boolean;
  organization: string;
  department: string;
  jobTitle: string;
  note: string;
}

/**
 * The address book at `path`: the iPhone's AddressBook.sqlitedb or one of the Mac's AddressBook-v22.abcddb, or a
 * folder holding either (the Mac's with its Sources/<id>/ stores). Each store is read from a copy in `work`, never
 * where it is. Null when there is nothing at `path`; an error when it is there but is no address book.
 */
export async function openAddressBook(path: string, work: string): Promise<AddressBook | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  const files = info.isFile() ? [path] : (await bookFiles(path)).map((file) => join(path, file));
  if (files.length === 0) throw new Error(`${path} holds no ${IPHONE_BOOK} or ${MAC_BOOK}`);
  const read: Array<{ mac: boolean; contacts: Array<Contact & { changed: number }> }> = [];
  for (const [n, file] of files.entries()) {
    // Each in its own folder: the Mac's stores all have the one name.
    const folder = join(work, `address-book-${n + 1}`);
    await mkdir(folder, { recursive: true });
    const db = (await openCopy(file, folder))!;
    try {
      read.push(isMacBook(db) ? { mac: true, contacts: readMacContacts(db) } : { mac: false, contacts: readIphoneContacts(db).map((c) => ({ ...c, changed: 0 })) });
    } finally {
      db.close();
    }
  }
  if (read.length === 1 && !read[0].mac) return new AddressBook(read[0].contacts);
  if (read.some((book) => !book.mac)) throw new Error(`${path} holds both an iPhone and a Mac address book; name one`);
  // The Mac's stores as one book, newest changed card first.
  const contacts = read.flatMap((book) => book.contacts).sort((a, b) => b.changed - a.changed);
  return new AddressBook(contacts.map((contact, i) => ({ ...contact, id: i + 1 })));
}

/** The address book an import names people from: its `contacts` setting, which must be there, else an iPhone book in `folder`. */
export async function importAddressBook(contacts: unknown, folder: string, work: string): Promise<AddressBook | null> {
  const named = typeof contacts === "string" && contacts !== "" ? resolve(contacts) : null;
  const book = await openAddressBook(named ?? join(folder, IPHONE_BOOK), work);
  if (named && !book) throw new Error(`the address book ${named} is not there`);
  return book;
}

/** The address book files in a folder, from the folder: the iPhone's, or else the Mac's stores. */
async function bookFiles(folder: string): Promise<string[]> {
  return (await isFile(join(folder, IPHONE_BOOK))) ? [IPHONE_BOOK] : macStores(folder);
}

/** The Mac's Contacts stores in its folder (or a copy of it), from the folder: its own, then each account's under Sources/. */
export async function macStores(folder: string): Promise<string[]> {
  const sources = (await readdir(join(folder, "Sources")).catch(() => [] as string[])).filter((name) => !name.startsWith(".")).sort();
  const found: string[] = [];
  for (const store of [MAC_BOOK, ...sources.map((source) => join("Sources", source, MAC_BOOK))]) {
    if (await isFile(join(folder, store))) found.push(store);
  }
  return found;
}

function isMacBook(db: DatabaseSync): boolean {
  return columnsOf(db, "ZABCDRECORD").length > 0;
}

/** The cards of an opened AddressBook.sqlitedb, checking by its tables and columns that it is one. */
export function readIphoneContacts(db: DatabaseSync): Contact[] {
  const person = columnsOf(db, "ABPerson");
  const values = columnsOf(db, "ABMultiValue");
  const missing = [
    ...["First", "Last", "Organization"].filter((c) => !person.includes(c)).map((c) => `ABPerson.${c}`),
    ...["record_id", "property", "value"].filter((c) => !values.includes(c)).map((c) => `ABMultiValue.${c}`),
  ];
  if (missing.length > 0) throw new Error(`the address book has no ${missing.join(", ")}; is it the iPhone's ${IPHONE_BOOK} or the Mac's ${MAC_BOOK}?`);

  const me = new Set(
    columnsOf(db, "ABStore").includes("MeIdentifier")
      ? (db.prepare("SELECT MeIdentifier FROM ABStore WHERE MeIdentifier IS NOT NULL").all() as Row[]).map((row) => Number(row.MeIdentifier))
      : [],
  );
  const optional = (column: string) => (person.includes(column) ? column : "NULL");
  const contacts = new Map<number, Contact>();
  for (const row of db
    .prepare(
      `SELECT ROWID AS rowid, First, ${optional("Middle")} AS Middle, Last, Organization, ${optional("Nickname")} AS Nickname,
         ${optional("Kind")} AS Kind, ${optional("Department")} AS Department, ${optional("JobTitle")} AS JobTitle, ${optional("Note")} AS Note
       FROM ABPerson ORDER BY ROWID`,
    )
    .all() as Row[]) {
    const id = Number(row.rowid);
    contacts.set(id, {
      id, first: text(row.First), middle: text(row.Middle), last: text(row.Last), organization: text(row.Organization), nickname: text(row.Nickname),
      isCompany: row.Kind === KIND_ORGANIZATION, department: text(row.Department), jobTitle: text(row.JobTitle), note: text(row.Note),
      self: me.has(id), phones: [], emails: [],
    });
  }
  for (const row of db.prepare("SELECT record_id, property, value FROM ABMultiValue WHERE property IN (?, ?) ORDER BY ROWID").all(PHONE_PROPERTY, EMAIL_PROPERTY) as Row[]) {
    const contact = contacts.get(Number(row.record_id));
    if (contact) (row.property === EMAIL_PROPERTY ? contact.emails : contact.phones).push(text(row.value));
  }
  return [...contacts.values()];
}

/** The cards of one opened Mac Contacts store, with when each last changed (Core Data's seconds, 0 when unknown). */
export function readMacContacts(db: DatabaseSync): Array<Contact & { changed: number }> {
  const record = columnsOf(db, "ZABCDRECORD");
  const phones = columnsOf(db, "ZABCDPHONENUMBER");
  const emails = columnsOf(db, "ZABCDEMAILADDRESS");
  const missing = [
    ...["Z_PK", "Z_ENT", "ZFIRSTNAME", "ZLASTNAME", "ZORGANIZATION"].filter((c) => !record.includes(c)).map((c) => `ZABCDRECORD.${c}`),
    ...["ZOWNER", "ZFULLNUMBER"].filter((c) => !phones.includes(c)).map((c) => `ZABCDPHONENUMBER.${c}`),
    ...["ZOWNER", "ZADDRESS"].filter((c) => !emails.includes(c)).map((c) => `ZABCDEMAILADDRESS.${c}`),
    ...["Z_ENT", "Z_NAME"].filter((c) => !columnsOf(db, "Z_PRIMARYKEY").includes(c)).map((c) => `Z_PRIMARYKEY.${c}`),
  ];
  if (missing.length > 0) throw new Error(`the Mac's address book has no ${missing.join(", ")}; its schema is not one this reader knows`);

  const me = new Set<number>();
  if (record.includes("ZME")) {
    for (const row of db.prepare("SELECT ZME FROM ZABCDRECORD WHERE ZME IS NOT NULL").all() as Row[]) me.add(Number(row.ZME));
  }
  const optional = (column: string) => (record.includes(column) ? `r.${column}` : "NULL");
  const hasNotes = ["ZCONTACT", "ZTEXT"].every((c) => columnsOf(db, "ZABCDNOTE").includes(c));
  const contacts = new Map<number, Contact & { changed: number }>();
  for (const row of db
    .prepare(
      `SELECT r.Z_PK AS pk, r.ZFIRSTNAME AS first, ${optional("ZMIDDLENAME")} AS middle, r.ZLASTNAME AS last,
         r.ZORGANIZATION AS organization, ${optional("ZNICKNAME")} AS nickname, ${optional("ZDISPLAYFLAGS")} AS flags,
         ${optional("ZDEPARTMENT")} AS department, ${optional("ZJOBTITLE")} AS jobTitle,
         ${optional("ZMODIFICATIONDATE")} AS changed, ${optional("ZCONTAINERWHERECONTACTISME")} AS meOf,
         ${hasNotes ? "(SELECT n.ZTEXT FROM ZABCDNOTE n WHERE n.ZCONTACT = r.Z_PK ORDER BY n.Z_PK LIMIT 1)" : "NULL"} AS note
       FROM ZABCDRECORD r
       WHERE r.Z_ENT IN (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME IN (${MAC_CONTACT_ENTITIES.map(() => "?").join(", ")}))
       ORDER BY r.Z_PK`,
    )
    .all(...MAC_CONTACT_ENTITIES) as Row[]) {
    const id = Number(row.pk);
    contacts.set(id, {
      id, first: text(row.first), middle: text(row.middle), last: text(row.last), organization: text(row.organization), nickname: text(row.nickname),
      isCompany: (Number(row.flags ?? 0) & SHOW_AS_COMPANY) === SHOW_AS_COMPANY, department: text(row.department), jobTitle: text(row.jobTitle), note: text(row.note),
      self: me.has(id) || row.meOf != null, phones: [], emails: [], changed: typeof row.changed === "number" ? row.changed : 0,
    });
  }
  for (const row of db.prepare("SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER ORDER BY Z_PK").all() as Row[]) {
    contacts.get(Number(row.owner))?.phones.push(text(row.value));
  }
  for (const row of db.prepare("SELECT ZOWNER AS owner, ZADDRESS AS value FROM ZABCDEMAILADDRESS ORDER BY Z_PK").all() as Row[]) {
    contacts.get(Number(row.owner))?.emails.push(text(row.value));
  }
  return [...contacts.values()];
}

function match(entries: Entry[]): Match {
  const named = entries.filter((entry) => entry.name).sort((a, b) => a.rowid - b.rowid);
  return { name: named[0]?.name, self: entries.some((entry) => entry.self) };
}

/** A number as typed, as the digits to match: with its country code when it was written with one ("+", "00"). */
export function parseNumber(typed: string): { digits: string; international: boolean } | null {
  if (/[a-z]/i.test(typed)) return null; // "1-555-MY-SAMPLE"
  const compact = typed.replace(/[^\d+]/g, "");
  const international = /^(\+|00)/.test(compact);
  const digits = compact.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= MIN_DIGITS ? { digits, international } : null;
}

/** A contact's name as the Contacts app shows it: a company by its name, a person by first, middle and last. */
function contactName(contact: Contact): string {
  if (contact.isCompany && contact.organization) return contact.organization;
  return joinName([contact.first, contact.middle, contact.last]) || contact.organization || contact.nickname;
}

/**
 * Name parts joined by spaces, leaving out a part the name before it already
 * ends with: a full name typed as the first name ("Joanna Draftly", last name
 * "Draftly") is "Joanna Draftly", not "Joanna Draftly Draftly". A name that is
 * only one part twice ("Li", "Li") is kept as it is.
 */
export function joinName(parts: string[]): string {
  const words: string[] = [];
  for (const part of parts) {
    const own = part.split(/\s+/).filter(Boolean);
    const repeated = words.length > own.length && nameKey(words.slice(-own.length).join(" ")) === nameKey(own.join(" "));
    if (!repeated) words.push(...own);
  }
  return words.join(" ");
}

function text(value: SQLOutputValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
