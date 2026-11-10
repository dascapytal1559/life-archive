// Polar's AccessLink v3 (https://www.polar.com/accesslink-api/), as the captain's own registered client: only the
// requests the archive makes, each with his access token. The non-transactional Exercises endpoints alone (the
// transactions were deprecated on 18.08.2025): they list what was uploaded to Flow in the last 30 days, after he
// registered with the client.
//
//   GET  /v3/exercises                                         the exercises, without their samples
//   GET  /v3/exercises/{id}?samples=true&zones=true&route=true one exercise, with its samples, zones and route
//   GET  /v3/exercises/{id}/fit                                its FIT file
//   POST /v3/users                                             registering him once, at login (login.ts)
//
// A 401 is a token Polar no longer takes (revoked, or expired: the docs say both that it never expires and that it
// lasts a year), so the connector says "reconnect needed"; a 403 is mandatory consents not yet accepted.

import { Data, Effect } from "effect";
import type { PolarExercise } from "./exercise.ts";

/** Where AccessLink answers. */
export const ACCESSLINK = "https://www.polaraccesslink.com";

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Polar refused the token (401): the captain logs in again. */
export class PolarUnauthorized extends Data.TaggedError("PolarUnauthorized")<{ readonly message: string }> {}

/** Anything else that went wrong asking Polar: no answer, a 403, a 5xx, an answer not as documented. */
export class PolarRequestFailed extends Data.TaggedError("PolarRequestFailed")<{ readonly message: string; readonly status?: number }> {}

export type PolarError = PolarUnauthorized | PolarRequestFailed;

/** Polar's answer to one request: its status and body, or why there was none. */
const request = (url: string, init: RequestInit, what: string): Effect.Effect<Response, PolarError> =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) }),
    catch: (error) => new PolarRequestFailed({ message: `could not reach Polar for ${what}: ${(error as Error).message}` }),
  }).pipe(
    Effect.flatMap((res): Effect.Effect<Response, PolarError> => {
      if (res.ok) return Effect.succeed(res);
      if (res.status === 401) return Effect.fail(new PolarUnauthorized({ message: `Polar refused the archive's token (401) for ${what}` }));
      const why = res.status === 403
        ? "the captain's Polar account has mandatory consents not yet accepted (403): accept them at https://account.polar.com"
        : res.status === 429 ? "Polar's rate limit was reached (429)" : `Polar answered ${res.status}`;
      return Effect.fail(new PolarRequestFailed({ message: `${why}, for ${what}`, status: res.status }));
    }),
  );

const bodyOf = <A>(res: Response, what: string, read: (res: Response) => Promise<A>): Effect.Effect<A, PolarRequestFailed> =>
  Effect.tryPromise({ try: () => read(res), catch: () => new PolarRequestFailed({ message: `Polar's answer for ${what} could not be read` }) });

/** AccessLink at `base` (ACCESSLINK; a made-up one in the tests), with the access token `token`. */
export function accessLink(base: string, token: string) {
  const url = (path: string) => new URL(path, base).toString();
  const auth = { Authorization: `Bearer ${token}` };
  return {
    /** The exercises uploaded to Flow in the last 30 days, without their samples. A 204 is none. */
    exercises: request(url("/v3/exercises"), { headers: { ...auth, Accept: "application/json" } }, "the list of exercises").pipe(
      Effect.flatMap((res) => (res.status === 204 ? Effect.succeed([]) : bodyOf(res, "the list of exercises", (r) => r.json() as Promise<unknown>))),
      Effect.flatMap((list) =>
        Array.isArray(list) && list.every((item) => typeof item?.id === "string")
          ? Effect.succeed(list as PolarExercise[])
          : Effect.fail(new PolarRequestFailed({ message: "Polar's list of exercises is not a list of exercises" })),
      ),
    ),
    /** One exercise with its samples, zones and route, as the bytes Polar gave (the copy), or null when it is gone (404). */
    exercise: (id: string) =>
      request(url(`/v3/exercises/${encodeURIComponent(id)}?samples=true&zones=true&route=true`), { headers: { ...auth, Accept: "application/json" } }, "an exercise").pipe(
        Effect.flatMap((res) => bodyOf(res, "an exercise", async (r) => Buffer.from(await r.arrayBuffer()))),
        Effect.catchIf((error) => error._tag === "PolarRequestFailed" && error.status === 404, () => Effect.succeed(null)),
      ),
    /** An exercise's FIT file, or null when Polar has none for it (404). */
    fit: (id: string) =>
      request(url(`/v3/exercises/${encodeURIComponent(id)}/fit`), { headers: { ...auth, Accept: "*/*" } }, "an exercise's FIT file").pipe(
        Effect.flatMap((res) => bodyOf(res, "an exercise's FIT file", async (r) => Buffer.from(await r.arrayBuffer()))),
        Effect.catchIf((error) => error._tag === "PolarRequestFailed" && error.status === 404, () => Effect.succeed(null)),
      ),
    /**
     * Registers the captain with the client, once, under the archive's own id for him (`memberId`); one already
     * registered (409) is fine.
     */
    register: (memberId: string) =>
      request(url("/v3/users"), { method: "POST", headers: { ...auth, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ "member-id": memberId }) }, "registering the captain").pipe(
        Effect.as("registered" as const),
        Effect.catchIf((error) => error._tag === "PolarRequestFailed" && error.status === 409, () => Effect.succeed("already registered" as const)),
      ),
  };
}

/** Whether bytes are a FIT file: its header's size (12 or 14) and ".FIT" signature. */
export function isFit(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && (bytes[0] === 12 || bytes[0] === 14) && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === ".FIT";
}
