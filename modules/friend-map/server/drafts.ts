// Drafts: messages the captain is writing to someone, one row each in the
// draft table, any number per person (his panel shows each, and one empty box
// for someone with none: one is the rule until there is a way to start a
// second, and only a merge gives anyone two). The only code that reads or
// writes it.
//
// A draft is his scratch space, saved as he types, so saving one is no edit
// to the person: it makes no changeset and marks nobody edited, and the page
// is not told to load again. A draft emptied is deleted. Imports never write
// them. A merge or a join gives the one kept the other's drafts (combine,
// which the change log records, so undoing the merge takes them back), and
// deleting a person deletes theirs.

import { type Db, type Draft, InvalidInputError, NotFoundError } from "../../../sdk/server.ts";
import { normalizeDraft } from "./personFields.ts";

interface DraftRow {
  id: number;
  person_id: number;
  text: string;
  created_at: number;
  updated_at: number;
}

export class Drafts {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** A person's drafts, the first made first. */
  list(personId: number): Draft[] {
    this.person(personId);
    return (this.db.prepare("SELECT * FROM draft WHERE person_id = ? ORDER BY id").all(personId) as unknown as DraftRow[]).map(fromRow);
  }

  /** A new draft to `personId` (text as a note is written); null, and nothing kept, when it is empty. */
  add(personId: number, text: unknown): Draft | null {
    const clean = normalizeDraft(text);
    this.person(personId);
    if (clean === "") return null;
    const now = Date.now();
    const id = Number(this.db.prepare("INSERT INTO draft (person_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)").run(personId, clean, now, now).lastInsertRowid);
    return this.get(id);
  }

  /** Draft `id` with this text; emptied, it is deleted (null). */
  set(id: number, text: unknown): Draft | null {
    const clean = normalizeDraft(text);
    const draft = this.get(id);
    if (clean === "") {
      this.remove(id);
      return null;
    }
    if (clean === draft.text) return draft;
    this.db.prepare("UPDATE draft SET text = ?, updated_at = ? WHERE id = ?").run(clean, Date.now(), id);
    return this.get(id);
  }

  remove(id: number): void {
    this.get(id);
    this.db.prepare("DELETE FROM draft WHERE id = ?").run(id);
  }

  get(id: number): Draft {
    if (!Number.isSafeInteger(id)) throw new InvalidInputError("give a draft number");
    const row = this.db.prepare("SELECT * FROM draft WHERE id = ?").get(id) as DraftRow | undefined;
    if (!row) throw new NotFoundError(`no draft #${id}`);
    return fromRow(row);
  }

  /** Gives `intoId` every draft of `fromId`'s (a merge or join, before `fromId` is deleted). */
  combine(intoId: number, fromId: number): void {
    this.db.prepare("UPDATE draft SET person_id = ? WHERE person_id = ?").run(intoId, fromId);
  }

  private person(id: number): void {
    if (!this.db.prepare("SELECT 1 FROM person WHERE id = ?").get(id)) throw new NotFoundError(`no person ${id}`);
  }
}

function fromRow(row: DraftRow): Draft {
  return { id: row.id, personId: row.person_id, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at };
}
