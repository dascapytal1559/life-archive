// The Grok calls job as launchd runs it: `npm run journal -- grok-calls` (command.ts, round.ts) copying each finished
// call still in Grok Bot's cache into the vault's journals, when the cache changes (at most once a minute) and every 30
// minutes.
//
// It was rituals' until 8 November 2026 (`npm run rituals -- voice-calls install`, running rituals' bin/ritual-voice-calls),
// and before 7 November ran from ~/Projects/rituals as local.ritual-voice-calls. It keeps the label it had, so an agent
// installed by rituals goes on as this one: its program, rituals' bin/ritual-voice-calls, now hands the run to this
// job (modules/rituals/README.md's "Voice calls"), and `npm run journal -- grok-calls install` writes the agent anew
// with this job's own program.

import { homedir } from "node:os";
import { join } from "node:path";
import { jobPath, launchdPlist } from "../../../../sdk/server.ts";

export const LAUNCHD_LABEL = "local.life-archive-voice-calls";
/** The job it replaced, in rituals' old home: install refuses while that one is still loaded. */
export const OLD_LABEL = "local.ritual-voice-calls";
/** The provider slug its files name. */
export const PROVIDER = "grok-bot";
/** Grok Bot's cache, as the archive's grok-bot connector reads it (its manifest's defaultSource). */
export const CACHE = join(homedir(), "Library", "Application Support", "Grok Bot", "sand-client-persistence");
export const EVERY_SECONDS = 30 * 60;
/** Its log, the one it kept as rituals'. */
export const LOG_NAME = "voice-calls.log";

export interface GrokCallsJob {
  node: string;
  repo: string;
  cache: string;
  journals: string;
  logFile: string;
}

/** The command the job runs: the journal module's, on the archive's Node. */
export function program({ node, repo, cache, journals }: Pick<GrokCallsJob, "node" | "repo" | "cache" | "journals">): string[] {
  return [node, "--no-warnings", join(repo, "modules", "journal", "cli.ts"), "grok-calls", "--cache", cache, "--journals", journals, "--provider", PROVIDER];
}

export function plist(job: GrokCallsJob): string {
  return launchdPlist({
    label: LAUNCHD_LABEL,
    comment: `The journal's Grok calls (${job.repo}, npm run journal -- grok-calls, the journal module's; its README's "Grok calls"): each finished call in ` +
      "Grok Bot's cache copied into the vault's Journals/raw/, when the cache changes and every 30 minutes. Written by npm run journal -- grok-calls install.",
    program: program(job),
    repo: job.repo,
    path: jobPath(job.node),
    schedule: { everySeconds: EVERY_SECONDS },
    watchPaths: [job.cache],
    logFile: job.logFile,
  });
}
