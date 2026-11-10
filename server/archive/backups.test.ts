import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupName, backupsToDelete, createBackup, integrityCheck, parseBackupName, pruneBackups, slugLabel } from "./backups.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const HOUR = 60 * 60 * 1000;
// Melbourne is UTC+10 in June and UTC+11 in January.
const NOW = Date.parse("2026-06-15T12:00:00+10:00");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-backups-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("backup names", () => {
  it("are Melbourne wall-clock time and a slugged label", () => {
    expect(backupName(NOW, "Before tag cleanup!")).toBe("2026-06-15T120000-before-tag-cleanup.sqlite");
    expect(backupName(Date.parse("2026-01-10T23:30:05Z"), "x")).toBe("2026-01-11T103005-x.sqlite");
    expect(slugLabel("  --Merge  Ada & Bea-- ")).toBe("merge-ada-bea");
    expect(() => backupName(NOW, "!!")).toThrow(/label/);
  });

  it("parse back to the instant and the Melbourne day, in and out of daylight saving", () => {
    expect(parseBackupName("2026-06-15T120000-x.sqlite")).toEqual({ at: NOW, day: "2026-06-15", label: "x" });
    expect(parseBackupName("2026-01-11T103005-x.sqlite")).toEqual({ at: Date.parse("2026-01-10T23:30:05Z"), day: "2026-01-11", label: "x" });
    expect(parseBackupName("2026-06-15T120000-before-import-calls.sqlite")?.label).toBe("before-import-calls");
    expect(parseBackupName("2026-06-15T120000-x.exercise.sqlite")).toEqual({ at: NOW, day: "2026-06-15", label: "x" });
    for (const other of ["archive.sqlite", "archive.sqlite.bak-before-merge", "2026-06-15T120000-x.sqlite.partial", "2026-06-15T1200-x.sqlite", "2026-06-15T120000-X.sqlite"]) {
      expect(parseBackupName(other)).toBeNull();
    }
  });
});

describe("backupsToDelete", () => {
  const at = (hoursAgo: number, label = "x") => backupName(NOW - hoursAgo * HOUR, label);

  it("keeps the newest of each Melbourne day within 48 hours and deletes the rest", () => {
    const names = [
      at(1, "noon"), // 2026-06-15 11:00
      at(3, "morning"), // 2026-06-15 09:00
      at(13, "late"), // 2026-06-14 23:00
      at(20, "evening"), // 2026-06-14 16:00
      at(36, "early"), // 2026-06-14 00:00: same day as "late", older
      at(37, "last-of-13th"), // 2026-06-13 23:00: newest of its day, within 48 hours
      at(49, "too-old"), // 2026-06-13 11:00: past 48 hours
      at(24 * 30, "month-old"),
    ];
    expect(backupsToDelete(names, NOW)).toEqual([at(3, "morning"), at(20, "evening"), at(36, "early"), at(49, "too-old"), at(24 * 30, "month-old")].sort());
  });

  it("keeps every before-import backup within 48 hours, so each import in a session has its restore point", () => {
    const names = [
      at(1, "before-import-llm-sessions"), // 2026-06-15 11:00
      at(2, "before-import-imessage"), // 2026-06-15 10:00
      at(3, "before-tag-cleanup"), // 2026-06-15 09:00: neither newest of its day nor before an import
      at(4, "before-import-calls"), // 2026-06-15 08:00
      at(30, "before-import-whatsapp"), // 2026-06-14 06:00: not the newest of its day
      at(29, "late"), // 2026-06-14 07:00: newest of its day
      at(49, "before-import-signal"), // past 48 hours
    ];
    expect(backupsToDelete(names, NOW)).toEqual([at(3, "before-tag-cleanup"), at(49, "before-import-signal")].sort());
    // A label that only has the words elsewhere is not one.
    expect(backupsToDelete([at(2, "after-before-import-x"), at(1, "y")], NOW)).toEqual([at(2, "after-before-import-x")]);
  });

  it("uses Melbourne day boundaries, not UTC ones", () => {
    // 09:30 and 10:30 Melbourne on 15 June are 23:30 on the 14th and 00:30 on the 15th in UTC.
    const names = [at(2.5, "a"), at(1.5, "b")];
    expect(backupsToDelete(names, NOW)).toEqual([at(2.5, "a")]);
  });

  it("deletes a backup older than 48 hours even when it is the only one of its day", () => {
    expect(backupsToDelete([at(48.01)], NOW)).toEqual([at(48.01)]);
    expect(backupsToDelete([at(47.99)], NOW)).toEqual([]);
  });

  it("never deletes the backup just written", () => {
    const older = at(0.5, "older-label-sorts-first");
    const justWritten = backupName(NOW, "a-just-written");
    // Taken in the same second as another would make the other the newest by name.
    const sameSecond = backupName(NOW, "z-same-second");
    expect(backupsToDelete([older, justWritten, sameSecond], NOW, justWritten)).toEqual([older]);
    expect(backupsToDelete([at(100)], NOW, at(100))).toEqual([]);
  });

  it("ignores names that are not backups", () => {
    expect(backupsToDelete(["archive.sqlite.bak-before-merge", "notes.txt", `${at(100)}.partial`, "2026-06-15T120000-x.sqlite-wal"], NOW)).toEqual([]);
  });
});

