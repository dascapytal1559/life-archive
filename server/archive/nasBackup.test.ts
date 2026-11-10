import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Fiber } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPromise } from "../effectRuntime.ts";
import { integrityCheck } from "./backups.ts";
import {
  ARCHIVE_EXCLUDES, backupSummary, backupTargets, findRestic, FolderRepository, forgetResult, initRepository, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, KeychainPasswordStore,
  LAUNCHD_LABEL, NAS_HOSTS, nasLine, NasRepository, newPassword, OTHER_FOLDERS, type PasswordStore, plist, reachNas, readNasStatus, recordNasFailure, REPOSITORY_PATH, Restic, runNasBackup, SNAPSHOT_TAG,
  STAGING, TRANSCRIPT_FOLDERS, TRANSCRIPTS_TAG, verifiedWhole, verifyNasBackup,
} from "./nasBackup.ts";
import { CALENDAR_FILE, openCalendar } from "../calendar/db.ts";
import { mirrorFolder } from "./nasMirror.ts";
import { ContentLog } from "./contentLog.ts";
import { TRANSCRIPTS_FOLDER } from "./transcripts.ts";

const DAY = 86_400_000;
/** Friend map's archive, in its module's folder: its path in the archive's folder, and in a snapshot. */
const FRIEND_MAP_DB = "modules/friend-map/archive.sqlite";
// 03:00 in Melbourne (UTC+11 in October).
const NIGHT = Date.parse("2026-10-16T03:00:00+11:00");

const resticBin = (() => {
  try {
    return findRestic();
  } catch {
    return null;
  }
})();

/** A password in a file of the test's folder, read with cat. */
class FilePasswordStore implements PasswordStore {
  readonly command: string;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    this.command = `cat ${file}`;
  }
  has(): Effect.Effect<boolean> {
    return Effect.sync(() => existsSync(this.file));
  }
  store(password: string): Effect.Effect<void> {
    return Effect.promise(() => writeFile(this.file, password));
  }
}

let root: string;
let dataDir: string;
let restic: Restic;

// One repository made once and copied for each test that needs one: restic derives its key for each command it
// runs (about a second), so making one per test would be most of the file's time.
let template: string;
beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), "life-archive-nas-template-"));
  if (resticBin) await runPromise(initRepository({ restic: new Restic(resticBin, new FolderRepository(join(template, "repo")), new FilePasswordStore(join(template, "password")), ["--no-cache"]) }));
}, 60_000);
afterAll(() => rm(template, { recursive: true, force: true }));

/** The made repository, as this test's. */
async function madeRepository(): Promise<void> {
  await cp(join(template, "repo"), join(root, "repo"), { recursive: true });
  await cp(join(template, "password"), join(root, "password"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-nas-"));
  dataDir = join(root, "data");
  // A made-up archive's folder as friend map's step left it: the core's database at its root and friend map's archive in
  // its module's folder, each in WAL mode with a write not yet checkpointed, as the server leaves them.
  await mkdir(join(dataDir, "modules", "friend-map"), { recursive: true });
  const core = new DatabaseSync(join(dataDir, "core.sqlite"));
  core.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE event (id INTEGER PRIMARY KEY, kind TEXT)");
  core.prepare("INSERT INTO event (kind) VALUES (?)").run("llm_session");
  const db = new DatabaseSync(join(dataDir, FRIEND_MAP_DB));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO person (name) VALUES (?)").run("Ada Sample");
  dbs.push(core, db);
  await put("platform-exports/whatsapp/2026-10-06/photo.jpg", "made-up photo");
  await put("connectors/telegram.json", "{}");
  await put("llm/claude-code/project/session.jsonl", "{}\n");
  await put("backups/2026-10-15T181442-before-x.sqlite", "a 48-hour copy");
  await put("archive/.spool/events.jsonl", "scratch");
  await put("archive/repoint-20261005T061615Z.jsonl", "{}");
  await put("archive.sqlite.bak-1", "an old hand-made copy");
  if (resticBin) restic = new Restic(resticBin, new FolderRepository(join(root, "repo")), new FilePasswordStore(join(root, "password")), ["--no-cache"]);
});

const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string, under = dataDir): Promise<void> {
  await mkdir(join(under, path, ".."), { recursive: true });
  await writeFile(join(under, path), text);
}

/**
 * A made-up store shaped like rituals': a folder holding a SQLite database in rollback-journal mode, its own backups and
 * a link out; returned with a write begun and not committed, so its -journal is there while the run copies it.
 */
async function ritualsStore(): Promise<{ folder: string; pending: DatabaseSync }> {
  const folder = join(root, "rituals", "data");
  await mkdir(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, "ritual.sqlite3"));
  db.exec("PRAGMA journal_mode = DELETE; CREATE TABLE ritual (id INTEGER PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO ritual (title) VALUES (?)").run("Morning walk");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO ritual (title) VALUES (?)").run("not yet committed");
  dbs.push(db);
  await put("views/today.json", "{}", folder);
  await put("backups/ritual-20261016T031953-bb18b3d0.sqlite3", "its own copy", folder);
  await symlink(join(dataDir, "connectors"), join(folder, "journals"));
  return { folder, pending: db };
}

/** The files in a snapshot, from its root. */
async function snapshotFiles(snapshot = "latest"): Promise<string[]> {
  const lines = JSON.parse(`[${(await runPromise(restic.run(["ls", "--json", snapshot]))).trim().split("\n").join(",")}]`) as { type?: string; path?: string; struct_type?: string }[];
  return lines.filter((l) => l.struct_type === "node" && l.type === "file").map((l) => l.path!).sort();
}

