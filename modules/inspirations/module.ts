// The inspirations' server half (sdk/server.ts's defineModule): the captain's saved things, each with his caption and
// his tags, and the AI's tags apart; a part of the core until 8 November 2026. Its database is its own
// (server/db.ts: modules/inspirations/inspirations.sqlite, its tables and its change log, taken over once from the
// core's core.sqlite, which keeps its copy), and so are its kept files (server/files.ts: modules/inspirations/files/).
//
//   database   its tables and its change log, and the take-over from the core (server/db.ts)
//   routes     the Inspirations page's routes and the share sheet's capture (server/http.ts), mounted at the address
//              they had while they were the core's (wire.ts's INSPIRATIONS_API, where the iPhone's Inspire shortcut
//              posts) as well as the module's own
//   work       the server's work on what a capture leaves waiting: previews and AI tags (the SDK's AiService;
//              server/worker.ts). It tells no one anything: his words are only kept, never read as a request
//   commands   npm run archive -- inspiration ... and inspiration-tag ... (server/cli.ts)
//   checkData  its problems, for npm run check-data (server/store.ts's inspirationProblems)
//   fixtures   its made-up data, for the testing data (fixtures/)
//   demo       what the static demo's build keeps of its routes' answers (its live reads are demo.ts)
//
// The core finds this file by its place (server/modules/loader.ts) and loads it while the module is on (settings.json's
// modules.inspirations, unfinished: docs/modules.md's "Ready pages"): switched off, nothing of it runs, its routes
// answer 404 to a GET (the share sheet's capture, a POST, 405), its commands are not offered and its page is not in the rail. Its page half is viewer.tsx; README.md says
// what the module is.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { AiService, defineModule, Effect } from "../../sdk/server.ts";
import { writeMadeUpInspirations } from "./fixtures/inspirations.ts";
import { INSPIRATION_HELP, INSPIRATION_OPTIONS, runInspirationCommand } from "./server/cli.ts";
import { INSPIRATIONS_DATABASE, INSPIRATIONS_DB } from "./server/db.ts";
import { INSPIRATIONS, inspirationsFolder, keepFile } from "./server/files.ts";
import { inspirationsRoute } from "./server/http.ts";
import { openInspirations } from "./server/part.ts";
import { inspirationProblems, Inspirations } from "./server/store.ts";
import { keepInspirations } from "./server/worker.ts";
import { INSPIRATIONS_API } from "./wire.ts";

const log = (line: string) => console.log(`[inspirations] ${line}`);

export default defineModule<AiService>({
  id: INSPIRATIONS,
  sdk: 1,
  database: INSPIRATIONS_DATABASE,
  routes: ({ db, folder }) => inspirationsRoute(openInspirations(db), inspirationsFolder(folder)),
  mounts: [INSPIRATIONS_API],
  work: ({ db, folder }) =>
    Effect.gen(function* () {
      const ai = yield* AiService;
      yield* keepInspirations({ store: openInspirations(db).store, folder: inspirationsFolder(folder) }, ai, { log });
    }),
  commands: {
    names: ["inspiration", "inspiration-tag"],
    options: INSPIRATION_OPTIONS,
    help: { structure: INSPIRATION_HELP },
    run: (command, args, values, context) => runInspirationCommand(command, args, values, context),
  },
  checkData: (db, folder) => inspirationProblems(db, inspirationsFolder(folder), existsSync),
  fixtures: {
    what: "made-up inspirations, for the Inspirations page",
    write: async (dataDir, { db }) => {
      const folder = inspirationsFolder(dataDir);
      await writeMadeUpInspirations(openInspirations(db).store, (bytes, name, mime) => keepFile(folder, Readable.from([bytes]), name, mime));
    },
  },
  demo: {
    record: async (recorder) => {
      await recorder.json(`${INSPIRATIONS_API}/changes?limit=40`);
      // Metadata alone: which kept images there are, to ask for each.
      const db = new DatabaseSync(join(inspirationsFolder(recorder.folder), INSPIRATIONS_DB), { readOnly: true });
      try {
        await Promise.all(new Inspirations(db).fileIds().map((id) => recorder.file(`${INSPIRATIONS_API}/files/${id}`)));
      } finally {
        db.close();
      }
    },
  },
  privacy: {
    metadata: [
      "the captain's inspirations, in full: each link and what is known of it, his caption, his tags and the AI's, every save and the kept files (`modules/inspirations/`; version 1, by the captain's call)",
    ],
  },
});
