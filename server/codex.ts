// The AI service's Codex adapter (ai.ts, which chooses it where a model is
// named): it runs on the owner's ChatGPT subscription through the Codex CLI
// already signed in on this Mac, never an API key: `codex app-server`, the long-lived
// process the Codex apps talk to, started with the server and kept running so
// a question does not wait for Codex to start (JSON lines over its stdin and
// stdout; each question is a new ephemeral thread of one turn).
//
// Codex runs read-only in a scratch folder outside the repo and data/, with no
// approval prompts, and with the captain's own Codex extras switched off for
// it (MCP servers, apps, plugins, hooks, the browser and computer use, web
// search, and the notify program), since a question needs none of them.
//
// When Codex is not installed, is signed out, or stops, the service says why
// in the server's log and starts it again after a growing wait (the restart
// ladder in schedules.ts: 10 s, 1 min, 5 min, then every 30 min, starting over
// once it has answered), as the live connectors do; a question asked
// meanwhile starts it at once, and if that fails, the answer is why, in plain
// words ("Codex is not signed in: run codex login").

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Duration, Effect, Fiber, Schedule, type Scope, Stream } from "effect";
import type { Ai, Question } from "./ai.ts";
import { stopProcess, watch, type Running } from "./childProcess.ts";
import { jsonLines } from "./connectors/lines.ts";
import { runBackground, runPromise } from "./effectRuntime.ts";
import { UnavailableError } from "./errors.ts";
import { restartLadder, RESTART_DELAYS_MS, type Stopped } from "./schedules.ts";

const EFFORT = "low";
/** Codex's Fast tier ("priority"), about 1.5 s quicker a query, at more of the plan's usage. */
const SERVICE_TIER = "priority";

/** Codex's features that give it tools a question has no use for (they would also slow each thread's start). */
const DISABLED_FEATURES = ["apps", "plugins", "hooks", "browser_use", "computer_use", "in_app_browser", "image_generation", "multi_agent", "goals", "tool_suggest"];
const OVERRIDES = ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "notify=[]"];
/** Streaming notifications the service does not read. */
const QUIET = ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta", "thread/tokenUsage/updated", "account/rateLimits/updated"];

const START_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 90_000;
/** How long Codex is given to stop, its stdin closed and sent SIGTERM, before it is sent SIGKILL. */
const STOP_GRACE_MS = 3000;

export const NOT_SIGNED_IN = "Codex is not signed in: run codex login";
export const NOT_INSTALLED = "Codex is not installed: install the Codex CLI, then run codex login";
const STOPPED = "the Codex service is stopped";

export interface CodexServiceOptions {
  /** The model Codex answers with (ai.ts's configuredAi gives it LIFE_ARCHIVE_MODEL's). */
  model: string;
  /** The program and its first arguments; `codex` by default. The service adds `app-server` and its settings. */
  command?: string[];
  /** Codex's working folder: empty, and outside the repo and data/. */
  workDir?: string;
  /** Hears each change of state, once, as a line for the server's log. */
  log?: (line: string) => void;
  restartDelaysMs?: number[];
  startTimeoutMs?: number;
  answerTimeoutMs?: number;
}

type Turn = { status: string; error: { message: string; codexErrorInfo: unknown } | null };

/** One running `codex app-server`, signed in and ready for questions. */
interface Connection {
  /** Sends a request and waits for its answer. */
  request: (method: string, params: unknown) => Effect.Effect<unknown, UnavailableError>;
  /** Sends a request whose answer nobody waits for. */
  post: (method: string, params: unknown) => void;
  /** Each thread's turn in progress: its last message so far, and its end. */
  turns: Map<string, { text: string | null; done: Deferred.Deferred<Turn, UnavailableError> }>;
  /** The captain's MCP servers, each switched off for our threads. */
  mcpOff: Record<string, false>;
  /** Why it stopped, once it has: it exited, or was stopped to start again (see `end`). */
  ended: Deferred.Deferred<string>;
  /** Done once the service has recorded the stop: the problem, the log line and the wait before it starts again. */
  recorded: Deferred.Deferred<void>;
  /** Whether an answer came back from it: the restart ladder then starts over. */
  answered: boolean;
}

/** The next start of Codex: what a question waits for, and whether it has begun (until it has, a question starts it at once). */
interface NextStart {
  readonly outcome: Deferred.Deferred<Connection, UnavailableError>;
  readonly wake: Deferred.Deferred<void>;
  begun: boolean;
}

