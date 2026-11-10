// A module's command takes --data <dir> (sdk/command.ts reads it first, server/onDataFlag.ts) and its own strict
// parseArgs takes it too (DATA_OPTION), rather than refusing it as an unknown option. Run on a made-up empty folder,
// with a command that only prints its usage.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const HEALTH = fileURLToPath(new URL("../modules/health/cli.ts", import.meta.url));

it("lets a module's command be given --data, as every entry point is", async () => {
  const folder = await mkdtemp(join(tmpdir(), "life-archive-data-flag-"));
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--no-warnings", HEALTH, "help", "--data", folder], { env: { ...process.env, LIFE_ARCHIVE_DATA: folder } });
    expect(stderr).toBe("");
    expect(stdout).toMatch(/^Usage: npm run health/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
