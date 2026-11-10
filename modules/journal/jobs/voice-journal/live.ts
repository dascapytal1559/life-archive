// The voice journals' transcription as launchd runs it: the launcher Full Disk Access is given to (the core's
// server/launcher.c, built through the SDK to run the module's command, cli.ts), and the launchd agent that runs it
// each day at 06:00.

import { homedir } from "node:os";
import { join } from "node:path";
import { buildLauncher as build, jobPath, launchdPlist } from "../../../../sdk/server.ts";
import { LAUNCHD_LABEL, LAUNCHER_ENV } from "./round.ts";

/** Where install puts the launcher: outside any checkout, so a new worktree or a pull leaves it, and its grant, alone. */
export const LAUNCHER = join(homedir(), "Library", "Application Support", "LifeArchive", "life-archive-voice-journal");
/**
 * The command the launcher runs, from the checkout: the module's, which hands a run with no job named to this job's
 * command.ts. It is built into the launcher, whose Full Disk Access is given to those bytes: a new path builds a new
 * launcher, which needs the grant given again, so cli.ts stays where it is.
 */
export const SCRIPT = "/modules/journal/cli.ts";
/**
 * One pass a day, at 06:00, so a recording deleted in Voice Memos before then is never taken into the journal. Missed
 * while the Mac slept, it runs on wake.
 */
export const AT = { hour: 6, minute: 0 };

/** Builds the launcher for `node` and `repo` at `out`: "built" when new or changed (its grant given again), else "unchanged". */
export function buildLauncher({ node, repo, out = LAUNCHER }: { node: string; repo: string; out?: string }): Promise<"built" | "unchanged"> {
  return build({ node, repo, out, identifier: LAUNCHD_LABEL, script: SCRIPT, env: LAUNCHER_ENV });
}

export function plist({ node, launcher = LAUNCHER, repo, logFile }: { node: string; launcher?: string; repo: string; logFile: string }): string {
  return launchdPlist({
    label: LAUNCHD_LABEL,
    comment: `The voice journals transcribed from Voice Memos (${repo}, npm run journal, the journal module's; docs/features.md's "Voice journals, transcribed at 6 AM"), ` +
      "each day at 06:00. Its program is the launcher Full Disk Access is given to. Written by npm run journal -- install.",
    program: [launcher],
    repo,
    path: jobPath(node),
    schedule: AT,
    logFile,
  });
}
