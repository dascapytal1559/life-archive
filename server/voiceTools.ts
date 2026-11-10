// The programs a recording is transcribed with, as a service: the core's, shared by the journal module's voice journals
// (modules/journal; docs/features.md's "Voice journals, transcribed at 6 AM"), and by any other module that needs a
// recording transcribed on this Mac, each reaching it through the SDK. ffprobe for a recording's length; OpenSuperWhisper on
// Parakeet v3, handed the file with `open -a` and read back from its own history (recordings.sqlite, read-only); and,
// when its model is on this Mac, Nemotron 3.5 Transcribe through NeMo-Speech.cpp, from a 16 kHz mono copy ffmpeg makes
// in a temporary folder. Everything runs on this Mac; nothing is sent anywhere. Tests give a made-up VoiceTools.

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Clock, Context, Data, Effect, Layer, Schedule } from "effect";
import { run } from "./childProcess.ts";
import { pathSetting } from "./dataHome.ts";

/** A transcription that did not come back. `lasting` when trying again cannot help (OpenSuperWhisper set to Whisper, say). */
export class TranscribeFailed extends Data.TaggedError("TranscribeFailed")<{ readonly message: string; readonly lasting?: boolean }> {}

export interface Transcript {
  text: string;
  /** What made it, as the transcript's Engine line says: "OpenSuperWhisper 0.1.0, Parakeet TDT 0.6B v3 (FluidAudio), on this Mac". */
  engine: string;
}

export class VoiceTools extends Context.Service<VoiceTools, {
  /** A recording's length in seconds, read through its audio; null when it cannot be read through (cut short, still arriving). */
  readonly probeSeconds: (file: string) => Effect.Effect<number | null, TranscribeFailed>;
  /** OpenSuperWhisper's transcript of `file`, a recording `seconds` long. */
  readonly osw: (file: string, seconds: number) => Effect.Effect<Transcript, TranscribeFailed>;
  /** Why Nemotron cannot run here (its model or runner is not on this Mac), or null when it can. */
  readonly nemotronMissing: string | null;
  /** Nemotron's transcript of `file`, asked with `instruction`. */
  readonly nemotron: (file: string, seconds: number, instruction: string) => Effect.Effect<Transcript, TranscribeFailed>;
}>()("life-archive/VoiceTools") {}

/** OpenSuperWhisper's preferences domain and history. */
const OSW_DOMAIN = "ru.starmel.OpenSuperWhisper";
export const OSW_HISTORY = join(homedir(), "Library", "Application Support", OSW_DOMAIN, "recordings.sqlite");
/** Nemotron 3.5 Transcribe 30B (its encoder file beside it) and NeMo-Speech.cpp: NEMOTRON_MODEL and NEMO_SPEECH_HOME; unset, no Nemotron. */
export const NEMOTRON_MODEL = pathSetting("NEMOTRON_MODEL");
export const NEMO_SPEECH_HOME = pathSetting("NEMO_SPEECH_HOME");

/** OpenSuperWhisper on Parakeet runs at about 240 times real time; ten minutes besides covers its first-use compile and a queue. */
export const oswTimeoutMs = (seconds: number) => 600_000 + seconds * 250;
/** Nemotron took about a minute for 12 minutes of audio, its 21 GB model loaded for each file. */
export const nemotronTimeoutMs = (seconds: number) => 900_000 + seconds * 500;

export interface LiveToolsOptions {
  oswHistory?: string;
  nemotronModel?: string;
  /** NeMo-Speech.cpp's folder (holding <release>/bin/nemo-speech), or the program itself. */
  nemoSpeech?: string;
}

/** The nemo-speech program: the one named, or the one in a release folder (<release>/bin/nemo-speech), the newest named first. */
export function findNemoSpeech(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  if (statSync(path).isFile()) return path;
  if (existsSync(join(path, "bin", "nemo-speech"))) return join(path, "bin", "nemo-speech");
  for (const release of readdirSync(path).sort().reverse()) {
    const program = join(path, release, "bin", "nemo-speech");
    if (existsSync(program)) return program;
  }
  return null;
}

