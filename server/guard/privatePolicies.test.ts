// The guard in a public fork (policies/publicFork.ts): installed under public-fork itself, or under a policy of the
// installation's own that extends it (sample-fork, named in the test archive's guard/policies.json, privatePolicies.ts),
// in a made-up fork with an upstream, reading a test archive and made-up private terms (never the real ones), with a
// stand-in for Codex that passes. Every host, profile, path, address and policy here is made up.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGuardArchive } from "../fixtures/guardArchive.ts";
import { termsFile } from "./dictionary.ts";
import { PUBLIC_FORK } from "./policies/publicFork.ts";
import { loadPolicies, policiesFile } from "./privatePolicies.ts";
import { readFindings, readReviewed, recordsFolder } from "./records.ts";
import { NOT_STOPPING, SUGGESTION } from "./review.ts";
import { RULES } from "./scan.ts";

const SCRIPT = fileURLToPath(new URL("./cli.ts", import.meta.url));

// A stand-in for Codex that keeps what it was given and passes it, or answers STUB_ANSWER.
const STUB = `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > "$STUB_DIR/prompt"
pass='{"findings":[]}'
printf '%s' "\${STUB_ANSWER:-$pass}" > "$out"
`;

// A live-check table and a picture's caption in the shape of the fork's commit an old policy stopped for
// "infrastructure": which agents and models were run on the captain's build, and what waits on his setup. Ordinary.
const VERIFICATION = [
  "On 2026-10-31 each harness was checked live on the captain's macOS arm64 build, at effort `low`:",
  "",
  "| Harness | Model | Result |",
  "| --- | --- | --- |",
  "| `claude` | `claude-haiku-5-5` | reported `done`, and was cleaned up |",
  "| `grok` | `grok-4.7-build-fast` | the same |",
  "",
  "Waits on the captain's setup: enable and sign in.",
  "",
].join("\n");

// The private terms, as guard/private-terms.json holds the captain's: hosts, a machine, a profile and its folder, a
// tailnet, a home path and a personal address (put together, so this file holds no whole address).
const GMAIL = ["vex.owner", "@", "gmail.com"].join("");
const TERMS = ["vexcorp-zdata", "vexcorp-bsc-archival", "qz7", "qz7-claudeq", "claudeq", ".claude-profiles/q", "tailf00d1", "/Users/vexowner", GMAIL];
const NOREPLY = "0+test@users.noreply.github.com"; // a made-up GitHub noreply address (no account has id 0)
const UPSTREAM_AUTHOR = ["dev", "@", "upstream.zz"].join("");
// A made-up tailnet host and a version string the check reads as an IP address, in pieces as GMAIL is.
const TAILNET_HOST = ["qz7", "tailf00d1", "ts", "net"].join(".");
const VERSION = ["1", "2", "0", "1"].join(".");

// The leak the guard is for, in its shape: a dev-journal entry naming the captain's hosts and their token counts, and a
// profile he removed.
const LEAK = [
  "## 2026-10-19: usage across the fleet",
  "",
  "Tokens by host this week: vexcorp-zdata 1.2M, vexcorp-bsc-archival 840k, qz7-claudeq 3.1M.",
  "Dropped the ClaudeQ profile (~/.claude-profiles/q) once its login moved.",
  "",
].join("\n");

// What upstream's code and the fork's docs hold that must pass: identifiers that share a piece of a host's name, and
// placeholder tailnet hosts.
const ORDINARY = [
  "export const readZData = (zdata: Uint8Array) => inflate(zdata);",
  "// Reach the server from a phone at https://your-mac.tail1234.ts.net:3773 or https://example.ts.net.",
  "",
].join("\n");

// A fork of the installation's own, as guard/policies.json names it: main pushed alone, and upstream's identifier let
// through though a private term shares it.
const SAMPLE_FORK = {
  extends: "public-fork",
  about: "a made-up public fork of a sample app, merged from its upstream with its owner's changes on top",
  pushBranches: ["main"],
  allowed: ["zdata"],
};

let root: string;
let fork: string;
let archiveDir: string;
/** What the stand-in answers, when not a pass. */
let stubAnswer = "";

