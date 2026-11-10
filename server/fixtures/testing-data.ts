// npm run testing-data -- <dir>: builds a complete testing data folder from the synthetic samples, so the app and the
// archive can be tried and developed without touching real data:
//
//   npm run testing-data -- /tmp/life-archive-testing
//   LIFE_ARCHIVE_DATA=/tmp/life-archive-testing LIFE_ARCHIVE_URL=http://127.0.0.1:4651 npm start
//
// Every installed module's made-up data (its fixtures, sdk/server.ts): friend map's sample Messenger export, imported,
// and its sample people, named and tagged, for friend-map's page at /friend-map/ and its tables; health's made-up
// results, for the viewer's Health tab; made-up Polar workouts, the exercise module's, some in the weeks to today, for
// the Fitness page, and a weekly zone 2 target of 300 minutes; a made-up rituals store, the rituals
// module's, for its two tabs and the calendar, whose workouts join the Fitness page, so it never meets the real rituals;
// and the inspirations module's made-up inspirations, for its Inspirations page.
//
// With --crowd, friend map's folder instead holds a made-up crowd of about 120 people over two and a half years
// (its fixtures/crowd.ts), for the map views, with their calls for the viewer's Calls tab and hangouts for its Hangouts
// tab, and the core made-up LLM sessions for the LLM tab (crowdEvents.ts). With --long, a made-up history of about 700
// people from 2008, most of them last spoken with years ago, for trying the map on a long history.

import "./onTestingSettings.ts";
import "../onSettings.ts";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { transaction } from "../archive/db.ts";
import { Archive } from "../archive/index.ts";
import { coreLedger } from "../archive/coreWrite.ts";
import { openCore, CORE_FILE } from "../archive/coreDb.ts";
import { loadModules } from "../modules/loader.ts";
import { closeModuleStores, openModuleStores } from "../modules/store.ts";
import { crowdLlm } from "./crowdEvents.ts";
import { writeCrowdWarehouse } from "./crowdWarehouse.ts";
import { SETTINGS_FILE } from "../settings.ts";
import { TESTING_SETTINGS } from "./onTestingSettings.ts";

const long = process.argv.includes("--long");
const crowd = long ? "long" : process.argv.includes("--crowd") ? "crowd" : undefined;
const target = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!target) {
  console.error("Usage: npm run testing-data -- <new directory> [--crowd | --long]");
  process.exit(1);
}
const dataDir = resolve(target);
await mkdir(dataDir, { recursive: true });
if ((await readdir(dataDir)).length > 0) {
  console.error(`${dataDir} is not empty; give a new directory.`);
  process.exit(1);
}
// Every installed module's made-up data, switched off or not, each with its database open (into which it writes): a
// testing folder has everything to try.
await copyFile(TESTING_SETTINGS, join(dataDir, SETTINGS_FILE));
const stores = openModuleStores(await loadModules({ all: true }), dataDir);
for (const broken of stores.broken) console.error(`Module ${broken.id} is broken, so it writes no made-up data: ${broken.problem}`);
const fixtures = stores.on.flatMap((m) => (m.definition.fixtures ? [{ fixture: m.definition.fixtures, store: { folder: dataDir, ...(m.db ? { db: m.db } : {}) } }] : []));
for (const { fixture, store } of fixtures) await fixture.write(dataDir, store, { crowd });
// The core's own: the crowd's conversations with an LLM, into its event index as the host writes them.
if (crowd === "crowd") {
  const core = openCore(join(dataDir, CORE_FILE));
  try {
    const events = await crowdLlm(dataDir);
    transaction(core, () => {
      const source = Number(core
        .prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES ('claude-code', 'crowd', 'export', 'crowd', ?, ?, 'ok')")
        .run(Date.now(), Date.now()).lastInsertRowid);
      coreLedger(core).apply(events, { id: source, platform: "claude-code", kind: "export", seenAt: Date.now(), folder: dataDir });
    });
    // And the LLM warehouse's: every other tool's made-up sessions, tagged (the crowd's above among them).
    writeCrowdWarehouse(core);
  } finally {
    core.close();
  }
}
const madeUp = [...fixtures.map((f) => f.fixture.what), ...(crowd === "crowd" ? ["made-up LLM sessions", "the LLM warehouse's made-up sessions and tags"] : [])];

const archive = await Archive.open(dataDir, { stores });
try {
  // The made-up data went in beside the host's imports and the changesets, which push to the calendar: build it whole, every module's rows with it.
  archive.calendar.rebuild();
  console.log(`${crowd ? "Crowd data" : "Testing data"} folder ready: ${dataDir}`);
  console.log(`With ${madeUp.slice(0, -1).join(", ")} and ${madeUp.at(-1)}.`);
  console.log(`Run the archive's server on it with: LIFE_ARCHIVE_DATA=${dataDir} LIFE_ARCHIVE_URL=http://127.0.0.1:4651 npm start (friend-map's page at /friend-map/ of it)`);
} finally {
  archive.close();
  closeModuleStores(stores);
}
