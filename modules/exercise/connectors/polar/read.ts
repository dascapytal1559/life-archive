// The polar connector: the captain's workouts from Polar Flow, through AccessLink (api.ts), for the module's index
// (server/workoutIndex.ts).
//
// A pass lists the exercises Polar has (those uploaded to Flow in the last 30 days, after he registered), and keeps a
// copy of each it has not kept yet, written once and never changed, in the archive's folder:
//   platform-exports/polar/accesslink/<exercise id>.json   the exercise as Polar gave it, with its samples, zones and route
//   platform-exports/polar/accesslink/<exercise id>.fit    its FIT file, when Polar has one (tried again each pass until then)
// The copies are content: the route says where he ran, and the samples his heart rate. The index gets one `workout`
// event of each copy (exercise.ts's workoutEvent), keyed on Polar's id, holding only what the copy holds and where:
// never a heart rate or a coordinate. A copy that is not an exercise this connector can read is never guessed at: it
// is counted (tally polar-copies-not-read) and left.
//
// Live, in the server (sync.ts, under the live connectors' lock): a pass when it starts and every 3 hours (its
// settings' pollEveryHours), each pass ending in a checkpoint (the cursor: each copy's id, its bytes and whether its
// FIT is kept) with only the events that changed: a pass that found nothing new is a checkpoint alone, so the
// connector's last good run is its last good pass, never the last one that brought something. Polar refusing the token (401) is "reconnect
// needed": it says so (logged-out) and asks Polar nothing more until the Keychain holds another token, looking each
// minute. `npm run archive -- import polar` is the same pass by hand, writing every copy's event again (nothing
// changes for one already there).
//
// A workout the captain deleted (the Fitness page's Delete; ../../server/deletedWorkouts.ts) is never kept again: the
// host hands its tombstones in the settings, and a pass neither fetches an exercise of one by its id nor keeps one it
// fetched that is the same activity as one, counting each (tally workouts-deleted).

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Duration, Effect } from "effect";
import { connectorError, whole, type Connector, type ConnectorError, type Emit, type WorkoutEvent } from "../../../../sdk/connector.ts";
import { dayKey, timeOfDay, writeOnce } from "../../../../sdk/server.ts";
import { DELETED_TALLY, deletedIn, isDeleted, type DeletedWorkout } from "../../server/deletedWorkouts.ts";
import { ACCESSLINK, accessLink, isFit, PolarRequestFailed, type PolarError } from "./api.ts";
import { workoutEvent, type PolarExercise } from "./exercise.ts";
import { manifest } from "./manifest.ts";
import { keychainSecrets, type PolarSecrets, type PolarSecretsError } from "./secrets.ts";
import { pollEveryMs } from "./settings.ts";

/** Where the copies are, in the media folder (the archive's platform-exports/). */
export const COPIES = join("polar", "accesslink");

/** How often, while the Keychain holds no token Polar takes, it looks for a new one (a login again). */
export const TOKEN_LOOK_EVERY_MS = 60_000;
/** How long after a pass that failed (Polar unreachable, say) it tries again, at most. */
export const RETRY_EVERY_MS = 15 * 60_000;

export const TALLIES = {
  /** Polar listed an exercise it then no longer had (404). */
  gone: "polar-exercises-gone",
  /** Polar listed an exercise under an id this archive will not name a file by. */
  oddId: "polar-ids-refused",
  /** An exercise Polar has no FIT file for, yet. */
  noFit: "polar-fit-missing",
  /** A copy that is not an exercise this connector can read. */
  unread: "polar-copies-not-read",
  /** An exercise the captain deleted, neither fetched nor kept. */
  deleted: DELETED_TALLY,
} as const;

/** What the last batch wrote: each copy's id, as `<bytes> <1 when its FIT is kept, else 0>`. */
export interface Cursor {
  copies: Record<string, string>;
}

/** A file name Polar's id may be: its ids are short hashes. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** No token yet, or one Polar refused: why, for the connector's state. */
class NotConnected extends Error {}

/** What a pass fetched: how many new copies, and the tallies. */
interface Fetched {
  copied: number;
  tallies: Partial<Record<keyof typeof TALLIES, number>>;
}

/**
 * Keeps a copy of each exercise Polar lists that the archive has no copy of yet (and each FIT file it lacks), but none
 * of a workout the captain deleted (`deleted`, the tombstones).
 */
