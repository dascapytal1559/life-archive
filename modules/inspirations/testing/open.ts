// The inspirations open on a made-up archive's folder of a test's own, as the server opens them: the module's
// database at modules/inspirations/ (migrated, its take-over from the folder's core when there is one), and what the
// routes, the worker and the commands are given over it. Never the real archive: a test names a temporary folder.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openModuleDatabase } from "../../../sdk/testing.ts";
import { INSPIRATIONS_DATABASE, INSPIRATIONS_DB } from "../server/db.ts";
import { inspirationsFolder } from "../server/files.ts";
import { openInspirations, type InspirationsPart } from "../server/part.ts";
import type { Kept } from "../server/worker.ts";

/** The inspirations a test opened. */
export interface TestInspirations {
  /** The archive's folder. */
  readonly dataDir: string;
  /** The module's folder in it, where its database and kept files are. */
  readonly folder: string;
  readonly db: DatabaseSync;
  /** Whether this open took the core's inspirations over. */
  readonly takenOver: boolean;
  readonly part: InspirationsPart;
  /** What the worker works on. */
  readonly kept: Kept;
  close(): void;
}

/** Opens the inspirations in the archive's folder `dataDir`, as the server does. */
export function openTestInspirations(dataDir: string): TestInspirations {
  const folder = inspirationsFolder(dataDir);
  const { db, takenOver } = openModuleDatabase(join(folder, INSPIRATIONS_DB), INSPIRATIONS_DATABASE, { archiveFile: join(dataDir, "archive.sqlite") });
  const part = openInspirations(db);
  return { dataDir, folder, db, takenOver, part, kept: { store: part.store, folder }, close: () => db.close() };
}

/** A new made-up folder of its own (named for `what`), with the inspirations open in it; closing them removes the folder. */
export async function newTestInspirations(what: string): Promise<TestInspirations & { remove(): Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), `life-archive-${what}-`));
  const opened = openTestInspirations(dataDir);
  return {
    ...opened,
    remove: async () => {
      opened.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