describe.skipIf(!resticBin)("the archive's folder moved out of the checkout", { timeout: 60_000 }, () => {
  it("carries on the same snapshots: nothing of the archive's read again, the other folders side by side, one retention", async () => {
    await madeRepository();
    const checkout = join(root, "Projects", "life-archive");
    await mkdir(checkout, { recursive: true });
    const before = join(checkout, "data");
    await rename(dataDir, before);
    await put("data/ritual.sqlite3", "not a database, and not named one here", join(root, "Projects", "rituals"));
    await put("old.txt", "kept", join(root, "Projects", "friend-map"));
    const otherFolders = [{ folder: join(root, "Projects", "rituals", "data"), exclude: [] }, { folder: join(root, "Projects", "friend-map"), exclude: [] }];
    await runPromise(runNasBackup({ dataDir: before, restic, otherFolders, now: NIGHT - DAY }));
    expect(await snapshotFiles()).toContain("/rituals/data/ritual.sqlite3");

    const after = join(root, "life-archive-data");
    await rename(before, after);
    const result = await runPromise(runNasBackup({ dataDir: after, restic, otherFolders, now: NIGHT }));

    const files = await snapshotFiles();
    expect(files).toContain("/platform-exports/whatsapp/2026-10-06/photo.jpg");
    expect(files).toEqual(expect.arrayContaining(["/Projects/rituals/data/ritual.sqlite3", "/Projects/friend-map/old.txt"]));
    expect(files.some((file) => file.startsWith("/Projects-") || file.startsWith("/rituals"))).toBe(false);
    // The two nights are one group, so the retention goes on counting them together.
    expect(result.snapshots).toHaveLength(2);
    // The old layout's snapshot stays restorable.
    expect(await snapshotFiles((await runPromise(restic.snapshots()))[0].id)).toContain("/rituals/data/ritual.sqlite3");
    // Only what the two database copies (the core's and friend map's) and the moved folders' paths bring is new; no
    // export is read as changed.
    expect(result.changed).toBeLessThanOrEqual(4);
  });
});

describe.skipIf(!resticBin)("the encrypted repository", { timeout: 60_000 }, () => {
  it("is made with a new password kept in the store, and opened, not made again, the second time", async () => {
    const lines: string[] = [];
    expect(await runPromise(initRepository({ restic, log: (line) => lines.push(line) }))).toEqual({ newPassword: true, created: true });
    const password = await readFile(join(root, "password"), "utf8");
    expect(password).toMatch(/^[\w-]{43}$/);
    // Nothing it says holds the password.
    expect(lines.join("\n")).not.toContain(password);
    expect(await runPromise(initRepository({ restic }))).toEqual({ newPassword: false, created: false });
    expect(await readFile(join(root, "password"), "utf8")).toBe(password);
    // The repository is encrypted: its config is not readable as JSON, and another password does not open it.
    expect(() => JSON.parse(spawnSync("cat", [join(root, "repo", "config")]).stdout.toString())).toThrow();
    await writeFile(join(root, "password"), newPassword());
    await expect(runPromise(restic.exists())).rejects.toThrow(/exited 12|wrong password/);
  });

  it("refuses to back up before it is made, with or without the password", async () => {
    await expect(runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }))).rejects.toThrow(/holds no password for the backup \(service life-archive-backup\): npm run nas-backup -- init/);
    await runPromise(restic.passwords.store(newPassword()));
    await expect(runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }))).rejects.toThrow(/there is no repository at .*: npm run nas-backup -- init/);
    expect(existsSync(join(dataDir, STAGING, "core.sqlite"))).toBe(false);
  });
});

