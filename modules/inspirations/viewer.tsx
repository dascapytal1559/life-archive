// The inspirations module's page half (sdk/viewer.ts): the Inspirations aspect, and a view for each of its own tabs
// (viewer/InspirationsSection.tsx). The core's page finds this file by its place (viewer/modules.ts) and shows the aspect
// in the rail while the module is on.

import { defineViewer } from "../../sdk/viewer.ts";
import { INSPIRATIONS_ASPECT, inspirationsViews } from "./viewer/InspirationsSection.tsx";

export default defineViewer({
  aspects: [
    {
      key: INSPIRATIONS_ASPECT, label: "Inspirations", icon: "inspirations",
      blurb: "The things kept for the ideas in them, by what they are about.",
    },
  ],
  views: inspirationsViews(),
});
