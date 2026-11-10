// The rituals module's half of the static demo (sdk/demo.ts's defineDemo; docs/demo.md): its Rituals and Ritual days
// tables, as the Events page's Tables opens them (the same list as module.ts's), and its answers for its calendar rows, over rituals'
// view of the made-up store as the server answered it when the demo was built (RITUALS_API, a recorded answer): rituals
// reads its store in its own way (src/view.ts), which the page does not run.

import { defineDemo } from "../../sdk/demo.ts";
import { ritualsEventsOver } from "./server/calendar.ts";
import { DAYS_TAB } from "./server/daysTab.ts";
import { HABITS_TAB } from "./server/habitsTab.ts";
import { RITUALS_API, type RitualsAnswer } from "./wire.ts";

export default defineDemo({
  tabs: [HABITS_TAB, DAYS_TAB],
  owner: async () => {
    // Through the page's fetch, which the demo answers from what the server recorded.
    const answer = (await (await fetch(RITUALS_API)).json()) as RitualsAnswer;
    return ritualsEventsOver(() => (answer.state === "ok" ? answer.view : null));
  },
});
