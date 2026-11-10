// The live bridges' lock on its own, its clock moved by hand (TestClock).
// server/archive/live.test.ts runs it with real connectors and real time.

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { type Db } from "../archive/db.ts";
import { openCore } from "../archive/coreDb.ts";
import { describeOwner, keepLiveBridges, liveOwner, makeLiveLock, type LiveBridges, type LiveLock } from "./liveLock.ts";

let db: Db;
beforeEach(() => {
  db = openCore(":memory:");
});
afterEach(() => db.close());

const otherOwner = (fields: { id?: string; pid?: number; beat?: number } = {}) =>
  db.prepare("INSERT INTO meta (key, value) VALUES ('live_owner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ id: "elsewhere", pid: process.pid, since: 1, beat: 1, ...fields }));

describe("the live bridges' lock", () => {
  it.effect("is taken when free, and taken again by its owner", () =>
    Effect.gen(function* () {
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      expect(yield* lock.take).toBeNull();
      const owner = liveOwner(db)!;
      expect(owner).toMatchObject({ id: lock.id, pid: process.pid });
      yield* TestClock.adjust(5_000);
      expect(yield* lock.take).toBeNull();
      expect(liveOwner(db)).toMatchObject({ since: owner.since, beat: owner.beat + 5_000 });
    }));

  it.effect("waits for a live owner whose heartbeat stands still, until staleAfterMs from when it first saw it", () =>
    Effect.gen(function* () {
      otherOwner();
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      expect(yield* lock.take).toMatchObject({ id: "elsewhere" });
      yield* TestClock.adjust(119_999);
      expect(yield* lock.take).toMatchObject({ id: "elsewhere" });
      yield* TestClock.adjust(1);
      expect(yield* lock.take).toBeNull();
      expect(liveOwner(db)?.id).toBe(lock.id);
    }));

  it.effect("starts counting again when the heartbeat moves", () =>
    Effect.gen(function* () {
      otherOwner({ beat: 1 });
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      yield* lock.take;
      yield* TestClock.adjust(100_000);
      otherOwner({ beat: 2 });
      yield* lock.take;
      yield* TestClock.adjust(100_000);
      expect(yield* lock.take).toMatchObject({ id: "elsewhere" });
    }));

  it.effect("is taken at once from a process that has died", () =>
    Effect.gen(function* () {
      otherOwner({ pid: spawnSync(process.execPath, ["-e", ""]).pid! });
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      expect(yield* lock.take).toBeNull();
    }));

  it.effect("renews only while it is ours, and lets go only its own", () =>
    Effect.gen(function* () {
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      yield* lock.take;
      expect(yield* lock.renew).toBe(true);
      otherOwner();
      expect(yield* lock.renew).toBe(false);
      yield* lock.release;
      expect(liveOwner(db)?.id).toBe("elsewhere");
    }));

  it.effect("fails with a LiveLockError when the archive cannot be read", () =>
    Effect.gen(function* () {
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      db.exec("DROP TABLE meta");
      const error = yield* Effect.flip(lock.take);
      expect(error._tag).toBe("LiveLockError");
      expect(error.message).toMatch(/no such table: meta/);
    }));
});

describe("keepLiveBridges", () => {
  const bridges = () => {
    const said: string[] = [];
    const recorder: LiveBridges = {
      hold: (detail) => void said.push(`hold: ${detail}`),
      start: () => void said.push("start"),
      stop: async () => void said.push("stop"),
      log: (line) => void said.push(`log: ${line}`),
    };
    return { said, recorder };
  };
  const timings = { checkEveryMs: 60_000, heartbeatEveryMs: 20_000 };
  // Started at once, up to its first wait, as ConnectorHost's runBackground starts it.
  const keep = (lock: LiveLock, recorder: LiveBridges) => Effect.forkChild(keepLiveBridges(lock, recorder, timings), { startImmediately: true });
  const held = `hold: ${describeOwner({ id: "elsewhere", pid: process.pid, since: 1, beat: 1 })}`;

  it.effect("waits while another process holds the lock, looking again every checkEveryMs, then starts them", () =>
    Effect.gen(function* () {
      otherOwner();
      const { said, recorder } = bridges();
      const keeper = yield* keep(makeLiveLock(db, { staleAfterMs: 120_000 }), recorder);
      expect(said).toEqual([held]);
      yield* TestClock.adjust(59_999);
      expect(said).toEqual([held]);
      yield* TestClock.adjust(1);
      expect(said).toEqual([held, held]);
      db.exec("DELETE FROM meta WHERE key = 'live_owner'");
      yield* TestClock.adjust(60_000);
      expect(said).toEqual([held, held, "start"]);
      yield* Fiber.interrupt(keeper);
    }));

  it.effect("renews every heartbeatEveryMs, and stops them and waits again once another process takes the lock", () =>
    Effect.gen(function* () {
      const lock = makeLiveLock(db, { staleAfterMs: 120_000 });
      const { said, recorder } = bridges();
      const keeper = yield* keep(lock, recorder);
      expect(said).toEqual(["start"]);
      const beat = liveOwner(db)!.beat;
      yield* TestClock.adjust(20_000);
      expect(liveOwner(db)!.beat).toBe(beat + 20_000);
      otherOwner();
      yield* TestClock.adjust(20_000);
      // Stopping them is a promise: it settles before the keeper looks for the lock again.
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      expect(said).toEqual(["start", "log: another process took over the live bridges; stopping them here", "stop", held]);
      yield* Fiber.interrupt(keeper);
    }));

  it.effect("carries on through a heartbeat that cannot be written, and shows them waiting when the lock cannot be read", () =>
    Effect.gen(function* () {
      const { said, recorder } = bridges();
      const keeper = yield* keep(makeLiveLock(db, { staleAfterMs: 120_000 }), recorder);
      db.exec("DROP TABLE meta");
      yield* TestClock.adjust(20_000);
      expect(said).toEqual(["start", "log: could not renew the live bridges' lock: no such table: meta"]);
      yield* Fiber.interrupt(keeper);
      const waiting = bridges();
      const other = yield* keep(makeLiveLock(db, { staleAfterMs: 120_000 }), waiting.recorder);
      expect(waiting.said).toEqual(["hold: could not tell who runs the live bridges: no such table: meta"]);
      yield* Fiber.interrupt(other);
    }));
});
