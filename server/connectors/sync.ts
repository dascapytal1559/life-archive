// Runs one connector in sync mode for as long as the server runs (see the
// contract in contract.ts):
//
// - It starts the connector only when it is switched on and its companion (the
//   bridge rig, say) answers; otherwise it waits, looking again every minute,
//   without starting anything or writing to the log again.
// - Each batch the connector writes is checked event by event, as a history
//   import's are, and applied at its `checkpoint` to the connector's ledger
//   (host.ts's ConnectorLedger: the archive's writer, or a module's apply), in
//   one transaction of the ledger's database that also stores the checkpoint's
//   cursor in connector_state.cursor_json. A batch cut short by a crash is
//   never applied, and the connector resumes after the last one that was.
//   Each run of the connector is one source (kind 'live'), its counts summed
//   over its batches.
// - When the connector stops, or writes something malformed, or a batch
//   cannot be applied, it is marked with the error and started again after a
//   growing wait (the restart ladder in ../schedules.ts: 10 s, 1 min, 5 min,
//   then every 30 min), each time only if its companion answers.
// - Stopping it sends the connector SIGTERM, then SIGKILL after 5 s, and reads
//   on until it has exited: a batch it finishes as it stops is still applied.
// - It carries commands to the connector (see `command`), for the server's
//   send executor alone, and hands back their results.
//
// Written in Effect (docs/effect.md): the runner is one fiber (`keep`), which
// SyncRunner starts and interrupts through server/effectRuntime.ts. Each run's
// process is held in that fiber's scope (../childProcess.ts), so stopping is
// interrupting.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Data, Deferred, Duration, Effect, Fiber, Schedule, type Scope, Stream } from "effect";
import type { LiveState } from "../../src/archive.ts";
import { transaction, type Db } from "../archive/db.ts";
import { emptyCounts, type ImportCounts } from "./counts.ts";
import { spawnScoped, stopProcess, type Running } from "../childProcess.ts";
import { runBackground, runPromise } from "../effectRuntime.ts";
import { restartLadder, RESTART_DELAYS_MS, type Stopped } from "../schedules.ts";
import {
  isSyncEvent,
  validateEvent,
  type ArchiveEvent,
  type ConnectorCommand,
  type SendResultEvent,
} from "./contract.ts";
import type { ConnectorLedger, RegisteredConnector } from "./host.ts";
import { expandHome, jsonLines } from "./lines.ts";
import { LOCALE } from "../../src/time.ts";

export type { LiveState };

const MEMORY_CAP_MB = 1024;
/** A batch bigger than this fails the run rather than filling memory; connectors checkpoint far more often. */
const MAX_BATCH_EVENTS = 100_000;

export interface SyncRunnerOptions {
  /** Hears after each batch that changed the ledger, with its counts (the server runs the people rules). */
  onBatch?: (counts: ImportCounts) => void;
  /** Hears each change of state, once, as a line for the server's log. */
  log?: (line: string) => void;
  /** How often to look again while switched off or waiting; a minute by default. */
  checkEveryMs?: number;
  restartDelaysMs?: number[];
  /** How long a command may take before its result is "unconfirmed"; 90 s by default. */
  commandTimeoutMs?: number;
}

export class NotConnectedError extends Error {}

/** The archive or the connector's settings could not be read or written: the runner says so and looks again later. */
class SyncError extends Data.TaggedError("SyncError")<{ readonly message: string }> {}

/** The archive's folder, and where in it connectors keep media and copies (see host.ts). */
export interface SyncFolders {
  dataDir: string;
  mediaDir: string;
  copiesDir: string;
}

/** A run begun: its source row and the connector's arguments. */
interface Begun {
  sourceId: number;
  args: string[];
}

/** Steps the restart ladder after a stop: how many stops in a row, and how long to wait. */
type NextRestart = (stopped: Stopped) => Effect.Effect<{ inARow: number; waitMs: number }>;

export class SyncRunner {
  readonly entry: RegisteredConnector;
  /** Where its runs are recorded and its batches applied (host.ts's ConnectorLedger), and that ledger's database. */
  private readonly ledger: ConnectorLedger;
  private readonly db: Db;
  private readonly folders: SyncFolders;
  private readonly readConfig: () => Promise<{ enabled: boolean; config: Record<string, unknown> }>;
  private readonly options: SyncRunnerOptions;
  private current: LiveState = { state: "off", detail: null, since: Date.now() };
  /** The connector's process while a run is going. */
  private child: ChildProcessWithoutNullStreams | null = null;
  /** The runner (keep), from start until stop. */
  private fiber: Fiber.Fiber<never, never> | null = null;
  private readonly waiting = new Map<string, Deferred.Deferred<SendResultEvent>>();

