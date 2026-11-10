// What the archive's scheduled jobs share (friend map's, modules/friend-map/jobs/, and the journal's,
// modules/journal/jobs/, through the SDK; a module's jobs live in its jobs/<job>/, docs/modules.md says): the archive's
// own commands as a service and its live Layer, the launchd agent each runs as, the launcher Full Disk Access is given
// to, the lock that keeps a job to one run at a time, and the log's times. How a job tells someone is the notifier's
// (notifier/notifier.ts).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import { isAlive } from "./alive.ts";
import { run, type RunFailed } from "./childProcess.ts";

/** The archive's own commands, run as the runbook runs them. */
export class ArchiveCommands extends Context.Service<ArchiveCommands, {
  /** How far each connector's imports reach, from import-status. */
  readonly coversTo: Effect.Effect<Record<string, number | null>, RunFailed>;
  /** `npm run archive -- <args>`: what it printed. */
  readonly archive: (args: string[]) => Effect.Effect<string, RunFailed>;
  /** `npm run check-data`: whether it found nothing wrong, and how many problems it named. */
  readonly checkData: Effect.Effect<{ ok: boolean; problems: number }, RunFailed>;
}>()("life-archive/ArchiveCommands") {}

const CLI = fileURLToPath(new URL("./archive/cli.ts", import.meta.url));
const CHECK_DATA = fileURLToPath(new URL("./check-data.ts", import.meta.url));

/** The archive's commands on `dataDir`, run with this Node as `npm run archive` and `npm run check-data` run them. */
export const archiveCommandsLayer = (dataDir: string) => {
  const archive = (args: string[]) => run(process.execPath, ["--no-warnings", CLI, ...args, "--data", dataDir]).pipe(Effect.map(({ stdout }) => stdout));
  return Layer.succeed(ArchiveCommands, {
    archive,
    coversTo: archive(["import-status", "--json"]).pipe(
      Effect.map((text) => {
        const report = JSON.parse(text) as { used: Array<{ connector: string; coversTo: number | null }>; unused: Array<{ connector: string; coversTo: number | null }> };
        return Object.fromEntries([...report.used, ...report.unused].map((row) => [row.connector, row.coversTo]));
      }),
    ),
    checkData: run(process.execPath, ["--no-warnings", CHECK_DATA, dataDir]).pipe(
      Effect.as({ ok: true, problems: 0 }),
      // 1 is "something to fix"; anything else is check-data failing.
      Effect.catchIf((failed) => failed.code === 1, (failed) => Effect.succeed({ ok: false, problems: Number(failed.message.match(/(\d+) to fix/)?.[1] ?? 1) })),
    ),
  });
};

/**
 * Stops a job's install off macOS: its launchd agent is macOS's. Each job is also a command of its own (its `run`), which
 * cron or a systemd timer can run instead (SETUP.md's "Scheduled jobs").
 */
export function requireLaunchd(label: string): void {
  if (process.platform === "darwin") return;
  throw new Error(`${label} is a launchd agent, which only macOS has: here, run the job's own command from cron or a systemd timer instead (SETUP.md's "Scheduled jobs")`);
}

