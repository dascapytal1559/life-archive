import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Notifier, type Transcript, TranscribeFailed, VoiceTools } from "../../../../sdk/server.ts";
import { type Entry, readLedger, saveLedger, STATE_FOLDER, STATE_FOLDER_BEFORE, takeOverLedger } from "./ledger.ts";
import { buildLauncher, plist } from "./live.ts";
import { formatLength, moment, readiness, startFromName } from "./recordings.ts";
import { ARRIVING_WAIT_MS, INSTRUCTION, punctuated, type RunResult, SECOND_INSTRUCTION, voiceJournalRun } from "./round.ts";

// Made-up recordings: their names have Voice Memos' shape, their bytes are not audio (the tools here are made up too).
const MEMO = "20261102 014448-AAAA1111.m4a";
const FALSE_START = "20261102 014436-BBBB2222.m4a";
const EVENING = "20261102 193005-CCCC3333.m4a";
const OLD = "20261020 101500-DDDD4444.m4a";
const SINCE = "2026-11-01T00:00:00+11:00";
const SENTENCES = Array.from({ length: 12 }, (_, i) => `This is made-up sentence number ${i + 1} of a sample journal.`).join(" ");
const RUN_ON = Array.from({ length: 12 }, (_, i) => `this is made-up phrase number ${i + 1} of a sample journal`).join(" ");

let root: string;
let recordings: string;
let journals: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "voice-journal-"));
  recordings = join(root, "Recordings");
  journals = join(root, "Journals");
  state = join(root, "state");
  await mkdir(recordings, { recursive: true });
});

