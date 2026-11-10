import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGuardArchive } from "../fixtures/guardArchive.ts";
import { HOOKS } from "./cli.ts";
import { addedFiles, addedTexts, messageText } from "./commits.ts";
import { archiveFile, guardFolder, loadPrivateData, readDictionary } from "./dictionary.ts";
import { CHAIN_KEY, GIT_KEY } from "./policy.ts";
import { RULES } from "./scan.ts";

const SCRIPT = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** A version string the check reads as an IP address; built from pieces, so this file passes the check itself. */
const VERSION = ["1", "2", "0", "1"].join(".");

let template: string; // an archive whose people are made up: "Ada Sample", and the captain, "Quinn Testperson"
let root: string;
let repo: string;
let archiveDir: string;
let pathFront = ""; // folders put first on the PATH, each with a colon after it

// git as in a fresh clone on any machine: none of this machine's or a calling hook's git settings, nor its archive's
// folder (the guard's is the test's), nor npm's word on where it was run from.
const env = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["LIFE_ARCHIVE_DATA", "FRIEND_MAP_DATA", "INIT_CWD", "npm_lifecycle_event"].includes(key)),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: `${pathFront}${dirname(process.execPath)}:${process.env.PATH}`,
  LIFE_ARCHIVE_DATA: archiveDir,
  // Never the real Codex: these tests stop before the model's review, or find no Codex for it.
  LIFE_ARCHIVE_CODEX: join(root, "no-codex"),
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

async function commitFile(name: string, text: string, message: string, ...flags: string[]) {
  await writeFile(join(repo, name), text);
  await git("add", name);
  return git("commit", "-q", "-m", message, ...flags);
}

/** The test's archive, with these people instead of the template's. */
async function archiveWith(people: string[]) {
  await rm(archiveDir, { recursive: true, force: true });
  await writeGuardArchive(archiveDir, { people });
}

beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), "life-archive-guard-template-"));
  await writeGuardArchive(template, { people: ["Ada Sample"], self: "Quinn Testperson" });
});

afterAll(async () => {
  await rm(template, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "life-archive-guard-"))); // as git names it
  [repo, archiveDir] = [join(root, "repo"), join(root, "archive")];
  await mkdir(repo);
  await mkdir(archiveDir);
  await copyFile(archiveFile(template), archiveFile(archiveDir));
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "0+test@users.noreply.github.com"); // a made-up GitHub noreply address (no account has id 0)
  await git("config", "core.hooksPath", HOOKS);
  await git("config", GIT_KEY, "life-archive");
});

afterEach(async () => {
  pathFront = "";
  await rm(root, { recursive: true, force: true });
});

