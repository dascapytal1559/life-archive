// The Mac WhatsApp app's calls, synced every 15 minutes: the launchd job
// local.whatsapp-calls-import runs this (docs/archive.md's "The Mac app's calls, every
// 15 minutes"), its only schedule. The bridge brings WhatsApp's messages and
// media as they come, but not its calls; the Mac app keeps them, with how long
// each was connected, the ones made on the phone too.
//
//   npm run whatsapp-mac-calls [-- --dry-run] [--from <the app's folder>]
//   npm run whatsapp-mac-calls -- install [--dry-run]   writes and loads the launchd agent
//
// One run at a time (whatsapp-mac-calls/lock in the archive's folder, beside
// the run's state):
//
// 1. A safe copy of the app's four databases (ChatStorage, CallHistory, LID and
//    ContactsV2, each with its -wal and -shm), never opened where they are:
//    copied twice with cp -p, and kept only when both copies are the same byte
//    for byte (else the app was writing; tried again a little later, three
//    times in all).
// 2. Each database merged with its -wal into one file by SQLite's backup, from
//    the copy opened read-only (never with immutable=1, which would pass over
//    the -wal). The copies are made in the archive's folder, since they hold
//    every chat, and removed.
// 2b. The calls' fingerprint, read from the merged copy (callsFingerprint: how
//    many calls each table has, the newest's id, and the Calls tab's seconds
//    in all; nothing of who or what): the same as at the last import, and the
//    run is done, having kept no copy and imported nothing. Else the merged
//    copy replaces platform-exports/whatsapp/mac/.
// 3. A calls-only import of that folder: npm run archive -- import whatsapp-db
//    with only: calls, callsFrom: chats, and the bridge's database for LIDs the
//    copy cannot resolve (see read.ts). It adds only the calls the archive
//    lacks. With --dry-run, its dry run instead, and nothing is remembered.

import { DATA_OPTION } from "../../../../sdk/command.ts";
import { archivePath } from "../../server/storage.ts";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Data, Effect, Schedule } from "effect";
import { archiveFolder, expandHome, installLaunchAgent, jobNode, jobPath, launchdPlist, REPO, runPromise, takeLock } from "../../../../sdk/connector.ts";
import { WHATSAPP } from "../matrix-bridge/rig.ts";
import { manifest as bridgeManifest } from "../matrix-whatsapp/manifest.ts";
import { LAUNCHD_LABEL, STATE_FOLDER } from "./macCallsJob.ts";
import { TYPE_CALL } from "./read.ts";

const LOG_FILE = "/tmp/whatsapp-calls-import.log";

/** Where the Mac app keeps its databases. */
export const MAC_APP_FOLDER = join(homedir(), "Library", "Group Containers", "group.net.whatsapp.WhatsApp.shared");
export const MAC_DATABASES = ["ChatStorage.sqlite", "CallHistory.sqlite", "LID.sqlite", "ContactsV2.sqlite"];
const SIDE_FILES = ["", "-wal", "-shm"];
const CLI = fileURLToPath(new URL("../../../../server/archive/cli.ts", import.meta.url));

/** Copies one file as `cp -p` does (its times and mode kept). */
export type CopyFile = (from: string, to: string) => Promise<void>;
const cp: CopyFile = async (from, to) => void (await promisify(execFile)("/bin/cp", ["-p", from, to]));

/**
 * Makes the safe copy of the app's databases in `from` (see the top of this file) at
 * <archiveDir>/platform-exports/whatsapp/mac/, replacing what is there, and returns that folder; when `keep`, given
 * the merged copy, says no, nothing is replaced and it returns null.
 */
