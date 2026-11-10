// People's notes from the captain's address book (the iPhone's AddressBook.sqlitedb
// or the Mac's Contacts, see connectors/addressBook.ts): what a contact card says beyond a name and numbers (the company, department and job
// title, and the card's own note) becomes the note of the people its phone
// numbers and emails belong to. A card is matched to a person the way the
// connectors name accounts (connectors/addressBook.ts): through the handle of
// each import person, a phone number or an email.
//
// A person on several cards gets each card's note once, in card order, a blank
// line between them. People.fillAddressBookNotes writes only notes that are
// empty or still as the address book last wrote them, so running this again
// after the captain has edited a note leaves it be, and a card with neither
// company nor note changes nothing. Runs after a whatsapp-db or imessage-db
// import given --contacts, and on `npm run archive -- contact-notes <book>`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAddressBook, type AddressBook, type ContactCard } from "../connectors/addressBook.ts";
import type { Db } from "../../../sdk/server.ts";
import type { NoteFill, People } from "./people.ts";

export interface AddressBookNotes extends NoteFill {
  /** Contact cards, the captain's own left out. */
  contacts: number;
  /** Of those, cards with a company, department or job title (a company's own card's name is no company)... */
  withCompany: number;
  /** ...with a note... */
  withNote: number;
  /** ...with either... */
  withEither: number;
  /** ...and of those, cards matched to at least one person, and to more than one. */
  matched: number;
  matchedSeveral: number;
  /** People the address book has a note for. */
  people: number;
}

/** What a card adds to a note: "Company: …", "Department: …" and "Job title: …" lines, then its note; empty when it has none of these. */
export function contactNote(card: ContactCard): string {
  const lines = [
    ...(card.organization && !card.isCompany ? [`Company: ${card.organization}`] : []),
    ...(card.department ? [`Department: ${card.department}`] : []),
    ...(card.jobTitle ? [`Job title: ${card.jobTitle}`] : []),
    ...(card.note ? [card.note] : []),
  ];
  return lines.join("\n");
}

/** The note the address book has for each person (by person id), and what it found, without writing anything. */
export function addressBookNotes(db: Db, book: AddressBook):
  { notes: Map<number, string>; counts: Omit<AddressBookNotes, keyof NoteFill> } {
  const own = [...book.cards.values()].filter((card) => !book.ownCards.has(card.rowid));
  const noted = new Map(own.map((card) => [card.rowid, contactNote(card)]).filter(([, note]) => note !== "") as [number, string][]);

  const cardsOf = new Map<number, Set<number>>();
  const peopleOf = new Map<number, Set<number>>();
  const handles = db
    .prepare(
      `SELECT ip.handle, ip.person_id FROM import_person ip JOIN person p ON p.id = ip.person_id
       WHERE ip.handle IS NOT NULL AND ip.is_self = 0 AND p.is_self = 0`,
    )
    .all() as { handle: string; person_id: number }[];
  for (const { handle, person_id: person } of handles) {
    for (const rowid of book.contactsWith(handle)) {
      if (!noted.has(rowid)) continue;
      cardsOf.set(person, (cardsOf.get(person) ?? new Set()).add(rowid));
      peopleOf.set(rowid, (peopleOf.get(rowid) ?? new Set()).add(person));
    }
  }
  const notes = new Map<number, string>();
  for (const [person, rowids] of cardsOf) {
    notes.set(person, [...new Set([...rowids].sort((a, b) => a - b).map((rowid) => noted.get(rowid)!))].join("\n\n"));
  }
  return {
    notes,
    counts: {
      contacts: own.length,
      withCompany: own.filter((card) => contactNote({ ...card, note: "" }) !== "").length,
      withNote: own.filter((card) => card.note !== "").length,
      withEither: noted.size,
      matched: peopleOf.size,
      matchedSeveral: [...peopleOf.values()].filter((people) => people.size > 1).length,
      people: notes.size,
    },
  };
}

/** Fills people's notes from the address book at `path`, a file or the Mac's Contacts folder (read from a copy, never written). */
export async function fillNotesFromAddressBook(
  db: Db,
  people: People,
  path: string,
  write: <T>(work: () => T) => T = (work) => work(),
): Promise<AddressBookNotes> {
  const work = await mkdtemp(join(tmpdir(), "friend-map-contacts-"));
  try {
    const book = await openAddressBook(path, work);
    if (!book) throw new Error(`the address book ${path} is not there`);
    const { notes, counts } = addressBookNotes(db, book);
    return { ...counts, ...write(() => people.fillAddressBookNotes(notes)) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