/** Why Nemotron cannot run, or null: the model, its encoder beside it, and the runner must all be here. */
export function nemotronMissing(model: string | undefined, nemoSpeech: string | null): string | null {
  if (!model) return "no model is named (NEMOTRON_MODEL)";
  if (!existsSync(model)) return `its model is not on this Mac (${model})`;
  const encoder = readdirSync(dirname(model)).some((name) => /encoder/i.test(name) && name.endsWith(".gguf"));
  if (!encoder) return `its encoder is not beside its model (${dirname(model)})`;
  if (!nemoSpeech) return `NeMo-Speech.cpp is not on this Mac (${NEMO_SPEECH_HOME ?? "NEMO_SPEECH_HOME is not set"})`;
  return null;
}

/** The model's quantisation as its file names it: AD-IQ4_NL GGUF. */
function quantOf(model: string): string {
  const match = /-((?:AD-)?I?Q\d\w*|F16|BF16)\.gguf$/i.exec(basename(model));
  return match ? `${match[1]} GGUF` : basename(model);
}

const failWith = (what: string) => (error: { message: string }) => new TranscribeFailed({ message: `${what}: ${error.message}` });

/** A UTC instant as OpenSuperWhisper's history writes it: 2026-11-01 15:25:40.207. */
const historyTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 23);

interface HistoryRow {
  status: string;
  transcription: string;
}

/** OpenSuperWhisper's newest history entry for a file handed to it since `since`, read-only; null when there is none yet. */
function readHistory(history: string, paths: string[], since: number): HistoryRow | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(history, { readOnly: true });
    const marks = paths.map(() => "?").join(", ");
    const row = db.prepare(`SELECT status, transcription FROM recordings WHERE sourceFileURL IN (${marks}) AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1`)
      .get(...paths, historyTime(since)) as HistoryRow | undefined;
    return row ?? null;
  } catch {
    // Busy or not there yet: looked at again.
    return null;
  } finally {
    db?.close();
  }
}

const readDefault = (key: string) =>
  run("/usr/bin/defaults", ["read", OSW_DOMAIN, key]).pipe(
    Effect.map(({ stdout }) => stdout.trim() as string | null),
    Effect.catch(() => Effect.succeed(null)),
  );

/** The installed OpenSuperWhisper's version, from its bundle; null when it is not where apps are. */
const oswVersion = Effect.gen(function* () {
  for (const app of ["/Applications/OpenSuperWhisper.app", join(homedir(), "Applications", "OpenSuperWhisper.app")]) {
    if (!existsSync(app)) continue;
    return yield* run("/usr/bin/defaults", ["read", join(app, "Contents", "Info.plist"), "CFBundleShortVersionString"]).pipe(
      Effect.map(({ stdout }) => stdout.trim() as string | null),
      Effect.catch(() => Effect.succeed(null)),
    );
  }
  return null;
});

