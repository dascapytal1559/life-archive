// Tags: the captain's tags, one row each in the tag table, in the captain's
// order (tag.sort_order), and which person has which (person_tag). The only
// code that reads or writes those tables.
//
// A tag exists whether or not anyone has it, so the Table's Hide
// and the person panel's suggestions offer it all the
// same, but taking it from the last person who has it deletes it too (in the
// same edit, so one undo brings both back): a tag made by mistake goes once
// nobody has it. A tag nobody had before (one just made in the tag manager),
// the built-in ones and those Hide starts on (KEPT_WHEN_EMPTY) are kept. Renaming or deleting one is a single change that everyone with it
// follows; renaming it to a tag that already exists merges the two (everyone
// with either has the one kept, in its place in the order). A person's tags
// are always given in the tag order.
//
// "archive" and "keep" (see archiving.ts) and "live-together" (see
// LIVE_TOGETHER_TAG in src/archive.ts) are built in: always there, and
// never renamed, deleted or merged into, though they can be moved.
// The rules' archive is never stored: it shows as "archive" (see tagsWithRule
// in src/archive.ts), and its old name, "system-archive", is refused, as is
// "me" ("This is me" says that).
//
// The captain's edits to one person's tags go through People (people.ts), which
// checks and marks the person edited; the tag table's own edits (create,
// rename, delete, move) are here, and each marks people changed, so open
// pages reload.

import { ARCHIVE_TAG, BUILT_IN_TAGS, bumpMeta, type Db, InvalidInputError, KEEP_TAG, NotFoundError, type TagInfo, transaction } from "../../../sdk/server.ts";
import { normalizeTag } from "./personFields.ts";

/** The tag that used to mark a person file as the captain's own; "This is me" (markAsMe) does that now. */
export const ME_TAG = "me";


/**
 * The tags friend-map's Hide starts with on (HIDDEN_BY_DEFAULT in its src/demos/hideChoices.ts), so offered with nobody
 * tagged; the Events calendar's day leaves out the people they hide too (dayChats.ts's hiddenAmong).
 */
export const HIDDEN_BY_DEFAULT: readonly string[] = [ARCHIVE_TAG, "commercial"];

/** Tags kept when the last person who has one loses it: the built-in ones, and those Hide starts on. */
const KEPT_WHEN_EMPTY: ReadonlySet<string> = new Set([...BUILT_IN_TAGS, ...HIDDEN_BY_DEFAULT]);

/** Whether a tag is deleted when the last person who has it loses it: all but the built-in ones and those Hide starts on. */
export function deletesWhenEmpty(tag: { name: string; builtIn: boolean }): boolean {
  return !tag.builtIn && !KEPT_WHEN_EMPTY.has(tag.name);
}

/** A tag name as stored: normalizeTag, and never "me". */
export function storableTag(name: unknown): string {
  const clean = normalizeTag(name);
  if (clean === ME_TAG) throw new InvalidInputError(`"${ME_TAG}" is not a tag: say "This is me" (\`person me\`) instead`);
  return clean;
}

export class Tags {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Every tag, in order, with how many people have it. */
  list(): TagInfo[] {
    return (this.db
      .prepare(
        `SELECT t.name, t.built_in, (SELECT count(*) FROM person_tag pt WHERE pt.tag_id = t.id) AS count
         FROM tag t ORDER BY t.sort_order, t.name`,
      )
      .all() as { name: string; built_in: number; count: number }[])
      .map((row) => ({ name: row.name, count: row.count, builtIn: row.built_in === 1 }));
  }

  /** Adds a tag, last in the order. Returns its name as stored. */
  create(name: unknown): string {
    const clean = storableTag(name);
    return transaction(this.db, () => {
      if (this.find(clean)) throw new InvalidInputError(`there is already a tag "${clean}"`);
      this.insert(clean);
      this.changed();
      return clean;
    });
  }

  /**
   * Renames a tag, for everyone who has it. Renaming it to a tag that exists
   * merges them: everyone with `from` has `to`, `to` keeps its place, and
   * `from` is gone (`merged`). Returns the name kept.
   */
  rename(from: unknown, to: unknown): { name: string; merged: boolean } {
    const old = this.existing(from);
    const name = storableTag(to);
    if (old.built_in) throw new InvalidInputError(`"${old.name}" is built in: it can't be renamed`);
    if (name === old.name) return { name, merged: false };
    return transaction(this.db, () => {
      const target = this.find(name);
      if (!target) {
        this.db.prepare("UPDATE tag SET name = ? WHERE id = ?").run(name, old.id);
        this.changed();
        return { name, merged: false };
      }
      if (target.built_in) throw new InvalidInputError(`"${target.name}" is built in: tag people with it one by one instead`);
      this.db
        .prepare("INSERT OR IGNORE INTO person_tag (person_id, tag_id, added_at) SELECT person_id, ?, added_at FROM person_tag WHERE tag_id = ?")
        .run(target.id, old.id);
      this.remove(old.id);
      this.changed();
      return { name, merged: true };
    });
  }

  /** Deletes a tag, taking it from everyone who has it. Returns how many people had it. */
  delete(name: unknown): number {
    const tag = this.existing(name);
    if (tag.built_in) throw new InvalidInputError(`"${tag.name}" is built in: it can't be deleted`);
    return transaction(this.db, () => {
      const count = this.holders(tag.id);
      this.remove(tag.id);
      this.changed();
      return count;
    });
  }