export const fetchNew = (api: ReturnType<typeof accessLink>, dir: string, deleted: readonly DeletedWorkout[] = []): Effect.Effect<Fetched, PolarError | ConnectorError> =>
  Effect.gen(function* () {
    const fetched: Fetched = { copied: 0, tallies: {} };
    const count = (tally: keyof typeof TALLIES) => void (fetched.tallies[tally] = (fetched.tallies[tally] ?? 0) + 1);
    const listed = yield* api.exercises;
    yield* whole(() => mkdir(dir, { recursive: true }));
    for (const { id } of listed) {
      if (!SAFE_ID.test(id)) {
        count("oddId");
        continue;
      }
      if (deleted.some((gone) => gone.origin === ORIGIN && gone.id === id)) {
        count("deleted");
        continue;
      }
      const json = join(dir, `${id}.json`);
      if (!(yield* exists(json))) {
        const bytes = yield* api.exercise(id);
        if (bytes === null) {
          count("gone");
          continue;
        }
        // Kept only when it is the exercise asked for, so a page of something else is never kept as one.
        if (idOf(bytes) !== id) return yield* new PolarRequestFailed({ message: "Polar answered for an exercise with something that is not it" });
        // Nor when it is a deleted workout under an id of its own (another source's copy was deleted).
        if (deletedActivity(bytes, deleted)) {
          count("deleted");
          continue;
        }
        if (yield* whole(() => writeOnce(json, bytes))) fetched.copied++;
      }
      const fit = join(dir, `${id}.fit`);
      if (!(yield* exists(fit))) {
        const bytes = yield* api.fit(id);
        if (bytes === null || !isFit(bytes)) count("noFit");
        else yield* whole(() => writeOnce(fit, bytes));
      }
    }
    return fetched;
  });

