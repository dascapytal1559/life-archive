// The folder history's command (commands.ts) and what the module declares (../module.ts), on a made-up folder in a
// temporary folder: never a real Drive folder.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPromise } from "../../../sdk/server.ts";
import definition from "../module.ts";
import { historyCommand } from "./commands.ts";
import { historyDir, openHistory, record, SETTINGS_FILE } from "./folderHistory.ts";

let dir: string;
let dataDir: string;
let folder: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-folder-history-cli-"));
  dataDir = join(dir, "data");
  folder = join(dir, "shared", "notes");
  await mkdir(folder, { recursive: true });
  await mkdir(join(dataDir, "connectors"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What the command prints, given its folder argument and options. */
async function printed(name?: string, values: { last?: unknown } = {}): Promise<string[]> {
  const lines: string[] = [];
  await historyCommand(dataDir, name, values, (line) => lines.push(line));
  return lines;
}

describe("npm run archive -- history", () => {
  it("says no folder is named when the settings name none", async () => {
    expect(await printed()).toEqual([`folder-history: no folders named (data/${SETTINGS_FILE})`]);
  });

  it("says each folder's state, and one folder's last commits with their files", async () => {
    await writeFile(join(dataDir, SETTINGS_FILE), JSON.stringify({ folders: [{ name: "notes", path: folder }] }));
    await writeFile(join(folder, "todo.md"), "one");
    const repo = historyDir(dataDir, "notes");
    await runPromise(openHistory(repo));
    await runPromise(record(repo, folder));
    await writeFile(join(folder, "plan.md"), "two");

    const all = await printed();
    expect(all[0]).toBe("folder-history: notes");
    expect(all).toContainEqual(expect.stringMatching(/^  history: .*, 1 commit, the last .* \(1 file\)$/));
    expect(all).toContainEqual("  1 change not in the history yet (the server records them seconds after the folder settles): added plan.md");

    const one = await printed("notes", { last: "5" });
    expect(one.slice(-2)).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  [0-9a-f]{7}  1 file$/), "  added todo.md"]);
  });

  it("refuses a folder the settings do not name, and a --last that is no number of commits", async () => {
    await writeFile(join(dataDir, SETTINGS_FILE), JSON.stringify({ folders: [{ name: "notes", path: folder }] }));
    await expect(printed("other")).rejects.toThrow(`no folder other in data/${SETTINGS_FILE}; the folders are notes`);
    await expect(printed("notes", { last: "none" })).rejects.toThrow("--last takes a number of commits");
  });
});

describe("the module", () => {
  it("keeps the histories as its work, and answers history among the archive's commands", () => {
    expect(definition.id).toBe("folder-history");
    expect(definition.work).toBeTypeOf("function");
    expect(definition.commands?.names).toEqual(["history"]);
    expect(definition.commands?.help?.structure).toMatch(/^  history \[<folder>\] \[--last <n>\]/);
  });
});