  /** Moves a tag to `position` in the order (0 first; past the end is last). */
  move(name: unknown, position: number): void {
    const tag = this.existing(name);
    if (!Number.isSafeInteger(position) || position < 0) throw new InvalidInputError("a position is a whole number from 0");
    transaction(this.db, () => {
      const order = this.ids().filter((id) => id !== tag.id);
      order.splice(Math.min(position, order.length), 0, tag.id);
      this.renumber(order);
      this.changed();
    });
  }

  // --- people's tags (People calls these inside its own transactions)

  /** A person's tags, in the tag order. */
  of(personId: number): string[] {
    return this.byPerson([personId]).get(personId) ?? [];
  }

  /** Everyone's tags (or just `personIds`'), in the tag order; people without any are left out. */
  byPerson(personIds?: number[]): Map<number, string[]> {
    const rows = this.db
      .prepare(
        `SELECT pt.person_id, t.name FROM person_tag pt JOIN tag t ON t.id = pt.tag_id
         ${personIds ? "WHERE pt.person_id IN (SELECT value FROM json_each(?))" : ""}
         ORDER BY t.sort_order, t.name`,
      )
      .all(...(personIds ? [JSON.stringify(personIds)] : [])) as { person_id: number; name: string }[];
    const tags = new Map<number, string[]>();
    for (const row of rows) tags.set(row.person_id, [...(tags.get(row.person_id) ?? []), row.name]);
    return tags;
  }

  /** The people who have a tag, by id. */
  holdersOf(name: string): Set<number> {
    return new Set((this.db
      .prepare("SELECT pt.person_id FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE t.name = ?")
      .all(name) as { person_id: number }[]).map((row) => row.person_id));
  }

  /**
   * Gives a person exactly these tags (as storableTag writes them): a tag
   * nobody has made yet is added, last in the order. Tags they already had
   * keep when they were added. A tag taken from the last person who had it is
   * deleted, unless deletesWhenEmpty keeps it.
   */
  set(personId: number, names: readonly string[]): void {
    const ids = names.map((name) => this.find(name)?.id ?? this.insert(name));
    const taken = this.db
      .prepare("DELETE FROM person_tag WHERE person_id = ? AND tag_id NOT IN (SELECT value FROM json_each(?)) RETURNING tag_id")
      .all(personId, JSON.stringify(ids)) as { tag_id: number }[];
    const add = this.db.prepare("INSERT OR IGNORE INTO person_tag (person_id, tag_id, added_at) VALUES (?, ?, ?)");
    for (const id of ids) add.run(personId, id, Date.now());
    for (const { tag_id } of taken) {
      const tag = this.db.prepare("SELECT name, built_in FROM tag WHERE id = ?").get(tag_id) as { name: string; built_in: number };
      if (deletesWhenEmpty({ name: tag.name, builtIn: tag.built_in === 1 }) && this.holders(tag_id) === 0) this.remove(tag_id);
    }
  }

  /**
   * Gives `intoId` every tag `fromId` has (a merge, before `fromId` is deleted); with
   * `archiveState: false`, all but "archive" and "keep", so `intoId` keeps its own archive state.
   */
  combine(intoId: number, fromId: number, { archiveState = true }: { archiveState?: boolean } = {}): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO person_tag (person_id, tag_id, added_at) SELECT ?, tag_id, added_at FROM person_tag WHERE person_id = ?${
        archiveState ? "" : " AND tag_id NOT IN (SELECT id FROM tag WHERE name IN (?, ?))"}`)
      .run(intoId, fromId, ...(archiveState ? [] : [ARCHIVE_TAG, KEEP_TAG]));
  }

  // --- helpers

  private find(name: string): { id: number; name: string; built_in: number } | undefined {
    return this.db.prepare("SELECT id, name, built_in FROM tag WHERE name = ?").get(name) as { id: number; name: string; built_in: number } | undefined;
  }

  private existing(name: unknown): { id: number; name: string; built_in: number } {
    const clean = normalizeTag(name);
    const tag = this.find(clean);
    if (!tag) throw new NotFoundError(`there is no tag "${clean}"`);
    return tag;
  }

  /**
   * Adds a tag, last. Its id is one no tag the change log remembers has had,
   * so undoing a tag's deletion (a typo taken from its last person, then the
   * right tag given) never finds its id taken.
   */
  private insert(name: string): number {
    const last = (this.db.prepare("SELECT coalesce(max(sort_order), -1) AS n FROM tag").get() as { n: number }).n;
    const id = (this.db
      .prepare(`SELECT max(coalesce((SELECT max(id) FROM tag), 0),
                          coalesce((SELECT max(row_key ->> 0) FROM change_row WHERE tbl = 'tag'), 0)) + 1 AS id`)
      .get() as { id: number }).id;
    this.db
      .prepare("INSERT INTO tag (id, name, sort_order, built_in, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, last + 1, BUILT_IN_TAGS.includes(name) ? 1 : 0, Date.now());
    return id;
  }

  private remove(tagId: number): void {
    this.db.prepare("DELETE FROM person_tag WHERE tag_id = ?").run(tagId);
    this.db.prepare("DELETE FROM tag WHERE id = ?").run(tagId);
    this.renumber(this.ids());
  }

  private holders(tagId: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM person_tag WHERE tag_id = ?").get(tagId) as { n: number }).n;
  }

  private ids(): number[] {
    return (this.db.prepare("SELECT id FROM tag ORDER BY sort_order, name").all() as { id: number }[]).map((row) => row.id);
  }

  /** Numbers the tags 0, 1, 2... in this order. */
  private renumber(order: number[]): void {
    const update = this.db.prepare("UPDATE tag SET sort_order = ? WHERE id = ? AND sort_order IS NOT ?");
    order.forEach((id, i) => update.run(i, id, i));
  }

  private changed(): void {
    bumpMeta(this.db, "people_version");
  }
}
