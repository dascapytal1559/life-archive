import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeGuardArchive } from "../fixtures/guardArchive.ts";
import { HOOKS } from "./cli.ts";
import type { CommitMaterial } from "./commits.ts";
import { archiveFile } from "./dictionary.ts";
import { CONTENT, GIT_KEY, kinds, type Policy } from "./policy.ts";
import { LIFE_ARCHIVE } from "./policies/lifeArchive.ts";
import { addReviewed, FINDINGS_FILE, formatLog, LOG_FILE, readFindings, readLog, readReviewed, recordsFolder, REVIEWED_FILE } from "./records.ts";
import { answerSchema, askCodex, BATCH_CHARS, batches, BYPASS, judge, madeUpNames, nameLists, NOT_STOPPING, OLD_BYPASS, policyText, prompt, reviewCommits, SUGGESTION, verdictOf, type Finding } from "./review.ts";

const SCRIPT = fileURLToPath(new URL("./cli.ts", import.meta.url));

// Made up, as everyone here: a name only the archive holds, to prove it never reaches the model.
const SECRET_NAME = "Zelda Privateer";

// A policy of its own for these tests, its name files where the repositories here keep them.
const POLICY: Policy = { ...LIFE_ARCHIVE, nameFiles: ["names/tests.ts", "names/demo.ts"] };

// A stand-in for the Codex CLI: it records how it was run and what it was given, then answers as told,
// or, given STUB_UNKNOWN, finds that name in test.ts unless it is among the made-up names it was given.
const STUB = `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
n=$(ls "$STUB_DIR" | grep -c '^prompt')
printf '%s\\n' "$*" > "$STUB_DIR/args"
pwd > "$STUB_DIR/cwd"
ls -A > "$STUB_DIR/files"
cat > "$STUB_DIR/prompt$n"
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
[ -n "$STUB_EXIT" ] && exit "$STUB_EXIT"
pass='{"findings":[]}'
[ -n "$STUB_UNKNOWN" ] && ! sed -n '/^<made-up-names>$/,/^<[/]made-up-names>$/p' "$STUB_DIR/prompt$n" | grep -qw "$STUB_UNKNOWN" && pass="{\\"findings\\":[{\\"commit\\":\\"\\",\\"file\\":\\"test.ts\\",\\"line\\":1,\\"kind\\":\\"name\\",\\"text\\":\\"$STUB_UNKNOWN\\",\\"reason\\":\\"\\",\\"suggestion\\":\\"\\"}]}"
printf '%s' "\${STUB_ANSWER:-$pass}" > "$out"
`;

let template: string;
let root: string;
let repo: string;
let stubDir: string;
let stub: string;
let archiveDir: string;
let records: string;
let extra: Record<string, string>;

const env = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") && ![BYPASS, OLD_BYPASS, "LIFE_ARCHIVE_DATA", "FRIEND_MAP_DATA", "INIT_CWD", "npm_lifecycle_event"].includes(key),
    ),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  LIFE_ARCHIVE_DATA: archiveDir,
  LIFE_ARCHIVE_CODEX: stub,
  STUB_DIR: stubDir,
  ...extra,
});

function run(cwd: string, command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(command, args, { cwd, env: env(), encoding: "utf8" }, (error, stdout, stderr) => {
      done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const git = (...args: string[]) => run(repo, "git", args);
const guard = (...args: string[]) => run(repo, process.execPath, ["--no-warnings", SCRIPT, ...args]);
const prompts = async () => await readFile(join(stubDir, "prompt0"), "utf8").catch(() => undefined);

async function commitFile(name: string, text: string, message: string, ...flags: string[]) {
  await mkdir(dirname(join(repo, name)), { recursive: true });
  await writeFile(join(repo, name), text);
  await git("add", name);
  return git("commit", "-q", "-m", message, ...flags);
}

const sha = async (revision = "HEAD") => (await git("rev-parse", revision)).stdout.trim();

/** A finding as the model answers it: a place, a kind, the text it points at, and why. */
const found = (commit: string, file: string, line: number, kind: string, text: string, reason = "made up for this test", suggestion = "a placeholder"): Finding => ({ commit, file, line, kind, text, reason, suggestion });
const answer = (...findings: Finding[]) => JSON.stringify({ findings });
const now = new Date("2026-10-19T00:00:00Z");

beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), "life-archive-review-template-"));
  await writeGuardArchive(template, { people: [SECRET_NAME] });
});

