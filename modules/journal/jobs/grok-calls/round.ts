// One pass of the Grok calls job (the journal module's; README.md's "Grok calls"), run by the launchd agent
// local.life-archive-voice-calls when Grok Bot's cache changes and every 30 minutes (`npm run journal -- grok-calls`):
// every finished call still in the cache (cache.ts) that is not yet in the journal is written into the vault's
// Journals/raw/<journal day>/ as its three files (format.ts).
//
// The files are the job's ledger: each is written once and never replaced (the SDK's writeOnce, synced to disk, made
// 0600 in folders made 0700), so a pass run twice, or two at once, or one stopped part way and run again, only fills in
// what is missing, and a pass needs no lock or state of its own. A saved transcript whose cache entry has changed since
// is kept and flagged `differs`. A pass never writes into the cache, and never makes a journal home that is not there:
// with no Journals/raw/ it refuses. What it returns, and the job logs, is counts and ids, never words.

import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Effect } from "effect";
import { writeOnce } from "../../../../sdk/server.ts";
import { files, type GrokCallsRefused, readCache, refused } from "./cache.ts";
import { isoformat, renderCall } from "./format.ts";

export interface RunOptions {
  /** Grok Bot's cache folder (live.ts's CACHE), or a scratch one. */
  readonly cacheDir: string;
  /** The journals' folder: the vault's Journals/. */
  readonly journalsDir: string;
  /** The provider slug its files name: grok-bot. */
  readonly provider: string;
}

export interface Saved {
  readonly source_id: string;
  readonly date: string;
  readonly bot: string | null;
  readonly agent_id: string;
  readonly written: ReadonlyArray<string>;
  readonly differs?: true;
}

export interface RunResult {
  readonly ok: true;
  readonly cached_calls: number;
  readonly unchanged: number;
  readonly saved: ReadonlyArray<Saved>;
}

const exists = (path: string) => files(() => stat(path).then(() => true, () => false));

/** Writes every cached call that is not yet saved: counts and ids only, never words. */
export const grokCallsRun = (options: RunOptions): Effect.Effect<RunResult, GrokCallsRefused> =>
  Effect.gen(function* () {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(options.provider)) return yield* Effect.fail(refused("Provider must be a lowercase slug such as example-bot"));
    if (!(yield* exists(join(options.journalsDir, "raw")))) {
      return yield* Effect.fail(refused(`No raw folder under ${options.journalsDir}; refusing to create a new journal home`));
    }
    const calls = yield* readCache(options.cacheDir);
    const extractedAt = isoformat(yield* Clock.currentTimeMillis);
    const saved: Array<Saved> = [];
    let unchanged = 0;
    for (const call of calls) {
      const made = yield* renderCall(call, options.provider);
      const folder = join(options.journalsDir, "raw", made.date);
      yield* files(() => mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? undefined : Promise.reject(error))));
      const outputs: Array<[string, string]> = [
        [`${made.sourceId}.transcript.json`, made.transcriptJson],
        [`${made.sourceId}.transcript.md`, made.transcriptMd],
        [`${made.sourceId}.source.json`, made.sidecar(extractedAt)],
      ];
      const written: Array<string> = [];
      for (const [name, content] of outputs) {
        if (yield* files(() => writeOnce(join(folder, name), content, { mode: 0o600 }))) written.push(name);
      }
      const transcript = `${made.sourceId}.transcript.json`;
      const differs = !written.includes(transcript) && (yield* files(() => readFile(join(folder, transcript), "utf8"))) !== made.transcriptJson;
      if (written.length === 0 && !differs) {
        unchanged += 1;
        continue;
      }
      saved.push({ source_id: made.sourceId, date: made.date, bot: call.botName, agent_id: call.agentId, written, ...(differs ? { differs: true as const } : {}) });
    }
    return { ok: true, cached_calls: calls.length, unchanged, saved };
  });
