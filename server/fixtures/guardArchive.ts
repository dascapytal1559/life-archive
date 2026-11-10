// A test archive for the privacy guard's tests (server/guard/): a real friend map archive in `dir` (its module's
// database, modules/friend-map/archive.sqlite) holding the made-up people given, and the captain (the archive's own
// self person) named `self` when given, so the guard reads its names as it reads the real one's.

import { mkdir } from "node:fs/promises";
import { loadModules } from "../modules/loader.ts";
import { closeModuleStores, openModuleStores } from "../modules/store.ts";

export async function writeGuardArchive(dir: string, { people = [], self }: { people?: string[]; self?: string } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const stores = openModuleStores(await loadModules({ all: true }), dir);
  try {
    const db = stores.on.find((module) => module.id === "friend-map")?.db;
    if (!db) throw new Error("the friend map module is not installed, or its database could not be opened");
    const add = db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'captain', 0)");
    for (const name of people) add.run(name);
    if (self) {
      if (db.prepare("UPDATE person SET name = ? WHERE is_self = 1").run(self).changes === 0) db.prepare("INSERT INTO person (name, name_source, is_self, created_at) VALUES (?, 'captain', 1, 0)").run(self);
    }
  } finally {
    closeModuleStores(stores);
  }
}