afterEach(async () => {
  await chmod(recordings, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** A made-up recording, last changed `agoMs` before now. */
async function recording(name: string, { bytes = `made-up audio of ${name}`, agoMs = 120_000 } = {}): Promise<string> {
  const file = join(recordings, name);
  await writeFile(file, bytes);
  const at = new Date(Date.now() - agoMs);
  await utimes(file, at, at);
  return file;
}

/**
 * Voice Memos' index, as CloudRecordings.db keeps it, with only the columns read; `deletedAt` is when one was moved to
 * Recently Deleted (Voice Memos' ZEVICTIONDATE, which it sets then and keeps the file).
 */
function memoIndex(rows: Array<{ name: string; startedAt: string; seconds: number; title: string; deletedAt?: string }>): void {
  const db = new DatabaseSync(join(recordings, "CloudRecordings.db"));
  db.exec("CREATE TABLE IF NOT EXISTS ZCLOUDRECORDING (Z_PK INTEGER PRIMARY KEY, ZDATE TIMESTAMP, ZDURATION FLOAT, ZEVICTIONDATE TIMESTAMP, ZCUSTOMLABEL VARCHAR, ZENCRYPTEDTITLE VARCHAR, ZPATH VARCHAR)");
  const coreData = (iso: string) => Date.parse(iso) / 1000 - 978_307_200;
  for (const row of rows) {
    const ms = Date.parse(row.startedAt);
    db.prepare("INSERT INTO ZCLOUDRECORDING (ZDATE, ZDURATION, ZEVICTIONDATE, ZCUSTOMLABEL, ZENCRYPTEDTITLE, ZPATH) VALUES (?, ?, ?, ?, ?, ?)")
      .run(coreData(row.startedAt), row.seconds, row.deletedAt ? coreData(row.deletedAt) : null, new Date(ms).toISOString().replace(/\.000Z$/, "Z"), row.title, row.name);
  }
  db.close();
}

interface FakeTools {
  /** Each recording's length as its audio reads through, by file name; absent is null (not readable through yet). */
  seconds: Record<string, number>;
  /** What Nemotron says, in turn; "missing" when it is not on this Mac. */
  nemotron?: "missing" | Array<string | TranscribeFailed>;
  osw?: string | TranscribeFailed;
}

function fakeTools(fake: FakeTools) {
  const calls = { osw: [] as string[], nemotron: [] as string[], instructions: [] as string[] };
  const nemotron = fake.nemotron === "missing" ? [] : [...(fake.nemotron ?? [SENTENCES])];
  const layer = Layer.succeed(VoiceTools, {
    probeSeconds: (file: string) => Effect.succeed(fake.seconds[file.split("/").at(-1)!] ?? null),
    osw: (file: string) => {
      calls.osw.push(file);
      const said = fake.osw ?? SENTENCES;
      return typeof said === "string" ? Effect.succeed({ text: said, engine: "OpenSuperWhisper 0.1.0, Parakeet TDT 0.6B v3 (FluidAudio), on this Mac" } satisfies Transcript) : Effect.fail(said);
    },
    nemotronMissing: fake.nemotron === "missing" ? "its model is not on this Mac (/opt/sample/nemotron.gguf)" : null,
    nemotron: (file: string, _seconds: number, instruction: string) => {
      calls.nemotron.push(file);
      calls.instructions.push(instruction);
      const said = nemotron.shift() ?? SENTENCES;
      return typeof said === "string"
        ? Effect.succeed({ text: said, engine: "NVIDIA Nemotron 3.5 Transcribe 30B-A4B (AD-IQ4_NL GGUF), NeMo-Speech.cpp 0.3.0 Metal, on this Mac" } satisfies Transcript)
        : Effect.fail(said);
    },
  });
  return { layer, calls };
}

/** firstmate's inbox, which takes a note with an id it has had once only. */
function fakeNotifier(notes: Map<string, string>) {
  return Layer.succeed(Notifier, { note: (id: string, text: string) => Effect.sync(() => void (notes.has(id) || notes.set(id, text))) });
}

function pass(tools: ReturnType<typeof fakeTools>, notes: Map<string, string>, extra: { since?: number } = {}) {
  return voiceJournalRun({ recordings, journals, state, since: extra.since ?? Date.parse(SINCE), arrivingWaitMs: 0 }).pipe(
    Effect.provide(Layer.mergeAll(tools.layer, fakeNotifier(notes))),
  );
}

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("a pass", () => {
  it.live("copies a new recording, transcribes the copy twice, writes the raw files and record firstmate named by hand, and tells firstmate once", () =>
    Effect.gen(function* () {
      const original = yield* Effect.promise(() => recording(MEMO));
      memoIndex([{ name: MEMO, startedAt: "2026-11-01T14:44:48Z", seconds: 2136.02, title: "Grove Street" }]);
      const before = yield* Effect.promise(() => stat(original));
      const tools = fakeTools({ seconds: { [MEMO]: 2136.0 } });
      const notes = new Map<string, string>();

      const result = yield* pass(tools, notes);
      expect(result.done).toEqual([MEMO]);

      // 01:44 on 2 November is the night of 1 November.
      const raw = join(journals, "raw", "2026-11-01");
      expect((yield* Effect.promise(() => readdir(raw))).sort()).toEqual(["0144-voice-transcript-nemotron.md", "0144-voice-transcript-osw.md", "0144-voice.source.json"]);
      const asset = join(journals, "assets", "2026-11-01", "voice-memos", "20261102-014448-AAAA1111.m4a");
      expect(yield* Effect.promise(() => readFile(asset, "utf8"))).toBe(`made-up audio of ${MEMO}`);
      // Both engines were given the copy, never the original, which is as it was.
      expect(tools.calls.osw).toEqual([asset]);
      expect(tools.calls.nemotron).toEqual([asset]);
      expect(tools.calls.instructions).toEqual([INSTRUCTION]);
      const after = yield* Effect.promise(() => stat(original));
      expect(after.mtimeMs).toBe(before.mtimeMs);

      const osw = yield* Effect.promise(() => readFile(join(raw, "0144-voice-transcript-osw.md"), "utf8"));
      expect(osw.split("\n").slice(0, 4)).toEqual([
        "# Voice memo, 2026-11-02 01:44 AEDT (OpenSuperWhisper, verbatim)",
        "",
        "- Source: Voice Memos, \"Grove Street\", 35:36, file assets/2026-11-01/voice-memos/20261102-014448-AAAA1111.m4a",
        "- Engine: OpenSuperWhisper 0.1.0, Parakeet TDT 0.6B v3 (FluidAudio), on this Mac",
      ]);
      expect(osw).toContain(SENTENCES);
      const nemotron = yield* Effect.promise(() => readFile(join(raw, "0144-voice-transcript-nemotron.md"), "utf8"));
      expect(nemotron.split("\n")[0]).toBe("# Voice memo, 2026-11-02 01:44 AEDT (Nemotron 3.5 Transcribe, verbatim)");

      const record = yield* Effect.promise(() => readJson(join(raw, "0144-voice.source.json")));
      expect(record).toMatchObject({
        schema: "journal-source-v1",
        source_id: "voicememo-20261102-014448-AAAA1111",
        provider: "apple-voice-memos",
        provider_ref: { file: MEMO, label: "Grove Street", cloud_recording_date: "2026-11-01T14:44:48Z" },
        channel: "voice-memo",
        verbatim: true,
        sent_at: "2026-11-02T01:44:48+11:00",
        logical_ritual_date: "2026-11-01",
        date_basis: "Recorded 01:44 Mon 2 Nov AEDT, before 06:00, so it belongs to ritual day 2026-11-01.",
        continuation_of: null,
        raw_file: "0144-voice-transcript-nemotron.md",
        raw_sha256: sha(nemotron),
        related_files: ["0144-voice-transcript-osw.md", "../../assets/2026-11-01/voice-memos/20261102-014448-AAAA1111.m4a"],
        audio_sha256: sha(`made-up audio of ${MEMO}`),
        ambiguous_transcriptions: [],
        request_ids: null,
        original_filename: MEMO,
      });
      expect(record.time_basis).toContain("Length 2136 s.");
      expect(record.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);

      expect([...notes.keys()]).toEqual(["voice-journal-20261102-014448-AAAA1111"]);
      const note = notes.get("voice-journal-20261102-014448-AAAA1111")!;
      expect(note).toContain("ready to process for 2026-11-01");
      expect(note).toContain(`${raw}: 0144-voice-transcript-osw.md, 0144-voice-transcript-nemotron.md, 0144-voice.source.json`);
      expect(note).toContain("Nemotron's transcript is the base text");

      // A second pass, and a third, find nothing new: nothing transcribed or told again.
      yield* pass(tools, notes);
      yield* pass(tools, notes);
      expect(tools.calls.osw).toHaveLength(1);
      expect(notes.size).toBe(1);
      expect((yield* Effect.promise(() => readLedger(state)))!.recordings[MEMO]).toMatchObject({ state: "done", journalDate: "2026-11-01", noted: true });
    }));

  it.live("skips a recording the captain deleted in Voice Memos, in Recently Deleted or erased, though its file is still there", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(MEMO));
      yield* Effect.promise(() => recording(FALSE_START));
      yield* Effect.promise(() => recording(EVENING));
      // The false start in Recently Deleted; the evening's erased for good (no row), its file left behind.
      memoIndex([
        { name: MEMO, startedAt: "2026-11-01T14:44:48Z", seconds: 61, title: "Grove Street" },
        { name: FALSE_START, startedAt: "2026-11-01T14:44:36Z", seconds: 4, title: "Grove Street", deletedAt: "2026-11-01T14:44:46Z" },
      ]);
      const tools = fakeTools({ seconds: { [MEMO]: 61, [FALSE_START]: 4, [EVENING]: 61 } });
      const notes = new Map<string, string>();

      const result = yield* pass(tools, notes);
      expect(result.done).toEqual([MEMO]);
      expect(tools.calls.osw).toEqual([join(journals, "assets", "2026-11-01", "voice-memos", "20261102-014448-AAAA1111.m4a")]);
      expect(yield* Effect.promise(() => readdir(join(journals, "raw", "2026-11-01")))).not.toContain("0144-voice-2.source.json");
      expect(existsSync(join(journals, "raw", "2026-11-02"))).toBe(false);
      expect([...notes.keys()]).toEqual(["voice-journal-20261102-014448-AAAA1111"]);
      const ledger = (yield* Effect.promise(() => readLedger(state)))!;
      expect(ledger.recordings[FALSE_START]).toBeUndefined();
      expect(ledger.recordings[EVENING]).toMatchObject({ state: "waiting", why: "Voice Memos' index does not list it (not synced yet, or deleted)" });

      // Still nothing a day on: an unlisted one is never taken, however long it has waited.
      const waiting = ledger.recordings[EVENING] as Extract<Entry, { state: "waiting" }>;
      ledger.recordings[EVENING] = { ...waiting, since: "2026-10-01T06:00:00+10:00" };
      yield* Effect.promise(() => saveLedger(state, ledger));
      expect((yield* pass(tools, notes)).done).toEqual([]);
      expect(tools.calls.osw).toHaveLength(1);
    }));

  it.live("takes nothing, and tells firstmate once that day, when Voice Memos' index is there but cannot be read", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      // An index of a shape this does not know (no ZEVICTIONDATE): which recordings were deleted cannot be told.
      const db = new DatabaseSync(join(recordings, "CloudRecordings.db"));
      db.exec("CREATE TABLE ZCLOUDRECORDING (Z_PK INTEGER PRIMARY KEY, ZDATE TIMESTAMP, ZDURATION FLOAT, ZPATH VARCHAR)");
      db.close();
      const tools = fakeTools({ seconds: { [EVENING]: 61 } });
      const notes = new Map<string, string>();

      expect(yield* pass(tools, notes)).toMatchObject({ indexUnreadable: true, done: [], failed: [] });
      yield* pass(tools, notes);
      expect(tools.calls.osw).toEqual([]);
      expect(existsSync(join(journals, "raw"))).toBe(false);
      expect(existsSync(join(journals, "assets"))).toBe(false);
      const [[id, text], ...more] = [...notes];
      expect(more).toEqual([]);
      expect(id).toMatch(/^voice-journal-index-unreadable-\d{4}-\d{2}-\d{2}$/);
      expect(text).toContain("cannot tell which recordings the captain deleted, and took none.");
    }));

  it.effect("says what it had done when Voice Memos' index cannot be read part way through a pass", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      yield* Effect.promise(() => recording(EVENING));
      yield* Effect.promise(() => recording(MEMO, { agoMs: 1_000 }));
      memoIndex([
        { name: EVENING, startedAt: "2026-11-02T08:30:05Z", seconds: 61, title: "Grove Street" },
        { name: MEMO, startedAt: "2026-11-01T14:44:48Z", seconds: 61, title: "Grove Street" },
      ]);
      const tools = fakeTools({ seconds: { [EVENING]: 61, [MEMO]: 61 } });
      const notes = new Map<string, string>();
      const live = (ms: number) => TestClock.withLive(Effect.sleep(ms));
      const fiber = yield* Effect.forkChild(
        voiceJournalRun({ recordings, journals, state, since: Date.parse(SINCE), arrivingWaitMs: ARRIVING_WAIT_MS }).pipe(
          Effect.provide(Layer.mergeAll(tools.layer, fakeNotifier(notes))),
        ),
        { startImmediately: true },
      );
      // The evening's done and noted; the other, changed a moment ago, is looked at again in half a minute.
      while (!notes.has("voice-journal-20261102-193005-CCCC3333")) yield* live(10);
      yield* Effect.promise(() => writeFile(join(recordings, "CloudRecordings.db"), "not a database"));
      let result: RunResult | null = null;
      for (let tries = 0; result === null && tries < 20; tries++) {
        yield* TestClock.adjust(30_000);
        result = yield* Effect.raceFirst(Fiber.join(fiber), live(100).pipe(Effect.as(null)));
      }
      expect(result).toMatchObject({ indexUnreadable: true, done: [EVENING] });
      const [id, text] = [...notes].find(([key]) => key.startsWith("voice-journal-index-unreadable-"))!;
      expect(id).toMatch(/^voice-journal-index-unreadable-\d{4}-\d{2}-\d{2}$/);
      expect(text).toContain(`took no more after the one it had done (${EVENING}, each noted on its own)`);
      expect(text).not.toContain("took none");
    }));

  it.effect("looks again for a recording the index does not list in the pass that first finds it, and not in later ones", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      yield* Effect.promise(() => recording(EVENING));
      memoIndex([{ name: MEMO, startedAt: "2026-11-01T14:44:48Z", seconds: 61, title: "Grove Street" }]);
      const tools = fakeTools({ seconds: { [EVENING]: 61 } });
      const run = voiceJournalRun({ recordings, journals, state, since: Date.parse(SINCE), arrivingWaitMs: ARRIVING_WAIT_MS }).pipe(
        Effect.provide(Layer.mergeAll(tools.layer, fakeNotifier(new Map()))),
      );
      // The test clock stands still, so a pass that looks again never ends; a second of real time is ample for one that does not.
      const outcome = <E>(fiber: Fiber.Fiber<{ waiting: string[] }, E>) =>
        Effect.raceFirst(Fiber.join(fiber).pipe(Effect.map((result) => result.waiting)), TestClock.withLive(Effect.sleep(1_000)).pipe(Effect.as("looking again" as const)));

      // First found unlisted: its row may still be syncing.
      const first = yield* Effect.forkChild(run, { startImmediately: true });
      expect(yield* outcome(first)).toBe("looking again");
      yield* Fiber.interrupt(first);
      expect((yield* Effect.promise(() => readLedger(state)))!.recordings[EVENING]).toMatchObject({
        state: "waiting",
        why: "Voice Memos' index does not list it (not synced yet, or deleted)",
      });

      // Still unlisted the next pass: a deleted one's file, which holds that pass no longer.
      const second = yield* Effect.forkChild(run, { startImmediately: true });
      expect(yield* outcome(second)).toEqual([EVENING]);
      expect(tools.calls.osw).toEqual([]);
    }));

  it.live("leaves a recording still arriving until it has, and only then transcribes it", () =>
    Effect.gen(function* () {
      const tools = fakeTools({ seconds: {} });
      const notes = new Map<string, string>();
      memoIndex([{ name: MEMO, startedAt: "2026-11-01T14:44:48Z", seconds: 600, title: "Grove Street" }]);

      // Changed a moment ago: still being written.
      yield* Effect.promise(() => recording(MEMO, { agoMs: 1_000 }));
      expect((yield* pass(tools, notes)).waiting).toEqual([MEMO]);
      expect((yield* Effect.promise(() => readLedger(state)))!.recordings[MEMO]).toMatchObject({ state: "waiting", why: "it changed in the last minute" });

      // Settled, but cut short: its audio cannot be read through.
      yield* Effect.promise(() => recording(MEMO, { bytes: "half" }));
      expect((yield* pass(tools, notes)).waiting).toEqual([MEMO]);

      // Readable, but shorter than Voice Memos says: still syncing.
      tools.calls.osw.length = 0;
      const shorter = fakeTools({ seconds: { [MEMO]: 300 } });
      expect((yield* pass(shorter, notes)).waiting).toEqual([MEMO]);
      expect((yield* Effect.promise(() => readLedger(state)))!.recordings[MEMO]).toMatchObject({ state: "waiting", why: "it is 5:00 of the 10:00 Voice Memos lists (still syncing)" });
      expect(shorter.calls.osw).toEqual([]);
      expect(existsSync(join(journals, "raw"))).toBe(false);
      expect(existsSync(join(journals, "assets"))).toBe(false);

      // Gone (deleted on the phone): waited on no more; back, it is waited on afresh.
      yield* Effect.promise(() => rm(join(recordings, MEMO)));
      expect((yield* pass(shorter, notes)).waiting).toEqual([]);

      // Whole.
      const whole = fakeTools({ seconds: { [MEMO]: 599.8 } });
      yield* Effect.promise(() => recording(MEMO, { bytes: "the whole made-up recording" }));
      expect((yield* pass(whole, notes)).done).toEqual([MEMO]);
      expect(notes.size).toBe(1);
    }));

  it.live("writes OpenSuperWhisper's transcript alone, as the record's raw file, when Nemotron is not on this Mac", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      const tools = fakeTools({ seconds: { [EVENING]: 61 }, nemotron: "missing" });
      const notes = new Map<string, string>();
      // No index (a scratch folder): the start is the name's, in Melbourne.
      expect((yield* pass(tools, notes)).done).toEqual([EVENING]);
      const raw = join(journals, "raw", "2026-11-02");
      expect((yield* Effect.promise(() => readdir(raw))).sort()).toEqual(["1930-voice-transcript-osw.md", "1930-voice.source.json"]);
      const record = yield* Effect.promise(() => readJson(join(raw, "1930-voice.source.json")));
      expect(record).toMatchObject({
        raw_file: "1930-voice-transcript-osw.md",
        related_files: ["../../assets/2026-11-02/voice-memos/20261102-193005-CCCC3333.m4a"],
        provider_ref: { file: EVENING, label: null, cloud_recording_date: null },
        sent_at: "2026-11-02T19:30:05+11:00",
        date_basis: "Recorded 19:30 Mon 2 Nov AEDT, so it belongs to ritual day 2026-11-02.",
      });
      expect(record.notes).toContain("Nemotron was skipped: its model is not on this Mac");
      expect(record.time_basis).toContain("from its file name");
      expect(tools.calls.nemotron).toEqual([]);
      expect(notes.get("voice-journal-20261102-193005-CCCC3333")).toContain("Nemotron was skipped");
    }));

  it.live("asks Nemotron again in other words when it comes back unpunctuated, and keeps OpenSuperWhisper's as the base when it does again", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      const tools = fakeTools({ seconds: { [EVENING]: 61 }, nemotron: [RUN_ON, RUN_ON] });
      yield* pass(tools, new Map());
      expect(tools.calls.instructions).toEqual([INSTRUCTION, SECOND_INSTRUCTION]);
      const raw = join(journals, "raw", "2026-11-02");
      const record = yield* Effect.promise(() => readJson(join(raw, "1930-voice.source.json")));
      expect(record.raw_file).toBe("1930-voice-transcript-osw.md");
      expect(record.related_files).toEqual(["1930-voice-transcript-nemotron.md", "../../assets/2026-11-02/voice-memos/20261102-193005-CCCC3333.m4a"]);
      expect(yield* Effect.promise(() => readFile(join(raw, "1930-voice-transcript-nemotron.md"), "utf8"))).toContain("- Note: came back without punctuation, asked twice");

      // Punctuated the second time: that one is kept, and is the base.
      const again = fakeTools({ seconds: { [MEMO]: 61 }, nemotron: [RUN_ON, SENTENCES] });
      yield* Effect.promise(() => recording(MEMO));
      yield* pass(again, new Map());
      expect((yield* Effect.promise(() => readJson(join(journals, "raw", "2026-11-01", "0144-voice.source.json")))).raw_file).toBe("0144-voice-transcript-nemotron.md");
    }));

  it.live("keeps OpenSuperWhisper's transcript as the base when Nemotron hears no words", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      yield* pass(fakeTools({ seconds: { [EVENING]: 5 }, nemotron: [""] }), new Map());
      const record = yield* Effect.promise(() => readJson(join(journals, "raw", "2026-11-02", "1930-voice.source.json")));
      expect(record.raw_file).toBe("1930-voice-transcript-osw.md");
      expect(record.notes).toContain("Nemotron heard no words");
    }));

  it.live("keeps OpenSuperWhisper's transcript when Nemotron fails", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      const tools = fakeTools({ seconds: { [EVENING]: 61 }, nemotron: [new TranscribeFailed({ message: "Nemotron failed: out of memory" })] });
      expect((yield* pass(tools, new Map())).done).toEqual([EVENING]);
      const record = yield* Effect.promise(() => readJson(join(journals, "raw", "2026-11-02", "1930-voice.source.json")));
      expect(record.raw_file).toBe("1930-voice-transcript-osw.md");
      expect(record.notes).toContain("Nemotron failed (Nemotron failed: out of memory)");
    }));

  it.live("names a second recording of the same minute <HHMM>-voice-2", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(FALSE_START));
      yield* Effect.promise(() => recording(MEMO));
      yield* pass(fakeTools({ seconds: { [FALSE_START]: 3.4, [MEMO]: 61 } }), new Map());
      const raw = join(journals, "raw", "2026-11-01");
      const files = (yield* Effect.promise(() => readdir(raw))).sort();
      expect(files.filter((f) => f.endsWith(".source.json"))).toEqual(["0144-voice-2.source.json", "0144-voice.source.json"]);
      expect((yield* Effect.promise(() => readJson(join(raw, "0144-voice.source.json")))).original_filename).toBe(FALSE_START);
      expect((yield* Effect.promise(() => readJson(join(raw, "0144-voice-2.source.json")))).original_filename).toBe(MEMO);
    }));

  it.live("leaves recordings made before the ledger began, and those firstmate put in the journal by hand", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(OLD));
      yield* Effect.promise(() => recording(MEMO));
      const raw = join(journals, "raw", "2026-11-01");
      yield* Effect.promise(async () => {
        await mkdir(raw, { recursive: true });
        await writeFile(join(raw, "0144-voice.source.json"), JSON.stringify({ schema: "journal-source-v1", source_id: "voicememo-20261102-014448-AAAA1111" }));
      });
      const tools = fakeTools({ seconds: { [OLD]: 30, [MEMO]: 61 } });
      const notes = new Map<string, string>();
      const result = yield* pass(tools, notes);
      expect(result.done).toEqual([]);
      expect(tools.calls.osw).toEqual([]);
      expect(notes.size).toBe(0);
      const ledger = (yield* Effect.promise(() => readLedger(state)))!;
      expect(ledger.since).toBe("2026-11-01T00:00:00+11:00");
      expect(ledger.recordings[MEMO]).toMatchObject({ state: "in-journal", journalDate: "2026-11-01" });
      expect(ledger.recordings[OLD]).toBeUndefined();
    }));

  it.live("records a failure, tries again later, and tells firstmate at once when trying again cannot help", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      const notes = new Map<string, string>();
      const failing = fakeTools({ seconds: { [EVENING]: 61 }, osw: new TranscribeFailed({ message: "OpenSuperWhisper had not finished it after 10 minutes" }) });
      expect((yield* pass(failing, notes)).failed).toEqual([EVENING]);
      expect((yield* Effect.promise(() => readLedger(state)))!.recordings[EVENING]).toMatchObject({ state: "failed", attempts: 1, lasting: false });
      expect(notes.size).toBe(0);
      // Not again within 15 minutes.
      yield* pass(failing, notes);
      expect(failing.calls.osw).toHaveLength(1);
      expect(existsSync(join(journals, "raw"))).toBe(false);

      const lasting = fakeTools({ seconds: { [EVENING]: 61 }, osw: new TranscribeFailed({ message: "OpenSuperWhisper is set to its whisper engine", lasting: true }) });
      yield* Effect.promise(() => rm(state, { recursive: true }));
      yield* pass(lasting, notes);
      expect([...notes.keys()]).toEqual(["voice-journal-failed-20261102-193005-CCCC3333-1"]);
      expect(notes.get("voice-journal-failed-20261102-193005-CCCC3333-1")).toContain("could not be transcribed: OpenSuperWhisper is set to its whisper engine");
    }));

  it.live("does nothing but tell firstmate, once a day, when it may not list Voice Memos' folder", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      yield* Effect.promise(() => chmod(recordings, 0o000));
      const notes = new Map<string, string>();
      const result = yield* voiceJournalRun({ recordings, journals, state, launcher: "/opt/sample/life-archive-voice-journal", arrivingWaitMs: 0 }).pipe(
        Effect.provide(Layer.mergeAll(fakeTools({ seconds: {} }).layer, fakeNotifier(notes))),
      );
      expect(result.noAccess).toBe(true);
      const [[id, text]] = [...notes];
      expect(id).toMatch(/^voice-journal-no-access-\d{4}-\d{2}-\d{2}$/);
      expect(text).toContain("paste /opt/sample/life-archive-voice-journal");
    }));

  it.live("says what it would do on a dry run, and writes nothing", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recording(EVENING));
      const lines: string[] = [];
      const tools = fakeTools({ seconds: { [EVENING]: 61 } });
      yield* voiceJournalRun({ recordings, journals, state, since: Date.parse(SINCE), dryRun: true, log: (line) => lines.push(line), arrivingWaitMs: 0 }).pipe(
        Effect.provide(Layer.mergeAll(tools.layer, fakeNotifier(new Map()))),
      );
      expect(lines).toContain("dry run: would transcribe 20261102 193005-CCCC3333.m4a (1:01) into raw/2026-11-02/ as 1930-voice");
      expect(existsSync(state)).toBe(false);
      expect(existsSync(journals)).toBe(false);
      expect(tools.calls.osw).toEqual([]);
    }));
});