/** The id of the exercise `bytes` hold, or null when they hold none. */
function idOf(bytes: Buffer): unknown {
  try {
    return (JSON.parse(bytes.toString("utf8")) as { id?: unknown } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** The polar connector's origin in the index: its platform's. */
const ORIGIN = manifest.platform;

/** Whether an exercise's `bytes` are the same activity as a deleted workout's; false when they cannot be read as one. */
function deletedActivity(bytes: Buffer, deleted: readonly DeletedWorkout[]): boolean {
  if (deleted.length === 0) return false;
  try {
    const event = workoutEvent(JSON.parse(bytes.toString("utf8")) as PolarExercise, { file: "", bytes: bytes.length });
    return isDeleted(deleted, { origin: ORIGIN, id: event.id, family: event.family, at: event.at, endAt: event.endAt });
  } catch {
    return false;
  }
}

const exists = (file: string) => whole(() => stat(file).then(() => true, () => false));

/** Every copy in `dir` as its event, oldest first (none of a deleted workout), and how many could not be read. */
export const copiedEvents = (dir: string, deleted: readonly DeletedWorkout[] = []): Effect.Effect<{ events: WorkoutEvent[]; unread: number }, ConnectorError> =>
  whole(async () => {
    const names = await readdir(dir).catch(() => [] as string[]);
    const events: WorkoutEvent[] = [];
    let unread = 0;
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const file = join(dir, name);
      const id = name.slice(0, -".json".length);
      try {
        const bytes = await readFile(file);
        const exercise = JSON.parse(bytes.toString("utf8")) as PolarExercise;
        if (exercise.id !== id) throw new Error("not the exercise its name says");
        const fit = join(dir, `${id}.fit`);
        const hasFit = await stat(fit).then(() => true, () => false);
        const event = workoutEvent(exercise, { file, ...(hasFit ? { fit } : {}), bytes: bytes.length });
        if (!isDeleted(deleted, { origin: ORIGIN, id: event.id, family: event.family, at: event.at, endAt: event.endAt })) events.push(event);
      } catch {
        unread++;
      }
    }
    return { events: events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), unread };
  });

/** Each event's stamp in the cursor. */
const stamp = (event: WorkoutEvent) => `${event.bytes} ${event.rawFile ? 1 : 0}`;

/** What changed since the cursor's copies: the events to write, and the next cursor. */
export function changesSince(events: readonly WorkoutEvent[], cursor: Cursor | null): { events: WorkoutEvent[]; cursor: Cursor } {
  const before = cursor?.copies ?? {};
  const now = Object.fromEntries(events.map((event) => [event.id, stamp(event)]));
  return { events: events.filter((event) => before[event.id] !== now[event.id]), cursor: { copies: now } };
}

/** The tallies of a pass, as events. */
const tallyEvents = (fetched: Fetched, unread: number) =>
  [...Object.entries(fetched.tallies), ["unread", unread] as const]
    .filter(([, n]) => (n as number) > 0)
    .map(([key, n]) => ({ kind: "tally" as const, name: TALLIES[key as keyof typeof TALLIES], count: n as number }));

/** The access token, or NotConnected; a secret the Keychain cannot give is the connector's error. */
const tokenOf = (secrets: PolarSecrets): Effect.Effect<string, ConnectorError | NotConnected> =>
  secrets.token.pipe(
    Effect.mapError((error: PolarSecretsError) => connectorError(new Error(error.message))),
    Effect.flatMap((token) => (token ? Effect.succeed(token.accessToken) : Effect.fail(new NotConnected("not connected yet: run npm run exercise -- polar login")))),
  );

/** The polar connector, its secrets from `secretsOf` (the Keychain, unless a test names others). */
export function polarConnector(secretsOf: (config: Record<string, unknown>) => PolarSecrets = (config) => keychainSecrets(config.keychain as string | undefined)): Connector {
  return {
    manifest,

    history: ({ sources, config, mediaDir, emit }) =>
      Effect.gen(function* () {
        const dir = join(mediaDir, COPIES);
        const token = yield* tokenOf(secretsOf(config)).pipe(Effect.mapError((error) => connectorError(error)));
        const deleted = deletedIn(config);
        const fetched = yield* fetchNew(accessLink(sources[0] ?? ACCESSLINK, token), dir, deleted).pipe(
          Effect.mapError((error) => (error._tag === "PolarUnauthorized" ? connectorError(new Error(`reconnect needed: ${error.message}; run npm run exercise -- polar login`)) : connectorError(error))),
        );
        const { events, unread } = yield* copiedEvents(dir, deleted);
        yield* write(emit, [...events, ...tallyEvents(fetched, unread)]);
      }),

    sync: ({ sources, config, mediaDir, emit, cursor }) =>
      Effect.gen(function* () {
        const dir = join(mediaDir, COPIES);
        const secrets = secretsOf(config);
        const every = pollEveryMs(config);
        // The tombstones as the sync started: a delete stops it and starts it again with the new ones (host.ts's pausingLive).
        const deleted = deletedIn(config);
        let last = (cursor as Cursor | null) ?? null;
        /** The token Polar last refused, asked with nothing more until the Keychain holds another. */
        let refused: string | null = null;
        let said: string | null = null;
        const say = (state: "connected" | "logged-out" | "error", detail: string) =>
          `${state}: ${detail}` === said
            ? Effect.void
            : whole(() => emit({ kind: "state", state, detail })).pipe(Effect.andThen(Effect.sync(() => void (said = `${state}: ${detail}`))));
        while (true) {
          const token = yield* Effect.result(tokenOf(secrets));
          let wait = every;
          if (token._tag === "Failure") {
            const error = token.failure;
            yield* error instanceof NotConnected ? say("logged-out", error.message) : say("error", error.message);
            wait = TOKEN_LOOK_EVERY_MS;
          } else if (token.success === refused) {
            wait = TOKEN_LOOK_EVERY_MS;
          } else {
            refused = null;
            const pass = yield* Effect.result(
              Effect.gen(function* () {
                const fetched = yield* fetchNew(accessLink(sources[0] ?? ACCESSLINK, token.success), dir, deleted);
                const { events, unread } = yield* copiedEvents(dir, deleted);
                return { fetched, events, unread };
              }),
            );
            if (pass._tag === "Failure") {
              const error = pass.failure;
              if (error._tag === "PolarUnauthorized") {
                refused = token.success;
                yield* say("logged-out", "reconnect needed: Polar refused the archive's token (401); run npm run exercise -- polar login");
                wait = TOKEN_LOOK_EVERY_MS;
              } else {
                yield* say("error", error.message);
                wait = Math.min(every, RETRY_EVERY_MS);
              }
            } else {
              const { fetched, events, unread } = pass.success;
              const changes = changesSince(events, last);
              const tallies = tallyEvents(fetched, unread);
              // A batch and its checkpoint, whole, so the cursor never runs ahead of what was applied; written every pass,
              // even empty, since the checkpoint is what tells the server the pass was good (connector_state.last_ok_at).
              yield* write(emit, [...changes.events, ...tallies, { kind: "checkpoint", cursor: changes.cursor }]);
              last = changes.cursor;
              const now = yield* Clock.currentTimeMillis;
              yield* say("connected", `last fetch ${dayKey(now)} ${timeOfDay(now)}, ${events.length} ${events.length === 1 ? "workout" : "workouts"} kept`);
            }
          }
          yield* Effect.sleep(Duration.millis(wait));
        }
      }),
  };
}

const write = (emit: Emit, events: Parameters<Emit>[0][]) =>
  whole(async () => {
    for (const event of events) await emit(event);
  });

export const polar = polarConnector();
