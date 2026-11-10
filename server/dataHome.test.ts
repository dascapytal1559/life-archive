// Where the archive's folder is (dataHome.ts): from the environment, then .env.local, then
// ~/life-archive-data, LIFE_ARCHIVE_DATA or its old name FRIEND_MAP_DATA. Every folder here is made
// up, under a temporary one, and the one in the home folder is only ever named, never made or read.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveFolder, archiveUrl, envSetting, jobNode, jobPath, pathSetting, sameFolder } from "./dataHome.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-data-home-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const envLocal = (text: string) => writeFile(join(root, ".env.local"), text);

describe("archiveFolder", () => {
  const home = join(homedir(), "life-archive-data");

  it("is ~/life-archive-data, out of the checkout, with nothing set", () => {
    expect(archiveFolder({ root, env: {} })).toBe(home);
  });

  it("stays on a checkout's real data/ until that has moved, so code landed before the move finds the archive where it is", async () => {
    await mkdir(join(root, "data"));
    expect(archiveFolder({ root, env: {} })).toBe(join(root, "data"));
  });

  it("does not go through the link the move leaves at data/, even a broken one", async () => {
    await mkdir(join(root, "moved"));
    await symlink(join(root, "moved"), join(root, "data"));
    expect(archiveFolder({ root, env: {} })).toBe(home);
    await rm(join(root, "moved"), { recursive: true });
    expect(archiveFolder({ root, env: {} })).toBe(home);
  });

  it("keeps a linked git worktree off the real archive: its own data/, there or not", async () => {
    await writeFile(join(root, ".git"), "gitdir: /srv/life-archive/.git/worktrees/one\n");
    expect(archiveFolder({ root, env: {} })).toBe(join(root, "data"));
    await envLocal("LIFE_ARCHIVE_DATA=/srv/named\n");
    expect(archiveFolder({ root, env: {} })).toBe("/srv/named");
  });

  it("takes a main checkout's .git, a folder, as the install it is", async () => {
    await mkdir(join(root, ".git"));
    expect(archiveFolder({ root, env: {} })).toBe(home);
  });

  it("reads .env.local, so nothing need be exported", async () => {
    await envLocal("LIFE_ARCHIVE_ALLOWED_HOSTS=example.test\n# the life archive\nLIFE_ARCHIVE_DATA=/srv/life-archive/data\n");
    expect(archiveFolder({ root, env: {} })).toBe("/srv/life-archive/data");
  });

  it("takes .env.local's paths from the repository, and ~/ as the home folder, quoted or not", async () => {
    await envLocal("LIFE_ARCHIVE_DATA=own\n");
    expect(archiveFolder({ root, env: {} })).toBe(join(root, "own"));
    await envLocal('LIFE_ARCHIVE_DATA="~/life-archive/data"\n');
    expect(archiveFolder({ root, env: {} })).toBe(join(homedir(), "life-archive", "data"));
  });

  it("takes FRIEND_MAP_DATA, its old name, after LIFE_ARCHIVE_DATA", async () => {
    await envLocal("FRIEND_MAP_DATA=/srv/friend-map\n");
    expect(archiveFolder({ root, env: {} })).toBe("/srv/friend-map");
    await envLocal("FRIEND_MAP_DATA=/srv/friend-map\nLIFE_ARCHIVE_DATA=/srv/life-archive\n");
    expect(archiveFolder({ root, env: {} })).toBe("/srv/life-archive");
    expect(archiveFolder({ root, env: { FRIEND_MAP_DATA: "/tmp/old", LIFE_ARCHIVE_DATA: "/tmp/new" } })).toBe("/tmp/new");
  });

  it("reads the environment before .env.local", async () => {
    await envLocal("LIFE_ARCHIVE_DATA=/srv/life-archive\n");
    expect(archiveFolder({ root, env: { LIFE_ARCHIVE_DATA: "/tmp/archive" } })).toBe("/tmp/archive");
  });

  it("runs on a testing folder alone when the environment names it by either name, whatever .env.local names", async () => {
    await envLocal("LIFE_ARCHIVE_DATA=/srv/life-archive\n");
    expect(archiveFolder({ root, env: { FRIEND_MAP_DATA: "/tmp/friend-map-testing" } })).toBe("/tmp/friend-map-testing");
  });

  it("passes over a setting left empty", async () => {
    await envLocal("LIFE_ARCHIVE_DATA=/srv/life-archive\n");
    expect(archiveFolder({ root, env: { FRIEND_MAP_DATA: "", LIFE_ARCHIVE_DATA: "" } })).toBe("/srv/life-archive");
    await envLocal("LIFE_ARCHIVE_DATA=\n");
    expect(archiveFolder({ root, env: {} })).toBe(join(homedir(), "life-archive-data"));
  });
});

describe("envSetting and archiveUrl", () => {
  it("read the environment, then .env.local, passing over a setting left empty", async () => {
    await envLocal("LIFE_ARCHIVE_URL=http://127.0.0.1:4651\nLIFE_ARCHIVE_ALLOWED_HOSTS=\n");
    expect(envSetting("LIFE_ARCHIVE_URL", { root, env: {} })).toBe("http://127.0.0.1:4651");
    expect(envSetting("LIFE_ARCHIVE_URL", { root, env: { LIFE_ARCHIVE_URL: "http://127.0.0.1:4652" } })).toBe("http://127.0.0.1:4652");
    expect(envSetting("LIFE_ARCHIVE_ALLOWED_HOSTS", { root, env: {} })).toBeUndefined();
    expect(archiveUrl({ root, env: { LIFE_ARCHIVE_URL: "" } })).toBe("http://127.0.0.1:4651");
  });

  it("put the archive's server on port 4650 of this Mac, with nothing set", () => {
    expect(archiveUrl({ root, env: {} })).toBe("http://127.0.0.1:4650");
  });

  it("read a path setting's ~/ as the home folder", () => {
    expect(pathSetting("FIRSTMATE_HOME", { root, env: { FIRSTMATE_HOME: "~/firstmate" } })).toBe(join(homedir(), "firstmate"));
    expect(pathSetting("FIRSTMATE_HOME", { root, env: {} })).toBeUndefined();
  });

  it("run a job's agent on LIFE_ARCHIVE_NODE, else this Node, that Node's folder first on its PATH", () => {
    expect(jobNode({ root, env: {} })).toBe(process.execPath);
    expect(jobNode({ root, env: { LIFE_ARCHIVE_NODE: "~/shims/node" } })).toBe(join(homedir(), "shims", "node"));
    expect(jobPath("/opt/shims/node", "/opt/tools").split(":").slice(0, 3)).toEqual(["/opt/shims", "/opt/tools", "/opt/homebrew/bin"]);
  });
});

describe("sameFolder", () => {
  it("is one folder however it is reached, and paths that do not exist as written", async () => {
    await mkdir(join(root, "archive"));
    await symlink(join(root, "archive"), join(root, "link"));
    expect(sameFolder(join(root, "link"), join(root, "archive", "."))).toBe(true);
    expect(sameFolder(join(root, "archive"), join(root, "other"))).toBe(false);
    expect(sameFolder(join(root, "gone", "x", ".."), join(root, "gone"))).toBe(true);
  });
});
