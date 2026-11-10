// Shopping's page half (sdk/viewer.ts): the Shopping aspect, and its one view, On special (viewer/ShoppingSection.tsx).
// The core's page finds this file by its place (viewer/modules.ts) and shows the aspect in the rail while the module is on.

import { defineViewer } from "../../sdk/viewer.ts";
import { SHOPPING_ASPECT, shoppingViews } from "./viewer/ShoppingSection.tsx";

export default defineViewer({
  aspects: [
    {
      key: SHOPPING_ASPECT, label: "Shopping", icon: "shopping",
      blurb: "What the shops have on special: every supplier's specials in one place, pulled each morning.",
    },
  ],
  views: shoppingViews(),
});
