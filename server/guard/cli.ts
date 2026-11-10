// npm run guard: the privacy guard (docs/guard.md's "The privacy guard"). It stops a commit or a push, in any repository
// that has it installed, that would publish private data: real people's names, account ids and notes from the
// archive (dictionary.ts), the captain's own name, his private terms (guard/private-terms.json beside the archive:
// his infrastructure's and his family's first names), and real-looking phone numbers, emails, chat ids and tailnet or
// LAN host names (scan.ts); a finding firstmate judged not private is let through (judgements.ts). Commits that
// pass are then read by GPT-6.1 Sol too (review.ts), against the repository's policy (policy.ts), which stops only on
// the policy's few kinds, keeps anything else it notices as a suggestion, and records each commit it passes (records.ts); a push, and the check before publication, check only the commits not recorded yet, so
// each commit is checked once and settled history never again. Apart from that, a push, a range, a review and the
// check before publication stop every commit they send or name, recorded or not, whose author or committer email is
// not a GitHub noreply address (or one guard/allow.json lists). None of them reads a commit its policy's public remotes
// hold (a fork's upstream) or one settled with its history.
//
//   npm run guard -- install <policy> --repo <dir>   points that repository's git at server/guard/hooks/, under <policy>,
//                                                    which run the hooks it ran before first
//   npm run guard -- settle <commit>... --repo <dir> settles commits a remote holds already, with all their history
//   npm run guard -- range <revisions> --repo <dir>  the local check on any commits, such as origin/main..main
//   npm run guard -- review <revisions> --repo <dir> any commits, then the model's review, recording what passes
//   npm run guard -- publish-check [<revisions>] --repo <dir>  what is to be made public (main) not yet reviewed, by hand only
//   npm run guard -- reviews [--all] --repo <dir>    the log of the model's reviews (the last 20, or all)
//   npm run guard -- findings [--all] [--repo <dir>] the model's findings, what stopped and what it only suggested (the
//                                                    last 20, or all), of that repository's policy, else every policy's
//   npm run guard -- judge <finding> (--allow | --block) --by <who> --reason <why>
//                                                    firstmate's judgement of a finding the commit check stopped, by
//                                                    the id it printed (judgements.ts): an allow lets that one match
//                                                    through in exactly that text; firstmate's alone
//   npm run guard -- judgements [--all] [--repo <dir>] the judgements (the last 20, or all), of that repository's
//                                                    policy, else every policy's, for the captain to skim
//   npm run guard -- policies [import <file>]        every policy, built in or the archive folder's own; import adds a
//                                                    file of the installation's own to guard/policies.json (privatePolicies.ts)
//   npm run guard -- dictionary                      how many names, ids, notes and private terms the check has, never which
//   npm run guard -- scan [--json] <file>...         the local check on files (as a demo build's check runs it): where and which rule
//
// --repo is the repository to act on; without it, the one npm was run from (INIT_CWD), else the current folder's. The
// hooks run three more, in the repository git runs them in: staged (pre-commit: the lines a commit adds; for a merge,
// what a push will read of it: the commits it brings not yet reviewed, and what its resolution adds), message
// <file> (commit-msg: its message) and push <remote> (pre-push: the commits a push sends not yet reviewed, refs on
// stdin). The archive's folder is this checkout's (server/dataHome.ts), whichever repository is checked. It prints
// where each finding is and which rule it broke, never the text it matched, and exits 1 when there is one.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { archiveFolder, REPO } from "../dataHome.ts";
import { runMain } from "../effectRuntime.ts";
import { commitsMaterial, commitTexts, exists, git, gitConfig, identities, isDeletion, mergeHeads, MESSAGE, messageText, pushedRefs, pushShas, revList, stagedMergeTexts, stagedTexts, type CommitMaterial, type PushedRef, type Text } from "./commits.ts";
import { allowFile, archiveFile, counts, emptyDictionary, loadPrivateData, readAllowed, termsFile, TermsUnreadable, type PrivateData } from "./dictionary.ts";
import { addFlags, addJudgement, allowedBy, FLAGGED_FILE, flagKey, formatJudgements, JUDGEMENTS_FILE, messageForKey, neverAllowed, quotesMatch, readFlags, readJudgements, RULE_KINDS, verdicts, type Flag } from "./judgements.ts";
import { CHAIN_KEY, GIT_KEY, type Policy } from "./policy.ts";
import { BUILT_IN_POLICIES, importPolicies, loadPolicies, policiesFile, policyNamed } from "./privatePolicies.ts";
import { addSettled, formatFindings, formatLog, readFindings, readLog, readReviewed, recordsFolder, REVIEWED_FILE } from "./records.ts";
import { EFFORT, reviewCommits } from "./review.ts";
import { privacyWith } from "../privacy/policy.ts";
import { lineAndColumn, PrivacyScanner } from "./scan.ts";

