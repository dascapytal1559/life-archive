// The Grok calls job's launchd agent and its install's dry run, on made-up folders: the agent keeps the label it had as
// rituals' and runs the journal's command; install takes a folder with the core's database (core.sqlite) as an archive
// and refuses one with none, writing and loading nothing in a dry run.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../../../sdk/server.ts";
import { install } from "./command.ts";
import { LAUNCHD_LABEL, plist, program } from "./live.ts";

const job = { node: "/opt/node/bin/node", repo: "/checkout", cache: "/cache dir", journals: "/data/Vault/Journals", logFile: "/logs/voice-calls.log" };

describe("the Grok calls job's agent", () => {
  it("keeps rituals' label and runs the journal's command with the cache, the journals and the provider", () => {
    expect(LAUNCHD_LABEL).toBe("local.life-archive-voice-calls");
    expect(program(job)).toEqual([
      "/opt/node/bin/node", "--no-warnings", "/checkout/modules/journal/cli.ts", "grok-calls", "--cache", "/cache dir", "--journals", "/data/Vault/Journals", "--provider", "grok-bot",
    ]);
    const text = plist(job);
    expect(text).toContain("<key>Label</key><string>local.life-archive-voice-calls</string>");
    expect(text).toContain("<key>StartInterval</key><integer>1800</integer>");
    expect(text).toContain("<key>WatchPaths</key><array><string>/cache dir</string></array>");
    expect(text).toContain("<key>StandardOutPath</key><string>/logs/voice-calls.log</string>");
  });
});

describe("grok-calls install", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "grok-calls-install-"));
    vi.stubEnv("LIFE_ARCHIVE_DATA", root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await mkdir(join(root, settings().vault.folder, "Journals", "raw"), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("takes a folder that holds core.sqlite, with friend map's database under modules/", async () => {
    await writeFile(join(root, "core.sqlite"), "");
    await mkdir(join(root, "modules", "friend-map"), { recursive: true });
    await writeFile(join(root, "modules", "friend-map", "archive.sqlite"), "");
    await expect(install({ dryRun: true })).resolves.toBeUndefined();
  });

  it("refuses a folder with no core.sqlite", async () => {
    await expect(install({ dryRun: true })).rejects.toThrow(/there is no core\.sqlite in/);
  });
});
