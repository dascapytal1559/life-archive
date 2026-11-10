// The console's half of the static demo's backend (sdk/demo.ts; docs/demo.md): the routes it answers live in the page
// with the server's own code over the made-up databases the build copied (the core's, the calendar and each module's),
// where the questions are open:
//
//   the Events tables and calendar   server/viewer/http.ts's viewerAnswers, over the core's tables and every module's
//                                    (each module's demo.ts, found by its place), with their owners
//   an LLM session's pages           server/viewer/content.ts's sessionPageAt for where a page starts, its turns from the
//                                    session's pages the server recorded (the session's words are in its files, which
//                                    the page does not read)
//
// and each module's own live routes (friend map's chat a Messages row opens, the Inspirations page's reads). Everything
// else is a recorded answer, the console's settings among them: the server recorded them as a fresh install's, so the
// demo shows the pages marked ready (src/pages.ts; tools/demo/record.ts).

import { coreOwners } from "../../server/calendar/owners.ts";
import { viewerReads } from "../../server/viewer/connection.ts";
import { sessionPageAt } from "../../server/viewer/content.ts";
import { viewerAnswers } from "../../server/viewer/http.ts";
import type { Reads } from "../../server/viewer/tab.ts";
import type { DemoContext, LiveRoute, ModuleDemo } from "../../sdk/demo.ts";
import { API_BASE, CALENDAR_DAYS_API, CONTENT_API, CONVERSATION_PAGE, type SessionPage } from "../wire.ts";

/** The made-up folder's own databases, as the build copies them. */
export const CORE_DATABASE = "core.sqlite";
export const CALENDAR_DATABASE = "calendar.sqlite";

const found = import.meta.glob<ModuleDemo>("../../modules/*/demo.ts", { eager: true, import: "default" });

/** Each installed module's half of the demo, by id (its folder's name). */
export const MODULE_DEMOS: ReadonlyMap<string, ModuleDemo> = new Map(Object.entries(found).map(([path, demo]) => [path.split("/").at(-2)!, demo]));

/** The viewer's reads over the made-up databases, made once: tab.ts's Reads, as server/viewer/connection.ts opens them. */
function readsOf(context: DemoContext): () => Promise<Reads> {
  let reads: Promise<Reads> | null = null;
  const open = async (): Promise<Reads> => {
    const core = viewerReads((await context.database(CORE_DATABASE)).sync);
    const calendar = viewerReads((await context.database(CALENDAR_DATABASE)).sync);
    const modules = new Map<string, import("node:sqlite").DatabaseSync>();
    const owners = new Map(coreOwners(core));
    for (const [id, demo] of MODULE_DEMOS) {
      if (demo.tablesRead) modules.set(id, viewerReads(await demo.tablesRead(context)));
      if (demo.owner) owners.set(id, await demo.owner(context));
    }
    return { core, calendar, modules, owners };
  };
  return () => (reads ??= open());
}

/** Every table's route (rows, volume, facets, a row) and the calendar's days. */
const TABLE_ROUTE = /^\/[a-z-]+\/(rows|volume|facets|row)$/;

/** An LLM session's recorded page at `offset` (a multiple of CONVERSATION_PAGE), as the server answered it. */
async function recordedPage(event: number, offset: number): Promise<SessionPage> {
  const response = await fetch(`${CONTENT_API}/llm/${event}/session?offset=${offset}`);
  if (!response.ok) throw new Error(`the demo has no page of session ${event} at ${offset}`);
  return (await response.json()) as SessionPage;
}

/** The console's live routes over `context`'s databases. */
export function consoleRoutes(context: DemoContext): LiveRoute[] {
  const reads = readsOf(context);
  const answer = viewerAnswers([...MODULE_DEMOS.values()].flatMap((demo) => demo.tabs ?? []));
  return [
    {
      matches: (url) => url.pathname === CALENDAR_DAYS_API || TABLE_ROUTE.test(url.pathname.slice(API_BASE.length)),
      answer: async (url) => answer(await reads(), url),
    },
    {
      matches: (url) => /^\/llm\/\d+\/session$/.test(url.pathname.slice(CONTENT_API.length)),
      answer: async (url) => {
        // A page the server was asked for as the demo was built (its offset a whole page's) is its recorded answer.
        const asked = url.searchParams.get("offset");
        if (asked !== null && /^\d+$/.test(asked) && Number(asked) % CONVERSATION_PAGE === 0) return undefined;
        const { core } = await reads();
        const { sessionEvent, offset, focus } = sessionPageAt(core, Number(url.pathname.split("/").at(-2)), url);
        const first = Math.floor(offset / CONVERSATION_PAGE) * CONVERSATION_PAGE;
        const pages = [await recordedPage(sessionEvent, first)];
        if (offset > first && first + CONVERSATION_PAGE < pages[0].total) pages.push(await recordedPage(sessionEvent, first + CONVERSATION_PAGE));
        const turns = pages.flatMap((page) => page.turns).slice(offset - first, offset - first + CONVERSATION_PAGE);
        return { session: pages[0].session, total: pages[0].total, offset, turns, focus } satisfies SessionPage;
      },
    },
    ...[...MODULE_DEMOS.values()].flatMap((demo) => demo.routes ?? []),
  ];
}
