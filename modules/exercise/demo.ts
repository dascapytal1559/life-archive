// The exercise module's half of the static demo (sdk/demo.ts's defineDemo; docs/demo.md): its Workouts table, as the
// Events page's Tables opens it (the same list as module.ts's), and its answers for its calendar rows, over the made-up
// index the build copied from the testing data. Its other routes (the activities, the playback, the maps) are
// answered from the server's recorded answers.

import { defineDemo } from "../../sdk/demo.ts";
import { exerciseEvents } from "./server/calendar.ts";
import { EXERCISE_DB } from "./server/db.ts";
import { WORKOUTS } from "./server/workoutsTab.ts";

const DATABASE = `modules/exercise/${EXERCISE_DB}`;

export default defineDemo({
  tablesRead: async (context) => (await context.database(DATABASE)).sync,
  tabs: [WORKOUTS],
  owner: async (context) => exerciseEvents((await context.database(DATABASE)).sync),
});
