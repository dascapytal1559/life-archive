// A child process held in a scope (docs/effect.md, "Resources and Scope"): however its scope ends, the process is
// stopped and waited for, so none outlives what started it. The sync runner's connectors and the history imports'
// (connectors/sync.ts, connectors/host.ts), Codex (codex.ts, stopped with its stdin closed and 3 s of grace) and the NAS
// backup's ssh, security and restic (archive/nasBackup.ts) and the folder history module's git
// (modules/folder-history/server/folderHistory.ts, through the SDK) run in one, the last two through `run`.

import { type ChildProcess, spawn } from "node:child_process";
import { basename } from "node:path";
import { Data, Effect, type Scope } from "effect";

/** How a process ended. */
export interface Exited {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Running<C extends ChildProcess = ChildProcess> {
  readonly child: C;
  /** Waits until the process has exited and its output has closed. */
  readonly exited: Effect.Effect<Exited>;
  /** Whether it has. */
  readonly ended: () => boolean;
}

/** How long a process is given to stop after SIGTERM before it is sent SIGKILL. */
export const STOP_GRACE_MS = 5000;

/**
 * The process `start` spawns, for as long as the scope lasts. When the scope closes while it is still running, it is
 * stopped (SIGTERM, then SIGKILL after 5 s) and waited for.
 */
export const spawnScoped = <C extends ChildProcess>(start: () => C): Effect.Effect<Running<C>, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => watch(start())), (running) => stopProcess(running));

/** A process already started, as a Running. */
export function watch<C extends ChildProcess>(child: C): Running<C> {
  let ended = false;
  const closed = new Promise<Exited>((resolve) =>
    child.once("close", (code, signal) => {
      ended = true;
      resolve({ code, signal });
    }),
  );
  return { child, exited: Effect.promise(() => closed), ended: () => ended };
}

/** Stops a running process, SIGTERM and then SIGKILL after `graceMs`, and waits until it has exited. */
export const stopProcess = (running: Running, graceMs = STOP_GRACE_MS): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (running.ended()) return;
    running.child.kill("SIGTERM");
    yield* running.exited.pipe(
      Effect.timeoutOrElse({
        duration: graceMs,
        orElse: () => Effect.sync(() => running.child.kill("SIGKILL")).pipe(Effect.andThen(running.exited)),
      }),
    );
  });

/** A program that could not start, or exited with an error: its exit code (as `code`) and the end of what it wrote to stderr. */
export class RunFailed extends Data.TaggedError("RunFailed")<{ readonly message: string; readonly code?: number }> {}

/**
 * Runs a program, held in a scope until it has exited (interrupted, it is stopped: SIGTERM, then SIGKILL after 5 s):
 * its output, or a RunFailed with its exit code and the end of what it wrote to stderr.
 */
export const run = (program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Effect.Effect<{ stdout: string }, RunFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { child, exited } = yield* spawnScoped(() =>
        spawn(program, args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }),
      );
      let stdout = "";
      let stderr = "";
      let failedToStart: Error | null = null;
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr!.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
      child.on("error", (error) => (failedToStart ??= error));
      if (options.input !== undefined) child.stdin!.end(options.input);
      const { code, signal } = yield* exited;
      if (failedToStart) return yield* new RunFailed({ message: (failedToStart as Error).message });
      if (code === 0) return { stdout };
      return yield* new RunFailed({
        message: `${basename(program)} ${signal ? `was stopped by ${signal}` : `exited ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        code: code ?? undefined,
      });
    }),
  );
