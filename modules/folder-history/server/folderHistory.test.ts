import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { runBackground, runPromise } from "../../../sdk/server.ts";
import {
  commitMessage,
  conflictCopies,
  folderFiles,
  folderReport,
  historyDir,
  keepFolder,
  keepHistories,
  openHistory,
  parseSettings,
  recentCommits,
  record,
  skipped,
  SETTINGS_FILE,
} from "./folderHistory.ts";

// Every folder here is a made-up one in a temporary folder: never a real Drive folder.
let dir: string;
let folder: string;
let dataDir: string;
let repo: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-folder-history-"));
  folder = join(dir, "shared", "notes");
  dataDir = join(dir, "data");
  repo = historyDir(dataDir, "notes");
  await mkdir(folder, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
  await mkdir(join(folder, path, ".."), { recursive: true });
  await writeFile(join(folder, path), text);
};

/** The history's own git, as a person would run it on the repository. */
const git = (...args: string[]) => execFileSync("git", ["--git-dir", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

/** Every file and folder under `root`, with its size and when it last changed, to show nothing was written there. */
async function listing(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const s = await stat(join(root, name));
    found.push(`${name} ${s.size} ${s.mtimeMs}`);
  }
  return found;
}

async function until(done: () => boolean | Promise<boolean>, what: string, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("what a folder's history keeps", () => {
  it("leaves out hidden files, Drive's and Office's temporary files, and never enters a hidden folder", async () => {
    expect(["todo.md", "plan (1).md", "Icon\r", ".DS_Store", ".tmp.drivedownload", "~$plan.docx", "upload.tmp"].filter((name) => !skipped(name))).toEqual([
      "todo.md", "plan (1).md",
    ]);
    await write("todo.md", "milk\n");
    await write("journal/2026-01-02.md", "a day\n");
    await write(".DS_Store", "finder");
    await write(".tmp.driveupload/123", "partial");
    await write("site/.cache/x.json", "{}");
    await write("~$plan.docx", "owner");
    expect(await folderFiles(folder)).toEqual(["journal/2026-01-02.md", "todo.md"]);
  });

  it("finds Drive's numbered conflict copies only beside the file they copy", () => {
    expect(conflictCopies(["todo.md", "todo (1).md", "todo (2).md", "plan (1).md", "notes/a b (3).txt", "notes/a b.txt", "README", "README (1)"])).toEqual([
      { copy: "todo (1).md", of: "todo.md" },
      { copy: "todo (2).md", of: "todo.md" },
      { copy: "notes/a b (3).txt", of: "notes/a b.txt" },
      { copy: "README (1)", of: "README" },
    ]);
  });

  it("says each file changed in the commit's message", () => {
    expect(commitMessage([{ change: "added", path: "a.md" }, { change: "changed", path: "b.md" }, { change: "added", path: "c.md" }])).toBe(
      "3 files: 2 added, 1 changed\n\nadded a.md\nchanged b.md\nadded c.md\n",
    );
  });

  it("checks its settings", () => {
    expect(parseSettings({}).folders).toEqual([]);
    expect(parseSettings({ folders: [{ name: "notes", path: "~/notes" }] })).toMatchObject({ settleMs: 3_000, maxWaitMs: 30_000, rescanMs: 3_600_000 });
    expect(() => parseSettings({ folders: [{ name: "notes folder", path: "/x" }] })).toThrow(/lower-case/);
    expect(() => parseSettings({ folders: [{ name: "notes", path: "/x" }, { name: "notes", path: "/y" }] })).toThrow(/two folders/);
    expect(() => parseSettings({ folders: [{ name: "notes" }] })).toThrow(/needs a path/);
  });
});

describe("a record of the folder", () => {
  it.live("commits additions, edits and deletions, exactly the folder's files, without writing into it", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await write("todo.md", "milk\n");
        await write("journal/2026-01-02.md", "a day\n");
        await write(".DS_Store", "finder");
        // The folder's own ignore rules are not the history's: every file is kept.
        await write(".gitignore", "journal/\n");
      });
      yield* openHistory(repo);
      const before = yield* Effect.promise(() => listing(folder));

      const first = yield* record(repo, folder);
      expect(first.changes).toEqual([{ change: "added", path: "journal/2026-01-02.md" }, { change: "added", path: "todo.md" }]);
      expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean)).toEqual(["journal/2026-01-02.md", "todo.md"]);

      // Nothing changed: no commit.
      expect((yield* record(repo, folder)).commit).toBeNull();

      yield* Effect.promise(async () => {
        await write("todo.md", "milk\neggs\n");
        await write("birth-plan.md", "calm\n");
        await unlink(join(folder, "journal/2026-01-02.md"));
      });
      const second = yield* record(repo, folder);
      expect(second.changes).toEqual([
        { change: "added", path: "birth-plan.md" },
        { change: "deleted", path: "journal/2026-01-02.md" },
        { change: "changed", path: "todo.md" },
      ]);
      expect(git("log", "-1", "--format=%B")).toBe("3 files: 1 added, 1 changed, 1 deleted\n\nadded birth-plan.md\ndeleted journal/2026-01-02.md\nchanged todo.md\n\n");
      expect(git("show", "HEAD:todo.md")).toBe("milk\neggs\n");
      expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");

      const commits = yield* recentCommits(repo, 10);
      expect(commits[0].commit).toBe(second.commit);
      expect(Math.abs(commits[0].at - Date.now())).toBeLessThan(60_000);
      expect(commits.map((c) => c.changes.map((f) => `${f.change} ${f.path}`))).toEqual([
        ["added birth-plan.md", "deleted journal/2026-01-02.md", "changed todo.md"],
        ["added journal/2026-01-02.md", "added todo.md"],
      ]);

      // The folder is as it was but for the test's own changes: nothing of git's is in it.
      const after = yield* Effect.promise(() => listing(folder));
      expect(after.filter((line) => /^\.|\/\./.test(line))).toEqual(before.filter((line) => /^\.|\/\./.test(line)));
      expect(after.some((line) => line.includes(".git/") || line.startsWith(".git "))).toBe(false);
    }));

  it.live("reads the folder through a link to it, as Drive's shortcut is", () =>
    Effect.gen(function* () {
      const shortcut = join(dir, "shortcuts", "notes");
      yield* Effect.promise(async () => {
        await mkdir(join(dir, "shortcuts"));
        await symlink(folder, shortcut);
        await write("todo.md", "milk\n");
      });
      yield* openHistory(repo);
      expect((yield* record(repo, shortcut)).changes).toEqual([{ change: "added", path: "todo.md" }]);
    }));

  it.live("records nothing, not even as deleted, while the folder is not there", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => write("todo.md", "milk\n"));
      yield* openHistory(repo);
      yield* record(repo, folder);
      yield* Effect.promise(() => rm(folder, { recursive: true }));
      const error = yield* Effect.flip(record(repo, folder));
      expect(error._tag).toBe("FolderMissing");
      expect(git("ls-tree", "-r", "--name-only", "HEAD").trim()).toBe("todo.md");
    }));

  it.live("is refused while the history has a remote", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => write("todo.md", "milk\n"));
      yield* openHistory(repo);
      git("remote", "add", "origin", "https://example.invalid/notes.git");
      expect((yield* Effect.flip(openHistory(repo)))._tag).toBe("HistoryHasRemote");
      const refused = yield* Effect.flip(record(repo, folder));
      expect(refused._tag).toBe("HistoryHasRemote");
      expect(refused.message).toMatch(/origin/);
      expect(() => git("rev-parse", "HEAD")).toThrow();

      // Kept live, it says so and keeps nothing.
      const lines: string[] = [];
      yield* keepFolder(dataDir, { name: "notes", path: folder }, { settleMs: 50, maxWaitMs: 200, rescanMs: 60_000 }, (line) => lines.push(line));
      expect(lines).toEqual([expect.stringMatching(/^notes: not kept: .* has a remote \(origin\)/)]);
    }));

  it.live("will not take over a folder that is not a history", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(repo, { recursive: true });
        await writeFile(join(repo, "something.txt"), "else");
      });
      expect((yield* Effect.flip(openHistory(repo)))._tag).toBe("FolderHistoryError");
    }));
});

