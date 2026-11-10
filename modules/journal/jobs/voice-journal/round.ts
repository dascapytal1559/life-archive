// One pass of the voice journals' transcription (the journal module's; docs/features.md's "Voice journals, transcribed at 6 AM"),
// run by the launchd agent local.life-archive-voice-journal each day at 06:00 (`npm run journal`):
//
// 1. Lists the recordings Voice Memos has synced to this Mac, and what its index says of each (start, length, title,
//    whether it is deleted).
// 2. Leaves alone each one the ledger has (done, or already in the journal by hand), each made before the ledger began
//    (its first run), each the captain deleted in Voice Memos (in Recently Deleted, or not in its index at all), and
//    each still arriving (changed in the last minute, its audio not readable through, or shorter than Voice Memos
//    says), which it looks at again for up to ten minutes and at the next pass. When Voice Memos' index is there but
//    cannot be read, it takes no more, since it cannot tell which the captain deleted, and tells firstmate.
// 3. For each one that has arrived, in Journals/ (the vault's): copies it, never touching the original, into
//    assets/<journal date>/voice-memos/; transcribes the copy with OpenSuperWhisper on Parakeet v3, then with Nemotron
//    when its model is here; writes both transcripts and a journal-source-v1 record into raw/<journal date>/, named
//    <HHMM>-voice as firstmate named them by hand; and tells firstmate, who writes the journal itself.
//
// Each recording is done once, keyed by its file name in the ledger (modules/journal/ledger.json in the archive's
// folder, ledger.ts); a run that stops part way leaves no source record, and the next does it again. One run at a time
// (its lock beside it). The transcribers are the core's (server/voiceTools.ts), reached through the SDK.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Clock, Data, Effect } from "effect";
import { atomicWrite, dayKey, isoAt, Notifier, takeLock, type Transcript, TranscribeFailed, VoiceTools } from "../../../../sdk/server.ts";
import { type Entry, readLedger, saveLedger } from "./ledger.ts";
import {
  formatLength,
  listRecordings,
  type MemoFacts,
  moment,
  type Moment,
  NoAccess,
  readiness,
  readMemoIndex,
  type Recording,
  SETTLE_MS,
  sourceIdOf,
  startFromName,
  stemOf,
  UNLISTED,
} from "./recordings.ts";

export const NOTE_HEAD = "[life-archive voice-journal, automated]";
export const LAUNCHD_LABEL = "local.life-archive-voice-journal";
/** Set by the launcher (server/launcher.c) to its own path: the program Full Disk Access is given to. */
export const LAUNCHER_ENV = "LIFE_ARCHIVE_VOICE_JOURNAL_LAUNCHER";

/** The instruction a transcriber bake-off chose (its report is kept outside this repository), and a second, said as sentences, for when it comes back unpunctuated. */
export const INSTRUCTION = "Transcribe this audio with punctuation and capitalization. Include all spoken words and verbal fillers. Write numbers in their standard written form.";
export const SECOND_INSTRUCTION = "Transcribe this audio as sentences: end every sentence with a full stop, question mark or exclamation mark, and start it with a capital letter. " +
  "Include all spoken words and verbal fillers. Write numbers in their standard written form.";

/** How many times a recording is tried before firstmate is told it failed, and how long between tries. */
export const ATTEMPTS = 3;
export const RETRY_AFTER_MS = 15 * 60_000;
/** How long one run waits on a recording still arriving, looking again every half minute; the next pass looks after. */
export const ARRIVING_WAIT_MS = 10 * 60_000;
const LOOK_AGAIN_MS = 30_000;

export interface RunOptions {
  /** Voice Memos' folder, or a scratch one. */
  recordings: string;
  /** The journals' folder: the vault's Journals/. */
  journals: string;
  /** Where the ledger and lock are kept: the module's folder in the archive's folder, modules/journal/. */
  state: string;
  /** When a new ledger begins (its first run): now, unless said. */
  since?: number;
  dryRun?: boolean;
  /** The program that needs Full Disk Access, when the launcher started this run. */
  launcher?: string;
  log?: (line: string) => void;
  arrivingWaitMs?: number;
}

export interface RunResult {
  noAccess: boolean;
  /** Voice Memos' index is there but could not be read: nothing more was taken. */
  indexUnreadable: boolean;
  done: string[];
  failed: string[];
  waiting: string[];
  /** Another run held the lock: this one did nothing. */
  busy: boolean;
}