describe("a recording's time and day", () => {
  it("is the night before's until 06:00", () => {
    expect(moment(Date.parse("2026-11-01T14:44:48Z"))).toMatchObject({ journalDate: "2026-11-01", day: "2026-11-02", hhmm: "0144", zone: "AEDT", nightBefore: true });
    expect(moment(Date.parse("2026-11-02T06:00:00+11:00"))).toMatchObject({ journalDate: "2026-11-02", hhmm: "0600", nightBefore: false });
    expect(moment(Date.parse("2026-07-01T05:59:00+10:00"))).toMatchObject({ journalDate: "2026-06-30", zone: "AEST", iso: "2026-07-01T05:59:00+10:00" });
  });

  it("files a recording by the clock whatever digits the locale writes", async () => {
    vi.resetModules();
    const { setClock } = await import("../../../../sdk/testing.ts");
    setClock({ timeZone: "Australia/Melbourne", locale: "ar-EG" });
    const recordings = await import("./recordings.ts");
    expect(recordings.moment(Date.parse("2026-11-01T14:44:48Z"))).toMatchObject({ journalDate: "2026-11-01", time: "01:44", hhmm: "0144", nightBefore: true });
  });

  it("is read from the recording's name, the phone's clock, when Voice Memos' index has none", () => {
    expect(startFromName(MEMO)).toBe(Date.parse("2026-11-02T01:44:48+11:00"));
    expect(startFromName("not a memo.m4a")).toBeNull();
  });

  it("is said as a clock says a length", () => {
    expect(formatLength(2136.02)).toBe("35:36");
    expect(formatLength(3.43)).toBe("0:03");
    expect(formatLength(8431.9)).toBe("2:20:32");
  });
});

