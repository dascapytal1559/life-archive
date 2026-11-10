import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { mirror, withCopiesLock } from "./sessionCopies.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-session-copies-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the archive's copies of session files", () => {
  it("makes a copy, grows it with its file, and keeps it when the file goes", async () => {
    const source = join(dir, "app", "s.jsonl");
    const copy = join(dir, "llm", "agent", "s.jsonl");
    await expect(mirror(source, copy)).rejects.toThrow(/neither/);
    await mkdir(join(dir, "app"));
    await writeFile(source, "one\n");
    expect(await mirror(source, copy)).toEqual({ outcome: "new", bytes: 4 });
    expect(await mirror(source, copy)).toEqual({ outcome: "same", bytes: 4 });
    await writeFile(source, "one\ntwo\n");
    expect(await mirror(source, copy)).toEqual({ outcome: "grown", bytes: 8 });
    await rm(source);
    expect(await mirror(source, copy)).toEqual({ outcome: "gone", bytes: 8 });
    expect(await readFile(copy, "utf8")).toBe("one\ntwo\n");
    // Nothing but the copy is left beside it: no temporary file.
    expect(await readdir(join(dir, "llm", "agent"))).toEqual(["s.jsonl"]);
  });

  it("copies a file of lines to its last whole line", async () => {
    const source = join(dir, "s.jsonl");
    const copy = join(dir, "copy", "s.jsonl");
    await writeFile(source, "one\ntw");
    expect((await mirror(source, copy, { wholeLines: true })).outcome).toBe("new");
    expect(await readFile(copy, "utf8")).toBe("one\n");
    // The line is finished otherwise than it began: still a file that grew.
    await writeFile(source, "one\nTWO\n");
    expect((await mirror(source, copy, { wholeLines: true })).outcome).toBe("grown");
    expect(await readFile(copy, "utf8")).toBe("one\nTWO\n");
  });

  it("checks the copy's last 64 KB against its file, and all of it when thorough", async () => {
    const source = join(dir, "s.jsonl");
    const copy = join(dir, "copy", "s.jsonl");
    const early = "a".repeat(100 * 1024);
    await writeFile(source, `${early}\n`);
    await mirror(source, copy);
    // Changed early on, and grown: a quick pass sees only the end, so it grows the copy from the file.
    await writeFile(source, `b${early.slice(1)}\nmore\n`);
    expect((await mirror(source, copy)).outcome).toBe("grown");
    // A thorough pass sees the change: the copy stays, and the file is mirrored beside it.
    await writeFile(source, `b${early.slice(1)}\nmore\nand more\n`);
    expect((await mirror(source, copy, { thorough: true })).outcome).toBe("changed");
    expect(await readFile(copy, "utf8")).toBe(`${early}\nmore\n`);
    expect(await readFile(`${copy}.changed-1`, "utf8")).toBe(`b${early.slice(1)}\nmore\nand more\n`);
  });

  it.effect("lets one import at a time keep an origin's copies, and takes the lock from one that died", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        withCopiesLock(dir, Effect.sync(() => order.push("first in")).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.sync(() => order.push("first out"))))),
        { startImmediately: true },
      );
      const second = yield* Effect.forkChild(withCopiesLock(dir, Effect.sync(() => void order.push("second")), { everyMs: 5 }), { startImmediately: true });
      yield* TestClock.adjust(50);
      expect(order).toEqual(["first in"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      // The second looks again 5 ms on, and takes it.
      yield* TestClock.adjust(5);
      yield* Fiber.join(second);
      expect(order).toEqual(["first in", "first out", "second"]);
      expect(existsSync(join(dir, ".importing"))).toBe(false);

      // A lock left by a process that has died is taken at once.
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
      writeFileSync(join(dir, ".importing"), `${dead}\n`);
      expect(yield* withCopiesLock(dir, Effect.succeed("taken"))).toBe("taken");

      // One held by a live process is waited for, looking every 200 ms, and given up on after ten minutes.
      writeFileSync(join(dir, ".importing"), `${process.ppid}\n`);
      const waiting = yield* Effect.forkChild(Effect.flip(withCopiesLock(dir, Effect.succeed("never"))), { startImmediately: true });
      yield* TestClock.adjust(10 * 60_000 - 1);
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      const held = yield* Fiber.join(waiting);
      expect(held._tag).toBe("CopiesLockHeld");
      expect(held.message).toMatch(new RegExp(`another import is keeping the copies in .* \\(process ${process.ppid}\\)`));
      // And the lock is still its holder's.
      expect(readFileSync(join(dir, ".importing"), "utf8")).toBe(`${process.ppid}\n`);
    }));

  it.effect("lets the lock go however the work ends", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(withCopiesLock(dir, Effect.fail(new Error("the work failed"))));
      expect(failed.message).toBe("the work failed");
      expect(existsSync(join(dir, ".importing"))).toBe(false);
      const stopped = yield* Effect.forkChild(withCopiesLock(dir, Effect.never), { startImmediately: true });
      expect(existsSync(join(dir, ".importing"))).toBe(true);
      yield* Fiber.interrupt(stopped);
      expect(existsSync(join(dir, ".importing"))).toBe(false);
    }));
});