/** Writing the journal's files failed. */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{ readonly message: string }> {}

/** Whether a transcript reads as sentences: at least one full stop, question or exclamation mark to every 60 words (a short one passes). */
export function punctuated(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 30) return true;
  const ends = (text.match(/[.?!…]["')\]]?(\s|$)/g) ?? []).length;
  return ends * 60 >= words;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Every source_id the journal's raw folders hold already (firstmate's by hand among them), with its day. */
async function journalSources(journals: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const raw = join(journals, "raw");
  for (const day of await readdir(raw).catch(() => [] as string[])) {
    for (const name of await readdir(join(raw, day)).catch(() => [] as string[])) {
      if (!name.endsWith(".source.json")) continue;
      try {
        const record = JSON.parse(await readFile(join(raw, day, name), "utf8")) as { source_id?: unknown };
        if (typeof record.source_id === "string") found.set(record.source_id, day);
      } catch {
        // Not a record this can read: not one of its own.
      }
    }
  }
  return found;
}

/** <HHMM>-voice, or <HHMM>-voice-2 and on when another recording of that minute has it (a false start, say). */
async function freeBase(rawDir: string, hhmm: string): Promise<string> {
  const names = await readdir(rawDir).catch(() => [] as string[]);
  for (let n = 1; ; n++) {
    const base = n === 1 ? `${hhmm}-voice` : `${hhmm}-voice-${n}`;
    if (!names.some((name) => name === `${base}.source.json` || name.startsWith(`${base}-transcript-`))) return base;
  }
}

/** A transcript file, as firstmate wrote them by hand on 2026-11-02. */
export function transcriptText(input: { moment: Moment; title: string | null; seconds: number; asset: string; tool: string; transcript: Transcript; remark?: string }): string {
  const { moment: m } = input;
  const title = input.title ? `"${input.title}", ` : "";
  return [
    `# Voice memo, ${m.day} ${m.time} ${m.zone} (${input.tool}, verbatim)`,
    "",
    `- Source: Voice Memos, ${title}${formatLength(input.seconds)}, file ${input.asset}`,
    `- Engine: ${input.transcript.engine}`,
    ...(input.remark ? [`- Note: ${input.remark}`] : []),
    "",
    input.transcript.text,
    "",
  ].join("\n");
}

export interface SourceInput {
  recording: Recording;
  facts: MemoFacts | null | undefined;
  startedAt: number;
  seconds: number;
  moment: Moment;
  rawFile: string;
  rawSha256: string;
  relatedFiles: string[];
  audioSha256: string;
  notes: string;
}

/** The journal-source-v1 record of a recording, in the shape firstmate's 2026-11-01 entry has. */
export function sourceRecord(input: SourceInput) {
  const m = input.moment;
  const fromIndex = input.facts ? "the recording's start from Voice Memos (CloudRecordings.db ZDATE)" : "the recording's start from its file name (the phone's clock)";
  return {
    schema: "journal-source-v1",
    source_id: sourceIdOf(input.recording.name),
    provider: "apple-voice-memos",
    provider_ref: {
      file: input.recording.name,
      label: input.facts?.title ?? null,
      cloud_recording_date: input.facts?.cloudDate ?? null,
    },
    channel: "voice-memo",
    verbatim: true,
    sent_at: m.iso,
    // To the minute: when it reached this Mac is only as good as the file's time.
    received_at: isoAt(Math.floor(input.recording.birthtimeMs / 60_000) * 60_000),
    time_basis: `sent_at is ${fromIndex}; received_at is when iCloud synced it to the Mac (file time, minute precision). Length ${Math.round(input.seconds)} s.`,
    logical_ritual_date: m.journalDate,
    date_basis: m.nightBefore
      ? `Recorded ${m.time} ${m.weekdayDate} ${m.zone}, before 06:00, so it belongs to ritual day ${m.journalDate}.`
      : `Recorded ${m.time} ${m.weekdayDate} ${m.zone}, so it belongs to ritual day ${m.journalDate}.`,
    continuation_of: null,
    raw_file: input.rawFile,
    raw_sha256: input.rawSha256,
    related_files: input.relatedFiles,
    audio_sha256: input.audioSha256,
    ambiguous_transcriptions: [],
    request_ids: null,
    original_filename: input.recording.name,
    notes: input.notes,
  };
}

export function readyNote(input: { journalDate: string; rawDir: string; files: string[]; asset: string; title: string | null; seconds: number; moment: Moment; nemotron: string }): string {
  const title = input.title ? `"${input.title}", ` : "";
  return `${NOTE_HEAD} a new voice journal is ready to process for ${input.journalDate}: ${title}${formatLength(input.seconds)}, recorded ${input.moment.day} ${input.moment.time} ${input.moment.zone}. ` +
    `Raw files in ${input.rawDir}: ${input.files.join(", ")}; the audio is ${input.asset}. ${input.nemotron} ` +
    "The clean journal is yours to write (removal-only, per the journal rules).";
}

export function failedNote(name: string, error: string, attempts: number, lasting: boolean): string {
  return `${NOTE_HEAD} the voice memo ${name} could not be transcribed${lasting ? "" : ` after ${attempts} tries`}: ${error}. ` +
    "Nothing of it was written to the journal's raw folder; its log is ~/Library/Logs/LifeArchive/voice-journal.log. " +
    `Once fixed, \`npm run journal -- retry "${name}"\` tries it again.`;
}

export function grantSteps(launcher: string): string {
  return `System Settings > Privacy & Security > Full Disk Access; click +, press Cmd-Shift-G, paste ${launcher}, choose Open, and check its switch is on. ` +
    `Then \`launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL}\` runs it again (else it runs at 06:00).`;
}

export function noAccessNote(folder: string, launcher: string | undefined): string {
  return `${NOTE_HEAD} the voice journals' transcription did nothing: macOS has not given it Full Disk Access, so it may not list ${folder}. ` +
    (launcher
      ? `Granting it is the captain's, once, to this one program (not to node): ${grantSteps(launcher)}`
      : "It ran outside its launchd agent, so the terminal it ran in needs Full Disk Access; the agent needs it for its own program (`npm run journal -- install` names it).");
}

export function indexUnreadableNote(error: string, done: string[]): string {
  const took = done.length === 0 ? "took none" : `took no more after ${done.length === 1 ? "the one" : `the ${done.length}`} it had done (${done.join(", ")}, each noted on its own)`;
  return `${NOTE_HEAD} the voice journals' transcription stopped: it could not read Voice Memos' index (${error}), so it cannot tell which recordings the captain deleted, and ${took}. ` +
    `The next pass (06:00, or \`launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL}\`) tries again; its log is ~/Library/Logs/LifeArchive/voice-journal.log.`;
}

export const voiceJournalRun = Effect.fn("voiceJournalRun")(function* (options: RunOptions) {
  const log = options.log ?? (() => {});
  const result: RunResult = { noAccess: false, indexUnreadable: false, done: [], failed: [], waiting: [], busy: false };
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lock = options.dryRun ? "dry run" : yield* takeLock(options.state);
      if (!lock) {
        log("another run holds the lock: leaving it to that one");
        return { ...result, busy: true };
      }
      const notifier = yield* Notifier;
      const tools = yield* VoiceTools;
      const started = yield* Clock.currentTimeMillis;
      let ledger = yield* Effect.promise(() => readLedger(options.state));
      if (!ledger) {
        ledger = { version: 1, since: isoAt(options.since ?? started), recordings: {} };
        log(`a new ledger: recordings made from ${ledger.since} on are transcribed`);
        if (!options.dryRun) yield* Effect.promise(() => saveLedger(options.state, ledger!));
      }
      const since = Date.parse(ledger.since);
      const save = () => (options.dryRun ? Effect.void : Effect.promise(() => saveLedger(options.state, ledger!)));
      const waiting = () => Object.entries(ledger!.recordings).filter(([, e]) => e.state === "waiting").map(([name]) => name);
      // Unlisted at an earlier pass: deleted, its file left behind, not one whose row is still syncing.
      const unlistedBefore = new Set(Object.entries(ledger.recordings).filter(([, e]) => e.state === "waiting" && e.why === UNLISTED).map(([name]) => name));

      for (;;) {
        const recordings = yield* listRecordings(options.recordings).pipe(Effect.catchTag("NoAccess", (error) => Effect.succeed(error)));
        if (!Array.isArray(recordings)) {
          log(`no access: ${recordings.message}`);
          if (!options.dryRun) yield* notifier.note(`voice-journal-no-access-${dayKey(started)}`, noAccessNote(options.recordings, options.launcher)).pipe(Effect.ignore);
          return { ...result, noAccess: true };
        }
        const index = yield* readMemoIndex(options.recordings).pipe(Effect.catchTag("NoAccess", (error) => Effect.succeed(error)));
        if (index instanceof NoAccess) {
          log(`Voice Memos' index: ${index.message}; taking nothing until it can be read`);
          if (!options.dryRun) yield* notifier.note(`voice-journal-index-unreadable-${dayKey(started)}`, indexUnreadableNote(index.message, result.done)).pipe(Effect.ignore);
          return { ...result, indexUnreadable: true, waiting: waiting() };
        }
        // One deleted while it waited (on the phone, mid-sync) is waited on no more: gone from the folder, or in Voice
        // Memos' Recently Deleted with its file still here. Restored, it is a new one again.
        const present = new Set(recordings.filter((r) => !index?.get(r.name)?.deleted).map((r) => r.name));
        for (const [name, entry] of Object.entries(ledger.recordings)) {
          if (entry.state === "waiting" && !present.has(name)) delete ledger.recordings[name];
        }
        const inJournal = yield* Effect.promise(() => journalSources(options.journals));
        const now = yield* Clock.currentTimeMillis;
        let arriving = 0;

        for (const recording of recordings) {
          const entry = ledger.recordings[recording.name];
          if (entry?.state === "in-journal") continue;
          if (entry?.state === "done") {
            if (!entry.noted && !options.dryRun) {
              yield* notifier.note(`voice-journal-${stemOf(recording.name)}`, `${NOTE_HEAD} a new voice journal is ready to process for ${entry.journalDate}: ${entry.files.join(", ")}.`).pipe(
                Effect.tap(() => Effect.sync(() => (entry.noted = true))),
                Effect.ignore,
              );
              yield* save();
            }
            continue;
          }
          if (entry?.state === "failed" && (entry.lasting || entry.attempts >= ATTEMPTS || now - Date.parse(entry.at) < RETRY_AFTER_MS)) continue;

          const facts = index ? (index.get(recording.name) ?? null) : undefined;
          if (facts?.deleted) continue;
          const startedAt = facts?.startedAt ?? startFromName(recording.name) ?? recording.birthtimeMs;
          if (startedAt < since) continue;
          const sourceId = sourceIdOf(recording.name);
          const there = inJournal.get(sourceId);
          if (there) {
            log(`${recording.name}: already in the journal (raw/${there}), done by hand`);
            ledger.recordings[recording.name] = { state: "in-journal", journalDate: there, at: isoAt(now) };
            yield* save();
            continue;
          }

          const settled = recording.size > 0 && now - recording.mtimeMs >= SETTLE_MS;
          const probed = settled ? yield* tools.probeSeconds(recording.path) : null;
          const waitingSince = entry?.state === "waiting" && entry.size === recording.size ? Date.parse(entry.since) : null;
          const ready = readiness({ size: recording.size, mtimeMs: recording.mtimeMs, now, probedSeconds: probed, facts, waitingSince });
          if (!ready.ready) {
            if (entry?.state !== "waiting" || entry.why !== ready.why || entry.size !== recording.size) log(`${recording.name}: waiting, ${ready.why}`);
            ledger.recordings[recording.name] = { state: "waiting", since: isoAt(waitingSince ?? now), size: recording.size, why: ready.why };
            yield* save();
            if (!(ready.why === UNLISTED && unlistedBefore.has(recording.name))) arriving++;
            continue;
          }

          const seconds = facts && facts.seconds > 0 ? facts.seconds : probed!;
          const m = moment(startedAt);
          if (options.dryRun) {
            log(`dry run: would transcribe ${recording.name} (${formatLength(seconds)}) into raw/${m.journalDate}/ as ${m.hhmm}-voice`);
            continue;
          }
          log(`${recording.name}: transcribing (${formatLength(seconds)}, journal ${m.journalDate})`);
          const outcome = yield* transcribeOne({ options, recording, facts, startedAt, seconds, moment: m, doubt: ready.doubt }).pipe(
            Effect.map((made) => ({ ok: true as const, made })),
            Effect.catch((error: TranscribeFailed | WriteFailed) => Effect.succeed({ ok: false as const, error })),
          );
          const at = isoAt(yield* Clock.currentTimeMillis);
          if (outcome.ok) {
            const { made } = outcome;
            log(`${recording.name}: written to raw/${m.journalDate}/ (${made.files.join(", ")})`);
            const done: Entry = { state: "done", journalDate: m.journalDate, files: made.files, noted: false, at };
            ledger.recordings[recording.name] = done;
            yield* save();
            yield* notifier.note(`voice-journal-${stemOf(recording.name)}`, made.note).pipe(
              Effect.tap(() => Effect.sync(() => (done.noted = true))),
              Effect.catch((error) => Effect.sync(() => log(`the note to firstmate failed (${error.message}); the next pass sends it`))),
            );
            yield* save();
            result.done.push(recording.name);
          } else {
            const error = outcome.error;
            const lasting = error._tag === "TranscribeFailed" && error.lasting === true;
            const attempts = (entry?.state === "failed" ? entry.attempts : 0) + 1;
            log(`${recording.name}: failed (try ${attempts}): ${error.message}`);
            const failed: Entry = { state: "failed", attempts, error: error.message, lasting, noted: false, at };
            ledger.recordings[recording.name] = failed;
            if (lasting || attempts >= ATTEMPTS) {
              yield* notifier.note(`voice-journal-failed-${stemOf(recording.name)}-${attempts}`, failedNote(recording.name, error.message, attempts, lasting)).pipe(
                Effect.tap(() => Effect.sync(() => (failed.noted = true))),
                Effect.ignore,
              );
            }
            yield* save();
            result.failed.push(recording.name);
          }
        }

        const waited = (yield* Clock.currentTimeMillis) - started;
        if (arriving === 0 || options.dryRun || waited >= (options.arrivingWaitMs ?? ARRIVING_WAIT_MS)) {
          result.waiting = waiting();
          return result;
        }
        yield* Effect.sleep(LOOK_AGAIN_MS);
      }
    }),
  );
});

