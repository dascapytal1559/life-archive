// The People table's Closeness: friend-map's own score (its page's src/demos/closeness.ts, which the map views and its
// Table scored people with), over the facts friend map keeps (structure.ts's score report), at the closeness settings
// in the page's settings.json, as Friend Map's Table asked for them. It moved here with that Table (the captain: fold
// it into Events' Tables "once Events can do what Friend Map's does").
//
// The tables read friend map's archive on the viewer's read-only connection, which cannot keep the report's message
// counts (structure.ts keeps them in the archive, worked out once per state of the links), so the score is asked of the
// friend map made over the same file as the archive opened: each registers its scorer, by its file, as it is made, and
// takes it away as it closes (friendMap.ts). Without one (a test of the tables alone, the static demo), nobody has a
// score. Nothing here reads a file itself, so the static demo can run the People table in the page.

import type { DatabaseSync } from "node:sqlite";

/** Everyone's closeness now, by person id: 0 or missing for nothing between you. */
export type Scorer = () => ReadonlyMap<number, number>;

/** The scorers open, by their archive's file. */
const scorers = new Map<string, Scorer>();

/** The file `db` is open on, what a friend map and the tables' connection share; none for a connection that cannot say (the demo's). */
const fileOf = (db: Partial<Pick<DatabaseSync, "location">>): string | null => (typeof db.location === "function" ? db.location() : null);

/** Scores the archive `db` is open on with `scorer`; the function it gives back takes it away again (the friend map closes). */
export function scoreWith(db: Partial<Pick<DatabaseSync, "location">>, scorer: Scorer): () => void {
  const file = fileOf(db);
  if (file === null) return () => undefined;
  scorers.set(file, scorer);
  return () => {
    if (scorers.get(file) === scorer) scorers.delete(file);
  };
}

/** Everyone's closeness now in the archive the tables' `db` reads, by person id; null when no friend map is open over it. */
export function closenessOf(db: Partial<Pick<DatabaseSync, "location">>): ReadonlyMap<number, number> | null {
  const file = fileOf(db);
  const scorer = file === null ? undefined : scorers.get(file);
  return scorer ? scorer() : null;
}
