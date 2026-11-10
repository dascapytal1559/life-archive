// Friend map's half of the static demo (sdk/demo.ts's defineDemo; docs/demo.md): what the console's demo runs of this
// module's server in the page, over the made-up archive the build copied (modules/friend-map/archive.sqlite of the
// testing data): its tables, as the Events page's Tables opens them (the same list as module.ts's), its answers for its
// calendar rows, and the chat a Messages row's drawer opens. friend-map's own page has its own demo entry
// (page/demo/), which answers its people's messages with the same reads (contentRoutes).

import { defineDemo, type DemoContext, type LiveRoute } from "../../sdk/demo.ts";
import { friendMapOwner } from "./server/calendarRows.ts";
import { CHAT_PATH, chatMessageOf } from "./server/chat.ts";
import { ArchiveContent } from "./server/content.ts";
import { chatRead, contentRead } from "./server/contentReads.ts";
import { dayRead } from "./server/dayChats.ts";
import { withViews } from "./server/sqlRead.ts";
import { CALLS } from "./server/tabs/callsTab.ts";
import { HANGOUTS } from "./server/tabs/hangoutsTab.ts";
import { MESSAGES } from "./server/tabs/messagesTab.ts";
import { PEOPLE } from "./server/tabs/peopleTab.ts";
import { TAGS } from "./server/tabs/tagsTab.ts";

/** The made-up archive, as the build copies it from the testing data. */
export const DEMO_ARCHIVE = "modules/friend-map/archive.sqlite";

const withViewsOnce = new WeakMap<object, import("node:sqlite").DatabaseSync>();

/** The made-up archive's one connection, with the views and functions the viewer's has (sqlRead.ts's withViews). */
async function archiveOf(context: DemoContext): Promise<import("node:sqlite").DatabaseSync> {
  const opened = await context.database(DEMO_ARCHIVE);
  let db = withViewsOnce.get(opened);
  if (!db) withViewsOnce.set(opened, (db = withViews(opened.sync)));
  return db;
}

/** The archive's content path over the made-up archive (its attachments' files are none of the demo's). */
async function content(context: DemoContext): Promise<{ db: import("node:sqlite").DatabaseSync; content: ArchiveContent }> {
  const db = await archiveOf(context);
  return { db, content: new ArchiveContent(db, "/demo") };
}

/** The chat a Messages row's drawer opens, and the Events calendar's day of chats, under CHAT_PATH, as chat.ts answers them. */
const chat: LiveRoute = {
  matches: (url) => url.pathname.startsWith(`${CHAT_PATH}/`),
  answer: async (url, context) => {
    const id = chatMessageOf(url.pathname);
    const { db, content: reads } = await content(context);
    if (id !== null) return chatRead(db, reads, id, url).answer;
    return dayRead(db, reads, url.pathname.slice(CHAT_PATH.length), url)?.answer;
  },
};

/** friend-map's page's reads of content (a person's messages, a chat's pages, a day of them) under `prefix`, as http.ts answers them. */
export function contentRoutes(prefix: string): LiveRoute {
  return {
    matches: (url) => url.pathname.startsWith(prefix),
    answer: async (url, context) => contentRead((await content(context)).content, url.pathname.slice(prefix.length - 1), url)?.answer,
  };
}

export default defineDemo({
  tablesRead: archiveOf,
  tabs: [MESSAGES, CALLS, HANGOUTS, PEOPLE, TAGS],
  owner: async (context) => friendMapOwner(await archiveOf(context)),
  routes: [chat],
});