export const HOOKS = join(REPO, "server", "guard", "hooks");

const USAGE = [
  "usage: npm run guard -- <command> [--repo <dir>]",
  "  install <policy> | settle <commit>... | range <revisions> | review <revisions> | publish-check [<revisions>] | reviews [--all] | findings [--all] | judge <finding> (--allow | --block) --by <who> --reason <why> | judgements [--all] | policies [import <file>] | dictionary | scan [--json] <file>...",
  "  (the hooks run staged, message <file> and push <remote>)",
].join("\n");

/** What stops a command before it checks anything: said, and it exits with `code`. */
class GuardError extends Data.TaggedError("GuardError")<{ readonly message: string; readonly code?: number }> {}

/** Every policy the guard knows, by name (privatePolicies.ts). */
type Policies = Readonly<Record<string, Policy>>;

/** Every policy; a guard/policies.json that cannot be read stops the command rather than run without what it names. */
const policiesOf = (archiveDir: string) =>
  loadPolicies(archiveDir).pipe(
    Effect.mapError((error) => new GuardError({ message: `guard: could not read the policies (${error.message}); stopped, since without them it would not know the repositories it names.` })),
  );

/** Each finding in the texts, with where it is and its key (judgements.ts), never the text it matched. */
function scanAll(scanner: PrivacyScanner, texts: Text[]): Flag[] {
  return texts.flatMap(({ text, place, subject }) => {
    const content = subject === MESSAGE ? messageForKey(text) : text;
    const seen = new Map<string, number>();
    return scanner.scan(text).map((finding) => {
      const { line, column } = lineAndColumn(text, finding.start);
      const matched = text.slice(finding.start, finding.end);
      const same = `${finding.rule}\0${matched}`;
      const occurrence = seen.get(same) ?? 0;
      seen.set(same, occurrence + 1);
      return { where: place(line, column), subject, rule: finding.rule, kind: RULE_KINDS[finding.rule] ?? "unknown", ...flagKey(subject, finding.rule, matched, occurrence, content) };
    });
  });
}

/** The archive's names, the reviewed terms and the private terms; any that cannot be read stops the check rather than weaken it. */
const privateData = (archiveDir: string) =>
  Effect.try({
    try: () => loadPrivateData(archiveDir),
    catch: (error) =>
      new GuardError({
        message: error instanceof TermsUnreadable
          ? `guard: could not read the private terms in ${termsFile(archiveDir)} (${error.message}); stopped, since without them it would pass them.`
          : `guard: could not read the names in ${archiveFile(archiveDir)} (${(error as Error).message}); stopped, since without them it would pass real names.`,
      }),
  });

/** The check, with what the policy, where there is one, calls ordinary. */
function makeScanner({ dictionary, allowed, terms }: PrivateData, policy?: Policy): PrivacyScanner {
  let machine: string[] = [];
  try {
    machine = [userInfo().username, hostname().split(".")[0]!];
  } catch {
    // no user record (some sandboxes): nothing to add
  }
  return new PrivacyScanner(dictionary ?? emptyDictionary(), { allowed: [...allowed, ...(policy?.allowed ?? [])], machine, terms });
}

/** What each check leaves out: the policy's public remotes' branches, and the commits settled with their history that this repository has. */
const settled = (top: string, policy: Policy, records: string) =>
  Effect.gen(function* () {
    const bases = yield* Effect.filter(yield* Effect.promise(() => readReviewed(records, { history: true })), (sha) => exists(top, sha));
    return [...(policy.publicRemotes ?? []).map((remote) => `--remotes=${remote}`), ...bases];
  });

/**
 * The findings, but those firstmate judged not private: each stopped one where it is, its rule and its id, recorded as
 * flagged, and how to have it judged; never the text. 1 when any is stopped.
 */