function makeArchive(file: string): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO person (name) VALUES ('Ada'), ('Bea');");
  db.close();
}

describe("createBackup", () => {
  it("writes a checked copy to the backups folder and prunes around it", async () => {
    const archive = join(dir, "core.sqlite");
    makeArchive(archive);
    const backups = join(dir, "backups");
    await mkdir(backups);
    const stale = backupName(NOW - 50 * HOUR, "stale");
    const earlierToday = backupName(NOW - HOUR, "earlier-today");
    const beforeImport = backupName(NOW - 2 * HOUR, "before-import-calls");
    for (const name of [stale, earlierToday, beforeImport, "keep-me.sqlite"]) await writeFile(join(backups, name), "");
    await writeFile(join(dir, "archive.sqlite.bak-before-something"), "");

    const made = await createBackup(dir, backups, "Before test", { now: NOW });

    expect(made.file).toBe(join(backups, "2026-06-15T120000-before-test.sqlite"));
    expect(made.bytes).toBeGreaterThan(0);
    expect(made.pruned).toEqual([earlierToday, stale].sort());
    expect((await readdir(backups)).sort()).toEqual([beforeImport, "2026-06-15T120000-before-test.sqlite", "keep-me.sqlite"]);
    expect(await readdir(dir)).toContain("archive.sqlite.bak-before-something");
    expect(integrityCheck(made.file)).toBe("ok");
    const copy = new DatabaseSync(made.file, { readOnly: true });
    expect(copy.prepare("SELECT name FROM person ORDER BY id").all().map((row) => row.name)).toEqual(["Ada", "Bea"]);
    copy.close();
  });

  it("removes a copy that fails the integrity check, and prunes nothing", async () => {
    const archive = join(dir, "core.sqlite");
    makeArchive(archive);
    const backups = join(dir, "backups");
    await mkdir(backups);
    const stale = backupName(NOW - 50 * HOUR, "stale");
    await writeFile(join(backups, stale), "");
    await expect(createBackup(dir, backups, "x", { now: NOW, check: () => "row 3 missing from index" })).rejects.toThrow(/integrity check.*\n.*row 3/);
    expect(await readdir(backups)).toEqual([stale]);
  });

  it("copies each module's database beside the archive's, and the prune keeps or deletes them as one backup", async () => {
    const archive = join(dir, "core.sqlite");
    makeArchive(archive);
    await mkdir(join(dir, "modules", "sample"), { recursive: true });
    makeArchive(join(dir, "modules", "sample", "sample.sqlite"));
    const backups = join(dir, "backups");

    const first = await createBackup(dir, backups, "morning", { now: NOW - HOUR });
    expect(first.modules).toEqual([join(backups, "2026-06-15T110000-morning.sample.sqlite")]);
    expect(integrityCheck(first.modules[0]!)).toBe("ok");
    const copy = new DatabaseSync(first.modules[0]!, { readOnly: true });
    expect(copy.prepare("SELECT name FROM person ORDER BY id").all().map((row) => row.name)).toEqual(["Ada", "Bea"]);
    copy.close();
    expect((await readdir(backups)).sort()).toEqual(["2026-06-15T110000-morning.sample.sqlite", "2026-06-15T110000-morning.sqlite"]);

    const second = await createBackup(dir, backups, "noon", { now: NOW });
    expect(second.pruned).toEqual(["2026-06-15T110000-morning.sample.sqlite", "2026-06-15T110000-morning.sqlite"]);
    expect((await readdir(backups)).sort()).toEqual(["2026-06-15T120000-noon.sample.sqlite", "2026-06-15T120000-noon.sqlite"]);
    expect(await pruneBackups(backups, { now: NOW + 49 * HOUR })).toEqual(["2026-06-15T120000-noon.sample.sqlite", "2026-06-15T120000-noon.sqlite"]);
  });

  it("removes a module's copy that fails the integrity check, and prunes nothing", async () => {
    const archive = join(dir, "core.sqlite");
    makeArchive(archive);
    await mkdir(join(dir, "modules", "sample"), { recursive: true });
    makeArchive(join(dir, "modules", "sample", "sample.sqlite"));
    const backups = join(dir, "backups");
    await mkdir(backups);
    const stale = backupName(NOW - 50 * HOUR, "stale");
    await writeFile(join(backups, stale), "");
    const check = (file: string) => (file.includes(".sample.") ? "row 3 missing from index" : "ok");
    await expect(createBackup(dir, backups, "x", { now: NOW, check })).rejects.toThrow(/integrity check.*\n.*row 3/);
    expect((await readdir(backups)).filter((name) => name.includes(".sample."))).toEqual([]);
    expect(await readdir(backups)).toContain(stale);
  });

  it("refuses when there is no archive", async () => {
    await expect(createBackup(join(dir, "missing"), join(dir, "backups"), "x")).rejects.toThrow(/no archive/);
  });
});

