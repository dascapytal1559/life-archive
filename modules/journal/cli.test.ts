// `npm run journal` (cli.ts) chooses its job from the first word that is no option, wherever `--data <dir>` stands, on
// a made-up archive's folder of its own: a word grok-calls does not know is answered by grok-calls, not taken for a
// voice-journal command.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const folder = mkdtempSync(join(tmpdir(), "life-archive-journal-cli-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { encoding: "utf8", input: "", timeout: 25_000, env: { ...process.env, HOME: folder } });

describe("npm run journal", () => {
  it("hands grok-calls its words with --data before or after it", () => {
    for (const args of [["--data", folder, "grok-calls", "frobnicate"], ["grok-calls", "--data", folder, "frobnicate"], [`--data=${folder}`, "grok-calls", "frobnicate"]]) {
      const ran = run(args);
      expect(ran.stderr, args.join(" ")).toContain("unknown command grok-calls frobnicate: run, install or uninstall");
      expect(ran.status, args.join(" ")).toBe(1);
    }
  });
});
