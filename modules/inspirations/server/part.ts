// The inspirations open over the module's database (db.ts): their store and their own change log, the one object
// the routes, the work and the commands share (module.ts). Opened once a database, its change log pruned to its last
// KEEP_DAYS days as it opens.

import { Changes, type Db } from "../../../sdk/server.ts";
import { INSPIRATION_LOG_TABLES, inspirationsDescriber } from "./changeLog.ts";
import { Inspirations } from "./store.ts";

/** The inspirations open over their database. */
export interface InspirationsPart {
  /** Their items, saves, files, tags and the server's queue (store.ts). */
  readonly store: Inspirations;
  /** Their change log: every edit of his to them, each undoable. */
  readonly changes: Changes;
}

const opened = new WeakMap<Db, InspirationsPart>();

/** The inspirations over the database `db`, opened the first time it is asked for. */
export function openInspirations(db: Db): InspirationsPart {
  let part = opened.get(db);
  if (!part) {
    const changes = new Changes(db, { tables: INSPIRATION_LOG_TABLES, describe: inspirationsDescriber(db) });
    changes.prune();
    part = { store: new Inspirations(db), changes };
    opened.set(db, part);
  }
  return part;
}
