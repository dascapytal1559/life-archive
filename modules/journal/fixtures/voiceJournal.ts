// The journal module's made-up data (sdk/server.ts's ModuleFixtures), for `npm run testing-data` and the tests: a vault
// in the testing folder with one made-up voice journal transcribed into its Journals/ as a pass writes one (the
// recording's copy, both engines' transcripts and the journal-source-v1 record), the clean journal of its day and the
// cleaner's edit list as firstmate writes them, an older day written by hand with no sources, and the module's ledger
// with that recording done. The words are made up here, and the recording is a made-up sound (soft tones, no voice, a
// WAV so a browser plays it on the Journal page; Voice Memos' own are .m4a): no recording of anyone's is read, and
// nothing is transcribed.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addDays, dayKey, isoAt, LOCALE, settings, wallClock } from "../../../sdk/server.ts";
import { type Ledger, saveLedger, STATE_FOLDER } from "../jobs/voice-journal/ledger.ts";
import { moment, sourceIdOf, stemOf } from "../jobs/voice-journal/recordings.ts";
import { sourceRecord, transcriptText } from "../jobs/voice-journal/round.ts";

/** The made-up recording: made at 21:30 the evening before `now`'s day, named as Voice Memos names one. */
export function madeUpRecording(now: number): { name: string; startedAt: number; seconds: number; text: string; nemotron: string } {
  const startedAt = wallClock(addDays(dayKey(now), -1), "21:30");
  return {
    name: `${dayKey(startedAt).replaceAll("-", "")} 213000-ABCD1234.m4a`,
    startedAt,
    seconds: 24,
    text: "Okay, um, a made-up voice journal. The day went well, I think. The run was slow, like, really slow, along the river, and tomorrow starts early. Lunch with Ada and Bruno was the best part, at the, the Larder? Something like that.",
    nemotron: "Okay um a made-up voice journal the day went well I think the run was slow like really slow along the river and tomorrow starts early lunch with Ada and Bruno was the best part at the the larder something like that",
  };
}

/** A made-up sound `seconds` long, as a WAV (8 kHz, 8-bit, mono): a soft tone in bursts, like a voice's rhythm, no voice. */
export function madeUpSound(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const burst = Math.max(0, Math.sin(t * Math.PI * 2.6)) * Math.max(0, Math.sin(t * Math.PI * 0.37 + 1));
    const tone = Math.sin(2 * Math.PI * 196 * t) * 0.6 + Math.sin(2 * Math.PI * 294 * t) * 0.4;
    wav[44 + i] = 128 + Math.round(tone * burst * 40);
  }
  return wav;
}

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The clean journal of the recording's day, as firstmate writes one: an H1, a section a source with its italic line and the comment citing it. */
function cleanDay(day: string, weekday: string, sourceId: string): string {
  return [
    `# ${weekday} ${day}`,
    "",
    "## A slow run, then lunch",
    "",
    `*From the voice memo recorded 21:30. Verbatim in [raw/${day}](raw/${day}/); one guess in brackets.*`,
    "",
    "A made-up voice journal. The day went well, I think. The run was slow, really slow, along the river, and tomorrow starts early.",
    "",
    "Lunch with Ada and Bruno was the best part, at the [Larder?].",
    "",
    `<!-- sources: ${sourceId} -->`,
    "",
  ].join("\n");
}

/** The cleaner's edit list for the recording, as firstmate writes one beside its transcripts. */
function editList(day: string): string {
  return [
    `# Edits, ${day}, the voice memo recorded 21:30`,
    "",
    "- **Guess:** [Larder?]: OpenSuperWhisper heard \"the Larder?\", Nemotron \"the larder\".",
    "- **Cut:** fillers (um, like) and one repeated word (the, the).",
    "- **Cut:** \"Something like that.\" after the guess.",
    "",
  ].join("\n");
}

/** An older day written by hand in Obsidian: no sources, and the rest of what the page draws (a list, a task, a link, a wikilink). */
function handWrittenDay(day: string, weekday: string, later: string): string {
  return [
    `# ${weekday} ${day}`,
    "",
    "Written by hand, no recording. A quiet one.",
    "",
    "## Things to remember",
    "",
    "- Book the dentist, *again*.",
    "- Call home on the weekend.",
    "  - Ask about the **garden**.",
    "- [x] Water the plants",
    "- [ ] Return the library book",
    "",
    "> The easy runs make the hard ones possible.",
    "",
    `See [[${later}]] for how the run went. The route is on https://example.com/route.`,
    "",
  ].join("\n");
}

export async function writeMadeUpVoiceJournal(dataDir: string): Promise<void> {
  const { name, startedAt, seconds, text, nemotron } = madeUpRecording(Date.now());
  const m = moment(startedAt);
  const journals = join(dataDir, settings().vault.folder, "Journals");
  const assetName = `${stemOf(name)}.wav`;
  const asset = `assets/${m.journalDate}/voice-memos/${assetName}`;
  const audio = madeUpSound(seconds);
  await mkdir(join(journals, "assets", m.journalDate, "voice-memos"), { recursive: true });
  await writeFile(join(journals, asset), audio);
  const rawDir = join(journals, "raw", m.journalDate);
  await mkdir(rawDir, { recursive: true });
  const base = `${m.hhmm}-voice`;
  const oswFile = `${base}-transcript-osw.md`;
  const nemotronFile = `${base}-transcript-nemotron.md`;
  const header = { moment: m, title: null, seconds, asset };
  const transcript = transcriptText({ ...header, tool: "OpenSuperWhisper", transcript: { text, engine: "OpenSuperWhisper 0.1.0, Parakeet TDT 0.6B v3 (FluidAudio), on this Mac" } });
  await writeFile(join(rawDir, oswFile), transcript);
  await writeFile(join(rawDir, nemotronFile), transcriptText({
    ...header, tool: "Nemotron 3.5 Transcribe", remark: "came back without punctuation, asked twice",
    transcript: { text: nemotron, engine: "Nemotron 3.5 Transcribe, on this Mac" },
  }));
  const sourceFile = `${base}.source.json`;
  const record = sourceRecord({
    recording: { name, path: join(dataDir, "made-up-recordings", name), size: audio.length, mtimeMs: startedAt + seconds * 1000, birthtimeMs: startedAt + 120_000 },
    facts: null,
    startedAt,
    seconds,
    moment: m,
    rawFile: oswFile,
    rawSha256: sha(transcript),
    relatedFiles: [nemotronFile, `../../${asset}`],
    audioSha256: sha(audio),
    notes: "Made-up testing data (the journal module's fixtures): nothing was recorded or transcribed; the words are made up.",
  });
  await writeFile(join(rawDir, sourceFile), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(rawDir, `${base}-edits.md`), editList(m.journalDate));
  const weekday = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(LOCALE, { weekday: "long", timeZone: "UTC" });
  await writeFile(join(journals, `${m.journalDate}.md`), cleanDay(m.journalDate, weekday(m.journalDate), sourceIdOf(name)));
  const older = addDays(m.journalDate, -3);
  await writeFile(join(journals, `${older}.md`), handWrittenDay(older, weekday(older), m.journalDate));
  const ledger: Ledger = {
    version: 1,
    since: isoAt(startedAt - 3_600_000),
    recordings: { [name]: { state: "done", journalDate: m.journalDate, files: [oswFile, nemotronFile, sourceFile], noted: true, at: isoAt(startedAt + 600_000) } },
  };
  await saveLedger(join(dataDir, STATE_FOLDER), ledger);
}
