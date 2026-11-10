# The privacy guard

The commit and push check that keeps private data out of the repositories it guards.

## The privacy guard

The guard stops a commit or a push that would publish private data, in any repository that installs it. It came from friend-map's `scripts/` (the commit check, the private dictionary and the model's review), since it reads the archive. It lives here (`server/guard/`) and is installed into a repository by pointing that repository's git at its hooks. Each repository it guards has its own **policy**: what it may hold, as the captain set it.

**Installing it.** From this checkout, run `npm run guard -- install <policy> --repo <dir>`. That sets these in that repository's own git config:
- `core.hooksPath`, to this checkout's `server/guard/hooks/` as an absolute path;
- `lifearchive.guardPolicy`, to the policy's name;
- `lifearchive.guardChain`, when git ran hooks there before: the folder they are in. That is the folder `core.hooksPath` named before, as written (the T3 Code fork's `.vite-hooks/_`, relative, so each worktree runs its own), else `.git/hooks` if it holds any. Installed again, the guard keeps it.

It then applies to that clone and every worktree of it, and to every agent committing there. It refuses only when this checkout has no archive, as a worktree has none: the hooks read the archive of the checkout they are in, so install from the captain's copy. To take it out, set `core.hooksPath` back to `lifearchive.guardChain` (or unset it) and unset the two `lifearchive.` keys.

Each hook runs the repository's own by the same name first, from `lifearchive.guardChain`, and stops if that one fails; the guard then checks what it left (a formatter's pre-commit may change what is staged). Every other hook git runs (`post-checkout`, `prepare-commit-msg` and the rest) is only passed on (`hooks/pass`, `hooks/chain`). FirstMate's own per-task hooks, which it sets for a session in the environment, run before all of these and then pass on to them, so a FirstMate home or task worktree can be guarded too. Three hooks check:
- `pre-commit`: checks the lines a commit adds. A merge being committed (one git left for `git commit`, after a conflict or `--no-commit`) is checked as its push will read it: each commit it brings that is not yet reviewed, as its own, but those of the policy's public remotes or settled; and the merge itself for what its resolution adds (see "Settled history and upstream" below). So a fork's merge of upstream goes in whatever upstream's own text holds, and still stops on what its resolution adds. (A merge git finishes by itself runs `pre-merge-commit`, which is only passed on; its push reads it the same way.);
- `commit-msg`: checks its message;
- `pre-push`: checks every commit a push sends that the model has not reviewed yet, and every commit it sends for who made it (see "Who made each commit" below). This also catches commits made with `--no-verify` and landed by a fast-forward. Under a policy that names the branches it pushes to (the life archive's: `main` only), it first stops a push that sends to any other ref (a stray branch, a tag, a Codex checkpoint), saying which; deleting one is let through, since it sends nothing.

The hooks run this checkout's code and `node_modules` on the life archive's own pinned Node, whichever repository they guard: `hooks/pinned-node` asks the PATH's `node` (the Vite+ shim, nvm, fnm, mise) from this checkout's root, where it names the pinned version, and the hooks run that binary in the guarded repository, whose own `.node-version` would name another. With no `node` on the PATH they stop, and a PATH `node` of the wrong version is stopped by the version check. A repository that names no policy, or one this project does not have, is stopped at every hook, with what to run.

**The policies** every installation has are in `server/guard/policies/`; a repository of the installation's own is named in the archive's folder, `guard/policies.json`, never in this repository (`server/guard/privatePolicies.ts` lists them all; `npm run guard -- policies` prints them). Each holds:
- the repository layer of the privacy policy: the few kinds of data that stop a commit, each with the kind the model reports it as (always some of `BLOCK_KINDS`: a real name, account, phone number, email, private host, IP address, street address, home path, secret, the archive's content or the owner's health records), and what is fine, said outright; anything else is allowed;
- a line saying what the repository is;
- the files its made-up names are kept in (none for a public fork, whose model review is then told of none);
- the branches a push may send to (`pushBranches`), or none named for any;
- the remotes whose branches are another's published history (`publicRemotes`, a fork's `upstream`), or none;
- words that are ordinary there (`allowed`), let through as `"multi"` is.

