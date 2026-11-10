// The module's route (module.ts's `routes`; ../wire.ts for the addresses), under /life-archive/api/m/exercise:
//
//   GET    .../activities          -> every activity, newest first, as its feed card
//   GET    .../activities/<id>     -> one activity in full: its route's shape, heart rate, zones and splits
//   GET    .../activities/<id>/playback -> its route whole, to replay in 3D (playback.ts); 409 when it has none (no
//                                  timed route, or its area's map not kept here)
//   DELETE .../activities/<id>     {start} -> every copy of it removed for good (delete.ts), when `start` is
//                                  still its start, so a page left open since deletes nothing else; 503, nothing
//                                  touched, while the archive is not available
//   GET    .../pillars             -> the Bryan Johnson tab's weekly targets (settings.ts) and each ritual day's
//                                  stretching statuses (RitualHabits, which the rituals module offers; null
//                                  with it off)
//   GET    .../map/...             -> the maps kept on this Mac, a tile or a font's glyphs (maps/http.ts)
//   GET    .../cesium/...          -> CesiumJS's build, for the playback's photorealistic city (cesium.ts)
//
// Read afresh each time (the module's reads, service.ts): the index's workouts in the module's own database, each
// origin's trust rule from its connector's settings, the runs transcribed by hand (RunsByHand, which the health module
// offers), the workouts logged in Rituals (RitualWorkouts, which the rituals module offers), the weekly zone 2 target
// and the heart-rate zones every activity's time in zones is counted by (settings.ts), and the maps kept on this Mac (maps/, which a route inside one is laid on); each copy's file is read
// once and what the page shows of it kept (activities.ts's copyReader), since a copy is never changed. Only from the
// page itself: the door's Host guard (server/allowedHosts.ts) and the tailnet's ACL decide who may ask, and another
// site's page may not; a delete must come with the page's Origin and a JSON body, as every write of the viewer's does.

import {
  answering, Clock, Context, dayKey, Effect, ForbiddenError, fromOwnPage, InvalidInputError, NotFoundError, Option, readJson, RitualHabits, sendJson, serve, UnavailableError,
  type ApiHandler, type HabitDay, type LoggedWorkout, type ModuleLive, type ModuleStore, type Route, type Run,
} from "../../../sdk/server.ts";
import {
  ACTIVITIES_API, CESIUM_URL, EXERCISE_API, MAP_API, PILLAR_HABITS, PILLARS_API, type ActivityDetail, type ActivitySummary, type DeleteActivity, type ExerciseAnswer, type PillarHabitDay,
  type PillarsAnswer, type Photoreal,
} from "../wire.ts";
import { deleteActivity } from "./delete.ts";
import { cesiumRoute } from "./cesium.ts";
import { mapRoute } from "./maps/http.ts";
import { Maps, mapStore } from "./maps/tiles.ts";
import { photorealSetting, readPlayback } from "./playback.ts";
import { exerciseLoader, ExerciseReads, exerciseReads } from "./service.ts";
import { heartRateZones, pillarTargets, zone2Target } from "./settings.ts";

/** The end of an activity's address that asks for its playback. */
const PLAYBACK = "/playback";

/** An activity as the feed shows it: its detail less what only its own page draws. */
export function summaryOf({ route: _route, heartRateSeries: _series, minHeartRate: _min, splits: _splits, link: _link, cannotDelete: _cannot, ...summary }: ActivityDetail): ActivitySummary {
  return summary;
}

/** A ritual day as the pillars read it: the pillars' habits' statuses alone. */
const pillarDay = ({ day, habits }: HabitDay): PillarHabitDay => ({ day, habits: Object.fromEntries(PILLAR_HABITS.filter((h) => h in habits).map((h) => [h, habits[h]])) });

/** The pillars' answer for the archive kept at `folder`, at `now`: its targets, and the ritual days from the rituals module while it offers them. */
export const pillarsAnswer = (folder: string, now: number): Effect.Effect<PillarsAnswer> =>
  Effect.gen(function* () {
    const targets = yield* Effect.promise(() => pillarTargets(folder));
    const offered = yield* Effect.serviceOption(RitualHabits);
    const habits = Option.isSome(offered) ? (yield* offered.value.days).map(pillarDay) : null;
    return { today: dayKey(now), targets, habits };
  });

type RouteErrors = ForbiddenError | NotFoundError | InvalidInputError | UnavailableError;

