import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { writeInstagramZip } from "../../fixtures/instagram-dyi.ts";
import { exportFiles as messengerExportFiles } from "../../fixtures/messenger.ts";
import { ArchiveCommands, archiveCommandsLayer, Notifier, RunFailed, writeZip } from "../../../../sdk/server.ts";
import { openArchive } from "../../server/db.ts";
import { type AgentRun, CuaSpace, exportRound, readState, roundDue, type Schedule, SHARED, writeState } from "./round.ts";

const CLI = fileURLToPath(new URL("../../../../server/archive/cli.ts", import.meta.url));
// 2026-10-21, midday in Melbourne.
const NOW = Date.parse("2026-10-21T12:00:00+11:00");
const ZIP = "instagram-ada_sample-2026-10-21-1.zip";

let dataDir: string;
let downloads: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cua-exports-data-"));
  downloads = await mkdtemp(join(tmpdir(), "cua-exports-downloads-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
});

/** The Space: its folder of the Cua Volume in memory, its Downloads a folder here, its runs a list that a round joins. */
function fakeSpace(volume: Map<string, string>, writes: string[] = [], runs: AgentRun[] = []) {
  return Layer.succeed(CuaSpace, {
    space: "local:space-sample",
    read: (name: string) => Effect.succeed(volume.get(name) ?? null),
    write: (name: string, text: string) => Effect.sync(() => void (volume.set(name, text), writes.push(name))),
    copyOut: (name: string, to: string) =>
      Effect.tryPromise({ try: () => copyFile(join(downloads, name), to), catch: (error) => new RunFailed({ message: (error as Error).message }) }),
    removeDownload: (name: string) => Effect.promise(() => rm(join(downloads, name))),
    runs: Effect.sync(() => [...runs]),
    startRound: Effect.sync(() => {
      const id = `run-sample-${runs.length + 1}`;
      runs.push({ id, alive: true, failed: false });
      return id;
    }),
  });
}

const DAILY: Schedule = { at: "10:00", enabled: true, model: "gpt-sample" };

/** firstmate's inbox, which takes a note with an id it has had once only. */
function fakeNotifier(notes: Map<string, string>) {
  return Layer.succeed(Notifier, { note: (id: string, text: string) => Effect.sync(() => void (notes.has(id) || notes.set(id, text))) });
}

/** Archive commands that must not run. */
const noArchive = Layer.succeed(ArchiveCommands, {
  coversTo: Effect.succeed({}),
  archive: (args: string[]) => Effect.die(`archive ${args.join(" ")} should not run`),
  checkData: Effect.die("check-data should not run"),
});

const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const events = (...lines: object[]) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

