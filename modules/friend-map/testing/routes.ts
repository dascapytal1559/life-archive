// friend map's routes as its tests serve them (testing/, a module's test helpers, which may use sdk/testing.ts): the
// module's route over a test's friend map, with the AI service a test gives Generate, and the viewer's routes.

import type { Reads } from "../../../sdk/server.ts";
import { aiAnswering, AiService, Context, moduleTabs, NO_AI, serve, viewerHandler as coreViewer, type Ai, type ApiHandler, type Modules } from "../../../sdk/testing.ts";
import friendMapModule from "../module.ts";
import type { FriendMap } from "../server/friendMap.ts";
import type { QueryModel } from "../server/queryWriter.ts";
import { friendMapRoute } from "../server/routes.ts";

/** The viewer's routes over the reads `reads` gives, the core's tables and friend map's, as the server lists them with the module on. */
export function viewerHandler(reads: () => Reads | Error): ApiHandler {
  return coreViewer(reads, moduleTabs({ on: [{ id: "friend-map", definition: friendMapModule }] } as unknown as Modules));
}

/** An AI service answering what `model` writes, as Codex answers aiQueryModel (JSON of the query and its parts). */
export const answering = (model: QueryModel): Ai => aiAnswering(model as (question: { system: string; prompt: string }) => Promise<unknown>);
export { answering as aiAnswering };

/** friend map's routes over `archive` (its contract at /api/archive, its page's API and the chats), Generate asking `ai`. */
export function archiveHandler(archive: FriendMap | Error, ai: Ai = NO_AI): ApiHandler {
  if (archive instanceof Error) return async (_req, res) => void res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: `the archive is not available: ${archive.message}` }));
  return serve(Context.make(AiService, ai), friendMapRoute(archive));
}
