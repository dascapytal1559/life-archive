// The module's services (module.ts's `services`, sdk/server.ts): what it offers the core and the other modules, and
// what its own route yields.
//
//   Exercise        the SDK's (server/modules/services.ts): the highest heart rate a trusted recording holds, which the
//                   health module asks for optionally, for its physical assessment
//   ExerciseReads   the module's own: every activity, worked out afresh each time from its index (workoutIndex.ts), its
//                   zones counted by the zones exercise.json sets (settings.ts, read each time), the
//                   runs transcribed by hand (RunsByHand, which the health module offers; asked for at each read, so
//                   with health off there are none) and the workouts logged in Rituals (RitualWorkouts, which the rituals
//                   module offers; none without it), each copy's file read once (activities.ts's
//                   copyReader), laid on the maps kept on this Mac (maps/tiles.ts: their files opened at the first
//                   request and closed as the server stops), and the maps themselves for the map route
//
// Both services ask for what they need of the other modules at request time, never as the Layer is built, so the
// modules' Layers need no order among themselves.

import type { DatabaseSync } from "node:sqlite";
import { Context, Effect, Exercise, Layer, Option, RitualWorkouts, RunsByHand, type LoggedWorkout, type Run } from "../../../sdk/server.ts";
import { exerciseActivities, copyReader, peakOf, type Built } from "./activities.ts";
import { Maps, mapStore, type MapRegion, type MapStore } from "./maps/tiles.ts";
import { heartRateZones } from "./settings.ts";
import { WorkoutIndex } from "./workoutIndex.ts";
import { trustRules } from "./workouts.ts";
import { readSettings } from "../connectors/polar/settings.ts";
import { join } from "node:path";

/** Every activity, its workouts read on `db`, each route laid on the one of `maps` that holds it. */
export type ExerciseLoader = (db: DatabaseSync, maps?: readonly MapRegion[]) => Effect.Effect<Built[]>;

/** The module's own reads, for its route (http.ts). */
export class ExerciseReads extends Context.Service<ExerciseReads, {
  /** Every activity, newest first, read afresh each time (each copy's file once, for as long as the server runs). */
  readonly activities: Effect.Effect<readonly Built[]>;
  /** The maps kept on this Mac. */
  readonly maps: MapStore;
}>()("life-archive/exercise/ExerciseReads") {}

/**
 * The loader of every activity of the archive kept at `dataDir`, the runs transcribed by hand from `byHand` and the
 * workouts logged in Rituals from `logged`, each copy read once by one reader for as long as the loader is kept. While
 * `byHand` fails, the activities are the other sources', and none can be deleted: a copy of one may be among those
 * runs, and a delete is whole or refused (delete.ts).
 */
export function exerciseLoader(dataDir: string, byHand: Effect.Effect<readonly Run[], Error>, logged: Effect.Effect<readonly LoggedWorkout[]> = Effect.succeed([])): ExerciseLoader {
  const read = copyReader(dataDir);
  return (db, maps = []) =>
    Effect.gen(function* () {
      const workouts = new WorkoutIndex(db).all();
      const rules = yield* Effect.promise(() => trustRulesOf(dataDir, [...new Set(workouts.map((w) => w.origin))]));
      const runs = yield* Effect.result(byHand);
      const logs = yield* logged;
      const zones = yield* Effect.promise(() => heartRateZones(dataDir));
      const built = yield* Effect.promise(() => exerciseActivities({ byHand: runs._tag === "Success" ? runs.success : [], workouts, rules, read, maps, logged: logs, zones }));
      if (runs._tag === "Failure") for (const b of built) b.detail.cannotDelete ??= `It cannot be deleted now, as not every copy of it can be known: ${runs.failure.message}.`;
      return built;
    });
}

/** Each origin's trust rules, from its connector's settings (data/connectors/<origin>.json); none where they are wrong. */
export async function trustRulesOf(dataDir: string, origins: string[]): Promise<Record<string, import("./workouts.ts").TrustRule[]>> {
  const rules: Record<string, import("./workouts.ts").TrustRule[]> = {};
  for (const origin of origins) {
    const found = trustRules(await readSettings(join(dataDir, "connectors", `${origin}.json`)).catch(() => ({})));
    if (found instanceof Error) console.error(`data/connectors/${origin}.json: ${found.message}; none of its heart rate is trusted until it is fixed`);
    rules[origin] = found instanceof Error ? [] : found;
  }
  return rules;
}

/** The runs transcribed by hand, from the health module when it is on; the error the page shows otherwise. */
const runsByHand: Effect.Effect<readonly Run[], Error> = Effect.serviceOption(RunsByHand).pipe(
  Effect.flatMap((offered) => (Option.isSome(offered) ? offered.value.runs : Effect.fail(new Error("the health module is off")))),
);

/** The workouts logged in Rituals, from the core while it offers them; none otherwise. */
const ritualWorkouts: Effect.Effect<readonly LoggedWorkout[]> = Effect.serviceOption(RitualWorkouts).pipe(
  Effect.flatMap((offered) => (Option.isSome(offered) ? offered.value.logged : Effect.succeed([]))),
);

/** The reads over `load`, the index on `db`, each route laid on `maps`' regions. */
export function exerciseReads(load: ExerciseLoader, db: DatabaseSync, maps: MapStore): ExerciseReads["Service"] {
  const activities = Effect.gen(function* () {
    const regions = yield* Effect.promise(() => maps.regions());
    return yield* load(db, regions);
  });
  return { activities, maps };
}

/** The Exercise service the SDK names, over `reads`: the peak. */
export function exerciseService(reads: ExerciseReads["Service"]): Exercise["Service"] {
  return { peak: Effect.map(reads.activities, peakOf) };
}

/**
 * The module's services as one Layer: its own reads over the archive kept at `folder` and the index on `db`, the maps
 * in the folder opened as asked and closed as the server stops (Maps too, for the map route), and the SDK's Exercise.
 */
export function exerciseLayer(folder: string, db: DatabaseSync): Layer.Layer<ExerciseReads | Exercise | Maps> {
  return Layer.effectContext(
    Effect.gen(function* () {
      const maps = yield* Effect.acquireRelease(Effect.sync(() => mapStore(folder)), (store) => Effect.promise(() => store.close()));
      const reads = exerciseReads(exerciseLoader(folder, runsByHand, ritualWorkouts), db, maps);
      return Context.make(ExerciseReads, reads).pipe(Context.add(Exercise, exerciseService(reads)), Context.add(Maps, maps));
    }),
  );
}