const nextStart = (): NextStart => ({ outcome: Deferred.makeUnsafe(), wake: Deferred.makeUnsafe(), begun: false });

/** Steps the restart ladder after a stop: how long to wait before starting again. */
type NextRestart = (stopped: Stopped) => Effect.Effect<number>;

/**
 * Written in Effect (docs/effect.md): the service is one fiber (`keep`), which `start` and `stop` begin and interrupt
 * through server/effectRuntime.ts. Each run of Codex is held in a scope of that fiber, so stopping is interrupting.
 */
export class CodexService implements Ai {
  readonly model: string;
  private readonly command: string[];
  readonly workDir: string;
  private connection: Connection | null = null;
  private next: NextStart = nextStart();
  private problem: string | null = null;
  /** Keeps Codex running (keep), from start until stop. */
  private fiber: Fiber.Fiber<never> | null = null;

  private readonly options: CodexServiceOptions;

  constructor(options: CodexServiceOptions) {
    this.options = options;
    this.model = options.model;
    this.command = options.command ?? ["codex"];
    this.workDir = options.workDir ?? join(tmpdir(), "friend-map-codex");
  }

  /** Starts Codex, and keeps it running until `stop`. */
  start(): void {
    this.fiber ??= runBackground(this.keep());
  }

  stop(): Promise<void> {
    return runPromise(this.halt);
  }

  /** Stops Codex (its stdin closed, SIGTERM, then SIGKILL after 3 s) and starts it no more. */
  readonly halt: Effect.Effect<void> = Effect.suspend(() => {
    const fiber = this.fiber;
    this.fiber = null;
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  });

  /** The state for a status line: running, or why not. */
  get state(): { running: true } | { running: false; problem: string | null } {
    return this.connection ? { running: true } : { running: false, problem: this.problem };
  }

  ask(question: Question): Promise<string> {
    return runPromise(this.answer(question));
  }

