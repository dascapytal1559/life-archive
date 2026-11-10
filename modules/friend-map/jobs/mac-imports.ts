// This Mac's calls and Messages into the archive, every 15 minutes (server/macImports/; docs/data.md's "This Mac's calls and
// Messages, every 15 minutes"):
//
//   npm run mac-imports                  a run: when either database has something new, it is copied into the
//                                        archive's folder, backed up before, imported and check-data run; else nothing
//   npm run mac-imports -- --dry-run     says what a run would do, and does nothing
//   npm run mac-imports -- install       builds the launcher Full Disk Access is given to, writes the launchd agent
//                                        (every 15 minutes) and loads it, and says what to grant; --dry-run prints it
//
// Each run logs a line with its time; a run that fails (Full Disk Access not given, say) logs an ERROR line, exits 1,
// and raises a macOS notification, the day's first only.

import { DATA_OPTION } from "../../../sdk/command.ts";
import { archivePath } from "../server/storage.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Layer } from "effect";
import { archiveCommandsLayer, archiveFolder, dayKey, Notifier, notifierLayer, installLaunchAgent, jobNode, localTime, LOG_FOLDER, notify, REPO, runMain } from "../../../sdk/server.ts";
import { buildLauncher, LAUNCHER, plist } from "./macImports/live.ts";
import { firstAlertToday, grantSteps, LAUNCHD_LABEL, LAUNCHER_ENV, macImportsRun, NOTE_HEAD } from "./macImports/round.ts";

const LOG_FILE = join(LOG_FOLDER, "mac-imports.log");
const TITLE = "Life archive: this Mac's calls and Messages";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...DATA_OPTION, "dry-run": { type: "boolean" } } });
const command = positionals[0] ?? "run";
const dryRun = values["dry-run"] ?? false;

function log(line: string): void {
  console.log(`${localTime(new Date())} ${line}`);
}

const runOnce = Effect.gen(function* () {
  const dataDir = archiveFolder();
  const launcher = process.env[LAUNCHER_ENV];
  const now = Date.now();
  const result = yield* macImportsRun({ dataDir, home: homedir(), now, dryRun, log, ...(launcher ? { launcher } : {}) }).pipe(
    // Anything else that stops a run (a database not where this Mac keeps it, import-status or check-data failing) is said once that day.
    Effect.tapError((error) =>
      dryRun ? Effect.void : Effect.gen(function* () {
        yield* (yield* Notifier).note(`mac-imports-stopped-${dayKey(now)}`, `${NOTE_HEAD} the sync of this Mac's calls and Messages stopped part way ` +
          `(${error._tag}); the log (~/Library/Logs/LifeArchive/mac-imports.log) has why.`);
      }).pipe(Effect.ignore),
    ),
    Effect.provide(Layer.mergeAll(archiveCommandsLayer(dataDir), notifierLayer(log, TITLE))),
  );
  if (result.noAccess.length > 0) return yield* Effect.fail(new Error(`no Full Disk Access to read ${result.noAccess.join(" and ")}${launcher ? `: grant it to ${launcher}` : ""}`));
  if (!result.ok) return yield* Effect.fail(new Error(`${result.sources.filter((s) => !s.ok).map((s) => `${s.source}: ${s.detail}`).join("; ")} failed`));
  if (!result.skipped) log(`${dryRun ? "dry run: " : ""}${result.sources.map((s) => `${s.source}: ${s.detail}`).join("; ")}`);
});

async function install(): Promise<void> {
  // The launcher runs this checkout on its archive: a checkout with none (a worktree, say) would import into nothing.
  const dataDir = archiveFolder();
  if (!existsSync(archivePath(dataDir))) throw new Error(`there is no friend map archive at ${archivePath(dataDir)}: install from the checkout whose archive takes the imports`);
  const node = jobNode();
  const repo = REPO.replace(/\/$/, "");
  const text = plist({ node, repo, logFile: LOG_FILE });
  if (dryRun) {
    console.log(`Would build ${LAUNCHER} (running ${node} on ${repo}/server/mac-imports.ts) and write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist:\n${text}`);
    return;
  }
  const built = await buildLauncher({ node, repo });
  const file = await installLaunchAgent(LAUNCHD_LABEL, text);
  console.log(`Wrote ${file} and loaded it: ${repo} syncs this Mac's calls and Messages into its archive every 15 minutes, logging to ${LOG_FILE}.`);
  console.log(built === "built"
    ? `Built ${LAUNCHER}. It is a new program to macOS, so it needs Full Disk Access given (again, if it had it):\n  ${grantSteps(LAUNCHER)}`
    : `${LAUNCHER} is unchanged, so it keeps the Full Disk Access it was given; if it has none yet:\n  ${grantSteps(LAUNCHER)}`);
}

const program = Effect.gen(function* () {
  if (command === "run") yield* runOnce;
  else if (command === "install") yield* Effect.tryPromise({ try: install, catch: (error) => error as Error });
  else return yield* Effect.fail(new Error(`unknown command ${command}: run or install`));
}).pipe(
  Effect.catch((error: { message: string }) =>
    Effect.promise(async () => {
      log(`ERROR ${error.message}`);
      // A run every 15 minutes: the day's first failure is shown, and firstmate's note says the rest.
      if (command === "run" && !dryRun && (await firstAlertToday(archiveFolder(), Date.now()).catch(() => true))) notify(TITLE, error.message);
      process.exitCode = 1;
    }),
  ),
);

// A signal (launchd stopping it, say) stops the import it waits on.
await runMain(program);