describe("the hooks", { timeout: 60_000 }, () => {
  it("let a commit with nothing private through", async () => {
    expect((await commitFile("a.txt", "hello\n", "Add a greeting")).code).toBe(0);
    expect((await git("log", "--format=%s")).stdout).toBe("Add a greeting\n");
  });

  it("stop a commit whose message names someone in the archive, saying where and which rule but not who", async () => {
    const result = await commitFile("a.txt", "hello\n", "Add a greeting\n\nFor lunch with Ada Sample.");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`commit message, line 3, column 16  ${RULES.person}`);
    expect(result.stderr).not.toMatch(/Ada|Sample/);
    expect((await git("rev-parse", "--verify", "-q", "HEAD")).code).not.toBe(0);
  });

  it("stop a commit that adds the captain's name, by file, line and column", async () => {
    const result = await commitFile("notes.md", "one\ntwo\nby Quinn Testperson\n", "Add notes");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`notes.md:3:4  ${RULES.captain}`);
    expect(result.stderr).toContain("(the life-archive policy, server/guard/policies/ in the life archive)");
    expect(result.stderr).not.toMatch(/Quinn|Testperson/);
  });

  it("read the archive afresh, and look only at what a commit adds", async () => {
    await archiveWith([]);
    expect((await commitFile("a.txt", "Ada Sample\n", "Add a name not yet known to be real")).code).toBe(0);
    await archiveWith(["Ada Sample"]);
    expect((await commitFile("a.txt", "Ada Sample\nmore\n", "Add a line")).code).toBe(0);
    expect((await commitFile("b.txt", "Ada Sample\n", "Add it again")).code).not.toBe(0);
  });

  it("let through a phrase reviewed as not private", async () => {
    await mkdir(guardFolder(archiveDir), { recursive: true });
    await writeFile(join(guardFolder(archiveDir), "allow.json"), JSON.stringify({ multi: ["Ada Sample"] }));
    expect((await commitFile("a.txt", "Ada Sample\n", "Add a greeting")).code).toBe(0);
  });

  it("without an archive, check only for phone numbers, emails, chat ids and host names, and say so once", async () => {
    await rm(archiveFile(archiveDir));
    const clean = await commitFile("a.txt", "Ada Sample\n", "Add a greeting");
    expect(clean.code).toBe(0);
    expect(clean.stderr.trim().split("\n")).toEqual([
      expect.stringMatching(/^guard: no private dictionary \(no archive in .*\), so only checked for phone numbers, emails, chat ids and host names\.$/),
    ]);
    const email = ["ada.sample", "@", "post.zz"].join(""); // made up (no such domain), put together so this file holds none
    const result = await commitFile("b.txt", `${email}\n`, "Add an address");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`b.txt:1:1  ${RULES.email}`);
  });

  it("stop a commit when the archive is there but its names cannot be read, rather than check without them", async () => {
    await writeFile(archiveFile(archiveDir), "not a database");
    const result = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`guard: could not read the names in ${archiveFile(archiveDir)}`);
    expect(result.stderr).toContain("stopped, since without them it would pass real names.");
  });

  it("stop a commit in a repository that names no policy, saying how to name one", async () => {
    await git("config", "--unset", GIT_KEY);
    const result = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`names no privacy policy (git config ${GIT_KEY}), so nothing was checked; stopped.`);
    expect(result.stderr).toContain("npm run guard -- install <policy> --repo");
    await git("config", GIT_KEY, "no-such-policy");
    expect((await commitFile("a.txt", "hello\n", "Add a greeting")).stderr).toContain('names the privacy policy "no-such-policy", which the life archive does not have (policies: life-archive, public-fork;');
  });

  it("run on the life archive's Node, whichever Node the guarded repository's own folder names", async () => {
    // A version manager's `node` (the Vite+ shim, nvm, fnm, mise) runs the Node its working folder's .node-version names:
    // here, a stand-in that runs this test's Node anywhere but in a folder naming another, where it is a Node that cannot run the guard.
    const shim = join(root, "shim");
    await mkdir(shim);
    await writeFile(join(shim, "wrong-node"), `#!/bin/sh\necho "wrong node: the guarded folder's Node ran the guard" >&2\nexit 1\n`, { mode: 0o755 });
    await writeFile(
      join(shim, "node"),
      `#!/bin/sh\nif [ -f .node-version ] && [ "$(cat .node-version)" != "${process.versions.node}" ]; then exec "${join(shim, "wrong-node")}" "$@"; fi\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    pathFront = `${shim}:`;
    await writeFile(join(repo, ".node-version"), "20.0.0\n");
    expect((await run(repo, "node", ["-p", "1"])).stderr).toContain("wrong node"); // the stand-in does what it should

    await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    const clean = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(clean.stderr).not.toContain("wrong node");
    expect(clean.code).toBe(0);
    const named = await commitFile("b.txt", "Ada Sample\n", "Add a name");
    expect(named.stderr).toContain(`b.txt:1:1  ${RULES.person}`);
    await commitFile("c.txt", "fine\n", "Lunch with Ada Sample", "--no-verify");
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.stderr).not.toContain("wrong node");
    expect(pushed.stderr).toContain(`commit message, line 1, column 12  ${RULES.person}`);
    expect(pushed.code).not.toBe(0);
  });

  it("stop a push of commits that went in without the commit hooks", async () => {
    await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    await commitFile("a.txt", "hello\n", "Add a greeting");
    expect((await git("push", "-q", "--no-verify", "origin", "main")).code).toBe(0);

    await commitFile("b.txt", "fine\n", "Lunch with Ada Sample", "--no-verify");
    const sha = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain(`${sha} commit message, line 1, column 12  ${RULES.person}`);

    // A new remote: everything it does not have yet.
    await run(root, "git", ["init", "-q", "--bare", "fresh.git"]);
    const fresh = await git("push", "-q", join(root, "fresh.git"), "main");
    expect(fresh.code).not.toBe(0);
    expect(fresh.stderr).toContain(`${sha} commit message, line 1, column 12`);
  });

  it("stop a push to any ref but main under life-archive's policy, before checking anything, but let one be deleted", async () => {
    await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    await commitFile("a.txt", "hello\n", "Add a greeting");
    expect((await git("push", "-q", "--no-verify", "origin", "main")).code).toBe(0);
    await commitFile("b.txt", "fine\n", "Lunch with Ada Sample", "--no-verify");

    const refused = "guard: stopped this push: the life-archive policy pushes only to main, and it sends to";
    const branch = await git("push", "-q", "origin", "main:other");
    expect(branch.code).not.toBe(0);
    expect(branch.stderr).toContain(`${refused} refs/heads/other.\nPush main by name instead: git push <remote> main.`);
    expect(branch.stderr).not.toContain(RULES.person);
    const many = await git("push", "-q", "origin", "main:main", "HEAD:refs/codex/checkpoint", "HEAD:refs/tags/v1");
    expect(many.code).not.toBe(0);
    expect(many.stderr).toContain(`${refused} refs/codex/checkpoint, refs/tags/v1.`);
    expect((await git("ls-remote", "origin")).stdout).not.toMatch(/other|codex|tags/);

    expect((await git("push", "-q", "--no-verify", "origin", "HEAD~1:refs/heads/stray")).code).toBe(0);
    expect((await git("push", "-q", "origin", ":stray")).code).toBe(0);
    expect((await git("ls-remote", "origin")).stdout).not.toContain("stray");
  });
});

describe("judged flags", { timeout: 60_000 }, () => {
  const idOf = (stderr: string) => /\(finding ([0-9a-f]{12})/.exec(stderr)?.[1] ?? "";
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const records = (file: string) => join(guardFolder(archiveDir), "life-archive", file);
  const judgeAllow = (id: string, reason = "a version string in an upstream test") => guard("judge", id, "--allow", "--by", "firstmate", "--reason", reason);

  it("stop a version string read as an IP address with its id and firstmate's command, and let exactly that through once judged", async () => {
    const stopped = await commitFile("a.test.ts", `const version = "${VERSION}";\n`, "Add a version");
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toMatch(new RegExp(`a\\.test\\.ts:1:18  ${escape(RULES.ip)} {2}\\(finding [0-9a-f]{12}\\)\\n`));
    const id = idOf(stopped.stderr);
    expect(stopped.stderr).toContain(`run guard -- judge ${id} --allow --by firstmate --reason "<why it is not private, without the text>"`);
    expect(stopped.stderr).toContain("do not judge or\nallow it yourself, and do not add it to an allow list: hand its place and finding id to firstmate");
    expect(stopped.stderr).not.toContain(VERSION);

    const judged = await judgeAllow(id);
    expect(judged).toMatchObject({ code: 0, stderr: "" });
    expect(judged.stdout).toContain(`guard: judged finding ${id} (a.test.ts:1:18, ${RULES.ip}, the life-archive policy): allow, by firstmate: a version string in an upstream test.`);
    const passed = await git("commit", "-q", "-m", "Add a version");
    expect(passed.code).toBe(0);
    expect(passed.stderr).toContain("guard: let through 1 finding firstmate judged not private (npm run guard -- judgements).");

    // Any change to the lines it is in stops it again, as another finding.
    const changed = await commitFile("a.test.ts", `const version = "${VERSION}"; // upstream\n`, "Change the version");
    expect(changed.code).not.toBe(0);
    expect(idOf(changed.stderr)).not.toBe(id);

    // The records keep where, the rule and hashes, who judged and why, never the text.
    const [judgement] = (await readFile(records("judgements.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(judgement).toMatchObject({ id, policy: "life-archive", where: "a.test.ts:1:18", subject: "a.test.ts", rule: RULES.ip, kind: "ip-address", verdict: "allow", by: "firstmate", reason: "a version string in an upstream test" });
    expect(judgement.matchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(judgement.contentHash).toMatch(/^[0-9a-f]{64}$/);
    for (const file of ["judgements.jsonl", "flagged-findings.jsonl"]) expect(await readFile(records(file), "utf8")).not.toContain(VERSION);
  });

  it("honour an allow at the push, for a file's lines and for a commit message", async () => {
    await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    await commitFile("a.txt", "hello\n", "Add a greeting");
    expect((await git("push", "-q", "--no-verify", "origin", "main")).code).toBe(0);

    const message = `Bump to ${VERSION}\n\nAs upstream has it.`;
    const file = await commitFile("version.txt", `${VERSION}\n`, message);
    expect(file.stderr).toContain(`version.txt:1:1  ${RULES.ip}`);
    expect((await judgeAllow(idOf(file.stderr))).code).toBe(0);
    const inMessage = await git("commit", "-q", "-m", message);
    expect(inMessage.stderr).toContain(`commit message, line 1, column 9  ${RULES.ip}`);
    expect((await judgeAllow(idOf(inMessage.stderr), "a version number")).code).toBe(0);
    expect((await git("commit", "-q", "-m", message)).code).toBe(0);

    // The push's local check reads them as the commit hooks did, and lets both through, on to the model's review (no Codex here).
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.stderr).toContain("guard: let through 2 findings firstmate judged not private");
    expect(pushed.stderr).not.toContain("it would publish what looks like private data");
    expect(pushed.stderr).toContain("privacy-review: stopped this push: no review:");
  });

  it("stop a first name kept as a private term however it is written, and never let one be judged through", async () => {
    // Made-up stand-ins for the family's first names, which private-terms.json keeps beside the real archive. One word
    // alone is no one's name to the dictionary, so without the terms these go through.
    const notes: [string, string, number][] = [["a.md", "Dinner with Kira tonight\n", 13], ["b.md", "juno's first scan\n", 1], ["c.md", "from ROWAN\n", 6]];
    for (const [file, text] of notes) {
      expect((await commitFile(file, text, "Add a note")).code).toBe(0);
      await rm(join(repo, file));
      await git("commit", "-q", "-a", "-m", "Remove the note");
    }
    await mkdir(guardFolder(archiveDir), { recursive: true });
    await writeFile(join(guardFolder(archiveDir), "private-terms.json"), JSON.stringify({ terms: ["Kira", "Juno", "Rowan"] }));
    let id = "";
    for (const [file, text, column] of notes) {
      const result = await commitFile(file, text, "Add a note");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(new RegExp(`${escape(file)}:1:${column}  ${escape(RULES.term)}  \\(finding [0-9a-f]{12}; never let through\\)`));
      expect(result.stderr).toContain('A finding marked "never let through"');
      expect(result.stderr).not.toContain("guard -- judge");
      expect(result.stderr).not.toMatch(/kira|juno|rowan/i);
      id ||= idOf(result.stderr);
      await git("reset", "-q");
    }

    const refused = await judgeAllow(id, "a made-up name");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`guard: finding ${id} (a.md:1:13, ${RULES.term}) can never be let through: it is one of the captain's private terms.`);
    expect(existsSync(records("judgements.jsonl"))).toBe(false);
    // A block may be recorded; it changes nothing.
    expect((await guard("judge", id, "--block", "--by", "firstmate", "--reason", "a family name")).code).toBe(0);
    expect((await commitFile("a.md", "Dinner with Kira tonight\n", "Add a note")).code).not.toBe(0);
  });

  it("keep a finding judged to block stopped, marked so, with no command to judge it", async () => {
    const first = await commitFile("a.txt", `const host = "${VERSION}";\n`, "Add a host");
    const id = idOf(first.stderr);
    expect((await guard("judge", id, "--block", "--by", "firstmate", "--reason", "unsure whose machine this is")).code).toBe(0);
    const again = await git("commit", "-q", "-m", "Add a host");
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain(`(finding ${id}; judged: stays stopped)`);
    expect(again.stderr).not.toContain("guard -- judge");
    // A later allow overrides it: the latest judgement counts.
    expect((await judgeAllow(id, "a version after all")).code).toBe(0);
    expect((await git("commit", "-q", "-m", "Add a host")).code).toBe(0);
  });

  it("judge only a flagged finding, with a verdict, who and a one-line reason that does not quote the text", async () => {
    const stopped = await commitFile("a.txt", `${VERSION}\n`, "Add a version");
    const id = idOf(stopped.stderr);
    expect(await guard("judge", "0123456789ab", "--allow", "--by", "firstmate", "--reason", "fine")).toMatchObject({
      code: 1,
      stderr: "guard: no finding 0123456789ab has been flagged (the guard prints each finding's id when it stops a commit); nothing judged.\n",
    });
    const usage = 'usage: npm run guard -- judge <finding> (--allow | --block) --by <who> --reason "<why, in one line, without the text>"\n';
    expect(await guard("judge", id, "--allow", "--reason", "fine")).toMatchObject({ code: 2, stderr: usage });
    expect(await guard("judge", id, "--by", "firstmate", "--reason", "fine")).toMatchObject({ code: 2, stderr: usage });
    expect(await guard("judge", id, "--allow", "--block", "--by", "firstmate", "--reason", "fine")).toMatchObject({ code: 2, stderr: usage });
    expect((await guard("judge", id, "--allow", "--by", "firstmate", "--reason", "fine\nand more")).code).toBe(2);
    const quoting = await judgeAllow(id, `${VERSION} is a version`);
    expect(quoting.code).toBe(1);
    expect(quoting.stderr).toContain("the reason quotes the matched text");
    expect(existsSync(records("judgements.jsonl"))).toBe(false);
  });

  it("list the judgements, every policy's, for the captain to skim, never the text", async () => {
    expect((await guard("judgements")).stdout).toBe("No judgements yet.\n");
    const stopped = await commitFile("a.txt", `${VERSION}\n`, "Add a version");
    const id = idOf(stopped.stderr);
    await judgeAllow(id);
    const listed = await guard("judgements");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  life-archive  allow  a\\.txt:1:1  ${escape(RULES.ip)} {2}\\(finding ${id}\\)\\n  by firstmate: a version string in an upstream test\\n$`));
    expect((await guard("judgements", "--repo", repo)).stdout).toBe(listed.stdout);
  });
});

describe("the author check", { timeout: 60_000 }, () => {
  const other = "ada.sample@example.com"; // made up
  const id = async () => (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
  const stopped = (what: string, count: string) => `guard: stopped ${what}: ${count} an author or committer email that is not a GitHub noreply address, which would publish it.`;

  it("stops a push of a commit whose author is not a noreply address, naming the commit and how to fix it but not the address", async () => {
    await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    await commitFile("a.txt", "hello\n", "Add a greeting");
    expect((await git("push", "-q", "--no-verify", "origin", "main")).code).toBe(0);

    await commitFile("b.txt", "fine\n", "Add more", `--author=Test <${other}>`);
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain(`${stopped("this push", "1 commit names")}\n  ${await id()}  author\n`);
    expect(pushed.stderr).toContain("git commit --amend --no-edit --reset-author");
    expect(pushed.stderr).toContain(`"authors" in ${join(guardFolder(archiveDir), "allow.json")}`);
    expect(pushed.stderr).not.toContain(other);
    expect((await git("ls-remote", "origin", "main")).stdout).not.toContain((await git("rev-parse", "HEAD")).stdout.trim());

    // Made again under the noreply address, it gets past this check (to the model's review, which there is no Codex for here).
    await git("commit", "-q", "--amend", "--no-edit", "--reset-author");
    expect((await git("push", "-q", "origin", "main")).stderr).not.toContain("noreply");
  });

  it("stops a range or a review naming a committer or author not allowed, every commit checked, and lets through one allow.json lists", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting", "--no-verify");
    await git("-c", `user.email=${other}`, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Commit as another", "--author=Test <0+test@users.noreply.github.com>");
    const committer = await id();
    await git("-c", `user.email=${other}`, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Commit as another again");
    const both = await id();

    const range = await guard("range", "main");
    expect(range.code).toBe(1);
    expect(range.stderr).toContain(`${stopped("these commits", "2 commits name")}\n  ${committer}  committer\n  ${both}  author, committer\n`);
    expect(range.stderr).not.toContain(other);
    expect((await guard("review", "main")).stderr).toContain(stopped("these commits", "2 commits name"));

    await mkdir(guardFolder(archiveDir), { recursive: true });
    await writeFile(join(guardFolder(archiveDir), "allow.json"), JSON.stringify({ multi: [], authors: ["Ada.Sample@example.com"] }));
    expect(await guard("range", "main")).toMatchObject({ code: 0, stderr: "" });
  });

  it("scans on a settings file it cannot use, and stops the model's review in its own words, nothing passed", async () => {
    await commitFile("a.txt", "hello\n", "Add a greeting", "--no-verify");
    const wrong = join(archiveDir, "settings.json");
    await writeFile(wrong, JSON.stringify({ timezone: "Asia/Tokyo" }));
    vi.stubEnv("LIFE_ARCHIVE_SETTINGS", wrong);
    try {
      expect(await guard("range", "main")).toMatchObject({ code: 0, stderr: "" });
      const review = await guard("review", "main");
      expect(review.code).toBe(1);
      expect(review.stderr).toMatch(/^guard: the archive's settings and modules could not be loaded for the model's review, so nothing has passed it: .*is not what docs\/settings\.md describes/);
      expect(review.stderr).not.toMatch(/^\s+at .*:\d+:\d+/m);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets GitHub's own noreply address commit", async () => {
    await git("-c", "user.email=noreply@github.com", "commit", "-q", "--allow-empty", "--no-verify", "-m", "Merge on GitHub");
    expect(await guard("range", "main")).toMatchObject({ code: 0, stderr: "" });
  });
});

describe("guard install", { timeout: 60_000 }, () => {
  it("points the repository's git at the guard's hooks under a policy, and says what it checks against", async () => {
    await git("config", "--unset", "core.hooksPath");
    await git("config", "--unset", GIT_KEY);
    const result = await guard("install", "life-archive", "--repo", repo);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`git now runs ${HOOKS}/ (pre-commit, commit-msg, pre-push) in ${repo}`);
    expect(result.stdout).toContain(`it checks against the names in ${archiveFile(archiveDir)} (1 person names, 1 self names,`);
    expect((await git("config", "core.hooksPath")).stdout.trim()).toBe(HOOKS);
    expect((await git("config", GIT_KEY)).stdout.trim()).toBe("life-archive");
    expect((await commitFile("a.txt", "Ada Sample\n", "Add a name")).code).not.toBe(0);
  });

  it("will not install from a checkout with no archive, whose hooks would read no names", async () => {
    await git("config", "--unset", "core.hooksPath");
    await rm(archiveFile(archiveDir));
    const result = await guard("install", "life-archive");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`guard: there is no archive in ${archiveDir}, so the hooks would check without its names;`);
    expect((await git("config", "core.hooksPath")).code).not.toBe(0);
  });

  it("takes only a policy it has", async () => {
    const result = await guard("install", "no-such-policy");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("guard: install takes a policy: life-archive, public-fork.");
  });

  it("runs another hooks folder's hooks first, as written, and keeps it when installed again", async () => {
    // The repository's own: a pre-commit that stops a file named "stop", and a post-commit and a pre-push that say they ran.
    await mkdir(join(repo, "scripts", "git-hooks"), { recursive: true });
    const own = {
      "pre-commit": `#!/bin/sh\nif git diff --cached --name-only | grep -qx stop; then echo "own pre-commit stopped it" >&2; exit 1; fi\n`,
      "post-commit": `#!/bin/sh\necho "own post-commit ran" >&2\n`,
      "pre-push": `#!/bin/sh\necho "own pre-push got $(cat | wc -l | tr -d ' ') ref" >&2\n`,
    };
    for (const [name, text] of Object.entries(own)) await writeFile(join(repo, "scripts", "git-hooks", name), text, { mode: 0o755 });
    await git("config", "core.hooksPath", "scripts/git-hooks");
    await git("config", "--unset", GIT_KEY);
    const installed = await guard("install", "public-fork");
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain(`each hook runs the repository's own from scripts/git-hooks first, as git ran them before (git config ${CHAIN_KEY}).`);
    expect((await git("config", "core.hooksPath")).stdout.trim()).toBe(HOOKS);
    expect((await git("config", CHAIN_KEY)).stdout.trim()).toBe("scripts/git-hooks");
    expect((await guard("install", "public-fork")).code).toBe(0);
    expect((await git("config", CHAIN_KEY)).stdout.trim()).toBe("scripts/git-hooks");

    const stopped = await commitFile("stop", "hello\n", "Add a file its own hook stops");
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toContain("own pre-commit stopped it");
    await git("reset", "-q");
    const passed = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(passed.code).toBe(0);
    expect(passed.stderr).toContain("own post-commit ran");
    expect((await commitFile("b.txt", "Ada Sample\n", "Add a name")).stderr).toContain(`b.txt:1:1  ${RULES.person}`);

    await run(root, "git", ["init", "-q", "--bare", "remote.git"]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.stderr).toContain("own pre-push got 1 ref");
    // Both read the refs: the guard's push check had them too, and went on to the model's review, stopped with no Codex here.
    expect(pushed.stderr).toContain("privacy-review: stopped this push: no review:");
    expect(pushed.code).not.toBe(0);
  });

  it("runs the repository's own .git/hooks first when it has some, and nothing more when it has none", async () => {
    await git("config", "--unset", "core.hooksPath");
    const hooks = join(repo, ".git", "hooks");
    await writeFile(join(hooks, "pre-commit"), `#!/bin/sh\necho "own pre-commit ran" >&2\n`, { mode: 0o755 });
    expect((await guard("install", "life-archive")).code).toBe(0);
    expect((await git("config", CHAIN_KEY)).stdout.trim()).toBe(hooks);
    expect((await commitFile("a.txt", "hello\n", "Add a greeting")).stderr).toContain("own pre-commit ran");

    await git("config", "--unset", "core.hooksPath");
    await rm(join(hooks, "pre-commit"));
    const plain = await guard("install", "life-archive");
    expect(plain.stdout).not.toContain("each hook runs");
    expect((await git("config", CHAIN_KEY)).code).not.toBe(0);
    expect((await commitFile("a.txt", "hello again\n", "Add another greeting")).code).toBe(0);
  });
});

describe("the private dictionary", () => {
  it("holds the archive's names, aliases, accounts, chats, tags, locations and notes for people, each once, the captain's apart", async () => {
    const db = new DatabaseSync(archiveFile(archiveDir));
    db.exec(`
      UPDATE person SET aliases_json = '["Addy"]', note = 'Met at the made-up climbing gym', location = 'Gold Coast' WHERE name = 'Ada Sample';
      INSERT INTO import_person (platform, key, key_kind, display_name, handle, is_self) VALUES
        ('telegram', 'user:9990001234', 'id', 'Ada Sample', 'ada_fixture_77', 0),
        ('messenger', 'Bruno Placeholder', 'name', 'Bruno Placeholder', NULL, 0),
        ('discord', 'quinn.tester', 'id', 'Quinn Testperson', NULL, 1);
      INSERT INTO conversation (platform, platform_conversation_id, type, title) VALUES ('telegram', 'chat:4440001', 'group', 'Sample Walkers');
    `);
    db.close();
    const dictionary = readDictionary(archiveFile(archiveDir));
    expect(dictionary).toMatchObject({
      person_names: ["Ada Sample", "Addy"],
      self_names: ["Quinn Testperson"],
      account_names: ["Ada Sample", "Bruno Placeholder"],
      account_ids: [["telegram", "ada_fixture_77"], ["telegram", "user:9990001234"], ["telegram", "chat:4440001"]],
      self_account_ids: [["discord", "quinn.tester"]],
      group_titles: ["Sample Walkers"],
      locations: ["Gold Coast"],
      person_text: ["Met at the made-up climbing gym"],
    });
    expect(dictionary.tags).toEqual(expect.arrayContaining(["archive", "keep"]));
  });

  it("is none without an archive, and says so", () => {
    expect(loadPrivateData(join(root, "nothing"))).toEqual({
      allowed: [],
      terms: [],
      note: `no private dictionary (no archive in ${join(root, "nothing")}), so only checked for phone numbers, emails, chat ids and host names`,
    });
  });

  it("reads the reviewed terms", async () => {
    await mkdir(guardFolder(archiveDir), { recursive: true });
    await writeFile(join(guardFolder(archiveDir), "allow.json"), JSON.stringify({ why: "", multi: ["Ada Sample", 3], self_words: ["quinn"] }));
    expect(loadPrivateData(archiveDir).allowed).toEqual(["Ada Sample"]);
  });

  it("is counted, never shown, by guard dictionary", { timeout: 30_000 }, async () => {
    const result = await guard("dictionary");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^guard: .*archive\.sqlite gives the check 1 person names, 1 self names, 0 account names, 0 account ids, .*\.\nguard: there are no private terms \(.*private-terms\.json\)\.\n$/);
    expect(result.stdout).not.toMatch(/Ada|Quinn/);
  });
});