const report = (flags: Flag[], what: string, policy: Policy, archiveDir: string) =>
  Effect.gen(function* () {
    if (flags.length === 0) return 0;
    const records = recordsFolder(archiveDir, policy.name);
    const judged = verdicts(yield* Effect.promise(() => readJudgements(records)));
    const stopped = flags.filter((flag) => !allowedBy(judged, flag));
    const through = flags.length - stopped.length;
    if (through > 0) console.error(`guard: let through ${through} finding${through === 1 ? "" : "s"} firstmate judged not private (npm run guard -- judgements).`);
    if (stopped.length === 0) return 0;
    const at = new Date().toISOString();
    yield* Effect.promise(() => addFlags(records, stopped.map((flag) => ({ at, policy: policy.name, ...flag }))));

    const blocked = (flag: Flag) => judged.get(flag.key)?.verdict === "block";
    const width = Math.max(...stopped.map((flag) => flag.where.length));
    const rule = Math.max(...stopped.map((flag) => flag.rule.length));
    console.error(`guard: stopped ${what}: it would publish what looks like private data.`);
    for (const flag of stopped) {
      const note = neverAllowed(flag.rule) ? "; never let through" : blocked(flag) ? "; judged: stays stopped" : "";
      console.error(`  ${flag.where.padEnd(width)}  ${flag.rule.padEnd(rule)}  (finding ${flag.id}${note})`);
    }
    const judgeable = stopped.filter((flag) => !neverAllowed(flag.rule) && !blocked(flag));
    const prefix = REPO.replace(/\/+$/, "");
    console.error(
      [
        "The matched text is not shown. Write a made-up name, a number set aside for fiction or a placeholder host",
        `instead (the ${policy.name} policy, ${policy.keptIn}).`,
        ...(stopped.some((flag) => neverAllowed(flag.rule))
          ? ['A finding marked "never let through" (one of the captain\'s private terms, this machine\'s name, content or a secret) cannot be judged through: rewrite it.']
          : []),
        ...(judgeable.length > 0
          ? [
              "If a finding is plainly not private (a version string read as an IP address, a made-up test value), do not judge or",
              "allow it yourself, and do not add it to an allow list: hand its place and finding id to firstmate, which alone judges",
              "flags. Firstmate looks at the text in place and runs:",
              ...judgeable.map((flag) => `  npm --prefix ${prefix} run guard -- judge ${flag.id} --allow --by firstmate --reason "<why it is not private, without the text>"`),
              "or --block to keep it stopped. An allow lets through that one match in exactly the lines it is in; any change stops it again.",
            ]
          : []),
      ].join("\n"),
    );
    return 1;
  });

const JUDGE_USAGE = 'usage: npm run guard -- judge <finding> (--allow | --block) --by <who> --reason "<why, in one line, without the text>"';

/**
 * Records firstmate's judgement of a finding the check stopped, by the id the guard printed, in each policy's record
 * that flagged it. An allow is refused for a finding that can never be let through, and a reason that quotes the
 * matched text is refused, since the record never holds it.
 */
const judge = (id: string | undefined, { allow, block, reason, by }: { allow: boolean; block: boolean; reason?: string; by?: string }, archiveDir: string, policies: Policies) =>
  Effect.gen(function* () {
    const why = reason?.trim() ?? "";
    const who = by?.trim() ?? "";
    if (!id || allow === block || !why || !who) return yield* new GuardError({ message: JUDGE_USAGE, code: 2 });
    if (/[\r\n]/.test(why) || why.length > 300) return yield* new GuardError({ message: "guard: a judgement's reason is one line of 300 characters at most; nothing judged.", code: 2 });
    const flagged = (yield* Effect.forEach(Object.values(policies), (policy) => Effect.promise(() => readFlags(recordsFolder(archiveDir, policy.name))))).flat();
    const found = flagged.filter((entry) => entry.id === id || entry.key === id);
    if (new Set(found.map((entry) => entry.key)).size !== 1) {
      return yield* new GuardError({
        message: found.length === 0
          ? `guard: no finding ${id} has been flagged (the guard prints each finding's id when it stops a commit); nothing judged.`
          : `guard: ${id} names more than one finding; give its whole key (${FLAGGED_FILE}); nothing judged.`,
      });
    }
    const flag = found.at(-1)!;
    const never = neverAllowed(flag.rule);
    if (allow && never) {
      return yield* new GuardError({ message: `guard: finding ${flag.id} (${flag.where}, ${flag.rule}) can never be let through: ${never}. Nothing judged; it stays stopped until the text is rewritten.` });
    }
    if (quotesMatch(why, flag.matchHash)) return yield* new GuardError({ message: "guard: the reason quotes the matched text, which the record never holds; say why without it. Nothing judged." });
    const at = new Date().toISOString();
    const verdict = allow ? "allow" : "block";
    for (const policy of new Set(found.map((entry) => entry.policy))) {
      const latest = found.filter((entry) => entry.policy === policy).at(-1)!;
      const records = recordsFolder(archiveDir, policy);
      yield* Effect.promise(() => addJudgement(records, { ...latest, at, verdict, reason: why, by: who }));
      console.log(`guard: judged finding ${flag.id} (${latest.where}, ${flag.rule}, the ${policy} policy): ${verdict}, by ${who}: ${why}. Recorded in ${join(records, JUDGEMENTS_FILE)}.`);
    }
    return 0;
  });

