// The archive's nightly encrypted backup on the NAS (server/archive/nasBackup.ts; docs/data.md's "The NAS copy"), and before
// it every LLM transcript taken into the archive's folder (server/archive/transcripts.ts; docs/data.md's "Every LLM transcript"):
//
//   npm run nas-backup                  the night's transcripts and the LLM warehouse's index of them (server/llm/pass.ts), then
//                                       one snapshot of the archive's folder and friend-map's, one of the
//                                       transcripts alone (never forgotten), then the retention (of the archive's folder's only)
//   npm run nas-backup -- --dry-run     says what it would take, back up and forget, writing nothing
//   npm run nas-backup -- transcripts   the transcripts alone, now (--dry-run: what it would take)
//   npm run nas-backup -- transcripts check   reads back every transcript kept, against its index and its tool's file
//   npm run nas-backup -- init          puts a new password in the Keychain (unless one is there) and makes the repository
//   npm run nas-backup -- verify        restic check, reading back a sample, the newest snapshot's databases restored and checked,
//                                       and the newest of the transcripts' snapshots looked for
//   npm run nas-backup -- status        the last run, from data/backups/nas-backup.json, and the transcripts' last pass
//   npm run nas-backup -- install       writes the launchd agent (06:00 daily) and loads it; --dry-run prints it
//
// --host <ssh host> uses that host alone; otherwise the settings' nasBackup.hosts, in turn. Each line is logged with its time; a
// failed run logs an ERROR line, raises a macOS notification, is kept in the status file and exits 1. A transcript it
// could not read is a PROBLEM line and a notification, and the snapshot is still made; so is a pass that failed whole,
// which also makes the run exit 1.

import "./onPinnedNode.ts";
import "./onSettings.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { archiveFolder, jobNode, REPO } from "./dataHome.ts";
import {
  archiveUnready, findRestic, initRepository, KeychainPasswordStore, LAUNCHD_LABEL, NAS_HOSTS, OTHER_FOLDERS, plist, reachNas, readNasStatus, recordNasFailure, Restic,
  runNasBackup, verifiedWhole, verifyNasBackup,
} from "./archive/nasBackup.ts";
import { bytes, captureTranscripts, checkTranscripts, readCaptureStatus, TRANSCRIPT_SOURCES, type CaptureStatus } from "./archive/transcripts.ts";
import { runMain } from "./effectRuntime.ts";
import { installLaunchAgent, localTime, LOG_FOLDER, requireLaunchd } from "./jobs.ts";
import { warehousePass } from "./llm/pass.ts";
import { notify } from "./notifier/notifier.ts";

const LOG_FILE = join(LOG_FOLDER, "nas-backup.log");

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean" }, host: { type: "string" } } });
const command = positionals[0] ?? "run";
const dataDir = archiveFolder();
const dryRun = values["dry-run"] ?? false;

function log(line: string): void {
  console.log(`${localTime(new Date())} ${line}`);
}

/** restic on the NAS, the password from the login Keychain. */
const nasRestic = Effect.gen(function* () {
  const bin = yield* Effect.try({ try: () => findRestic(), catch: (error) => error as Error });
  return new Restic(bin, yield* reachNas(values.host ? [values.host] : NAS_HOSTS), new KeychainPasswordStore());
});

/** Plain work (a file read, the install) in the program, its failure the error itself. */
const plain = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error as Error });

/** The transcripts' pass, said in the log; one that could not read some, or failed whole, also notified. */
const transcripts = Effect.gen(function* () {
  log(`${dryRun ? "dry run: transcripts" : "taking the transcripts"} into ${dataDir}/transcripts`);
  const status = yield* captureTranscripts({ dataDir, sources: TRANSCRIPT_SOURCES, log, dryRun });
  const problems = status.sources.reduce((sum, s) => sum + s.problems.length, 0);
  const read = status.sources.reduce((sum, s) => sum + s.read, 0);
  log(`transcripts ${dryRun ? "dry run done: nothing read or written" : `taken: read ${bytes(read)}`}${problems ? `; ${problems} could not be read (the PROBLEM lines)` : ""}`);
  if (problems && !dryRun) notify("The life archive could not take some LLM transcripts", `${problems} could not be read: see ~/Library/Logs/LifeArchive/nas-backup.log`);
  return status;
});