  private answer({ instructions, prompt, schema }: Question): Effect.Effect<string, UnavailableError> {
    return Effect.gen({ self: this }, function* () {
      const connection = yield* this.connect();
      return yield* Effect.gen({ self: this }, function* () {
        const { thread } = (yield* connection.request("thread/start", {
          cwd: this.workDir,
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          model: this.model,
          serviceTier: SERVICE_TIER,
          baseInstructions: instructions,
          config: connection.mcpOff,
        })) as { thread: { id: string } };
        const turn = { text: null as string | null, done: Deferred.makeUnsafe<Turn, UnavailableError>() };
        connection.turns.set(thread.id, turn);
        let turnId: string | null = null;
        const timeout = this.options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
        return yield* Effect.gen({ self: this }, function* () {
          ({ turn: { id: turnId } } = (yield* connection.request("turn/start", {
            threadId: thread.id,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            effort: EFFORT,
            outputSchema: schema ?? null,
          })) as { turn: { id: string } });
          const ended = yield* Deferred.await(turn.done).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new UnavailableError(`Codex took more than ${Math.round(timeout / 1000)} s to answer: try again`)),
            }),
          );
          if (ended.status !== "completed") return yield* Effect.fail(this.turnError(ended, connection));
          if (!turn.text) return yield* Effect.fail(new UnavailableError("Codex finished without an answer"));
          connection.answered = true;
          return turn.text;
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (turnId && this.connection === connection) connection.post("turn/interrupt", { threadId: thread.id, turnId });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              connection.turns.delete(thread.id);
              if (this.connection === connection) connection.post("thread/unsubscribe", { threadId: thread.id });
            }),
          ),
        );
        // When Codex stopped under the question, it is answered once the stop is recorded, so the state says why.
      }).pipe(Effect.onError(() => (Deferred.isDoneUnsafe(connection.ended) ? Deferred.await(connection.recorded) : Effect.void)));
    });
  }

  /** Why a turn did not complete, in plain words. */
  private turnError(turn: Turn, connection: Connection): UnavailableError {
    const info = turn.error?.codexErrorInfo;
    if (info === "unauthorized") {
      // Signed out since it started: start again, so the next question finds out afresh.
      this.end(connection, NOT_SIGNED_IN);
      return new UnavailableError(NOT_SIGNED_IN);
    }
    if (info === "usageLimitExceeded" || info === "rateLimitExceeded") return new UnavailableError("Codex has reached the ChatGPT plan's usage limit for now: try again later");
    if (info === "cyberPolicy" || info === "misalignmentPolicyViolation") return new UnavailableError("Codex declined to answer");
    if (turn.status === "interrupted") return new UnavailableError("Codex was interrupted before it answered: try again");
    return new UnavailableError(`Codex could not answer: ${turn.error?.message ?? turn.status}`);
  }

  /** The running connection, starting Codex now if it is not running (even while waiting to start it again). */
  private connect(): Effect.Effect<Connection, UnavailableError> {
    return Effect.suspend(() => {
      if (this.connection) return Effect.succeed(this.connection);
      if (!this.fiber) return Effect.fail(new UnavailableError(STOPPED));
      const next = this.next;
      if (!next.begun) Deferred.doneUnsafe(next.wake, Effect.void);
      return Deferred.await(next.outcome);
    });
  }

  /** Runs Codex, starting it again after each stop, after the restart ladder's wait or at once for a question, until interrupted. */
  private keep(): Effect.Effect<never> {
    return Effect.gen({ self: this }, function* () {
      const step = yield* Schedule.toStep(restartLadder(this.options.restartDelaysMs ?? RESTART_DELAYS_MS));
      const nextRestart: NextRestart = (stopped) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => step(now, stopped)),
          Effect.map(([, wait]) => Duration.toMillis(wait)),
          // The ladder never ends.
          Effect.orDie,
        );
      for (;;) {
        const next = this.next;
        next.begun = true;
        const startAgainAt = yield* Effect.scoped(this.run(next, nextRestart));
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.race(Effect.sleep(Math.max(0, startAgainAt - now)), Deferred.await(this.next.wake));
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.connection = null;
          Deferred.doneUnsafe(this.next.outcome, Effect.fail(new UnavailableError(STOPPED)));
        }),
      ),
    );
  }

  /** One run of Codex, from its start until it stops: then when to start it again. Its scope holds the process. */
  private run(next: NextStart, nextRestart: NextRestart): Effect.Effect<number, never, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      const opened = yield* Effect.result(this.open());
      if (opened._tag === "Failure") {
        const startAgainAt = yield* this.stopped(opened.failure.message, false, nextRestart);
        this.next = nextStart();
        Deferred.doneUnsafe(next.outcome, Effect.fail(opened.failure));
        return startAgainAt;
      }
      const connection = opened.success;
      this.connection = connection;
      this.log(this.problem === null ? "running" : "running again");
      this.problem = null;
      Deferred.doneUnsafe(next.outcome, Effect.succeed(connection));
      return yield* Deferred.await(connection.ended).pipe(
        Effect.flatMap((reason) => this.stopped(reason, connection.answered, nextRestart)),
        // Recorded, or the service stopped: a question Codex's stop cut short is answered either way.
        Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(connection.recorded, Effect.void))),
      );
    });
  }

  /** Starts `codex app-server`, held in the scope, and checks it is signed in, within the start's time limit. */
  private open(): Effect.Effect<Connection, UnavailableError, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.tryPromise({ try: () => mkdir(this.workDir, { recursive: true }), catch: (error) => new UnavailableError((error as Error).message) });
      const [program, ...first] = this.command;
      const running: Running<ChildProcessWithoutNullStreams> = yield* Effect.acquireRelease(
        Effect.sync(() =>
          watch(spawn(program, [...first, "app-server", ...OVERRIDES, ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature])], {
            cwd: this.workDir,
            stdio: ["pipe", "pipe", "pipe"],
          })),
        ),
        (running) =>
          Effect.sync(() => {
            if (!running.ended()) running.child.stdin.end();
          }).pipe(Effect.andThen(stopProcess(running, STOP_GRACE_MS))),
      );
      const { child } = running;
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
      child.stdin.on("error", () => {}); // it stopped; the exit says why
      let failedToStart: string | null = null;
      child.once("error", (error: NodeJS.ErrnoException) => {
        failedToStart ??= error.code === "ENOENT" ? NOT_INSTALLED : `Codex could not start (${error.message})`;
      });

      /** Set when it is stopped for not starting, so a request still waiting hears that, not how it ended. */
      let closing = false;
      const exited = Deferred.makeUnsafe<string>();
      const pending = new Map<number, Deferred.Deferred<unknown, UnavailableError>>();
      let nextId = 1;
      /** Writes one message; false when Codex is not there to read it. */
      const send = (message: object) => {
        if (!child.stdin.writable) return false;
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      };
      const connection: Connection = {
        request: (method, params) =>
          Effect.suspend(() => {
            const id = nextId++;
            const answer = Deferred.makeUnsafe<unknown, UnavailableError>();
            pending.set(id, answer);
            if (!send({ id, method, params })) {
              pending.delete(id);
              return Deferred.await(exited).pipe(Effect.flatMap((detail) => Effect.fail(new UnavailableError(detail))));
            }
            return Deferred.await(answer).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
          }),
        post: (method, params) => void send({ id: nextId++, method, params }),
        turns: new Map(),
        mcpOff: {},
        ended: Deferred.makeUnsafe(),
        recorded: Deferred.makeUnsafe(),
        answered: false,
      };

      child.once("close", (code, signal) => {
        const last = stderr.trim().split("\n").at(-1);
        const detail = failedToStart ?? `the Codex service stopped (${last || (signal ? `killed by ${signal}` : `exit code ${code}`)})`;
        Deferred.doneUnsafe(exited, Effect.succeed(detail));
        // Ended first, so a question it cuts short waits for the stop to be recorded.
        this.end(connection, detail);
        const stopped = new UnavailableError(closing ? STOPPED : detail);
        for (const waiter of pending.values()) Deferred.doneUnsafe(waiter, Effect.fail(stopped));
        for (const turn of connection.turns.values()) Deferred.doneUnsafe(turn.done, Effect.fail(new UnavailableError(`${detail} while it answered: try again`)));
      });

      yield* Stream.fromAsyncIterable(jsonLines(child.stdout), () => null).pipe(
        Stream.runForEach((line) => Effect.sync(() => take(line))),
        Effect.ignore,
        Effect.forkScoped,
      );
      function take(line: string): void {
        let message: { id?: number; method?: string; params?: any; result?: unknown; error?: { message: string } };
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.method === undefined && message.id !== undefined) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (waiter) Deferred.doneUnsafe(waiter, message.error ? Effect.fail(new UnavailableError(`Codex answered with an error: ${message.error.message}`)) : Effect.succeed(message.result));
        } else if (message.id !== undefined) {
          // A request to us (an approval, say): with no approvals asked for there should be none, and each is refused.
          send({ id: message.id, error: { code: -32601, message: "friend-map answers no requests" } });
        } else if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
          const turn = connection.turns.get(message.params.threadId);
          if (turn) turn.text = message.params.item.text;
        } else if (message.method === "turn/completed") {
          const turn = connection.turns.get(message.params?.threadId);
          if (turn) Deferred.doneUnsafe(turn.done, Effect.succeed(message.params.turn as Turn));
        }
      }

      const timeout = this.options.startTimeoutMs ?? START_TIMEOUT_MS;
      return yield* Effect.gen({ self: this }, function* () {
        yield* connection.request("initialize", {
          clientInfo: { name: "friend-map", title: "friend-map", version: "1" },
          capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: QUIET },
        });
        send({ method: "initialized" });
        const { account } = (yield* connection.request("account/read", {})) as { account: { type: string } | null };
        if (!account || account.type !== "chatgpt") return yield* Effect.fail(new UnavailableError(account ? `Codex is signed in with an API key, not ChatGPT: run codex login` : NOT_SIGNED_IN));
        const { config } = (yield* connection.request("config/read", { cwd: this.workDir })) as { config: { mcp_servers?: Record<string, unknown> } };
        connection.mcpOff = Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]));
        return connection;
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new UnavailableError(`Codex did not start within ${Math.round(timeout / 1000)} s`)),
        }),
        Effect.onError(() =>
          Effect.sync(() => {
            closing = true;
          }),
        ),
      );
    });
  }

  /**
   * Marks `connection` as stopped, for `reason`: it exited, or the service stops it to start again. Done at once, so
   * the next question finds it gone and starts Codex anew; the service's fiber records the stop and closes it.
   */
  private end(connection: Connection, reason: string): void {
    if (Deferred.isDoneUnsafe(connection.ended)) return;
    if (this.connection === connection) {
      this.connection = null;
      this.next = nextStart();
    }
    // Last: completing it may run the service's fiber on at once.
    Deferred.doneUnsafe(connection.ended, Effect.succeed(reason));
  }

  /** Records why Codex is not running, saying so once, and gives when to start it again: after the restart ladder's wait. */
  private stopped(reason: string, ranWell: boolean, nextRestart: NextRestart): Effect.Effect<number> {
    return Effect.gen({ self: this }, function* () {
      const waitMs = yield* nextRestart({ ranWell });
      if (reason !== this.problem) this.log(`${reason}; starting again in ${formatWait(waitMs)}`);
      this.problem = reason;
      return (yield* Clock.currentTimeMillis) + waitMs;
    });
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function formatWait(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}
