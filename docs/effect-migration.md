# Moving the archive to Effect

The user's call (2026-10-16): "Yeah, let's start moving life archive to Effect."
The archive moves piece by piece, never in one rewrite: new server code is written in Effect, and older code moves in the phases below, where Effect earns its keep first.
How to write it is in docs/effect.md.

Each phase is its own task, merged on its own, with `npm test` and `npm run typecheck` passing and no change the user can see: the same timings, log lines, answers and stored rows.
Phases B to D change code the running server runs, so each ends with a restart of `local.life-archive` and a look at its log.

## What there is

About 199 TypeScript modules (tests aside), by what they do and how much Effect would add:

| Kind | Modules | What they hold | Effect adds |
| --- | --- | --- | --- |
| Live bridges' lock | `connectors/liveLock.ts`, the lock in `connectors/host.ts` | a lock in the archive with a heartbeat, a loop that waits for it | done (phase A) |
| Sync runner | `connectors/sync.ts` | one child process per sync connector, restarted after 10 s, 1 min, 5 min, then every 30 min; commands with a 90 s limit; SIGTERM then SIGKILL after 5 s | done (phase B) |
| Connector processes | `connectors/runtime.ts`, `conversations.ts`, `sessionCopies.ts`, `matrix-bridge/read.ts`, `grok-bot/`, `llm-sessions/`, `matrix-whatsapp/` | each sync connector's own process: a debounced file watcher with a rescan, a folder lock that waits, the bridge's polling and resends | done (phase B) |
| History imports | `connectors/host.ts` (`importHistory`, `run`) | a child process with a time limit and memory cap, its spool file, the backoff ladder stored as `retry_after` | the process and its time limit done (phase B); the rest stays plain |
| Server lifecycle | `main.ts`, `serverLayer.ts`, `archive/index.ts`, `archive/server.ts`, `dataHome.ts` | opening the archive, Vite, the HTTP server, the live bridges, the rules' timer; SIGINT and SIGTERM | done (phase C) |
| AI service | `ai.ts` and `codex.ts` (one file until 8 November 2026), `archive/queryWriter.ts` | Codex's app-server process, restarted on its own ladder, start and answer time limits; one retry of a query that does not run | done (phase C) |
| NAS backup | `archive/nasBackup.ts`, `nas-backup.ts`, `archive/backups.ts` | restic runs over sftp, a lock file taken over from a dead process, two hosts tried in turn | done (phase C); `backups.ts` stays plain |
| Child-process helpers | `archive/sqlQuery.ts` (a query in its own process, killed at its time limit: the server's last `setTimeout`), `connectors/iphoneBackup.ts`, `connectors/whatsapp-db/macCalls.ts` | | some, when touched (E) |
| HTTP routes | `archive/http.ts`, `viewer/http.ts`, `modules/health/server/http.ts`, `jsonApi.ts`, `errors.ts`, `allowedHosts.ts` | the routes friend-map and the viewer call, errors mapped to 400/403/404/409, the page's change stream (a look every second) | done (phase D); `allowedHosts.ts` and the door stay plain |
| The archive's rules and stores | `archive/people.ts`, `structure.ts`, `changes.ts`, `write.ts`, `edits.ts`, `tags.ts`, `query.ts`, `sqlRead.ts`, `db.ts` and the rest of `archive/` | synchronous SQL over `node:sqlite`, pure rules | little |
| Importers | each connector's `read.ts`, `metaDyi*.ts`, `zip.ts`, `protobuf.ts`, `contract.ts` | parsers of export files | little |
| Health results | `modules/health/server/` (`store.ts`, `judge.ts`, `ranges.ts`, `catalogue.ts`, `everlab.ts`, `import.ts`, `pdf.ts`) and `modules/health/cli.ts` | JSON files in the archive's folder read on each request, pure judging against ranges, an import that reads PDFs through one `swift` run | little: one child process in the import |
| CLI | `archive/cli.ts`, `check-data.ts`, `../tools/docs/docs.ts`, `fixtures/` | commands that run once | little |
| From friend-map | `src/archive.ts`, `fixtures/madeUpNames.ts` | the contract and the made-up names, this project's own since friend-map-frontend was retired | none: plain data and types |
| Helpers | `src/time.ts`, `calls.ts`, `catchUps.ts`, `identicon.ts` and the rest of `src/` | pure functions | none |
| Viewer | `viewer/` (React 19, Vite), its Health tab in `modules/health/viewer/` | the page | none, but for perhaps its fetch layer |

## The phases

The order first proposed stands, with one change: phase A converts the one retry that stands alone, and each backoff ladder moves with the code that owns it (the sync runner's in B, Codex's in C, the import backoff in B).
A ladder is a counter of failures read back from the archive (`connector_state.failures`, `retry_after`) inside an object's own timers; moved without its owner, it would be a Schedule used as a lookup table, which is Effect in name only.

The Health tab has landed (`modules/health/server/`, its route `/life-archive/api/m/health`, `modules/health/viewer/`). Where a phase now covers its files, the phase says so; no phase waits on it any more.

### A. Foundation, the live lock and one retry (done)

- **Modules:** `effect` and `@effect/vitest` (4.0.5, pinned); `docs/effect.md`, this plan, AGENTS.md's stack rule; `server/effectRuntime.ts` (the boundary); `connectors/liveLock.ts` (the lock and its heartbeat loop, `keepLiveBridges`); `connectors/host.ts` (`startLive`, `stopLive`); `connectors/whatsapp-db/macCalls.ts` (the copy taken until two passes agree, up to three times, 10 s apart).
- **What improves:** the lock's two timers, its options kept to tell a stale timer from a live one, and the `lockTimer` bookkeeping become one fiber that `stopLive` interrupts. Its times come from Effect's Clock, so `liveLock.test.ts` checks a two-minute staleness and a 20 s heartbeat in no time with TestClock.
- **Risk:** low. The live lock decides which process runs the bridges; a mistake would run them twice or not at all. `live.test.ts` runs two archives against one lock unchanged, and the server was restarted on it.
- **Tests:** `archive/live.test.ts` (unchanged), `connectors/liveLock.test.ts` (new), `whatsapp-mac-calls.test.ts` (unchanged).
- **Depends on:** nothing.

### B. The sync runner and the live connectors (done)

- **Modules:** `connectors/sync.ts`; the history import's child process in `connectors/host.ts` (`run`, `importHistory`'s backoff); the connector side: `connectors/runtime.ts`, `conversations.ts`, `sessionCopies.ts`, `matrix-bridge/read.ts`, `grok-bot/`, `llm-sessions/`.
- **What improves:** the restart ladder becomes one shared Schedule (10 s, 1 min, 5 min, then every 30 min), used by the sync runner here and by Codex in C. Each connector's child process is an `acquireRelease` (SIGTERM, then SIGKILL after 5 s) in the runner's scope, so stopping is interrupting. A command waiting for its result is a `Deferred` with a timeout. In each connector's process, `runtime.ts` becomes that process's edge (its own runtime). The watcher in `conversations.ts` (a settle delay and a rescan interval) becomes a debounced Stream. `sessionCopies.ts`'s folder lock (take it, or wait while its holder lives) becomes an `acquireRelease` with a Schedule.
- **Risk:** the highest. These run all day; a mistake loses messages or applies a batch twice. The batch, its checkpoint and its cursor must stay in one transaction, untouched. Sending stays off (`SENDING` in `archive/send.ts`); the command path still needs its tests.
- **Tests:** `sync.test.ts`, `host.test.ts`, `connectors.test.ts`, `archive/live.test.ts`, `matrix-bridge.test.ts`, `matrix-whatsapp.test.ts`, `llm-sessions.test.ts`, `grok-bot.test.ts`, `conversations.test.ts`, `sessionCopies.test.ts`, `overlap.test.ts`. Port timing tests to TestClock where they now wait in real time.
- **Depends on:** A. It may do C's first step (the server's runtime and the Archive service) first, if the runner wants the database as a service rather than an argument.
- **Packages:** none new. Child processes stay `node:child_process` in `acquireRelease`; `effect/unstable/process` (the ChildProcess modules, with `@effect/platform-node` for Node) is considered once it is no longer unstable.
- **Done:**
  - The ladder is `restartLadder` in `server/schedules.ts`, its input whether the run went well (a batch applied), which starts it over. The runner steps it (`Schedule.toStep`) rather than `Effect.retry`, since it records the failure and logs the wait before it sleeps.
  - `server/childProcess.ts` holds a process in a scope (`spawnScoped`, `stopProcess`: SIGTERM, SIGKILL after 5 s, waited for). The runner's `run` stops the connector in the release of the fiber reading it, then waits for that fiber, so a batch the connector finishes as it stops is still applied, as before. A run's start (its source row, the process) is uninterruptible, so no run is left begun with no process.
  - A command is a `Deferred` with `timeoutOrElse`; the host's history run (`run`) is a scoped process whose time limit is `timeoutOrElse`, still killed at once with SIGKILL. `importHistory` stays plain, its backoff (`backoffDelay`) a lookup of the stored failures: nothing in this process waits on it, so a Schedule would add nothing.
  - The connector contract changed: `sync` is an Effect, stopped by interruption (no `signal`), and a command's handler gives an Effect; `history` is a promise or an Effect until E moves the importers. `runtime.ts` is the connector process's edge and interrupts sync on SIGTERM, SIGINT or stdin ending; an answer to a command begun is finished.
  - `conversations.ts`: the watchers feed a Queue; `settled` gathers its changes until they settle (2 s, at most 10 s after the first), merged with the hourly rescan (`Schedule.fixed`) into one stream of passes run in turn; a pass begun is finished, with its checkpoint. `sessionCopies.ts`'s lock is `acquireUseRelease`, its waiting `Schedule.spaced` while under ten minutes; its few file calls are synchronous, which keeps them in step with `TestClock`.
  - `matrix-bridge/read.ts`: the long poll is interruptible (its `AbortSignal` from `tryPromise`); each answer with its checkpoint, and each room's walk, is taken in whole (`whole`), and it may stop between them, as it looked at its signal before. A send's wait for the bridge's word is a `Deferred` with a timeout, and its wait for the bridge's record a Schedule.
  - Tests: the listed ones pass, those that called a connector's sync or history directly now run its Effect; the copies' lock, the ladder, the stop of a process and the watcher's settling run on `TestClock`; two new sync tests stop a connector mid-batch, cut short and finished as it stops, and check that no batch is half applied or applied twice.
  - C's first step was not needed: the runner is handed the database, as before.
