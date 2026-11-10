// Which process runs the live bridges. Only one process may run the sync
// connectors on an archive at a time: two would race each connector's saved
// position (its cursor), and once sending is on, a message could go out twice.
//
// - The process running them keeps an owner record in meta (live_owner): an id
//   of its own, its process id, when it took it, and a heartbeat it renews.
// - Another process finds the record held and waits, looking again every so
//   often (see keepLiveBridges).
// - The record is free when there is none, when its process has died, or when
//   its heartbeat has not moved for `staleAfterMs` as this process saw it.
//   Staleness is judged by this process's own monotonic clock, from when it
//   first saw that heartbeat, never by comparing wall-clock times: when the Mac
//   sleeps, both processes stop alike, so a long sleep does not make the owner
//   look dead.
// - The archive is in WAL mode, which works only for processes on one machine,
//   so a process id in the record is always one this process can look up.
//
// Written in Effect (docs/effect.md): ConnectorHost runs keepLiveBridges
// through server/effectRuntime.ts. Times come from Effect's Clock, so a test
// can move them with TestClock.

import { randomUUID } from "node:crypto";
import { Clock, Data, Effect, Schedule } from "effect";
import { transaction, type Db } from "../archive/db.ts";
import { isAlive } from "../alive.ts";

const KEY = "live_owner";

export interface LiveOwner {
  /** One per lock, so two archives opened in one process are told apart. */
  id: string;
  pid: number;
  since: number;
  /** Renewed every heartbeat; another process watches it move. */
  beat: number;
}

/** The archive could not be read or written for the lock (a busy database, say). */
export class LiveLockError extends Data.TaggedError("LiveLockError")<{ readonly message: string }> {}

export interface LiveLock {
  readonly id: string;
  /** Takes the lock if it is free or already ours, giving null; otherwise gives who holds it. */
  readonly take: Effect.Effect<LiveOwner | null, LiveLockError>;
  /** Renews the heartbeat; false when the lock is no longer ours (another process took it). */
  readonly renew: Effect.Effect<boolean, LiveLockError>;
  /** Lets the lock go, if it is ours. */
  readonly release: Effect.Effect<void, LiveLockError>;
}

export function makeLiveLock(db: Db, { staleAfterMs }: { staleAfterMs: number }): LiveLock {
  const id = randomUUID();
  /** The other owner's heartbeat as last seen, and when (monotonic ms) it was first seen at that value. */
  let seen: { id: string; beat: number; at: number } | null = null;

  /** Runs one statement or transaction against the archive, its error a LiveLockError. */
  const sql = <A>(work: (clock: Clock.Clock) => A) =>
    Clock.clockWith((clock) => Effect.try({ try: () => work(clock), catch: (cause) => new LiveLockError({ message: (cause as Error).message }) }));

  const write = (owner: LiveOwner) =>
    db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(KEY, JSON.stringify(owner));

  /** Whether another owner's process has died, or its heartbeat has stood still for staleAfterMs. */
  const isGone = (holder: LiveOwner, clock: Clock.Clock): boolean => {
    if (holder.pid !== process.pid && !isAlive(holder.pid)) return true;
    const now = Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
    if (seen?.id !== holder.id || seen.beat !== holder.beat) {
      seen = { id: holder.id, beat: holder.beat, at: now };
      return false;
    }
    return now - seen.at >= staleAfterMs;
  };

  return {
    id,
    take: sql((clock) =>
      transaction(db, () => {
        const holder = liveOwner(db);
        if (holder && holder.id !== id && !isGone(holder, clock)) return holder;
        const now = clock.currentTimeMillisUnsafe();
        const since = holder?.id === id ? holder.since : now;
        write({ id, pid: process.pid, since, beat: now });
        seen = null;
        return null;
      }),
    ),
    renew: sql(
      (clock) =>
        db
          .prepare("UPDATE meta SET value = json_set(value, '$.beat', ?) WHERE key = ? AND json_extract(value, '$.id') = ?")
          .run(clock.currentTimeMillisUnsafe(), KEY, id).changes === 1,
    ),
    release: sql(() => void db.prepare("DELETE FROM meta WHERE key = ? AND json_extract(value, '$.id') = ?").run(KEY, id)),
  };
}

/** What keepLiveBridges drives: the sync connectors of one archive. */
export interface LiveBridges {
  /** Shows every bridge waiting, with why; it starts nothing. */
  hold(detail: string): void;
  /** This process has taken the lock: starts them. */
  start(): void;
  /** Stops them, another process having taken the lock. */
  stop(): Promise<void>;
  log(line: string): void;
}

/**
 * Runs the live bridges here while this process holds the lock, for as long as it runs.
 *
 * It takes the lock, or shows the bridges waiting and looks again every `checkEveryMs`. Once it
 * holds it, it starts them and renews its heartbeat every `heartbeatEveryMs`; should another
 * process take the lock, it stops them and waits for it again. Interrupting it stops only the
 * looking and the heartbeat: the bridges and the lock are its caller's to stop and let go.
 */
export const keepLiveBridges = (
  lock: LiveLock,
  bridges: LiveBridges,
  { checkEveryMs, heartbeatEveryMs }: { checkEveryMs: number; heartbeatEveryMs: number },
): Effect.Effect<never> => {
  // Why the bridges cannot run here yet, or null once this process holds the lock.
  const claim = lock.take.pipe(
    Effect.map((holder) => (holder ? describeOwner(holder) : null)),
    Effect.catchTag("LiveLockError", (error) => Effect.succeed(`could not tell who runs the live bridges: ${error.message}`)),
    Effect.tap((waiting) => Effect.sync(() => waiting !== null && bridges.hold(waiting))),
    Effect.repeat({ schedule: Schedule.spaced(checkEveryMs), while: (waiting) => waiting !== null }),
  );
  // A busy database: try again at the next heartbeat, well before the lock looks stale.
  const renew = lock.renew.pipe(
    Effect.catchTag("LiveLockError", (error) =>
      Effect.sync(() => bridges.log(`could not renew the live bridges' lock: ${error.message}`)).pipe(Effect.as(true)),
    ),
  );
  return Effect.gen(function* () {
    yield* claim;
    bridges.start();
    yield* renew.pipe(Effect.delay(heartbeatEveryMs), Effect.repeat({ while: (ours) => ours }));
    bridges.log("another process took over the live bridges; stopping them here");
    yield* Effect.promise(() => bridges.stop());
  }).pipe(Effect.forever);
};

/** The owner record as it stands, or null when no process runs the live bridges. */
export function liveOwner(db: Db): LiveOwner | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as LiveOwner) : null;
}

/** The holder in a few words, for the log and each connector's state. */
export function describeOwner(owner: LiveOwner): string {
  return `another process (pid ${owner.pid}) runs the live bridges`;
}