describe("whether a recording has arrived", () => {
  const now = Date.parse("2026-11-02T03:00:00+11:00");
  const facts = { startedAt: now - 3_600_000, seconds: 600, title: null, cloudDate: null, deleted: false };
  const base = { size: 1000, mtimeMs: now - 120_000, now, probedSeconds: 600, facts, waitingSince: null };

  it("has when it is whole, settled and as long as Voice Memos says", () => {
    expect(readiness(base)).toEqual({ ready: true, doubt: null });
    expect(readiness({ ...base, facts: undefined })).toEqual({ ready: true, doubt: null });
  });

  it("has not while empty, changing, unreadable, unlisted or short", () => {
    expect(readiness({ ...base, size: 0 })).toMatchObject({ ready: false });
    expect(readiness({ ...base, mtimeMs: now - 5_000 })).toMatchObject({ ready: false });
    expect(readiness({ ...base, probedSeconds: null })).toMatchObject({ ready: false });
    expect(readiness({ ...base, facts: null })).toMatchObject({ ready: false });
    expect(readiness({ ...base, probedSeconds: 590 })).toMatchObject({ ready: false });
    // Within a second or two (or 1%) of Voice Memos' length is whole.
    expect(readiness({ ...base, probedSeconds: 598.5 })).toMatchObject({ ready: true });
  });

  it("is taken anyway, its doubt said, once it has sat unchanged for six hours shorter than Voice Memos lists, but never while unlisted", () => {
    expect(readiness({ ...base, probedSeconds: 590, waitingSince: now - 6 * 3_600_000 })).toEqual({ ready: true, doubt: "it is 9:50 of the 10:00 Voice Memos lists" });
    // Voice Memos drops the row of one it erased for good: a file it no longer lists may be one the captain deleted.
    expect(readiness({ ...base, facts: null, waitingSince: now - 30 * 24 * 3_600_000 })).toMatchObject({ ready: false });
    expect(readiness({ ...base, probedSeconds: null, waitingSince: now - 6 * 3_600_000 })).toMatchObject({ ready: false });
  });
});