- **Learned for C:**
  - `Effect.tryPromise` does not wait for its promise when interrupted. Wrap promise work that must finish in `Effect.uninterruptible`, or it runs on unwatched (with a database closed under it, say).
  - Codex's restart ladder is `restartLadder` with `ranWell` set when an answer came back (it resets `failures` there now); its process is `spawnScoped`, but its stop waits 3 s, not 5: `stopProcess(running, 3000)`. restic's runs are scoped processes too.
  - A plain class owning a fiber (`SyncRunner`, `ConnectorHost`) is the seam between the server's plain code and Effect until `main.ts` moves; with C's runtime, `runBackground` runs on it unchanged.
  - `Effect.repeat({ schedule, until })` gives back the last value, so a loop that looks until something is ready is one `repeat`.

### C. The server's lifecycle, the AI service and the NAS backup (done)

- **Modules:** `main.ts`, `archive/index.ts` (the `Archive` class, its rules' timer), `archive/server.ts`, `dataHome.ts`; `ai.ts`, `archive/queryWriter.ts`; `archive/nasBackup.ts`, `nas-backup.ts`, `archive/backups.ts`.
- **What improves:** `main.ts` builds one `ManagedRuntime` from the server's Layer: the archive's folder and settings (config), the open archive (a service, closed last), the AI service, the live bridges, Vite and the HTTP server, each a scoped resource. SIGINT and SIGTERM dispose the runtime, which closes them in reverse order (no hand-written `Promise.all` before `process.exit`). `effectRuntime.ts` runs on this runtime from then on, as docs/effect.md says. Codex's restart ladder uses B's Schedule, its start and answer limits become `Effect.timeout`, and its process is scoped. The NAS backup's lock is an `acquireRelease`; trying each of `nasBackup.hosts` in turn is `Effect.orElse`; each restic run is a scoped child process.
- **Risk:** medium. A mistake at startup is seen at once (the server does not answer); one at shutdown leaves a child process or a WAL behind. Restart the agent and read `/tmp/life-archive-server.log`. Run `npm run nas-backup -- --dry-run` and `verify`, never a real night by hand.
- **Tests:** `ai.test.ts`, `queryWriter.test.ts`, `archive/server.test.ts`, `live.test.ts`, `nasBackup.test.ts`, `backups.test.ts`, `dataHome.test.ts`.
- **Depends on:** A; after B, the live bridges are one more scoped Layer.
- **Health:** `main.ts` hands the server the Health route (`createHealthApi`); it opens nothing and runs nothing in the background, so it moves as one more handler.
- **Packages:** `@effect/platform-node` (`NodeRuntime.runMain` for the scripts' edges) only if it removes more than it adds.
- **Done:**
  - `server/serverLayer.ts` is the server as one Layer, its layers chained with `Layer.provideMerge` in the order the server starts: `ServerSettings` (the folder, where it answers, the Host names it admits, from `dataHome.ts`, which stays plain), the backups' prune, `OpenArchive` (the archive, or why it could not be opened), `AiService`, `ViewerDb` (the viewer's connection, opened at its first request), the HTTP server with Vite, then the live connectors. `main.ts` builds one `ManagedRuntime` from it; SIGINT and SIGTERM dispose it, which closes them in the reverse order: the live connectors stopped and their lock let go, the server stops listening and ends its connections, Vite closes (its hot reload's sockets with it), the server has closed, the viewer's connection, Codex, and the archive last, so its WAL is checkpointed and removed. Before, nothing was closed but the live connectors, Codex and Vite, at once, and the WAL stayed. A port already taken is said as before, then what was opened is closed and it exits 1.
  - The same startup lines in the same order, the same routes and Host guard, Health refused through a proxy, and Vite's `fs.strict` and allow list unchanged: a server of this branch and one of `main` answered alike on the testing data.
  - `ai.ts` (Codex's half is `codex.ts` now): Codex is one fiber (`keep`) owned by `CodexService`, as `SyncRunner` owns its runner; each run of Codex is a scope holding its process (its stdin closed, SIGTERM, SIGKILL after 3 s); the restart ladder is `restartLadder`, its `ranWell` an answer having come back; the start and answer limits are `timeoutOrElse`; a request, a turn and the next start are `Deferred`s. A question while it waits to start again cuts the wait short, as before. One change at the edge: a question to a service that was stopped (or never started) is answered "the Codex service is stopped" at once, instead of starting Codex for it.
  - `archive/queryWriter.ts`: the one retry of a query that does not run is `Effect.retry({ times: 1 })`, the error added to the prompt in `tapError`.
  - `archive/index.ts`: the rules' run after sync batches is a fiber that sleeps on the Clock (`runRulesSoon`); `stopLive` and `close` interrupt it.
  - `archive/nasBackup.ts`: `runNasBackup`, `verifyNasBackup` and `initRepository` are Effects; the staging folder's lock is an `acquireRelease`, as are the database copy's and the restored copy's deletion; every ssh, security and restic run is a `spawnScoped` process; `reachNas` tries the hosts in turn with `Effect.catch` (Effect 4 has no `orElse`). Its errors are `NasBackupError` and `RunFailed` (with restic's exit code). `nas-backup.ts` runs the command with `runMain` (in `effectRuntime.ts`, not `@effect/platform-node`, which would add a package for a dozen lines): a signal stops restic, deletes the copy and lets the lock go before the process ends as the signal would end it, where before the lock and a full copy of the database were left until the next run.
  - `archive/backups.ts` stays plain: synchronous SQLite and a few file calls that do not wait, which the server's prune and the NAS backup call.
  - Tests: `queryWriter.test.ts`, `server.test.ts`, `live.test.ts`, `backups.test.ts`, `dataHome.test.ts` unchanged; `ai.test.ts` with one new test (a question cut short by the service's stop is answered, not left waiting); `nasBackup.test.ts` runs the Effects, with two new tests (a run stopped while restic backs up leaves no process, copy or lock; the hosts are each tried and named); `main.test.ts` (new) starts `main.ts` on a made-up archive with a live connector and a stand-in Codex, sends SIGTERM, and finds no child process, no live bridges' lock, no WAL and no listener left, and exits 1 cleanly when its port is taken.
  - NAS backup checked on the real NAS with `npm run nas-backup -- --dry-run` alone, on made-up data (nothing written), with an unreachable `--host`, and stopped by SIGTERM mid-run; `verify` restores the real newest database into the folder it runs on, so it was run against test repositories only, never from a worktree.
- **Learned for D:**
  - The fibers `runBackground` starts are not run on the server's `ManagedRuntime`, against what this plan first said: a `ManagedRuntime` interrupts every fiber it ran, at once, before it closes its Layer, and refuses to run anything once disposal has begun, so `stopLive` run on it while it stops would die. The plain classes keep their fibers on the default runtime, and the Layer stops them in order. D's handlers, which need the server's services, are the first programs to run on the runtime itself: run each request with `runtime.runPromise` (or with the context `runtime.context()` gives, via `Effect.runPromiseWith`), and stop the HTTP server before the runtime is disposed, as the Layer's order already does.
  - `Deferred.doneUnsafe` resumes a waiting fiber inside the call: set the state it reads first.
  - Vite loads signal-exit, which sends a signal again to a process left with no other listener: keep the server's signal listeners with `process.on`.
  - What must happen whatever stops a process belongs on the process's `close` listener: a fiber forked in its scope is interrupted before the process is stopped.

### D. HTTP routes and their errors (done)

- **Modules:** `archive/http.ts`, `viewer/http.ts`, `modules/health/server/http.ts`, `jsonApi.ts`, `errors.ts`, `allowedHosts.ts`, `archive/server.ts`.
- **What improves:** each handler is an Effect program run by C's runtime. `NotFoundError`, `InvalidInputError`, `UnavailableError` and `ForbiddenError` become tagged errors, mapped to 404, 400, 409 and 403 in one place, as now, and a handler's type lists what it can answer. The change stream (`streamChanges`, a `setInterval` per page) becomes a Stream, ended by the page closing it.
- **Risk:** medium. friend-map reads every route; the contract (`src/archive.ts`) does not change, and the route tests hold it. Keep `node:http` and the routing as they are: Effect's `HttpRouter` and `HttpApi` are in `effect/unstable/http`, which may change between minor versions.
- **Tests:** `archive/http.test.ts`, `changesHttp.test.ts`, `queryHttp.test.ts`, `archive/server.test.ts`, `viewer/viewer.test.ts`, `allowedHosts.test.ts`.
- **Depends on:** C (the runtime): run each handler with the server's `ManagedRuntime`, never through `effectRuntime.ts`'s `runPromise`, so the services (`OpenArchive`, `AiService`, `ViewerDb`, `ServerSettings`) are in reach.
- **Health:** its route (`/life-archive/api/m/health`, on the tailnet with the rest of the viewer, refused to another site's page and to a write) moves with the rest; `health.test.ts` holds its refusals.
- **Done:**
  - `server/errors.ts`: the four errors are tagged errors (`Data.TaggedError`), still made from their message alone, as the plain rules throw them (every one of those throws unchanged); a subclass (`QueryError`, `UndoConflictError`) keeps its parent's tag. `STATUS` maps each tag to 404, 400, 409 or 403.
  - `server/jsonApi.ts`: a route is `Route<E, R>`, an Effect program per request whose `E` lists the route errors it answers and whose `R` names the services it reads. `serve(context, route)` is node:http's handler and the one place errors become statuses (anything else logged and answered 500, as before); `handler(route)` makes one with the services of the Effect that asks for it. `answering(...classes)` lifts the route errors plain code throws into the program's type, and leaves any other a defect, so each route answers exactly the errors it answered before (the viewer never answered 409, Health only 403). `readJson` and `fromOwnPage` are Effects.
  - `archive/http.ts`: `archiveRoute` (`Route<RouteError, OpenArchive | AiService>`) yields the archive and the AI service; its own checks fail by tag instead of throwing; `revealed` catches a query that does not run with `catchTag`. The change stream is `changeEvents`, a Stream (`Stream.tick` every second, the versions compared with `mapAccum`), written to the response until it closes (`Stream.interruptWhen`); the request's program ends with it, where the `setInterval` before was cleared by a listener. `viewer/http.ts`: `viewerRoute()` (its tabs' memos made with it) yields `ViewerDb`. `modules/health/server/http.ts`, converted last and kept to a minimal edit for the Health work beside it: `createHealthApi` keeps its signature and serves a program answering only `ForbiddenError`, still handed its folder.
  - `serverLayer.ts`: the HTTP layer makes the archive's and the viewer's handlers with `handler`, so they run with the layer's services: the archive, the AI service and the viewer's connection. Not on the `ManagedRuntime`, as this plan first said: it refuses to run anything once its disposal has begun, and requests still come while the live connectors stop; run with the layer's services, they are answered until the server stops listening and ends its connections (each change stream with them), before the archive is closed.
  - The generated query's "no model is set up to write queries" branch is gone: the route always has the AI service, which answers for itself when Codex is stopped. The tests' stand-in AI service with no model behind it refuses with those words (`server/fixtures/routes.ts`).
  - `archive/server.ts` (the door) and `allowedHosts.ts` (the Host guard) stay plain: routing by path and comparing names neither waits nor fails. node:http stays; nothing from `effect/unstable/http`.
  - `architectureSnapshot.ts` reads the routes from `structureRoute` and `contentRoute`'s generators; friend-map's `archive.json` is unchanged, so the route list is the same.
  - Tests: the listed ones pass, served through `server/fixtures/routes.ts` (the routes with the services a test has at hand); `jsonApi.test.ts` (new: each error's status, a subclass's, 500 for a bug; what `answering` lifts) and `archive/changeStream.test.ts` (new: the events on `TestClock`; the request's program ending when the page closes the stream).
  - Checked on made-up testing data against a server of `main`: 73 requests across every route family (the archive's structure and content routes, the viewer's API, Health, the door's 404, 302 and 503) answered the same statuses and bodies (but the times each testing archive was built at); the Host guard's 403, the ETag's 304, a byte range's 206 and Vite's `fs` refusals alike; an event came on the next one-second look after a change; the stream's connection was gone when the page closed it, and a SIGTERM with a page's stream open stopped the server in a quarter of a second, leaving no WAL.

### E. Importers and CLI commands, when touched

- **Modules:** each connector's `read.ts` and parser, `archive/cli.ts`, `check-data.ts`, `../tools/docs/docs.ts`, the rest of `archive/`.
- **What improves:** little at once. Converted only when a change touches them anyway: a command that waits on a process or a file uses Effect's resources and schedules, and its edge runs it. A parser that only computes stays plain.
- **Risk:** low each time, spread out.
- **Tests:** each module's own.
- **Depends on:** A; C for any command that wants the server's services.
- **Health:** `npm run health` and its import (`modules/health/cli.ts`, `modules/health/server/import.ts`, and `modules/health/server/pdf.ts`'s one `swift` run) are commands like the rest, moved when touched; judging and the ranges are pure and stay plain.

### The viewer

It stays React. Its fetch layer (`viewer/api.ts`, 62 lines) could become Effect for retries and cancelling a request a newer filter replaces, but it has neither need today; leave it until it does.
The Health tab's page (`modules/health/viewer/`, `modules/health/wire.ts`) stays React with the rest.

## What remains

B to D are done: the server has no `setInterval` or hand-kept timer of its own but `archive/sqlQuery.ts`'s time limit on a query's process, every process it runs is in a scope, and every error a route can answer is in its type.
What waits is E, module by module as a change touches it (each connector's reader, the CLI, `check-data.ts`, `../tools/docs/docs.ts`, the rest of `archive/`), and the child-process helpers with it (`archive/sqlQuery.ts`, `connectors/iphoneBackup.ts`); new code (the Rituals tab's routes, say) is written as `server/archive/http.ts`'s are.
Once E has nothing left that a change has asked for, shorten this plan to that list and keep docs/effect.md current.
