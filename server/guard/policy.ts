// A repository's privacy policy: what it may hold, for the guard to judge its commits by (docs/guard.md's "The privacy
// guard"). Each repository the guard is installed in names its policy in its git config (GIT_KEY, set by `npm run
// guard -- install <name>`); its records (the commits the model passed, and the log of its reviews) are kept under
// that name in the archive's folder (records.ts).
//
// A policy is the repository layer of the captain's privacy policy as it applies there: the kinds of data it never
// holds, each with the kind the model's review reports it as, and what is fine, said outright. The model is given it
// word for word, with what the content layer holds (CONTENT), and reports only its kinds; the commit check (scan.ts)
// looks for the kinds it can find by shape or from the archive, whatever the policy.
//
// The policies any installation has are in policies/ (the life archive's own, and a public fork's); a repository of
// one's own is named in the archive's folder, extending one of them (privatePolicies.ts, which lists them all).

import { PRIVACY, type RepoLayer } from "../privacy/policy.ts";

export interface Policy {
  /** As `npm run guard -- install <name>` takes it, and the name of its records' folder. */
  name: string;
  /** What the repository is, in a clause, for the model: "a private app that maps its owner's friendships, ...". */
  about: string;
  /** Where it is kept, as a refusal tells an agent to look: BUILT_IN, or the archive's folder's guard/policies.json. */
  keptIn: string;
  /**
   * The files in the repository its made-up names are kept in, which the model is told are invented, as the newest
   * commit under review has them: each `export const` FIRST_NAMES, LAST_NAMES and WHOLE_NAMES (lists) and SELF_NAME
   * (one name), read as written, never run (review.ts); and PUBLIC_FIGURES and STAND_INS, which it is told are a
   * public figure's or a check's stand-in for a real person.
   */
  nameFiles: string[];
  /**
   * The only branches a push may send to, by name (`main`): a push to any other ref (a stray branch, a tag, a Codex
   * checkpoint) is stopped before anything is checked, though deleting one is not. Absent, a push may send to any ref.
   */
  pushBranches?: string[];
  /**
   * The remotes whose branches are another's published history, as a fork's `upstream` is: a commit any of their
   * branches holds is left out of every check (who made it too), and a merge of one is read for what its own
   * resolution adds (commits.ts). Absent, none.
   */
  publicRemotes?: string[];
  /**
   * Words that are ordinary in this repository, matched exactly however cased, which the commit check lets through
   * as allow.json's "multi" does (upstream code's identifiers that happen to be one of the private terms, say).
   */
  allowed?: string[];
  /** What it may hold: its title, summary and rule, what it never holds, each with its kind, and what is fine. */
  repo: RepoLayer;
}

/** Where a policy in policies/ is kept, as a refusal names it. */
export const BUILT_IN = "server/guard/policies/ in the life archive";

/** What the content layer holds: the captain's chats' content, which no repository ever holds (a policy's "content" kind). */
export const CONTENT: readonly string[] = PRIVACY.content.holds ?? [];

/** The git config key that names a repository's policy (in its own config, so its worktrees share it). */
export const GIT_KEY = "lifearchive.guardPolicy";

/** The git config key that names the hooks folder git ran before the guard was installed, whose hooks the guard's run first. */
export const CHAIN_KEY = "lifearchive.guardChain";

/** The kinds a policy's model review may report. */
export const kinds = (policy: Policy): string[] => policy.repo.never.map((item) => item.kind);
