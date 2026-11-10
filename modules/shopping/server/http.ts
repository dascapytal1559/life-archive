// The Shopping page's route, under the viewer's /life-archive/ (wire.ts's SHOPPING_API, the module's mount, and the
// module's own address), on this Mac and on the tailnet with the rest of the viewer:
//
//   GET  /life-archive/api/shopping   -> ShoppingAnswer: the latest pull, whether one is running, when the next is due
//   POST /life-archive/api/shopping   {} -> ShoppingAnswer once a pull now (or the one already running) is done
//
// A pull only reads the suppliers' public storefronts and writes into shopping/pulls/ in the archive's folder; even
// so, POST is the page's own alone (a JSON body, and an Origin naming this server), as every write of the viewer is.

import { Effect } from "effect";
import { ForbiddenError, fromOwnPage, InvalidInputError, moduleApi, NotFoundError, sendJson, UnavailableError, type Route } from "../../../sdk/server.ts";
import { SHOPPING_API } from "../wire.ts";
import { Shopping } from "./pull.ts";

/** Where the route answers: the page's address, and the module's own. */
const ADDRESSES: ReadonlySet<string> = new Set([SHOPPING_API, moduleApi("shopping")]);

export const shoppingRoute: Route<ForbiddenError | InvalidInputError | NotFoundError | UnavailableError, Shopping> = (req, res) =>
  Effect.gen(function* () {
    if (!ADDRESSES.has(new URL(req.url ?? "/", "http://localhost").pathname)) return yield* new NotFoundError(`the Shopping module answers only ${SHOPPING_API}`);
    yield* fromOwnPage(req);
    const shopping = yield* Shopping;
    if (req.method === "GET" || req.method === "HEAD") return sendJson(res, 200, yield* shopping.answer);
    if (req.method !== "POST") return sendJson(res, 405, { error: "the specials are read, or pulled again with POST" });
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return yield* new InvalidInputError("the body must be JSON (content-type: application/json)");
    if (req.headers.origin === undefined) return yield* new ForbiddenError("a pull is asked for from the Shopping page itself");
    const answer = yield* shopping.pull("refresh").pipe(Effect.mapError((failed) => new UnavailableError(failed.message)));
    sendJson(res, 200, answer);
  });