describe.skipIf(!resticBin)("a night's snapshot", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    await madeRepository();
  });

  it("holds the trail of content reads a write not yet checkpointed left in the calendar, as a checked copy that verify checks", async () => {
    const calendar = openCalendar(join(dataDir, CALENDAR_FILE));
    calendar.exec("PRAGMA wal_autocheckpoint = 0");
    new ContentLog(calendar).record({ surface: "cli", reader: "made-up", what: "timeline", scope: { person: 1 }, why: "made up" });
    expect(existsSync(join(dataDir, `${CALENDAR_FILE}-wal`))).toBe(true);
    try {
      await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
      const files = await snapshotFiles();
      expect(files).toContain(`/${CALENDAR_FILE}`);
      expect(files.filter((file) => file.startsWith(`/${CALENDAR_FILE}-`))).toEqual([]);
      await runPromise(restic.run(["restore", "latest", "--include", `/${CALENDAR_FILE}`, "--target", join(root, "restored")]));
      const restored = new DatabaseSync(join(root, "restored", CALENDAR_FILE), { readOnly: true });
      expect(restored.prepare("SELECT reader, what FROM content_read").all()).toEqual([{ reader: "made-up", what: "timeline" }]);
      restored.close();
      expect((await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [] }))).integrity).toEqual({ "core.sqlite": "ok", [CALENDAR_FILE]: "ok", [FRIEND_MAP_DB]: "ok" });
    } finally {
      calendar.close();
    }
  });

  it("is the archive's folder with a checked copy of each database at its own path, less the backups, the spool and the live databases' files, and is recorded", async () => {
    const lines: string[] = [];
    const result = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT, log: (line) => lines.push(line) }));
    expect(result).toMatchObject({ changed: 6, forgotten: [], snapshots: [expect.stringMatching(/^2026-10-16T03:00:00/)] });
    expect(await snapshotFiles()).toEqual([
      "/archive/repoint-20261005T061615Z.jsonl",
      "/connectors/telegram.json",
      "/core.sqlite",
      "/llm/claude-code/project/session.jsonl",
      `/${FRIEND_MAP_DB}`,
      "/platform-exports/whatsapp/2026-10-06/photo.jpg",
    ]);
    // Each copy, restored, is whole and holds the write the WAL had.
    await runPromise(restic.run(["restore", "latest", "--include", "/core.sqlite", "--include", `/${FRIEND_MAP_DB}`, "--target", join(root, "restored")]));
    expect(integrityCheck(join(root, "restored", "core.sqlite"))).toBe("ok");
    const core = new DatabaseSync(join(root, "restored", "core.sqlite"), { readOnly: true });
    expect(core.prepare("SELECT kind FROM event").all()).toEqual([{ kind: "llm_session" }]);
    core.close();
    const copy = join(root, "restored", FRIEND_MAP_DB);
    expect(integrityCheck(copy)).toBe("ok");
    const restored = new DatabaseSync(copy, { readOnly: true });
    expect(restored.prepare("SELECT name FROM person").all()).toEqual([{ name: "Ada Sample" }]);
    restored.close();
    // The local copy is gone once sent, and so is the lock.
    expect(await readdir(join(dataDir, STAGING))).toEqual([]);
    expect(lines.join("\n")).toMatch(/backed up 6 new or changed files/);
    expect(await readNasStatus(dataDir)).toMatchObject({
      lastSuccessAt: new Date(NIGHT).toISOString(),
      lastSuccessHost: join(root, "repo"),
      snapshots: [expect.any(String)],
      transcripts: { count: 1, first: expect.stringMatching(/^2026-10-16T02:59:59/), last: expect.stringMatching(/^2026-10-16T02:59:59/) },
      resticVersion: expect.any(String),
    });
  });

  it("takes modules/ whole through its mirror: each database a checked copy at its own path, so a restore of the snapshot is the folder as it lives", async () => {
    // Friend map's page files beside its archive; rituals' store mid-write, its own backups and a link out; the journal's ledger.
    await put("modules/friend-map/page/settings.json", "{}");
    await put("modules/friend-map/page/me/photo.jpg", "made-up photo");
    await put("modules/journal/ledger.json", "{}");
    const store = join(dataDir, "modules", "rituals", "data");
    await mkdir(store, { recursive: true });
    const rituals = new DatabaseSync(join(store, "ritual.sqlite3"));
    rituals.exec("PRAGMA journal_mode = DELETE; CREATE TABLE ritual (id INTEGER PRIMARY KEY, title TEXT)");
    rituals.prepare("INSERT INTO ritual (title) VALUES (?)").run("Morning walk");
    rituals.exec("BEGIN IMMEDIATE");
    rituals.prepare("INSERT INTO ritual (title) VALUES (?)").run("not yet committed");
    dbs.push(rituals);
    await put("modules/rituals/data/backups/ritual-20261016T031953-bb18b3d0.sqlite3", "its own copy");
    await symlink(join(dataDir, "connectors"), join(store, "journals"));
    expect(existsSync(join(store, "ritual.sqlite3-journal"))).toBe(true);
    const lines: string[] = [];
    const made = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT, log: (line) => lines.push(line) }));
    expect((await snapshotFiles()).filter((file) => file.startsWith("/modules/"))).toEqual([
      "/modules/friend-map/archive.sqlite",
      "/modules/friend-map/page/me/photo.jpg",
      "/modules/friend-map/page/settings.json",
      "/modules/journal/ledger.json",
      "/modules/rituals/data/ritual.sqlite3",
    ]);
    expect(lines.join("\n")).toMatch(/mirrored .*modules as \/modules \(3 files linked\)/);
    expect(lines.join("\n")).toMatch(/made a checked copy of .*modules\/rituals\/data\/ritual.sqlite3 as \/modules\/rituals\/data\/ritual.sqlite3/);
    // Restored whole, as docs/data.md's "The NAS copy" says: every file where it lives, the link a link, the write not committed not in it.
    const restored = join(root, "restored");
    await runPromise(restic.run(["restore", "latest", "--target", restored]));
    expect(await readFile(join(restored, "modules/friend-map/page/settings.json"), "utf8")).toBe("{}");
    expect(integrityCheck(join(restored, FRIEND_MAP_DB))).toBe("ok");
    const copy = new DatabaseSync(join(restored, "modules/rituals/data/ritual.sqlite3"), { readOnly: true });
    expect(copy.prepare("SELECT title FROM ritual").all()).toEqual([{ title: "Morning walk" }]);
    copy.close();
    expect(await readlink(join(restored, "modules/rituals/data/journals"))).toBe(join(dataDir, "connectors"));
    // The live folder is as it was, its files linked from nothing any more, and the mirror is gone.
    expect((await stat(join(dataDir, "modules/friend-map/page/settings.json"))).nlink).toBe(1);
    expect(existsSync(join(dataDir, "modules/rituals/data/backups/ritual-20261016T031953-bb18b3d0.sqlite3"))).toBe(true);
    expect(await readdir(join(dataDir, STAGING))).toEqual([]);
    // verify restores each database by its path in the snapshot.
    rituals.exec("COMMIT");
    expect(await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [] }))).toMatchObject({
      snapshot: made.snapshot,
      integrity: { "core.sqlite": "ok", [FRIEND_MAP_DB]: "ok", "modules/rituals/data/ritual.sqlite3": "ok" },
    });
  });

  it("makes a second snapshot of the transcripts alone (transcripts/ and llm/), tagged llm-transcripts, and leaves `latest` the archive's", async () => {
    await put("transcripts/claude-code/projects/crew/session.jsonl.zst", "made-up frames");
    await put("transcripts/claude-code.json", "{}");
    const lines: string[] = [];
    const result = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT, log: (line) => lines.push(line) }));
    expect(result.transcripts).toMatchObject({ snapshot: expect.stringMatching(/^[0-9a-f]{8}$/), changed: 3, kept: [expect.objectContaining({ short_id: result.transcripts?.snapshot })] });
    expect(await snapshotFiles(result.transcripts!.snapshot)).toEqual(["/llm/claude-code/project/session.jsonl", "/transcripts/claude-code.json", "/transcripts/claude-code/projects/crew/session.jsonl.zst"]);
    // The archive's snapshot holds them too: the second costs only its trees.
    expect(await snapshotFiles(result.snapshot)).toEqual(expect.arrayContaining(["/core.sqlite", "/transcripts/claude-code.json"]));
    // Stamped a second before the archive's, so `latest` without a tag is still the archive's folder.
    expect(await snapshotFiles("latest")).toContain("/core.sqlite");
    expect(lines.join("\n")).toMatch(/backed up 3 new or changed files of the transcripts \(transcripts\/, llm\/\), .* added: snapshot [0-9a-f]{8}, tagged llm-transcripts/);
    expect(lines.join("\n")).toMatch(/1 snapshot of the transcripts on .*, never forgotten/);
    // A night with nothing new adds a snapshot of the transcripts all the same.
    const next = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT + DAY }));
    expect(next.transcripts).toMatchObject({ changed: 0, kept: [expect.anything(), expect.anything()] });
  });

  it("makes none of the transcripts when the archive's folder has neither transcripts/ nor llm/", async () => {
    await rm(join(dataDir, "llm"), { recursive: true });
    const lines: string[] = [];
    const result = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT, log: (line) => lines.push(line) }));
    expect(result.transcripts).toBeNull();
    expect(await runPromise(restic.snapshots(TRANSCRIPTS_TAG))).toEqual([]);
    expect(lines.join("\n")).toMatch(/has no transcripts\/ and llm\/: no snapshot of the transcripts/);
    expect((await readNasStatus(dataDir))?.transcripts).toBeUndefined();
  });

  it("sends only what changed, and keeps what is gone from the Mac in the older snapshot", async () => {
    const first = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    await rm(join(dataDir, "connectors/telegram.json"));
    await put("platform-exports/whatsapp/live/new.jpg", "made-up");
    const second = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT + DAY }));
    // The new photo, and the two database copies (each a new file each night).
    expect(second.changed).toBe(3);
    expect(second.snapshots).toHaveLength(2);
    expect(await snapshotFiles(first.snapshot)).toContain("/connectors/telegram.json");
    expect(await snapshotFiles(second.snapshot)).not.toContain("/connectors/telegram.json");
  });

  it("takes in another folder beside the archive's, under its own name and less its exclusions", async () => {
    const notes = join(root, "notes");
    await put("journal.md", "made-up notes", notes);
    await put(".cache/x", "scratch", notes);
    await runPromise(runNasBackup({ dataDir, restic, now: NIGHT, otherFolders: [{ folder: notes, exclude: [".cache"] }] }));
    expect(await snapshotFiles()).toEqual(expect.arrayContaining(["/core.sqlite", "/notes/journal.md"]));
    expect(await snapshotFiles()).not.toContain("/notes/.cache/x");
  });

  it("takes a folder with a database (rituals'), the database as a checked copy at the top, never its live file or journal", async () => {
    const { folder } = await ritualsStore();
    const lines: string[] = [];
    const rituals = { folder, exclude: ["backups"], database: "ritual.sqlite3" };
    const result = await runPromise(runNasBackup({ dataDir, restic, now: NIGHT, otherFolders: [rituals], log: (line) => lines.push(line) }));
    expect(existsSync(join(folder, "ritual.sqlite3-journal"))).toBe(true);
    const all = await snapshotFiles();
    expect(all).toEqual(expect.arrayContaining(["/core.sqlite", "/ritual.sqlite3", "/rituals/data/views/today.json"]));
    expect(all.filter((file) => file.startsWith("/rituals/"))).toEqual(["/rituals/data/views/today.json"]);
    expect(result.snapshots).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/taking .*rituals\/data as \/rituals\/data/);
    expect(lines.join("\n")).toMatch(/made a checked copy of .*rituals\/data\/ritual.sqlite3 as \/ritual.sqlite3 \(.*integrity ok\)/);
    // Restored as docs/data.md's "The NAS copy" says: the folder, and its database put back into it; the write not committed is not in it.
    await runPromise(restic.run(["restore", "latest", "--include", "/rituals/data", "--include", "/ritual.sqlite3", "--target", join(root, "restored")]));
    const copy = join(root, "restored", "ritual.sqlite3");
    expect(integrityCheck(copy)).toBe("ok");
    const restored = new DatabaseSync(copy, { readOnly: true });
    expect(restored.prepare("SELECT title FROM ritual").all()).toEqual([{ title: "Morning walk" }]);
    restored.close();
    // The link into the archive's folder stays a link.
    expect(await readlink(join(root, "restored", "rituals", "data", "journals"))).toBe(join(dataDir, "connectors"));
    expect(await readdir(join(dataDir, STAGING))).toEqual([]);
  });

  it("refuses a folder that is not there", async () => {
    await expect(runPromise(runNasBackup({ dataDir, restic, now: NIGHT, otherFolders: [{ folder: join(root, "gone"), exclude: [] }] }))).rejects.toThrow(/gone, which the NAS backup takes, is not there/);
  });

  it("in a dry run, backs up, forgets and records nothing", async () => {
    const lines: string[] = [];
    const result = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT, dryRun: true, log: (line) => lines.push(line) }));
    expect(result).toMatchObject({ databaseBytes: undefined, snapshot: undefined, changed: 4, snapshots: [], transcripts: { snapshot: undefined, changed: 1, kept: [] } });
    expect(await runPromise(restic.snapshots())).toEqual([]);
    expect(await runPromise(restic.snapshots(TRANSCRIPTS_TAG))).toEqual([]);
    expect(lines.join("\n")).toMatch(/would back up 1 new or changed file of the transcripts \(llm\/\)/);
    expect(await readNasStatus(dataDir)).toBeNull();
    expect(lines.join("\n")).toMatch(/would add a checked copy of core.sqlite\n.*would add a checked copy of .*modules\/friend-map\/archive.sqlite as \/modules\/friend-map\/archive.sqlite/);
  });

  it("will not run beside another, takes over a dead run's lock, and keeps the last success when one fails", async () => {
    await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    await writeFile(join(dataDir, STAGING, ".lock"), String(process.pid));
    await expect(runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT + DAY }))).rejects.toThrow(/another NAS backup is running/);
    await recordNasFailure(dataDir, new Error("the NAS did not answer"), NIGHT + DAY);
    const status = await readNasStatus(dataDir);
    expect(status).toMatchObject({ lastSuccessAt: new Date(NIGHT).toISOString(), lastFailure: "the NAS did not answer" });
    expect(nasLine(status, NIGHT + DAY)).toMatch(/24 hours ago.*failed since, 2026-10-16T16:00:00.000Z: the NAS did not answer$/);
    // A lock left by a process that is gone is taken over, and the next success clears the failure.
    await writeFile(join(dataDir, STAGING, ".lock"), "999999999");
    await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT + 2 * DAY }));
    expect((await readNasStatus(dataDir))?.lastFailure).toBeUndefined();
  });

  it("clears a stale restic lock a dead run left in the repository", async () => {
    await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    // A run killed while it holds its lock: a backup reading its standard input, which is never closed.
    const env = { ...process.env, RESTIC_PASSWORD_COMMAND: restic.passwords.command };
    const killed = spawn(restic.bin, ["-r", restic.repository.url, "--no-cache", "backup", "--stdin", "-q"], { env, stdio: ["pipe", "ignore", "ignore"] });
    let locks = "";
    for (let tries = 0; tries < 100 && !locks; tries++) locks = (await runPromise(restic.run(["list", "locks", "--no-lock"]))).trim();
    expect(locks).not.toBe("");
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("close", resolve));
    expect((await runPromise(restic.run(["list", "locks", "--no-lock"]))).trim()).toBe(locks);
    await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT + DAY }));
    expect((await runPromise(restic.run(["list", "locks", "--no-lock"]))).trim()).toBe("");
  });

  it("keeps the newest of each of the last seven days, and nothing older", async () => {
    // Midday in this Mac's zone, as restic counts days: two snapshots on the 16th, then one a day to 1 November,
    // made directly (a whole run each is slow), then a night's run on 2 November.
    const midday = (day: number, hour = 12) => new Date(2026, 9, 16 + day, hour).getTime();
    const seed = (at: number) => runPromise(restic.run(["backup", "-q", "--tag", SNAPSHOT_TAG, "--time", new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " "), "connectors"], { cwd: dataDir }));
    await seed(midday(0, 11));
    for (let day = 0; day < 17; day++) await seed(midday(day));
    const result = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: midday(17) }));
    // 27 October to 2 November, one a day; nothing older.
    expect(result.snapshots.map((time) => time.slice(0, 10))).toEqual(["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    // Both of the 16th, and the 17th to the 26th.
    expect(result.forgotten).toHaveLength(12);
  });

  // 34 restic backups, a prune, a restore and a check: 35 to 50 s alone, past a minute on a busy machine.
  it("never forgets a snapshot of the transcripts, nor prunes what only they hold, however old", { timeout: 180_000 }, async () => {
    // As above: a snapshot of each kind at midday each day from 16 October to 1 November, made directly, then a
    // night's run on 2 November, whose forget prunes.
    const midday = (day: number) => new Date(2026, 9, 16 + day, 12).getTime();
    const wall = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const seed = (tag: string, day: number, target: string) => runPromise(restic.run(["backup", "-q", "--tag", tag, "--time", wall(midday(day)), target], { cwd: dataDir }));
    // A crew's session that its tool, and then the Mac's copy, lost: after the 16th only the NAS has it.
    const gone = "transcripts/claude-code/projects/crew/gone.jsonl.zst";
    await put(gone, "made-up frames of a crew's session");
    for (let day = 0; day < 17; day++) {
      await seed(SNAPSHOT_TAG, day, "connectors");
      await seed(TRANSCRIPTS_TAG, day, "transcripts");
      if (day === 0) await rm(join(dataDir, gone));
    }
    const result = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: midday(17) }));
    // The archive's: a week kept, the 11 older forgotten and pruned.
    expect(result.snapshots).toHaveLength(7);
    expect(result.forgotten).toHaveLength(11);
    // The transcripts': all 18, from the first.
    const kept = await runPromise(restic.snapshots(TRANSCRIPTS_TAG));
    expect(kept.map((s) => s.time.slice(0, 10))).toEqual([...Array.from({ length: 17 }, (_, day) => new Date(midday(day)).toLocaleDateString("en-CA")), "2026-11-02"]);
    expect(result.transcripts?.kept).toEqual(kept);
    expect(result.forgotten.filter((id) => kept.some((s) => s.short_id === id))).toEqual([]);
    expect(await readNasStatus(dataDir)).toMatchObject({ transcripts: { count: 18, first: kept[0].time, last: kept[17].time } });
    // The prune kept the data only the oldest held: it gives the file back, byte for byte.
    await runPromise(restic.run(["restore", kept[0].id, "--include", `/${gone}`, "--target", join(root, "restored")]));
    expect(await readFile(join(root, "restored", gone), "utf8")).toBe("made-up frames of a crew's session");
    await runPromise(restic.run(["check", "-q"]));
    // A second night forgets one more of the archive's, and still none of the transcripts'.
    const after = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: midday(18) }));
    expect(after.forgotten).toHaveLength(1);
    expect(after.transcripts?.kept).toHaveLength(19);
  });

  it("stopped mid-run, stops restic, deletes the database copy and lets the lock go", async () => {
    const staging = join(dataDir, STAGING);
    const running = Effect.runFork(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    // Stopped while restic backs up, the database copy beside it.
    const backingUp = () => spawnSync("pgrep", ["-P", String(process.pid), "-f", "restic .* backup"]).stdout.toString().trim();
    for (let tries = 0; tries < 1000 && !backingUp(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(backingUp()).not.toBe("");
    expect((await readdir(staging)).sort()).toEqual([".lock", "core.sqlite", "modules"]);
    await runPromise(Fiber.interrupt(running));
    expect(await readdir(staging)).toEqual([]);
    expect(spawnSync("pgrep", ["-P", String(process.pid), "restic"]).stdout.toString()).toBe("");
    expect(await readNasStatus(dataDir)).toBeNull();
    // The next run is not kept out by it.
    expect((await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }))).snapshots).toHaveLength(1);
  });

  it("refuses a folder with no archive, and one from before friend map was a module until it has moved", async () => {
    await writeFile(join(dataDir, "archive.sqlite"), "");
    await expect(runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }))).rejects.toThrow(/from before friend map was a module \(archive.sqlite at its root\): move it first, .*npm run archive -- migrate friend-map-module/);
    await rm(join(dataDir, "archive.sqlite"));
    await rm(join(dataDir, "core.sqlite"));
    await expect(runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }))).rejects.toThrow(/there is no core.sqlite in/);
    expect(await runPromise(restic.snapshots())).toEqual([]);
  });
});

