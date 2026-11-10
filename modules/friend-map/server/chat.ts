// The chats the console opens, under viewer/wire.ts's CONTENT_API/messages, a mount of the module's route: the chat a
// message is in, opened from a Messages row's drawer only when the captain asks for it ("Show the chat"), a page at a
// time; and the Events calendar's day of chats (dayChats.ts): its chats by count, and a person's or a chat's messages
// that day, each opened by a click. Content is read through the archive's content path (content.ts's ArchiveContent) on
// the archive's own connection (the viewer's cannot read content). Each page of messages is kept in the core's trail
// of content reads before it is answered, with the surface viewer: a chat as a read of the conversation from the
// message it was opened at, a day as a day read of the person or the chat, every page one more read on that row (pages
// within FOLD_MS of each other fold into it), as the core's session route (server/viewer/content.ts) keeps its own.
// What a chat's page holds is contentReads.ts's chatRead, and a day's dayChats.ts's dayRead, which the static demo
// answers with too.
//
//   GET CONTENT_API/messages/:id/chat?before=|after=   -> ChatPage: around the message, then older or newer pages
//   GET CONTENT_API/messages/days/:day[/people/:id|/chats/:id]  -> a calendar day's chats, or one's messages (dayChats.ts)

import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTENT_API, Effect, ForbiddenError, fromOwnPage, InvalidInputError, NotFoundError, sendJson } from "../../../sdk/server.ts";
import { chatRead } from "./contentReads.ts";
import { dayRead } from "./dayChats.ts";
import type { FriendMap as Archive } from "./friendMap.ts";

/** Where the chats are opened: CONTENT_API's messages. */
export const CHAT_PATH = `${CONTENT_API}/messages`;

/** The path of the chat message `id` is in, under CHAT_PATH; null for a path that is not one. */
export const chatMessageOf = (pathname: string): number | null => {
  const match = /^\/(\d+)\/chat$/.exec(pathname.slice(CHAT_PATH.length));
  return match ? Number(match[1]) : null;
};

/** Answers a request under CHAT_PATH (its route errors thrown, for the module's route to answer). */
export const chatRoute = (archive: Archive, req: IncomingMessage, res: ServerResponse): Effect.Effect<void, NotFoundError | InvalidInputError | ForbiddenError> =>
  Effect.gen(function* () {
    if (req.method !== "GET") return sendJson(res, 405, { error: "a conversation is only read" });
    yield* fromOwnPage(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = chatMessageOf(url.pathname);
    if (id !== null) {
      const read = chatRead(archive.db, archive.content, id, url);
      archive.live.contentLog.record({ surface: "viewer", reader: null, what: read.what, scope: read.scope });
      return sendJson(res, 200, read.answer);
    }
    const day = dayRead(archive.db, archive.content, url.pathname.slice(CHAT_PATH.length), url);
    if (day === null) return yield* new NotFoundError(`no route GET ${url.pathname}`);
    if (day.read) archive.live.contentLog.record({ surface: "viewer", reader: null, ...day.read });
    sendJson(res, 200, day.answer);
  });