/** An instant as this Mac's local time with its offset, e.g. 2026-10-16T03:00:04+11:00. */
export function localTime(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const wall = new Date(at.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${wall}${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** Where the jobs log, each to a file of its own. */
export const LOG_FOLDER = join(homedir(), "Library", "Logs", "LifeArchive");

/**
 * When launchd runs a job: every so many seconds (from when it is loaded), at a time each day, or each week on a day
 * (`weekday`, Sunday 0), or always (started again when it stops). A calendar time missed while the Mac slept runs on
 * wake.
 */
export type JobSchedule =
  | { everySeconds: number }
  | { weekday?: number; hour: number; minute: number }
  | { keepAlive: true };

export interface LaunchAgent {
  label: string;
  /** The plist's comment: what it is, and where it is written from. */
  comment: string;
  program: string[];
  repo: string;
  path: string;
  schedule: JobSchedule;
  logFile: string;
  /** Paths whose change also starts it, besides its schedule: at most once a minute. */
  watchPaths?: string[];
}

/** A launchd agent's plist. */
export function launchdPlist(agent: LaunchAgent): string {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const strings = (items: string[]) => items.map((item) => `<string>${escape(item)}</string>`).join("");
  const { schedule } = agent;
  const when = "keepAlive" in schedule
    ? `<key>KeepAlive</key><true/>\n<key>RunAtLoad</key><true/>`
    : "everySeconds" in schedule
    ? `<key>StartInterval</key><integer>${schedule.everySeconds}</integer>\n<key>RunAtLoad</key><true/>`
    : `<key>StartCalendarInterval</key><dict>${schedule.weekday === undefined ? "" : `<key>Weekday</key><integer>${schedule.weekday}</integer>`}` +
      `<key>Hour</key><integer>${schedule.hour}</integer><key>Minute</key><integer>${schedule.minute}</integer></dict>\n<key>RunAtLoad</key><false/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${escape(agent.comment)} Run now: launchctl kickstart gui/$(id -u)/${agent.label} -->
<plist version="1.0"><dict>
<key>Label</key><string>${agent.label}</string>
<key>ProgramArguments</key><array>${strings(agent.program)}</array>
<key>WorkingDirectory</key><string>${escape(agent.repo)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(agent.path)}</string></dict>
${when}${agent.watchPaths?.length ? `\n<key>WatchPaths</key><array>${strings(agent.watchPaths)}</array><key>ThrottleInterval</key><integer>60</integer>` : ""}
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${escape(agent.logFile)}</string><key>StandardErrorPath</key><string>${escape(agent.logFile)}</string>
</dict></plist>
`;
}

/** Writes a launchd agent's plist into ~/Library/LaunchAgents/ and loads it, in place of any it had: the plist's path. */
export async function installLaunchAgent(label: string, text: string): Promise<string> {
  requireLaunchd(label);
  const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  await mkdir(LOG_FOLDER, { recursive: true });
  await writeFile(file, text);
  const domain = `gui/${process.getuid?.()}`;
  // Unloaded first, so a second install takes the new plist; not loaded is fine.
  await promisify(execFile)("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
  await promisify(execFile)("/bin/launchctl", ["bootstrap", domain, file]);
  return file;
}

/** Removes a launchd agent: unloaded (not loaded is fine) and its plist deleted. Whether there was a plist. */
export async function removeLaunchAgent(label: string): Promise<boolean> {
  requireLaunchd(label);
  const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  await promisify(execFile)("/bin/launchctl", ["bootout", `gui/${process.getuid?.()}/${label}`]).catch(() => {});
  const had = existsSync(file);
  await rm(file, { force: true });
  return had;
}

const LAUNCHER_SOURCE = fileURLToPath(new URL("./launcher.c", import.meta.url));

export interface LauncherBuild {
  /** The Node the launcher starts, and the checkout it runs in. */
  node: string;
  repo: string;
  /** Where the launcher goes: outside any checkout, so a new worktree or a pull leaves it, and its grant, alone. */
  out: string;
  /** Its code signature's identifier: the job's launchd label. */
  identifier: string;
  /** The script it runs, from the checkout (`/server/....ts`), and the variable it sets to its own path; launcher.c's defaults (mac-imports') when absent. */
  script?: string;
  env?: string;
}

/**
 * Builds the launcher Full Disk Access is given to (launcher.c) at `out`, signed ad hoc: "built" when it is new or
 * changed, "unchanged" when what is there is already that program byte for byte (and keeps its grant).
 */
export async function buildLauncher({ node, repo, out, identifier, script, env }: LauncherBuild): Promise<"built" | "unchanged"> {
  await mkdir(dirname(out), { recursive: true });
  const work = await mkdtemp(join(dirname(out), ".building-"));
  try {
    // Built under the name it will have: the same source and paths then make the same bytes.
    const built = join(work, out.split("/").at(-1)!);
    const run = promisify(execFile);
    const defines = [`-DLA_NODE=${JSON.stringify(node)}`, `-DLA_REPO=${JSON.stringify(repo)}`];
    if (script) defines.push(`-DLA_SCRIPT=${JSON.stringify(script)}`);
    if (env) defines.push(`-DLA_ENV=${JSON.stringify(env)}`);
    await run("/usr/bin/clang", ["-O2", "-Wall", "-o", built, LAUNCHER_SOURCE, ...defines]);
    await run("/usr/bin/codesign", ["--sign", "-", "--force", "--identifier", identifier, built]);
    if (existsSync(out) && (await readFile(out)).equals(await readFile(built))) return "unchanged";
    await chmod(built, 0o755);
    await rename(built, out);
    return "built";
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * One run of a job at a time: `<folder>/lock`, a file holding the run's pid, held for the scope and taken again when
 * that process is gone. Null when another run holds it.
 */
export const takeLock = (folder: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      await mkdir(folder, { recursive: true });
      const file = join(folder, "lock");
      for (let tries = 0; tries < 2; tries++) {
        try {
          const handle = await open(file, "wx");
          await handle.writeFile(String(process.pid));
          await handle.close();
          return file;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
          if (pid > 0 && pid !== process.pid && isAlive(pid)) return null;
          await rm(file, { force: true });
        }
      }
      return null;
    }),
    (file) => (file ? Effect.promise(() => unlink(file).catch(() => {})) : Effect.void),
  );
