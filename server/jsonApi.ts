// The pieces a JSON route here is made of (archive/http.ts, viewer/http.ts, modules/health/server/http.ts):
//
// - A route is an Effect program per request (Route): it reads the server's services (OpenArchive, ViewerDb,
//   AiService), and its type lists the errors it answers (errors.ts).
// - serve runs it for node:http, and is the one place those errors become their status: 404, 400, 409 or 403 with
//   {error: message}; anything else is a bug, logged and answered 500.
// - The archive's rules stay plain and throw those errors; answering lifts what they throw into the route's type.
// - Reading a request's body, sending JSON, and refusing what another site's page sent.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Context, Effect } from "effect";
import { ForbiddenError, InvalidInputError, STATUS, type RouteError } from "./errors.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** What node:http calls for a request; the promise settles once it is answered. */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** A route: the program answering one request, failing only with the route errors it answers, and needing `R`. */
export type Route<E extends RouteError, R> = (req: IncomingMessage, res: ServerResponse) => Effect.Effect<void, E, R>;

/**
 * `route` for node:http, each request run with `context` (the server's services): a route error is answered with its
 * status (STATUS) and {error: its message}; anything else is logged and answered 500.
 */
export function serve<E extends RouteError, R>(context: Context.Context<R>, route: Route<E, R>): ApiHandler {
  const run = Effect.runPromiseWith(context);
  return (req, res) =>
    run(
      route(req, res).pipe(
        Effect.catch((error: RouteError) => Effect.sync(() => sendJson(res, STATUS[error._tag], { error: error.message }))),
        Effect.catchDefect((defect) =>
          Effect.sync(() => {
            console.error(defect);
            sendJson(res, 500, { error: defect instanceof Error ? defect.message : String(defect) });
          }),
        ),
      ),
    );
}

/** `route` for node:http, run with the services of the Effect that makes it (the server's Layer). */
export const handler = <E extends RouteError, R>(route: Route<E, R>): Effect.Effect<ApiHandler, never, R> =>
  Effect.map(Effect.context<R>(), (context) => serve(context, route));

type RouteErrorClass = abstract new (...args: never[]) => RouteError;

/**
 * Lifts the route errors of `answers` that plain code threw (or a promise rejected with) inside `self` into its error
 * channel, so its type lists them; any other throw stays a defect, answered 500.
 */
export const answering =
  <const C extends readonly RouteErrorClass[]>(...answers: C) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | InstanceType<C[number]>, R> =>
    self.pipe(
      Effect.catchDefect((defect) =>
        answers.some((answer) => defect instanceof answer) ? Effect.fail(defect as InstanceType<C[number]>) : Effect.die(defect),
      ),
    );

/**
 * Refuses a request another site's page sent: one whose browser says it came from elsewhere (Sec-Fetch-Site),
 * or whose Origin is not this server.
 */
export const fromOwnPage = (req: IncomingMessage): Effect.Effect<void, ForbiddenError> =>
  Effect.suspend(() => {
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") return Effect.fail(new ForbiddenError("this is only for friend-map's own page"));
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        // An unreadable Origin is refused below.
      }
      if (host !== req.headers.host) return Effect.fail(new ForbiddenError("this is only for friend-map's own page"));
    }
    return Effect.void;
  });

/** The request's body, refused once it passes `max` bytes. */
async function readBytes(req: IncomingMessage, max: number, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new InvalidInputError(`${what} is over ${max / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The request's body, whole, refused once it passes `max` bytes (10 MB unless said). */
export const readBody = (req: IncomingMessage, max = MAX_BODY_BYTES): Effect.Effect<Buffer, InvalidInputError> =>
  Effect.promise(() => readBytes(req, max, "the request body")).pipe(answering(InvalidInputError));

/** The request's body, read as JSON. */
export const readJson = (req: IncomingMessage): Effect.Effect<unknown, InvalidInputError> =>
  readBody(req).pipe(
    Effect.flatMap((body) =>
      Effect.try({ try: (): unknown => JSON.parse(body.toString("utf8")), catch: () => new InvalidInputError("request body is not valid JSON") }),
    ),
  );

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
