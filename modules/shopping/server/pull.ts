// The Shopping page's pulls: every supplier asked at once (fetch.ts), the pull kept in the archive's folder, one file a
// pull (shopping/pulls/<when, UTC>.json, so the history grows by itself; nothing reads it but for the latest yet); the
// service the module offers (Shopping, module.ts's `services`), which pulls whenever the page's Refresh asks; and the
// mornings (module.ts's `work`), which pull through it each morning at 08:00 local time, and once at start when today
// has no pull and it is past then. A pull asked for while one runs waits for that one rather than starting another.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Clock, Context, Data, Deferred, Effect, Layer } from "effect";
import { addDays, dayKey, wallClock } from "../../../sdk/server.ts";
import { SHOPPING_FORMAT, type ShoppingAnswer, type ShoppingPull } from "../wire.ts";
import { pullSupplier, type FetchOptions } from "./fetch.ts";
import { readSuppliers, type Supplier } from "./suppliers.ts";

/** When the morning's pull runs, local time. */
export const MORNING = "08:00";

/** Suppliers asked at once. */
const SUPPLIERS_AT_ONCE = 5;

/** A pull could not be kept (the archive's folder not writable, say). */
export class ShoppingFailed extends Data.TaggedError("ShoppingFailed")<{ readonly message: string }> {}

/** Where the pulls are kept, in the archive's folder `dataDir`. */
export const pullsFolder = (dataDir: string) => join(dataDir, "shopping", "pulls");

/** The next morning's pull after `now`: today's at MORNING when it is still to come, else tomorrow's. */
export function nextMorning(now: number, at = MORNING): number {
  const today = wallClock(dayKey(now), at);
  return today > now ? today : wallClock(addDays(dayKey(now), 1), at);
}

/** Every supplier asked, as one pull (never failing: a supplier's failure is its part's). */
export const pullAll = (trigger: ShoppingPull["trigger"], suppliers: readonly Supplier[], options: FetchOptions = {}): Effect.Effect<ShoppingPull> =>
  Effect.gen(function* () {
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const pulled = yield* Effect.forEach(suppliers, (supplier) => pullSupplier(supplier, options), { concurrency: SUPPLIERS_AT_ONCE });
    const finishedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return { format: SHOPPING_FORMAT, startedAt, finishedAt, trigger, suppliers: pulled.map(({ part }) => part), specials: pulled.flatMap(({ specials }) => specials) };
  });

/** Keeps `pull` in `folder` (written whole, then moved into place), named for when it started. */
export const savePull = (folder: string, pull: ShoppingPull): Effect.Effect<void, ShoppingFailed> =>
  Effect.try({
    try: () => {
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `${pull.startedAt.replace(/:/g, "-")}.json`);
      writeFileSync(`${file}.partial`, `${JSON.stringify(pull)}\n`);
      renameSync(`${file}.partial`, file);
    },
    catch: (error) => new ShoppingFailed({ message: `could not keep the pull in ${folder}: ${(error as Error).message}` }),
  });

/** The latest pull kept in `folder` that this archive reads, or null when there is none. */
export function latestPull(folder: string): ShoppingPull | null {
  let files: string[];
  try {
    files = readdirSync(folder).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return null;
  }
  for (const name of files.reverse()) {
    try {
      const pull = JSON.parse(readFileSync(join(folder, name), "utf8")) as ShoppingPull;
      if (pull.format === SHOPPING_FORMAT) return pull;
    } catch {
      // A file that cannot be read is passed over for the one before it.
    }
  }
  return null;
}

/** The Shopping page's service: the latest pull, and a pull now (or the one running). */
export class Shopping extends Context.Service<Shopping, {
  readonly answer: Effect.Effect<ShoppingAnswer>;
  /** Pulls now, or waits for the pull already running; then the answer with it. */
  readonly pull: (trigger: ShoppingPull["trigger"]) => Effect.Effect<ShoppingAnswer, ShoppingFailed>;
}>()("life-archive/Shopping") {
  /**
   * The service for the archive kept at `dataDir`; a pull it starts is a fiber of the layer's scope, so one asked for
   * by a page closed mid-pull still finishes, and one running as the server stops is interrupted.
   */
  static readonly layer = (dataDir: string, options: ShoppingOptions = {}) => Layer.effect(Shopping, makeShopping(dataDir, options));
}

export interface ShoppingOptions extends FetchOptions {
  suppliers?: readonly Supplier[];
  log?: (line: string) => void;
}

export const makeShopping = Effect.fnUntraced(function* (dataDir: string, { suppliers = readSuppliers(dataDir), log = () => {}, ...fetchOptions }: ShoppingOptions) {
  const folder = pullsFolder(dataDir);
  const scope = yield* Effect.scope;
  let latest = latestPull(folder);
  let running: Deferred.Deferred<ShoppingPull, ShoppingFailed> | null = null;

  const answer = Effect.gen(function* () {
    return { pull: latest, pulling: running !== null, nextPullAt: new Date(nextMorning(yield* Clock.currentTimeMillis)).toISOString(), suppliers: suppliers.length } satisfies ShoppingAnswer;
  });

  /** The pull itself: asked, kept, said in the log. */
  const run = (trigger: ShoppingPull["trigger"]) =>
    Effect.gen(function* () {
      const pull = yield* pullAll(trigger, suppliers, fetchOptions);
      yield* savePull(folder, pull);
      latest = pull;
      const working = pull.suppliers.filter((part) => part.working).length;
      const down = pull.suppliers.filter((part) => !part.working).map((part) => `${part.name} (${part.note})`);
      log(`${trigger} pull: ${pull.specials.length} specials from ${working} of ${pull.suppliers.length} suppliers${down.length ? `; not working: ${down.join(", ")}` : ""}`);
      return pull;
    });

  const pull = (trigger: ShoppingPull["trigger"]) =>
    Effect.gen(function* () {
      let waiting = running;
      if (!waiting) {
        const started = (waiting = running = Deferred.makeUnsafe<ShoppingPull, ShoppingFailed>());
        // In the layer's scope, not the asker's: a page closed mid-pull leaves the pull to finish.
        yield* run(trigger).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              running = null;
            }).pipe(Effect.andThen(Deferred.done(started, exit))),
          ),
          Effect.forkIn(scope),
        );
      }
      yield* Deferred.await(waiting);
      return yield* answer;
    });

  return { answer, pull };
});

/**
 * The morning pulls, through the Shopping service (module.ts's `work`, a fiber the server interrupts as it stops):
 * today's at once when started past MORNING with no pull today, then each morning's. Nothing with no suppliers.
 */
export const mornings = (log: (line: string) => void = () => {}): Effect.Effect<void, never, Shopping> =>
  Effect.gen(function* () {
    const shopping = yield* Shopping;
    const { pull: latest, suppliers } = yield* shopping.answer;
    if (suppliers === 0) return;
    const pull = (trigger: ShoppingPull["trigger"]) => shopping.pull(trigger).pipe(Effect.asVoid, Effect.catch((failed) => Effect.sync(() => log(failed.message))));
    const now = yield* Clock.currentTimeMillis;
    // Started after this morning's pull time with no pull today: today's pull now.
    if ((!latest || dayKey(Date.parse(latest.startedAt)) !== dayKey(now)) && now >= wallClock(dayKey(now), MORNING)) yield* pull("catch-up");
    while (true) {
      const at = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(nextMorning(at) - at);
      yield* pull("daily");
    }
  });