afterAll(async () => {
  await rm(template, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "life-archive-review-test-")));
  [repo, stubDir, archiveDir] = [join(root, "repo"), join(root, "stub"), join(root, "archive")];
  records = recordsFolder(archiveDir, "life-archive");
  stub = join(root, "codex");
  extra = {};
  await mkdir(repo);
  await mkdir(stubDir);
  await mkdir(archiveDir);
  await copyFile(archiveFile(template), archiveFile(archiveDir));
  await writeFile(stub, STUB);
  await chmod(stub, 0o755);
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "0+test@users.noreply.github.com");
  await git("config", "core.hooksPath", HOOKS);
  await git("config", GIT_KEY, "life-archive");
  await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
  await git("remote", "add", "origin", join(root, "remote.git"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the push review", { timeout: 60_000 }, () => {
  it("leaves commits to the local check alone", async () => {
    expect((await commitFile("a.txt", "hello\n", "Add a greeting")).code).toBe(0);
    expect(await prompts()).toBeUndefined();
  });

  it("gives the model only the push, in an empty folder, read-only, with no tools, at high effort, and lets a clean push go", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    await commitFile("b.txt", "one\ntwo\n", "Add two lines\n\nWith a body.");
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toMatch(/privacy-review: passed in \d+ s\./);

    const text = (await prompts())!;
    const [first, second] = (await git("rev-list", "--reverse", "--abbrev-commit", "--abbrev=7", "main")).stdout.trim().split("\n");
    expect(text).toContain(`<commit id="${first}">\n<message>\n1| Add a greeting\n</message>\n<file path="a.txt" new>\n1| hello\n</file>\n</commit>`);
    expect(text).toContain(`<commit id="${second}">\n<message>\n1| Add two lines\n2| \n3| With a body.\n</message>\n<file path="b.txt" new>\n1| one\n2| two\n</file>`);
    expect(text).not.toContain(SECRET_NAME);
    expect(text).toContain(`whose history may be made PUBLIC: ${LIFE_ARCHIVE.about}.`);
    // This repository has none of the policy's name files, so no made-up names.
    expect(text).toContain("<made-up-names>\nfirst names: \nlast names: \nwhole names: \n</made-up-names>");

    const args = await readFile(join(stubDir, "args"), "utf8");
    for (const arg of ["exec -m gpt-6.1-sol", 'model_reasoning_effort="high"', "--ephemeral", "-s read-only", "--ignore-user-config", "--disable shell_tool", "--disable unified_exec", "--output-schema"]) {
      expect(args).toContain(arg);
    }
    const cwd = (await readFile(join(stubDir, "cwd"), "utf8")).trim();
    expect(cwd).not.toContain(repo);
    expect((await readFile(join(stubDir, "files"), "utf8")).trim()).toBe("schema.json");

    const [entry] = await readLog(records);
    expect(entry).toMatchObject({ remote: "origin", range: `${first}..${second}`, commits: 2, verdict: "pass", findings: 0, model: "gpt-6.1-sol", effort: "high" });
    expect(Object.keys(entry!)).not.toContain("material");
  });

  it("stops a push only on a policy's kind whose text it finds, saying where, what kind and why, never the text", async () => {
    await commitFile("a.txt", "hello\nlunch with Bruno Placeholder\n", "Add a greeting");
    const id = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
    extra.STUB_ANSWER = answer(
      found(id, "a.txt", 2, "name", "Bruno Placeholder", "reads as a real person's name, Bruno Placeholder", "a made-up name"),
      found(id, "commit message", 1, SUGGESTION, "greeting", "could say more", "say what it greets"),
      found(id, "a.txt", 1, "secret", "sk-nowhere-in-it"), // a text the commit does not add stops nothing
      found(id, "Bruno Placeholder said hi", 1, "name", "Bruno Placeholder"), // a place it made up is not repeated
    );
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("privacy-review: stopped this push: gpt-6.1-sol found private data");
    expect(pushed.stderr).toMatch(new RegExp(`${id} a\\.txt:2 +name  reads as a real person's name, …  instead: a made-up name\n`));
    expect(pushed.stderr).toContain("privacy-review: 2 suggestions, which stop nothing (kept for the captain: npm run guard -- findings):");
    expect(pushed.stderr).toMatch(new RegExp(`${id} commit message, line 1 +could say more; instead: say what it greets\n`));
    expect(pushed.stderr).toMatch(new RegExp(`${id} a\\.txt:1 +secret \\(${NOT_STOPPING.unfound}\\): made up for this test`));
    // Found where the model did not say, and so said where it is.
    expect(pushed.stderr).toMatch(new RegExp(`\n  ${id} a\\.txt:2 +name`));
    expect(pushed.stderr).not.toContain("Bruno");
    expect(pushed.stderr).not.toContain("sk-nowhere");
    expect((await git("ls-remote", "origin")).stdout).toBe("");
    expect(await readLog(records)).toEqual([expect.objectContaining({ verdict: "findings", findings: 2, suggestions: 2 })]);
    expect(await readReviewed(records)).toEqual(new Set());

    const kept = await readFindings(records);
    expect(kept.map((f) => [f.file, f.line, f.kind, f.stops, f.why])).toEqual([
      ["a.txt", 2, "name", true, undefined],
      ["commit message", 1, SUGGESTION, false, NOT_STOPPING.suggestion],
      ["a.txt", 1, "secret", false, NOT_STOPPING.unfound],
      ["a.txt", 2, "name", true, undefined],
    ]);
    expect(kept[0]).toMatchObject({ commit: await sha(), remote: "origin", model: "gpt-6.1-sol", reason: "reads as a real person's name, …" });
    const file = await readFile(join(records, FINDINGS_FILE), "utf8");
    expect(file).not.toContain("Bruno");
    expect(file).not.toContain('"text"');
  });

  it("lets a push go when the model only suggests or points at what is plainly made up, keeping each for the captain to look over", async () => {
    await commitFile("a.txt", "call +61 491 570 006 at your-mac.tail1234.ts.net\n", "Add a fixture");
    const id = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
    extra.STUB_ANSWER = answer(
      found(id, "a.txt", 1, "phone-number", "+61 491 570 006"),
      found(id, "a.txt", 1, "private-host", "your-mac.tail1234.ts.net"),
      found(id, "a.txt", 1, SUGGESTION, "fixture", "a vague word", "name it"),
    );
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain("privacy-review: 3 suggestions, which stop nothing");
    expect(pushed.stderr).toContain(`phone-number (${NOT_STOPPING.madeUp})`);
    expect(pushed.stderr).toMatch(/privacy-review: passed in \d+ s\./);
    expect(await readReviewed(records)).toEqual(new Set([await sha()]));
    expect(await readLog(records)).toEqual([expect.objectContaining({ verdict: "pass", findings: 0, suggestions: 3 })]);

    const listed = await guard("findings");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`life-archive  ${(await sha()).slice(0, 10)} a.txt:1  [phone-number, not stopped: ${NOT_STOPPING.madeUp}]`);
    expect(listed.stdout).toContain("[suggestion]\n  a vague word\n  instead: name it");
    expect((await guard("findings", "--repo", repo)).stdout).toBe(listed.stdout);
  });

  it("is not asked when the local check already stopped the push", async () => {
    await writeFile(join(repo, "a.txt"), `${SECRET_NAME}\n`);
    await git("add", "a.txt");
    await git("commit", "-q", "--no-verify", "-m", "Add a name");
    expect((await git("push", "-q", "origin", "main")).code).not.toBe(0);
    expect(await prompts()).toBeUndefined();
  });

  it("stops a push when Codex fails or is missing, and lets the captain's bypass through, by either name", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    extra.STUB_EXIT = "3";
    const failed = await git("push", "-q", "origin", "main");
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("privacy-review: stopped this push: no review: Codex exited with 3.");

    extra = { LIFE_ARCHIVE_CODEX: join(root, "no-codex") };
    const missing = await git("push", "-q", "origin", "main");
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("the Codex CLI is not installed here");

    extra = { LIFE_ARCHIVE_CODEX: join(root, "no-codex"), [OLD_BYPASS]: "1" };
    const old = await git("push", "-q", "origin", "main");
    expect(old.code).toBe(0);
    expect(old.stderr).toContain(`privacy-review: skipped: ${OLD_BYPASS} is set`);

    await commitFile("b.txt", "more\n", "Add more");
    extra = { LIFE_ARCHIVE_CODEX: join(root, "no-codex"), [BYPASS]: "1" };
    const bypassed = await git("push", "-q", "origin", "main");
    expect(bypassed.code).toBe(0);
    expect(bypassed.stderr).toContain(`privacy-review: skipped: ${BYPASS} is set`);
    expect((await readLog(records)).map((e) => e.verdict)).toEqual(["unavailable", "unavailable", "bypassed", "bypassed"]);
    expect(await readReviewed(records)).toEqual(new Set());
  });

  it("is skipped without a word where there is no archive", async () => {
    await rm(archiveFile(archiveDir));
    await commitFile("a.txt", "hello\n", "Add a greeting");
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).not.toContain("privacy-review");
    expect(await prompts()).toBeUndefined();
  });
});