const program = Effect.gen(function* () {
  if (command === "run") {
    // Before the snapshot, so it holds them; a pass that fails whole is said, and the snapshot still made.
    const taken = yield* transcripts.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log(`ERROR the transcripts' pass: ${error.message}`);
          if (!dryRun) notify("The life archive could not take the LLM transcripts", error.message);
          process.exitCode = 1;
          return null as CaptureStatus | null;
        }),
      ),
    );
    // The LLM warehouse's index brought up to date, so the snapshot holds tonight's; one that fails is said, and the
    // snapshot still made.
    if (!dryRun) {
      yield* warehousePass({ dataDir, log: (line) => log(`LLM warehouse: ${line}`) }).pipe(
        Effect.tap(({ imported, retagged }) => Effect.sync(() => log(`LLM warehouse: read ${imported.read} of ${imported.files} session files, ${imported.indexed} indexed; ${retagged.added} tags added, ${retagged.removed} taken off`))),
        Effect.catch((error) => Effect.sync(() => log(`ERROR the LLM warehouse: ${error.message}`))),
      );
    }
    log(`${dryRun ? "dry run" : "backing up"} ${dataDir}${taken ? "" : " (without tonight's transcripts)"}`);
    yield* runNasBackup({ dataDir, restic: yield* nasRestic, log, dryRun, otherFolders: OTHER_FOLDERS });
    log(dryRun ? "dry run done: nothing backed up or forgotten" : "done");
  } else if (command === "transcripts" && positionals[1] === "check") {
    const result = yield* checkTranscripts({ dataDir, sources: TRANSCRIPT_SOURCES, log });
    log(`${result.ok} files read back whole, ${result.matchOriginal} of them byte for byte their tool's file still; ${result.bad.length} wrong`);
    if (result.bad.length > 0) return yield* Effect.fail(new Error(`${result.bad.length} transcripts kept are not what was taken: see the WRONG lines`));
  } else if (command === "transcripts") {
    yield* transcripts;
  } else if (command === "init") {
    yield* initRepository({ restic: yield* nasRestic, log });
  } else if (command === "verify") {
    const result = yield* verifyNasBackup({ dataDir, restic: yield* nasRestic, otherFolders: OTHER_FOLDERS, log });
    if (!verifiedWhole(result)) {
      const what = !result.snapshot
        ? "there is no snapshot of the archive's folder on the NAS"
        : !result.transcripts.snapshot
          ? "there is no snapshot of the transcripts on the NAS"
          : "the newest snapshots are not whole: see the lines above";
      return yield* Effect.fail(new Error(what));
    }
  } else if (command === "status") {
    const status = yield* plain(() => readNasStatus(dataDir));
    console.log(status ? JSON.stringify(status, null, 2) : "No NAS backup has run on this archive yet.");
    const captured = yield* plain(() => readCaptureStatus(dataDir));
    console.log(captured ? JSON.stringify(captured, null, 2) : "No transcripts have been taken into this archive yet.");
  } else if (command === "install") {
    yield* plain(install);
  } else {
    return yield* Effect.fail(new Error(`unknown command ${command}: run, transcripts, init, verify, status or install`));
  }
}).pipe(
  Effect.catch((error: Error) =>
    Effect.promise(async () => {
      log(`ERROR ${error.message}`);
      if (command === "run" && !dryRun) {
        await recordNasFailure(dataDir, error).catch(() => {});
        notify("The life archive's NAS backup failed", error.message);
      }
      process.exitCode = 1;
    }),
  ),
);

// A signal (launchd stopping it, say) stops the restic it waits on, deletes the database copy and lets the lock go.
await runMain(program);

async function install(): Promise<void> {
  // The agent runs this checkout on its archive: a checkout with none (a worktree, say) would back up nothing.
  const unready = archiveUnready(dataDir);
  if (unready) throw new Error(`${unready}: install from the checkout whose archive this backs up, once it has moved`);
  requireLaunchd(LAUNCHD_LABEL);
  findRestic();
  const text = plist({ node: jobNode(), repo: REPO.replace(/\/$/, ""), logFile: LOG_FILE });
  const file = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (dryRun) {
    console.log(`Would write ${file}:\n${text}`);
    return;
  }
  await installLaunchAgent(LAUNCHD_LABEL, text);
  console.log(`Wrote ${file} and loaded it: ${REPO} backs up to the NAS at 06:00 each day, logging to ${LOG_FILE}.`);
  console.log(`Run it now with: launchctl kickstart gui/${process.getuid?.()}/${LAUNCHD_LABEL}`);
}
