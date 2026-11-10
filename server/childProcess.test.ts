// A child process held in a scope: stopped when its scope closes, SIGTERM and then SIGKILL 5 s on, its clock moved
// by hand (TestClock) while the process is real.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { spawnScoped, stopProcess, watch, type Running } from "./childProcess.ts";

/** A node process that says when it is ready, then runs until stopped; `stubborn` ignores SIGTERM. */
const node = (stubborn: boolean) =>
  spawn(process.execPath, ["-e", `${stubborn ? "process.on('SIGTERM', () => {});" : ""} process.stdout.write('ready'); setInterval(() => {}, 1000);`]);
const ready = (running: Running) => Effect.promise(() => once(running.child.stdout!, "data"));
/** Real time passing, for a real process to do what it does. */
const pause = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("a child process in a scope", () => {
  it.effect("is sent SIGTERM when its scope closes, and waited for", () =>
    Effect.gen(function* () {
      const running = yield* Effect.scoped(spawnScoped(() => node(false)).pipe(Effect.tap(ready)));
      expect(running.ended()).toBe(true);
      expect(yield* running.exited).toEqual({ code: null, signal: "SIGTERM" });
    }));

  it.effect("is sent SIGKILL 5 s after SIGTERM if it is still running", () =>
    Effect.gen(function* () {
      const running = watch(node(true));
      yield* ready(running);
      const stopping = yield* Effect.forkChild(stopProcess(running), { startImmediately: true });
      yield* pause(200);
      yield* TestClock.adjust(4_999);
      yield* pause(100);
      expect(running.ended()).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(stopping);
      expect(yield* running.exited).toEqual({ code: null, signal: "SIGKILL" });
    }));

  it.effect("leaves a process that has already ended alone", () =>
    Effect.gen(function* () {
      const running = watch(spawn(process.execPath, ["-e", ""]));
      expect(yield* running.exited).toEqual({ code: 0, signal: null });
      yield* stopProcess(running);
      expect(running.child.killed).toBe(false);
    }));
});