describe.skipIf(!resticBin)("verifying the NAS copy", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    await madeRepository();
  });

  it("checks the repository and restores the newest snapshot's database, inside the archive's folder, and deletes it", async () => {
    const made = await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    const lines: string[] = [];
    const result = await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [], log: (line) => lines.push(line) }));
    expect(result).toEqual({ snapshot: made.snapshot, integrity: { "core.sqlite": "ok", [FRIEND_MAP_DB]: "ok" }, missing: [], transcripts: { snapshot: made.transcripts?.snapshot, missing: [] } });
    expect(verifiedWhole(result)).toBe(true);
    expect(lines.join("\n")).toMatch(/restic check: no errors/);
    expect(lines.join("\n")).toMatch(/the transcripts: 1 snapshot, never forgotten, the newest [0-9a-f]{8} of .*\n.*: \/llm is in it/);
    expect(await readdir(join(dataDir, STAGING))).toEqual([]);
  });

  it("fails when there is no snapshot of the transcripts, or the newest lacks a folder of theirs the archive's folder has", async () => {
    // The archive's snapshot alone, as the nights before the transcripts' snapshot was made.
    await runPromise(restic.run(["backup", "-q", "--tag", SNAPSHOT_TAG, "core.sqlite", FRIEND_MAP_DB], { cwd: dataDir }));
    const lines: string[] = [];
    const none = await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [], log: (line) => lines.push(line) }));
    expect(none).toMatchObject({ integrity: { "core.sqlite": "ok", [FRIEND_MAP_DB]: "ok" }, missing: [], transcripts: { snapshot: null, missing: [] } });
    expect(verifiedWhole(none)).toBe(false);
    expect(lines.join("\n")).toMatch(/NO snapshot of the transcripts \(tagged llm-transcripts\)/);
    // A night when the archive's folder had llm/ alone; then transcripts/ came, and the newest lacks it.
    await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    await put("transcripts/claude-code.json", "{}");
    const lacking = await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [] }));
    expect(lacking.transcripts).toEqual({ snapshot: expect.any(String), missing: ["/transcripts"] });
    expect(verifiedWhole(lacking)).toBe(false);
  });

  it("restores each other folder's database too, and looks for the folder, saying what the newest snapshot lacks", async () => {
    const { folder, pending } = await ritualsStore();
    pending.exec("COMMIT");
    const rituals = { folder, exclude: ["backups"], database: "ritual.sqlite3" };
    // A night before rituals was taken in: verify says it is not there.
    await runPromise(runNasBackup({ dataDir, restic, now: NIGHT, otherFolders: [] }));
    const before = await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [rituals] }));
    expect(before).toMatchObject({ integrity: { "core.sqlite": "ok", [FRIEND_MAP_DB]: "ok", "ritual.sqlite3": "missing" }, missing: ["/rituals/data"] });
    expect(verifiedWhole(before)).toBe(false);
    const made = await runPromise(runNasBackup({ dataDir, restic, now: NIGHT + DAY, otherFolders: [rituals] }));
    const after = await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [rituals] }));
    expect(after).toEqual({ snapshot: made.snapshot, integrity: { "core.sqlite": "ok", [FRIEND_MAP_DB]: "ok", "ritual.sqlite3": "ok" }, missing: [], transcripts: { snapshot: made.transcripts?.snapshot, missing: [] } });
    expect(verifiedWhole(after)).toBe(true);
    expect(await readdir(join(dataDir, STAGING))).toEqual([]);
  });

  it("fails when the repository's data is damaged", async () => {
    await runPromise(runNasBackup({ dataDir, restic, otherFolders: [], now: NIGHT }));
    const packs = (await readdir(join(root, "repo", "data"), { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    for (const pack of packs) {
      const file = join(pack.parentPath, pack.name);
      await chmod(file, 0o600);
      const bytes = await readFile(file);
      bytes[bytes.length >> 1] ^= 0xff;
      await writeFile(file, bytes);
    }
    // The check reads a sample: with every pack damaged, any sample finds it.
    await expect(runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [] }))).rejects.toThrow(/restic exited/);
  });

  it("says when there is no snapshot", async () => {
    const result = await runPromise(verifyNasBackup({ dataDir, restic, otherFolders: [] }));
    expect(result).toEqual({ snapshot: null, integrity: {}, missing: [], transcripts: { snapshot: null, missing: [] } });
    expect(verifiedWhole(result)).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")("the Keychain", () => {
  it("keeps the password as a generic password, read by the command restic is given, never as an argument", async () => {
    const keychain = join(root, "test.keychain-db");
    // A keychain file of the test's own, unlocked by its password; create-keychain leaves the search list as it is.
    expect(spawnSync("/usr/bin/security", ["create-keychain", "-p", "made-up", keychain]).status).toBe(0);
    try {
      const store = new KeychainPasswordStore(keychain);
      expect(store.command).toBe(`/usr/bin/security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${keychain}`);
      expect(await runPromise(store.has())).toBe(false);
      const password = newPassword();
      await runPromise(store.store(password));
      expect(await runPromise(store.has())).toBe(true);
      const [program, ...args] = store.command.split(" ");
      expect(spawnSync(program, args).stdout.toString().trim()).toBe(password);
      await expect(runPromise(store.store("it's"))).rejects.toThrow(/letters, digits/);
    } finally {
      spawnSync("/usr/bin/security", ["delete-keychain", keychain]);
    }
  });
});

