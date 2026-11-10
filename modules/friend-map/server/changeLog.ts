// friend map's change log: the core's (changes.ts, sdk/server.ts's Changes) over the archive, an undo settling the
// people it touched through the people rules (People.settle). friendMap.ts makes the archive's one; a test makes its own.

import { Changes } from "../../../sdk/server.ts";
import type { Db } from "./db.ts";
import type { People } from "./people.ts";

/** The change log over the archive `db`, its undos settled by `people`; `afterChange` hears what each changeset changed, once committed. */
export const changeLog = (db: Db, people: People, { afterChange }: { afterChange?: (tables: string[]) => void } = {}): Changes =>
  new Changes(db, { settle: (ids, options) => people.settle(ids, options), afterChange });
