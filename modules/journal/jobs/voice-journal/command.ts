// The voice journals' command (the journal module's cli.ts hands it every `npm run journal` but grok-calls; README.md;
// docs/features.md, "Voice journals, transcribed at 6 AM"): the voice journals Voice Memos syncs, transcribed each morning.
//
//   npm run journal                        a pass: each recording that has arrived since the ledger began is copied into
//                                          the journal's assets, transcribed (OpenSuperWhisper, then Nemotron when it is
//                                          here), written to the vault's Journals/raw/<date>/, and firstmate told
//   npm run journal -- --dry-run           says what a pass would do, and does nothing
//   npm run journal -- status              the ledger: what is done, waiting and failed
//   npm run journal -- retry <file>        forgets a failed recording, so the next pass tries it again
//   npm run journal -- install             builds the launcher Full Disk Access is given to, writes the launchd agent
//                                          (each day at 06:00), loads it, and
//                                          says what to grant; --dry-run prints it
//   npm run journal -- uninstall           unloads and deletes the agent and its launcher; the ledger and the journal stay
//
// A pass's folders may be named, to try it on scratch ones: --recordings <folder> (Voice Memos'), --journals <folder>
// (the vault's Journals), --state <folder> (the module's folder in the archive's folder, modules/journal/, where the
// ledger and lock are kept), --nemotron-model <file> and --nemo-speech <folder or program>, and --since <time> for the
// ledger a first pass makes (now, else). With no --state, a pass first takes the ledger over from where it was before
// the journal was a module, once (ledger.ts).
// Each line is logged with its time; a pass that fails (Full Disk Access not given, say) logs an ERROR line, raises a
// macOS notification and exits 1. The archive's folder is found as every entry point finds it (the core's dataHome.ts,
// through the SDK); nothing here opens archive.sqlite. cli.ts imports sdk/command.ts first (the pinned Node, the
// settings), and this file imports the SDK for the rest.

import { DATA_OPTION } from "../../../../sdk/command.ts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  archiveFolder, CORE_FILE, Effect, notifierLayer, installLaunchAgent, jobNode, Layer, liveVoiceTools, localTime, LOG_FOLDER, notify, removeLaunchAgent, REPO, runMain, settings,
} from "../../../../sdk/server.ts";
import { LEDGER_FILE, ledgerFile, readLedger, saveLedger, STATE_FOLDER, STATE_FOLDER_BEFORE, takeOverLedger } from "./ledger.ts";
import { buildLauncher, LAUNCHER, plist, SCRIPT } from "./live.ts";
import { voiceMemosFolder } from "./recordings.ts";
import { grantSteps, LAUNCHD_LABEL, LAUNCHER_ENV, voiceJournalRun } from "./round.ts";

const LOG_FILE = join(LOG_FOLDER, "voice-journal.log");
const TITLE = "Life archive: voice journals";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...DATA_OPTION,
    "dry-run": { type: "boolean" },
    recordings: { type: "string" },
    journals: { type: "string" },
    state: { type: "string" },
    "nemotron-model": { type: "string" },
    "nemo-speech": { type: "string" },
    since: { type: "string" },
  },
});
const command = positionals[0] ?? "run";
const dryRun = values["dry-run"] ?? false;

function log(line: string): void {
  console.log(`${localTime(new Date())} ${line}`);
}

function folders() {
  const dataDir = archiveFolder();
  return {
    recordings: values.recordings ?? voiceMemosFolder(homedir()),
    journals: values.journals ?? join(dataDir, settings().vault.folder, "Journals"),
    state: values.state ?? join(dataDir, STATE_FOLDER),
  };
}

const runOnce = Effect.gen(function* () {
  const launcher = process.env[LAUNCHER_ENV];
  const since = values.since ? Date.parse(values.since) : undefined;
  if (since !== undefined && Number.isNaN(since)) return yield* Effect.fail(new Error(`--since ${values.since} is not a time`));
  let where = folders();
  if (!values.state) {
    const taken = yield* Effect.promise(() => takeOverLedger(archiveFolder(), { dryRun }));
    if (taken) {
      log(taken.said);
      where = { ...where, state: taken.state };
    }
  }
  const tools = liveVoiceTools({
    ...(values["nemotron-model"] ? { nemotronModel: values["nemotron-model"] } : {}),
    ...(values["nemo-speech"] ? { nemoSpeech: values["nemo-speech"] } : {}),
  });
  const result = yield* voiceJournalRun({ ...where, dryRun, log, ...(launcher ? { launcher } : {}), ...(since !== undefined ? { since } : {}) }).pipe(
    Effect.provide(Layer.mergeAll(tools, notifierLayer(log, TITLE))),
  );
  if (result.noAccess) {
    return yield* Effect.fail(new Error(`no Full Disk Access to list Voice Memos' recordings${launcher ? `: grant it to ${launcher}` : ""}`));
  }
  if (result.indexUnreadable) return yield* Effect.fail(new Error(`Voice Memos' index could not be read, so ${result.done.length === 0 ? "nothing was taken" : `nothing more was taken after ${result.done.join(", ")}`} (the log says why)`));
  if (result.failed.length > 0) return yield* Effect.fail(new Error(`${result.failed.join(", ")} could not be transcribed (the log says why)`));
});

