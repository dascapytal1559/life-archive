// One whole pass of the LLM warehouse on an archive (docs/events.md's "The LLM warehouse"): the import (warehouse.ts) over
// every tool's sessions on this Mac, then every rule over the whole history (tags.ts), on the archive's core database
// (or a trial's own: `coreFile`, which holds none of the connectors' sessions, so the trial reads them too). Run by
// `npm run llm -- import` and by the nightly job (npm run nas-backup, after it takes the transcripts and before its
// snapshot, so the snapshot holds the night's index).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { CORE_FILE, openCore } from "../archive/coreDb.ts";
import { projectsOf } from "../connectors/llm-sessions/read.ts";
import { readContext } from "./context.ts";
import { classifierOf } from "./markers.ts";
import { configuredProvenance } from "./provenance.ts";
import { warehouseSources } from "./sources.ts";
import { retag, type RetagResult } from "./tags.ts";
import { type ImportResult, importWarehouse, WarehouseError } from "./warehouse.ts";

/** The projects the llm-sessions connector reads: its own settings', else the archive's (none when neither names any). */
export function connectorProjects(dataDir: string): string[] {
  const file = join(dataDir, "connectors", "llm-sessions.json");
  try {
    const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { config?: Record<string, unknown>; projects?: unknown }) : {};
    return projectsOf(saved.config ?? (saved.projects ? { projects: saved.projects } : {}));
  } catch {
    return [];
  }
}

export interface PassOptions {
  dataDir: string;
  /** A trial's own core database, instead of the archive's. */
  coreFile?: string;
  again?: boolean;
  log?: (line: string) => void;
}

/** The import and the retag, on the core database, opened for the pass and closed after it. */
export const warehousePass = ({ dataDir, coreFile, again = false, log = () => {} }: PassOptions): Effect.Effect<{ imported: ImportResult; retagged: RetagResult & { ms: number } }, WarehouseError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const file = coreFile ?? join(dataDir, CORE_FILE);
        if (!coreFile && !existsSync(file)) throw new Error(`there is no archive in ${dataDir} (no ${CORE_FILE})`);
        return { db: openCore(file), file };
      },
      catch: (error) => new WarehouseError({ message: (error as Error).message }),
    }),
    ({ db, file }) =>
      Effect.gen(function* () {
        const provenance = configuredProvenance();
        const imported = yield* importWarehouse({
          db, dataDir, sources: warehouseSources(), again, log, lockDir: join(dirname(file), "backups", "llm-warehouse"),
          connector: { root: join(homedir(), ".claude", "projects"), projects: coreFile ? [] : connectorProjects(dataDir) },
          classify: classifierOf(provenance),
        });
        const started = Date.now();
        const context = readContext({ provenance });
        if (context.t3.problem) log(`the rules run without T3's records: ${context.t3.problem}`);
        const retagged = yield* Effect.try({ try: () => retag(db, context), catch: (error) => new WarehouseError({ message: `retagging: ${(error as Error).message}` }) });
        return { imported, retagged: { ...retagged, ms: Date.now() - started } };
      }),
    ({ db }) => Effect.sync(() => db.close()),
  );
