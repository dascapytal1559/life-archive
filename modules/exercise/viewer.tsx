// Exercise's page half (sdk/viewer.ts): one aspect, Fitness (Exercise until the captain renamed it, "we're gonna change
// exercise to fitness"; the module keeps its id, exercise), and its two views: Activities, at the aspect's own address
// (viewer/ExerciseSection.tsx; an activity's page is the same view with ?activity=<id> in the address), and Bryan
// Johnson, Bryan Johnson's five pillars of exercise as a bar chart each (viewer/Pillars.tsx), once the Don't Die page
// beside Fitness, whose address opens it. Its other tab, Habits, is the rituals module's
// (modules/rituals/viewer/HabitViews.tsx), whose page folded into this one; so the old Exercise and Rituals addresses
// (/life-archive/dev/exercise, /life-archive/dev/rituals) are the aspect's former keys and open it. The core's
// page finds this file by its place (viewer/modules.ts) and shows the aspect in the rail, where the captain put it (the
// registry's RAIL names its key), while the module is on. The Workouts table is the server's (server/workoutsTab.ts):
// one of the tables the core's Events page lists in its Tables.

import { defineViewer } from "../../sdk/viewer.ts";
import { exerciseViews } from "./viewer/ExerciseSection.tsx";
import { pillarsViews } from "./viewer/Pillars.tsx";
import { FITNESS_ASPECT } from "./wire.ts";

export default defineViewer({
  aspects: [
    {
      key: FITNESS_ASPECT, label: "Fitness", icon: "exercise", formerKeys: ["exercise", "rituals"],
      blurb: "Every workout from every source, newest first, with the week's totals; each with its route, heart rate and splits; Bryan Johnson's five pillars week by week; and the weekly targets as rows of dots.",
    },
  ],
  views: [...exerciseViews(), ...pillarsViews()],
});
