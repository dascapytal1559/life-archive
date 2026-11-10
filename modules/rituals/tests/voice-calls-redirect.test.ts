// bin/ritual-voice-calls, which the launchd agent rituals installed still runs by its path, hands its run to the journal
// module's Grok calls job, arguments and all, and prints that job's one JSON line: on a made-up, empty cache, and on a
// journal home with no raw/ folder, which the job refuses.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO } from "./helpers/fixtures.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-voice-calls-"));
  fs.mkdirSync(path.join(root, "cache"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (journals: string) =>
  spawnSync("/bin/sh", [path.join(REPO, "bin", "ritual-voice-calls"), "--cache", path.join(root, "cache"), "--journals", journals, "--provider", "grok-bot"], {
    env: { ...process.env, RITUAL_NODE: process.execPath },
    encoding: "utf8",
  });

describe("bin/ritual-voice-calls", () => {
  it("runs the journal's Grok calls job with the arguments it was given", () => {
    const journals = path.join(root, "Journals");
    fs.mkdirSync(path.join(journals, "raw"), { recursive: true });
    const outcome = run(journals);
    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toBe("");
    expect(JSON.parse(outcome.stdout)).toEqual({ ok: true, cached_calls: 0, unchanged: 0, saved: [] });
  });

  it("prints the job's refusal as one JSON line and exits 1", () => {
    const outcome = run(path.join(root, "no-journal"));
    expect(outcome.status).toBe(1);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, error: expect.stringContaining("No raw folder") });
  });
});
