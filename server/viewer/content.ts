// The viewer's conversations (viewer/wire.ts's CONTENT_API): the LLM session an event is in, opened from a row's drawer
// only when the captain asks for it ("Show the conversation"), a page at a time; the chat a message is in is friend
// map's, at CONTENT_API/messages/ (modules/friend-map/server/chat.ts), the same in every way. They are the only routes
// of the viewer's that read content, and read it only through its content paths (readLlmContent for a session), on
// the core's own connection (the viewer's cannot read content). Each page is kept in the trail of content reads (contentLog.ts) before it is
// answered, with the surface viewer: a chat as a read of the conversation from the message it was opened at, a
// session as a read of it (event-content) from the event it was opened at, every page one more read on that row
// (pages within FOLD_MS of each other fold into it), so the trail says what was opened and how far it was read.
//
//   GET CONTENT_API/llm/:event/session?offset=          -> SessionPage: from its start for a session, around the turn
//                                                         for a prompt or reply, then any page by its offset
//
// Who may ask is who may ask the viewer's other routes that answer content (Health, Rituals): a Host the door admits
// (allowedHosts.ts), the page itself (fromOwnPage), and on the tailnet only the devices its ACL admits.

import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { OpenArchive, type Archive } from "../archive/index.ts";
import { ContentMovedError, readLlmContent } from "../archive/llmContent.ts";
import { ForbiddenError, InvalidInputError, NotFoundError, UnavailableError } from "../errors.ts";
import { answering, fromOwnPage, sendJson, type Route } from "../jsonApi.ts";
import { LLM_APPS } from "../calendar/eventIndex.ts";
import { CONTENT_API, CONVERSATION_PAGE, type SessionPage } from "../../viewer/wire.ts";

type RouteErrors = NotFoundError | InvalidInputError | ForbiddenError | UnavailableError;

/** How many turns of a session come before the one it is opened at, so a reply is seen after its prompt. */
const TURNS_BEFORE = 2;

export function contentRoute(): Route<RouteErrors, OpenArchive> {
  return (req, res) =>
    Effect.gen(function* () {
      if (req.method !== "GET") return sendJson(res, 405, { error: "a conversation is only read" });
      yield* fromOwnPage(req);
      const { archive } = yield* OpenArchive;
      if (archive instanceof Error) return sendJson(res, 503, { error: `the archive is not available: ${archive.message}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.slice(CONTENT_API.length);
      let match: RegExpExecArray | null;
      if ((match = /^\/llm\/(\d+)\/session$/.exec(path))) return yield* session(archive, Number(match[1]), url, res);
      return yield* new NotFoundError(`no route GET ${url.pathname}`);
    }).pipe(answering(NotFoundError, InvalidInputError, ForbiddenError, UnavailableError));
}

/**
 * Where a page of the session event `id` is in starts, as `url` asks (see the top): the session's own event, the turn
 * the page starts at, its app (as its origin names it), and the turn to show first (a prompt or reply asked for with
 * no offset). Throws a route error for an event that is none, or an offset that is not one. Plain code over the core's
 * database, which the static demo runs in its page too.
 */
export function sessionPageAt(core: DatabaseSync, id: number, url: URL): { sessionEvent: number; offset: number; origin: string; focus: number | null } {
  const event = core
    .prepare(
      `SELECT e.id, e.origin, e.detail, t.session_id, t.byte_offset FROM event e LEFT JOIN llm_turn t ON e.detail = 'llm_turn' AND t.id = e.detail_id
       WHERE e.id = ?`,
    )
    .get(id) as { id: number; origin: string; detail: string; session_id: number | null; byte_offset: number | null } | undefined;
  if (!event) throw new NotFoundError(`there is no event ${id}`);
  if (event.detail !== "llm_session" && event.detail !== "llm_turn") throw new InvalidInputError(`event ${id} is not an LLM's session, prompt or reply`);
  const sessionEvent = event.detail === "llm_session"
    ? id
    : (core.prepare("SELECT id FROM event WHERE detail = 'llm_session' AND detail_id = ?").get(event.session_id) as { id: number }).id;
  const asked = url.searchParams.get("offset");
  if (asked !== null && !/^\d+$/.test(asked)) throw new InvalidInputError(`offset is a whole number, not ${JSON.stringify(asked)}`);
  const at = event.detail === "llm_session"
    ? null
    : (core.prepare("SELECT count(*) AS n FROM llm_turn WHERE session_id = ? AND byte_offset < ?").get(event.session_id, event.byte_offset) as { n: number }).n;
  const offset = asked !== null ? Number(asked) : Math.max(0, (at ?? 0) - TURNS_BEFORE);
  return { sessionEvent, offset, origin: event.origin, focus: asked === null && event.detail === "llm_turn" ? id : null };
}

const session = Effect.fnUntraced(function* (archive: Archive, id: number, url: URL, res: ServerResponse) {
  const { sessionEvent, offset, origin, focus } = sessionPageAt(archive.coreDb, id, url);
  const read = yield* Effect.try({
    try: () => readLlmContent(archive.coreDb, archive.host.dataDir, sessionEvent, { offset, limit: CONVERSATION_PAGE, parts: true })!,
    catch: (error) => error instanceof ContentMovedError ? new UnavailableError(error.message) : new InvalidInputError((error as Error).message),
  });
  archive.contentLog.record({ surface: "viewer", reader: null, what: "event-content", scope: { event: sessionEvent, kind: "llm_session", from: id === sessionEvent ? undefined : id } });
  sendJson(res, 200, {
    session: { event: sessionEvent, project: read.session.project, app: LLM_APPS[origin] ?? origin },
    total: read.total,
    offset: read.offset,
    turns: read.turns.map(({ event, role, at, model, images, parts }) => ({ event, role, at, model, images, parts: parts! })),
    focus,
  } satisfies SessionPage);
});

/** A page's cursor (`<ms>:<id>`, a ChatPage's before or after), or undefined when not given. */
const cursor = (url: URL, key: string): Effect.Effect<string | undefined, InvalidInputError> => {
  const value = url.searchParams.get(key);
  if (value === null) return Effect.succeed(undefined);
  return /^-?\d+:\d+$/.test(value) ? Effect.succeed(value) : Effect.fail(new InvalidInputError(`${key} is a page's cursor, <ms>:<id>, not ${JSON.stringify(value)}`));
};
