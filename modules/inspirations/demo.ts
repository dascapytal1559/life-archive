// The inspirations module's half of the static demo (sdk/demo.ts's defineDemo; docs/demo.md): the Inspirations page's
// reads (the list, its tags, an item), answered live in the page with the server's own code (server/http.ts's
// inspirationsRead) over the made-up database the build copied. Everything else of theirs (their changes, their kept
// files) is a recorded answer, which module.ts's demo keeps as the demo is built.

import { defineDemo } from "../../sdk/demo.ts";
import { INSPIRATIONS_DB } from "./server/db.ts";
import { INSPIRATIONS } from "./server/files.ts";
import { inspirationsRead } from "./server/http.ts";
import { Inspirations } from "./server/store.ts";
import { INSPIRATIONS_API } from "./wire.ts";

const DATABASE = `modules/${INSPIRATIONS}/${INSPIRATIONS_DB}`;

export default defineDemo({
  routes: [
    {
      matches: (url) => url.pathname === INSPIRATIONS_API || url.pathname.startsWith(`${INSPIRATIONS_API}/`),
      answer: async (url, context) => inspirationsRead(new Inspirations((await context.database(DATABASE)).sync), url.pathname.slice(INSPIRATIONS_API.length) || "/", url),
    },
  ],
});
