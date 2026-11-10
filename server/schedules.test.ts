// The restart ladder, its clock moved by hand (TestClock).

import { describe, expect, it } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { restartLadder } from "./schedules.ts";

describe("the restart ladder", () => {
  it.effect("waits 10 s, 1 min, 5 min, then every 30 min, and starts over after a run that went well", () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(restartLadder());
      const stop = (ranWell: boolean) => step(0, { ranWell }).pipe(Effect.map(([inARow, wait]) => [inARow, Duration.toMillis(wait)]));
      const steps = [];
      for (const ranWell of [false, false, false, false, false, true, false]) steps.push(yield* stop(ranWell));
      expect(steps).toEqual([[1, 10_000], [2, 60_000], [3, 300_000], [4, 1_800_000], [5, 1_800_000], [1, 10_000], [2, 60_000]]);
    }));

  it.effect("drives a retry: a run that keeps stopping is started again at those times", () =>
    Effect.gen(function* () {
      const startedAt: number[] = [];
      const run = Clock.currentTimeMillis.pipe(
        Effect.tap((now) => Effect.sync(() => startedAt.push(now))),
        Effect.andThen(Effect.fail({ ranWell: false })),
      );
      const fiber = yield* Effect.forkChild(run.pipe(Effect.retry(restartLadder())), { startImmediately: true });
      yield* TestClock.adjust(2 * 60 * 60_000);
      yield* Fiber.interrupt(fiber);
      expect(startedAt).toEqual([0, 10_000, 70_000, 370_000, 2_170_000, 3_970_000, 5_770_000]);
    }));
});