export const liveVoiceTools = (options: LiveToolsOptions = {}) => {
  const history = options.oswHistory ?? OSW_HISTORY;
  const model = options.nemotronModel ?? NEMOTRON_MODEL;
  const nemoSpeech = findNemoSpeech(options.nemoSpeech ?? NEMO_SPEECH_HOME);
  const missing = nemotronMissing(model, nemoSpeech);
  const nemotronModel = model ?? "";

  const probeSeconds = (file: string) =>
    run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).pipe(
      Effect.map(({ stdout }) => {
        const seconds = Number.parseFloat(stdout.trim());
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      }),
      // ffprobe ran and could not read it through: still arriving. Not starting at all is a fault here, said.
      Effect.catch((failed) => failed.code === undefined ? Effect.fail(new TranscribeFailed({ message: `ffprobe could not start: ${failed.message}`, lasting: true })) : Effect.succeed(null)),
    );

  const osw = (file: string, seconds: number) =>
    Effect.gen(function* () {
      // Parakeet only: OpenSuperWhisper's Whisper engine, timestamps off, dropped long stretches of a test recording.
      const engine = (yield* readDefault("selectedEngine")) ?? "whisper";
      if (engine !== "fluidaudio") {
        return yield* new TranscribeFailed({ message: `OpenSuperWhisper is set to its ${engine} engine, not Parakeet (fluidaudio): set it back in its settings`, lasting: true });
      }
      const parakeet = (yield* readDefault("fluidAudioModelVersion")) ?? "v3";
      if (parakeet !== "v3") return yield* new TranscribeFailed({ message: `OpenSuperWhisper is set to Parakeet ${parakeet}, not v3`, lasting: true });
      const version = yield* oswVersion;
      const real = yield* Effect.promise(() => realpath(file));
      const since = (yield* Clock.currentTimeMillis) - 5_000;
      // -g: in the background, so a recording synced while the captain works does not take his screen.
      yield* run("/usr/bin/open", ["-g", "-a", "OpenSuperWhisper", real]).pipe(Effect.mapError(failWith("OpenSuperWhisper would not open the recording")));
      const timeout = oswTimeoutMs(seconds);
      const done = yield* Effect.sync(() => readHistory(history, [...new Set([real, file])], since)).pipe(
        Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (row) => row?.status === "completed" || row?.status === "failed" }),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new TranscribeFailed({ message: `OpenSuperWhisper had not finished it after ${Math.round(timeout / 60_000)} minutes` })),
        }),
      );
      if (!done || done.status !== "completed") return yield* new TranscribeFailed({ message: `OpenSuperWhisper failed: ${done?.transcription.slice(0, 200) ?? "no entry"}` });
      return { text: done.transcription.trim(), engine: `OpenSuperWhisper${version ? ` ${version}` : ""}, Parakeet TDT 0.6B v3 (FluidAudio), on this Mac` } satisfies Transcript;
    });

  const nemotron = (file: string, seconds: number, instruction: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (missing || !nemoSpeech) return yield* new TranscribeFailed({ message: `Nemotron cannot run: ${missing}`, lasting: true });
        // The 16 kHz copy is made in a folder of this run's own, removed however it ends.
        const work = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "voice-journal-"))),
          (folder) => Effect.promise(() => rm(folder, { recursive: true, force: true })),
        );
        const wav = join(work, "memo-16k.wav");
        yield* run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", file, "-ac", "1", "-ar", "16000", wav]).pipe(
          Effect.mapError(failWith("ffmpeg could not make the 16 kHz copy")),
        );
        // It says "nemo-speech 0.3.0"; the project calls itself NeMo-Speech.cpp.
        const version = yield* run(nemoSpeech, ["--version"]).pipe(
          Effect.map(({ stdout }) => stdout.trim().replace(/^nemo-speech\b/i, "NeMo-Speech.cpp")),
          Effect.catch(() => Effect.succeed("NeMo-Speech.cpp")),
        );
        const out = join(work, "memo.txt");
        const timeout = nemotronTimeoutMs(seconds);
        yield* run(nemoSpeech, ["transcribe", wav, "--model", nemotronModel, "--device", "metal", "--format", "text", "--quiet", "--instruction", instruction, "-o", out]).pipe(
          Effect.mapError(failWith("Nemotron failed")),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new TranscribeFailed({ message: `Nemotron had not finished after ${Math.round(timeout / 60_000)} minutes` })),
          }),
        );
        const text = yield* Effect.tryPromise({ try: () => readFile(out, "utf8"), catch: (error) => failWith("Nemotron wrote no transcript")(error as Error) });
        return { text: text.trim(), engine: `NVIDIA Nemotron 3.5 Transcribe 30B-A4B (${quantOf(nemotronModel)}), ${version} Metal, on this Mac` } satisfies Transcript;
      }),
    );

  return Layer.succeed(VoiceTools, { probeSeconds, osw, nemotronMissing: missing, nemotron });
};
