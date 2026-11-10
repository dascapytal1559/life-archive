// Polar's secrets, in this Mac's login Keychain and nowhere else: never in a file, a log or a commit. Two generic
// passwords of the service KEYCHAIN_SERVICE:
//   client  the API client the captain registered at admin.polaraccesslink.com: "<client id>:<client secret>"
//   token   the access token his login gave, and his Polar user id: "<user id>:<access token>"
// Each is read with `security find-generic-password -w` and stored through `security -i` on its standard input, so
// it is never a process's argument. A keychain file can be named instead of the login keychain (the tests' own).

import { Data, Effect } from "effect";
import { run } from "../../../../sdk/server.ts";

export const KEYCHAIN_SERVICE = "life-archive-polar";

/** The API client the captain registered. */
export interface PolarClient {
  id: string;
  secret: string;
}

/** The access token of the captain's login, and his Polar user id. */
export interface PolarToken {
  userId: string;
  accessToken: string;
}

/** The Keychain could not be read or written; never says a secret. */
export class PolarSecretsError extends Data.TaggedError("PolarSecretsError")<{ readonly message: string }> {}

/** Where Polar's secrets are kept. */
export interface PolarSecrets {
  client: Effect.Effect<PolarClient | null, PolarSecretsError>;
  setClient(client: PolarClient): Effect.Effect<void, PolarSecretsError>;
  token: Effect.Effect<PolarToken | null, PolarSecretsError>;
  setToken(token: PolarToken): Effect.Effect<void, PolarSecretsError>;
}

/** What a secret's part may hold, so it is safe on `security -i`'s line: no space, quote or colon. */
const SAFE = /^[A-Za-z0-9._~+/=-]+$/;

/** The secrets in the login keychain, or in the keychain file `keychainFile`. */
export function keychainSecrets(keychainFile?: string): PolarSecrets {
  const keychain = keychainFile ? [keychainFile] : [];
  const read = (account: string): Effect.Effect<[string, string] | null, PolarSecretsError> =>
    run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", ...keychain]).pipe(
      Effect.map(({ stdout }) => {
        const value = stdout.trim();
        const colon = value.indexOf(":");
        return colon > 0 ? ([value.slice(0, colon), value.slice(colon + 1)] as [string, string]) : null;
      }),
      // 44 is security's "not found".
      Effect.catchIf((error) => error.code === 44, () => Effect.succeed(null)),
      Effect.mapError(() => new PolarSecretsError({ message: `the Keychain could not be read (service ${KEYCHAIN_SERVICE}, ${account})` })),
    );
  const write = (account: string, first: string, second: string): Effect.Effect<void, PolarSecretsError> =>
    Effect.gen(function* () {
      if (!SAFE.test(first) || !SAFE.test(second)) {
        return yield* new PolarSecretsError({ message: `Polar's ${account} holds a character this archive does not keep (only letters, digits and . _ ~ + / = -)` });
      }
      // -U updates the item when there is one (a login again).
      yield* run("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${first}:${second} ${keychain.join(" ")}\n` }).pipe(
        // security's own words could quote the line it was given, so they are never passed on.
        Effect.mapError(() => new PolarSecretsError({ message: `the Keychain did not take Polar's ${account} (service ${KEYCHAIN_SERVICE})` })),
      );
      const kept = yield* read(account);
      if (!kept || kept[0] !== first || kept[1] !== second) return yield* new PolarSecretsError({ message: `the Keychain did not keep Polar's ${account}` });
    });
  return {
    client: read("client").pipe(Effect.map((found) => found && { id: found[0], secret: found[1] })),
    setClient: (client) => write("client", client.id, client.secret),
    token: read("token").pipe(Effect.map((found) => found && { userId: found[0], accessToken: found[1] })),
    setToken: (token) => write("token", token.userId, token.accessToken),
  };
}

/** Secrets held in memory, for the tests. */
export function memorySecrets(start: { client?: PolarClient; token?: PolarToken } = {}): PolarSecrets & { held: { client?: PolarClient; token?: PolarToken } } {
  const held = { ...start };
  return {
    held,
    client: Effect.sync(() => held.client ?? null),
    setClient: (client) => Effect.sync(() => void (held.client = client)),
    token: Effect.sync(() => held.token ?? null),
    setToken: (token) => Effect.sync(() => void (held.token = token)),
  };
}