Two are built in:
- `life-archive` (`policies/lifeArchive.ts`): the privacy policy's repository layer itself, `REPO_PRIVACY` in `server/privacy/policy.ts` (`docs/privacy.md`).
- `public-fork` (`policies/publicFork.ts`): a public fork of open-source code, merged from its upstream. Its layer, `FORK_PRIVACY` (beside `REPO_PRIVACY` in `server/privacy/policy.ts`), is for code anyone reads: it stops only the owner's machines', servers' and tailnet's names, their own accounts and tool profiles, home paths, real emails, and the rest of the archive's layer's kinds; products, tools, models and agents by name, test results and live checks, dates and versions, saying that the owner has a setup without naming its machines, upstream's identifiers and placeholder hosts are all fine. (Until 31 October 2026 it also stopped "what his setup runs or uses", which stopped a fork's commit for its table of which agents were checked live on his build; that kind is gone.) It leaves out what `upstream` holds, and pushes any branch.

**A repository of one's own** (a fork of one's own, say) gets its policy in `guard/policies.json` in the archive's folder, beside the private terms, before it is installed. Each entry extends a built-in policy and gives what is its own: what the repository is (`about`), and where they differ from the base, `nameFiles`, `pushBranches`, `publicRemotes` and `allowed`. The repository layer is always the base's.

```json
{ "policies": { "my-fork": { "extends": "public-fork", "about": "my public fork of an app, merged from its upstream", "pushBranches": ["main"], "allowed": ["<an upstream identifier a private term shares>"] } } }
```

