// Grok Bot's cache, as the Grok calls job reads it (round.ts): the app keeps each bot's recent chat as JSON blobs whose
// file names are base32 keys ending in `.transcript.replicas.<agentId>`; a finished call is an entry with
// `kind: "voice-call"` holding the call record and every timed turn, and the bots' names are in the cached roster
// (`.roster.last-roster`). The cache is a rolling window, so calls age out within days. This only reads it.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";

/** Why a pass stopped, in words for its log line: a bad option, a journal home that is not there, an unsafe call id, a file it could not read or write. */
export class GrokCallsRefused extends Data.TaggedError("GrokCallsRefused")<{ readonly message: string }> {}

export const refused = (message: string): GrokCallsRefused => new GrokCallsRefused({ message });

export interface Turn {
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
  readonly atMs: number;
}

export interface CachedCall {
  readonly agentId: string;
  readonly botName: string | null;
  readonly cacheSchemaVersion: unknown;
  /** The cache entry exactly as the app stored it. */
  readonly entry: Record<string, unknown>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 without padding, as the cache spells its file names (lowercase). */
export const decodeBase32 = (text: string): string | null => {
  let bits = 0;
  let value = 0;
  const bytes: Array<number> = [];
  for (const char of text.toLowerCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
};

/** A file system call, its failure the job's (a folder it may not read, say), in the system's words. */
export const files = <A>(work: () => Promise<A>): Effect.Effect<A, GrokCallsRefused> =>
  Effect.tryPromise({ try: work, catch: (error) => refused((error as Error).message) });

/** Every finished voice call still in the cache folder, with its bot's name from the cached roster. */
export const readCache = (cacheDir: string): Effect.Effect<Array<CachedCall>, GrokCallsRefused> =>
  Effect.gen(function* () {
    const parse = (name: string) =>
      files(() => readFile(join(cacheDir, name), "utf8")).pipe(
        Effect.flatMap((text) => Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => refused(`Unreadable cache file ${name}`) })),
      );
    const keyed = (yield* files(() => readdir(cacheDir)))
      .filter((name) => name.endsWith(".blob"))
      .map((name) => ({ name, key: decodeBase32(name.slice(0, -".blob".length)) ?? "" }));
    const names = new Map<string, string>();
    for (const { name } of keyed.filter(({ key }) => key.endsWith(".roster.last-roster"))) {
      const roster = yield* parse(name);
      const rows = isRecord(roster) && isRecord(roster.value) ? roster.value.rows : undefined;
      for (const row of Array.isArray(rows) ? rows : []) {
        if (isRecord(row) && typeof row.id === "string" && typeof row.name === "string") names.set(row.id, row.name);
      }
    }
    const calls: Array<CachedCall> = [];
    for (const { name, key } of keyed) {
      const match = /\.transcript\.replicas\.([^.]+)$/.exec(key);
      if (match === null) continue;
      const agentId = match[1] as string;
      const blob = yield* parse(name);
      const entries = isRecord(blob) && isRecord(blob.value) ? blob.value.entries : undefined;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!isRecord(entry) || entry.kind !== "voice-call" || !isRecord(entry.call)) continue;
        // Only a call that has ended carries its whole transcript.
        if (typeof entry.call.endedAtMs !== "number" || typeof entry.call.callId !== "string") continue;
        calls.push({ agentId, botName: names.get(agentId) ?? null, cacheSchemaVersion: isRecord(blob) ? blob.schemaVersion : null, entry });
      }
    }
    return calls;
  });
