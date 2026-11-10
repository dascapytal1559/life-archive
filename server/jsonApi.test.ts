// The one place route errors become their status (serve), and lifting what plain code throws (answering).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { afterEach, vi } from "vitest";
import { ForbiddenError, InvalidInputError, NotFoundError, UnavailableError, type RouteError } from "./errors.ts";
import { answering, sendJson, serve, type Route } from "./jsonApi.ts";

/** A route error of a module's own, a subclass of one of the core's (as friend map's QueryError is of InvalidInputError). */
class QueryError extends InvalidInputError {}

let server: Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
});

/** What `route` answers a GET. */
async function answer(route: Route<RouteError, never>): Promise<{ status: number; body: unknown }> {
  const handler = serve(Context.empty(), route);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  return { status: response.status, body: await response.json() };
}

describe("serve", () => {
  it.live("answers each route error with its status and message, and anything else 500, logged", () =>
    Effect.promise(async () => {
      expect(await answer(() => Effect.fail(new NotFoundError("no person 7")))).toEqual({ status: 404, body: { error: "no person 7" } });
      expect(await answer(() => Effect.fail(new InvalidInputError("bad")))).toEqual({ status: 400, body: { error: "bad" } });
      expect(await answer(() => Effect.fail(new UnavailableError("not now")))).toEqual({ status: 409, body: { error: "not now" } });
      expect(await answer(() => Effect.fail(new ForbiddenError("elsewhere")))).toEqual({ status: 403, body: { error: "elsewhere" } });
      // A subclass keeps its parent's tag, and so its status.
      expect(await answer(() => Effect.fail(new QueryError("SQL: no such column")))).toEqual({ status: 400, body: { error: "SQL: no such column" } });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await answer(() => Effect.die(new Error("a bug")))).toEqual({ status: 500, body: { error: "a bug" } });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(await answer((_req, res) => Effect.sync(() => sendJson(res, 200, { ok: true })))).toEqual({ status: 200, body: { ok: true } });
    }));
});

describe("answering", () => {
  const thrown = (error: Error) =>
    Effect.sync(() => {
      throw error;
    });

  it.effect("lifts the route errors it names, a subclass with them, and leaves any other throw a defect", () =>
    Effect.gen(function* () {
      const notFound = yield* Effect.flip(thrown(new NotFoundError("gone")).pipe(answering(NotFoundError, InvalidInputError)));
      expect(notFound).toBeInstanceOf(NotFoundError);
      expect(notFound._tag).toBe("NotFoundError");
      expect(yield* Effect.flip(thrown(new QueryError("SQL")).pipe(answering(InvalidInputError)))).toBeInstanceOf(QueryError);
      // One it does not name is a defect, as before: the route answered 500 for it.
      const exit = yield* Effect.exit(thrown(new UnavailableError("not named")).pipe(answering(NotFoundError)));
      expect(exit._tag === "Failure" && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true);
    }));
});