describe("punctuation", () => {
  it("reads sentences as punctuated and a run-on as not, and a few words as either", () => {
    expect(punctuated(SENTENCES)).toBe(true);
    expect(punctuated(RUN_ON)).toBe(false);
    expect(punctuated("hello there")).toBe(true);
  });
});

describe("the ledger's place", () => {
  it("is taken over once from where it was before the journal was a module, the old file left, and a dry run only says so", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "journal-data-"));
    try {
      expect(await takeOverLedger(dataDir)).toBeNull();
      const before = join(dataDir, STATE_FOLDER_BEFORE);
      const ledger = { version: 1 as const, since: SINCE, recordings: { [MEMO]: { state: "in-journal" as const, journalDate: "2026-11-01", at: SINCE } } };
      await saveLedger(before, ledger);
      // A dry run copies nothing, and reads the old ledger where it is.
      expect(await takeOverLedger(dataDir, { dryRun: true })).toEqual({ said: expect.stringMatching(/^dry run: would take the ledger over from .*voice-journal\/ledger\.json/), state: before });
      expect(await readLedger(join(dataDir, STATE_FOLDER))).toBeNull();
      expect(await takeOverLedger(dataDir)).toEqual({ said: expect.stringMatching(/^took the ledger over from .*voice-journal\/ledger\.json into .*modules\/journal /), state: join(dataDir, STATE_FOLDER) });
      expect(await readLedger(join(dataDir, STATE_FOLDER))).toEqual(ledger);
      expect(await readLedger(before)).toEqual(ledger);
      // Done once: a ledger in the module's folder is never written over.
      expect(await takeOverLedger(dataDir)).toBeNull();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

const hasClang = spawnSync("/usr/bin/clang", ["--version"]).status === 0;

describe("the launcher", () => {
  it.skipIf(!hasClang)("runs only node on the checkout's modules/journal/cli.ts run, and says it is the launcher", async () => {
    const repo = await mkdtemp(join(tmpdir(), "voice-journal-repo-"));
    const out = join(repo, "bin", "life-archive-voice-journal");
    try {
      await mkdir(join(repo, "modules", "journal"), { recursive: true });
      await writeFile(join(repo, "modules", "journal", "cli.ts"), `
        import { writeFileSync } from "node:fs";
        writeFileSync("ran.json", JSON.stringify({ args: process.argv.slice(2), launcher: process.env.LIFE_ARCHIVE_VOICE_JOURNAL_LAUNCHER }));
        process.exitCode = 4;
      `);
      expect(await buildLauncher({ node: process.execPath, repo, out })).toBe("built");
      expect(await buildLauncher({ node: process.execPath, repo, out })).toBe("unchanged");
      const ran = spawnSync(out, [], { cwd: tmpdir() });
      expect(ran.status).toBe(4);
      expect(JSON.parse(await readFile(join(repo, "ran.json"), "utf8"))).toEqual({ args: ["run"], launcher: out });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("is the program of a launchd agent that runs each day at 06:00, and not at load", () => {
    const text = plist({ node: "/home/sample/.vite-plus/bin/node", launcher: "/opt/sample/life-archive-voice-journal", repo: "/opt/life-archive", logFile: "/tmp/voice-journal.log" });
    expect(text).toContain("<key>Label</key><string>local.life-archive-voice-journal</string>");
    expect(text).toContain("<key>ProgramArguments</key><array><string>/opt/sample/life-archive-voice-journal</string></array>");
    expect(text).toContain("<key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>\n<key>RunAtLoad</key><false/>");
    expect(text).not.toContain("WatchPaths");
    expect(text).not.toContain("StartInterval<");
  });
});
