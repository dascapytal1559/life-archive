// Where plain TypeScript runs Effect code, while the server moves to Effect
// piece by piece (docs/effect.md, docs/effect-migration.md).
//
// - Plain code runs an Effect program only through these functions, so there
//   is one place where Effect meets the rest of the server.
// - A program run here needs nothing (its requirements are `never`): it is
//   given its database and settings as arguments, or provided them, first.
// - A failure comes back to plain code as the error itself (a tagged error,
//   or what a promise it awaited rejected with), never wrapped.
// - A command's process (an npm run script) runs its program with runMain,
//   its edge: a signal interrupts it, so what it holds is let go first.
//
// The server's own resources are its Layer's (serverLayer.ts), run by the
// ManagedRuntime main.ts builds. The fibers runPromise and runBackground start stay
// owned by the plain classes that start them (SyncRunner, ConnectorHost,
// CodexService), which the server's Layer stops in order; run on that runtime,
// they would be interrupted all at once as it is disposed, before its Layer
// is closed.

import { Cause, Effect, Fiber } from "effect";

/** Runs `program` to its end and returns what it gives, or rejects with its error. */
export function runPromise<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program);
}

/**
 * Starts `program` in the background, on this turn up to its first wait, and returns its fiber;
 * `Effect.runPromise(Fiber.interrupt(fiber))` stops it. Its program handles every error it expects,
 * so one that ends it anyway is a bug: it is thrown again outside, as a throw from a timer would be,
 * rather than lost.
 */
export function runBackground<A>(program: Effect.Effect<A>): Fiber.Fiber<A> {
  const fiber = Effect.runFork(program);
  fiber.addObserver((exit) => {
    if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) {
      queueMicrotask(() => {
        throw Cause.squash(exit.cause);
      });
    }
  });
  return fiber;
}

/**
 * Runs a command's `program` (an npm run script) to its end, or until SIGINT or SIGTERM, which interrupt it so that
 * what it holds is let go (a child process stopped, a lock, a file deleted); then the signal ends the process, as it
 * would have. Its program handles every error it expects, so one that ends it anyway is thrown, as a bug.
 */
export async function runMain<A>(program: Effect.Effect<A>): Promise<A | undefined> {
  const fiber = Effect.runFork(program);
  let caught: NodeJS.Signals | null = null;
  const stop = (signal: NodeJS.Signals) => {
    caught ??= signal;
    fiber.interruptUnsafe();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop);
  if (caught) {
    process.kill(process.pid, caught);
    return undefined;
  }
  if (exit._tag === "Failure") throw Cause.squash(exit.cause);
  return exit.value;
}
