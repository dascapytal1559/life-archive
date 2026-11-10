// `npm run exercise -- polar login`: connects the archive to the captain's Polar account, once (docs/events.md's "Workouts from
// Polar"). Only he can do it: it opens Polar's own page in his browser, where he signs in and grants access.
//
//   1. The API client he registered at https://admin.polaraccesslink.com (its redirect URL REDIRECT_URL): asked for
//      once, its id and secret typed here (the secret unseen) and kept in the Keychain (secrets.ts); --new-client asks again.
//   2. Polar's authorisation page, opened in his browser, which sends the browser back to REDIRECT_URL: a listener on
//      this Mac alone (127.0.0.1 and ::1), only while the login waits (10 minutes at most), takes the one answer whose
//      `state` is the one sent, and stops.
//   3. The code exchanged for the access token (POST to Polar's token endpoint, the client's id and secret as HTTP
//      Basic), at once: a code is good once, for 10 minutes.
//   4. Him registered with the client (POST /v3/users) under the archive's own id for him, its settings' memberId
//      (made the first time); already registered is fine. A 403 is consents to accept at https://account.polar.com.
//   5. The token kept in the Keychain, the settings' memberId written and the connector switched on, so the server
//      polls from its next look. Nothing secret is ever printed or written to a file.

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Data, Deferred, Duration, Effect } from "effect";
import { accessLink, ACCESSLINK } from "./api.ts";
import type { PolarSecrets } from "./secrets.ts";
import { readSettings, updateSettings } from "./settings.ts";
import { envSetting } from "../../../../sdk/server.ts";

/** The port the login listens on, which the client's redirect URL names: POLAR_LOGIN_PORT, else 4655. */
export const LOGIN_PORT = Number(envSetting("POLAR_LOGIN_PORT") ?? 4655);
export const REDIRECT_PATH = "/polar/callback";
/** The redirect URL to give the client at admin.polaraccesslink.com. */
export const REDIRECT_URL = `http://localhost:${LOGIN_PORT}${REDIRECT_PATH}`;
export const AUTHORIZE_URL = "https://flow.polar.com/oauth2/authorization";
export const TOKEN_URL = "https://polarremote.com/v2/oauth2/token";
/** How long the login waits for the browser to come back. */
export const LOGIN_WAIT_MS = 10 * 60_000;

/** Why the login did not connect Polar, in words for the captain; never a secret. */
export class PolarLoginFailed extends Data.TaggedError("PolarLoginFailed")<{ readonly message: string }> {}

export interface LoginOptions {
  secrets: PolarSecrets;
  /** data/connectors/polar.json. */
  settingsFile: string;
  /** Asks the captain a question at the terminal; `secret` keeps his answer unseen. */
  ask: (question: string, options?: { secret?: boolean }) => Effect.Effect<string>;
  /** Opens a page in his browser. */
  open: (url: string) => Effect.Effect<void>;
  log: (line: string) => void;
  /** Asks for the client's id and secret even when the Keychain holds them. */
  newClient?: boolean;
  /** Polar's endpoints and the listener's port, made-up ones in the tests. */
  authorizeUrl?: string;
  tokenUrl?: string;
  apiUrl?: string;
  port?: number;
  waitMs?: number;
}

/** What the browser brought back: the code, or Polar's error. */
type Answer = { code: string } | { error: string };

