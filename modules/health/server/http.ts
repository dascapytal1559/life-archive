// The Health tab's one route, GET /life-archive/api/m/health (wire.ts's HEALTH_API: the module's address, where the core
// mounts it, server/modules/loader.ts): every result judged, graded and ordered (judge.ts), from the archive's
// folder's modules/health/ (or health/, where an archive kept them before; store.ts), and the highest heart rate a trusted recording holds, from the Exercise service
// (sdk/server.ts: the exercise module's, asked for optionally: with that module off there is no peak), read afresh each time. It is under the viewer's /life-archive/, which Tailscale Serve passes on to the
// tailnet, so the captain's phone reaches it; the core's door (its Host guard) and the tailnet's ACL decide who may
// ask, and another site's page may not.

import { answering, Context, dayKey, Effect, Exercise, ForbiddenError, fromOwnPage, NotFoundError, Option, sendJson, serve, type ApiHandler, type Peak, type Route } from "../../../sdk/server.ts";
import { HEALTH_API } from "../wire.ts";
import { healthAnswer } from "./judge.ts";
import { readLabIntervals } from "./labIntervals.ts";
import { BY_HAND_FILE, healthFileText, readByHand, readImported } from "./store.ts";

/** The route, for the archive kept at `dataDir`. */
export const healthRoute = (dataDir: string, { now = () => Date.now() }: { now?: () => number } = {}): Route<ForbiddenError | NotFoundError, never> => (req, res) =>
  Effect.gen(function* () {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "the health results are only read" });
    yield* fromOwnPage(req);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== HEALTH_API) return yield* new NotFoundError(`the health module answers only ${HEALTH_API}`);
    const byHand = yield* Effect.promise(() => readByHand(dataDir));
    if (byHand === null) return sendJson(res, 404, { error: `there are no health results in this archive: ${healthFileText(dataDir, BY_HAND_FILE)} names whose they are (docs/features.md's "Health")` });
    const exercise = yield* Effect.serviceOption(Exercise);
    const peak = Option.isSome(exercise) ? yield* exercise.value.peak : null;
    const [imported, labs] = yield* Effect.promise(() => Promise.all([readImported(dataDir), readLabIntervals(dataDir)]));
    sendJson(res, 200, healthAnswer({ byHand, imported, labs, today: dayKey(now()), peak, exercise: Option.isSome(exercise) }));
  }).pipe(answering(ForbiddenError, NotFoundError));

/** The route as node:http's handler, the Fitness page's highest heart rate `peak` (none unless given; `exercise` false, the module off), for the tests. */
export function createHealthApi(dataDir: string, { now, peak = null, exercise = true }: { now?: () => number; peak?: Peak | null; exercise?: boolean } = {}): ApiHandler {
  return serve(exercise ? Context.make(Exercise, { peak: Effect.succeed(peak) }) : Context.empty(), healthRoute(dataDir, { now }));
}