describe("pruneBackups", () => {
  it("lists without deleting on a dry run, and treats a missing folder as empty", async () => {
    const stale = backupName(NOW - 50 * HOUR, "stale");
    await writeFile(join(dir, stale), "");
    expect(await pruneBackups(dir, { now: NOW, dryRun: true })).toEqual([stale]);
    expect(await readdir(dir)).toEqual([stale]);
    expect(await pruneBackups(dir, { now: NOW })).toEqual([stale]);
    expect(await readdir(dir)).toEqual([]);
    expect(await pruneBackups(join(dir, "nowhere"))).toEqual([]);
  });
});

describe("npm run archive -- backup", () => {
  const run = async (...args: string[]) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", CLI, ...args, "--data", dir]);
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
      return { code, stdout, stderr };
    }
  };

  it("takes a backup of the archive without opening it for writing", async () => {
    makeArchive(join(dir, "core.sqlite"));
    const result = await run("backup", "before", "cli", "test");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Backed up to .*backups\/\d{4}-\d{2}-\d{2}T\d{6}-before-cli-test\.sqlite \(.* MB\), integrity ok\./);
    // The archive was copied as it was, not brought up to the app's schema first.
    const archive = new DatabaseSync(join(dir, "core.sqlite"), { readOnly: true });
    expect(archive.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    archive.close();
  });

  it("prunes, or lists what would go, and fails without a label or archive", async () => {
    await mkdir(join(dir, "backups"));
    const stale = backupName(Date.now() - 50 * HOUR, "stale");
    await writeFile(join(dir, "backups", stale), "");
    expect((await run("backup", "--prune", "--dry-run")).stdout).toContain(`Would delete ${join(dir, "backups", stale)}`);
    expect(await readdir(join(dir, "backups"))).toEqual([stale]);
    expect((await run("backup", "--prune")).stdout).toContain("1 deleted.");
    expect(await readdir(join(dir, "backups"))).toEqual([]);

    expect(await run("backup")).toMatchObject({ code: 1, stderr: expect.stringMatching(/label/) });
    expect(await run("backup", "x")).toMatchObject({ code: 1, stderr: expect.stringMatching(/no archive/) });
  });
});