/** The judgements, of one policy or every one, newest last: the last 20, or all. */
const listJudgements = (policies: Policy[], all: boolean, archiveDir: string) =>
  Effect.gen(function* () {
    const entries = (yield* Effect.forEach(policies, (policy) => Effect.promise(() => readJudgements(recordsFolder(archiveDir, policy.name))))).flat().sort((a, b) => a.at.localeCompare(b.at));
    console.log(formatJudgements(all ? entries : entries.slice(-20)));
    return 0;
  });

/** The top of the repository `dir` is in. */
const repoTop = (dir: string) =>
  git(dir, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((out) => out.trim()),
    Effect.catchTag("RunFailed", () => Effect.fail(new GuardError({ message: `guard: ${dir} is not in a git repository.`, code: 2 }))),
  );

/** The policy the repository at `top` names. */
const policyOf = (top: string, policies: Policies, archiveDir: string) =>
  Effect.gen(function* () {
    const name = yield* gitConfig(top, GIT_KEY);
    const policy = policyNamed(policies, name);
    if (policy) return policy;
    const known = Object.keys(policies).join(", ");
    return yield* new GuardError({
      message: name === undefined
        ? `guard: ${top} names no privacy policy (git config ${GIT_KEY}), so nothing was checked; stopped. Install the guard in it from the life archive: npm run guard -- install <policy> --repo ${top} (policies: ${known}).`
        : `guard: ${top} names the privacy policy "${name}", which the life archive does not have (policies: ${known}; a repository's own is named in ${policiesFile(archiveDir)}, npm run guard -- policies import <file>); stopped.`,
    });
  });