const env = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") && !["LIFE_ARCHIVE_DATA", "FRIEND_MAP_DATA", "INIT_CWD", "npm_lifecycle_event", "LIFE_ARCHIVE_SKIP_PUSH_REVIEW", "FRIEND_MAP_SKIP_PUSH_REVIEW"].includes(key),
    ),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  LIFE_ARCHIVE_DATA: archiveDir,
  LIFE_ARCHIVE_CODEX: join(root, "codex"),
  STUB_DIR: root,
  ...(stubAnswer ? { STUB_ANSWER: stubAnswer } : {}),
});

function run(cwd: string, command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(command, args, { cwd, env: env(), encoding: "utf8" }, (error, stdout, stderr) => {
      done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const git = (...args: string[]) => run(fork, "git", args);
const guard = (...args: string[]) => run(fork, process.execPath, ["--no-warnings", SCRIPT, ...args, "--repo", fork]);

async function commitFile(name: string, text: string, message: string, ...flags: string[]) {
  await mkdir(dirname(join(fork, name)), { recursive: true });
  await writeFile(join(fork, name), text);
  await git("add", name);
  return git("commit", "-q", "-m", message, ...flags);
}

/** A commit on upstream, by upstream's own author, adding a line with an email in it. */
async function upstreamCommit(upstream: string, name: string) {
  const at = (...args: string[]) => run(upstream, "git", ["-c", "user.name=Dev", "-c", `user.email=${UPSTREAM_AUTHOR}`, ...args]);
  await writeFile(join(upstream, name), `maintained by ${UPSTREAM_AUTHOR}\n`);
  await at("add", name);
  await at("commit", "-q", "-m", `Add ${name}`);
  await at("push", "-q", "origin", "main");
}

const head = async () => (await git("rev-parse", "HEAD")).stdout.trim();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "life-archive-guard-forks-")));
  stubAnswer = "";
  [fork, archiveDir] = [join(root, "fork"), join(root, "archive")];
  await writeGuardArchive(archiveDir, { people: ["Ada Sample"] });
  await mkdir(dirname(termsFile(archiveDir)), { recursive: true });
  await writeFile(termsFile(archiveDir), JSON.stringify({ terms: TERMS }));
  await writeFile(policiesFile(archiveDir), JSON.stringify({ policies: { "sample-fork": SAMPLE_FORK } }));
  await writeFile(join(root, "codex"), STUB);
  await chmod(join(root, "codex"), 0o755);

  // Upstream, with a commit of its own; the fork starts as upstream's main, with its own origin and a hook of its own.
  for (const bare of ["upstream.git", "origin.git"]) await run(root, "git", ["init", "-q", "--bare", "-b", "main", bare]);
  await run(root, "git", ["clone", "-q", join(root, "upstream.git"), "upstream"]);
  await upstreamCommit(join(root, "upstream"), "one.txt");
  await run(root, "git", ["clone", "-q", "-o", "upstream", join(root, "upstream.git"), "fork"]);
  await git("remote", "add", "origin", join(root, "origin.git"));
  await git("config", "user.name", "Test");
  await git("config", "user.email", NOREPLY);
  await mkdir(join(fork, ".hooks"));
  await writeFile(join(fork, ".hooks", "pre-commit"), `#!/bin/sh\necho "own pre-commit ran" >&2\n`, { mode: 0o755 });
  await git("config", "core.hooksPath", ".hooks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the sample-fork policy", { timeout: 120_000 }, () => {
  beforeEach(async () => {
    expect((await guard("install", "sample-fork")).code).toBe(0);
  });

  it("stops the dev-journal leak at the commit, each host, profile and folder by place, never shown", async () => {
    const result = await commitFile("docs/dev-journal.md", LEAK, "docs: note usage across the fleet");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("own pre-commit ran");
    for (const where of ["3:27", "3:47", "3:74", "4:13", "4:32"]) expect(result.stderr).toContain(`docs/dev-journal.md:${where}  ${RULES.term}`);
    expect(result.stderr).not.toMatch(/vexcorp|qz7|claudeq|claude-profiles/i);
  });

  it("stops a home path, a tailnet host and a personal address the same way, in code or a commit message", async () => {
    const code = await commitFile("a.ts", `const home = "/Users/vexowner/Projects";\nconst mac = "${TAILNET_HOST}";\n`, "Add paths");
    expect(code.code).not.toBe(0);
    expect(code.stderr).toContain(`a.ts:1:15  ${RULES.term}`);
    expect(code.stderr).toContain(`a.ts:2:14  ${RULES.tailnet}`);
    await git("reset", "-q", "--hard");
    const message = await commitFile("b.txt", "hello\n", `Add a greeting\n\nAsk ${GMAIL} for the key.`);
    expect(message.code).not.toBe(0);
    expect(message.stderr).toContain(`commit message, line 3, column 5`);
  });

  it("lets upstream's identifiers and placeholder hosts through, and a push of them gives the model no made-up names", async () => {
    expect((await commitFile("src/hasher.ts", ORDINARY, "feat: read compressed data")).code).toBe(0);
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    const prompt = await readFile(join(root, "prompt"), "utf8");
    expect(prompt).toContain("the sample-fork policy");
    expect(prompt).toContain("[kind: private-host]");
    // What his setup runs is no kind of its own any more: at most a suggestion.
    expect(prompt).not.toContain("infrastructure");
    expect(prompt).not.toContain("<made-up-names>");
  });

  it("lets through an identifier the policy calls ordinary, even when it is a private term", async () => {
    await writeFile(termsFile(archiveDir), JSON.stringify({ terms: [...TERMS, "zdata"] }));
    expect((await commitFile("src/hasher.ts", ORDINARY, "feat: read compressed data")).code).toBe(0);
    expect((await commitFile("notes.md", "vexcorp-zdata\n", "Add a host")).code).not.toBe(0);
  });

  it("stops a push of a commit made under a personal address", async () => {
    await git("-c", `user.email=${GMAIL}`, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Commit as the captain's personal address");
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("an author or committer email that is not a GitHub noreply address");
  });

  it("leaves upstream's commits out of a push that merges them, and reads the merge for its resolution alone", async () => {
    expect((await git("push", "-q", "--no-verify", "origin", "main")).code).toBe(0);
    await upstreamCommit(join(root, "upstream"), "two.txt");
    expect((await commitFile("fork.txt", "the fork's own change\n", "feat: the fork's own change")).code).toBe(0);
    await git("fetch", "-q", "upstream");
    expect((await git("merge", "-q", "--no-edit", "-m", "Merge upstream into the fork", "upstream/main")).code).toBe(0);
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    const prompt = await readFile(join(root, "prompt"), "utf8");
    expect(prompt).toContain("the fork's own change");
    expect(prompt).toContain("Merge upstream into the fork");
    expect(prompt).not.toContain("two.txt");
    expect(prompt).not.toContain(UPSTREAM_AUTHOR);
  });

  describe("a merge being committed", () => {
    // Upstream's side: a version string that looks like an IP address and a private term, in a file of its own and in
    // the line both sides change; the fork's side changes that line too, so the merge stops for its resolution.
    const UPSTREAM_TEXT = `pinned to ${VERSION} on vexcorp-zdata\n`;
    beforeEach(async () => {
      const upstream = join(root, "upstream");
      const at = (...args: string[]) => run(upstream, "git", ["-c", "user.name=Dev", "-c", `user.email=${UPSTREAM_AUTHOR}`, ...args]);
      await writeFile(join(upstream, "one.txt"), UPSTREAM_TEXT);
      await writeFile(join(upstream, "pins.md"), `# Pins\n\n${UPSTREAM_TEXT}`);
      await at("add", "-A");
      await at("commit", "-q", "-m", "Pin the version");
      await at("push", "-q", "origin", "main");
      expect((await commitFile("one.txt", "the fork's own line\n", "feat: the fork's own line")).code).toBe(0);
      await git("fetch", "-q", "upstream");
      expect((await git("merge", "--no-edit", "upstream/main")).stdout).toContain("CONFLICT");
    });

    it("lets through what upstream brings, though the guard would stop the same text in a commit of the fork's own", async () => {
      await git("checkout", "--theirs", "one.txt");
      await git("add", "one.txt");
      const merged = await git("commit", "-q", "--no-edit");
      expect(merged.stderr).not.toContain("guard: stopped");
      expect(merged.code).toBe(0);
      expect((await git("rev-list", "--parents", "-1", "HEAD")).stdout.trim().split(" ")).toHaveLength(3);

      const own = await commitFile("copy.md", UPSTREAM_TEXT, "docs: the same text, the fork's own");
      expect(own.code).not.toBe(0);
      expect(own.stderr).toContain("guard: stopped this commit");
      expect(own.stderr).toContain(`copy.md:1:11  ${RULES.ip}`);
      expect(own.stderr).toContain(`copy.md:1:22  ${RULES.term}`);
    });

    it("stops what its resolution adds, by place, and nothing upstream brought", async () => {
      await writeFile(join(fork, "one.txt"), `${UPSTREAM_TEXT}the fork's own line, on ${TAILNET_HOST}\n`);
      await git("add", "one.txt");
      const merged = await git("commit", "-q", "--no-edit");
      expect(merged.code).not.toBe(0);
      expect(merged.stderr).toContain("guard: stopped this merge");
      expect(merged.stderr).toContain(`one.txt:2:25  ${RULES.tailnet}`);
      expect(merged.stderr).not.toContain("one.txt:1:");
      expect(merged.stderr).not.toContain("pins.md");
      expect(merged.stderr).not.toMatch(/vexcorp|qz7|tailf00d1/);
    });

    it("stops the commits a merge brings from anywhere but upstream, each as its own", async () => {
      await git("merge", "--abort");
      await git("checkout", "-q", "-b", "side", "HEAD~1");
      expect((await commitFile("side.md", "on qz7-claudeq\n", "docs: a side note", "--no-verify")).code).toBe(0);
      const side = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
      await git("checkout", "-q", "main");
      await git("merge", "--no-commit", "--no-ff", "side");
      const merged = await git("commit", "-q", "--no-edit");
      expect(merged.code).not.toBe(0);
      expect(merged.stderr).toContain("guard: stopped this merge");
      expect(merged.stderr).toContain(`${side} side.md:1:4  ${RULES.term}`);
    });
  });

  it("stops a push to any branch but main", async () => {
    const pushed = await git("push", "-q", "origin", "main:other");
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("the sample-fork policy pushes only to main");
  });

  it("settles only published history, and then reads none of it, nor who made it", async () => {
    // History published before the guard: a commit under an address that is not noreply.
    await git("-c", "user.email=old@example.invalid", "commit", "-q", "--allow-empty", "--no-verify", "-m", "An old commit");
    expect((await git("push", "-q", "--no-verify", "origin", "main")).code).toBe(0);
    const published = await head();
    expect((await commitFile("new.txt", "new\n", "feat: something new")).code).toBe(0);

    const unpublished = await guard("settle", "HEAD");
    expect(unpublished.code).toBe(1);
    expect(unpublished.stderr).toContain("so it is not published yet; not settling it.");

    // A new remote has none of it, so a push there sends all of it: stopped for the old commit's address, until settled.
    await run(root, "git", ["init", "-q", "--bare", "fresh.git"]);
    await git("remote", "add", "fresh", join(root, "fresh.git"));
    expect((await git("push", "-q", "fresh", "main")).stderr).toContain("not a GitHub noreply address");
    const settled = await guard("settle", "origin/main");
    expect(settled.code).toBe(0);
    expect(settled.stdout).toContain(`settled ${published.slice(0, 10)} on origin/main, with all before it, under the sample-fork policy`);
    expect(await readReviewed(recordsFolder(archiveDir, "sample-fork"), { history: true })).toEqual(new Set([published]));
    expect((await guard("settle", "origin/main")).stdout).toContain("already settled");

    expect((await git("push", "-q", "fresh", "main")).code).toBe(0);
    const prompt = await readFile(join(root, "prompt"), "utf8");
    expect(prompt).toContain("feat: something new");
    expect(prompt).not.toContain("An old commit");
    expect(prompt).not.toContain("Add one.txt");
  });
});

describe("the public-fork policy", { timeout: 120_000 }, () => {
  beforeEach(async () => {
    expect((await guard("install", "public-fork")).code).toBe(0);
  });

  it("stops the same leak, but pushes any branch, as a fork's task branches go", async () => {
    expect((await commitFile("docs/dev-journal.md", LEAK, "docs: note usage across the fleet")).code).not.toBe(0);
    await git("reset", "-q", "--hard");
    expect((await commitFile("docs/fm.md", ORDINARY, "docs: reach the server from a phone")).code).toBe(0);
    expect((await git("push", "-q", "origin", "main:fm/some-task")).code).toBe(0);
    expect(await readFile(join(root, "prompt"), "utf8")).toContain("the public-fork policy");
  });

  it("lets a live-check table through, the model's suggestions on it kept for the captain but stopping nothing", async () => {
    expect((await commitFile("docs/verification.md", VERIFICATION, "docs: record the live check")).code).toBe(0);
    const id = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
    const finding = (line: number, kind: string, text: string) => ({ commit: id, file: "docs/verification.md", line, kind, text, reason: "names the captain's setup", suggestion: "say it generically" });
    stubAnswer = JSON.stringify({ findings: [finding(8, SUGGESTION, "the captain's setup"), finding(1, "private-host", "zq-build-host")] });
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain("privacy-review: 2 suggestions, which stop nothing");
    expect(await readReviewed(recordsFolder(archiveDir, "public-fork"))).toContain(await head());
    const kept = await readFindings(recordsFolder(archiveDir, "public-fork"));
    expect(kept.map((f) => [f.line, f.kind, f.stops, f.why])).toEqual([
      [8, SUGGESTION, false, NOT_STOPPING.suggestion],
      [1, "private-host", false, NOT_STOPPING.unfound],
    ]);
  });

  it("stops a push on a machine's name the model finds, though no private term or shape knew it", async () => {
    expect((await commitFile("docs/deploy.md", "Deploy to brightbox-7 every night.\n", "docs: deploy nightly")).code).toBe(0);
    const id = (await git("rev-parse", "--short=7", "HEAD")).stdout.trim();
    stubAnswer = JSON.stringify({ findings: [{ commit: id, file: "docs/deploy.md", line: 1, kind: "private-host", text: "brightbox-7", reason: "names one of his servers", suggestion: "a remote host" }] });
    const pushed = await git("push", "-q", "origin", "main");
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toMatch(new RegExp(`${id} docs/deploy\\.md:1 +private-host  names one of his servers  instead: a remote host`));
    expect(pushed.stderr).not.toContain("brightbox");
  });

  it("holds an identifier the sample-fork policy calls ordinary to the private terms", async () => {
    await writeFile(termsFile(archiveDir), JSON.stringify({ terms: [...TERMS, "zdata"] }));
    const result = await commitFile("src/hasher.ts", ORDINARY, "feat: read compressed data");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`src/hasher.ts:1:27  ${RULES.term}`);
  });

  it("stops every check, rather than pass the terms, when private-terms.json cannot be read", async () => {
    await writeFile(termsFile(archiveDir), "{ not json");
    const result = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`guard: could not read the private terms in ${termsFile(archiveDir)}`);
    expect(result.stderr).toContain("stopped, since without them it would pass them.");
  });
});

