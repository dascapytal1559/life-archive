// Rituals' server half (sdk/server.ts's defineModule): the fourth module, and the first whose store is its own code's.
// Its store is rituals' own SQLite database (src/store.ts: the reviewed migrations, the Python-compatible hashes, the
// audit), which bin/ritualctl writes, in modules/rituals/data/ of the archive's folder, and which this half reads
// in-process and read-only through rituals' own view (server/view.ts); it is not a database the core opens (that would
// put it in WAL mode and migrate it: rituals keeps its journal mode and runs its own migrations, `bin/ritualctl
// --migrate`). Its route (server/http.ts: the whole view, and what rituals' dashboard served); the RitualWorkouts and
// RitualHabits services the exercise module asks for (server/service.ts); its rows in the core's calendar and its answers for them
// (server/calendar.ts); the watch that keeps those rows in step with the store, which is written outside the server
// (server/watch.ts); the Rituals and Ritual days tables (server/habitsTab.ts, server/daysTab.ts), which the Events page's
// Tables lists, and their editor (server/edits.ts: a habit's day done or not, through ritualctl); its tools at the
// archive's MCP door (server/agents.ts: a day's standing, ritualctl's help, and its reads and writes through ritualctl,
// for the assistant that logs, which needs no path to this code); its made-up store for the testing data (fixtures/rituals.ts); its lines of the privacy policy (server/privacy.ts); and
// what the NAS backup takes of its folder (the store as a checked copy, never its own backups). The core finds this
// file by its place (server/modules/loader.ts) and loads it while the module is on. Its page half is viewer.tsx, its
// command cli.ts (`npm run rituals`); README.md says what the module is, and HANDOFF.md how it is written to.

import { defineModule } from "../../sdk/server.ts";
import { writeMadeUpRituals } from "./fixtures/rituals.ts";
import { ritualsAgents } from "./server/agents.ts";
import { ritualsEvents } from "./server/calendar.ts";
import { DAYS_TAB } from "./server/daysTab.ts";
import { ritualsEditors } from "./server/edits.ts";
import { HABITS_TAB } from "./server/habitsTab.ts";
import { ritualsRoute } from "./server/http.ts";
import { RITUALS_PRIVACY } from "./server/privacy.ts";
import { ritualsServices } from "./server/service.ts";
import { RITUALS, ritualsRoot, STORE_FILE } from "./server/view.ts";
import { ritualsWatch } from "./server/watch.ts";
import { RITUALS_API, RITUALS_DASHBOARD_API } from "./wire.ts";

export default defineModule({
  id: RITUALS,
  sdk: 1,
  routes: (context) => ritualsRoute(context),
  services: ({ folder }) => ritualsServices(folder),
  events: ({ folder }) => ritualsEvents(folder),
  agents: (context) => ritualsAgents(context),
  work: (context) => ritualsWatch(context),
  tabs: [HABITS_TAB, DAYS_TAB],
  edits: (context) => ritualsEditors(context),
  fixtures: {
    what: "a made-up rituals store, four weeks of evenings with their habit times and workouts, eight weeks of targets and four temporary items",
    write: (dataDir) => writeMadeUpRituals(ritualsRoot(dataDir)),
  },
  privacy: RITUALS_PRIVACY,
  backup: { databases: [STORE_FILE], exclude: ["data/backups"] },
  // The static demo keeps both of the route's answers (docs/demo.md); its calendar rows' drawers read the view (demo.ts).
  demo: { record: async (recorder) => void (await Promise.all([recorder.json(RITUALS_API), recorder.json(RITUALS_DASHBOARD_API)])) },
});