const install = (top: string, name: string | undefined, archiveDir: string, policies: Policies) =>
  Effect.gen(function* () {
    const policy = policyNamed(policies, name);
    if (!policy) return yield* new GuardError({ message: `guard: install takes a policy: ${Object.keys(policies).join(", ")}.`, code: 2 });
    // The hooks read this checkout's archive: one with none (a worktree, say) would check without any names.
    if (!existsSync(archiveFile(archiveDir))) {
      return yield* new GuardError({ message: `guard: there is no archive in ${archiveDir}, so the hooks would check without its names; install from the checkout whose archive they read (the captain's copy).` });
    }
    // The hooks git ran before, which the guard's run first: another folder core.hooksPath names (as written, so a
    // relative one is each worktree's own), else the repository's own .git/hooks if it has any. Installed again, the
    // guard keeps what it chained to.
    const current = yield* gitConfig(top, "core.hooksPath", ["--local"]);
    let chain: string | undefined;
    if (current && resolve(top, current) === HOOKS) {
      chain = yield* gitConfig(top, CHAIN_KEY, ["--local"]);
    } else if (current) {
      chain = current;
    } else {
      const hooks = join((yield* git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(), "hooks");
      const own = (yield* Effect.promise(() => readdir(hooks).catch(() => [] as string[]))).filter((file) => !file.endsWith(".sample"));
      if (own.length > 0) chain = hooks;
    }
    yield* git(top, ["config", "--local", "core.hooksPath", HOOKS]);
    yield* git(top, ["config", "--local", GIT_KEY, policy.name]);
    if (chain) yield* git(top, ["config", "--local", CHAIN_KEY, chain]);
    else yield* git(top, ["config", "--local", "--unset-all", CHAIN_KEY]).pipe(Effect.ignore);
    console.log(`guard: git now runs ${HOOKS}/ (pre-commit, commit-msg, pre-push) in ${top} and its worktrees, under the ${policy.name} policy.`);
    if (chain) console.log(`guard: each hook runs the repository's own from ${chain} first, as git ran them before (git config ${CHAIN_KEY}).`);
    const { dictionary, note, terms } = yield* privateData(archiveDir);
    console.log(dictionary ? `guard: it checks against the names in ${archiveFile(archiveDir)} (${counts(dictionary)}).` : `guard: ${note}.`);
    console.log(termsLine(archiveDir, terms));
    return 0;
  });

/** How many private terms the check has, never which. */
const termsLine = (archiveDir: string, terms: string[]) =>
  terms.length > 0 ? `guard: and against ${terms.length} private terms in ${termsFile(archiveDir)}.` : `guard: there are no private terms (${termsFile(archiveDir)}).`;

/**
 * Settles commits a remote holds already, with all their history: published before the guard was installed, so no
 * check reads them or what came before them again, nor who made them. A commit no remote branch holds is refused,
 * since settling it would publish it unchecked.
 */
const settle = (top: string, revisions: string[], archiveDir: string, policies: Policies) =>
  Effect.gen(function* () {
    const policy = yield* policyOf(top, policies, archiveDir);
    if (revisions.length === 0) return yield* new GuardError({ message: USAGE, code: 2 });
    if (!existsSync(archiveFile(archiveDir))) {
      return yield* new GuardError({ message: `guard: there is no archive in ${archiveDir}, whose records the hooks read; settle from the checkout whose archive they read (the captain's copy).` });
    }
    const shas: string[] = [];
    const where: string[] = [];
    for (const revision of revisions) {
      const sha = yield* git(top, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).pipe(
        Effect.map((out) => out.trim()),
        Effect.catchTag("RunFailed", () => Effect.fail(new GuardError({ message: `guard: ${revision} is not a commit in ${top}.`, code: 2 }))),
      );
      const held = (yield* git(top, ["for-each-ref", "--count=1", `--contains=${sha}`, "--format=%(refname:short)", "refs/remotes"])).trim();
      if (!held) return yield* new GuardError({ message: `guard: no remote branch holds ${sha.slice(0, 10)}, so it is not published yet; not settling it. Push it through the guard instead.` });
      shas.push(sha);
      where.push(`${sha.slice(0, 10)} on ${held}`);
    }
    const records = recordsFolder(archiveDir, policy.name);
    const why = `settled with its history by hand (npm run guard -- settle): published before the guard was installed (${where.join(", ")})`;
    const added = yield* Effect.promise(() => addSettled(records, shas, why, new Date()));
    console.log(`guard: ${added.length === 0 ? "already settled" : `settled ${where.join(", ")}`}, with all before ${shas.length === 1 ? "it" : "them"}, under the ${policy.name} policy (${join(records, REVIEWED_FILE)}).`);
    return 0;
  });

/** The commits of shas not yet reviewed, saying how many it passes over: a commit the model's review has passed is settled. */
const unreviewed = (shas: string[], records: string, which: string) =>
  Effect.gen(function* () {
    const reviewed = yield* Effect.promise(() => readReviewed(records));
    const fresh = shas.filter((sha) => !reviewed.has(sha));
    const settled = shas.length - fresh.length;
    if (settled > 0) {
      const rest = fresh.length === 0 ? "; none left for the model, so no model call" : "";
      console.error(`guard: ${settled} of the ${shas.length} commits ${which} reviewed already (${REVIEWED_FILE}), so not checked again${rest}.`);
    }
    return fresh;
  });

/** Stops a push that sends to a ref its policy does not push to: a stray branch, a tag or a Codex checkpoint. */
const onlyPushBranches = (policy: Policy, refs: PushedRef[]) =>
  Effect.gen(function* () {
    const allowed = policy.pushBranches;
    if (!allowed) return;
    const stray = refs.filter((ref) => !isDeletion(ref) && !allowed.some((branch) => ref.remoteRef === `refs/heads/${branch}`));
    if (stray.length === 0) return;
    const named = allowed.join(" or ");
    return yield* new GuardError({
      message: [
        `guard: stopped this push: the ${policy.name} policy pushes only to ${named}, and it sends to ${stray.map((ref) => ref.remoteRef).join(", ")}.`,
        `Push ${named} by name instead: git push <remote> ${allowed[0]}.`,
      ].join("\n"),
    });
  });

/** GitHub's noreply addresses: a person's (<id>+<user>@users.noreply.github.com) and GitHub's own, on what it commits itself. */
const NOREPLY = /^(?:[^@\s]+@users\.noreply\.github\.com|noreply@github\.com)$/i;

/** Stops commits whose author or committer email is not a noreply address, nor one allow.json's "authors" names: publishing a commit publishes them. */
const noreplyOnly = (top: string, shas: string[], what: string, archiveDir: string) =>
  Effect.gen(function* () {
    const allowed = new Set(readAllowed(archiveDir, "authors").map((email) => email.toLowerCase()));
    const fine = (email: string) => NOREPLY.test(email) || allowed.has(email.toLowerCase());
    const named = (yield* identities(top, shas)).flatMap(({ id, author, committer }) => {
      const roles = [...(fine(author) ? [] : ["author"]), ...(fine(committer) ? [] : ["committer"])];
      return roles.length > 0 ? [`  ${id}  ${roles.join(", ")}`] : [];
    });
    if (named.length === 0) return;
    const one = named.length === 1;
    return yield* new GuardError({
      message: [
        `guard: stopped ${what}: ${named.length} commit${one ? "" : "s"} name${one ? "s" : ""} an author or committer email that is not a GitHub noreply address, which would publish it.`,
        ...named,
        "The address is not shown. Set the noreply one (git config user.email <id>+<username>@users.noreply.github.com, from GitHub's email",
        "settings), then make each commit again under it: the last with git commit --amend --no-edit --reset-author, older ones with",
        "git rebase -r <base> --exec 'git commit --amend --no-edit --reset-author'.",
        `An address meant to be published goes in "authors" in ${allowFile(archiveDir)}.`,
      ].join("\n"),
    });
  });

const readStdin = () =>
  new Promise<string>((done) => {
    let input = "";
    process.stdin.setEncoding("utf8").on("data", (chunk) => (input += chunk)).on("end", () => done(input));
  });

/** The commands that check a repository's commits, under its policy. */
const checkRepository = (command: string, args: string[], top: string, archiveDir: string, all: boolean, policies: Policies) =>
  Effect.gen(function* () {
    const policy = yield* policyOf(top, policies, archiveDir);
    const records = recordsFolder(archiveDir, policy.name);
    if (command === "reviews") {
      const entries = yield* Effect.promise(() => readLog(records));
      console.log(formatLog(all ? entries : entries.slice(-20)));
      return 0;
    }
    if (command === "findings") return yield* listFindings([policy], all, archiveDir);
    if (command === "judgements") return yield* listJudgements([policy], all, archiveDir);

    const hasArchive = existsSync(archiveFile(archiveDir));
    let texts: Text[];
    let what: string;
    let commits: CommitMaterial[] | undefined; // for a push, a review or the publication check: what the model is to read next
    let tip = ""; // the newest commit sent or reviewed, whose made-up names the model is given
    let remote = "";
    if (command === "staged") {
      const heads = yield* mergeHeads(top);
      if (heads.length === 0) {
        [texts, what] = [yield* stagedTexts(top), "this commit"];
      } else {
        // A merge, read as its push will read it: each commit it brings as that commit's own, but those the policy's
        // public remotes hold (upstream's), those settled and those reviewed; and the merge for what its resolution adds.
        const shas = yield* revList(top, heads, ["HEAD", ...(yield* settled(top, policy, records))]);
        const brought = yield* commitsMaterial(top, yield* unreviewed(shas, records, "this merge brings"));
        [texts, what] = [[...brought.flatMap(commitTexts), ...(yield* stagedMergeTexts(top, heads))], "this merge"];
      }
    } else if (command === "message" && args[0]) {
      const file = isAbsolute(args[0]) ? args[0] : join(process.cwd(), args[0]);
      const commentChar = (yield* gitConfig(top, "core.commentChar")) ?? "#";
      const text = messageText(yield* Effect.promise(() => readFile(file, "utf8")), commentChar.length === 1 ? commentChar : "#");
      [texts, what] = [[{ text, place: (line, column) => `${MESSAGE}, line ${line}, column ${column}`, subject: MESSAGE }], "this commit"];
    } else if (command === "push" && args[0]) {
      const refs = pushedRefs(yield* Effect.promise(readStdin));
      yield* onlyPushBranches(policy, refs);
      const shas = yield* pushShas(top, args[0], refs, yield* settled(top, policy, records));
      yield* noreplyOnly(top, shas, "this push", archiveDir);
      const fresh = yield* unreviewed(shas, records, "this push sends");
      [commits, tip, remote] = [yield* commitsMaterial(top, fresh), shas.at(-1) ?? "", args[0]];
      [texts, what] = [commits.flatMap(commitTexts), "this push"];
    } else if ((command === "range" || command === "review") && args.length > 0) {
      const shas = yield* revList(top, args, yield* settled(top, policy, records));
      yield* noreplyOnly(top, shas, "these commits", archiveDir);
      const material = yield* commitsMaterial(top, shas);
      if (command === "review") [commits, tip] = [material, shas.at(-1) ?? ""];
      [texts, what] = [material.flatMap(commitTexts), "these commits"];
    } else if (command === "publish-check") {
      // Before the repository is made public: as a push, each commit not yet reviewed, by both checks, and only with the archive's dictionary.
      if (!hasArchive) return yield* new GuardError({ message: `guard: publish-check needs the archive and its names (${archiveFile(archiveDir)}); run it in the captain's copy of the life archive.` });
      const shas = yield* revList(top, args.length > 0 ? args : ["main"], yield* settled(top, policy, records));
      yield* noreplyOnly(top, shas, "this publication", archiveDir);
      const fresh = yield* unreviewed(shas, records, "to be published");
      if (fresh.length === 0) {
        console.error(`guard: all ${shas.length} commits to be published have passed the review. Making them public is the captain's call.`);
        return 0;
      }
      [commits, tip] = [yield* commitsMaterial(top, fresh), shas.at(-1) ?? ""];
      [texts, what] = [commits.flatMap(commitTexts), "this publication"];
    } else {
      return yield* new GuardError({ message: USAGE, code: 2 });
    }
    if (texts.length === 0) return 0;
    const data = yield* privateData(archiveDir);
    // The note once for a commit: from pre-commit, not again from commit-msg.
    if (data.note && command !== "message") console.error(`guard: ${data.note}.`);
    const found = yield* report(scanAll(makeScanner(data, policy), texts), what, policy, archiveDir);
    if (found !== 0 || !commits) return found;
    // Then the model's review, only where the archive is: a machine without one has nothing it could leak.
    if (!hasArchive) return 0;
    const effort = command === "push" ? { effort: EFFORT.push } : command === "publish-check" ? { effort: EFFORT.publish, what } : { effort: EFFORT.review, what };
    // What content is, with every installed module's lines (health's results among them), so the model is told them too.
    // The settings and the loader only here: they bring the whole core, which the hooks' scans, in every repository
    // guarded, never need; a settings file that cannot be used stops the review in the guard's words, as the review's
    // own processes read it too.
    const content = yield* Effect.tryPromise({
      try: async () => {
        const { settings } = await import("../settings.ts");
        settings();
        const { installedPrivacy } = await import("../modules/loader.ts");
        return privacyWith(await installedPrivacy()).content.holds ?? [];
      },
      catch: (error) => new GuardError({ message: `guard: the archive's settings and modules could not be loaded for the model's review, so nothing has passed it: ${(error as Error).message}` }),
    });
    const reviewed = yield* reviewCommits({ top, policy, tip, records, remote, commits, content, ...effort });
    if (reviewed === 0 && command === "publish-check") {
      console.error(`guard: nothing private found in the ${commits.length} commit${commits.length === 1 ? "" : "s"} not yet reviewed; all to be published have now passed the review. Making them public is the captain's call.`);
    }
    return reviewed;
  });

/** Files, by the local check: each place and rule, or, with --json, one line each of {file, rule, start, end} (UTF-16 offsets), never the text. */
const scanFiles = (files: string[], json: boolean, archiveDir: string) =>
  Effect.gen(function* () {
    if (files.length === 0) return yield* new GuardError({ message: USAGE, code: 2 });
    const data = yield* privateData(archiveDir);
    if (data.note) console.error(`guard: ${data.note}.`);
    const scanner = makeScanner(data);
    let found = 0;
    for (const file of files) {
      const text = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: () => new GuardError({ message: `guard: could not read ${file}.`, code: 2 }) });
      for (const finding of scanner.scan(text)) {
        found++;
        const { line, column } = lineAndColumn(text, finding.start);
        console.log(json ? JSON.stringify({ file, rule: finding.rule, start: finding.start, end: finding.end }) : `${file}:${line}:${column}  ${finding.rule}`);
      }
    }
    return found > 0 ? 1 : 0;
  });