describe("guard scan", { timeout: 30_000 }, () => {
  it("says where each finding is and its rule, or each one's offsets with --json, never the text, and exits 1 on any", async () => {
    await writeFile(join(root, "page.js"), 'const a = 1;\nconst who = "Ada Sample";\n');
    await writeFile(join(root, "clean.js"), "const a = 1;\n");
    const found = await guard("scan", join(root, "page.js"), join(root, "clean.js"));
    expect(found.code).toBe(1);
    expect(found.stdout).toBe(`${join(root, "page.js")}:2:14  ${RULES.person}\n`);
    const json = await guard("scan", "--json", join(root, "page.js"));
    expect(JSON.parse(json.stdout)).toEqual({ file: join(root, "page.js"), rule: RULES.person, start: 26, end: 36 });
    expect((await guard("scan", join(root, "clean.js"))).code).toBe(0);
    expect(await guard("scan", join(root, "missing.js"))).toMatchObject({ code: 2, stderr: `guard: could not read ${join(root, "missing.js")}.\n` });
  });
});

describe("addedTexts", () => {
  const diff = [
    "diff --git a/old.ts b/old.ts",
    "index 1111111..2222222 100644",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -3,0 +4,2 @@ context",
    "+first added",
    "+second added",
    "@@ -9 +11 @@",
    "-gone",
    "+replaced",
    "diff --git a/new.md b/new.md",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new.md",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/shot.png b/shot.png",
    "new file mode 100644",
    "index 0000000..4444444",
    "Binary files /dev/null and b/shot.png differ",
    "diff --git a/plus.md b/plus.md",
    "index 5555555..6666666 100644",
    "--- a/plus.md",
    "+++ b/plus.md",
    "@@ -1,0 +2 @@",
    "+++ a line that looks like a header",
    "diff --git a/dead.txt b/dead.txt",
    "deleted file mode 100644",
    "--- a/dead.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  it("takes each run of added lines as one text, numbered as in the new file, and each new file's name, a binary one's too", () => {
    const texts = addedTexts(diff, "abc1234 ");
    expect(texts.map((t) => t.text)).toEqual(["first added\nsecond added", "replaced", "new.md", "hello", "shot.png", "++ a line that looks like a header"]);
    expect(texts.map((t) => t.place(t.text.split("\n").length, 2))).toEqual([
      "abc1234 old.ts:5:2",
      "abc1234 old.ts:11:2",
      "abc1234 new.md (its file name)",
      "abc1234 new.md:1:2",
      "abc1234 shot.png (its file name)",
      "abc1234 plus.md:2:2",
    ]);
  });

  it("says which files are binary, and leaves deleted files out", () => {
    expect(addedFiles(diff).map(({ path, named, binary }) => ({ path, named, binary }))).toEqual([
      { path: "old.ts", named: false, binary: false },
      { path: "new.md", named: true, binary: false },
      { path: "shot.png", named: true, binary: true },
      { path: "plus.md", named: false, binary: false },
    ]);
  });
});

describe("messageText", () => {
  it("blanks comment lines and drops everything from the scissors line on", () => {
    expect(messageText("Fix\n# Ada Sample\nbody\n")).toBe("Fix\n\nbody\n");
    expect(messageText("Fix\n; note\n", ";")).toBe("Fix\n\n");
    expect(messageText("Fix\n# ------------------------ >8 ------------------------\n+Ada Sample\n")).toBe("Fix");
  });
});