  constructor(entry: RegisteredConnector, ledger: ConnectorLedger, folders: SyncFolders, readConfig: SyncRunner["readConfig"], options: SyncRunnerOptions = {}) {
    this.entry = entry;
    this.ledger = ledger;
    this.db = ledger.db;
    this.folders = folders;
    this.readConfig = readConfig;
    this.options = options;
  }

  get state(): LiveState {
    return this.current;
  }

  /** Whether it has been started, and not stopped since. */
  get running(): boolean {
    return this.fiber !== null;
  }

  start(): void {
    this.fiber ??= runBackground(this.keep());
  }

  /** Stops the connector (it is sent SIGTERM, then SIGKILL after 5 s) and looks no more. */
  async stop(): Promise<void> {
    const fiber = this.fiber;
    this.fiber = null;
    if (fiber) await runPromise(Fiber.interrupt(fiber));
    this.setState("stopped", null);
  }

  /** Shows it waiting while another process runs the live bridges (see liveLock.ts); it starts nothing. */
  hold(detail: string): void {
    this.setState("waiting", detail);
  }

  /**
   * Hands a command to the connector and waits for its result. For the send
   * executor only: nothing else may send. Throws NotConnectedError unless the
   * connector is running and connected.
   */
  command(command: Omit<ConnectorCommand, "request">): Promise<SendResultEvent> {
    const child = this.child;
    if (!child?.stdin.writable || this.current.state !== "connected") {
      throw new NotConnectedError(`${this.entry.id} is not connected (${this.describe()})`);
    }
    const request = randomUUID();
    const timeoutMs = this.options.commandTimeoutMs ?? 90_000;
    const answer = Deferred.makeUnsafe<SendResultEvent>();
    this.waiting.set(request, answer);
    child.stdin.write(`${JSON.stringify({ ...command, request })}\n`);
    return runPromise(
      Deferred.await(answer).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.succeed<SendResultEvent>({
            kind: "send-result", request, status: "unconfirmed", error: `no answer from ${this.entry.id} within ${Math.round(timeoutMs / 1000)} seconds`,
          }),
        }),
        Effect.ensuring(Effect.sync(() => this.waiting.delete(request))),
      ),
    );
  }

  /** The state in a few words, for errors and the log. */
  describe(): string {
    return this.current.detail ? `${this.current.state}: ${this.current.detail}` : this.current.state;
  }

  /** Runs the connector whenever it can, starting it again after each stop, until interrupted. */
  private keep(): Effect.Effect<never> {
    const every = this.options.checkEveryMs ?? 60_000;
    return Effect.gen({ self: this }, function* () {
      const step = yield* Schedule.toStep(restartLadder(this.options.restartDelaysMs ?? RESTART_DELAYS_MS));
      const next: NextRestart = (stopped) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => step(now, stopped)),
          Effect.map(([inARow, wait]) => ({ inARow, waitMs: Duration.toMillis(wait) })),
          // The ladder never ends.
          Effect.orDie,
        );
      for (;;) {
        const waitMs = yield* Effect.gen({ self: this }, function* () {
          const config = yield* this.ready(every);
          return yield* Effect.scoped(this.run(config, next));
        }).pipe(
          Effect.catchTag("SyncError", (error) => Effect.sync(() => this.setState("error", error.message)).pipe(Effect.as(every))),
        );
        yield* Effect.sleep(waitMs);
      }
    });
  }

  /** The connector's settings once it is switched on and its companion answers, looking again every `every` until then. */
  private ready(every: number): Effect.Effect<Record<string, unknown>> {
    const look = Effect.gen({ self: this }, function* () {
      const settings = yield* Effect.tryPromise({ try: () => this.readConfig(), catch: (error) => new SyncError({ message: (error as Error).message }) });
      if (!settings.enabled) {
        this.setState("off", null);
        return null;
      }
      const companion = this.entry.manifest?.companion;
      const healthUrl = (settings.config.healthUrl as string | undefined) ?? companion?.healthUrl;
      if (healthUrl && !(yield* answers(healthUrl))) {
        this.setState("waiting", `${companion?.name ?? "its companion"} does not answer at ${healthUrl}`);
        return null;
      }
      return settings.config;
    }).pipe(Effect.catchTag("SyncError", (error) => Effect.sync(() => this.setState("error", error.message)).pipe(Effect.as(null))));
    return look.pipe(Effect.repeat({ schedule: Schedule.spaced(every), until: (config) => config !== null })) as Effect.Effect<Record<string, unknown>>;
  }

  /** Records a run as begun (its source, the connector's row), and says how to start the connector. */
  private begin(config: Record<string, unknown>): Effect.Effect<Begun, SyncError> {
    return Effect.gen({ self: this }, function* () {
      const manifest = this.entry.manifest!;
      const source = expandHome((config.source as string | undefined) ?? manifest.defaultSource ?? "");
      yield* Effect.tryPromise({ try: () => mkdir(this.folders.mediaDir, { recursive: true }), catch: (error) => new SyncError({ message: (error as Error).message }) });
      const startedAt = yield* Clock.currentTimeMillis;
      const begun = yield* this.sql(() => {
        const cursorRow = this.db.prepare("SELECT cursor_json FROM connector_state WHERE connector = ?").get(this.entry.id) as
          { cursor_json: string | null } | undefined;
        const sourceId = Number(
          this.db
            .prepare(`INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, ?, 'live', 'sync', ?, 'running')`)
            .run(manifest.platform, this.entry.id, startedAt).lastInsertRowid,
        );
        this.setRow({ status: "running", last_run_at: startedAt });
        const args = [
          `--max-old-space-size=${MEMORY_CAP_MB}`, "--no-warnings", this.entry.main, "--mode", "sync",
          ...(source ? ["--source", source] : []), "--media", this.folders.mediaDir,
          ...(manifest.keepsCopies ? ["--copies", join(this.folders.copiesDir, manifest.platform)] : []),
          "--config", JSON.stringify(config), "--cursor", cursorRow?.cursor_json ?? "null",
        ];
        return { sourceId, args };
      });
      this.setState("starting", null);
      return begun;
    });
  }

  /**
   * One run of the connector, until its process ends: then how long to wait before the next. Interrupting it stops
   * the process and reads on until it has ended, so whatever it applies as it stops is kept. Only its waiting for
   * the process to end can be interrupted, so a run is never left recorded as begun with no process.
   */
  private run(config: Record<string, unknown>, next: NextRestart): Effect.Effect<number, SyncError, Scope.Scope> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const begun = yield* this.begin(config);
        const running = yield* spawnScoped(() => spawn(process.execPath, begun.args, { stdio: ["pipe", "pipe", "pipe"] }));
        this.child = running.child;
        let stopping = false;
        const reading = yield* Effect.acquireRelease(
          Effect.forkDetach(this.read(running, begun.sourceId, () => stopping, next)),
          (fiber) =>
            Effect.sync(() => {
              stopping = true;
            }).pipe(Effect.andThen(stopProcess(running)), Effect.andThen(Fiber.await(fiber))),
        );
        return yield* restore(Fiber.join(reading));
      }),
    );
  }

  /**
   * Reads the connector's output until it ends, applying each batch at its checkpoint and handing back command
   * results; then records how the run ended and gives how long to wait before the next.
   */
  private read(running: Running<ChildProcessWithoutNullStreams>, sourceId: number, stopping: () => boolean, next: NextRestart): Effect.Effect<number, SyncError> {
    return Effect.gen({ self: this }, function* () {
      const { child } = running;
      const clock = yield* Clock.clockWith(Effect.succeed);
      // A command written as the connector dies must not take the server with it.
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      let problem: string | null = null;
      const fail = (why: string) => {
        problem ??= why;
        child.kill("SIGKILL");
      };
      const totals = emptyCounts();
      let batch: ArchiveEvent[] = [];
      let applied = false;
      let line = 0;

      const take = (text: string) => {
        line++;
        if (problem || !text.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return fail(`it wrote a line that is not JSON (line ${line})`);
        }
        const checked = validateEvent(parsed);
        if ("error" in checked) return fail(`it wrote an invalid event on line ${line}: ${checked.error}`);
        const event = checked.event;
        if (!isSyncEvent(event)) {
          if (event.kind === "progress") return;
          if (batch.length >= MAX_BATCH_EVENTS) fail(`it wrote a batch of more than ${MAX_BATCH_EVENTS.toLocaleString(LOCALE)} events`);
          else batch.push(event);
          return;
        }
        if (event.kind === "state") this.setState(event.state, event.detail ?? null);
        else if (event.kind === "send-result") this.answered(event);
        else {
          try {
            const counts = this.apply(batch, event.cursor, sourceId, totals, clock.currentTimeMillisUnsafe());
            batch = [];
            applied = true;
            if (counts) this.options.onBatch?.(counts);
          } catch (error) {
            fail(`a batch could not be applied: ${(error as Error).message}`);
          }
        }
      };
      yield* Stream.fromAsyncIterable(jsonLines(child.stdout), (error) => new SyncError({ message: (error as Error).message })).pipe(
        Stream.runForEach((text) => Effect.sync(() => take(text))),
      );

      const { code, signal } = yield* running.exited;
      this.child = null;
      for (const [request, answer] of this.waiting) {
        Deferred.doneUnsafe(answer, Effect.succeed({ kind: "send-result", request, status: "unconfirmed", error: `${this.entry.id} stopped before it answered` }));
      }
      this.waiting.clear();
      const detail = (problem as string | null) ?? (stderr.trim().split("\n").at(-1) || (signal ? `killed by ${signal}` : `exit code ${code}`));
      const cleanStop = stopping() && problem === null;
      const finishedAt = yield* Clock.currentTimeMillis;
      yield* this.sql(() =>
        this.db
          .prepare("UPDATE source SET status = ?, finished_at = ?, error = ? WHERE id = ?")
          .run(cleanStop ? "ok" : "failed", finishedAt, cleanStop ? null : detail, sourceId),
      );
      if (cleanStop) {
        yield* this.sql(() => this.setRow({ status: "idle" }));
        return 0;
      }
      const { inARow, waitMs } = yield* next({ ranWell: applied });
      const now = yield* Clock.currentTimeMillis;
      yield* this.sql(() => this.setRow({ status: "error", last_error: `it stopped: ${detail}`, last_error_at: now, failures: inARow, retry_after: now + waitMs }));
      this.setState("error", `it stopped (${detail}); starting again in ${formatWait(waitMs)}`);
      return waitMs;
    });
  }

  /** Applies one batch and its cursor in one transaction of the ledger; returns the batch's counts if it held anything. */
  private apply(batch: ArchiveEvent[], cursor: unknown, sourceId: number, totals: ImportCounts, now: number): ImportCounts | null {
    const platform = this.entry.manifest!.platform;
    let afterCommit: (() => void) | undefined;
    const counts = transaction(this.db, () => {
      let applied: ReturnType<ConnectorLedger["apply"]> | null = null;
      if (batch.length > 0) {
        applied = this.ledger.apply(batch, { id: sourceId, platform, kind: "live", seenAt: now, folder: this.folders.dataDir });
        addCounts(totals, applied.counts);
        this.db.prepare("UPDATE source SET counts_json = ? WHERE id = ?").run(JSON.stringify(totals), sourceId);
        afterCommit = applied.afterCommit;
      }
      this.db.prepare("UPDATE connector_state SET cursor_json = ? WHERE connector = ?").run(JSON.stringify(cursor), this.entry.id);
      return applied?.counts ?? null;
    });
    // Once the ledger has committed: the calendar's push, in its own file (server/calendar/push.ts).
    afterCommit?.();
    this.setRow({ last_ok_at: now, failures: 0, retry_after: null, last_error: null });
    return counts;
  }

  private answered(result: SendResultEvent): void {
    const answer = this.waiting.get(result.request);
    if (!answer) return;
    this.waiting.delete(result.request);
    Deferred.doneUnsafe(answer, Effect.succeed(result));
  }

  private setState(state: LiveState["state"], detail: string | null): void {
    if (this.current.state === state && this.current.detail === detail) return;
    this.current = { state, detail, since: Date.now() };
    this.options.log?.(`${this.entry.id}: ${this.describe()}`);
  }

  /** Runs statements against the archive, a failure a SyncError. */
  private sql<A>(work: () => A): Effect.Effect<A, SyncError> {
    return Effect.try({ try: work, catch: (error) => new SyncError({ message: (error as Error).message }) });
  }

  private setRow(fields: Record<string, string | number | null>): void {
    this.db.prepare("INSERT OR IGNORE INTO connector_state (connector, status) VALUES (?, 'idle')").run(this.entry.id);
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE connector_state SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE connector = ?`)
      .run(...keys.map((key) => fields[key]), this.entry.id);
  }
}

/** Whether a URL answers at all within 3 seconds (any HTTP status counts). */
const answers = (url: string): Effect.Effect<boolean> =>
  Effect.tryPromise((signal) => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

function formatWait(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 60_000)} min`;
}

/** Adds one batch's counts into the run's. */
function addCounts(into: ImportCounts, add: ImportCounts): void {
  for (const group of ["accounts", "conversations", "messages", "reactions", "attachments"] as const) {
    const target = into[group] as Record<string, number>;
    for (const [key, value] of Object.entries(add[group])) target[key] = (target[key] ?? 0) + value;
  }
  into.coverageSpans += add.coverageSpans;
  for (const [name, value] of Object.entries(add.tallies)) into.tallies[name] = (into.tallies[name] ?? 0) + value;
}