/** Connects Polar (see the top of this file); fails with why it could not. */
export const polarLogin = (options: LoginOptions): Effect.Effect<{ memberId: string; registered: "registered" | "already registered" }, PolarLoginFailed> =>
  Effect.gen(function* () {
    const { secrets, log } = options;
    const port = options.port ?? LOGIN_PORT;
    const redirect = `http://localhost:${port}${REDIRECT_PATH}`;
    const failed = (message: string) => new PolarLoginFailed({ message });
    const keychain = <A>(effect: Effect.Effect<A, { message: string }>) => effect.pipe(Effect.mapError((error) => failed(error.message)));

    let client = options.newClient ? null : yield* keychain(secrets.client);
    if (client) log("Using the API client the Keychain holds (--new-client to give another).");
    else {
      log(`Your API client, from https://admin.polaraccesslink.com (its redirect URL must be ${redirect}):`);
      const id = (yield* options.ask("Client ID: ")).trim();
      const secret = (yield* options.ask("Client secret (not shown): ", { secret: true })).trim();
      if (!id || !secret) return yield* failed("a client ID and secret are both needed");
      client = { id, secret };
      yield* keychain(secrets.setClient(client));
      log("Kept the client in the Keychain.");
    }

    const state = randomBytes(16).toString("hex");
    const answer = yield* Deferred.make<Answer>();
    yield* listen(port, state, answer);
    const authorize = new URL(options.authorizeUrl ?? AUTHORIZE_URL);
    authorize.search = new URLSearchParams({ response_type: "code", client_id: client.id, redirect_uri: redirect, scope: "accesslink.read_all", state }).toString();
    log(`Opening Polar in your browser: sign in and accept. If it does not open, go to:\n  ${authorize.toString()}`);
    yield* options.open(authorize.toString());
    const came = yield* Deferred.await(answer).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.waitMs ?? LOGIN_WAIT_MS),
        orElse: () => Effect.fail(failed(`Polar did not send the browser back within ${Math.round((options.waitMs ?? LOGIN_WAIT_MS) / 60_000)} minutes`)),
      }),
    );
    if ("error" in came) return yield* failed(`Polar did not grant access (${came.error})`);

    const token = yield* exchange(options.tokenUrl ?? TOKEN_URL, client, came.code, redirect);
    const settings = yield* Effect.tryPromise({ try: () => readSettings(options.settingsFile), catch: (error) => failed((error as Error).message) });
    const memberId = typeof settings.memberId === "string" && settings.memberId ? settings.memberId : `life-archive-${randomUUID().slice(0, 8)}`;
    const registered = yield* accessLink(options.apiUrl ?? ACCESSLINK, token.accessToken).register(memberId).pipe(
      Effect.mapError((error) => failed(`Polar did not register you with the client: ${error.message}`)),
    );
    yield* keychain(secrets.setToken(token));
    yield* Effect.tryPromise({ try: () => updateSettings(options.settingsFile, { enabled: true, memberId }), catch: (error) => failed((error as Error).message) });
    log(`Connected: ${registered === "registered" ? "registered with your client" : "already registered with your client"}, the token kept in the Keychain, and the polar connector switched on.`);
    if (settings.trustedHeartRate === undefined) {
      log(`Its heart rate is trusted only once you say so: add "trustedHeartRate": [{"device": "Polar Flow app", "sensor": "Polar H10"}] to ${options.settingsFile} (docs/events.md's "Workouts from Polar").`);
    }
    return { memberId, registered };
  }).pipe(Effect.scoped);

/** The one-shot listener for the browser's way back, on this Mac alone, closed with the login's scope. */
const listen = (port: number, state: string, answer: Deferred.Deferred<Answer>) =>
  Effect.forEach(["127.0.0.1", "::1"], (host) =>
    Effect.acquireRelease(
      Effect.callback<Server | null, PolarLoginFailed>((resume) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://localhost:${port}`);
          if (req.method !== "GET" || url.pathname !== REDIRECT_PATH) {
            res.writeHead(404).end();
            return;
          }
          // Only the answer to this login: another state is some other page's request.
          if (url.searchParams.get("state") !== state) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("This is not the answer to the login waiting here.");
            return;
          }
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
            `<!doctype html><meta charset="utf-8"><title>Polar</title><p>${code ? "Polar is connected to the life archive. You can close this tab." : "Polar did not grant access. You can close this tab."}</p>`,
          );
          Deferred.doneUnsafe(answer, Effect.succeed(code ? { code } : { error: error ?? "no code" }));
        });
        server.once("error", (error: NodeJS.ErrnoException) => {
          // A Mac with no IPv6 loopback still has 127.0.0.1; a port taken is the login's failure.
          if (host === "::1" && error.code === "EADDRNOTAVAIL") resume(Effect.succeed(null));
          else resume(Effect.fail(new PolarLoginFailed({ message: `the login could not listen on ${host}:${port} (${error.code ?? error.message}); is another login running?` })));
        });
        server.listen(port, host, () => resume(Effect.succeed(server)));
      }),
      (server) => (server ? Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)).closeAllConnections()) : Effect.void),
    ),
  );

/** Exchanges the code for the access token and the captain's Polar user id. */
const exchange = (tokenUrl: string, client: { id: string; secret: string }, code: string, redirect: string) =>
  Effect.gen(function* () {
    const failed = (message: string) => new PolarLoginFailed({ message });
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(tokenUrl, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json;charset=UTF-8",
          },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }).toString(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        }),
      catch: (error) => failed(`could not reach Polar for the token: ${(error as Error).message}`),
    });
    if (!res.ok) {
      return yield* failed(
        res.status === 401 || res.status === 400
          ? `Polar refused the token exchange (${res.status}): check the client ID and secret (npm run exercise -- polar login --new-client) and that its redirect URL is ${redirect}`
          : `Polar answered ${res.status} for the token`,
      );
    }
    const body = yield* Effect.tryPromise({ try: () => res.json() as Promise<Record<string, unknown>>, catch: () => failed("Polar's token answer could not be read") });
    const accessToken = body.access_token;
    const userId = body.x_user_id;
    if (typeof accessToken !== "string" || !accessToken || (typeof userId !== "number" && typeof userId !== "string")) {
      return yield* failed("Polar's token answer has no access token or user id");
    }
    return { accessToken, userId: String(userId) };
  });
