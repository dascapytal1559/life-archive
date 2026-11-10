// Locations: where each person is, as far as the captain last knew
// (person.location, one value or NULL). The only code that reads location
// across people.
//
// A value is kept as typed, trimmed and single-spaced (normalizeLocation), and
// values that differ only in case are one: the column compares without case,
// and a value someone already has is written in their spelling ("tokyo"
// is "Tokyo"). The index on the column (migration 32) lists every value
// and finds who has one without reading the people themselves.
//
// The captain's edits to one person's location go through People (people.ts),
// which checks and marks the person edited; renaming a value for everyone is
// here, and marks people changed, so open pages reload.

import { bumpMeta, type Db, InvalidInputError, type LocationInfo, NotFoundError, transaction } from "../../../sdk/server.ts";
import { normalizeLocation } from "./personFields.ts";

export class Locations {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Every location someone has, the most people first, then A to Z, with how many have each. */
  list(): LocationInfo[] {
    return this.db
      .prepare("SELECT location AS name, count(*) AS count FROM person WHERE location IS NOT NULL GROUP BY location ORDER BY count DESC, location")
      .all() as unknown as LocationInfo[];
  }

  /** `value` as someone already has it written, but for case; as given when nobody has it. */
  spelled(value: string): string {
    return (this.db.prepare("SELECT location FROM person WHERE location = ? LIMIT 1").get(value) as { location: string } | undefined)?.location ?? value;
  }

  /** The people at `value` (matched but for case), by id. */
  holders(value: string): Set<number> {
    const clean = value.trim().replace(/\s+/g, " ");
    return new Set((this.db.prepare("SELECT id FROM person WHERE location = ?").all(clean) as { id: number }[]).map((row) => row.id));
  }

  /**
   * Renames `from` (matched but for case) to `to` for everyone at it. Onto another location someone has, the two
   * are merged: everyone at either is at that one, in its spelling (`merged`). Returns the name kept and how many
   * people it moved (those already written so stay).
   */
  rename(from: unknown, to: unknown): { name: string; count: number; merged: boolean } {
    if (typeof from !== "string" || !from.trim()) throw new InvalidInputError("name the location to rename");
    const old = from.trim().replace(/\s+/g, " ");
    const next = normalizeLocation(to);
    return transaction(this.db, () => {
      const holders = this.holders(old);
      if (holders.size === 0) throw new NotFoundError(`nobody is at "${old}"`);
      // Only the case changing renames it; anything else onto a location in use takes that one's spelling.
      const merged = next.toLowerCase() !== old.toLowerCase() && this.holders(next).size > 0;
      const name = merged ? this.spelled(next) : next;
      const moved = Number(this.db.prepare("UPDATE person SET location = ? WHERE location = ? AND location COLLATE BINARY <> ?").run(name, old, name).changes);
      if (moved > 0) bumpMeta(this.db, "people_version");
      return { name, count: moved, merged };
    });
  }
}