export async function copyMacApp(
  from: string,
  archiveDir: string,
  { attempts = 3, pauseMs = 10_000, copy = cp, keep }: { attempts?: number; pauseMs?: number; copy?: CopyFile; keep?: (merged: string) => boolean | Promise<boolean> } = {},
): Promise<string | null> {
  const present = MAC_DATABASES.flatMap((db) => SIDE_FILES.map((side) => db + side)).filter((name) => existsSync(join(from, name)));
  if (!present.includes("ChatStorage.sqlite")) throw new Error(`there is no WhatsApp ChatStorage.sqlite in ${from}`);
  const exports = join(archiveDir, "platform-exports", "whatsapp");
  const work = join(exports, ".mac-copying");
  const folder = join(exports, "mac");
  await rm(work, { recursive: true, force: true });
  try {
    const [first, second, merged] = ["pass-1", "pass-2", "merged"].map((name) => join(work, name));
    const copyTwice = Effect.gen(function* () {
      yield* Effect.promise(async () => {
        for (const pass of [first, second]) {
          await rm(pass, { recursive: true, force: true });
          await mkdir(pass, { recursive: true });
          for (const name of present) await copy(join(from, name), join(pass, name));
        }
      });
      if (!(yield* Effect.promise(() => sameFiles(first, second)))) return yield* new CopiesDiffer();
    });
    await runPromise(
      copyTwice.pipe(
        Effect.retry({ schedule: Schedule.spaced(pauseMs), times: attempts - 1 }),
        Effect.mapError(() => new Error(`WhatsApp changed its databases while they were copied, ${attempts} times over; try again later`)),
      ),
    );
    await mkdir(merged, { recursive: true });
    for (const name of MAC_DATABASES.filter((db) => present.includes(db))) {
      const source = new DatabaseSync(join(first, name), { readOnly: true });
      try {
        await backup(source, join(merged, name));
      } finally {
        source.close();
      }
      // One file, with no -wal beside it.
      const out = new DatabaseSync(join(merged, name));
      out.exec("PRAGMA journal_mode = DELETE");
      out.close();
    }
    if (keep && !(await keep(merged))) return null;
    await rm(`${folder}.old`, { recursive: true, force: true });
    if (existsSync(folder)) await rename(folder, `${folder}.old`);
    await rename(merged, folder);
    await rm(`${folder}.old`, { recursive: true, force: true });
    return folder;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The two copies of the app's databases differ: the app was writing to them. */
class CopiesDiffer extends Data.TaggedError("CopiesDiffer") {}

/** Whether two folders hold the same files, byte for byte. */
async function sameFiles(a: string, b: string): Promise<boolean> {
  const [left, right] = [(await readdir(a)).sort(), (await readdir(b)).sort()];
  if (left.join("/") !== right.join("/")) return false;
  const sha1 = async (file: string) => createHash("sha1").update(await readFile(file)).digest("hex");
  for (const name of left) if ((await sha1(join(a, name))) !== (await sha1(join(b, name)))) return false;
  return true;
}

/** The WhatsApp bridge's database, where the matrix-whatsapp connector's settings (or its usual place) say the rig is, if it is there. */
export async function bridgeDatabase(archiveDir: string): Promise<string | null> {
  let rig = bridgeManifest.defaultSource ?? "";
  try {
    const settings = JSON.parse(await readFile(join(archiveDir, "connectors", `${bridgeManifest.id}.json`), "utf8")) as { source?: unknown };
    if (typeof settings.source === "string" && settings.source) rig = settings.source;
  } catch {
    // No settings: the usual place.
  }
  const file = join(expandHome(rig), WHATSAPP.database);
  return rig && existsSync(file) ? file : null;
}

/**
 * What the copy in `folder` holds of calls, as one line to compare: how many call records the chats keep and the
 * newest's id, and how many calls the Calls tab keeps, the newest's id, and their seconds connected in all (so a call
 * whose length came later shows too). Counts and ids alone: nothing of who, when or what.
 */
export function callsFingerprint(folder: string): string {
  const read = (name: string, sql: string) => {
    const file = join(folder, name);
    if (!existsSync(file)) return "none";
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return Object.values(db.prepare(sql).get() as Record<string, unknown>).map((value) => String(value ?? 0)).join("/");
    } catch {
      return "none"; // no such table in this copy
    } finally {
      db.close();
    }
  };
  const chats = read("ChatStorage.sqlite", `SELECT count(*), max(Z_PK) FROM ZWAMESSAGE WHERE ZMESSAGETYPE = ${TYPE_CALL}`);
  const tab = read("CallHistory.sqlite", "SELECT count(*), max(Z_PK), total(ZDURATION) FROM ZWACDCALLEVENT");
  return `chats ${chats}; calls tab ${tab}`;
}

interface State {
  /** The calls' fingerprint at the last import that went well. */
  fingerprint?: string;
  /** When each connector last synced well (found nothing new, or imported): read by the Sources tab. */
  checked: Record<string, number>;
}

async function readState(archiveDir: string): Promise<State> {
  try {
    return { checked: {}, ...(JSON.parse(await readFile(join(archiveDir, STATE_FOLDER, "state.json"), "utf8")) as Partial<State>) };
  } catch {
    return { checked: {} };
  }
}

async function saveState(archiveDir: string, state: State): Promise<void> {
  const file = join(archiveDir, STATE_FOLDER, "state.json");
  await mkdir(join(archiveDir, STATE_FOLDER), { recursive: true });
  await writeFile(`${file}.new`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${file}.new`, file);
}

/** Runs the calls-only import of `folder`: its exit code. */
export type CallsImport = (folder: string, settings: Record<string, unknown>, dryRun: boolean) => Promise<number>;

const archiveImport = (archiveDir: string): CallsImport => (folder, settings, dryRun) => {
  const args = [CLI, "import", "whatsapp-db", folder, "--settings", JSON.stringify(settings), "--data", archiveDir, ...(dryRun ? ["--dry-run"] : [])];
  const child = spawn(process.execPath, ["--no-warnings", ...args], { stdio: "inherit" });
  return new Promise<number>((done) => child.on("close", (code) => done(code ?? 1)));
};

/**
 * One run: the safe copy, and the import when the calls changed since the last import that went well. "busy" when
 * another run holds the lock, "nothing new", or the import's exit code.
 */
export async function syncMacCalls({ from, archiveDir, dryRun = false, now = Date.now(), log = console.log, importCalls = archiveImport(archiveDir), pauseMs }: {
  from: string;
  archiveDir: string;
  dryRun?: boolean;
  now?: number;
  log?: (line: string) => void;
  importCalls?: CallsImport;
  pauseMs?: number;
}): Promise<"busy" | "nothing new" | number> {
  return runPromise(Effect.scoped(Effect.gen(function* () {
    const lock = dryRun ? "dry run" : yield* takeLock(join(archiveDir, STATE_FOLDER));
    if (!lock) {
      log(`${new Date(now).toISOString()} The last run is still going: leaving it to that one.`);
      return "busy" as const;
    }
    return yield* Effect.promise(async () => {
      const state = await readState(archiveDir);
      let fingerprint = "";
      const folder = await copyMacApp(from, archiveDir, {
        ...(pauseMs === undefined ? {} : { pauseMs }),
        keep: (merged) => (fingerprint = callsFingerprint(merged)) !== state.fingerprint,
      });
      if (!folder) {
        log(`${new Date(now).toISOString()} Nothing new: WhatsApp's calls are as at the last import (${fingerprint}).`);
        if (!dryRun) await saveState(archiveDir, { ...state, checked: { ...state.checked, "whatsapp-db": now } });
        return "nothing new" as const;
      }
      log(`${new Date(now).toISOString()} Copied WhatsApp's databases to ${folder} (${fingerprint}).`);
      const bridgeDb = await bridgeDatabase(archiveDir);
      if (!bridgeDb) log("The bridge's database is not there, so LIDs are only those the copy knows.");
      const code = await importCalls(folder, { only: "calls", callsFrom: "chats", ...(bridgeDb ? { bridgeDb } : {}) }, dryRun);
      if (code === 0 && !dryRun) await saveState(archiveDir, { fingerprint, checked: { ...state.checked, "whatsapp-db": now } });
      return code;
    });
  })));
}

