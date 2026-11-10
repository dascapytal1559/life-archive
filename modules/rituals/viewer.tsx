// Rituals' page half (sdk/viewer.ts): no page of its own any more, two tabs on others' (viewer/HabitViews.tsx), the
// captain's ("we're gonna fold the rituals page into exercise and we're gonna change exercise to fitness"). Daily
// rituals is a tab on the core's Events page (/life-archive/dev/events/daily): every habit (magnesium, protein,
// stretches, the plank, journalling and winding down before midnight) and the temporary checks running now, today at the left and then every day
// before it fit to the width. Habits is a tab on the exercise module's Fitness page
// (/life-archive/dev/fitness/habits): the weekly targets but the fish one, a week a dot. The old
// Rituals page's address, /life-archive/dev/rituals, is one of Fitness's former keys, so it opens Fitness. The core's
// page finds this file by its place (viewer/modules.ts) and shows the two tabs while the module is on. The Rituals
// table, of each habit done, is the server's (server/habitsTab.ts): one of the tables the core's Events page lists in
// its Tables.

import { defineViewer } from "../../sdk/viewer.ts";
import { ritualsViews } from "./viewer/HabitViews.tsx";

export default defineViewer({
  aspects: [],
  views: ritualsViews(),
});