/** The module's route, over what it is given (its database, the archive's folder, the calendar and the live connectors). */
export const exerciseRoute = (
  { folder, db, calendar, pausingLive }: ModuleStore & ModuleLive,
  { now = () => Date.now(), photoreal = () => photorealSetting() }: { now?: () => number; photoreal?: () => Photoreal | null } = {},
): Route<RouteErrors, ExerciseReads | Maps> => {
  const map = mapRoute(folder);
  return (req, res) =>
    Effect.gen(function* () {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path.startsWith(`${MAP_API}/`)) return yield* map(req, res);
      if (path.startsWith(CESIUM_URL)) return yield* cesiumRoute(req, res);
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && method !== "DELETE") return sendJson(res, 405, { error: "the activities are only read, or one deleted" });
      yield* fromOwnPage(req);
      if (path === PILLARS_API) {
        if (method === "DELETE") return sendJson(res, 405, { error: "the pillars are only read" });
        return sendJson(res, 200, yield* pillarsAnswer(folder, now()));
      }
      if (path !== ACTIVITIES_API && !path.startsWith(`${ACTIVITIES_API}/`)) return yield* new NotFoundError(`the exercise module answers ${ACTIVITIES_API}, ${PILLARS_API} and ${MAP_API}, not ${path.slice(EXERCISE_API.length) || "/"}`);
      if (method === "DELETE") {
        // The page's own write: its Origin, which a browser sends with every one, and a JSON body.
        if (req.headers.origin === undefined) return yield* new ForbiddenError("an activity is deleted from the Fitness page itself");
        if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return yield* new InvalidInputError("the body must be JSON (content-type: application/json)");
      }
      const built = yield* (yield* ExerciseReads).activities;
      if (path === ACTIVITIES_API) {
        if (method === "DELETE") return sendJson(res, 405, { error: "one activity is deleted at a time, by its id" });
        const [target, zones] = yield* Effect.promise(() => Promise.all([zone2Target(folder), heartRateZones(folder)]));
        return sendJson(res, 200, { today: dayKey(now()), zone2Target: target, zones, activities: built.map((b) => summaryOf(b.detail)) } satisfies ExerciseAnswer);
      }
      const rest = path.slice(ACTIVITIES_API.length + 1);
      const playing = rest.endsWith(PLAYBACK);
      const id = decodeURIComponent(playing ? rest.slice(0, -PLAYBACK.length) : rest);
      const found = built.find((b) => b.detail.id === id);
      if (!found) return yield* new NotFoundError(`no activity ${id}: it may have been matched into another, or deleted, since`);
      if (playing) {
        if (method === "DELETE") return sendJson(res, 405, { error: "a playback is only read" });
        const maps = yield* Maps;
        const played = yield* readPlayback(folder, found.detail, found.playback, maps, photoreal());
        return "track" in played ? sendJson(res, 200, played.track) : sendJson(res, 409, { error: played.none });
      }
      if (method !== "DELETE") return sendJson(res, 200, found.detail);

      const body = (yield* readJson(req)) as Partial<DeleteActivity> | null;
      if (typeof body?.start !== "string") return yield* new InvalidInputError("say the activity's start, as its page shows it: {\"start\": \"YYYY-MM-DDTHH:MM\"}");
      if (body.start !== found.detail.start) return yield* new UnavailableError("this activity has changed since the page was opened, so nothing was deleted: open it again");
      return yield* deleteActivity({ db, folder, calendar, pausingLive }, found, yield* Clock.currentTimeMillis).pipe(
        Effect.map((deleted) => sendJson(res, 200, deleted)),
        Effect.catchTag("DeleteNotBegun", (error) => Effect.sync(() => sendJson(res, 503, { error: error.message }))),
      );
    }).pipe(answering(ForbiddenError, NotFoundError, InvalidInputError, UnavailableError));
};

/**
 * The route as node:http's handler, for the tests: over `context` (a testing life archive's module, sdk/testing.ts),
 * the runs by hand `byHand` (none unless given; `runs`, an Effect, when a test wants them to fail as health's do when
 * off), the workouts logged in Rituals `logged` (none unless given), and the ritual days `habits` as the rituals
 * module's RitualHabits gives them (not offered unless given, as with that module off), and the photorealistic city's
 * credentials `photoreal` (none unless given, never the .env.local's).
 */
export function createExerciseApi(
  context: ModuleStore & ModuleLive,
  { now, byHand = [], runs, logged = Effect.succeed([]), habits, photoreal = null }: { now?: () => number; photoreal?: Photoreal | null; byHand?: readonly Run[]; runs?: Effect.Effect<readonly Run[], Error>; logged?: Effect.Effect<readonly LoggedWorkout[]>; habits?: readonly HabitDay[] } = {},
): ApiHandler {
  const maps = mapStore(context.folder);
  const reads = exerciseReads(exerciseLoader(context.folder, runs ?? Effect.succeed(byHand), logged), context.db, maps);
  const services = Context.make(ExerciseReads, reads).pipe(Context.add(Maps, maps));
  return serve(habits ? services.pipe(Context.add(RitualHabits, { days: Effect.succeed(habits) })) : services, exerciseRoute(context, { now, photoreal: () => photoreal }));
}