describe("exportRound", () => {
  it.live("notes each new event once, takes a downloaded export into the archive's folder, imports it, and plans the next round", () =>
    Effect.gen(function* () {
      // A scratch archive that imports Instagram, and a made-up Instagram download in the Space.
      openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite")).close();
      yield* Effect.promise(() => promisify(execFile)(process.execPath, ["--no-warnings", CLI, "enable", "instagram-dyi", "--data", dataDir]));
      yield* Effect.promise(() => writeInstagramZip(join(downloads, ZIP)));
      const file = { name: ZIP, bytes: (yield* Effect.promise(() => stat(join(downloads, ZIP)))).size, sha256: yield* Effect.promise(() => sha256(join(downloads, ZIP))) };
      const volume = new Map<string, string>([[SHARED.events, events(
        { id: "event-requested-1", at: "2026-10-20T23:00:00Z", kind: "requested", platform: "instagram", from: "2026-10-13", to: "2026-10-21" },
        { id: "event-stop-0001", at: "2026-10-20T23:05:00Z", kind: "needs-user", platform: "facebook", stop: "password", detail: "the dialog after Start export" },
        { id: "event-downloaded", at: "2026-10-21T00:30:00Z", kind: "downloaded", platform: "instagram", files: [file] },
        { id: "event-round-0001", at: "2026-10-21T00:40:00Z", kind: "round" },
      )]]);
      const writes: string[] = [];
      const notes = new Map<string, string>();
      const layer = Layer.mergeAll(fakeSpace(volume, writes), archiveCommandsLayer(dataDir), fakeNotifier(notes));

      const result = yield* exportRound({ dataDir, now: NOW }).pipe(Effect.provide(layer));

      expect([...notes.keys()]).toEqual(["cua-exports-event-requested-1", "cua-exports-event-stop-0001", "cua-exports-event-downloaded"]);
      expect(notes.get("cua-exports-event-stop-0001")).toMatch(/Facebook Messenger: the Cua Space's export round stopped for the captain: it needs the password typed again \(/);
      expect(notes.get("cua-exports-event-downloaded")).toMatch(
        /^\[life-archive cua-exports, automated\] Instagram messages: the export the Cua Space downloaded is imported, from platform-exports\/instagram\/2026-10-21 \(a backup was taken first\)\. Messages: [1-9]\d* new\. check-data /,
      );
      // The download is in its export folder, checked and unpacked, and gone from the Space.
      const folder = join(dataDir, "platform-exports", "instagram", "2026-10-21");
      expect(yield* Effect.promise(() => sha256(join(folder, ZIP)))).toBe(file.sha256);
      expect(yield* Effect.promise(() => readdir(folder))).toContain("your_instagram_activity");
      expect(existsSync(join(downloads, ZIP))).toBe(false);
      expect(result.imported).toEqual([expect.objectContaining({ platform: "instagram", folder: "platform-exports/instagram/2026-10-21", ok: true, detail: expect.stringMatching(/^Messages: \d+ new/) })]);
      expect((yield* Effect.promise(() => readdir(join(dataDir, "backups")))).some((name) => name.endsWith("-before-import-instagram-dyi.sqlite"))).toBe(true);
      // Next: Instagram a week after its request; Facebook, Messenger and Discord now (never imported, so All time for Facebook).
      expect(JSON.parse(volume.get(SHARED.plan)!)).toEqual({
        today: "2026-10-21",
        tasks: [{ platform: "facebook", do: "request", from: null, to: "2026-10-20" }, { platform: "messenger", do: "request" }, { platform: "discord", do: "request" }],
        next: [{ platform: "instagram", on: "2026-10-28" }],
      });

      // A second run finds nothing new: no note, no import, and the plan, unchanged, is not written again.
      const again = yield* exportRound({ dataDir, now: NOW + 15 * 60_000 }).pipe(Effect.provide(layer));
      expect(again.handled).toEqual([]);
      expect(notes.size).toBe(3);
      expect(writes).toEqual([SHARED.plan]);
      const state = yield* Effect.promise(() => readState(dataDir));
      expect(state.seen).toEqual(["event-requested-1", "event-stop-0001", "event-downloaded", "event-round-0001"]);
      expect(state.imports).toHaveLength(1);
    }), 120_000);

  it.live("takes Messenger's encrypted chats into their own folder beside Facebook's export of that day, unpacked, and imports them", () =>
    Effect.gen(function* () {
      openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite")).close();
      yield* Effect.promise(() => promisify(execFile)(process.execPath, ["--no-warnings", CLI, "enable", "messenger-export", "--data", dataDir]));
      // Facebook's export of the same day is in platform-exports/messenger/2026-10-21 already.
      const facebook = join(dataDir, "platform-exports", "messenger", "2026-10-21");
      yield* Effect.promise(async () => {
        await mkdir(facebook, { recursive: true });
        await writeFile(join(facebook, "facebook-ada_sample-2026-10-21-1.zip"), "a made-up export");
      });
      yield* Effect.promise(() => writeZip(join(downloads, "messages.zip"), messengerExportFiles()));
      const zip = join(downloads, "messages.zip");
      const file = { name: "messages.zip", bytes: (yield* Effect.promise(() => stat(zip))).size, sha256: yield* Effect.promise(() => sha256(zip)) };
      const volume = new Map<string, string>([[SHARED.events, events(
        { id: "event-requested-m", at: "2026-10-20T23:00:00Z", kind: "requested", platform: "messenger" },
        { id: "event-downloaded-m", at: "2026-10-20T23:20:00Z", kind: "downloaded", platform: "messenger", files: [file] },
      )]]);
      const notes = new Map<string, string>();
      const result = yield* exportRound({ dataDir, now: NOW }).pipe(Effect.provide(Layer.mergeAll(fakeSpace(volume), archiveCommandsLayer(dataDir), fakeNotifier(notes))));

      expect(result.imported).toEqual([expect.objectContaining({ platform: "messenger", folder: "platform-exports/messenger/2026-10-21-2", ok: true, detail: expect.stringMatching(/^Messages: [1-9]\d* new/) })]);
      const folder = join(dataDir, "platform-exports", "messenger", "2026-10-21-2");
      expect((yield* Effect.promise(() => readdir(folder))).sort()).toEqual(expect.arrayContaining(["messages.zip", "media"]));
      expect(existsSync(zip)).toBe(false);
      // Its request is not news: firstmate hears of the import.
      expect([...notes.keys()]).toEqual(["cua-exports-event-downloaded-m"]);
      expect(notes.get("cua-exports-event-downloaded-m")).toMatch(/^\[life-archive cua-exports, automated\] Messenger's encrypted chats: the export the Cua Space downloaded is imported, from platform-exports\/messenger\/2026-10-21-2/);
    }), 120_000);

  it.live("leaves a download whose copy is not the agent's in the Space, says so once, and tries it again next run", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeInstagramZip(join(downloads, ZIP)));
      const volume = new Map<string, string>([[SHARED.events, events(
        { id: "event-downloaded", at: "2026-10-21T00:30:00Z", kind: "downloaded", platform: "instagram", files: [{ name: ZIP, bytes: 10, sha256: "0".repeat(64) }] },
      )]]);
      const notes = new Map<string, string>();
      const layer = Layer.mergeAll(fakeSpace(volume), noArchive, fakeNotifier(notes));
      const lines: string[] = [];
      for (const minutes of [0, 15]) {
        const result = yield* exportRound({ dataDir, now: NOW + minutes * 60_000, log: (line) => lines.push(line) }).pipe(Effect.provide(layer));
        expect(result.handled).toEqual([]);
      }
      expect([...notes.keys()]).toEqual(["cua-exports-event-downloaded-not-taken"]);
      expect(lines).toContain(`instagram: ${ZIP} copied out of the Space is not the file the agent downloaded (its SHA-256 differs)`);
      expect(existsSync(join(downloads, ZIP))).toBe(true);
      expect(yield* Effect.promise(() => readdir(join(dataDir, "platform-exports", "instagram", "2026-10-21")))).toEqual([]);
      expect((yield* Effect.promise(() => readState(dataDir))).seen).toEqual([]);
    }));

  it.live("tells firstmate, once a day, when the agent has reported no round for two days while the schedule is on", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeState(dataDir, { space: "local:space-sample", schedule: DAILY, seen: [], imports: [], rounds: [] }));
      const volume = new Map<string, string>([[SHARED.events, events({ id: "event-round-0001", at: "2026-10-18T23:00:00Z", kind: "round" })]]);
      const notes = new Map<string, string>();
      const layer = Layer.mergeAll(fakeSpace(volume), noArchive, fakeNotifier(notes));
      yield* exportRound({ dataDir, now: Date.parse("2026-10-20T12:00:00+11:00") }).pipe(Effect.provide(layer));
      expect(notes.size).toBe(0);
      yield* exportRound({ dataDir, now: NOW }).pipe(Effect.provide(layer));
      yield* exportRound({ dataDir, now: NOW + 15 * 60_000 }).pipe(Effect.provide(layer));
      expect([...notes]).toEqual([["cua-exports-silent-2026-10-21", expect.stringMatching(/the Cua Space's export agent has not reported a round since 2026-10-19: Codex may be signed out in the Space/)]]);
      // Not while the schedule is off: then no round is expected.
      yield* Effect.promise(async () => writeState(dataDir, { ...(await readState(dataDir)), schedule: { ...DAILY, enabled: false } }));
      const quiet = new Map<string, string>();
      yield* exportRound({ dataDir, now: NOW + 86_400_000 }).pipe(Effect.provide(Layer.mergeAll(fakeSpace(volume), noArchive, fakeNotifier(quiet))));
      expect(quiet.size).toBe(0);
    }));

  it.live("refuses a line that is not an event, and acts on the rest", () =>
    Effect.gen(function* () {
      const volume = new Map<string, string>([[SHARED.events, `not json\n${events({ id: "event-round-0001", at: "2026-10-21T00:00:00Z", kind: "round" })}`]]);
      const lines: string[] = [];
      const result = yield* exportRound({ dataDir, now: NOW, log: (line) => lines.push(line), dryRun: true }).pipe(Effect.provide(Layer.mergeAll(fakeSpace(volume), noArchive, fakeNotifier(new Map()))));
      expect(result.refused).toEqual([{ line: 1, why: "not JSON" }]);
      expect(lines[0]).toBe("events.jsonl line 1 refused: not JSON");
      // A dry run writes nothing: no plan, no state.
      expect(volume.has(SHARED.plan)).toBe(false);
      expect(existsSync(join(dataDir, "platform-exports", ".cua-exports.json"))).toBe(false);
    }));

  it.live("starts the day's round once its time has come, once a day, and not while one is still running", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeState(dataDir, { space: "local:space-sample", schedule: DAILY, seen: [], imports: [], rounds: [] }));
      const volume = new Map<string, string>();
      const runs: AgentRun[] = [{ id: "run-older", alive: true, failed: false }];
      const layer = Layer.mergeAll(fakeSpace(volume, [], runs), noArchive, fakeNotifier(new Map()));
      const at = (time: string) => Date.parse(`2026-10-21T${time}:00+11:00`);
      // Before ten, nothing; at ten, a round is still running from before, so none yet; once it has ended, one starts.
      expect((yield* exportRound({ dataDir, now: at("09:45") }).pipe(Effect.provide(layer))).started).toBeNull();
      expect((yield* exportRound({ dataDir, now: at("10:00") }).pipe(Effect.provide(layer))).started).toBeNull();
      runs[0].alive = false;
      const started = (yield* exportRound({ dataDir, now: at("10:15") }).pipe(Effect.provide(layer))).started;
      expect(started).toEqual({ run: "run-sample-2", at: new Date(at("10:15")).toISOString(), why: "daily" });
      runs[1].alive = false;
      expect((yield* exportRound({ dataDir, now: at("10:30") }).pipe(Effect.provide(layer))).started).toBeNull();
      expect((yield* Effect.promise(() => readState(dataDir))).rounds).toEqual([started]);
    }));

  it.live("tells firstmate once when a round's run failed or ended without reporting its end", () =>
    Effect.gen(function* () {
      const rounds = [
        { run: "run-failed", at: "2026-10-20T23:00:00.000Z", why: "daily" as const },
        { run: "run-finished", at: "2026-10-20T23:30:00.000Z", why: "nudge" as const },
        { run: "run-unfinished", at: "2026-10-21T00:00:00.000Z", why: "nudge" as const },
        { run: "run-working", at: "2026-10-21T00:10:00.000Z", why: "nudge" as const },
      ];
      yield* Effect.promise(() => writeState(dataDir, { space: "local:space-sample", schedule: { ...DAILY, enabled: false }, seen: [], imports: [], rounds }));
      const volume = new Map<string, string>([[SHARED.events, events({ id: "event-round-0001", at: "2026-10-20T23:50:00Z", kind: "round" })]]);
      const runs: AgentRun[] = [
        { id: "run-failed", alive: false, failed: true },
        { id: "run-finished", alive: false, failed: false },
        { id: "run-unfinished", alive: false, failed: false },
        { id: "run-working", alive: true, failed: false },
      ];
      const notes = new Map<string, string>();
      const layer = Layer.mergeAll(fakeSpace(volume, [], runs), noArchive, fakeNotifier(notes));
      yield* exportRound({ dataDir, now: NOW }).pipe(Effect.provide(layer));
      yield* exportRound({ dataDir, now: NOW + 15 * 60_000 }).pipe(Effect.provide(layer));
      expect([...notes.keys()]).toEqual(["cua-exports-run-failed-ended", "cua-exports-run-unfinished-ended"]);
      expect(notes.get("cua-exports-run-failed-ended")).toMatch(/export round started 2026-10-21 10:00 failed before it finished \(Cua says the run failed/);
      expect(notes.get("cua-exports-run-unfinished-ended")).toMatch(/export round started 2026-10-21 11:00 ended without reporting its end/);
    }));
});

describe("roundDue", () => {
  const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+11:00`);
  it("is due from the schedule's time each day the schedule is on, until a daily round has started that day", () => {
    expect(roundDue(undefined, [], at("2026-10-21", "12:00"))).toBe(false);
    expect(roundDue({ ...DAILY, enabled: false }, [], at("2026-10-21", "12:00"))).toBe(false);
    expect(roundDue(DAILY, [], at("2026-10-21", "09:59"))).toBe(false);
    expect(roundDue(DAILY, [], at("2026-10-21", "10:00"))).toBe(true);
    const yesterday = { run: "run-1", at: new Date(at("2026-10-20", "10:00")).toISOString(), why: "daily" as const };
    expect(roundDue(DAILY, [yesterday], at("2026-10-21", "10:05"))).toBe(true);
    const today = { run: "run-2", at: new Date(at("2026-10-21", "10:05")).toISOString(), why: "daily" as const };
    expect(roundDue(DAILY, [yesterday, today], at("2026-10-21", "23:00"))).toBe(false);
    // A nudge earlier in the day does not take the daily round's place.
    expect(roundDue(DAILY, [{ ...today, why: "nudge" }], at("2026-10-21", "23:00"))).toBe(true);
  });
});
