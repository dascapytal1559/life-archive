// The notifier's adapters on a made-up FirstMate home: its inbox is found only where its script is, each note goes to
// it with its id, and an inbox that saved a note without waking anyone still counts as sent. The desktop adapter is not
// run here: on a Mac it would put a notification on the screen.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstMateInbox, firstMateNotes } from "./firstmate.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "notifier-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A made-up fm-inbox.sh that keeps its arguments in `sent` and exits with `code`. */
async function fakeInbox(code: number): Promise<string> {
  const inbox = join(home, "bin", "fm-inbox.sh");
  await mkdir(join(home, "bin"));
  await writeFile(inbox, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(home, "sent")}"\nexit ${code}\n`);
  await chmod(inbox, 0o755);
  return inbox;
}

describe("FirstMate's inbox", () => {
  it("is there only where FIRSTMATE_HOME has its script", async () => {
    expect(firstMateInbox(undefined)).toBeNull();
    expect(firstMateInbox(home)).toBeNull();
    const inbox = await fakeInbox(0);
    expect(firstMateInbox(home)).toBe(inbox);
  });

  it("gets each note with its id, and the note logged as sent", async () => {
    const lines: string[] = [];
    await Effect.runPromise(firstMateNotes(await fakeInbox(0), (line) => lines.push(line)).note("job-failed-2026-11-08", "the job failed"));
    expect((await readFile(join(home, "sent"), "utf8")).split("\n")).toEqual(["note", "--request-id", "job-failed-2026-11-08", "--", "the job failed", ""]);
    expect(lines).toEqual(["noted firstmate: job-failed-2026-11-08"]);
  });

  it("counts a note saved without waking firstmate as sent, and fails on any other refusal", async () => {
    const lines: string[] = [];
    await Effect.runPromise(firstMateNotes(await fakeInbox(3), (line) => lines.push(line)).note("a", "text"));
    expect(lines).toEqual(["noted firstmate: a (saved; firstmate not woken)"]);
    await writeFile(join(home, "bin", "fm-inbox.sh"), "#!/bin/sh\nexit 1\n");
    await expect(Effect.runPromise(firstMateNotes(join(home, "bin", "fm-inbox.sh"), () => {}).note("b", "text"))).rejects.toThrow();
  });
});