/** The model's findings, of one policy or every one, newest last: the last 20, or all. */
const listFindings = (policies: Policy[], all: boolean, archiveDir: string) =>
  Effect.gen(function* () {
    const entries = (yield* Effect.forEach(policies, (policy) =>
      Effect.promise(() => readFindings(recordsFolder(archiveDir, policy.name))).pipe(Effect.map((found) => found.map((entry) => ({ ...entry, policy: policy.name })))),
    ))
      .flat()
      .sort((a, b) => a.at.localeCompare(b.at));
    console.log(formatFindings(all ? entries : entries.slice(-20)));
    return 0;
  });

/**
 * `policies`: every policy, where it is kept and what each of the archive folder's own extends; `policies import
 * <file>`: adds the policies a file holds (privatePolicies.ts) to the archive folder's own, checked first. Like
 * install, it refuses a checkout with no archive, whose policies no hook reads.
 */
const managePolicies = (args: string[], archiveDir: string, from: string) =>
  Effect.gen(function* () {
    const [sub, file, ...rest] = args;
    if (sub === undefined) {
      const policies = yield* policiesOf(archiveDir);
      for (const policy of Object.values(policies)) console.log(`${policy.name.padEnd(16)} ${policyNamed(BUILT_IN_POLICIES, policy.name) ? "built in" : policy.keptIn}: ${policy.about}`);
      return 0;
    }
    if (sub !== "import" || file === undefined || rest.length > 0) return yield* new GuardError({ message: "usage: npm run guard -- policies [import <file>]", code: 2 });
    if (!existsSync(archiveFile(archiveDir))) {
      return yield* new GuardError({ message: `guard: there is no archive in ${archiveDir}, whose policies the hooks would read; import from the checkout whose archive they read (the captain's copy).` });
    }
    const done = yield* importPolicies(archiveDir, resolve(from, file)).pipe(Effect.mapError((error) => new GuardError({ message: `guard: nothing imported: ${error.message}.` })));
    const said = [done.added.length > 0 ? `added ${done.added.join(", ")}` : "", done.replaced.length > 0 ? `replaced ${done.replaced.join(", ")}` : ""].filter(Boolean).join("; ");
    console.log(`guard: ${said} in ${done.file}.`);
    return 0;
  });

