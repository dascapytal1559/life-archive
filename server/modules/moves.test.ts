// A module's files moved from where they were kept before modules kept theirs in modules/<id>/ (moves.ts): where each
// is read, and the move, explicit and backed up, on made-up folders in a temporary folder alone; and the move run by
// `npm run archive -- migrate module-data` on a made-up archive's folder laid out as an old one is.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { movedPath, moveModuleData, pendingMoveLines, planModuleMoves } from "./moves.ts";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-archive-moves-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const RECORDS = { from: "records", to: "." };
const TARGETS = { from: "targets.json", to: "targets.json" };
const modules = [{ id: "sample", moves: [RECORDS] }, { id: "other", moves: [TARGETS] }];

describe("where a moved file is read", () => {
  it("is its new place in a new archive, its old one while that is there, and its new one once it is there", async () => {
    expect(movedPath(folder, "other", TARGETS)).toBe(join(folder, "modules", "other", "targets.json"));
    await writeFile(join(folder, "targets.json"), "{}");
    expect(movedPath(folder, "other", TARGETS)).toBe(join(folder, "targets.json"));
    await mkdir(join(folder, "modules", "other"), { recursive: true });
    await writeFile(join(folder, "modules", "other", "targets.json"), "{}");
    expect(movedPath(folder, "other", TARGETS)).toBe(join(folder, "modules", "other", "targets.json"));
  });

  it("takes an empty folder at the new place for none, so an old folder is still read", async () => {
    await mkdir(join(folder, "records"));
    await writeFile(join(folder, "records", "a.json"), "{}");
    await mkdir(join(folder, "modules", "sample"), { recursive: true });
    expect(movedPath(folder, "sample", RECORDS)).toBe(join(folder, "records"));
    await writeFile(join(folder, "modules", "sample", "a.json"), "{}");
    expect(movedPath(folder, "sample", RECORDS)).toBe(join(folder, "modules", "sample"));
  });
});

