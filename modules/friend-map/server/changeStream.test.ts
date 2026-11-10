// The page's change stream (/api/archive/events): its events on TestClock, and its end when the page closes it.

import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll } from "vitest";
import { archiveHandler } from "../testing/routes.ts";
import { changeEvents, WATCH_MS, type Versions } from "./http.ts";

describe("the change events", () => {
  it.effect("look every WATCH_MS: people when anyone's people changed, else messages when only the links did", () =>
    Effect.gen(function* () {
      const now: Versions = { people: "1", links: "1" };
      const seen: string[] = [];
      const fiber = yield* changeEvents(() => ({ ...now })).pipe(
        Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
        Effect.forkChild({ startImmediately: true }),
      );
      // Its first look is where it starts from: nothing to say, then nothing while nothing changes.
      yield* TestClock.adjust(WATCH_MS);
      expect(seen).toEqual([]);

      now.links = "2";
      yield* TestClock.adjust(WATCH_MS - 1);
      expect(seen).toEqual([]);
      yield* TestClock.adjust(1);
      expect(seen).toEqual(['event: messages\ndata: "2"\n\n']);

      now.people = "2";
      now.links = "3";
      yield* TestClock.adjust(WATCH_MS);
      expect(seen.at(-1)).toBe('event: people\ndata: "2"\n\n');
      yield* TestClock.adjust(10 * WATCH_MS);
      expect(seen).toHaveLength(2);
      yield* Fiber.interrupt(fiber);
    }));
});

describe("the change stream", () => {
  let dataDir: string;
  let archive: TestArchive;
  let server: Server;
  let base: string;
  /** Each request's handler, settled once it has answered. */
  const answered: Array<Promise<void>> = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "life-archive-change-stream-"));
    archive = await openTestArchive(dataDir);
    const handler = archiveHandler(archive);
    server = createServer((req, res) => void answered.push(handler(req, res)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/archive`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    archive.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it.live("ends when the page closes it", () =>
    Effect.promise(async () => {
      const abort = new AbortController();
      const response = await fetch(`${base}/events`, { signal: abort.signal });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      expect((await reader.read()).value).toBe(": watching people\n\n");
      const handled = answered.at(-1)!;
      let ended = false;
      void handled.then(() => (ended = true));
      await new Promise((resolve) => setTimeout(resolve, WATCH_MS + 200));
      expect(ended).toBe(false);
      abort.abort();
      await handled;
      expect(ended).toBe(true);
    }));
});
