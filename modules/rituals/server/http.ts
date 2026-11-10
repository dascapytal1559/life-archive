// The module's route (module.ts's `routes`; ../wire.ts for the addresses), under /life-archive/api/m/rituals:
//
//   GET /life-archive/api/m/rituals             -> RitualsAnswer: rituals' whole view, which no tab reads
//   GET /life-archive/api/m/rituals/dashboard   -> RitualsDashboardAnswer: what rituals' own dashboard served, which
//                                                  Daily rituals and Habits read (dashboard.ts)
//
// Each is read afresh from the store each time it is asked (view.ts), or says why there is none; always 200. Only
// read, and only from the page itself: the door's Host guard (server/allowedHosts.ts) and the tailnet's ACL decide
// who may ask, and another site's page may not.

import {
  answering, Context, Effect, ForbiddenError, fromOwnPage, NotFoundError, sendJson, serve, type ApiHandler, type ModuleContext, type ModuleLive, type Route,
} from "../../../sdk/server.ts";
import { RITUALS_API, RITUALS_DASHBOARD_API } from "../wire.ts";
import { ritualsDashboardAnswer } from "./dashboard.ts";
import { ritualsAnswer } from "./view.ts";

/** The module's route over what it is given (the archive's folder); `now`, for the tests, is the instant the view is read at. */
export const ritualsRoute = ({ folder }: ModuleContext & ModuleLive, { now }: { now?: () => number } = {}): Route<ForbiddenError | NotFoundError, never> => (req, res) =>
  Effect.gen(function* () {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "rituals are only read here" });
    yield* fromOwnPage(req);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === RITUALS_API) return sendJson(res, 200, yield* ritualsAnswer(folder, now?.()));
    if (path === RITUALS_DASHBOARD_API) return sendJson(res, 200, yield* ritualsDashboardAnswer(folder, now?.()));
    return yield* new NotFoundError(`the rituals module answers ${RITUALS_API} and ${RITUALS_DASHBOARD_API}, not ${path}`);
  }).pipe(answering(ForbiddenError, NotFoundError));

/** The route as node:http's handler, for the tests: over `context` (a testing life archive's module, sdk/testing.ts). */
export function createRitualsApi(context: ModuleContext & ModuleLive, options: { now?: () => number } = {}): ApiHandler {
  return serve(Context.empty(), ritualsRoute(context, options));
}