describe("the record of reviewed commits", { timeout: 60_000 }, () => {
  const why = "made up for this test";

  it("is kept for each policy in the archive's folder", () => {
    expect(records).toBe(join(archiveDir, "guard", "life-archive"));
  });

  it("lets a push check only the commits not reviewed yet, by both checks, and stop on a finding in one", async () => {
    // Reviewed already, though the local check would stop it now: it is settled, and not read again.
    await commitFile("a.txt", `${SECRET_NAME}\n`, "Add a name", "--no-verify");
    const settled = await sha();
    await addReviewed(records, [settled], why, now);
    await commitFile("b.txt", "hello\n", "Add a greeting");
    const fresh = await sha();

    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(`guard: 1 of the 2 commits this push sends reviewed already (${REVIEWED_FILE}), so not checked again.`);
    expect(pushed.stderr).toContain("privacy-review: gpt-6.1-sol is reading 1 commit for private data");
    const text = (await prompts())!;
    expect(text).toContain(`<commit id="${fresh.slice(0, 7)}">`);
    expect(text).not.toContain(settled.slice(0, 7));
    expect(text).not.toContain(SECRET_NAME);
    // The push's review passed, so its commit is settled too.
    expect(await readReviewed(records)).toEqual(new Set([settled, fresh]));

    await commitFile("c.txt", "hello\nfine\n", "Add more");
    const stopping = await sha();
    extra.STUB_ANSWER = answer(found(stopping.slice(0, 7), "c.txt", 2, "name", "fine"));
    const stopped = await git("push", "-q", "origin", "main");
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toMatch(new RegExp(`${stopping.slice(0, 7)} c\\.txt:2 +name`));
    expect(await readReviewed(records)).not.toContain(stopping);
  });

  it("makes no model call for a push of reviewed commits only, even to a remote that has none of them", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    await commitFile("b.txt", "more\n", "Add more");
    await addReviewed(records, [await sha("HEAD~1"), await sha()], why, now);
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain("guard: 2 of the 2 commits this push sends reviewed already");
    expect(pushed.stderr).not.toContain("privacy-review");
    expect(await prompts()).toBeUndefined();
    expect(await readLog(records)).toEqual([]);
  });

  it("records each commit a review by hand passes, and none it finds something in", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    await git("checkout", "-q", "-b", "work");
    await commitFile("b.txt", "more\n", "Add more");
    await commitFile("c.txt", "more\n", "Add more again");
    expect((await guard("review", "main..work")).code).toBe(0);
    expect(await readReviewed(records)).toEqual(new Set([await sha("work~1"), await sha("work")]));
    const [entry] = (await readFile(join(records, REVIEWED_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(entry).toEqual({ at: expect.any(String), why: "passed gpt-6.1-sol's review", commits: [await sha("work~1"), await sha("work")] });

    await commitFile("d.txt", "more\n", "Add yet more");
    extra.STUB_ANSWER = answer(found((await sha()).slice(0, 7), "d.txt", 1, "email", "more"));
    expect((await guard("review", "main..work")).code).toBe(1);
    expect((await readReviewed(records)).size).toBe(2);
  });

  it("reviews the repository --repo names, from anywhere", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    const reviewed = await run(root, process.execPath, ["--no-warnings", SCRIPT, "review", "HEAD", "--repo", repo]);
    expect(reviewed.code).toBe(0);
    expect(await readReviewed(records)).toEqual(new Set([await sha()]));
  });

  it("reads past a line or sha it cannot use, which only means more is checked, and adds each commit once", async () => {
    const [one, two] = ["1".repeat(40), "2".repeat(40)];
    await mkdir(records, { recursive: true });
    await writeFile(join(records, REVIEWED_FILE), `not json\n${JSON.stringify({ commits: [one, "1111111", 7] })}\n`);
    expect(await readReviewed(records)).toEqual(new Set([one]));
    await addReviewed(records, [one, two, two], why, now);
    await addReviewed(records, [one], why, now);
    const lines = (await readFile(join(records, REVIEWED_FILE), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toEqual({ at: now.toISOString(), why, commits: [two] });
  });
});

describe("guard publish-check", { timeout: 60_000 }, () => {
  const why = "made up for this test";

  it("passes over the commits reviewed already, with no model call when none is left", async () => {
    // Reviewed already, though the local check would stop it now: it is settled, and not read again.
    await commitFile("a.txt", `${SECRET_NAME}\n`, "Add a name", "--no-verify");
    await commitFile("b.txt", "more\n", "Add more");
    await addReviewed(records, [await sha("HEAD~1"), await sha()], why, now);

    const checked = await guard("publish-check");
    expect(checked.code).toBe(0);
    expect(checked.stderr).toContain(`guard: 2 of the 2 commits to be published reviewed already (${REVIEWED_FILE}), so not checked again; none left for the model, so no model call.`);
    expect(checked.stderr).toContain("guard: all 2 commits to be published have passed the review. Making them public is the captain's call.");
    expect(checked.stderr).not.toContain("privacy-review");
    expect(await prompts()).toBeUndefined();
    expect(await readLog(records)).toEqual([]);
  });

  it("checks a commit not yet reviewed by both checks, the model at high effort with no bypass, and records it once it passes", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    const settled = await sha();
    await addReviewed(records, [settled], why, now);
    await commitFile("b.txt", "more\n", "Add more");
    const fresh = await sha();

    const checked = await guard("publish-check");
    expect(checked.code).toBe(0);
    expect(checked.stderr).toContain("guard: 1 of the 2 commits to be published reviewed already");
    expect(checked.stderr).toContain("guard: nothing private found in the 1 commit not yet reviewed; all to be published have now passed the review. Making them public is the captain's call.");
    expect(await readFile(join(stubDir, "args"), "utf8")).toContain('model_reasoning_effort="high"');
    const text = (await prompts())!;
    expect(text).toContain(`<commit id="${fresh.slice(0, 7)}">`);
    expect(text).not.toContain(settled.slice(0, 7));
    expect(await readLog(records)).toEqual([expect.objectContaining({ remote: "", commits: 1, verdict: "pass", effort: "high" })]);
    expect(await readReviewed(records)).toEqual(new Set([settled, fresh]));

    await commitFile("c.txt", "more\n", "Add yet more");
    extra = { STUB_EXIT: "3", [BYPASS]: "1" };
    const failed = await guard("publish-check", "main");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("privacy-review: stopped this publication: no review: Codex exited with 3.");
  });

  it("stops on a finding in a commit not yet reviewed, from either check, and records nothing", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    await commitFile("b.txt", "hello\nfine\n", "Add more");
    const stopping = await sha();
    extra.STUB_ANSWER = answer(found(stopping.slice(0, 7), "b.txt", 2, "name", "fine"));
    const reviewed = await guard("publish-check");
    expect(reviewed.code).toBe(1);
    expect(reviewed.stderr).toContain("privacy-review: stopped this publication");
    expect(reviewed.stderr).toMatch(new RegExp(`${stopping.slice(0, 7)} b\\.txt:2 +name`));
    expect(await readReviewed(records)).toEqual(new Set());

    extra = {};
    await commitFile("c.txt", `${SECRET_NAME}\n`, "Add a name", "--no-verify");
    await rm(join(stubDir, "prompt0"));
    const scanned = await guard("publish-check");
    expect(scanned.code).toBe(1);
    expect(scanned.stderr).toContain("guard: stopped this publication");
    expect(await prompts()).toBeUndefined();
  });

  it("stops a commit whose author is not a noreply address, reviewed already or not, before any model call", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting", "--author=Test <ada.sample@example.com>"); // made up
    await addReviewed(records, [await sha()], why, now);
    await commitFile("b.txt", "more\n", "Add more");

    const checked = await guard("publish-check");
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain(
      `guard: stopped this publication: 1 commit names an author or committer email that is not a GitHub noreply address, which would publish it.\n  ${(await sha("HEAD~1")).slice(0, 7)}  author\n`,
    );
    expect(await prompts()).toBeUndefined();
  });

  it("will not run without the archive", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    await rm(archiveFile(archiveDir));
    const checked = await guard("publish-check");
    expect(checked.code).toBe(1);
    expect(checked.stderr).toMatch(/^guard: publish-check needs the archive and its names \(.*\); run it in the captain's copy of the life archive\.\n$/);
  });
});

