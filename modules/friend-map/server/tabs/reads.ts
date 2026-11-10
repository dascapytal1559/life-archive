// The viewer's read-only connection to friend map's archive, which its tables read (the core's Reads' `modules`, opened
// as the module's database declares: as its SQL runner opens it, unable to read content).

import type { DatabaseSync } from "node:sqlite";
import type { Reads } from "../../../../sdk/server.ts";

/** Friend map's archive among the viewer's reads. */
export function archiveOf(reads: Reads): DatabaseSync {
  const db = reads.modules.get("friend-map");
  if (!db) throw new Error("friend map's archive is not open for the viewer");
  return db;
}