Write it with `npm run guard -- policies import <file>`, which takes a file in that shape, checks every entry as the guard will read it (a name a records folder can take and no built-in's, a known base, no field it does not know), and adds them to those already there, replacing one of the same name; nothing is written when any is refused, and it refuses a checkout with no archive, as `install` does. A `guard/policies.json` that cannot be read stops every check rather than run without the repositories it names; a repository naming a policy the guard does not have is stopped, saying where policies are kept.

Every policy's model review is also given the content layer's list (`PRIVACY.content`).

**The local check** (`server/guard/scan.ts`) looks only at what is added. It stops:
- a real person's name, a group chat's title, an account id or phone number from the archive, or text from a note about someone;
- the captain's own name or account ids;
- a real-looking phone number, email address, WhatsApp or WeChat id, tailnet host name or address, LAN host name (`*.local`, `*.lan`), this machine's user or host name, IP address (not a loopback, private-network or documentation one) or street address (12 Example Street, plainly made up, passes);
- one of the captain's private terms (see "The private terms" below), in every repository.

A few more rules:
- The captain's name words count together, run together, or used as someone's name.
- A friend's name of two words or more counts written as a name (each word capitalised) or as a handle or file name (`ada_sample`, `ada-sample`), but not in lower-case prose. One word alone is not checked.
- When it stops something, it prints each place (file, line and column, or the line and column of the commit message), the rule it broke and the finding's id, never the text it matched.
- A phrase that keeps matching and is not a person goes in `"multi"` in the archive's folder's `guard/allow.json`, by the captain or firstmate, never by the agent it stopped.

**Judged flags.** A pattern can be wrong in a way anyone looking can see: a four-part version string in an upstream test, read as an IP address. Such a finding goes to firstmate, not to the agent that was stopped. Only firstmate judges; the refusal says so, gives each finding's id and prints the exact command:

```sh
npm --prefix <this checkout> run guard -- judge <finding> --allow --by firstmate --reason "<why it is not private, without the text>"
```

Firstmate looks at the exact text in place. If it is plainly not personal (a version string, a made-up test value), it allows it with a one-line reason. If it is real, or it is unsure, it leaves it stopped (or records `--block`) and takes it to the captain. An allow covers that one match in exactly the text the check read around it: the run of lines the commit adds, or the commit message. A finding is known by a hash of its file (or the message), its rule, the matched text, which of that text's matches it is there, and that text, so any change to the lines stops it again under a new id. The commit hooks, the push, `range`, `review` and `publish-check` all honour it, saying how many they let through. Some findings can never be allowed, whoever asks, and `judge --allow` refuses them outright: one of the private terms, this machine's own name, and the kinds `content` (a note about a real person among them) and `secret`. The refusal marks these "never let through", and the only way past is to rewrite them. A reason that quotes the matched text is refused too. A later judgement of the same finding replaces an earlier one. The captain skims them with `npm run guard -- judgements` (`server/guard/judgements.ts`).

**Who made each commit.** A commit carries its author's and committer's email, and publishing it publishes them. So a push, `range`, `review` and `publish-check` stop any commit whose author or committer email is not a GitHub noreply address (`<id>+<username>@users.noreply.github.com`, or GitHub's own `noreply@github.com` on what it commits itself). They check every commit they send or name, reviewed already or not, since it costs one git call. The report names each commit and which of the two is wrong, never the address, and says how to fix it: set the noreply address (`git config user.email`), then make the commit again under it (`git commit --amend --no-edit --reset-author`, or for older ones `git rebase -r <base> --exec 'git commit --amend --no-edit --reset-author'`). An address meant to be published goes in `"authors"` in `guard/allow.json`. The commit hooks do not check it, so a commit under another address is caught at the push, not when it is made.

**The names** come from the archive itself (`server/guard/dictionary.ts`): every person's name and aliases (the captain's apart), every account's display name, handle and id, every chat's title and id, the tags, the locations and the captain's notes for people. They are read from friend map's archive (`modules/friend-map/archive.sqlite`; `archive.sqlite` at the folder's root before the friend map step's move), opened read-only and never asked for message text. They are read afresh at every check, which takes well under a second (a commit through both hooks took 0.7 s on a made-up archive the real one's size), so they are never stale and never copied out of the archive. The archive's folder is this checkout's (`LIFE_ARCHIVE_DATA`, see data.md's "Where the data lives"), whichever repository is checked. If there is no archive, it says so in one line and checks only what needs no names. An archive whose names cannot be read stops the check rather than let it pass real names. `npm run guard -- dictionary` says how many of each it reads, never which.

**The private terms** are what no check could tell by shape: the captain's private infrastructure (his machines' and servers' host names, his tool profiles' names and folders, his tailnet's name, his home path and his personal email addresses), and his family's and his own first names, which the names above never find, since one word alone is not checked. They are kept by hand in the archive's folder, `guard/private-terms.json` (`{"terms": [...]}`, with a `"why"` beside it if wanted), as private as the archive: never committed, copied or printed. The check finds each whole however it is cased, never inside a longer word or number, but a host's name run on by a hyphen or a dot counts (a term `qz7` is in `qz7-db` and `qz7.example`, not in `qz70` or `aqz7`), so upstream code that shares a piece of one passes. It reads them without the archive too; a file that is there but cannot be read stops every check, as an unreadable archive does. `npm run guard -- dictionary` and `install` say how many there are, never which.

**The model's review** (`server/guard/review.ts`) is a second reader for each commit, once. When the local check passes, GPT-6.1 Sol reads every commit's message and the lines and new file names it adds, as if published, against the repository's policy. The policy is narrow: only its kinds stop a push, and everything else is allowed.

For each finding the model gives the place, the kind, the text itself (quoted exactly), a reason and a suggestion. A finding stops the push only when all three hold:
- it is one of the policy's kinds;
- its text is found in what the commits add (on the line it named, else elsewhere in that commit or another, which then is the place said), so a place it imagined stops nothing;
- that text is not plainly made up by the conventions: a number set aside for fiction, an example address or host, a non-public IP address (`madeUpValue` in `scan.ts`), or, outside a commit message, only the repository's made-up names.

Anything else is a **suggestion**: the model may also suggest a change outside the policy's kinds (kind `other`). Suggestions are printed with the push (where, why, what instead), kept in `privacy-findings.jsonl`, and never stop it. The captain looks them over now and then with `npm run guard -- findings`, and widens the policy only if one keeps being right. The quoted text is used only for that check: it is never printed or kept, and the guard takes it out of the model's reason and suggestion too.

Why it is built this way: when any finding stopped the push, the model stopped nearly every large review on places that were all made up (fixture names and numbers, product names, paths without a user name), and on ordinary engineering notes it read as "infrastructure", while the leaks that mattered (a real name, a private host, a personal email as author) were the kind the local check already catches. Trying several models on the same commits found the policy's description, not the model, at fault: with a description that names exactly what counts and what is plainly made up, different models agreed, let the made-up places through and still stopped a real leak.

It runs through the Codex CLI (`LIFE_ARCHIVE_CODEX`, else `codex` on the PATH or in `~/.local/bin`) under the captain's ChatGPT login. It runs read-only and ephemeral, in an empty scratch folder with its tools turned off, with the commits on its standard input. It is never given the names, the archive or anything else from this Mac.

It is also given the repository's own made-up names, from the policy's name files: each `export const` `FIRST_NAMES`, `LAST_NAMES`, `WHOLE_NAMES` and `SELF_NAME`. These are read as the newest commit under review has them, read as written and never run. A list spread into another from the same file counts; a name the file only computes does not.

Much is read in parts, three at a time, each given up to ten minutes. If Codex is missing, fails or is too slow, what it was reading is stopped too, as before: only findings became suggestions, not a missing review. It runs only where the archive is.

**Records.** Each policy keeps its records in the archive's folder, under `guard/<policy>/`, so the nightly NAS backup holds them with the archive. There are five files, each appended to a line at a time:
- `reviewed-commits.jsonl`: every commit the review passed, by full sha, with when and why, and each commit settled with its history (`"history": true`). Nothing checks a recorded commit again.
- `privacy-reviews.jsonl`: every review: when, the remote, which commits, the verdict (`findings` when one stopped it, else `pass`), how many findings stopped it and how many were suggestions, the model, its effort and how long it took, never what it read.
- `privacy-findings.jsonl`: every finding of the model's: when, the remote, the model, the commit's full sha, file and line, the kind, whether it stopped the push and if not why not (a suggestion, its text not found, or plainly made up), and the model's reason and suggestion, never the text.
- `flagged-findings.jsonl`: every finding the commit check stopped, once each: when, its id and key, where, its rule and kind, and the hashes of the matched text and the text around it, never the text.
- `judgements.jsonl`: every judgement (see "Judged flags"): the finding as flagged, allow or block, the reason, who judged and when.

**Settled history and upstream.** None of the checks (the author check either) reads a commit that the policy's public remotes hold (`upstream`'s branches: another's history, published under its own authors), nor one settled with its history: `npm run guard -- settle <commit>... --repo <dir>` records each commit given in `reviewed-commits.jsonl` with `"history": true`, and nothing reads it or anything before it again. It is for history published before the guard was installed, so it settles only a commit some remote branch holds already, and refuses one that is not published. Like the bypass below, it is the captain's (or FirstMate's, as it installs the guard), never an agent's to skip a review with. A guarded fork's first push after a history rewrite, or its first to a new remote, then sends only what is new. A merge of two is read for what its own resolution adds (git's remerge diff), since each side is checked as its own commits or is published or settled already; an octopus merge, which git cannot remerge, is read against its first parent.

A push runs both checks, the model at high effort, on only the commits it sends that are not in the record, and says how many it passed over. A push of reviewed commits only makes no model call. The commands by hand take `--repo <dir>` (else the folder npm was run from):

```sh
npm run guard -- review <base>..<tip> --repo <dir>       # both checks, the model at medium effort (firstmate, before landing a branch), recording what passes
npm run guard -- range origin/main..main --repo <dir>    # the local check alone (names and who made each commit), on any commits
npm run guard -- publish-check [<revisions>] --repo <dir> # before a repository is made public: both checks, the model at high effort, on what main holds that is not recorded; needs the archive
npm run guard -- reviews [--all] --repo <dir>            # the log: the last twenty, or every one
npm run guard -- findings [--all] [--repo <dir>]         # the model's findings, what stopped and what it only suggested: that repository's policy, else every policy's
npm run guard -- judge <finding> (--allow | --block) --by firstmate --reason "<why>"  # firstmate's alone: its judgement of a finding the commit check stopped
npm run guard -- judgements [--all] [--repo <dir>]       # the judgements: the last twenty, or all; that repository's policy, else every policy's
npm run guard -- settle <commit>... --repo <dir>         # settles published commits with all their history (once, at install)
npm run guard -- scan [--json] <file>...                 # the local check on files: each place and rule, or with --json each one's {file, rule, start, end}, never the text
```

`scan` is for a check over files built elsewhere (friend-map-frontend's `check-demo` ran it over its built demo); this repository's `npm run check-demo` (`tools/demo/check.ts`) scans its demo with the same scanner. Only the captain may push without the model's review, by setting `LIFE_ARCHIVE_SKIP_PUSH_REVIEW=1` for that push (`FRIEND_MAP_SKIP_PUSH_REVIEW`, its old name, still works). The local check still runs, the log says it was skipped, and nothing is recorded as reviewed. Agents never set it, and neither `review` nor `publish-check` takes it.

**From friend-map's copy.** friend-map's clones were once guarded by friend-map's own `scripts/`, with its records in its `data/`. They have moved here, in these steps (for any clone still to move):
1. Copy `reviewed-commits.jsonl` and `privacy-reviews.jsonl` from friend-map's `data/` into the archive's folder's `guard/friend-map/`. They are the same lines in the same shape, so the commits already reviewed stay settled.
2. Copy `data/public-prep/private/allow.json` to `guard/allow.json`. Only its `"multi"` is read (and `"authors"`, which friend-map's never had).
3. Point each clone at the hooks: `git config --unset core.hooksPath`, then `npm run guard -- install friend-map --repo <clone>`.
4. Drop friend-map's `git config friendmap.dataDir` and `friendmap.archiveDir`, which nothing reads any more.

The kit's dictionary (`commit-check-dictionary.json` and its stamp) is not carried over: the guard reads the archive instead.
