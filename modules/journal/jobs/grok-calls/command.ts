// The Grok calls job's command (the journal module's cli.ts hands it `npm run journal -- grok-calls ...`; README.md's
// "Grok calls"):
//
//   npm run journal -- grok-calls                 a pass: each finished call in Grok Bot's cache not yet in the vault's
//                                                 Journals/raw/ is written there (round.ts); one JSON line of counts and ids
//   npm run journal -- grok-calls install         writes the launchd agent (live.ts, local.life-archive-voice-calls) and
//                                                 loads it; --dry-run prints it
//   npm run journal -- grok-calls uninstall       unloads and deletes it; the journals it wrote stay
//
// A pass's folders may be named, to try it on scratch ones: --cache <folder> (Grok Bot's) and --journals <folder> (the
// vault's Journals), and --provider <slug> for the name its files give (grok-bot). Rituals' bin/ritual-voice-calls,
// which an agent installed by rituals runs, names all three. A pass prints `{"ok":true,...}`, or `{"ok":false,"error":...}`
// and exits 1, one line each, as it did as rituals' (its log, ~/Library/Logs/LifeArchive/voice-calls.log, goes on).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Cause, Effect, Exit, Option } from "effect";
import { DATA_OPTION } from "../../../../sdk/command.ts";
import { archiveFolder, CORE_FILE, installLaunchAgent, jobNode, LOG_FOLDER, removeLaunchAgent, REPO, settings } from "../../../../sdk/server.ts";
import { CACHE, LAUNCHD_LABEL, LOG_NAME, OLD_LABEL, plist, PROVIDER } from "./live.ts";
import { grokCallsRun, type RunOptions } from "./round.ts";

const LOG_FILE = join(LOG_FOLDER, LOG_NAME);

/** The vault's Journals/ in the archive's folder. */
const vaultJournals = () => join(archiveFolder(), settings().vault.folder, "Journals");

/** Whether launchd has `label` loaded for this user. */
function loaded(label: string): Promise<boolean> {
  return promisify(execFile)("/bin/launchctl", ["print", `gui/${process.getuid?.()}/${label}`]).then(() => true, () => false);
}

/** A pass, its one JSON line printed: the counts and ids, or why it stopped (and exit code 1). */
export async function run(options: RunOptions): Promise<void> {
  process.umask(0o077);
  const exit = await Effect.runPromiseExit(grokCallsRun(options));
  if (Exit.isSuccess(exit)) return console.log(JSON.stringify(exit.value));
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) console.log(JSON.stringify({ ok: false, error: failure.value.message }));
  else console.error(Cause.pretty(exit.cause));
  process.exitCode = 1;
}

/** Writes and loads the agent, from the checkout whose archive keeps the journals; a dry run prints it and does nothing. */
export async function install({ dryRun }: { dryRun: boolean }): Promise<void> {
  const dataDir = archiveFolder();
  if (!existsSync(join(dataDir, CORE_FILE))) throw new Error(`there is no ${CORE_FILE} in ${dataDir}: install from the checkout whose archive keeps the journals`);
  const journals = vaultJournals();
  if (!existsSync(join(journals, "raw"))) throw new Error(`there is no ${join(journals, "raw")}: the job writes only into a journal that is already there`);
  const repo = REPO.replace(/\/$/, "");
  const text = plist({ node: jobNode(), repo, cache: CACHE, journals, logFile: LOG_FILE });
  if (dryRun) {
    console.log(`Would write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist:\n${text}`);
    return;
  }
  // Both would copy the same calls into the same folder; the old one goes first, by hand (README.md's "Grok calls").
  if (await loaded(OLD_LABEL)) throw new Error(`${OLD_LABEL} (rituals' old home) is still loaded: launchctl bootout gui/$(id -u)/${OLD_LABEL} first`);
  const file = await installLaunchAgent(LAUNCHD_LABEL, text);
  console.log(`Wrote ${file} and loaded it: each finished call in ${CACHE} is copied into ${join(journals, "raw")}, when the cache changes and every 30 minutes, logging to ${LOG_FILE}.`);
}

export async function uninstall(): Promise<void> {
  const had = await removeLaunchAgent(LAUNCHD_LABEL);
  console.log(`${had ? "Unloaded and deleted" : "There was no"} ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist; the journals it wrote stay.`);
}

/** `npm run journal -- grok-calls <args>`: a pass, install or uninstall. */
export async function grokCalls(args: string[]): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { ...DATA_OPTION, "dry-run": { type: "boolean" }, cache: { type: "string" }, journals: { type: "string" }, provider: { type: "string" } },
    });
    const command = positionals[0] ?? "run";
    if (command === "run") {
      if (values["dry-run"]) throw new Error("a pass has no dry run: it only adds files that are not there, never replacing one");
      return await run({ cacheDir: values.cache ?? CACHE, journalsDir: values.journals ?? vaultJournals(), provider: values.provider ?? PROVIDER });
    }
    if (command === "install") await install({ dryRun: values["dry-run"] ?? false });
    else if (command === "uninstall") await uninstall();
    else throw new Error(`unknown command grok-calls ${command}: run, install or uninstall`);
  } catch (error) {
    console.error(`ERROR ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
