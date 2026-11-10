// The schedules the server shares (docs/effect.md, "Retries and schedules").

import { Duration, Effect, Schedule } from "effect";

/** How long to wait before starting something again after it stopped: 10 s, 1 min, 5 min, then every 30 min. */
export const RESTART_DELAYS_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000];

/** How a run that stopped went, for the restart ladder. */
export interface Stopped {
  /** Whether it did good work before it stopped (a sync connector applied a batch, say): the ladder then starts over. */
  readonly ranWell: boolean;
}

/**
 * The restart ladder: the n-th stop in a row waits the n-th of `delaysMs`, and every stop after the last waits the
 * last. A stop after a run that went well is the first in a row again. Its output is how many stops are in the row.
 * The sync runner (connectors/sync.ts) steps it after each stop; Codex's restarts (codex.ts) are to use it too.
 */
export const restartLadder = (delaysMs: readonly number[] = RESTART_DELAYS_MS): Schedule.Schedule<number, Stopped> =>
  Schedule.fromStep(
    Effect.sync(() => {
      let inARow = 0;
      return (_now: number, stopped: Stopped) => {
        inARow = stopped.ranWell ? 1 : inARow + 1;
        return Effect.succeed([inARow, Duration.millis(delaysMs[Math.min(inARow, delaysMs.length) - 1])] as [number, Duration.Duration]);
      };
    }),
  );
