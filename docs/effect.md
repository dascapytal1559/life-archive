# Writing Effect here

The archive is TypeScript and [Effect](https://effect.website) (`effect`, 4.x, pinned in package.json).
New server code is written in Effect; older code moves over in the order docs/effect-migration.md sets.
The examples are the live bridges' lock (`server/connectors/liveLock.ts`) and its test (`liveLock.test.ts`), the WhatsApp copy's retry (`modules/friend-map/connectors/whatsapp-db/macCalls.ts`), the sync runner (`server/connectors/sync.ts`: a restart ladder, a child process in a scope, commands answered through a `Deferred`), the agents' conversations' sync (`server/connectors/conversations.ts`: a watcher's changes as a Stream, gathered as they settle), the server's Layer (`server/serverLayer.ts`: every resource it opens, in order), the NAS backup (`server/archive/nasBackup.ts`: a lock and processes in a scope, hosts tried in turn) and the routes (`modules/friend-map/server/http.ts`, `server/viewer/http.ts`: a program per request, its errors in its type, the page's change stream a Stream).
Effect's own guide for agents is `node_modules/effect/CLAUDE.md`: it matches the installed version, so read it rather than the web, whose examples are often Effect 3.

## Generators

Write Effect code as `Effect.gen(function* () { ... })`, with `yield*` where async code would `await`.
A function that returns an Effect is `Effect.fn("name")(function* (...) { ... })` when it is worth a trace span, and `Effect.fnUntraced` otherwise.
Add retries, timeouts and error handling with `.pipe(...)` after the generator, not inside it.

Plain statements inside a generator are fine for work that cannot fail and does not wait (calling a callback, building a value).
Anything that can throw goes through `Effect.try`, and anything that returns a promise through `Effect.tryPromise` (or `Effect.promise` when a rejection is a bug, never an outcome).

## Errors

Inside Effect code, an expected failure is a tagged error, returned with `return yield* new SomeError({...})`, never thrown:

```ts
export class LiveLockError extends Data.TaggedError("LiveLockError")<{ readonly message: string }> {}
```

- Name it for what happened (`CopiesDiffer`, `LiveLockError`), and give it the fields a caller needs to decide or say what to do. A `message` field becomes the error's message.
- Handle it by tag: `Effect.catchTag("LiveLockError", ...)`. What nothing handles stays in the type, so the compiler lists what can go wrong.
- A thrown error, or a rejection from `Effect.promise`, is a defect: a bug, not an outcome. Defects are not retried.
- Use `Schema.TaggedError` instead once an error crosses a wire (an HTTP answer, a connector's stdout) and must be encoded.
- The routes' errors (`server/errors.ts`: `NotFoundError`, `InvalidInputError`, `UnavailableError`, `ForbiddenError`) are tagged errors made from their message alone (`new NotFoundError("no person 7")`), since the archive's rules, which stay plain, throw them. A subclass (`QueryError`, `UndoConflictError`) keeps its parent's tag, and so its status.

## Services and Layers

A shared resource (the archive's database, settings, the AI service, a clock) is a service, declared once and provided by a Layer:

```ts
export class Archive extends Context.Service<Archive, { readonly db: Db }>()("life-archive/Archive") {
  static readonly layer = (file: string) =>
    Layer.effect(Archive, Effect.acquireRelease(Effect.sync(() => ({ db: openArchive(file) })), ({ db }) => Effect.sync(() => db.close())));
}
```

- Code that needs it says so in its type (`Effect<A, E, Archive>`) and gets it with `yield* Archive`; a test provides a different Layer.
- Time comes from Effect's `Clock` (`Clock.currentTimeMillis`, `Clock.monotonicTimeNanos`, `Effect.sleep`), never `Date.now()`, `performance.now()` or `setTimeout`, so a test can move it with `TestClock`.
- The server's services are `ServerSettings` and `LoadedModules` (`server/serverLayer.ts`), `OpenArchive` (`server/archive/index.ts`: the archive, or why it could not be opened), `AiService` (`server/ai.ts`) and `ViewerDb` (`server/viewer/connection.ts`), beside which `RunsByHand` and `Exercise` (`server/modules/services.ts`) are those a module provides and another asks for optionally (`Effect.serviceOption`; `docs/modules.md`). The routes yield them (see "Routes"); code outside the server is still handed what it needs as arguments, as `makeLiveLock(db, ...)` is.
- A service whose resource is opened and closed gives a scoped opener (`OpenArchive.open`, `ViewerDb.open`: an `acquireRelease`), and the Layer that provides it decides what else happens around it (a log line, which folder).

## Retries and schedules

A retry, a backoff ladder or a loop that looks again later is a `Schedule`, never a counter and a `setTimeout`:

```ts
copyTwice.pipe(Effect.retry({ schedule: Schedule.spaced(pauseMs), times: attempts - 1 }))
lock.take.pipe(Effect.repeat({ schedule: Schedule.spaced(checkEveryMs), while: (waiting) => waiting !== null }))
```

- `Effect.retry` runs the effect once, then again on each typed failure while the schedule allows: `times: 2` is three tries in all. A retry that changes what it asks (the query writer sends the error back to the model) changes it in `tapError`, before the retry (`modules/friend-map/server/queryWriter.ts`).
- Effect 4 has no `Effect.orElse`: trying one thing, then another, is `Effect.catch(() => next)` (the NAS hosts in `reachNas`).
- `Effect.repeat` does the same on success, for polling and heartbeats.
- A ladder of growing waits (10 s, 1 min, 5 min, then every 30 min) is one shared schedule, `restartLadder` in `server/schedules.ts`; a run that went well before it stopped starts it over. Its owner steps it (`Schedule.toStep`) when it must record and say the wait before it sleeps, as the sync runner does.

## Resources and Scope

Anything opened (a database, a child process, a watcher, a lock, a temporary folder) is opened with `Effect.acquireRelease`, so it is closed however its scope ends: success, failure or interruption.

- A long-running loop is a fiber (`Effect.forkScoped` in Effect code). Stopping it is interrupting it, which runs its finalizers; there are no timers to clear.
- Interruption stops a fiber at its next wait. Work that must finish once begun is made `Effect.uninterruptible`.
- A promise does not stop when its fiber is interrupted: `Effect.tryPromise` lets it run on, unwatched. A step that must finish is `Effect.uninterruptible(Effect.tryPromise(...))` (`whole` in `server/connectors/contract.ts`); one that may be cut short takes the `AbortSignal` `tryPromise` hands it (the Matrix bridge's long poll).
- A child process is held with `spawnScoped` (`server/childProcess.ts`): closing its scope sends SIGTERM, then SIGKILL after 5 s, and waits for it. To keep what a process writes as it stops, read it in a fiber of its own and stop the process in a release that then waits for that fiber (the sync runner's `run`). A process with its own way to stop is held with `acquireRelease` around `watch` and `stopProcess(running, graceMs)` (Codex: its stdin closed first, 3 s of grace).
- What must happen when a process exits, whoever stopped it (failing the questions waiting on it), is a listener on the process, not a fiber in its scope: closing the scope interrupts its fibers before it stops the process.
- `Deferred.doneUnsafe` runs a fiber waiting on it on at once, inside the call: change the state that fiber will read before completing the Deferred, never after (`CodexService.end` in `server/ai.ts`).

## Where plain TypeScript meets Effect

During the move, plain code calls Effect code only through `server/effectRuntime.ts`:

- `runPromise(program)` runs a program to its end and resolves or rejects as an async function would, with the error itself, never wrapped.
- `runBackground(program)` starts a long-running program and returns its fiber; `runPromise(Fiber.interrupt(fiber))` stops it. A defect that ends it is thrown again outside, so it is never lost.
- `runMain(program)` is a command's edge (`server/nas-backup.ts`): it runs the program to its end, and SIGINT or SIGTERM interrupt it, so what it holds is let go (a process stopped, a lock, a file deleted) before the signal ends the process.
- A program run there needs nothing (its requirements are `never`); give it what it needs first.
- `ConnectorHost.startLive` and `stopLive` (`server/connectors/host.ts`), `SyncRunner.start` and `stop` (`server/connectors/sync.ts`) and `CodexService.start` and `stop` (`server/codex.ts`) show the shape: a plain class owns the fiber, and its plain callers see no change.

The server's edge is `server/main.ts`: it builds one `ManagedRuntime` from the server's Layer (`server/serverLayer.ts`), and SIGINT or SIGTERM dispose it, which closes every layer in the reverse of the order they were built. Each layer's resources are `acquireRelease`s in its scope; `Layer.provideMerge` chains the layers, so one is built only after those below it in the chain.
The routes run with the services of the Layer that serves them (`handler` in `server/jsonApi.ts`), not on the `ManagedRuntime` itself, which refuses to run anything once its disposal has begun: a request that comes while the live connectors stop is still answered, and the server ends its connections before the archive is closed.
The fibers that `runBackground` starts are not run on that runtime: a `ManagedRuntime` interrupts the fibers it ran, all at once, before it closes its Layer, and refuses to run anything once its disposal has begun. They stay owned by their plain classes, which the server's Layer stops in order.
The server keeps its SIGINT and SIGTERM listeners for the whole run (`process.on`, not `once`): Vite loads signal-exit, which sends a signal again to a process left with no other listener for it, and would end the server while it stops.
A connector's process is an edge of its own, `server/connectors/runtime.ts`: it runs the connector's history (a promise, or an Effect) or sync (an Effect), and interrupts sync on SIGTERM, SIGINT or its stdin ending.
Effect code never calls `Effect.runPromise` or `runSync` itself: it composes, and the edge runs (for a route, `serve`).

## Routes

Each route is an Effect program per request, a `Route<E, R>` (`server/jsonApi.ts`): it yields the services it reads (`OpenArchive`, `AiService`, `ViewerDb`), and `E` lists the route errors it answers.

```ts
export const archiveRoute: Route<RouteError, OpenArchive | AiService> = (req, res) =>
  Effect.gen(function* () {
    const { archive } = yield* OpenArchive;
    if (archive instanceof Error) return sendJson(res, 503, { error: `the archive is not available: ${archive.message}` });
    ...
    return yield* new NotFoundError(`no route ${method} ${url.pathname}`);
  }).pipe(answering(NotFoundError, InvalidInputError, UnavailableError, ForbiddenError));
```

- `serve(context, route)` turns it into node:http's handler, and is the one place a route error becomes its status (`STATUS` in `server/errors.ts`: 404, 400, 409, 403, with `{error: message}`); anything else is a bug, logged and answered 500. The server's Layer makes each handler with `handler(route)`, which runs it with the Layer's own services; a test serves it with a context of its own (`server/fixtures/routes.ts`).
- The archive's rules stay plain and throw route errors. `answering(...)` lifts the ones it names, thrown inside the program (or a promise's rejection with one, through `Effect.promise`), into its error channel; one it does not name stays a defect, answered 500. A route's own checks fail with `return yield* new InvalidInputError("...")`, never throw.
- Reading a body (`readJson`) and the same-site check (`fromOwnPage`) are Effects with their errors in their type; sending (`sendJson`) is a plain write.
- A route that keeps answering (the page's change stream, `/api/archive/events`) is a Stream written to the response, ended with `Stream.interruptWhen` once the response closes (the page gone, or the server ending its connections as it stops).
- node:http and the door's routing (`server/archive/server.ts`) stay as they are: Effect's `HttpRouter` and `HttpApi` are in `effect/unstable/http`. The Host guard (`server/allowedHosts.ts`) is plain: it only compares names.

## Testing

Tests of Effect code use `@effect/vitest`:

```ts
import { describe, expect, it } from "@effect/vitest";

it.effect("waits until staleAfterMs from when it first saw the heartbeat", () =>
  Effect.gen(function* () {
    expect(yield* lock.take).toMatchObject({ id: "elsewhere" });
    yield* TestClock.adjust(120_000);
    expect(yield* lock.take).toBeNull();
  }));
```

- `it.effect` runs on `TestClock`: time stands still until `TestClock.adjust` moves it, so a test of a two-minute wait takes no time and never flakes. `it.live` uses the real clock.
- Fork a loop under test with `Effect.forkChild(program, { startImmediately: true })`, as `runBackground` starts it, and interrupt it at the end.
- `Effect.flip` turns an expected failure into the value, to check its tag and fields.
- A test may drive real files and processes under `TestClock`: file work done synchronously runs in step with the clock (as the copies' lock in `server/connectors/sessionCopies.ts` does), while a real process needs real time to answer, given with `Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))` (`server/childProcess.test.ts`).
- Tests of plain code that calls Effect code through the boundary stay as they are.

## What stays plain TypeScript

- Pure functions: parsers, the query language, the people rules, formatting, anything that only computes. Effect adds nothing to a function that cannot fail and does not wait.
- Types: the contract shared with friend-map (`src/archive.ts`), which friend-map also reads.
- SQL through `node:sqlite`, which is synchronous: wrap a call in `Effect.try` where Effect code makes it, and leave the queries themselves alone.
- The viewer's React components (`viewer/`). At most its fetch layer (`viewer/api.ts`) may move.
- Importers and CLI commands, until a change touches one (phase E).