describe("pieces", () => {
  it("refuses while a module is broken, since only its declaration leaves out and copies a database it keeps itself", async () => {
    const checkout = join(root, "checkout");
    const module = join(checkout, "modules", "unloadable");
    await mkdir(module, { recursive: true });
    await writeFile(join(module, "package.json"), JSON.stringify({ name: "made-up", private: true, lifeArchive: true }));
    await writeFile(join(module, "module.ts"), "import { nothing } from './missing.ts';\nexport default nothing;\n");
    await expect(backupTargets(dataDir, [], checkout)).rejects.toThrow(/cannot tell what a broken module keeps in its folder: unloadable \(.*missing\.ts/);
    await rm(module, { recursive: true });
    expect((await backupTargets(dataDir, [], checkout)).databases.map((database) => database.name)).toEqual(["core.sqlite", FRIEND_MAP_DB]);
  });

  it("names the archive's entries relative to the staging folder, so each lands at the snapshot's root, modules/ as its mirror, and refuses two on one name", async () => {
    for (const folder of ["notes", "elsewhere/llm", "llm", "core.sqlite"]) await mkdir(join(root, folder), { recursive: true });
    // The captain's vault, a link into iCloud Drive, which keeps it: left out, neither the link nor what it points at.
    await mkdir(join(root, "iCloud", "Vault"), { recursive: true });
    await symlink(join(root, "iCloud", "Vault"), join(dataDir, "Vault"));
    // Another module's database, which goes as a checked copy at its own path in the mirror, and never twice.
    await mkdir(join(dataDir, "modules", "exercise"), { recursive: true });
    await writeFile(join(dataDir, "modules", "exercise", "exercise.sqlite"), "");
    const { targets, excludes, databases, mirror } = await backupTargets(dataDir, [{ folder: join(root, "notes"), exclude: ["cache/**"] }]);
    expect(targets).toEqual(["../../archive", "../../connectors", "../../llm", "modules", "../../platform-exports", "../../../notes"]);
    expect(databases.map((d) => d.name)).toEqual(["core.sqlite", "modules/exercise/exercise.sqlite", FRIEND_MAP_DB]);
    // Resolved, as restic resolves them (the temporary folder is under /var, which is /private/var). The mirror leaves
    // out the live databases the core opens, and what a module keeps itself (rituals' store, which its own ritualctl
    // writes, and the backups rituals makes before each write) whether or not it is there yet; the store goes as a
    // checked copy once it is (below). restic's own exclusions are the rest.
    const real = await realpath(root);
    const ritualsKept = [join(real, "data/modules/rituals/data/ritual.sqlite3*"), join(real, "data/modules/rituals/data/backups")];
    expect(mirror).toEqual({ from: join(real, "data/modules"), excludes: [join(real, "data/modules/*/*.sqlite*"), ...ritualsKept] });
    expect(excludes).toEqual([join(real, "data/archive/.spool"), join(real, "notes/cache/**")]);
    // A folder beyond the shared one keeps the rest of its path, so does not land on the archive's llm/.
    expect((await backupTargets(dataDir, [{ folder: join(root, "elsewhere", "llm"), exclude: [] }])).targets.at(-1)).toBe("../../../elsewhere/llm");
    await expect(backupTargets(dataDir, [{ folder: join(root, "llm"), exclude: [] }])).rejects.toThrow(/would be \/llm in the snapshot/);
    await expect(backupTargets(dataDir, [{ folder: join(root, "core.sqlite"), exclude: [] }])).rejects.toThrow(/would be \/core.sqlite/);
    // A folder's database: its copy at the top under its own name, its live file and journal left out of the folder.
    const withDatabase = await backupTargets(dataDir, [{ folder: join(root, "notes"), exclude: ["cache/**"], database: "notes.sqlite3" }]);
    expect(withDatabase.databases).toEqual([
      { file: join(real, "data/core.sqlite"), name: "core.sqlite" },
      { file: join(real, "data/modules/exercise/exercise.sqlite"), name: "modules/exercise/exercise.sqlite" },
      { file: join(real, "data", FRIEND_MAP_DB), name: FRIEND_MAP_DB },
      { file: join(real, "notes/notes.sqlite3"), name: "notes.sqlite3" },
    ]);
    expect(withDatabase.excludes).toEqual([join(real, "data/archive/.spool"), join(real, "notes/cache/**"), join(real, "notes/notes.sqlite3*")]);
    expect(withDatabase.folders).toEqual([{ folder: join(real, "notes"), path: "/notes" }]);
    await expect(backupTargets(dataDir, [{ folder: join(root, "notes"), exclude: [], database: "llm" }])).rejects.toThrow(/would be \/llm in the snapshot/);
    // A folder's database named as a module's folder cannot land on the mirror either.
    await expect(backupTargets(dataDir, [{ folder: join(root, "notes"), exclude: [], database: "modules" }])).rejects.toThrow(/would be \/modules in the snapshot/);
    // Rituals' store, once it is in the folder: a checked copy at its own path, after the databases the core opens.
    await mkdir(join(dataDir, "modules", "rituals", "data"), { recursive: true });
    await writeFile(join(dataDir, "modules", "rituals", "data", "ritual.sqlite3"), "");
    expect((await backupTargets(dataDir, [])).databases).toEqual([
      { file: join(real, "data/core.sqlite"), name: "core.sqlite" },
      { file: join(real, "data/modules/exercise/exercise.sqlite"), name: "modules/exercise/exercise.sqlite" },
      { file: join(real, "data", FRIEND_MAP_DB), name: FRIEND_MAP_DB },
      { file: join(real, "data/modules/rituals/data/ritual.sqlite3"), name: "modules/rituals/data/ritual.sqlite3" },
    ]);
  });

  it("mirrors a folder as hard links, its links as links, less what the patterns leave out, and deleting the mirror leaves the folder", async () => {
    const from = join(root, "live");
    await put("a/kept.json", "{}", from);
    await put("a/live.sqlite", "the live database", from);
    await put("a/live.sqlite-wal", "its journal", from);
    await put("b/backups/old.sqlite3", "left out with its folder", from);
    await symlink(join(root, "elsewhere"), join(from, "b", "out"));
    const to = join(root, "mirror");
    expect(await mirrorFolder(from, to, [join(from, "*/*.sqlite*"), join(from, "b/backups")])).toBe(1);
    expect((await readdir(to, { recursive: true })).sort()).toEqual(["a", "a/kept.json", "b", "b/out"]);
    expect((await stat(join(from, "a/kept.json"))).nlink).toBe(2);
    expect(await readlink(join(to, "b/out"))).toBe(join(root, "elsewhere"));
    await rm(to, { recursive: true, force: true });
    expect(await readFile(join(from, "a/kept.json"), "utf8")).toBe("{}");
    expect((await stat(join(from, "a/kept.json"))).nlink).toBe(1);
  });

  it("sends the calendar as a checked copy beside the core's, never its live files", async () => {
    for (const name of [CALENDAR_FILE, `${CALENDAR_FILE}-wal`, `${CALENDAR_FILE}-shm`]) await writeFile(join(dataDir, name), "");
    const { targets, databases } = await backupTargets(dataDir, []);
    const real = await realpath(dataDir);
    expect(databases).toEqual([
      { file: join(real, "core.sqlite"), name: "core.sqlite" },
      { file: join(real, CALENDAR_FILE), name: CALENDAR_FILE },
      { file: join(real, FRIEND_MAP_DB), name: FRIEND_MAP_DB },
    ]);
    expect(targets.filter((target) => target.includes(CALENDAR_FILE))).toEqual([]);
  });

  it("lets folders that share a parent the archive's folder is outside of land together, and refuses one named twice", async () => {
    // As the captain's: the archive's folder in the home folder, the others in ~/Projects, all in /Projects in a snapshot.
    for (const folder of ["Projects/rituals/data", "Projects/friend-map"]) await mkdir(join(root, folder), { recursive: true });
    const folders = [{ folder: join(root, "Projects/rituals/data"), exclude: [] }, { folder: join(root, "Projects/friend-map"), exclude: [] }];
    const { targets, folders: landed } = await backupTargets(dataDir, folders);
    expect(targets.slice(-2)).toEqual(["../../../Projects/rituals/data", "../../../Projects/friend-map"]);
    expect(landed.map((f) => f.path)).toEqual(["/Projects/rituals/data", "/Projects/friend-map"]);
    await expect(backupTargets(dataDir, [folders[1], folders[1]])).rejects.toThrow(/would be \/Projects in the snapshot/);
    // A database's copy is at the top, where another of that name cannot go either.
    await expect(backupTargets(dataDir, [{ ...folders[0], database: "x.sqlite3" }, { ...folders[1], database: "x.sqlite3" }])).rejects.toThrow(/would be \/x.sqlite3 in the snapshot/);
  });

  it("takes the folders the settings name beside the archive's, ~/ read as the home folder", () => {
    expect(OTHER_FOLDERS).toEqual([{ folder: join(homedir(), "Projects", "sample", "data"), exclude: ["backups"], database: "sample.sqlite3" }]);
  });

  it("leaves the settings' vault out of a snapshot, and has no repository unless they name one", () => {
    expect(ARCHIVE_EXCLUDES).toContain("Vault");
    expect(REPOSITORY_PATH).toBe("sample-backup/restic");
    expect(NAS_HOSTS).toEqual(["sample-nas", "sample-nas-remote"]);
  });

  it("reads restic's JSON", () => {
    expect(backupSummary('{"message_type":"status"}\n{"message_type":"summary","files_new":2,"files_changed":1,"data_added":10,"snapshot_id":"abc"}\n')).toMatchObject({ files_new: 2, snapshot_id: "abc" });
    expect(() => backupSummary("")).toThrow(/no summary/);
    const kept = { id: "3", short_id: "cc", time: "2026-10-16T03:00:00+11:00" };
    expect(forgetResult(`[{"tags":["life-archive"],"keep":[${JSON.stringify(kept)}],"remove":[{"id":"1","short_id":"aa","time":"t"},{"id":"2","short_id":"bb","time":"t"}]}]\n`)).toEqual({ forgotten: ["aa", "bb"], kept: [kept] });
    expect(forgetResult('[{"tags":["life-archive"],"keep":null,"remove":null}]')).toEqual({ forgotten: [], kept: [] });
    expect(forgetResult("")).toEqual({ forgotten: [], kept: [] });
  });

  it("tries each host in turn, and says why none answered", async () => {
    const error = await runPromise(Effect.flip(reachNas(["nas-one.invalid", "nas-two.invalid"])));
    expect(error.message).toMatch(/^the NAS did not answer over ssh \(nas-one\.invalid: ssh exited 255: .*; nas-two\.invalid: ssh exited 255: .*\)$/);
  });

  it("reaches the NAS's repository over sftp as the ssh host, without prompting", () => {
    const nas = new NasRepository("nas");
    expect(nas.url).toBe("sftp:nas:sample-backup/restic");
    expect(nas.options).toEqual(["-o", "sftp.command=ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 nas -s sftp"]);
  });

  it("finds restic on the PATH, else where Homebrew puts it, and says how to install it when it is nowhere", async () => {
    const bin = join(root, "bin");
    await put("restic", "", bin);
    expect(findRestic(bin)).toBe(join(bin, "restic"));
    if (!existsSync("/opt/homebrew/bin/restic") && !existsSync("/usr/local/bin/restic")) expect(() => findRestic("")).toThrow(/brew install restic/);
  });

  it("says when the NAS copy was last made, or that it never was", () => {
    expect(nasLine(null, NIGHT)).toBe("NAS backup: none made yet (npm run nas-backup)");
    const status = { lastSuccessAt: new Date(NIGHT).toISOString(), lastSuccessHost: "nas", snapshots: ["2026-10-15T03:00:02+11:00", "2026-10-16T03:00:01+11:00"], freeBytes: 6e12 };
    expect(nasLine(status, NIGHT + 5 * DAY)).toBe(`NAS backup: last made ${status.lastSuccessAt} (5 days ago, overdue) on nas, 2 snapshots there (2026-10-15 to 2026-10-16) and none yet of the transcripts, 6000 GB free`);
    const transcripts = { count: 400, first: "2025-09-12T03:00:01+10:00", last: "2026-10-16T03:00:00+11:00" };
    expect(nasLine({ ...status, transcripts }, NIGHT + DAY)).toBe(`NAS backup: last made ${status.lastSuccessAt} (24 hours ago) on nas, 2 snapshots there (2026-10-15 to 2026-10-16) and 400 of the transcripts, never forgotten (2025-09-12 to 2026-10-16), 6000 GB free`);
  });

  it("takes the transcripts' folder (transcripts.ts's) and the archive's llm/ into the transcripts' snapshot", () => {
    expect(TRANSCRIPT_FOLDERS).toEqual([TRANSCRIPTS_FOLDER, "llm"]);
    expect(TRANSCRIPTS_TAG).not.toBe(SNAPSHOT_TAG);
  });

  it("writes the launchd agent for 06:00, kept awake, from this repository, with Homebrew's restic on its PATH", async () => {
    const text = plist({ node: "/Users/ada/.vite-plus/bin/node", repo: "/Users/ada/Projects/life-archive", logFile: "/Users/ada/Library/Logs/LifeArchive/nas-backup.log" });
    expect(text).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(text).toContain("<string>/usr/bin/caffeinate</string><string>-i</string><string>/Users/ada/.vite-plus/bin/node</string><string>--no-warnings</string><string>server/nas-backup.ts</string>");
    expect(text).toContain("<key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer>");
    expect(text).toContain("<key>WorkingDirectory</key><string>/Users/ada/Projects/life-archive</string>");
    expect(text).toContain("<string>/Users/ada/.vite-plus/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(await readFile(new URL("../../package.json", import.meta.url), "utf8")).toContain('"nas-backup": "node --no-warnings server/nas-backup.ts"');
  });
});