describe("guard review <revisions>", { timeout: 60_000 }, () => {
  it("reviews a range at medium effort, logs it, exits 1 on findings, and takes no bypass", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    await git("checkout", "-q", "-b", "work");
    await commitFile("b.txt", "more\n", "Add more");
    const id = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();

    const clean = await guard("review", "main..work");
    expect(clean.code).toBe(0);
    expect(await readFile(join(stubDir, "args"), "utf8")).toContain('model_reasoning_effort="medium"');
    expect(await prompts()).toContain(`<commit id="${id}">`);
    expect(await prompts()).not.toContain("Add a greeting");

    extra = { STUB_ANSWER: answer(found(id, "b.txt", 1, "email", "more")), [BYPASS]: "1" };
    const stopped = await guard("review", "main..work");
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("privacy-review: stopped these commits");
    expect(stopped.stderr).toMatch(new RegExp(`${id} b\\.txt:1 +email`));

    const log = await readLog(records);
    expect(log).toEqual([
      expect.objectContaining({ remote: "", range: id, commits: 1, verdict: "pass", effort: "medium" }),
      expect.objectContaining({ remote: "", verdict: "findings", findings: 1 }),
    ]);
    const shown = await guard("reviews");
    expect(shown.stdout.split("\n")).toEqual([
      expect.stringMatching(/^when \(UTC\) +remote +range +commits +verdict +time +model$/),
      expect.stringMatching(new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d +\\(review\\) +${id} +1 +pass +[\\d.]+ s +gpt-6\\.1-sol medium$`)),
      expect.stringMatching(/ findings \(1\) /),
      "",
    ]);
  });

  it("knows the made-up names the tip adds to the policy's name files, and only those", async () => {
    const pools = (first: string[]) => `export const FIRST_NAMES = ${JSON.stringify(first)};\nexport const LAST_NAMES = ["Sample"];\nexport const WHOLE_NAMES = [];\n`;
    await commitFile(LIFE_ARCHIVE.nameFiles[0]!, pools(["Ada"]), "Add the made-up names");
    await git("checkout", "-q", "-b", "added");
    await commitFile(LIFE_ARCHIVE.nameFiles[0]!, pools(["Ada", "Bea"]), "Add a made-up name");
    await commitFile("test.ts", 'const friend = "Bea Sample";\n', "Use it");
    await git("checkout", "-q", "-b", "unadded", "main");
    await commitFile("test.ts", 'const friend = "Bea Sample";\nconst first = ["Bea"];\n', "Use it without adding it");
    // Reviewed from main, whose working tree and the ranges' base know only Ada.
    await git("checkout", "-q", "main");
    extra = { STUB_UNKNOWN: "Bea" };

    expect((await guard("review", "main..added")).code).toBe(0);
    expect(await prompts()).toContain("first names: Ada, Bea\n");
    expect((await guard("review", "main..unadded")).code).toBe(1);
    expect(await readFile(join(stubDir, "prompt1"), "utf8")).toContain("first names: Ada\n");
  });
});

describe("askCodex", () => {
  const ask = (text: string, timeoutMs: number, variables: Record<string, string>) => {
    Object.assign(process.env, { STUB_DIR: stubDir, ...variables });
    return Effect.runPromise(askCodex(stub, text, POLICY, "high", timeoutMs)).finally(() => {
      for (const key of ["STUB_DIR", ...Object.keys(variables)]) delete process.env[key];
    });
  };

  it("gives up when Codex takes too long, and ends it", async () => {
    const started = Date.now();
    expect(await ask("material", 300, { STUB_SLEEP: "5" })).toEqual({ ok: false, why: "Codex took longer than 1 s" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("calls an answer that breaks the schema no review", async () => {
    expect(await ask("material", 10_000, { STUB_ANSWER: '{"verdict":"maybe"}' })).toEqual({ ok: false, why: "Codex gave no answer in the expected shape" });
    expect(verdictOf({ findings: [{ commit: "a", line: 1.5 }] }, "Codex")).toEqual({ ok: true, findings: [{ commit: "a", file: "", line: 0, kind: "", text: "", reason: "", suggestion: "" }] });
  });

  it("says when Codex cannot be started", async () => {
    expect(await Effect.runPromise(askCodex(join(root, "not-codex"), "material", POLICY, "high", 10_000))).toMatchObject({ ok: false, why: expect.stringMatching(/^could not start Codex \(/) });
  });
});

describe("reviewCommits", { timeout: 30_000 }, () => {
  const bigCommit = (id: string): CommitMaterial => ({
    sha: id.repeat(6).slice(0, 40),
    id,
    message: "Subject\n",
    files: [{ path: `${id}.txt`, named: true, binary: false, runs: [{ first: 1, lines: Array.from({ length: 2500 }, () => "x".repeat(100)) }] }],
  });
  const review = async (commits: CommitMaterial[], sleep: string, timeoutMs: number) => {
    const lines: string[] = [];
    Object.assign(process.env, { STUB_DIR: stubDir, STUB_SLEEP: sleep });
    try {
      const code = await Effect.runPromise(
        reviewCommits({ top: repo, policy: POLICY, tip: "HEAD", records: root, remote: "origin", commits, content: CONTENT, env: { LIFE_ARCHIVE_CODEX: stub }, timeoutMs, log: (line) => lines.push(line) }),
      );
      return { code, lines, log: await readLog(root) };
    } finally {
      delete process.env.STUB_DIR;
      delete process.env.STUB_SLEEP;
    }
  };

  it("gives each part its own time limit, so a push in many parts may take longer than one call may", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting"); // a tip to read the name files at
    const commits = ["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd"].map(bigCommit);
    const parts = batches(commits).length;
    // More parts than run at once, so they go in at least two rounds of a second each, longer than one call's limit.
    expect(parts).toBeGreaterThan(3);
    const started = Date.now();
    const { code, lines, log } = await review(commits, "1", 1800);
    expect(Date.now() - started).toBeGreaterThan(1800);
    expect(code).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`in ${parts} parts for private data \\(up to \\d+ min a part\\)`));
    expect(lines.at(-1)).toMatch(/^privacy-review: passed in \d+ s\.$/);
    expect(log.at(-1)).toMatchObject({ verdict: "pass", calls: parts });
  });

  it("still stops the push when one call takes longer than its limit", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting");
    const { code, lines, log } = await review([bigCommit("aaaaaaa")].map((c) => ({ ...c, files: [] })), "5", 500);
    expect(code).toBe(1);
    expect(lines).toContain("privacy-review: stopped this push: no review: Codex took longer than 1 s.");
    expect(log.at(-1)).toMatchObject({ verdict: "unavailable", why: "Codex took longer than 1 s", calls: 1 });
  });
});

describe("batches", () => {
  const commit = (id: string, lines: number, width = 100): CommitMaterial => ({
    sha: id.repeat(6).slice(0, 40),
    id,
    message: "Subject\n",
    files: [{ path: `${id}.txt`, named: true, binary: false, runs: [{ first: 1, lines: Array.from({ length: lines }, () => "x".repeat(width)) }] }],
  });

  it("puts a small push in one part", () => {
    expect(batches([commit("aaaaaaa", 3), commit("bbbbbbb", 3)])).toHaveLength(1);
  });

  it("splits a big push, and even one big file, into parts that each fit and stay well formed", () => {
    const parts = batches([commit("aaaaaaa", 2000), commit("bbbbbbb", 8000)]);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(part.length).toBeLessThan(BATCH_CHARS * 1.05);
      expect(part.match(/<commit /g)?.length).toBe(part.match(/<\/commit>/g)?.length);
      expect(part.match(/<file /g)?.length).toBe(part.match(/<\/file>/g)?.length);
    }
    const lines = parts.join("\n").split("\n").filter((l) => /^\d+\| x/.test(l));
    expect(lines).toHaveLength(10_000);
  });

  it("names a binary file without its contents", () => {
    const [part] = batches([{ sha: "c".repeat(40), id: "ccccccc", message: "Add a picture", files: [{ path: "shot.png", named: true, binary: true, runs: [] }] }]);
    expect(part).toContain('<file path="shot.png" new binary>(binary contents not shown)</file>');
  });
});

describe("nameLists", () => {
  it("reads each string and list of strings as written, with the lists of the same file spread into it", () => {
    const source = [
      "// made-up names",
      'export const CROWD = ["Ada", \'Bea\', /* a comment */ "Cleo"];',
      "export const FIRST_NAMES: readonly string[] = [",
      "  ...CROWD, // the crowd's first",
      '  "Dora", "Esc\\"aped", "Uni\\u0063ode", `Tem`,',
      "];",
      'export const SELF_NAME = "Kit Ng";',
      "const LOOP = [...LOOP, \"Eve\"];",
    ].join("\n");
    const lists = nameLists(source);
    expect(lists.get("FIRST_NAMES")).toEqual(["Ada", "Bea", "Cleo", "Dora", 'Esc"aped', "Unicode", "Tem"]);
    expect(lists.get("SELF_NAME")).toEqual(["Kit Ng"]);
    expect(lists.get("LOOP")).toEqual(["Eve"]);
  });

  it("takes nothing it would have to run: a sum, a call, a template with a value in it, a name from elsewhere", () => {
    const source = [
      'import { OTHER } from "./other.ts";',
      'export const FIRST_NAMES = ["Ada", "Al" + "ba", make("Bea"), `${"Cy"}`, ...OTHER, "Dora"];',
      'export const LAST_NAMES = "Sample".split(",");',
      "export const WHOLE_NAMES = pick();",
    ].join("\n");
    const lists = nameLists(source);
    expect(lists.get("FIRST_NAMES")).toEqual(["Ada", "Dora"]);
    expect(lists.has("LAST_NAMES")).toBe(false);
    expect(lists.has("WHOLE_NAMES")).toBe(false);
  });
});

describe("prompt and place", () => {
  it("holds the policy, the made-up names and the material, and asks for the text only to check it", () => {
    const text = prompt(POLICY, { first: ["Ada", "Bea"], last: ["Sample"], whole: ["Kit Ng"], figures: [], standIns: [] }, "MATERIAL HERE", CONTENT);
    expect(text).toContain(`<policy>\n${policyText(POLICY, CONTENT)}\n</policy>`);
    expect(text).toContain("(the life-archive policy)");
    expect(text).toContain("<made-up-names>\nfirst names: Ada, Bea\nlast names: Sample\nwhole names: Kit Ng\n</made-up-names>");
    expect(text).toContain("kept in the repository (names/tests.ts and names/demo.ts)");
    expect(text).toContain("report a name only when it is not made of these and reads as a real person's.");
    expect(text).toContain("A name the material adds to those files is on these lists and made up like the rest");
    expect(text).toContain("a name that plainly means one of the captain's real friends, as in a commit message quoting his ask, is judged like any other, even one on these lists");
    expect(text).toContain("61491571266@s.whatsapp.net");
    expect(text).toContain("even about one person");
    expect(text).toContain("lists the only kinds of data that stop a commit; everything else is allowed");
    expect(text).toContain("Allowed by default, and never one of those kinds");
    expect(text).toContain(`as kind "${SUGGESTION}": it never stops the commit`);
    expect(text).toContain("<material>\nMATERIAL HERE\n</material>");
    expect(text).toContain("it is checked against the material and never shown");
    expect(text).toContain("- reason: why, in a few plain words, without repeating the text;");
    expect(text).toContain("home folders of a placeholder or made-up user (/Users/someone, /Users/ada)");
    expect(text).not.toContain("public figures some tests use");
  });

  it("tells the public figures and the stand-ins apart from the made-up names, when the name files have them", () => {
    const text = prompt(POLICY, { first: ["Ada"], last: [], whole: [], figures: ["Ada Lovelace"], standIns: ["Zelda Privateer"] }, "", CONTENT);
    expect(text).toContain("public figures some tests use as their people (real, famous, and no one in the archive): Ada Lovelace");
    expect(text).toContain("stand-ins, invented, that play a real person in the privacy checks' own tests, which must stop them: Zelda Privateer");
    expect(text).toContain("whole names: \n</made-up-names>");
  });

  it("gives the policy word for word, with what content is, and lets the model report only its kinds", () => {
    const text = policyText(LIFE_ARCHIVE, CONTENT);
    for (const item of LIFE_ARCHIVE.repo.never) expect(text).toContain(`- ${item.what} [kind: ${item.kind}]`);
    for (const item of LIFE_ARCHIVE.repo.fine) expect(text).toContain(`- ${item}`);
    expect(text).toContain(`Content, the policy's first layer, is: ${CONTENT.join("; ")}.`);
    expect(kinds(LIFE_ARCHIVE)).toEqual(LIFE_ARCHIVE.repo.never.map((item) => item.kind));
    expect(kinds(LIFE_ARCHIVE)).not.toContain("other-personal-data");
  });

  it("tells quoted asks, which are instructions, from a friend's quoted message, which is content", () => {
    const text = prompt(POLICY, { first: [], last: [], whole: [], figures: [], standIns: [] }, "", CONTENT);
    expect(text).toContain("that is never content, however personal or chatty it reads");
    expect(text).toContain("Content is text from his archive: a friend's message, quoted or paraphrased");
    expect(LIFE_ARCHIVE.repo.fine.join("\n")).toContain("commit messages quoting the captain's own asks to his agents");
    expect(LIFE_ARCHIVE.repo.never.find((item) => item.kind === "content")!.what).toContain("friends' messages");
  });

  it("calls fine what the captain does: ordinary phrases, cities, time zones, dates and counts", () => {
    const fine = LIFE_ARCHIVE.repo.fine.join("\n");
    for (const word of ["Since Aug", "Melbourne", "Australia/Melbourne", "time zones", "dates", "counts"]) expect(fine).toContain(word);
  });

  it("calls fine the handles made from made-up names and the documentation addresses in tests of refused hosts", () => {
    const fine = LIFE_ARCHIVE.repo.fine.join("\n");
    for (const word of ["Handles and account ids made from the made-up names", "@ada_sample", "ada_sample_77"]) expect(fine).toContain(word);
    for (const range of ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32"]) expect(fine).toContain(range);
    expect(fine).toContain("in tests of which hosts are refused");
  });

  it("names a tailnet host, an IP address, a street address, a phone number and an email among what it stops", () => {
    expect(kinds(LIFE_ARCHIVE)).toEqual(expect.arrayContaining(["private-host", "ip-address", "street-address", "phone-number", "email", "name"]));
  });

  it("takes names only from the policy's name files, and none where the tip has none", async () => {
    await commitFile("src/other.ts", 'export const FIRST_NAMES = ["Bea"];\nexport const WHOLE_NAMES = ["Kit Ng"];\n', "Add a list elsewhere");
    const names = () => Effect.runPromise(madeUpNames(repo, "HEAD", POLICY));
    expect(await names()).toEqual({ first: [], last: [], whole: [], figures: [], standIns: [] });
    await commitFile(POLICY.nameFiles[1]!, 'export const SELF_NAME = "Kit Ng";\nexport const FIRST_NAMES = ["Ada", "Alba"];\nexport const PUBLIC_FIGURES = ["Ada Lovelace"];\nexport const STAND_INS = ["Dee Sample"];\n', "Add the demo's names");
    expect(await names()).toEqual({ first: ["Ada", "Alba"], last: [], whole: ["Kit Ng"], figures: ["Ada Lovelace"], standIns: ["Dee Sample"] });
    expect(JSON.stringify(await names())).not.toContain(SECRET_NAME);
  });

  it("lets the model answer only the policy's kinds or a suggestion, each with its text, reason and suggestion", () => {
    const item = answerSchema(POLICY).properties.findings.items;
    expect(item.properties.kind.enum).toEqual([...kinds(POLICY), SUGGESTION]);
    expect(item.required).toEqual(["commit", "file", "line", "kind", "text", "reason", "suggestion"]);
  });
  it("shows an empty log plainly", () => {
    expect(formatLog([])).toBe("No privacy reviews yet.");
    expect(LOG_FILE).toBe("privacy-reviews.jsonl");
  });
});

describe("judge", () => {
  // A made-up tailnet host, built from pieces so this file holds none whole.
  const HOST = ["qz7", "tailf00d1", "ts", "net"].join(".");
  // A home folder of a user no list names, in pieces as HOST is.
  const REAL_HOME = ["", "Users", "qtester", "Projects"].join("/");
  const commits: CommitMaterial[] = [
    { sha: "d".repeat(40), id: "ddddddd", message: "Add notes\n\nLunch with Ada Sample\n", files: [{ path: "a.ts", named: true, binary: false, runs: [{ first: 3, lines: ["const one = 1;", 'const friend = "Bruno Placeholder"; // +61 491 570 006'] }] }] },
    { sha: "e".repeat(40), id: "eeeeeee", message: "More", files: [{ path: "b.md", named: false, binary: false, runs: [{ first: 10, lines: [`reach ${HOST} or your-mac.tail1234.ts.net`] }] }] },
    { sha: "c".repeat(40), id: "ccccccc", message: "Paths", files: [{ path: "c.ts", named: true, binary: false, runs: [{ first: 1, lines: ['const a = "/Users/ada/Projects", b = "/Users/someone/x", by = "Cy Twombly";', `const c = "${REAL_HOME}";`] }] }] },
  ];
  const names = { first: ["Ada", "Bruno"], last: ["Sample", "Placeholder"], whole: [], figures: ["Cy Twombly"], standIns: [] };
  const judged = (finding: Partial<Finding>) => judge({ commit: "ddddddd", file: "a.ts", line: 4, kind: "name", text: "", reason: "", suggestion: "", ...finding }, commits, POLICY, names);

  it("stops on a policy's kind whose text is where it says, or elsewhere in what is added, saying where it is", () => {
    expect(judged({ kind: "private-host", file: "b.md", commit: "eeeeeee", line: 10, text: HOST })).toMatchObject({ sha: "e".repeat(40), where: "eeeeeee b.md:10", stops: true });
    expect(judged({ kind: "private-host", line: 4, text: HOST.toUpperCase() })).toMatchObject({ where: "eeeeeee b.md:10", file: "b.md", line: 10, stops: true });
    expect(judged({ kind: "name", file: "commit message", line: 1, text: "Ada Sample" })).toMatchObject({ where: "ddddddd commit message, line 3", stops: true });
  });

  it("lets through, with why, a suggestion, an unknown kind, a text it cannot find, and what is plainly made up", () => {
    expect(judged({ kind: SUGGESTION, text: "one" })).toMatchObject({ kind: SUGGESTION, stops: false, why: NOT_STOPPING.suggestion, where: "ddddddd a.ts:4" });
    expect(judged({ kind: "infrastructure", text: "one" })).toMatchObject({ kind: SUGGESTION, stops: false, why: NOT_STOPPING.suggestion });
    expect(judged({ text: "Zelda Privateer" })).toMatchObject({ stops: false, why: NOT_STOPPING.unfound });
    expect(judged({ text: "a" })).toMatchObject({ stops: false, why: NOT_STOPPING.unfound });
    expect(judged({ text: "Bruno Placeholder" })).toMatchObject({ stops: false, why: NOT_STOPPING.madeUp });
    expect(judged({ kind: "phone-number", text: "+61 491 570 006" })).toMatchObject({ stops: false, why: NOT_STOPPING.madeUp });
    expect(judged({ kind: "private-host", text: "your-mac.tail1234.ts.net" })).toMatchObject({ stops: false, why: NOT_STOPPING.madeUp });
  });

  it("lets through a public figure the name files list, and a home folder of a placeholder or made-up user, but no other", () => {
    const inPaths = (finding: Partial<Finding>) => judged({ commit: "ccccccc", file: "c.ts", line: 1, ...finding });
    expect(inPaths({ text: "Cy Twombly" })).toMatchObject({ stops: false, why: NOT_STOPPING.madeUp });
    expect(inPaths({ kind: "user-path", text: "/Users/ada/Projects" })).toMatchObject({ stops: false, why: NOT_STOPPING.madeUp });
    expect(inPaths({ kind: "user-path", text: "/Users/someone/x" })).toMatchObject({ stops: false, why: NOT_STOPPING.madeUp });
    expect(inPaths({ kind: "user-path", line: 2, text: REAL_HOME })).toMatchObject({ stops: true });
  });

  it("names a place only by the commit's id and paths, and takes the quoted text out of its words", () => {
    expect(judged({ commit: "fffffff", kind: SUGGESTION }).where).toBe("(a place it did not name)");
    expect(judged({ file: "Bruno said hi", kind: SUGGESTION }).where).toBe("ddddddd (a place it did not name)");
    expect(judged({ line: 0, kind: SUGGESTION }).where).toBe("ddddddd a.ts (its file name)");
    const words = judged({ kind: "private-host", text: HOST, reason: `names ${HOST.toUpperCase()},\n a host`, suggestion: `not ${HOST} but a placeholder` });
    expect([words.reason, words.suggestion]).toEqual(["names …, a host", "not … but a placeholder"]);
  });
});