async function status(): Promise<void> {
  const { state } = folders();
  const ledger = await readLedger(state);
  if (!ledger) {
    const before = join(archiveFolder(), STATE_FOLDER_BEFORE);
    const old = values.state ? null : await readLedger(before);
    console.log(old
      ? `The ledger is still at ${ledgerFile(before)}, from before the journal was a module: the next pass takes it over into ${state}.`
      : `No ledger in ${state} yet: the first pass makes one, and transcribes what is recorded from then on.`);
    return;
  }
  console.log(`Ledger ${ledgerFile(state)}, transcribing recordings made from ${ledger.since} on:`);
  for (const [name, entry] of Object.entries(ledger.recordings)) {
    const what = entry.state === "done" ? `done, raw/${entry.journalDate}/ (${entry.files.join(", ")})${entry.noted ? "" : ", firstmate not yet told"}`
      : entry.state === "in-journal" ? `in the journal already (raw/${entry.journalDate}/), by hand`
      : entry.state === "failed" ? `failed ${entry.attempts}x${entry.lasting ? " (until fixed)" : ""}: ${entry.error}`
      : `waiting since ${entry.since}: ${entry.why}`;
    console.log(`  ${name}: ${what}`);
  }
}

async function retry(name: string | undefined): Promise<void> {
  if (!name) throw new Error("retry needs the recording's file name, as status shows it");
  const { state } = folders();
  const ledger = await readLedger(state);
  const entry = ledger?.recordings[name];
  if (!ledger || !entry) throw new Error(`the ledger has no ${name}`);
  if (entry.state !== "failed") throw new Error(`${name} has not failed (it is ${entry.state})`);
  delete ledger.recordings[name];
  await saveLedger(state, ledger);
  console.log(`${name} is forgotten: the next pass tries it again (launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL} runs one now).`);
}

async function install(): Promise<void> {
  // The launcher runs this checkout on its archive: a checkout with none (a worktree, say) would keep its ledger nowhere.
  const dataDir = archiveFolder();
  if (!existsSync(join(dataDir, CORE_FILE))) throw new Error(`there is no ${CORE_FILE} in ${dataDir}: install from the checkout whose archive keeps the journals`);
  const node = jobNode();
  const repo = REPO.replace(/\/$/, "");
  const text = plist({ node, repo, logFile: LOG_FILE });
  if (dryRun) {
    console.log(`Would build ${LAUNCHER} (running ${node} on ${repo}${SCRIPT}) and write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist:\n${text}`);
    return;
  }
  const built = await buildLauncher({ node, repo });
  const file = await installLaunchAgent(LAUNCHD_LABEL, text);
  console.log(`Wrote ${file} and loaded it: each day at 06:00, each recording Voice Memos has synced to ${voiceMemosFolder(homedir())} since the last pass, and not deleted, is transcribed into ${join(dataDir, settings().vault.folder, "Journals")}, logging to ${LOG_FILE}.`);
  console.log(built === "built"
    ? `Built ${LAUNCHER}. It is a new program to macOS, so it needs Full Disk Access given (again, if it had it):\n  ${grantSteps(LAUNCHER)}`
    : `${LAUNCHER} is unchanged, so it keeps the Full Disk Access it was given; if it has none yet:\n  ${grantSteps(LAUNCHER)}`);
  console.log("The first time it writes into the vault, macOS may ask whether it may \"access files managed by iCloud Drive\": Allow.");
}

async function uninstall(): Promise<void> {
  const had = await removeLaunchAgent(LAUNCHD_LABEL);
  await rm(LAUNCHER, { force: true });
  console.log(`${had ? "Unloaded and deleted" : "There was no"} ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist; deleted ${LAUNCHER}. ` +
    `The ledger (${join(archiveFolder(), STATE_FOLDER, LEDGER_FILE)}) and the journal's files stay. Its Full Disk Access entry is the captain's to remove ` +
    "(System Settings > Privacy & Security > Full Disk Access: select life-archive-voice-journal, click -).");
}

const program = Effect.gen(function* () {
  const plain = (work: () => Promise<void>) => Effect.tryPromise({ try: work, catch: (error) => error as Error });
  if (command === "run") yield* runOnce;
  else if (command === "status") yield* plain(status);
  else if (command === "retry") yield* plain(() => retry(positionals[1]));
  else if (command === "install") yield* plain(install);
  else if (command === "uninstall") yield* plain(uninstall);
  else return yield* Effect.fail(new Error(`unknown command ${command}: run, status, retry, install or uninstall`));
}).pipe(
  Effect.catch((error: { message: string }) =>
    Effect.sync(() => {
      log(`ERROR ${error.message}`);
      if (command === "run" && !dryRun) notify(TITLE, error.message);
      process.exitCode = 1;
    }),
  ),
);

// A signal (launchd stopping it, say) stops the pass; a recording cut short is done again at the next.
await runMain(program);