/** Writes the launchd agent that runs this every 15 minutes, and loads it (from the checkout whose archive takes the calls). */
async function install(dryRun: boolean): Promise<void> {
  const archiveDir = archiveFolder();
  if (!existsSync(archivePath(archiveDir))) throw new Error(`there is no friend map archive at ${archivePath(archiveDir)}: install from the checkout whose archive takes the calls`);
  const node = jobNode();
  const repo = REPO.replace(/\/$/, "");
  const text = launchdPlist({
    label: LAUNCHD_LABEL,
    comment: `WhatsApp's calls from the Mac app into the life archive (${repo}, npm run whatsapp-mac-calls; docs/archive.md's "The Mac app's calls, every 15 minutes"), every 15 minutes. Written by npm run whatsapp-mac-calls -- install.`,
    program: [node, "--no-warnings", "modules/friend-map/connectors/whatsapp-db/macCalls.ts"],
    repo,
    path: jobPath(node),
    schedule: { everySeconds: 15 * 60 },
    logFile: LOG_FILE,
  });
  if (dryRun) {
    console.log(`Would write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist:\n${text}`);
    return;
  }
  const file = await installLaunchAgent(LAUNCHD_LABEL, text);
  console.log(`Wrote ${file} and loaded it: ${repo} syncs WhatsApp's calls from the Mac app every 15 minutes, logging to ${LOG_FILE}.`);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...DATA_OPTION, "dry-run": { type: "boolean" }, from: { type: "string" } } });
  const dryRun = values["dry-run"] ?? false;
  try {
    if (positionals[0] === "install") await install(dryRun);
    else if (positionals.length > 0) throw new Error(`unknown command ${positionals[0]}: install, or none for a run`);
    else {
      const result = await syncMacCalls({ from: values.from ? expandHome(values.from) : MAC_APP_FOLDER, archiveDir: archiveFolder(), dryRun });
      if (typeof result === "number") process.exitCode = result;
    }
  } catch (error) {
    console.error(`${new Date().toISOString()} ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
