// The module's services (module.ts's `services`, sdk/server.ts): what it offers the core and the other modules.
//
//   RitualWorkouts   the SDK's (server/modules/services.ts): the workouts the captain logged in Rituals, each read from
//                    the store's view (workouts.ts), which the exercise module asks for optionally and lays on the
//                    activity each is; none while there is no store, or it cannot be read (said in the server's log by
//                    the watch, watch.ts, not here)
//   RitualHabits     the SDK's too: how each day's habits stood, statuses alone (habitDays), which the exercise module's
//                    Bryan Johnson tab asks for optionally; none in the same cases
//
// Read afresh at each ask, never as the Layer is built, so the modules' Layers need no order among themselves.

import { Effect, Layer, RitualHabits, RitualWorkouts, type HabitDay, type LoggedWorkout } from "../../../sdk/server.ts";
import type { RitualsView } from "../wire.ts";
import { readRituals } from "./view.ts";
import { loggedWorkouts } from "./workouts.ts";

/** Each day the view shows, oldest first, with each habit's status and nothing else of its cell (a plank's m:ss, a label). */
export function habitDays(view: RitualsView): HabitDay[] {
  return view.daily.rows
    .map((row) => ({ day: row.date, habits: Object.fromEntries(Object.entries(row.cells).map(([habit, cell]) => [habit, cell.status])) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** What the view at `folder` gives, read afresh: `of` it, or `none` while there is no store or it cannot be read. */
const fromView = <A>(folder: string, of: (view: RitualsView) => A, none: A): Effect.Effect<A> =>
  readRituals(folder).pipe(
    Effect.map(of),
    Effect.catchTag("RitualsUnavailable", () => Effect.succeed(none)),
  );

/** The RitualWorkouts service over the store in the archive kept at `folder`. */
export const ritualWorkoutsLayer = (folder: string): Layer.Layer<RitualWorkouts> =>
  Layer.succeed(RitualWorkouts, { logged: fromView<readonly LoggedWorkout[]>(folder, loggedWorkouts, []) });

/** The RitualHabits service over the same store. */
export const ritualHabitsLayer = (folder: string): Layer.Layer<RitualHabits> =>
  Layer.succeed(RitualHabits, { days: fromView<readonly HabitDay[]>(folder, habitDays, []) });

/** Both, as the module offers them. */
export const ritualsServices = (folder: string): Layer.Layer<RitualWorkouts | RitualHabits> => Layer.mergeAll(ritualWorkoutsLayer(folder), ritualHabitsLayer(folder));
