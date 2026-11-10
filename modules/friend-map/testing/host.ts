// A connectors' host over an archive a test built by hand (openArchive): friend map's connectors registered in a
// ledger of the archive's own, their imports applied by the module's writer (server/write.ts) to `db`, as the core's
// host runs them for the module, and the core's own connectors beside them, into a core database in memory. Nothing
// is pushed into a calendar, and no rules run (what must hold before an import, beforeImport.ts, is still checked):
// what a test of the importing alone needs.

import { isPlatform } from "../../../sdk/server.ts";
import { ConnectorHost, loadRegistry, openCore } from "../../../sdk/testing.ts";
import { CONNECTORS } from "../connectors/connectors.ts";
import type { Db } from "../server/db.ts";
import { beforeImport } from "../server/beforeImport.ts";
import { applyChats } from "../server/write.ts";

/**
 * The host over `db`, the archive in `dataDir`: friend map's connectors and the core's own, or, given `registry` (a
 * test's made-up connectors), those, a chat platform's in friend map's ledger as a module's are. Its own spool, media
 * and copies folders beside, when given (`options`), as the host takes them.
 */
export async function chatHost(db: Db, dataDir: string, registry?: Awaited<ReturnType<typeof loadRegistry>>, options: Partial<ConstructorParameters<typeof ConnectorHost>[0]> = {}): Promise<ConnectorHost> {
  const entries = registry
    ? registry.map((entry) => (entry.manifest && isPlatform(entry.manifest.platform) ? { ...entry, ledger: "friend-map" } : entry))
    : [...(await loadRegistry()), ...CONNECTORS.map(({ manifest, main }) => ({ id: manifest.id, main, manifest, loadError: null, ledger: "friend-map" }))];
  const ledger = {
    db,
    apply: (events: Parameters<typeof applyChats>[0], source: Parameters<typeof applyChats>[2]) => applyChats(events, db, source, () => {}),
    before: (connector: string) => beforeImport(connector, db),
  };
  return new ConnectorHost({ db: openCore(":memory:"), dataDir, registry: entries, ledgers: new Map([["friend-map", ledger]]), ...options });
}
