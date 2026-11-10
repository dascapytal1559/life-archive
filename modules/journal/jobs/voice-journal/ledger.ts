// The voice journals' ledger (docs/features.md's "Voice journals, transcribed at 6 AM"): which of Voice Memos' recordings
// the transcription has done, found in the journal by firstmate's hand, is waiting on or could not do, keyed by file
// name, in the module's own folder in the archive's folder (modules/journal/ledger.json), its lock beside it. Written
// whole (the SDK's atomicWrite). Nothing in it is a word of a recording: a file name, times, a size, a state and the
// names of the files written for it.
//
// Before the journal was a module the ledger was the archive's folder's voice-journal/ledger.json. A pass whose module
// folder has no ledger beside an old one takes it over, copied once, so it goes on from where the old one was rather
// than beginning a new ledger that would leave the recordings since behind; the old file stays until firstmate removes
// it (the migration's steps).

import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, isMissingFile } from "../../../../sdk/server.ts";

/** The module's folder in the archive's folder, where the ledger and the lock are kept. */
export const STATE_FOLDER = "modules/journal";
/** Where the ledger was before the journal was a module. */
export const STATE_FOLDER_BEFORE = "voice-journal";
export const LEDGER_FILE = "ledger.json";

export type Entry =
  | { state: "done"; journalDate: string; files: string[]; noted: boolean; at: string }
  | { state: "in-journal"; journalDate: string; at: string }
  | { state: "failed"; attempts: number; error: string; lasting: boolean; noted: boolean; at: string }
  | { state: "waiting"; since: string; size: number; why: string };

export interface Ledger {
  version: 1;
  /** When the ledger began: recordings made before it are left to firstmate (the ones done by hand among them). */
  since: string;
  recordings: Record<string, Entry>;
}

export const ledgerFile = (state: string) => join(state, LEDGER_FILE);

export async function readLedger(state: string): Promise<Ledger | null> {
  try {
    return JSON.parse(await readFile(ledgerFile(state), "utf8")) as Ledger;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function saveLedger(state: string, ledger: Ledger): Promise<void> {
  await mkdir(state, { recursive: true });
  await atomicWrite(ledgerFile(state), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Takes the ledger over from where it was before the journal was a module, once: when the module's folder in `dataDir`
 * has none and voice-journal/ledger.json is there, that one is copied in (the old file stays). A line saying so and the
 * folder the pass reads its ledger from: the module's, or on a dry run, which copies nothing, the old one, so the dry
 * run reads the ledger it would have taken over. Null when there is nothing to take over.
 */
export async function takeOverLedger(dataDir: string, { dryRun = false } = {}): Promise<{ said: string; state: string } | null> {
  const state = join(dataDir, STATE_FOLDER);
  if (await readLedger(state)) return null;
  const before = join(dataDir, STATE_FOLDER_BEFORE);
  const old = await readLedger(before);
  if (!old) return null;
  if (dryRun) return { said: `dry run: would take the ledger over from ${ledgerFile(before)} into ${state} (recordings made from ${old.since} on)`, state: before };
  await mkdir(state, { recursive: true });
  const temporary = join(state, `.${LEDGER_FILE}.copying`);
  await copyFile(ledgerFile(before), temporary);
  await rename(temporary, ledgerFile(state));
  return { said: `took the ledger over from ${ledgerFile(before)} into ${state} (recordings made from ${old.since} on); the old file stays until it is removed`, state };
}
