// Exercise's server half (sdk/server.ts's defineModule): the first module with a store of its own. Its database
// (server/db.ts), which the core opens and keeps; its two connectors (connectors/polar, connectors/polar-export), which
// the core's host runs, their imports applied to that database (server/apply.ts) and the rows of what changed pushed
// into the core's calendar; its route (server/http.ts: the activities, a delete, the maps); the Exercise service the
// health module asks for (server/service.ts); its answers for its calendar rows and every row for the calendar's
// rebuild (server/calendar.ts); the Workouts table (server/workoutsTab.ts), which the Events
// page's Tables lists, and its editor (server/workoutEdits.ts: the captain's corrections, server/corrections.ts); its tools at the archive's MCP door (server/agents.ts: the activities over a range of days, and
// a week's five pillars); its made-up workouts for the testing data (fixtures/polar.ts); and its lines of the privacy policy
// (server/privacy.ts). The core finds this file by its place (server/modules/loader.ts)
// and loads it while the module is on. Its page half is viewer.tsx, its command cli.ts (`npm run exercise`, and `npm run
// map`); README.md says what the module is.

import { fileURLToPath } from "node:url";
import { defineModule } from "../../sdk/server.ts";
import { manifest as polarExport } from "./connectors/polar-export/manifest.ts";
import { manifest as polar } from "./connectors/polar/manifest.ts";
import { MADE_UP_ZONES, recentRuns, writeMadeUpPolar } from "./fixtures/polar.ts";
import { applyWorkouts, broughtWorkouts, connectorSettings } from "./server/apply.ts";
import { exerciseAgents } from "./server/agents.ts";
import { exerciseEvents } from "./server/calendar.ts";
import { EXERCISE, EXERCISE_DATABASE } from "./server/db.ts";
import { exerciseRoute } from "./server/http.ts";
import { EXERCISE_PRIVACY } from "./server/privacy.ts";
import { exerciseLayer } from "./server/service.ts";
import { SETTINGS_MOVE, writeExerciseSettings } from "./server/settings.ts";
import { workoutEditor } from "./server/workoutEdits.ts";
import { WORKOUTS } from "./server/workoutsTab.ts";
import { recordExercise } from "./server/demoRecord.ts";

/** A connector's main.ts, which the host runs in a process of its own. */
const main = (connector: string) => fileURLToPath(new URL(`./connectors/${connector}/main.ts`, import.meta.url));

export default defineModule({
  id: EXERCISE,
  sdk: 1,
  database: EXERCISE_DATABASE,
  connectors: {
    connectors: [{ manifest: polar, main: main("polar") }, { manifest: polarExport, main: main("polar-export") }],
    apply: applyWorkouts,
    settings: connectorSettings,
    brought: broughtWorkouts,
  },
  routes: (context) => exerciseRoute(context),
  services: ({ folder, db }) => exerciseLayer(folder, db),
  events: ({ db }) => exerciseEvents(db),
  agents: (context) => exerciseAgents(context),
  tabs: [WORKOUTS],
  edits: (context) => [workoutEditor(context)],
  fixtures: {
    what: "made-up Polar workouts, some in the weeks to today",
    // And the weekly targets (modules/exercise/exercise.json): zone 2's 300 minutes, three gym sessions and 20 minutes in
    // zones 4 and 5, so the testing folder's Fitness tabs count against them; and made-up zones to count by.
    write: async (dataDir, { db }) => {
      await writeMadeUpPolar(db, dataDir, { recent: recentRuns(Date.now()) });
      const settings = { zone2WeeklyMinutes: 300, liftWeeklySessions: 3, hiitWeeklyMinutes: 20, heartRateZones: MADE_UP_ZONES };
      await writeExerciseSettings(dataDir, `${JSON.stringify(settings, null, 2)}\n`);
    },
  },
  // Its settings, exercise.json at the archive's folder's root before modules kept their files in theirs (server/settings.ts).
  moves: [SETTINGS_MOVE],
  privacy: EXERCISE_PRIVACY,
  demo: { record: (recorder) => recordExercise(recorder) },
});