const HOOK_COMMANDS = new Set(["staged", "message", "push"]);

export const program = (argv: string[]) =>
  Effect.gen(function* () {
    const flags = { json: false, all: false, allow: false, block: false, repo: undefined as string | undefined, reason: undefined as string | undefined, by: undefined as string | undefined };
    const positionals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      const valued = /^--(repo|reason|by)(?:=(.*))?$/s.exec(arg);
      if (arg === "--json") flags.json = true;
      else if (arg === "--all") flags.all = true;
      else if (arg === "--allow") flags.allow = true;
      else if (arg === "--block") flags.block = true;
      else if (valued) flags[valued[1] as "repo" | "reason" | "by"] = valued[2] ?? argv[++i];
      else positionals.push(arg);
    }
    const [command, ...args] = positionals;
    const archiveDir = archiveFolder();
    if (command === "dictionary") {
      const { dictionary, note, terms } = yield* privateData(archiveDir);
      console.log(dictionary ? `guard: ${archiveFile(archiveDir)} gives the check ${counts(dictionary)}.` : `guard: ${note}.`);
      console.log(termsLine(archiveDir, terms));
      return dictionary ? 0 : 1;
    }
    if (command === "scan") return yield* scanFiles(args, flags.json, archiveDir);
    if (command === undefined) return yield* new GuardError({ message: USAGE, code: 2 });
    // A command by hand runs where it was run from (npm runs it in the life archive, and says where it was run from in
    // INIT_CWD); a hook, where git runs it.
    const from = process.env.npm_lifecycle_event === "guard" ? process.env.INIT_CWD : undefined;
    if (command === "policies") return yield* managePolicies(args, archiveDir, from ?? process.cwd());
    const policies = yield* policiesOf(archiveDir);
    // Without --repo, every policy's: the captain's look over what the review noticed, wherever it ran.
    if (command === "findings" && flags.repo === undefined) return yield* listFindings(Object.values(policies), flags.all, archiveDir);
    if (command === "judgements" && flags.repo === undefined) return yield* listJudgements(Object.values(policies), flags.all, archiveDir);
    // Firstmate's alone (docs/guard.md's "The privacy guard"): by the finding's id, in whichever policy's record flagged it.
    if (command === "judge") return yield* judge(args[0], flags, archiveDir, policies);
    const dir = HOOK_COMMANDS.has(command) ? process.cwd() : resolve(from ?? process.cwd(), flags.repo ?? ".");
    const top = yield* repoTop(dir);
    if (command === "install") return yield* install(top, args[0], archiveDir, policies);
    if (command === "settle") return yield* settle(top, args, archiveDir, policies);
    return yield* checkRepository(command, args, top, archiveDir, flags.all, policies);
  }).pipe(
    Effect.catchTag("GuardError", (error) => Effect.sync(() => (console.error(error.message), error.code ?? 1))),
    Effect.catchTag("RunFailed", (error) => Effect.sync(() => (console.error(`guard: ${error.message}`), 1))),
  );

if (import.meta.main) process.exitCode = (await runMain(program(process.argv.slice(2)))) ?? 1;