describe("the history kept live", () => {
  it("records when it starts, then once for a burst of changes after they settle", async () => {
    await write("todo.md", "milk\n");
    const lines: string[] = [];
    const running = runBackground(keepFolder(dataDir, { name: "notes", path: folder }, { settleMs: 300, maxWaitMs: 5_000, rescanMs: 60_000 }, (line) => lines.push(line)).pipe(Effect.orDie));
    try {
      const commits = () => runPromise(recentCommits(repo, 50).pipe(Effect.orElseSucceed(() => [])));
      await until(async () => (await commits()).length === 1, "the first record");

      // macOS tells fs.watch of a change late when the machine is busy (seconds late beside the rest of the suite and
      // other work), and in the order the changes were made. Change a file until a record of it lands, so every event
      // from before has been told, and let any late one go by (it records nothing new) before the burst.
      for (let i = 0; (await commits()).length === 1; i++) {
        if (i === 8) throw new Error("timed out waiting for the watcher to hear a change");
        await write("ready.md", `${i}\n`);
        try {
          await until(async () => (await commits()).length > 1, "a record of ready.md", 250);
        } catch {
          // Not heard yet: change it again.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const before = (await commits()).length;

      // Three changes 50 ms apart are one commit, once they have been quiet for settleMs.
      await write("todo.md", "milk\neggs\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await write("plan.md", "calm\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await write("plan (1).md", "calm, too\n");
      await until(async () => (await commits()).length === before + 1, "the burst's record", 2_000);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const all = await commits();
      expect(all).toHaveLength(before + 1);
      expect(all[0].changes.map((f) => `${f.change} ${f.path}`)).toEqual(["added plan (1).md", "added plan.md", "changed todo.md"]);
      expect(lines).toContainEqual("notes: 1 Drive conflict copy: plan (1).md (beside plan.md)");
      expect(lines.filter((line) => line.startsWith("notes: recorded"))).toHaveLength(before + 1);
    } finally {
      await runPromise(Fiber.interrupt(running));
    }
  }, 120_000);

  it("keeps nothing when no settings name a folder", async () => {
    const lines: string[] = [];
    await runPromise(keepHistories(dataDir, (line) => lines.push(line)));
    expect(lines).toEqual([]);
  });

  it("says when the settings cannot be read", async () => {
    await mkdir(join(dataDir, "connectors"), { recursive: true });
    await writeFile(join(dataDir, SETTINGS_FILE), JSON.stringify({ folders: [{ name: "Notes!" }] }));
    const lines: string[] = [];
    await runPromise(keepHistories(dataDir, (line) => lines.push(line)));
    expect(lines).toEqual([expect.stringMatching(/^not kept: data\/connectors\/folder-history.json: each folder needs a name/)]);
  });
});

describe("a folder's report", () => {
  it.live("says the commits, what the next record would commit, and the conflict copies, writing nothing", () =>
    Effect.gen(function* () {
      const notes = { name: "notes", path: folder };
      // No history yet: none is made.
      expect(yield* folderReport(dataDir, notes)).toMatchObject({ commits: 0, last: null, problem: null });
      expect(yield* Effect.promise(() => stat(repo).then(() => true, () => false))).toBe(false);

      yield* Effect.promise(async () => {
        await write("todo.md", "milk\n");
        await write("old.md", "gone soon\n");
      });
      yield* openHistory(repo);
      yield* record(repo, folder);
      yield* Effect.promise(async () => {
        await write("todo.md", "milk\neggs\n");
        await write("todo (1).md", "milk\n");
        await unlink(join(folder, "old.md"));
      });
      const report = yield* folderReport(dataDir, notes);
      expect(report).toMatchObject({ commits: 1, resolved: expect.stringContaining("notes"), problem: null });
      expect(report.last?.changes).toEqual([{ change: "added", path: "old.md" }, { change: "added", path: "todo.md" }]);
      expect(report.pending).toEqual([
        { change: "added", path: "todo (1).md" },
        { change: "changed", path: "todo.md" },
        { change: "deleted", path: "old.md" },
      ]);
      expect(report.conflicts).toEqual([{ copy: "todo (1).md", of: "todo.md" }]);
      expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");

      git("remote", "add", "backup", "https://example.invalid/notes.git");
      expect((yield* folderReport(dataDir, notes)).problem).toMatch(/has a remote \(backup\)/);
      yield* Effect.promise(() => rm(folder, { recursive: true }));
      expect((yield* folderReport(dataDir, notes)).resolved).toEqual({ missing: `${folder} is not there` });
    }));
});
