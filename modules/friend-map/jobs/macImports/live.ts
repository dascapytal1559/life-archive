// This Mac's calls and Messages, every 15 minutes: the launcher Full Disk Access is given to (server/launcher.c), and the launchd
// agent that runs it.

import { homedir } from "node:os";
import { buildLauncher as build, jobPath, launchdPlist } from "../../../../sdk/server.ts";
import { join } from "node:path";
import { LAUNCHD_LABEL } from "./round.ts";

/** Where install puts the launcher: outside any checkout, so a new worktree or a pull leaves it, and its grant, alone. */
export const LAUNCHER = join(homedir(), "Library", "Application Support", "LifeArchive", "life-archive-mac-imports");
/**
 * Every 15 minutes, and at load. launchd starts the job only when it is not still running, and a run that finds
 * nothing new reads two numbers and exits; a run's own lock keeps one started by hand from overlapping it.
 */
export const EVERY = { everySeconds: 15 * 60 } as const;

/** The command the launcher runs, from the repository's root: the module's own (the launcher built before ran server/mac-imports.ts, which hands on to it). */
export const SCRIPT = "/modules/friend-map/jobs/mac-imports.ts";

/**
 * Builds the launcher for `node` and `repo` at `out`, signed ad hoc: "built" when it is new or changed, "unchanged"
 * when what is there is already that program byte for byte (and keeps its Full Disk Access). It runs SCRIPT.
 */
export function buildLauncher({ node, repo, out = LAUNCHER }: { node: string; repo: string; out?: string }): Promise<"built" | "unchanged"> {
  return build({ node, repo, out, identifier: LAUNCHD_LABEL, script: SCRIPT });
}

export function plist({ node, launcher = LAUNCHER, repo, logFile }: { node: string; launcher?: string; repo: string; logFile: string }): string {
  return launchdPlist({
    label: LAUNCHD_LABEL,
    comment: `This Mac's calls and Messages into the life archive (${repo}, npm run mac-imports; docs/data.md's "This Mac's calls and Messages, every 15 minutes"), every 15 minutes. ` +
      "Its program is the launcher Full Disk Access is given to. Written by npm run mac-imports -- install.",
    program: [launcher],
    repo,
    path: jobPath(node),
    schedule: EVERY,
    logFile,
  });
}
