import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPromise } from "../effectRuntime.ts";
import { backupTargets } from "./nasBackup.ts";
import {
  CAPTURE_STATUS_FILE, captureTranscripts, checkTranscripts, isSecretName, readCaptureStatus, type SourceIndex, type SourceResult, storedBytes, takeFile,
  type TranscriptSource, transcriptsLine, TRANSCRIPT_SOURCES, versionFile,
} from "./transcripts.ts";

let root: string;
let dataDir: string;
let tool: string;
let source: TranscriptSource;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-transcripts-"));
  dataDir = join(root, "data");
  await mkdir(dataDir);
  // An archive's folder as friend map's step left it: the core's database at its root.
  await writeFile(join(dataDir, "core.sqlite"), "");
  // A made-up tool's home: its sessions and history are taken, its sign-in and settings beside them never.
  tool = join(root, "home", ".agent");
  source = { name: "agent", about: "a made-up agent", root: tool, take: ["sessions", "history.jsonl"] };
  await put("auth.json", '{"token":"made-up"}');
  await put("settings.json", "{}");
});

afterEach(async () => {
  await chmod(join(tool, "sessions"), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, text: string, base = tool): Promise<void> {
  await mkdir(dirname(join(base, rel)), { recursive: true });
  await writeFile(join(base, rel), text);
}

/** One pass over the made-up sources, as the night's job runs it. */
async function pass(sources: TranscriptSource[] = [source], options: { dryRun?: boolean; now?: number; freeBytes?: () => Promise<number> } = {}): Promise<SourceResult[]> {
  const lines: string[] = [];
  const status = await runPromise(captureTranscripts({ dataDir, sources, log: (line) => lines.push(line), minFreeBytes: 0, ...options }));
  return status.sources;
}

const kept = (rel: string, version = 1, name = "agent") => versionFile(join(dataDir, "transcripts", name, rel), version);
const index = (name = "agent") => JSON.parse(readFileSync(join(dataDir, "transcripts", `${name}.json`), "utf8")) as SourceIndex;
const hasZstd = spawnSync("zstd", ["--version"]).status === 0;

describe("the transcripts' pass", () => {
  it("keeps each file compressed, and gives back its bytes exactly", async () => {
    await put("sessions/2026/10/rollout-1.jsonl", '{"made":"up"}\n'.repeat(500));
    await put("history.jsonl", '{"prompt":"a made-up prompt"}\n');
    const [result] = await pass();
    expect(result).toMatchObject({ new: 2, grown: 0, replaced: 0, same: 0, gone: 0, files: 2, problems: [] });
    expect(storedBytes(kept("sessions/2026/10/rollout-1.jsonl")).toString()).toBe('{"made":"up"}\n'.repeat(500));
    // Compressed: the repeated lines take far less than the 7,000 bytes written.
    expect((await stat(kept("sessions/2026/10/rollout-1.jsonl"))).size).toBeLessThan(200);
    expect(result.rawBytes).toBe(7000 + 30);
    if (hasZstd) expect(spawnSync("zstd", ["-dc", kept("history.jsonl")]).stdout.toString()).toBe('{"prompt":"a made-up prompt"}\n');
    // The index and the stored files alone: nothing temporary is left.
    expect((await readdir(join(dataDir, "transcripts"))).sort()).toEqual(["agent", "agent.json", "capture.json"]);
    expect(await readdir(join(dataDir, "transcripts", "agent"))).toEqual(["history.jsonl.zst", "sessions"]);
  });

  it("takes only the named folders and files, and never a secrets file inside them", async () => {
    await put("sessions/s.jsonl", "{}\n");
    await put("sessions/auth.json", '{"token":"made-up"}');
    await put("sessions/.credentials.json", '{"token":"made-up"}');
    await put("sessions/.claude.json", '{"account":"made-up"}');
    await put("sessions/secrets/key.txt", "made-up");
    await put("sessions/.env.local", "KEY=made-up");
    const [result] = await pass();
    expect(Object.keys(index().files)).toEqual(["sessions/s.jsonl"]);
    expect(result.secrets.sort()).toEqual(["sessions/.claude.json", "sessions/.credentials.json", "sessions/.env.local", "sessions/auth.json", "sessions/secrets"]);
    expect(existsSync(kept("auth.json"))).toBe(false);
    expect(existsSync(kept("settings.json"))).toBe(false);
    // The real sources name no tool's home whole, nor any secrets file.
    for (const s of TRANSCRIPT_SOURCES) for (const take of s.take) expect(take === "" || take === "." || isSecretName(take.split("/").at(-1)!)).toBe(false);
    expect(TRANSCRIPT_SOURCES.filter((s) => s.take.includes("*")).map((s) => s.name)).toEqual(["t3-usage-archive"]);
  });

  it("appends what a tool added as a frame of its own, leaving what is stored as it was", async () => {
    await put("sessions/s.jsonl", "one\n");
    await pass();
    const before = await readFile(kept("sessions/s.jsonl"));
    await appendFile(join(tool, "sessions/s.jsonl"), "two\n");
    const [grown] = await pass();
    expect(grown).toMatchObject({ grown: 1, new: 0, replaced: 0 });
    const after = await readFile(kept("sessions/s.jsonl"));
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(storedBytes(kept("sessions/s.jsonl")).toString()).toBe("one\ntwo\n");
    if (hasZstd) expect(spawnSync("zstd", ["-dc", kept("sessions/s.jsonl")]).stdout.toString()).toBe("one\ntwo\n");
    expect(index().files["sessions/s.jsonl"]).toMatchObject({ size: 8, versions: 1, stored: after.length });
    // Unchanged since: not read again.
    const [same] = await pass();
    expect(same).toMatchObject({ same: 1, read: 0 });
  });

  it("keeps a rewritten file's earlier bytes as a version beside the new", async () => {
    await put("sessions/s.jsonl", "one\ntwo\n");
    await pass();
    await put("sessions/s.jsonl", "ONE\n");
    expect((await pass())[0]).toMatchObject({ replaced: 1 });
    expect(storedBytes(kept("sessions/s.jsonl", 1)).toString()).toBe("one\ntwo\n");
    expect(storedBytes(kept("sessions/s.jsonl", 2)).toString()).toBe("ONE\n");
    expect(kept("sessions/s.jsonl", 2)).toMatch(/s\.jsonl\.changed-1\.zst$/);
    // The same length, other bytes, and an hour later: a third version.
    await put("sessions/s.jsonl", "uno\n");
    const later = new Date(Date.now() + 3_600_000);
    await utimes(join(tool, "sessions/s.jsonl"), later, later);
    expect((await pass())[0]).toMatchObject({ replaced: 1 });
    expect(index().files["sessions/s.jsonl"]).toMatchObject({ versions: 3, size: 4 });
    expect(storedBytes(kept("sessions/s.jsonl", 3)).toString()).toBe("uno\n");
  });

  it("keeps a rollout Codex rewrote to .jsonl.zst in both forms, the .jsonl marked gone", async () => {
    await put("sessions/rollout-1.jsonl", '{"made":"up"}\n');
    await pass(undefined, { now: Date.parse("2026-10-20T06:00:00+11:00") });
    // Codex compresses a quiet rollout in place: the .jsonl goes, a .jsonl.zst of the same bytes comes.
    await writeFile(join(tool, "sessions/rollout-1.jsonl.zst"), spawnSync("zstd", ["-q", "-c"], { input: '{"made":"up"}\n' }).stdout ?? "");
    await rm(join(tool, "sessions/rollout-1.jsonl"));
    const [result] = await pass(undefined, { now: Date.parse("2026-10-21T06:00:00+11:00") });
    expect(result).toMatchObject({ new: 1, gone: 1, files: 2, goneTotal: 1 });
    expect(index().files["sessions/rollout-1.jsonl"].goneAt).toBe("2026-10-20T19:00:00.000Z");
    expect(storedBytes(kept("sessions/rollout-1.jsonl")).toString()).toBe('{"made":"up"}\n');
    expect(storedBytes(kept("sessions/rollout-1.jsonl.zst")).equals(await readFile(join(tool, "sessions/rollout-1.jsonl.zst")))).toBe(true);
  });

  it("keeps a file its tool deleted, and takes it up again if it comes back", async () => {
    await put("sessions/s.jsonl", "one\n");
    await pass();
    await rm(join(tool, "sessions"), { recursive: true });
    expect((await pass())[0]).toMatchObject({ gone: 1, files: 1, goneTotal: 1 });
    expect(storedBytes(kept("sessions/s.jsonl")).toString()).toBe("one\n");
    // Gone already: not counted again.
    expect((await pass())[0]).toMatchObject({ gone: 0, goneTotal: 1 });
    await put("sessions/s.jsonl", "one\ntwo\n");
    expect((await pass())[0]).toMatchObject({ grown: 1, goneTotal: 0 });
    expect(index().files["sessions/s.jsonl"].goneAt).toBeUndefined();
  });

  it("cuts back a frame a pass cut short left before it appends", async () => {
    await put("sessions/s.jsonl", "one\n");
    await pass();
    const before = await readFile(kept("sessions/s.jsonl"));
    // A pass stopped after appending a frame and before saving the index.
    await appendFile(kept("sessions/s.jsonl"), spawnSync("zstd", ["-q", "-c"], { input: "half\n" }).stdout ?? Buffer.from("x"));
    await appendFile(join(tool, "sessions/s.jsonl"), "two\n");
    await pass();
    expect(storedBytes(kept("sessions/s.jsonl")).toString()).toBe("one\ntwo\n");
    expect((await readFile(kept("sessions/s.jsonl"))).subarray(0, before.length).equals(before)).toBe(true);
  });

  it("says a folder it cannot read, takes the rest, and marks nothing in it gone", async () => {
    if (process.getuid?.() === 0) return;
    await put("sessions/a/s.jsonl", "one\n");
    await put("history.jsonl", "one\n");
    await pass();
    await chmod(join(tool, "sessions"), 0o000);
    await appendFile(join(tool, "history.jsonl"), "two\n");
    const [result] = await pass();
    expect(result.problems).toEqual(["sessions/: EACCES"]);
    expect(result).toMatchObject({ grown: 1, gone: 0, goneTotal: 0 });
    const status = await readCaptureStatus(dataDir);
    expect(transcriptsLine(status, Date.parse(status!.finishedAt) + 3_600_000)).toMatch(/1 file it could not read: agent: sessions\/: EACCES$/);
  });

  it("writes nothing in a dry run, and says what it would take", async () => {
    await put("sessions/s.jsonl", "one\n");
    expect((await pass(undefined, { dryRun: true }))[0]).toMatchObject({ new: 1, read: 0 });
    expect(existsSync(join(dataDir, "transcripts"))).toBe(false);
    await pass();
    await appendFile(join(tool, "sessions/s.jsonl"), "two\n");
    expect((await pass(undefined, { dryRun: true }))[0]).toMatchObject({ grown: 1 });
    expect(storedBytes(kept("sessions/s.jsonl")).toString()).toBe("one\n");
  });

  it("takes a SQLite store as a checked copy, again only when it changed", async () => {
    const dbFile = join(root, "home", "store", "threads.db");
    await mkdir(dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE thread (id INTEGER PRIMARY KEY, title TEXT)");
    db.prepare("INSERT INTO thread (title) VALUES (?)").run("a made-up thread");
    const store: TranscriptSource = { name: "store", about: "a made-up store", root: dirname(dbFile), take: ["threads.db"], databases: ["threads.db"] };
    try {
      expect((await pass([store]))[0]).toMatchObject({ new: 1, files: 1 });
      expect((await pass([store]))[0]).toMatchObject({ same: 1, read: 0 });
      db.prepare("INSERT INTO thread (title) VALUES (?)").run("another made-up thread");
      expect((await pass([store]))[0]).toMatchObject({ replaced: 1 });
    } finally {
      db.close();
    }
    // Each version a whole database, restored with zstd -d.
    const restored = join(root, "restored.db");
    for (const [version, threads] of [[1, 1], [2, 2]]) {
      await writeFile(restored, storedBytes(kept("threads.db", version, "store")));
      const back = new DatabaseSync(restored, { readOnly: true });
      expect(back.prepare("SELECT count(*) AS n FROM thread").get()).toEqual({ n: threads });
      back.close();
    }
    // No copy is left in the staging folder.
    expect(await readdir(join(dataDir, "backups", "transcripts"))).toEqual([]);
  });

  it("does not look at a source taken once again", async () => {
    await put("sessions/s.jsonl", "one\n");
    const once = { ...source, once: true };
    expect((await pass([once]))[0]).toMatchObject({ new: 1 });
    await appendFile(join(tool, "sessions/s.jsonl"), "two\n");
    expect((await pass([once]))[0]).toMatchObject({ skipped: "once", grown: 0, files: 1 });
    expect(index().takenOnceAt).toBeDefined();
  });

  it("says a tool not on this Mac, and keeps what it took of it", async () => {
    await put("sessions/s.jsonl", "one\n");
    await pass();
    await rm(tool, { recursive: true });
    expect((await pass())[0]).toMatchObject({ skipped: "not there", files: 1, goneTotal: 0 });
  });

  it("takes the transcripts from an archive's folder before friend map's move too, and refuses a folder with no archive", async () => {
    await rm(join(dataDir, "core.sqlite"));
    const none = await runPromise(Effect.flip(captureTranscripts({ dataDir, sources: [source], minFreeBytes: 0 })));
    expect(none.message).toMatch(/there is no archive in .* \(no core.sqlite\)/);
    // archive.sqlite at its root, as before the move: nothing here reads it, so the pass runs.
    await writeFile(join(dataDir, "archive.sqlite"), "");
    await put("sessions/one.jsonl", "{}\n");
    expect((await pass())[0]).toMatchObject({ files: 1 });
  });

  it("refuses to fill the disk, and runs one pass at a time", async () => {
    const error = await runPromise(Effect.flip(captureTranscripts({ dataDir, sources: [source], minFreeBytes: 1e18 })));
    expect(error.message).toMatch(/free, under the/);
    await mkdir(join(dataDir, "backups", "transcripts"), { recursive: true });
    await writeFile(join(dataDir, "backups", "transcripts", ".lock"), String(process.pid));
    const held = await runPromise(Effect.flip(captureTranscripts({ dataDir, sources: [source], minFreeBytes: 0 })));
    expect(held.message).toMatch(/another transcripts' pass is running/);
  });

  it("reads back every file kept, against its index and its tool's file", async () => {
    await put("sessions/s.jsonl", "one\n");
    await put("sessions/t.jsonl", "two\n");
    await pass();
    await appendFile(join(tool, "sessions/s.jsonl"), "more\n");
    await pass();
    expect(await runPromise(checkTranscripts({ dataDir, sources: [source] }))).toEqual({ ok: 2, matchOriginal: 2, bad: [] });
    // A stored file damaged: said.
    await writeFile(kept("sessions/t.jsonl"), spawnSync("zstd", ["-q", "-c"], { input: "TWO\n" }).stdout ?? "x");
    const damaged = await runPromise(checkTranscripts({ dataDir, sources: [source] }));
    expect(damaged.bad).toHaveLength(1);
  });

  it("is in the NAS's nightly snapshot of the archive's folder", async () => {
    await put("sessions/s.jsonl", "one\n");
    await pass();
    const { targets } = await backupTargets(dataDir, []);
    expect(targets).toContain("../../transcripts");
    // Its lock and database copies are in backups/, which the snapshot leaves out.
    expect(targets.some((t) => t.includes("backups"))).toBe(false);
    expect(JSON.parse(await readFile(join(dataDir, CAPTURE_STATUS_FILE), "utf8")).sources[0]).toMatchObject({ name: "agent", files: 1 });
  });
});

describe("OpenSuperWhisper's dictations", () => {
  let app: string;
  let dictations: TranscriptSource;
  let db: DatabaseSync;
  const wav = (n: number) => Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * (n + 3) + (i >> 3) * n) % 251));
  const recording = (id: string, n: number) => put(`recordings/${id}.wav`, wav(n));
  const kept = (rel: string, version = 1) => versionFile(join(dataDir, "transcripts", "opensuperwhisper", rel), version);
  const index = () => JSON.parse(readFileSync(join(dataDir, "transcripts", "opensuperwhisper.json"), "utf8")) as SourceIndex;

  beforeEach(async () => {
    // The app's folder as it is kept: recordings, their database, and the model's weights beside them.
    app = join(root, "home", "ru.starmel.OpenSuperWhisper");
    const real = TRANSCRIPT_SOURCES.find((s) => s.name === "opensuperwhisper")!;
    dictations = { ...real, root: app };
    await recording("11111111-aaaa", 1);
    await recording("22222222-bbbb", 2);
    await put("whisper-models/ggml-made-up.bin", "weights".repeat(1000), app);
    db = new DatabaseSync(join(app, "recordings.sqlite"));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE recording (id TEXT PRIMARY KEY, transcription TEXT)");
    db.prepare("INSERT INTO recording VALUES (?, ?)").run("11111111-aaaa", "a made-up dictation");
  });
  afterEach(() => db.close());

  async function put(rel: string, body: string | Buffer, base = app): Promise<void> {
    await mkdir(dirname(join(base, rel)), { recursive: true });
    await writeFile(join(base, rel), body);
  }

  it("is the real source's shape: recordings and their database, never the model", () => {
    expect(TRANSCRIPT_SOURCES.find((s) => s.name === "opensuperwhisper")).toMatchObject({
      root: expect.stringMatching(/Library\/Application Support\/ru\.starmel\.OpenSuperWhisper$/), take: ["recordings", "recordings.sqlite"], databases: ["recordings.sqlite"],
    });
  });

  it("takes each recording whole and the database as a checked copy, and never the models", async () => {
    const [first] = await pass([dictations]);
    expect(first).toMatchObject({ new: 3, files: 3, problems: [], links: 0 });
    expect(Object.keys(index().files).sort()).toEqual(["recordings.sqlite", "recordings/11111111-aaaa.wav", "recordings/22222222-bbbb.wav"]);
    expect(existsSync(join(dataDir, "transcripts", "opensuperwhisper", "whisper-models"))).toBe(false);
    expect(storedBytes(kept("recordings/22222222-bbbb.wav")).equals(wav(2))).toBe(true);
    // A new recording is taken; the others, and the database when it did not change, are not read again.
    await recording("33333333-cccc", 3);
    expect(await pass([dictations])).toMatchObject([{ new: 1, same: 3, read: 4000, files: 4 }]);
    // The database changed: a version beside, the earlier kept, each a whole database.
    db.prepare("INSERT INTO recording VALUES (?, ?)").run("33333333-cccc", "another made-up dictation");
    expect((await pass([dictations]))[0]).toMatchObject({ replaced: 1, same: 3, new: 0 });
    // (the three recordings; the database is the one replaced)
    const restored = join(root, "restored.sqlite");
    for (const [version, rows] of [[1, 1], [2, 2]]) {
      await writeFile(restored, storedBytes(kept("recordings.sqlite", version)));
      const back = new DatabaseSync(restored, { readOnly: true });
      expect(back.prepare("SELECT count(*) AS n FROM recording").get()).toEqual({ n: rows });
      back.close();
      await rm(restored);
    }
    expect(await runPromise(checkTranscripts({ dataDir, sources: [dictations] }))).toEqual({ ok: 4, matchOriginal: 3, bad: [] });
    // The staging folder holds no database copy afterwards.
    expect(await readdir(join(dataDir, "backups", "transcripts"))).toEqual([]);
  });

  it("keeps a recording the app deleted, marked gone, and a symbolic link in the folder is left alone", async () => {
    await pass([dictations], { now: Date.parse("2026-11-08T06:00:00+11:00") });
    await rm(join(app, "recordings/11111111-aaaa.wav"));
    await symlink(join(app, "recordings/22222222-bbbb.wav"), join(app, "recordings/linked.wav"));
    const [result] = await pass([dictations], { now: Date.parse("2026-11-09T06:00:00+11:00") });
    expect(result).toMatchObject({ gone: 1, goneTotal: 1, links: 1, files: 3, new: 0 });
    expect(index().files["recordings/11111111-aaaa.wav"].goneAt).toBe("2026-11-08T19:00:00.000Z");
    expect(storedBytes(kept("recordings/11111111-aaaa.wav")).equals(wav(1))).toBe(true);
    expect(existsSync(kept("recordings/linked.wav"))).toBe(false);
  });

  it("stops a pass that would fill the disk, keeps what it took, and carries on at the next", async () => {
    await recording("33333333-cccc", 3);
    // Room for the start's check and the first recording, not the second: 3,000 bytes less at each look.
    let free = 13_000;
    const filling = async () => (free -= 3000) + 3000;
    const stopped = await runPromise(Effect.flip(captureTranscripts({ dataDir, sources: [dictations], minFreeBytes: 5000, freeBytes: filling })));
    expect(stopped.message).toMatch(/^stopped at opensuperwhisper\/recordings\/22222222-bbbb\.wav: this Mac has .* free, under the .*; what was taken is kept, and the next pass carries on$/);
    // The first recording (recordings/11111111-aaaa.wav) is kept and indexed; no half-written file is left.
    expect(Object.keys(index().files)).toEqual(["recordings/11111111-aaaa.wav"]);
    expect(await readdir(join(dataDir, "transcripts", "opensuperwhisper", "recordings"))).toEqual(["11111111-aaaa.wav.zst"]);
    // Room again: the rest is taken, the first not read again, and everything reads back.
    expect((await pass([dictations]))[0]).toMatchObject({ new: 3, same: 1, files: 4, problems: [] });
    expect(await runPromise(checkTranscripts({ dataDir, sources: [dictations] }))).toMatchObject({ ok: 4, bad: [] });
  });

  it("starts again cleanly after a pass killed between a recording's file and its index", async () => {
    await pass([dictations]);
    // Killed after 22222222-bbbb was stored and before the index was saved: its entry is not there, and a partial file is.
    const saved = index();
    delete saved.files["recordings/22222222-bbbb.wav"];
    await writeFile(join(dataDir, "transcripts", "opensuperwhisper.json"), JSON.stringify(saved));
    await writeFile(`${kept("recordings/33333333-cccc.wav")}.partial`, "half a frame");
    await recording("33333333-cccc", 3);
    expect((await pass([dictations]))[0]).toMatchObject({ new: 2, same: 2, files: 4, problems: [] });
    expect(await readdir(join(dataDir, "transcripts", "opensuperwhisper", "recordings"))).toEqual(["11111111-aaaa.wav.zst", "22222222-bbbb.wav.zst", "33333333-cccc.wav.zst"]);
    expect(await runPromise(checkTranscripts({ dataDir, sources: [dictations] }))).toMatchObject({ ok: 4, bad: [] });
  });
});

describe("one file's step", () => {
  it("never reads a file whose size and time are as recorded", async () => {
    const file = join(root, "s.jsonl");
    await writeFile(file, "one\n");
    const first = await takeFile(file, join(root, "kept", "s.jsonl"), undefined);
    expect(first).toMatchObject({ outcome: "new", read: 4 });
    expect(await takeFile(file, join(root, "kept", "s.jsonl"), first.entry)).toMatchObject({ outcome: "same", read: 0 });
  });
});

describe("the storage report's line", () => {
  it("says when the last pass was, what is kept, and two days without one", () => {
    expect(transcriptsLine(null, 0)).toMatch(/none taken yet/);
    const finishedAt = "2026-10-26T19:00:00.000Z";
    const sourceResult = { name: "agent", root: "", new: 1, grown: 0, replaced: 0, same: 0, gone: 0, read: 4, files: 3, goneTotal: 1, rawBytes: 3e9, storedBytes: 1.2e9, links: 0, secrets: [], problems: [] };
    const status = { startedAt: finishedAt, finishedAt, sources: [sourceResult] };
    expect(transcriptsLine(status, Date.parse(finishedAt) + 5 * 3_600_000)).toBe(
      "LLM transcripts: last taken 2026-10-26T19:00:00.000Z (5 hours ago), 3 files from 1 tools (1 since deleted by them), 3.0 GB as written in 1.2 GB",
    );
    expect(transcriptsLine(status, Date.parse(finishedAt) + 3 * 86_400_000)).toMatch(/3 days ago, overdue/);
  });
});
