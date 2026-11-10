// A dry run of an import (`npm run archive -- import <connector> <source> --dry-run`): the connector reads its source as
// for a real import, and its events are applied to a copy, in memory, of the database its ledger keeps, so the counts
// are those the import would make. The real databases are only read: attached read-only, never opened for writing,
// no module told of the import, no backup taken, nor the calendar pushed. The connector's spool, any media it would
// copy, and the copies of an LLM's session files it would keep (made afresh, so all counted as new), go in a folder
// of their own in the archive's folder, removed after.
//
// The core's own connectors (llm-sessions, grok-bot) are applied to a new core database (so every event counts as
// new); a module's to a copy of the module's database: the module's own (sdk/server.ts's ModuleDatabase `dryRun`:
// friend map's, only the platform's records and none of their content), else its migrations then every row of the
// real file (none before the server first made it, so all counted as new). The module may say more of what the import
// would do (ModuleConnectors' `dryRunSaid`: friend map's calls it would add).

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ConnectorHost, loadRegistry, type ImportOptions, type ImportResult } from "../connectors/host.ts";
import { moduleConnectors, moduleLedgers, type Modules } from "../modules/loader.ts";
import { closeModuleStores, moduleDatabaseFile, NO_MODULES, openModuleDatabase, type ModuleStores } from "../modules/store.ts";
import { openCore } from "./coreDb.ts";
import { readOnlyAddress } from "./db.ts";

/** Runs an import of `sources` with `connector` against copies of the archive's databases in `dataDir`, and says what it would do. */
export async function dryRunImport(
  dataDir: string,
  connector: string,
  sources: string[],
  options: ImportOptions = {},
  modules: Modules = NO_MODULES,
): Promise<ImportResult & { said: string[] }> {
  const work = join(dataDir, "archive", `.dry-run-${process.pid}`);
  const core = openCore(":memory:");
  const registry = [...(await loadRegistry()), ...moduleConnectors(modules)];
  const entry = registry.find((e) => e.id === connector);
  const platform = entry?.manifest?.platform;
  if (!platform) throw new Error(`${connector} cannot be loaded`);
  // Only the connector's own module's database is copied: no other is written.
  const copies = copiedStores({ ...modules, on: modules.on.filter((module) => module.id === entry!.ledger) }, dataDir, platform);
  try {
    const host = new ConnectorHost({
      db: core, dataDir, registry, ledgers: moduleLedgers(copies, () => {}, { quiet: true }),
      spoolDir: join(work, "spool"), mediaDir: join(work, "media"), copiesDir: join(work, "llm"),
    });
    const result = await host.importHistory(connector, sources, options);
    const owner = copies.on.find((module) => module.id === entry!.ledger);
    const said = owner?.db ? (owner.definition.connectors?.dryRunSaid?.(owner.db, result.sourceId) ?? []) : [];
    return { ...result, said: [...said] };
  } finally {
    closeModuleStores(copies);
    core.close();
    await rm(work, { recursive: true, force: true });
  }
}

/** `modules`, each with a copy in memory of its database in `dataDir`, for an import of `platform` (see the top of this file). */
function copiedStores(modules: Modules, dataDir: string, platform: string): ModuleStores {
  return {
    ...modules,
    on: modules.on.map((module) => {
      const { database } = module.definition;
      if (!database) return { ...module, db: null, takenOver: false };
      const file = moduleDatabaseFile(dataDir, module.id, database);
      if (database.dryRun) {
        if (!existsSync(file)) throw new Error(`no ${module.id} database at ${file}`);
        return { ...module, db: database.dryRun(file, dataDir, platform), takenOver: false };
      }
      const { db } = openModuleDatabase(":memory:", database);
      if (existsSync(file)) copyRows(db, file);
      return { ...module, db, takenOver: false };
    }),
  };
}

/** Every row of the database in `file`, attached read-only, into `db`, over what `db` has (the take-over's mark). */
function copyRows(db: DatabaseSync, file: string): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("ATTACH DATABASE ? AS real").run(readOnlyAddress(file));
  try {
    const tables = db.prepare("SELECT name FROM real.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) db.exec(`INSERT OR REPLACE INTO main.${name} SELECT * FROM real.${name}`);
  } finally {
    db.exec("DETACH DATABASE real");
  }
}
