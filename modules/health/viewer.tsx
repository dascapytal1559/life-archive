// Health's page half (sdk/viewer.ts): the Health Record aspect, and one view under it for each of Health's own tabs
// (viewer/HealthSection.tsx), All first at the aspect's own address. The core's page finds this file by its place
// (viewer/modules.ts) and shows the aspect in the rail while the module is on.

import { defineViewer } from "../../sdk/viewer.ts";
import { HEALTH_ASPECT, healthViews } from "./viewer/HealthSection.tsx";

export default defineViewer({
  aspects: [
    {
      key: HEALTH_ASPECT, label: "Health Record", icon: "health",
      blurb: "Every result judged by one authority on range, the records that are no result, and the physical assessment.",
    },
  ],
  views: healthViews(),
});