describe("the policies of the installation's own", { timeout: 120_000 }, () => {
  const load = () => Effect.runPromise(Effect.result(loadPolicies(archiveDir)));
  const importing = async (policies: unknown) => {
    await writeFile(join(root, "import.json"), JSON.stringify({ policies }));
    return guard("policies", "import", join(root, "import.json"));
  };

  it("are the policy they extend, with what is their own over it, kept where a refusal says", async () => {
    const loaded = await load();
    expect(loaded._tag).toBe("Success");
    const policies = loaded._tag === "Success" ? loaded.success : {};
    expect(Object.keys(policies)).toEqual(["life-archive", "public-fork", "sample-fork"]);
    expect(policies["sample-fork"]).toEqual({ ...PUBLIC_FORK, ...SAMPLE_FORK, extends: undefined, name: "sample-fork", keptIn: "guard/policies.json in the life archive's folder" });
    expect(policies["sample-fork"]).not.toHaveProperty("extends");
    expect(policies["sample-fork"]!.repo).toBe(PUBLIC_FORK.repo);
    expect((await guard("install", "sample-fork")).code).toBe(0);
    const stopped = await commitFile("notes.md", "vexcorp-zdata\n", "Add a host");
    expect(stopped.stderr).toContain("(the sample-fork policy, guard/policies.json in the life archive's folder)");
  });

  it("are only the built-in ones without the file, and a repository naming one it does not have is stopped, saying where they are kept", async () => {
    expect((await guard("install", "sample-fork")).code).toBe(0);
    await rm(policiesFile(archiveDir));
    expect((await guard("policies")).stdout.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["life-archive", "public-fork"]);
    const result = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('names the privacy policy "sample-fork", which the life archive does not have (policies: life-archive, public-fork;');
    expect(result.stderr).toContain(policiesFile(archiveDir));
  });

  it("stop every check, rather than run without them, when guard/policies.json cannot be read", async () => {
    expect((await guard("install", "public-fork")).code).toBe(0);
    for (const broken of ["{ not json", JSON.stringify({ policies: { "other-fork": { extends: "public-fork", pushBranch: ["main"] } } })]) {
      await writeFile(policiesFile(archiveDir), broken);
      const result = await commitFile("a.txt", "hello\n", "Add a greeting");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("guard: could not read the policies (");
      await git("reset", "-q");
    }
  });

  it("are imported beside those there, each checked first, replacing one of the same name", async () => {
    const added = await importing({ "other-fork": { extends: "public-fork", about: "another made-up fork" }, "sample-fork": { ...SAMPLE_FORK, allowed: [] } });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain(`guard: added other-fork; replaced sample-fork in ${policiesFile(archiveDir)}.`);
    const written = JSON.parse(await readFile(policiesFile(archiveDir), "utf8")) as { policies: Record<string, unknown> };
    expect(written.policies).toEqual({ "sample-fork": { ...SAMPLE_FORK, allowed: [] }, "other-fork": { extends: "public-fork", about: "another made-up fork" } });
    const listed = (await guard("policies")).stdout;
    expect(listed).toMatch(/^public-fork +built in: a public fork/m);
    expect(listed).toMatch(/^other-fork +guard\/policies\.json in the life archive's folder: another made-up fork$/m);
  });

  it("are refused whole, nothing written, for a built-in name, an unknown base, a name no folder takes or a field it does not know", async () => {
    const before = await readFile(policiesFile(archiveDir), "utf8");
    for (const [policies, why] of [
      [{ "public-fork": { extends: "life-archive" } }, "has the name of one every installation has"],
      [{ "new-fork": { extends: "friend-map" } }, 'extends "friend-map", which is not one of life-archive, public-fork'],
      [{ "new-fork": { extends: "toString" } }, 'extends "toString", which is not one of life-archive, public-fork'],
      [{ "new-fork": { extends: "constructor" } }, 'extends "constructor", which is not one of life-archive, public-fork'],
      [{ "../escape": { extends: "public-fork" } }, "is not a name a policy can take"],
      [{ "new-fork": { extends: "public-fork", repo: {} } }, "does not hold policies in the shape guard/policies.json takes"],
      [{}, "names no policies"],
    ] as const) {
      const result = await importing(policies);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("guard: nothing imported: ");
      expect(result.stderr).toContain(why);
    }
    expect(await readFile(policiesFile(archiveDir), "utf8")).toBe(before);
  });

  it("take a name every object has as any other: `constructor` is imported as a policy of its own, and a repository naming `toString` is stopped as naming none there is", async () => {
    const added = await importing({ constructor: { extends: "public-fork", about: "a made-up fork" } });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain(`guard: added constructor in ${policiesFile(archiveDir)}.`);
    expect((await guard("policies")).stdout).toMatch(/^constructor +guard\/policies\.json in the life archive's folder: a made-up fork$/m);
    expect((await guard("install", "public-fork")).code).toBe(0);
    await git("config", "lifearchive.guardPolicy", "toString");
    const result = await commitFile("a.txt", "hello\n", "Add a greeting");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('names the privacy policy "toString", which the life archive does not have');
  });

  it("are imported only where the hooks read them: a checkout with an archive", async () => {
    await rm(join(archiveDir, "modules"), { recursive: true, force: true });
    await rm(join(archiveDir, "archive.sqlite"), { force: true });
    const result = await importing({ "other-fork": { extends: "public-fork" } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("there is no archive in");
  });
});
