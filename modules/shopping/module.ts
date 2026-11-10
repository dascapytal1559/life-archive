// Shopping's server half (sdk/server.ts's defineModule): the Shopping page's route (server/http.ts), mounted at the
// address it had while it was a part of the core (wire.ts's SHOPPING_API) as well as the module's own; the Shopping
// service (server/pull.ts: the latest pull, and a pull now), which the route asks; its morning pulls (`work`, through
// that service); and its lines of the privacy policy. The core finds this file by its place (server/modules/loader.ts)
// and loads it while the module is on: switched off, nothing of it runs, its route answers 404 and its page is not in
// the rail. Its page half is viewer.tsx; README.md says what the module is.

import { defineModule } from "../../sdk/server.ts";
import { shoppingRoute } from "./server/http.ts";
import { mornings, Shopping } from "./server/pull.ts";
import { SHOPPING_API } from "./wire.ts";

const log = (line: string) => console.log(`[shopping] ${line}`);

export default defineModule<Shopping>({
  id: "shopping",
  sdk: 1,
  routes: () => shoppingRoute,
  mounts: [SHOPPING_API],
  services: ({ folder }) => Shopping.layer(folder, { log }),
  work: () => mornings(log),
  privacy: {
    metadata: [
      "the Shopping module's suppliers (`shopping/suppliers.json`: the shops the owner watches, each by its name and address) and its pulls (`shopping/pulls/`: what each shop listed on special in public, at what price, and when it was asked), read from the shops' public storefronts, never behind a sign-in",
    ],
  },
});
