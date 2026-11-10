// Rituals' store, as the module reads it: in-process, through rituals' own read-only view (src/view.ts's readView, which
// opens data/ritual.sqlite3 with mode=ro as bin/ritual-view does, and gives every rule already applied: the 06:00
// cutoff, what applies on a day, how a check-in's time is known). The store is in the archive's folder, at
// modules/rituals/ (ritualsRoot: data/ritual.sqlite3 with its backups, exports and snapshots, and queue/), where
// bin/ritualctl writes it (its config/root, or RITUAL_ROOT, names that folder: README.md). Nothing here writes: the
// route (http.ts), the calendar's rows (calendar.ts), the workouts the Fitness page asks for (service.ts) and the
// watch that keeps the calendar in step (watch.ts) all read through readRituals.
//
// The view's shape is the wire's (../wire.ts): readRituals holds rituals' View to RitualsView, so a change to rituals'
// envelope (src/view.ts's VIEW_FORMAT) fails the typecheck here rather than on the page.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { describe } from "../src/errors.ts";
import { readView } from "../src/view.ts";
import type { RitualsAnswer, RitualsView } from "../wire.ts";

/** The module's id, which names its folder in modules/ of both the checkout and the archive's folder, and its rows in the calendar. */
export const RITUALS = "rituals";

/** The store, from rituals' root: rituals' own place for it. */
export const STORE_FILE = join("data", "ritual.sqlite3");

/** Rituals' root in the archive's folder `folder`: modules/rituals/, where ritualctl keeps its data/ and queue/. */
export const ritualsRoot = (folder: string): string => join(folder, "modules", RITUALS);

/** The store's file in the archive's folder `folder`. */
export const storeFile = (folder: string): string => join(ritualsRoot(folder), STORE_FILE);

/** Why there is no view: `unset` when the archive's folder has no rituals store, `failed` when rituals could not read it. */
export class RitualsUnavailable extends Data.TaggedError("RitualsUnavailable")<{ readonly state: "unset" | "failed"; readonly reason: string }> {}

/** Rituals' view of its store in `root` at `asOf` (ms; now when left out), through its own read-only view (its `options`, readView's); as the page reads it. */
export const viewOf = (root: string, asOf?: number, options?: { daysThroughActive?: boolean }): Effect.Effect<RitualsView, RitualsUnavailable> =>
  readView(root, asOf === undefined ? undefined : asOf * 1000, options).pipe(
    Effect.map((view) => view satisfies RitualsView),
    Effect.mapError((error) => new RitualsUnavailable({ state: "failed", reason: describe(error) })),
  );

/** Rituals' view for the archive kept at `folder` (with viewOf's `options`), or why there is none. */
export const readRituals = (folder: string, asOf?: number, options?: { daysThroughActive?: boolean }): Effect.Effect<RitualsView, RitualsUnavailable> =>
  Effect.suspend(() =>
    existsSync(storeFile(folder))
      ? viewOf(ritualsRoot(folder), asOf, options)
      : Effect.fail(new RitualsUnavailable({ state: "unset", reason: `this archive has no rituals store: modules/${RITUALS}/${STORE_FILE} is not in its folder` })),
  );

/** The whole view's route's answer for the archive kept at `folder`. */
export const ritualsAnswer = (folder: string, asOf?: number): Effect.Effect<RitualsAnswer> =>
  readRituals(folder, asOf).pipe(
    Effect.map((view): RitualsAnswer => ({ state: "ok", view })),
    Effect.catchTag("RitualsUnavailable", (error) => Effect.succeed<RitualsAnswer>({ state: error.state, reason: error.reason })),
  );

/**
 * The view now, read in one go (rituals reads its store in this thread, node:sqlite), for what the core asks in a plain
 * call: the calendar's rows and a row's drawer. Null with no store; throws when rituals could not read it, so a rebuild
 * on a broken store stops rather than forgets every row.
 */
export function readRitualsNow(folder: string, asOf?: number): RitualsView | null {
  const read = Effect.runSync(Effect.result(readRituals(folder, asOf)));
  if (read._tag === "Success") return read.success;
  if (read.failure.state === "unset") return null;
  throw new Error(`rituals' store could not be read: ${read.failure.reason}`);
}
