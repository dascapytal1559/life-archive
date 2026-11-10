// An archive as it was before friend map was a module, for tests of the move (server/archive/migrate.ts) and of the
// old rows it drops (legacy.ts): opened at the schema the move takes (MOVE_VERSION), so it still has the core's tables
// and the exercise and rituals modules' old ones, which a new archive's migration 66 drops. Never the real archive: a
// test names a file in a temporary folder.

import { getMeta, setMeta, TIME_ZONE, type Db } from "../../../sdk/server.ts";
import { MOVE_VERSION } from "../../../sdk/testing.ts";
import { openArchive, type MigrationContext } from "../server/db.ts";

/** The archive at `file`, made or opened at the schema the move takes, not the latest, its zone kept as that code kept it. */
export function openUnmovedArchive(file: string, context: Omit<MigrationContext, "version"> = {}): Db {
  const db = openArchive(file, { ...context, version: MOVE_VERSION });
  // openArchive holds the zone only at the latest schema; the code at MOVE_VERSION held it on every open.
  if (getMeta(db, "time_zone") === null) setMeta(db, "time_zone", TIME_ZONE);
  return db;
}