describe("the move", () => {
  it("says what it would move and moves nothing in a dry run, and the server's start says the same", async () => {
    await mkdir(join(folder, "records"));
    await writeFile(join(folder, "records", "a.json"), "made-up");
    const planned = planModuleMoves(folder, modules);
    expect(planned.map((m) => m.state)).toEqual(["move", "none"]);
    expect(await moveModuleData(folder, planned, { apply: false })).toEqual([
      "sample: would move records to modules/sample.",
      "A dry run: nothing was moved. Run it again with --apply to move them after a backup.",
    ]);
    expect(existsSync(join(folder, "records", "a.json"))).toBe(true);
    expect(pendingMoveLines(folder, planned)).toEqual(["sample reads records at its old place: npm run archive -- migrate module-data moves it to modules/sample"]);
  });

  it("copies each into backups-kept first, checks the copy, then moves it whole, links and nested folders with it; again, nothing", async () => {
    await mkdir(join(folder, "records", "old"), { recursive: true });
    await writeFile(join(folder, "records", "a.json"), "made-up a");
    await writeFile(join(folder, "records", "old", "b.json"), "made-up b");
    await symlink("a.json", join(folder, "records", "link.json"));
    await writeFile(join(folder, "targets.json"), "made-up targets");
    // A module folder already there with its database in it: the file goes in beside it.
    await mkdir(join(folder, "modules", "other"), { recursive: true });
    await writeFile(join(folder, "modules", "other", "other.sqlite"), "");

    const now = Date.UTC(2026, 10, 8, 1, 2, 3);
    const lines = await moveModuleData(folder, planModuleMoves(folder, modules), { apply: true, now });
    const [backup] = await readdir(join(folder, "backups-kept"));
    expect(backup).toMatch(/^2026-11-08T\d{6}-before-module-data$/);
    expect(lines).toEqual([
      `sample: moved records to modules/sample (4 entries), after a checked copy in backups-kept/${backup}/records.`,
      `other: moved targets.json to modules/other/targets.json (1 entry), after a checked copy in backups-kept/${backup}/targets.json.`,
    ]);
    expect(existsSync(join(folder, "records"))).toBe(false);
    expect(existsSync(join(folder, "targets.json"))).toBe(false);
    expect(await readFile(join(folder, "modules", "sample", "old", "b.json"), "utf8")).toBe("made-up b");
    expect(await readFile(join(folder, "modules", "sample", "link.json"), "utf8")).toBe("made-up a");
    expect(await readFile(join(folder, "modules", "other", "targets.json"), "utf8")).toBe("made-up targets");
    expect(await readFile(join(folder, "backups-kept", backup!, "records", "old", "b.json"), "utf8")).toBe("made-up b");
    expect(await readFile(join(folder, "backups-kept", backup!, "targets.json"), "utf8")).toBe("made-up targets");

    expect(await moveModuleData(folder, planModuleMoves(folder, modules), { apply: true, now: now + 5_000 })).toEqual([
      "sample: modules/sample is in its place already.",
      "other: modules/other/targets.json is in its place already.",
      "Nothing to move.",
    ]);
    expect(await readdir(join(folder, "backups-kept"))).toEqual([backup]);
  });

  it("takes a folder holding only what Finder leaves for none: the old one is read, moved, and nothing refused", async () => {
    await mkdir(join(folder, "records"));
    await writeFile(join(folder, "records", "a.json"), "made-up a");
    await mkdir(join(folder, "modules", "sample"), { recursive: true });
    await writeFile(join(folder, "modules", "sample", ".DS_Store"), "made-up Finder bytes");
    expect(movedPath(folder, "sample", RECORDS)).toBe(join(folder, "records"));
    const planned = planModuleMoves(folder, [{ id: "sample", moves: [RECORDS] }]);
    expect(planned.map((m) => m.state)).toEqual(["move"]);
    expect(pendingMoveLines(folder, planned)).toEqual([expect.stringMatching(/^sample reads records at its old place/)]);
    await moveModuleData(folder, planned, { apply: true });
    expect(await readdir(join(folder, "modules", "sample"))).toEqual(["a.json"]);
    expect(await readFile(join(folder, "modules", "sample", "a.json"), "utf8")).toBe("made-up a");
    expect(existsSync(join(folder, "records"))).toBe(false);
  });

  it("refuses, moving nothing, while a file is at both places", async () => {
    await writeFile(join(folder, "targets.json"), "made-up old");
    await mkdir(join(folder, "modules", "other"), { recursive: true });
    await writeFile(join(folder, "modules", "other", "targets.json"), "made-up new");
    await mkdir(join(folder, "records"));
    await writeFile(join(folder, "records", "a.json"), "made-up");
    const planned = planModuleMoves(folder, modules);
    expect(pendingMoveLines(folder, planned)).toContainEqual(expect.stringMatching(/^other has both targets.json and modules\/other\/targets.json, and reads the second/));
    await expect(moveModuleData(folder, planned, { apply: true })).rejects.toThrow("other: both targets.json and modules/other/targets.json are there, so nothing was moved");
    expect(existsSync(join(folder, "records", "a.json"))).toBe(true);
    expect(existsSync(join(folder, "backups-kept"))).toBe(false);
  });
});

describe("npm run archive -- migrate module-data", () => {
  it("moves health's records and exercise's settings of a made-up archive laid out as before, after a dry run", async () => {
    const script = fileURLToPath(new URL("../archive/cli.ts", import.meta.url));
    const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, ["--no-warnings", script, "migrate", "module-data", ...args, "--data", folder])).stdout;
    await mkdir(join(folder, "health"));
    await writeFile(join(folder, "health", "lab-intervals.json"), JSON.stringify({ version: 1, labs: [] }));
    await writeFile(join(folder, "exercise.json"), JSON.stringify({ zone2WeeklyMinutes: 150 }));

    const dry = await run();
    expect(dry).toContain("health: would move health to modules/health.");
    expect(dry).toContain("exercise: would move exercise.json to modules/exercise/exercise.json.");
    expect(existsSync(join(folder, "health", "lab-intervals.json"))).toBe(true);

    const applied = await run("--apply");
    expect(applied).toMatch(/health: moved health to modules\/health \(1 entry\), after a checked copy in backups-kept\/.*-before-module-data\/health\./);
    expect(JSON.parse(await readFile(join(folder, "modules", "exercise", "exercise.json"), "utf8"))).toEqual({ zone2WeeklyMinutes: 150 });
    expect(existsSync(join(folder, "modules", "health", "lab-intervals.json"))).toBe(true);
    expect(existsSync(join(folder, "health"))).toBe(false);
    expect(await run()).toContain("Nothing to move.");
  });
});