/** One recording into the journal: its copy, its transcripts and its source record, and the note that says so. */
const transcribeOne = Effect.fn("transcribeOne")(function* (input: {
  options: RunOptions;
  recording: Recording;
  facts: MemoFacts | null | undefined;
  startedAt: number;
  seconds: number;
  moment: Moment;
  doubt: string | null;
}) {
  const tools = yield* VoiceTools;
  const { options, recording, moment: m } = input;
  const log = options.log ?? (() => {});
  const write = <A>(what: string, work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: (error) => new WriteFailed({ message: `${what}: ${(error as Error).message}` }) });

  // The copy, in the journal's assets, made under a hidden name and checked against the original before it is named.
  const assetsDir = join(options.journals, "assets", m.journalDate, "voice-memos");
  const assetName = `${stemOf(recording.name)}${extname(recording.name).toLowerCase()}`;
  const assetPath = join(assetsDir, assetName);
  const asset = `assets/${m.journalDate}/voice-memos/${assetName}`;
  const audioSha256 = yield* write("reading the recording", () => sha256(recording.path));
  yield* write("copying the recording", async () => {
    await mkdir(assetsDir, { recursive: true });
    if (existsSync(assetPath)) {
      if ((await sha256(assetPath)) === audioSha256) return;
      throw new Error(`${asset} is there already, and is another recording`);
    }
    const temporary = join(assetsDir, `.${assetName}.copying`);
    await copyFile(recording.path, temporary);
    if ((await sha256(temporary)) !== audioSha256) {
      await rm(temporary, { force: true });
      throw new Error("the copy differs from the recording (it changed while copied)");
    }
    await rename(temporary, assetPath);
  });

  // The transcripts, from the copy: OpenSuperWhisper must come back; Nemotron, the second opinion, may not.
  const osw = yield* tools.osw(assetPath, input.seconds);
  let nemotron: Transcript | null = null;
  let nemotronSaid: string;
  let nemotronPunctuated = false;
  if (tools.nemotronMissing) {
    nemotronSaid = `Nemotron was skipped: ${tools.nemotronMissing}.`;
    log(`${recording.name}: ${nemotronSaid}`);
  } else {
    const first = yield* tools.nemotron(assetPath, input.seconds, INSTRUCTION).pipe(Effect.catch((error) => Effect.succeed(error)));
    let got: Transcript | TranscribeFailed = first;
    if (!(got instanceof TranscribeFailed) && !punctuated(got.text)) {
      log(`${recording.name}: Nemotron came back without punctuation; asking again, in other words`);
      const second = yield* tools.nemotron(assetPath, input.seconds, SECOND_INSTRUCTION).pipe(Effect.catch((error) => Effect.succeed(error)));
      if (!(second instanceof TranscribeFailed) && punctuated(second.text)) got = second;
    }
    if (got instanceof TranscribeFailed) {
      nemotronSaid = `Nemotron failed (${got.message}); OpenSuperWhisper's transcript stands alone.`;
      log(`${recording.name}: ${nemotronSaid}`);
    } else {
      nemotron = got;
      nemotronPunctuated = punctuated(got.text);
      nemotronSaid = !got.text
        ? "Nemotron heard no words, so OpenSuperWhisper's transcript is the base text."
        : nemotronPunctuated
        ? "Nemotron's transcript is the base text, OpenSuperWhisper's the cross-check."
        : "Nemotron came back without punctuation twice, so OpenSuperWhisper's transcript is the base text and Nemotron's only a word check.";
    }
  }

  const rawDir = join(options.journals, "raw", m.journalDate);
  yield* write("making the raw folder", () => mkdir(rawDir, { recursive: true }));
  const base = yield* Effect.promise(() => freeBase(rawDir, m.hhmm));
  const oswFile = `${base}-transcript-osw.md`;
  const nemotronFile = `${base}-transcript-nemotron.md`;
  const sourceFile = `${base}.source.json`;
  const header = { moment: m, title: input.facts?.title ?? null, seconds: input.seconds, asset };
  const oswText = transcriptText({ ...header, tool: "OpenSuperWhisper", transcript: osw });
  yield* write(`writing ${oswFile}`, () => atomicWrite(join(rawDir, oswFile), oswText));
  const files = [oswFile];
  let nemotronText: string | null = null;
  if (nemotron) {
    nemotronText = transcriptText({
      ...header,
      tool: "Nemotron 3.5 Transcribe",
      transcript: nemotron,
      ...(nemotronPunctuated ? {} : { remark: "came back without punctuation, asked twice" }),
    });
    yield* write(`writing ${nemotronFile}`, () => atomicWrite(join(rawDir, nemotronFile), nemotronText!));
    files.push(nemotronFile);
  }
  const baseIsNemotron = nemotron !== null && nemotron.text !== "" && nemotronPunctuated;
  const rawFile = baseIsNemotron ? nemotronFile : oswFile;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const notes = [
    `Transcribed automatically on this Mac by the life archive's voice-journal agent (${LAUNCHD_LABEL}): ` +
      (nemotron ? `${nemotron.engine.replace(/, on this Mac$/, "")} and ${osw.engine.replace(/, on this Mac$/, "")}. ` : `${osw.engine.replace(/, on this Mac$/, "")}. `),
    nemotronSaid,
    input.doubt ? ` Taken without Voice Memos' word that it had finished syncing (${input.doubt}): check its length.` : "",
    " Not yet cleaned: the edits file, cleanup_sha256 and ambiguous transcriptions are firstmate's to add.",
  ].join("");
  const record = sourceRecord({
    recording,
    facts: input.facts,
    startedAt: input.startedAt,
    seconds: input.seconds,
    moment: m,
    rawFile,
    rawSha256: digest(baseIsNemotron ? nemotronText! : oswText),
    relatedFiles: [...files.filter((file) => file !== rawFile), `../../${asset}`],
    audioSha256,
    notes,
  });
  // The record last: a raw folder with transcripts and no record is a run that stopped, done again.
  yield* write(`writing ${sourceFile}`, () => atomicWrite(join(rawDir, sourceFile), `${JSON.stringify(record, null, 2)}\n`));
  files.push(sourceFile);
  const size = yield* Effect.promise(() => stat(assetPath).then((info) => info.size));
  log(`${recording.name}: audio copied (${(size / 1_000_000).toFixed(1)} MB) to ${asset}`);
  return {
    files,
    note: readyNote({ journalDate: m.journalDate, rawDir, files, asset: join(options.journals, asset), title: input.facts?.title ?? null, seconds: input.seconds, moment: m, nemotron: nemotronSaid }),
  };
});
